import test from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import type { Service, TerminalServerFrame } from '../../shared/types.js';
import type { TerminalRuntime, TerminalHandle, TerminalOpenOptions, TerminalCallbacks } from '../terminals.js';
import { milestoneFixture, until } from './milestone-fixture.js';

class FakeTerminal implements TerminalRuntime {
  handles:FakeHandle[]=[];openGate?:Promise<void>;closeGate?:Promise<void>;inputGate?:Promise<void>;initialOutput?:Buffer;targetIds=['main'];cleanupFailure=false;
  async targets(){return this.targetIds.map(id=>({id,name:id}));}
  async open(service:Service,options:TerminalOpenOptions,callbacks:TerminalCallbacks){
    const handle=new FakeHandle(service,options,callbacks,this);this.handles.push(handle);await this.openGate;
    if(this.cleanupFailure)throw Object.assign(Error('private cleanup failure'),{terminalCleanupFailed:true});
    if(this.initialOutput)callbacks.output(this.initialOutput);
    return handle;
  }
}
class FakeHandle implements TerminalHandle {
  writes:string[]=[];sizes:number[][]=[];closed=false;paused=false;verificationFailure=false;
  constructor(readonly service:Service,readonly options:TerminalOpenOptions,readonly callbacks:TerminalCallbacks,readonly runtime:FakeTerminal){}
  async write(data:Buffer){await this.runtime.inputGate;if(this.closed)throw Error();this.writes.push(data.toString());}
  async resize(cols:number,rows:number){this.sizes.push([cols,rows]);}
  pause(){this.paused=true;}
  resume(){this.paused=false;}
  async close(){await this.runtime.closeGate;this.closed=true;}
  async verify(){if(this.verificationFailure)throw Error('private runtime failure');}
}
function observe(socket:WebSocket){
  const frames:TerminalServerFrame[]=[];let closed:number|undefined;
  socket.on('message',data=>frames.push(JSON.parse(data.toString()) as TerminalServerFrame));socket.on('close',code=>{closed=code;});socket.on('error',()=>undefined);
  return {frames,closed:()=>closed,frame:<T extends TerminalServerFrame['type']>(type:T)=>until(async()=>frames.find(frame=>frame.type===type) as Extract<TerminalServerFrame,{type:T}>|undefined),waitClosed:()=>until(async()=>closed===undefined?undefined:closed)};
}
const open={type:'open',target:'main',shell:'sh',cols:80,rows:24};
async function prepared(options:Parameters<typeof milestoneFixture>[0]={}){
  const terminal=new FakeTerminal(),f=await milestoneFixture({terminalRuntime:terminal,terminalPolicy:{checkMs:20},publicUrl:'http://localhost',...options});const service=await f.create();await f.deploy(service);
  const connect=async(credential?:string)=>{const socket=await f.connect(`/services/${service.id}/terminal/socket`,credential?{cookie:credential}:{}),events=observe(socket);return {socket,events};};
  return {...f,terminal,service,terminalConnect:connect};
}

test('the unverified Docker terminal is disabled by default and cannot upgrade a socket',async t=>{
  const previous=process.env.HARBORLIGHT_EXPERIMENTAL_TERMINAL;
  delete process.env.HARBORLIGHT_EXPERIMENTAL_TERMINAL;
  t.after(()=>{if(previous===undefined)delete process.env.HARBORLIGHT_EXPERIMENTAL_TERMINAL;else process.env.HARBORLIGHT_EXPERIMENTAL_TERMINAL=previous;});
  const f=await milestoneFixture({publicUrl:'http://localhost'});t.after(f.close);
  const service=await f.create();await f.deploy(service);
  const path=`/services/${service.id}/terminal`,response=await f.request('GET',path);
  assert.equal(response.statusCode,200);assert.equal(response.json().supported,false);assert.equal(response.json().available,false);
  assert.match(response.json().reason,/disabled/);
  await assert.rejects(f.connect(`${path}/socket`),/409/);
});

test('terminal capability and handshake require browser operator authority, exact Origin and a canonical scoped route',async t=>{
  const f=await prepared();t.after(f.close);const viewer=await f.user('viewer','viewer'),operator=await f.user('operator','operator');
  const path=`/services/${f.service.id}/terminal`,ws=`${path}/socket`;
  const caps=await f.request('GET',path);assert.equal(caps.statusCode,200);assert.equal(caps.json().available,true);assert.deepEqual(caps.json().targets,[{id:'main',name:'main'}]);
  assert.equal((await f.request('GET',path,undefined,viewer.cookie)).statusCode,403);
  const key=(await f.request('POST','/api-keys',{name:'terminal-denied',projectIds:[f.project.id],permission:'write'})).json();
  assert.equal((await f.request('GET',path,undefined,key.token)).statusCode,403);
  for(const headers of [{origin:undefined},{origin:'null'},{origin:'https://evil.example'},{origin:'http://localhost/'},{'sec-fetch-site':'cross-site'},{authorization:`Bearer ${key.token}`}])await assert.rejects(f.connect(ws,headers),/403/);
  await assert.rejects(f.connect(ws,{cookie:''}),/401/);await assert.rejects(f.connect(ws,{cookie:viewer.cookie}),/403/);
  await assert.rejects(f.connect(`${ws}?token=forbidden`),/400/);
  const foreign=await f.create({name:'foreign',projectId:f.otherProject.id});await f.deploy(foreign);await assert.rejects(f.connect(`/services/${foreign.id}/terminal/socket`,{cookie:operator.cookie}),/404/);
  assert.equal(f.terminal.handles.length,0);
});

test('terminal captures early messages, preserves output bytes, serializes input and resize, and never persists a transcript',async t=>{
  const f=await prepared();let release!:()=>void;t.after(async()=>{release?.();await f.close();});f.terminal.openGate=new Promise(resolve=>{release=resolve;});
  f.terminal.initialOutput=Buffer.from([0,27,91,109,240,159,152,128]);
  const {socket,events}=await f.terminalConnect();socket.send(JSON.stringify(open));socket.send(JSON.stringify({type:'input',data:'private-command-secret\n'}));socket.send(JSON.stringify({type:'resize',cols:120,rows:40}));
  await until(async()=>f.terminal.handles[0]);assert.equal(f.terminal.handles[0].writes.length,0);release();await events.frame('ready');const output=await events.frame('output');assert.deepEqual(Buffer.from(output.data,'base64'),f.terminal.initialOutput);
  await until(async()=>f.terminal.handles[0].writes.length===1&&f.terminal.handles[0].sizes.length===1?true:undefined);assert.deepEqual(f.terminal.handles[0].writes,['private-command-secret\n']);assert.deepEqual(f.terminal.handles[0].sizes,[[120,40]]);
  f.terminal.handles[0].callbacks.exit(7);assert.equal((await events.frame('exit')).code,7);assert.equal(await events.waitClosed(),1000);
  await f.inspectState(store=>{const encoded=JSON.stringify(store.state);assert.ok(!encoded.includes('private-command-secret'));assert.ok(store.state.activity.some(item=>item.action==='Terminal opened'));assert.ok(store.state.activity.some(item=>item.action==='Terminal closed'));});
});

test('terminal accepts only enumerated targets and bounded JSON frames with no client container identity or command option',async t=>{
  const f=await prepared();t.after(f.close);
  for(const frame of [{...open,target:'a'.repeat(64)},{...open,command:'sh -c evil'},{type:'input',data:'before-open'},{...open,shell:'/bin/sh'},{...open,cols:10000}]){
    const {socket,events}=await f.terminalConnect();socket.send(JSON.stringify(frame));assert.ok([1008,1011].includes(await events.waitClosed()));
  }
  for(const frame of ['not JSON',JSON.stringify({type:'input',data:'x'.repeat(8193)})]){const {socket,events}=await f.terminalConnect();socket.send(frame);assert.equal(await events.waitClosed(),1008);}
  const binary=await f.terminalConnect();binary.socket.send(Buffer.from('{}'));assert.equal(await binary.events.waitClosed(),1008);
  const huge=await f.terminalConnect();huge.socket.send('x'.repeat(20000));assert.equal(await huge.events.waitClosed(),1009);
  assert.equal(f.terminal.handles.length,0);
});

test('terminal limits simultaneous sessions and closes idle, expired-opening and changed-runtime sessions',async t=>{
  const f=await prepared({terminalPolicy:{perUser:1,perService:1,total:1,checkMs:10,openMs:60,idleMs:80,lifetimeMs:150}});t.after(f.close);
  const first=await f.terminalConnect(),second=await f.terminalConnect();assert.equal(await second.events.waitClosed(),1008);assert.equal(await first.events.waitClosed(),1008);
  const active=await f.terminalConnect();active.socket.send(JSON.stringify(open));await active.events.frame('ready');assert.equal(await active.events.waitClosed(),1008);assert.equal(f.terminal.handles[0].closed,true);
  const changed=await f.terminalConnect();changed.socket.send(JSON.stringify(open));await changed.events.frame('ready');f.terminal.handles.at(-1)!.verificationFailure=true;assert.equal(await changed.events.waitClosed(),1008);assert.ok(!changed.events.frames.some(frame=>JSON.stringify(frame).includes('private runtime failure')));
});

test('logout, account role changes, password resets and account deletion close existing terminal execs',async t=>{
  const f=await prepared();t.after(f.close);
  for(const action of ['logout','role','password','delete']){
    const user=await f.user(`operator-${action}`,'operator'),session=await f.terminalConnect(user.cookie);session.socket.send(JSON.stringify(open));await session.events.frame('ready');
    let result;
    if(action==='logout')result=await f.request('POST','/auth/logout',{},user.cookie);
    else if(action==='role')result=await f.request('PATCH',`/users/${user.user.id}`,{memberships:[{projectId:f.project.id,role:'viewer'}]});
    else if(action==='password')result=await f.request('POST',`/users/${user.user.id}/password`,{password:'changed-password-12345'});
    else result=await f.request('DELETE',`/users/${user.user.id}`);
    assert.equal(result.statusCode,200,result.body);assert.equal(await session.events.waitClosed(),1008);assert.equal(f.terminal.handles.at(-1)!.closed,true);
  }
});

test('deployment and lifecycle mutations wait for terminal cleanup, including an opening that races replacement',async t=>{
  const f=await prepared();let release!:()=>void;t.after(async()=>{release?.();await f.close();});
  const active=await f.terminalConnect();active.socket.send(JSON.stringify(open));await active.events.frame('ready');f.terminal.closeGate=new Promise(resolve=>{release=resolve;});
  const previous=f.driver.deployments.length,accepted=await f.request('POST',`/services/${f.service.id}/deploy`,{});assert.equal(accepted.statusCode,202);await active.events.waitClosed();assert.equal(f.driver.deployments.length,previous);release();const job=await f.waitJob(accepted.json().id);assert.equal(job.status,'success');assert.equal(f.terminal.handles[0].closed,true);f.terminal.closeGate=undefined;
  const next=await f.terminalConnect();next.socket.send(JSON.stringify(open));await next.events.frame('ready');const stopped=await f.request('POST',`/services/${f.service.id}/stop`,{});assert.equal(stopped.statusCode,200);assert.equal(await next.events.waitClosed(),1008);assert.equal(f.terminal.handles[1].closed,true);
  await f.request('POST',`/services/${f.service.id}/start`,{});f.terminal.openGate=new Promise(resolve=>{release=resolve;});const racing=await f.terminalConnect();racing.socket.send(JSON.stringify(open));await until(async()=>f.terminal.handles[2]);
  const before=f.driver.deployments.length,queued=await f.request('POST',`/services/${f.service.id}/deploy`,{});await racing.events.waitClosed();assert.equal(f.terminal.handles[2].options.signal.aborted,true);assert.equal(f.driver.deployments.length,before);release();await f.waitJob(queued.json().id);assert.equal(f.terminal.handles[2].closed,true);
});

test('terminal bounds buffered input and output, handles runtime failure generically and supports Compose child selection',async t=>{
  const f=await prepared();let release!:()=>void;t.after(async()=>{release?.();await f.close();});
  f.terminal.openGate=new Promise(resolve=>{release=resolve;});const input=await f.terminalConnect();input.socket.send(JSON.stringify(open));await until(async()=>f.terminal.handles[0]);
  for(let i=0;i<10;i++)input.socket.send(JSON.stringify({type:'input',data:'x'.repeat(8192)}));assert.equal(await input.events.waitClosed(),1008);release();await until(async()=>f.terminal.handles[0].closed?true:undefined);assert.equal(f.terminal.handles[0].writes.length,0);f.terminal.openGate=undefined;
  const output=await f.terminalConnect();output.socket.send(JSON.stringify(open));await output.events.frame('ready');f.terminal.handles.at(-1)!.callbacks.output(Buffer.alloc(512*1024+1));assert.equal(await output.events.waitClosed(),1008);
  f.terminal.targetIds=['web','worker'];const compose=await f.create({kind:'compose',name:'stack'});await f.deploy(compose);const socket=await f.connect(`/services/${compose.id}/terminal/socket`),events=observe(socket);socket.send(JSON.stringify({...open,target:'worker'}));await events.frame('ready');assert.equal(f.terminal.handles.at(-1)!.options.target,'worker');f.terminal.handles.at(-1)!.callbacks.error(Error('private failure details'));assert.equal(await events.waitClosed(),1011);assert.ok(!JSON.stringify(events.frames).includes('private failure details'));
});

test('demo terminals are explicitly unsupported and never call the real runtime',async t=>{
  const terminal=new FakeTerminal(),f=await milestoneFixture({mode:'demo',terminalRuntime:terminal,publicUrl:'http://localhost'});t.after(f.close);const service=await f.create();await f.deploy(service);const result=await f.request('GET',`/services/${service.id}/terminal`);assert.equal(result.statusCode,200);assert.equal(result.json().supported,false);assert.equal(result.json().available,false);await assert.rejects(f.connect(`/services/${service.id}/terminal/socket`),/409/);assert.equal(terminal.handles.length,0);
});

test('failed cleanup during asynchronous terminal opening retains the mutation lock without exposing errors',async t=>{
  const f=await prepared();t.after(f.close);f.terminal.cleanupFailure=true;
  const session=await f.terminalConnect();session.socket.send(JSON.stringify(open));assert.equal(await session.events.waitClosed(),1011);assert.ok(!JSON.stringify(session.events.frames).includes('private cleanup failure'));
  const before=f.driver.deployments.length,accepted=await f.request('POST',`/services/${f.service.id}/deploy`,{});assert.equal(accepted.statusCode,202);const job=await f.waitJob(accepted.json().id);assert.equal(job.status,'failed');assert.match(job.output,/terminal could not be stopped/);assert.equal(f.driver.deployments.length,before);
  const status=await f.request('GET',`/services/${f.service.id}/terminal`);assert.equal(status.json().available,false);assert.match(status.json().reason,/previous terminal could not be stopped/);
  assert.equal((await f.request('POST',`/services/${f.service.id}/stop`,{})).statusCode,502);assert.equal(f.driver.runtime[f.service.id],'running');
});
