import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deployment, GitHubWebhookStatus, RuntimeMode, Service } from '../shared/types.js';
import type { Store } from './store.js';
import { AccessControl, accessError } from './access.js';

export interface GitHubDelivery { id: string; bodyDigest: string; deploymentId: string; receivedAt: string }
export interface GitHubWebhookRecord { secret: string; issuerId: string; repository: string; branch: string; createdAt: string; disabledReason?: 'source-changed'; deliveries: GitHubDelivery[] }
export interface GitHubWebhookDependencies {
  store: Store; access: AccessControl; mode: RuntimeMode; publicUrl?: string;
  /** onQueued mutates dedup state in the same durable write as the queued deployment. */
  enqueueDeploy(serviceId: string, trigger: string, options: { expectedCommit: string; onQueued(deployment: Deployment): void }): Deployment;
}
const maxDeliveries=256;
export const githubBodyLimit=1024*1024;
function repositoryUrl(value: unknown): string | undefined {
  if(typeof value!=='string')return;
  try {
    const url=new URL(value);
    if(url.protocol!=='https:'||url.hostname!=='github.com'||url.port||url.username||url.password||url.search||url.hash)return;
    const match=/^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)\/?$/.exec(url.pathname);
    if(!match)return;
    const name=match[2].replace(/\.git$/i,'');
    if(!name||name==='.'||name==='..')return;
    return `https://github.com/${match[1]}/${name}`.toLowerCase();
  }catch{return;}
}
export function githubBinding(service: Service): { repository: string; branch: string } | undefined {
  const repository=service.source.type==='git'?repositoryUrl(service.source.repository):undefined;
  return repository?{repository,branch:service.source.branch||'main'}:undefined;
}
export function disableChangedGitHubWebhook(store: Store,service: Service) {
  const record=store.state.githubWebhooks[service.id],binding=githubBinding(service);
  if(record&&(!binding||binding.repository!==record.repository||binding.branch!==record.branch))record.disabledReason='source-changed';
}
export function verifyGitHubSignature(secret: string, body: Buffer, signature: unknown) {
  const valid=typeof signature==='string'&&/^sha256=[a-f0-9]{64}$/.test(signature);
  const supplied=valid?Buffer.from(signature.slice(7),'hex'):Buffer.alloc(32);
  const expected=createHmac('sha256',secret).update(body).digest();
  return timingSafeEqual(expected,supplied)&&valid;
}

export function registerGitHubWebhooks(app: FastifyInstance,dependencies: GitHubWebhookDependencies) {
  const {store,access}=dependencies;
  const origin=dependencies.publicUrl?new URL(dependencies.publicUrl).origin:'';
  const parameter=(params:unknown)=>z.string().uuid().parse((params as {id:string}).id);
  function issuerAllowed(service:Service,record:GitHubWebhookRecord) {
    const user=store.state.users.find(item=>item.id===record.issuerId&&!item.disabled);
    return !!user&&(user.role!=='member'||user.memberships.some(item=>item.projectId===service.projectId&&item.role==='operator'));
  }
  function status(service:Service):GitHubWebhookStatus {
    const binding=githubBinding(service),record=store.state.githubWebhooks[service.id];
    const supported=dependencies.mode==='docker'&&!!binding;
    const reason=dependencies.mode!=='docker'?'GitHub delivery deployment is unavailable in demo mode.':!binding?'Save a Git source hosted on GitHub.com first.':record&&(record.disabledReason||binding.repository!==record.repository||binding.branch!==record.branch)?'The repository or branch changed. Rotate the webhook secret to enable deliveries.':record&&!issuerAllowed(service,record)?'The issuing account no longer has operator access. Rotate the webhook secret.':undefined;
    const last=record?.deliveries[0];
    return {supported,configured:!!record,enabled:supported&&!!record&&!reason,...(reason?{reason}:{}),repository:record?.repository||binding?.repository,branch:record?.branch||binding?.branch,endpoint:`${origin}/api/hooks/github/${service.id}`,events:['push'],contentType:'application/json',secretVisibleOnce:true,...(record?{createdAt:record.createdAt}:{}),...(last?{lastDelivery:{id:last.id,receivedAt:last.receivedAt,deploymentId:last.deploymentId}}:{})};
  }
  const path='/api/services/:id/github-webhook';
  app.get(path,async request=>{access.requireCookie(request);const service=access.requireService(request,parameter(request.params),'write');return status(service);});
  app.post(`${path}/rotate`,async(request,reply)=>{
    const actor=access.requireCookie(request),service=access.requireService(request,parameter(request.params),'write'),binding=githubBinding(service);
    if(!status(service).supported||!binding)throw accessError(409,status(service).reason||'Unsupported GitHub source.');
    z.object({}).strict().parse(request.body||{});
    const secret=randomBytes(32).toString('base64url');
    store.state.githubWebhooks[service.id]={...binding,secret,issuerId:actor.user.id,createdAt:new Date().toISOString(),deliveries:[]};
    store.activity('GitHub webhook secret rotated',service.name,undefined,service.projectId);store.save();
    return reply.header('Cache-Control','no-store').send({...status(service),secret});
  });
  app.delete(path,async request=>{
    access.requireCookie(request);const service=access.requireService(request,parameter(request.params),'write');
    delete store.state.githubWebhooks[service.id];store.activity('GitHub webhook revoked',service.name,undefined,service.projectId);store.save();return status(service);
  });
  // Encapsulation preserves exact signed bytes only for this endpoint. Other APIs retain their JSON parser.
  void app.register(async hook=>{
    hook.removeContentTypeParser('application/json');
    hook.addContentTypeParser('application/json',{parseAs:'buffer',bodyLimit:githubBodyLimit},(_request,body,done)=>done(null,body));
    hook.post('/api/hooks/github/:id',{bodyLimit:githubBodyLimit,config:{rateLimit:{max:60,timeWindow:'1 minute'}}},async(request,reply)=>{
      const contentType=request.headers['content-type'];
      if(!contentType||!/^application\/json(?:\s*;\s*charset\s*=\s*"?utf-8"?)?$/i.test(contentType)||request.headers['content-encoding']&&request.headers['content-encoding']!=='identity')throw accessError(415,'Send an uncompressed application/json webhook.');
      const serviceId=parameter(request.params),service=store.state.services.find(item=>item.id===serviceId),record=store.state.githubWebhooks[serviceId],body=request.body;
      const valid=Buffer.isBuffer(body)&&verifyGitHubSignature(record?.secret||'unconfigured-webhook',body,request.headers['x-hub-signature-256']);
      if(!valid||!service||!record||!status(service).enabled)throw accessError(401,'Invalid, disabled or revoked GitHub webhook.');
      const deliveryId=z.string().uuid().safeParse(request.headers['x-github-delivery']);
      if(!deliveryId.success)throw accessError(400,'A valid GitHub delivery identifier is required.');
      let payload:Record<string,unknown>;
      try{const text=new TextDecoder('utf-8',{fatal:true}).decode(body as Buffer);const value=JSON.parse(text);if(!value||typeof value!=='object'||Array.isArray(value))throw Error();payload=value;}catch{throw accessError(400,'The signed webhook body must be a UTF-8 JSON object.');}
      const event=request.headers['x-github-event'];
      if(event==='ping')return {status:'pong'};
      if(event!=='push')return {status:'ignored',reason:'Only push events trigger deployments.'};
      const repository=payload.repository as {full_name?:unknown;html_url?:unknown}|undefined;
      const slug=record.repository.slice('https://github.com/'.length);
      if(!repository||typeof repository.full_name!=='string'||repository.full_name.toLowerCase()!==slug||repositoryUrl(repository.html_url)!==record.repository)return {status:'ignored',reason:'Repository does not match the configured source.'};
      if(payload.deleted===true)return {status:'ignored',reason:'Deleted branches do not trigger deployments.'};
      if(payload.ref!==`refs/heads/${record.branch}`)return {status:'ignored',reason:'Branch does not match the configured source.'};
      if(payload.deleted!==false||typeof payload.after!=='string'||!/^[a-f0-9]{40}$/.test(payload.after)||/^0+$/.test(payload.after))throw accessError(400,'The push event requires a nondeleted branch and a valid commit identifier.');
      const bodyDigest=createHash('sha256').update(body as Buffer).digest('hex');
      const duplicate=record.deliveries.find(item=>item.id===deliveryId.data||item.bodyDigest===bodyDigest);
      if(duplicate)return {status:'duplicate',deploymentId:duplicate.deploymentId};
      // Queue creation and replay receipt are one atomic state commit. Busy/validation failures consume nothing.
      const deployment=dependencies.enqueueDeploy(service.id,'GitHub push',{expectedCommit:payload.after,onQueued:queued=>{
        record.deliveries.unshift({id:deliveryId.data,bodyDigest,deploymentId:queued.id,receivedAt:new Date().toISOString()});record.deliveries=record.deliveries.slice(0,maxDeliveries);
      }});
      return reply.status(202).send({status:'queued',deploymentId:deployment.id,requestedCommit:payload.after});
    });
  });
}
