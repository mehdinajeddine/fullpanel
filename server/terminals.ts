import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { WebSocket, type RawData } from 'ws';
import { z } from 'zod';
import type { Service, RuntimeMode, TerminalTarget, TerminalShell, TerminalCapabilities, TerminalServerFrame } from '../shared/types.js';
import { AccessControl, accessError, digestToken, SESSION_COOKIE } from './access.js';
import type { Store } from './store.js';

export interface TerminalOpenOptions { target: string; shell: TerminalShell; cols: number; rows: number; signal: AbortSignal }
export interface TerminalCallbacks { output(data: Buffer): void; exit(code: number | null, signal?: string): void; error(error: Error): void }
export interface TerminalHandle {
  write(data: Buffer): Promise<void> | void;
  resize(cols: number, rows: number): Promise<void> | void;
  pause(): void;
  resume(): void;
  /** Resolves only once the owned container exec has stopped. */
  close(): Promise<void> | void;
  /** Revalidates the exact runtime/container identity without changing it. */
  verify?(): Promise<void>;
}
export interface TerminalRuntime {
  targets(service: Service): Promise<TerminalTarget[]>;
  open(service: Service, options: TerminalOpenOptions, callbacks: TerminalCallbacks): Promise<TerminalHandle>;
}
export interface TerminalPolicy {
  idleMs: number; lifetimeMs: number; openMs: number; checkMs: number;
  perUser: number; perService: number; total: number;
}
export interface TerminalDependencies {
  store: Store; access: AccessControl; mode: RuntimeMode; runtime?: TerminalRuntime;
  publicOrigin?: string; requireIdle(serviceId: string): void;
  policy?: Partial<TerminalPolicy>;
}
const maxFrame=16*1024,maxInput=8192,maxInputQueue=64*1024,maxOutputQueue=512*1024;
const dimensions={cols:z.number().int().min(20).max(300),rows:z.number().int().min(5).max(150)};
const clientFrame=z.discriminatedUnion('type',[
  z.object({type:z.literal('open'),target:z.string().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),shell:z.enum(['sh','bash']),...dimensions}).strict(),
  z.object({type:z.literal('input'),data:z.string().min(1).refine(value=>Buffer.byteLength(value)<=maxInput)}).strict(),
  z.object({type:z.literal('resize'),...dimensions}).strict(),
  z.object({type:z.literal('close')}).strict()
]);
interface Connection {
  id:string; serviceId:string; userId:string; sessionHash:string; socket:WebSocket; request:FastifyRequest;
  startedAt:number; activeAt:number; abort:AbortController; closed:boolean; opening?:Promise<void>;
  handle?:TerminalHandle; closing?:Promise<void>; inputBytes:number; serial:Promise<void>; sentReady:boolean;
  windowAt:number; messageCount:number; outputBytes:number; outputQueue:Buffer[]; outputInFlight:boolean; paused:boolean;
  target?:string; shell?:TerminalShell;
  closeFailed?:boolean;
  verifying?:boolean;
}

export function registerTerminals(app:FastifyInstance,dependencies:TerminalDependencies) {
  const {store,access,runtime}=dependencies;
  const policy:TerminalPolicy={idleMs:600000,lifetimeMs:3600000,openMs:10000,checkMs:1000,perUser:2,perService:2,total:20,...dependencies.policy};
  const connections=new Map<string,Connection>();
  const path='/api/services/:id/terminal';
  let stopping=false;
  const id=(request:FastifyRequest)=>z.string().uuid().parse((request.params as {id:string}).id);
  function context(request:FastifyRequest) {
    store.assertWritable();access.requireCookie(request);
    const service=access.requireService(request,id(request),'write');dependencies.requireIdle(service.id);
    if([...connections.values()].some(connection=>connection.serviceId===service.id&&connection.closeFailed))throw accessError(409,'A previous terminal could not be stopped. Resolve the runtime connection before retrying.');
    if(dependencies.mode!=='docker'||!runtime)throw accessError(409,'Interactive terminals are unavailable in this runtime.');
    if(service.runtimeUncertain)throw accessError(409,'Reconcile the interrupted deployment before opening a terminal.');
    if(!service.deployedAt||service.status!=='running')throw accessError(409,'Start the deployed service before opening a terminal.');
    return service;
  }
  function audit(connection:Connection,action:string) {
    const service=store.state.services.find(item=>item.id===connection.serviceId);
    store.activity(action,service?.name||'Service',`User ${connection.userId}; session ${connection.id}.`,service?.projectId);
    store.save();
  }
  function send(connection:Connection,frame:TerminalServerFrame) {
    if(connection.socket.readyState===WebSocket.OPEN)connection.socket.send(JSON.stringify(frame),error=>{if(error)void close(connection,'Terminal connection failed.',1011);});
  }
  function close(connection:Connection,reason:string,code=1008,notify=true):Promise<void> {
    if(connection.closing)return connection.closing;
    connection.closed=true;connection.abort.abort();
    connection.outputQueue=[];connection.outputBytes=0;
    if(notify)send(connection,{type:'error',message:reason});
    if(connection.socket.readyState===WebSocket.OPEN)connection.socket.close(code,reason.slice(0,100));
    const terminate=setTimeout(()=>connection.socket.terminate(),250);terminate.unref();
    connection.closing=(async()=>{
      // open() must honor AbortSignal and close before rejecting or returning a handle.
      await connection.opening?.catch(()=>undefined);
      if(connection.closeFailed)throw Error('The terminal runtime could not verify cleanup.');
      await connection.handle?.close();
    })().then(()=>{
      connections.delete(connection.id);
      try{audit(connection,'Terminal closed');}catch{/* Persistence failure must never leave an exec attached. */}
    },error=>{connection.closeFailed=true;throw error;});
    void connection.closing.catch(()=>undefined);
    return connection.closing;
  }
  function valid(connection:Connection) {
    try{if(connection.closed||stopping)return false;context(connection.request);return true;}catch{return false;}
  }
  function flushOutput(connection:Connection) {
    if(connection.closed||!connection.sentReady||connection.outputInFlight)return;
    const chunk=connection.outputQueue.shift();
    if(!chunk){if(connection.paused){connection.paused=false;connection.handle?.resume();}return;}
    connection.outputInFlight=true;
    connection.socket.send(JSON.stringify({type:'output',data:chunk.toString('base64')} satisfies TerminalServerFrame),error=>{
      connection.outputBytes-=chunk.length;connection.outputInFlight=false;
      if(error){void close(connection,'Terminal connection failed.',1011);return;}
      if(connection.outputBytes<maxOutputQueue/4&&connection.paused){connection.paused=false;connection.handle?.resume();}
      flushOutput(connection);
    });
  }
  function output(connection:Connection,data:Buffer) {
    if(connection.closed)return;
    if(!Buffer.isBuffer(data)||data.length>maxOutputQueue||connection.outputBytes+data.length>maxOutputQueue||connection.socket.bufferedAmount>maxOutputQueue){void close(connection,'Terminal output exceeded the connection buffer.',1008);return;}
    for(let offset=0;offset<data.length;offset+=8192)connection.outputQueue.push(Buffer.from(data.subarray(offset,offset+8192)));
    connection.outputBytes+=data.length;
    if(connection.outputBytes>maxOutputQueue/2&&!connection.paused){connection.paused=true;connection.handle?.pause();}
    flushOutput(connection);
  }
  app.get(path,async request=>{
    access.requireCookie(request);const service=access.requireService(request,id(request),'write');
    const supported=dependencies.mode==='docker'&&!!runtime;
    const result:TerminalCapabilities={supported,available:false,targets:[],shells:['sh','bash'],limits:{idleSeconds:policy.idleMs/1000,lifetimeSeconds:policy.lifetimeMs/1000,maxInputBytes:maxInput}};
    if(!supported)return {...result,reason:dependencies.mode==='docker'?'The experimental terminal is disabled on this server.':'Interactive terminals are unavailable in this runtime.'};
    try{context(request);result.targets=await runtime!.targets(structuredClone(store.state.appliedServices[service.id]||service));context(request);result.available=!!result.targets.length;if(!result.available)result.reason='No running managed container is available.';}
    catch(error){result.reason=(error as {statusCode?:number}).statusCode?(error as Error).message:'The managed runtime could not be inspected.';}
    return result;
  });
  app.get(`${path}/socket`,{websocket:true,config:{rateLimit:{max:20,timeWindow:'1 minute'}},preValidation:async request=>{
    if(request.url!==`/api/services/${id(request)}/terminal/socket`)throw accessError(400,'Use the canonical terminal endpoint without query parameters.');
    const origin=dependencies.publicOrigin||`${request.protocol}://${request.headers.host}`;
    if(request.headers.origin!==origin||request.headers['sec-fetch-site']==='cross-site')throw accessError(403,'The terminal requires an exact same-origin browser request.');
    context(request);
  }},(socket,request)=>{
    // All listeners are attached synchronously before any runtime promise is started.
    const actor=access.requireCookie(request),service=access.requireService(request,id(request),'write');
    const connection:Connection={id:randomUUID(),serviceId:service.id,userId:actor.user.id,sessionHash:digestToken(request.cookies[SESSION_COOKIE]||''),socket,request,startedAt:Date.now(),activeAt:Date.now(),abort:new AbortController(),closed:false,inputBytes:0,serial:Promise.resolve(),sentReady:false,windowAt:Date.now(),messageCount:0,outputBytes:0,outputQueue:[],outputInFlight:false,paused:false};
    socket.on('close',()=>{void close(connection,'Terminal disconnected.',1000,false);});
    socket.on('error',()=>{void close(connection,'Terminal connection failed.',1011,false);});
    socket.on('message',(raw:RawData,binary:boolean)=>{
      if(!valid(connection)){void close(connection,'Your terminal access is no longer valid.');return;}
      const now=Date.now();if(now-connection.windowAt>=10000){connection.windowAt=now;connection.messageCount=0;}
      if(++connection.messageCount>120){void close(connection,'Terminal input rate exceeded.');return;}
      let frame:z.infer<typeof clientFrame>;
      try{if(binary)throw Error();const bytes=Array.isArray(raw)?Buffer.concat(raw):Buffer.isBuffer(raw)?raw:Buffer.from(raw);if(bytes.length>maxFrame)throw Error();frame=clientFrame.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}catch{void close(connection,'Invalid terminal message.');return;}
      connection.activeAt=now;
      if(frame.type==='close'){void close(connection,'Terminal disconnected.',1000,false);return;}
      if(frame.type==='open'){
        if(connection.opening){void close(connection,'The terminal was already opened.');return;}
        connection.target=frame.target;connection.shell=frame.shell;
        const options=frame;
        connection.opening=(async()=>{
          try{
            const snapshot=structuredClone(store.state.appliedServices[service.id]||service),targets=await runtime!.targets(snapshot);
            if(!valid(connection))throw Error();if(!targets.some(target=>target.id===options.target))throw Error();
            const handle=await runtime!.open(snapshot,{...options,signal:connection.abort.signal},{output:data=>output(connection,data),exit:(code,signal)=>{if(!connection.closed)send(connection,{type:'exit',code,signal});void close(connection,'Terminal process exited.',1000,false);},error:()=>{void close(connection,'The container terminal stopped unexpectedly.',1011);}});
            connection.handle=handle;
            if(!valid(connection)){await handle.close();return;}
            if(connection.paused)handle.pause();
            audit(connection,'Terminal opened');connection.sentReady=true;
            send(connection,{type:'ready',sessionId:connection.id,target:options.target,shell:options.shell});flushOutput(connection);
          }catch(error){if((error as {terminalCleanupFailed?:boolean})?.terminalCleanupFailed)connection.closeFailed=true;if(!connection.closed)void close(connection,'The container terminal could not be opened.',1011);}
        })();
        return;
      }
      if(!connection.opening){void close(connection,'Open the terminal before sending input.');return;}
      const bytes=frame.type==='input'?Buffer.byteLength(frame.data):64;
      connection.inputBytes+=bytes;
      if(connection.inputBytes>maxInputQueue){void close(connection,'Terminal input exceeded the connection buffer.');return;}
      connection.serial=connection.serial.then(async()=>{
        await connection.opening;
        if(!valid(connection)||!connection.handle||!connection.sentReady)return;
        if(frame.type==='input')await connection.handle.write(Buffer.from(frame.data));else await connection.handle.resize(frame.cols,frame.rows);
      }).catch(()=>{void close(connection,'The container terminal input failed.',1011);}).finally(()=>{connection.inputBytes-=bytes;});
    });
    const existing=[...connections.values()];
    connections.set(connection.id,connection);
    if(stopping||existing.length>=policy.total||existing.filter(item=>item.userId===actor.user.id).length>=policy.perUser||existing.filter(item=>item.serviceId===service.id).length>=policy.perService){void close(connection,'The terminal session limit has been reached.');}
  });
  const timer=setInterval(()=>{
    for(const connection of connections.values()){
      if(connection.closed)continue;
      const now=Date.now();
      if(!valid(connection)){void close(connection,'Your terminal access is no longer valid.');continue;}
      if(now-connection.startedAt>policy.lifetimeMs||now-connection.activeAt>policy.idleMs||!connection.sentReady&&now-connection.startedAt>policy.openMs){void close(connection,'The terminal session timed out.');continue;}
      if(connection.handle?.verify&&!connection.verifying){connection.verifying=true;void connection.handle.verify().catch(()=>{void close(connection,'The terminal container is no longer active.');}).finally(()=>{connection.verifying=false;});}
    }
  },policy.checkMs);timer.unref();
  const closeWhere=async(predicate:(connection:Connection)=>boolean,reason:string)=>{await Promise.all([...connections.values()].filter(predicate).map(connection=>close(connection,reason)));};
  const manager={
    closeService:(serviceId:string)=>closeWhere(connection=>connection.serviceId===serviceId,'A service operation closed the terminal.'),
    closeUser:(userId:string)=>closeWhere(connection=>connection.userId===userId,'Your terminal access was revoked.'),
    closeSession:(sessionHash:string)=>closeWhere(connection=>connection.sessionHash===sessionHash,'Your browser session ended.'),
    closeAll:async()=>{stopping=true;clearInterval(timer);const outcomes=await Promise.allSettled([...connections.values()].map(connection=>close(connection,'The server is stopping.')));if(outcomes.some(result=>result.status==='rejected'))app.log.error('A container terminal could not be verified stopped. Inspect the runtime before restarting service operations.');}
  };
  app.addHook('preClose',manager.closeAll);
  return manager;
}
export type TerminalManager=ReturnType<typeof registerTerminals>;
