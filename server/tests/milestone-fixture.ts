import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InjectOptions } from 'fastify';
import { createApp, type AppOptions } from '../app.js';
import type { IncomingMessage } from 'node:http';
import { DemoDriver, type DeployOptions, type Output, type RollbackOptions } from '../docker.js';
import type { Deployment, PublicUser, Service, ServiceStatus } from '../../shared/types.js';
import { Store } from '../store.js';
export class MilestoneDriver extends DemoDriver {
  runtime:Record<string,ServiceStatus>={};
  deployments:{service:Service;options:DeployOptions}[]=[];
  rollbacks:{service:Service;options:RollbackOptions}[]=[];
  gate?:Promise<void>; failure?:string; rollbackFailure?:string; afterDeploy?:()=>Promise<void>;
  logOutput='Application log';
  override async deploy(service:Service,output:Output,options:DeployOptions={}){
    this.deployments.push({service:structuredClone(service),options:structuredClone(options)});await this.gate;
    if(this.failure)throw Error(this.failure);
    this.runtime[service.id]='running';output('Build completed.\n');await this.afterDeploy?.();
    return {containerId:`container-${this.deployments.length}`,image:service.source.image||'built-app',imageId:`sha256:${createHash('sha256').update(JSON.stringify(service.env)).digest('hex')}`,releaseTag:options.releaseId?`harborlight-release/${service.id}:${options.releaseId}`:undefined,commit:service.source.type==='git'?options.expectedCommit||'a'.repeat(40):undefined};
  }
  async rollback(service:Service,output:Output,options:RollbackOptions){
    this.rollbacks.push({service:structuredClone(service),options:structuredClone(options)});await this.gate;
    for(const value of Object.values(service.env).filter(value=>value.length>=4)){output(value.slice(0,3));output(value.slice(3));}
    if(this.rollbackFailure)throw Error(this.rollbackFailure);
    this.runtime[service.id]='running';return {containerId:`rollback-${this.rollbacks.length}`,image:service.source.image||'built-app',imageId:options.imageId,releaseTag:`harborlight-release/${service.id}:${options.releaseId}`};
  }
  override async statuses(){return {...this.runtime};}
  override async logs(){return this.logOutput;}
  override async action(service:Service,action:'start'|'stop'|'restart'){this.runtime[service.id]=action==='stop'?'stopped':'running';}
  override async remove(service:Service){delete this.runtime[service.id];}
}
export async function until<T>(check:()=>Promise<T|undefined>):Promise<T>{for(let index=0;index<200;index++){const result=await check();if(result)return result;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Polling timed out.');}
export async function milestoneFixture(options:Partial<AppOptions>={}){
  const directory=await mkdtemp(join(tmpdir(),'harborlight-release-test-')),driver=new MilestoneDriver();
  let app=await createApp({dataDir:directory,mode:'docker',driver,...options}),cookie='';
  const request=(method:InjectOptions['method'],path:string,payload?:Record<string,unknown>,credential?:string)=>app.inject({method,url:`/api${path}`,headers:credential?.startsWith('hl_')?{authorization:`Bearer ${credential}`}:{cookie:credential??cookie},...(payload===undefined?{}:{payload})});
  const setup=await request('POST','/auth/setup',{name:'Owner',email:'owner@example.test',password:'owner-password-123456'});assert.equal(setup.statusCode,200,setup.body);cookie=String(setup.headers['set-cookie']).split(';')[0];
  const project=(await request('POST','/projects',{name:'alpha'})).json(),otherProject=(await request('POST','/projects',{name:'beta'})).json();
  const create=async(fields:Record<string,unknown>={})=>{const response=await request('POST','/services',{projectId:project.id,name:'web',kind:'app',...fields});assert.equal(response.statusCode,201,response.body);return response.json() as Service;};
  const waitJob=(id:string)=>until(async()=>{const job=(await request('GET',`/deployments/${id}`)).json() as Deployment;return ['success','failed'].includes(job.status)?job:undefined;});
  const deploy=async(service:Service)=>{const response=await request('POST',`/services/${service.id}/deploy`,{});assert.equal(response.statusCode,202,response.body);const job=await waitJob(response.json().id);assert.equal(job.status,'success',job.output);return job;};
  const user=async(name:string,role:'viewer'|'operator')=>{const result=await request('POST','/users',{name,email:`${name}@example.test`,password:'member-password-123456',role:'member',memberships:[{projectId:project.id,role}]});assert.equal(result.statusCode,201,result.body);const user=result.json() as PublicUser;const login=await request('POST','/auth/login',{email:user.email,password:'member-password-123456'},'');assert.equal(login.statusCode,200,login.body);return {user,cookie:String(login.headers['set-cookie']).split(';')[0]};};
  const reopen=async(change?:(store:Store)=>void)=>{await app.close();if(change){const store=new Store(directory);try{change(store);store.save();}finally{store.close();}}app=await createApp({dataDir:directory,mode:'docker',driver,...options});};
  const inspectState=async(check:(store:Store)=>void)=>reopen(check);
  const restartAfterStorageFailure=async()=>{await assert.rejects(app.close(),/Persistent storage failed/);app=await createApp({dataDir:directory,mode:'docker',driver,...options});};
  const raw=(options:InjectOptions)=>app.inject(options);
  const connect=async(path:string,headers:IncomingMessage['headers']={})=>{await app.ready();return app.injectWS(`/api${path}`,{headers:{host:'localhost',origin:'http://localhost',cookie,...headers}});};
  const close=async()=>{await app.close();await rm(directory,{recursive:true,force:true});};
  return {directory,driver,request,project,otherProject,create,deploy,waitJob,user,reopen,inspectState,restartAfterStorageFailure,raw,connect,close};
}
