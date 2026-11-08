import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deployment, Release, ReleasesResponse, RuntimeMode, Service } from '../shared/types.js';
import type { ProxyAuthMap } from '../shared/proxy.js';
import type { Store } from './store.js';
import type { DeploymentResult, RuntimeDriver } from './docker.js';
import { AccessControl, accessError } from './access.js';
import { mountConfiguration } from './release-config.js';

export interface ReleaseSnapshot {
  metadata: Omit<Release,'canRollback'|'rollbackReason'>;
  /** Immutable and encrypted; intentionally contains no source authentication credentials. */
  service: Service;
  proxyAuth: ProxyAuthMap;
  releaseTag: string;
}
export interface ReleaseDependencies {
  store: Store; access: AccessControl; driver: RuntimeDriver; mode: RuntimeMode;
  requireIdle(serviceId:string):void;
  enqueue(serviceId:string,action:()=>Promise<void>):Promise<unknown>;
  validateService(service:Service):void;
  secrets(service:Service):string[];
}
/** Keep candidate reservations and redaction after an interrupted or failed switch. */
export function pendingReleaseServices(store:Store,serviceId?:string):Service[] {
  const ids=new Set(serviceId?store.state.pendingReleaseIds[serviceId]||[]:Object.values(store.state.pendingReleaseIds).flat());
  return store.state.releases.filter(release=>ids.has(release.metadata.id)).map(release=>release.service);
}
export function recordRelease(store: Store, service: Service, proxyAuth: ProxyAuthMap, deployment: Deployment, result: DeploymentResult, releaseId: string) {
  if(service.kind!=='app'||!result.imageId||!result.releaseTag)return;
  if(!/^sha256:[a-f0-9]{64}$/.test(result.imageId)||result.releaseTag!==`harborlight-release/${service.id}:${releaseId}`)throw new Error('The runtime returned an invalid immutable release identity.');
  const snapshot=structuredClone(service);
  delete snapshot.volumeOverrides;delete snapshot.containerId;delete snapshot.error;delete snapshot.pendingChanges;delete snapshot.activeReleaseId;delete snapshot.runtimeUncertain;
  const release:ReleaseSnapshot={metadata:{id:releaseId,serviceId:service.id,projectId:service.projectId,deploymentId:deployment.id,createdAt:new Date().toISOString(),image:result.image||service.source.image||'Built application',imageId:result.imageId,commit:result.commit||deployment.commit,sourceType:service.source.type,trigger:deployment.trigger,...(deployment.rollbackOf?{rollbackOf:deployment.rollbackOf}:{})},service:snapshot,proxyAuth:structuredClone(proxyAuth),releaseTag:result.releaseTag};
  store.state.releases.unshift(release);store.state.activeReleaseIds[service.id]=releaseId;deployment.releaseId=releaseId;
  return release;
}

export function registerReleases(app: FastifyInstance,dependencies: ReleaseDependencies) {
  const {store,access,driver}=dependencies;
  const parameter=(params:unknown)=>z.string().uuid().parse((params as {id:string}).id);
  function unsupported(service:Service) {
    if(dependencies.mode!=='docker')return 'Immutable application releases are unavailable in demo mode.';
    if(service.kind!=='app')return 'Rollback supports single-container applications only. Database and Compose rollback require separate compatibility and data recovery procedures.';
    if(!driver.rollback)return 'This runtime does not support immutable application rollback.';
  }
  function candidate(service:Service,release:ReleaseSnapshot):Service {
    if(service.runtimeUncertain)throw accessError(409,'A deployment was interrupted. Deploy the saved configuration to reconcile the runtime before rollback.');
    const applied=store.state.appliedServices[service.id];
    if(!service.deployedAt||!applied)throw accessError(409,'Deploy this application once before using rollback.');
    if(mountConfiguration(applied)!==mountConfiguration(release.service))throw accessError(409,'This release uses different volume names or mount paths. Rollback cannot change active volumes.');
    const snapshot={...structuredClone(release.service),volumeOverrides:structuredClone(applied.volumeOverrides||{}),containerId:service.containerId||applied.containerId};
    dependencies.validateService(snapshot);
    return snapshot;
  }
  function publicRelease(service:Service,release:ReleaseSnapshot):Release {
    let reason=unsupported(service);
    if(!reason&&service.status==='deploying')reason='Wait for the current deployment to finish.';
    if(!reason&&store.state.activeReleaseIds[service.id]===release.metadata.id)reason='This release is already active.';
    if(!reason)try{candidate(service,release);}catch(error){reason=(error as Error).message;}
    return {...release.metadata,canRollback:!reason,...(reason?{rollbackReason:reason}:{})};
  }
  app.get('/api/services/:id/releases',async request=>{
    const service=access.requireService(request,parameter(request.params)),reason=unsupported(service);
    return {supported:!reason,...(reason?{reason}:{}),activeReleaseId:service.status==='deploying'||service.runtimeUncertain?undefined:store.state.activeReleaseIds[service.id],releases:store.state.releases.filter(item=>item.metadata.serviceId===service.id).map(item=>publicRelease(service,item))} satisfies ReleasesResponse;
  });
  app.post('/api/services/:id/rollback',async(request,reply)=>{
    const service=access.requireService(request,parameter(request.params),'write');
    const input=z.object({releaseId:z.string().uuid(),confirmationName:z.string().min(1).max(63)}).strict().parse(request.body);
    if(input.confirmationName!==service.name)throw accessError(400,'Type the application name exactly to confirm rollback.');
    const reason=unsupported(service);if(reason)throw accessError(409,reason);
    dependencies.requireIdle(service.id);
    const release=store.state.releases.find(item=>item.metadata.id===input.releaseId&&item.metadata.serviceId===service.id);
    if(!release)throw accessError(404,'Release not found.');
    const eligibility=publicRelease(service,release);if(!eligibility.canRollback)throw accessError(409,eligibility.rollbackReason!);
    const snapshot=candidate(service,release),newReleaseId=randomUUID(),proxyAuth=structuredClone(release.proxyAuth);
    const deployment:Deployment={id:randomUUID(),serviceId:service.id,projectId:service.projectId,status:'queued',trigger:'Rollback',createdAt:new Date().toISOString(),output:'Application rollback queued. Current volume data will be preserved.\n',rollbackOf:release.metadata.id,image:release.metadata.image,commit:release.metadata.commit};
    store.state.pendingReleaseIds[service.id]=[...new Set([...(store.state.pendingReleaseIds[service.id]||[]),release.metadata.id])];
    store.state.deployments.unshift(deployment);service.status='deploying';delete service.error;store.activity('Application rollback queued',service.name,undefined,service.projectId);store.save();
    void dependencies.enqueue(service.id,async()=>{
      deployment.status='running';store.save();let rawOutput=deployment.output;
      const secrets=[...new Set([...dependencies.secrets(snapshot),...Object.values(proxyAuth).map(value=>value.passwordHash)].filter(value=>value.length>=4))].sort((a,b)=>b.length-a.length);
      const redact=(value:string)=>secrets.reduce((text,secret)=>text.split(secret).join('[REDACTED]'),value);
      const output=(chunk:string)=>{
        rawOutput=(rawOutput+chunk).slice(-250000);let end=rawOutput.length;
        for(const secret of secrets)for(let length=Math.min(secret.length-1,rawOutput.length);length>0;length--)if(rawOutput.endsWith(secret.slice(0,length))){end=Math.min(end,rawOutput.length-length);break;}
        deployment.output=redact(rawOutput.slice(0,end)).slice(-200000);
      };
      try{
        access.requireService(request,service.id,'write');
        const result=await driver.rollback!(snapshot,output,{imageId:release.metadata.imageId,releaseTag:release.releaseTag,proxyAuth,releaseId:newReleaseId});
        deployment.output=redact(rawOutput).slice(-200000);
        service.status='running';service.containerId=result.containerId;service.deployedAt=new Date().toISOString();delete service.error;
        store.state.appliedServices[service.id]={...snapshot,containerId:result.containerId,status:'running',deployedAt:service.deployedAt};
        store.state.appliedProxyAuth[service.id]=proxyAuth;
        delete store.state.activeReleaseIds[service.id];
        recordRelease(store,snapshot,proxyAuth,deployment,{...result,commit:release.metadata.commit},newReleaseId);
        delete store.state.pendingReleaseIds[service.id];
        deployment.status='success';store.activity('Application rollback completed',service.name,'The saved desired configuration is unchanged; current volume data was preserved.',service.projectId);
      }catch(error){
        deployment.status='failed';service.error=redact((error as Error).message);output(`\nRollback failed: ${service.error}\n`);
        try{const states=await driver.statuses();service.status=states[service.id]||'failed';}catch{service.status='failed';}
        store.activity('Application rollback failed',service.name,undefined,service.projectId);
      }finally{deployment.finishedAt=new Date().toISOString();store.save();}
    });
    return reply.status(202).send(deployment);
  });
}
