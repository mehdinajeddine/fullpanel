import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink, lstat, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createDecipheriv } from 'node:crypto';
import type { InjectOptions } from 'fastify';
import { createApp } from '../app.js';
import { DemoDriver, type RuntimeDriver, type DeployOptions, type Output, type RestoreOptions, type RestoreCheckpoint } from '../docker.js';
import type { Backup, BackupMetadata, RestoreJob, Service, ServiceStatus } from '../../shared/types.js';
import { Store } from '../store.js';
import { recoverPreparedRestores } from '../restore-jobs.js';

class RecoveryDriver implements RuntimeDriver {
  states: Record<string,ServiceStatus> = {};
  deployments: {service:Service;options:DeployOptions}[] = [];
  backups: Service[] = [];
  restores: {target:Service;source:Service;contents:string}[] = [];
  events: string[] = [];
  validationGate?: Promise<void>;
  validationFailure?: string;
  backupFailure?: string;
  restoreFailure?: string;
  afterValidation?: () => Promise<void>;
  afterCheckpoint?: () => Promise<void>;
  logText = '';
  recoveryOutcome: 'activated'|'rolled-back' = 'rolled-back';
  recoveryFailure?: string;
  recovered: {previous:Service;prepared:Service;checkpoint:RestoreCheckpoint}[] = [];
  async recoverRestore(previous:Service,prepared:Service,checkpoint:RestoreCheckpoint){this.recovered.push({previous:structuredClone(previous),prepared:structuredClone(prepared),checkpoint:structuredClone(checkpoint)});if(this.recoveryFailure)throw new Error(this.recoveryFailure);return this.recoveryOutcome;}
  async deploy(service:Service,_output:Output,options:DeployOptions={}) { this.deployments.push({service:structuredClone(service),options:structuredClone(options)}); this.states[service.id]='running';return {containerId:`container-${service.id}`,image:service.source.image || 'built'}; }
  async action(service:Service,action:'start'|'stop'|'restart') {this.states[service.id]=action==='stop'?'stopped':'running';}
  async remove(service:Service) {delete this.states[service.id];}
  async statuses(){return {...this.states};}
  async metrics(){return new DemoDriver().metrics();}
  async logs(){return this.logText;}
  async backup(service:Service,filename:string):Promise<BackupMetadata> {
    this.events.push('backup');this.backups.push(structuredClone(service));
    if(this.backupFailure) throw new Error(this.backupFailure);
    await writeFile(filename,`snapshot:${service.name}:${service.env.POSTGRES_PASSWORD || 'app-data'}\n`,{flag:'wx',mode:0o600});
    return {schemaVersion:1,kind:service.kind,format:service.kind==='app'?'volume-tar':'postgres-sql',engineVersion:'16.3',image:service.source.image,mounts:service.mounts.map(({name,mountPath})=>({name,mountPath}))};
  }
  async validateRestore(_target:Service,_backup:Backup,_filename:string,_options?:RestoreOptions) {this.events.push('validate');await this.validationGate;if(this.validationFailure)throw new Error(this.validationFailure);await this.afterValidation?.();}
  async restore(target:Service,_backup:Backup,filename:string,output:Output,options?:RestoreOptions){
    this.events.push('restore');const source=options!.sourceService!;this.restores.push({target:structuredClone(target),source:structuredClone(source),contents:await readFile(filename,'utf8')});
    const secret=source.env.POSTGRES_PASSWORD; if(secret){output(secret.slice(0,3));output(secret.slice(3));}
    const result={containerId:`replacement-${target.id}`,volumeOverrides:Object.fromEntries(target.mounts.map(mount=>[mount.name,`hl-${target.id}-restore-${randomUUID()}`])),environment:{POSTGRES_PASSWORD:secret,POSTGRES_USER:source.env.POSTGRES_USER,POSTGRES_DB:source.env.POSTGRES_DB,UNRELATED_SECRET:'must-not-copy'}};
    await options?.onPrepared?.(result,{restoreId:randomUUID(),previousContainerId:target.containerId!,candidateContainerId:result.containerId,previousWasRunning:true});
    await this.afterCheckpoint?.();
    if(this.restoreFailure)throw new Error(this.restoreFailure);
    return result;
  }
}
async function until<T>(check:()=>Promise<T|undefined>):Promise<T>{for(let i=0;i<200;i++){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Polling timed out.');}
async function fixture(){
  const directory=await mkdtemp(join(tmpdir(),'harborlight-restores-')),driver=new RecoveryDriver();
  let app=await createApp({dataDir:directory,mode:'docker',driver});
  const request=(method:InjectOptions['method'],path:string,payload?:Record<string,unknown>,credential?:string)=>app.inject({method,url:`/api${path}`,headers:credential?.startsWith('hl_')?{authorization:`Bearer ${credential}`}:{cookie:credential??ownerCookie},...(payload===undefined?{}:{payload})});
  let ownerCookie='';const setup=await request('POST','/auth/setup',{name:'Owner',email:'owner@example.test',password:'owner-password-123456'});assert.equal(setup.statusCode,200,setup.body);ownerCookie=String(setup.headers['set-cookie']).split(';')[0];
  const projectA=(await request('POST','/projects',{name:'alpha'})).json(),projectB=(await request('POST','/projects',{name:'beta'})).json();
  const create=async(projectId:string,name:string,fields:Record<string,unknown>={})=>{const response=await request('POST','/services',{projectId,name,kind:'postgres',...fields});assert.equal(response.statusCode,201,response.body);return response.json() as Service;};
  const deploy=async(service:Service)=>{const response=await request('POST',`/services/${service.id}/deploy`);assert.equal(response.statusCode,202,response.body);await until(async()=>{const job=(await request('GET',`/deployments/${response.json().id}`)).json();if(job.status==='failed')throw Error(job.output);return job.status==='success'?job:undefined;});};
  const backup=async(service:Service)=>{const response=await request('POST',`/services/${service.id}/backups`);assert.equal(response.statusCode,202,response.body);return until(async()=>{const row=(await request('GET','/backups')).json().find((item:Backup)=>item.id===response.json().id) as Backup;assert.notEqual(row.status,'failed',row.error);return row.status==='success'?row:undefined;});};
  const waitRestore=(id:string)=>until(async()=>{const job=(await request('GET',`/restores/${id}`)).json() as RestoreJob;return ['success','failed'].includes(job.status)?job:undefined;});
  const user=async(name:string,memberships:{projectId:string;role:'viewer'|'operator'}[])=>{const created=await request('POST','/users',{name,email:`${name}@example.test`,password:'member-password-123456',role:'member',memberships});assert.equal(created.statusCode,201,created.body);const login=await request('POST','/auth/login',{email:`${name}@example.test`,password:'member-password-123456'},'');assert.equal(login.statusCode,200,login.body);return {cookie:String(login.headers['set-cookie']).split(';')[0],id:created.json().id};};
  const close=async()=>{await app.close();await rm(directory,{recursive:true,force:true});};
  const reopen=async(change:(store:Store)=>void|Promise<void>)=>{await app.close();const store=new Store(directory);try{await change(store);store.save();}finally{store.close();}app=await createApp({dataDir:directory,mode:'docker',driver});};
  return{driver,directory,request,projectA,projectB,create,deploy,backup,waitRestore,user,close,reopen};
}

async function prepared(){const f=await fixture();const source=await f.create(f.projectA.id,'source'),target=await f.create(f.projectB.id,'target');await f.deploy(source);await f.deploy(target);const backup=await f.backup(source);f.driver.events=[];return {...f,source,target,saved:backup};}

test('restoration verifies the source, creates a safety backup, retains private applied volume mappings and adopts only managed database credentials',async t=>{
  const f=await prepared();t.after(f.close);
  let checkpointSeen=false;
  f.driver.afterCheckpoint=async()=>{
    const bytes=await readFile(join(f.directory,'state.enc')),key=await readFile(join(f.directory,'encryption.key'));
    const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));
    const state=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString());
    const intention=Object.values(state.restoreIntents)[0] as {previousService:Service;preparedService:Service;checkpoint:RestoreCheckpoint};
    assert.equal(intention.previousService.containerId,`container-${f.target.id}`);assert.equal(intention.preparedService.containerId,`replacement-${f.target.id}`);assert.equal(intention.checkpoint.candidateContainerId,intention.preparedService.containerId);assert.equal(intention.preparedService.env.POSTGRES_PASSWORD,f.source.env.POSTGRES_PASSWORD);checkpointSeen=true;
  };
  const response=await f.request('POST',`/services/${f.target.id}/restore`,{backupId:f.saved.id,confirmationName:f.target.name});assert.equal(response.statusCode,202,response.body);
  const job=await f.waitRestore(response.json().id);assert.equal(job.status,'success',job.error);assert.equal(checkpointSeen,true);assert.deepEqual(f.driver.events,['validate','backup','restore']);assert.ok(job.startedAt);assert.ok(job.finishedAt);assert.ok(job.preRestoreBackupId);assert.ok(job.requestedBy);
  const backups=(await f.request('GET','/backups')).json() as Backup[],safety=backups.find(item=>item.id===job.preRestoreBackupId)!;assert.equal(safety.restoreJobId,job.id);assert.equal(safety.status,'success');assert.match(safety.sha256!,/^[a-f0-9]{64}$/);assert.ok(safety.metadata);
  const target=(await f.request('GET',`/services/${f.target.id}`)).json() as Service;assert.equal(target.env.POSTGRES_PASSWORD,f.source.env.POSTGRES_PASSWORD);assert.equal(target.env.UNRELATED_SECRET,undefined);assert.equal(target.volumeOverrides,undefined);assert.equal(target.containerId,`replacement-${target.id}`);assert.ok(!job.output.includes(f.source.env.POSTGRES_PASSWORD));assert.match(job.output,/REDACTED/);
  await f.deploy(target);const deployed=f.driver.deployments.at(-1)!.service;assert.ok(deployed.volumeOverrides?.[target.mounts[0].name]);assert.equal(deployed.env.POSTGRES_PASSWORD,f.source.env.POSTGRES_PASSWORD);
  assert.equal((await f.request('PATCH',`/services/${target.id}`,{volumeOverrides:{attack:'unowned'}})).statusCode,400);
  const encrypted=await readFile(join(f.directory,'state.enc'));assert.equal(encrypted.includes(Buffer.from(f.source.env.POSTGRES_PASSWORD)),false);
});

test('restore requires an exact name, compatible metadata, a running target and operator permission on both projects',async t=>{
  const f=await prepared();t.after(f.close);
  assert.equal((await f.request('POST',`/services/${f.target.id}/restore`,{backupId:f.saved.id,confirmationName:'Target'})).statusCode,400);
  const viewer=await f.user('viewer',[{projectId:f.projectA.id,role:'viewer'},{projectId:f.projectB.id,role:'operator'}]),targetOnly=await f.user('target-only',[{projectId:f.projectB.id,role:'operator'}]);
  const payload={backupId:f.saved.id,confirmationName:f.target.name},route=`/services/${f.target.id}/restore`;
  assert.equal((await f.request('POST',route,payload,viewer.cookie)).statusCode,403);assert.equal((await f.request('POST',route,payload,targetOnly.cookie)).statusCode,404);
  const oneKey=(await f.request('POST','/api-keys',{name:'target-only',projectIds:[f.projectB.id],permission:'write'})).json();assert.equal((await f.request('POST',route,payload,oneKey.token)).statusCode,404);
  const readKey=(await f.request('POST','/api-keys',{name:'read-both',projectIds:[f.projectA.id,f.projectB.id],permission:'read'})).json();assert.equal((await f.request('POST',route,payload,readKey.token)).statusCode,403);
  await f.request('POST',`/services/${f.target.id}/stop`);assert.equal((await f.request('POST',route,payload)).statusCode,409);await f.request('POST',`/services/${f.target.id}/start`);
  const redis=await f.create(f.projectB.id,'cache',{kind:'redis'});await f.deploy(redis);assert.equal((await f.request('POST',`/services/${redis.id}/restore`,{backupId:f.saved.id,confirmationName:redis.name})).statusCode,409);
  const bothKey=(await f.request('POST','/api-keys',{name:'both',projectIds:[f.projectA.id,f.projectB.id],permission:'write'})).json();const response=await f.request('POST',route,payload,bothKey.token);assert.equal(response.statusCode,202,response.body);const job=await f.waitRestore(response.json().id);assert.equal(job.status,'success',job.error);
  for(const credential of [viewer.cookie,targetOnly.cookie,oneKey.token,readKey.token]){assert.deepEqual((await f.request('GET','/restores',undefined,credential)).json(),[]);assert.equal((await f.request('GET',`/restores/${job.id}`,undefined,credential)).statusCode,404);}
  assert.equal((await f.request('GET','/restores',undefined,bothKey.token)).json().length,1);
});

test('corrupt and symlink backups never reach runtime validation, safety backup or restoration',async t=>{
  const f=await prepared();t.after(f.close);const path=join(f.directory,'backups',f.saved.filename),contents=await readFile(path);
  const corrupt=Buffer.from(contents);corrupt[0]^=1;await writeFile(path,corrupt);
  let response=await f.request('POST',`/services/${f.target.id}/restore`,{backupId:f.saved.id,confirmationName:f.target.name}),job=await f.waitRestore(response.json().id);assert.equal(job.status,'failed');assert.match(job.error!,/integrity/);assert.deepEqual(f.driver.events,[]);
  const external=join(f.directory,'outside-dump');await writeFile(external,contents);await rm(path);await symlink(external,path);
  assert.equal((await f.request('GET',`/backups/${f.saved.id}/download`)).statusCode,404);
  response=await f.request('POST',`/services/${f.target.id}/restore`,{backupId:f.saved.id,confirmationName:f.target.name});job=await f.waitRestore(response.json().id);assert.equal(job.status,'failed');assert.deepEqual(f.driver.events,[]);
});

test('safety backup failures and runtime preflight incompatibility stop before restore and redact the durable error',async t=>{
  const f=await prepared();t.after(f.close);const payload={backupId:f.saved.id,confirmationName:f.target.name},route=`/services/${f.target.id}/restore`;
  f.driver.validationFailure='Incompatible database version';let response=await f.request('POST',route,payload),job=await f.waitRestore(response.json().id);assert.equal(job.status,'failed');assert.deepEqual(f.driver.events,['validate']);assert.equal(job.preRestoreBackupId,undefined);
  f.driver.validationFailure=undefined;f.driver.events=[];f.driver.backupFailure=`Cannot dump ${f.target.env.POSTGRES_PASSWORD}`;response=await f.request('POST',route,payload);job=await f.waitRestore(response.json().id);assert.equal(job.status,'failed');assert.deepEqual(f.driver.events,['validate','backup']);assert.ok(job.preRestoreBackupId);assert.ok(!job.error!.includes(f.target.env.POSTGRES_PASSWORD));assert.match(job.error!,/REDACTED/);
});

test('restores share all target mutation locks, pin source files against retention and recheck authority before creating backups',async t=>{
  const f=await prepared();let release!:()=>void;t.after(async()=>{release?.();await f.close();});
  f.driver.validationGate=new Promise(resolve=>{release=resolve;});
  const operator=await f.user('both-operator',[{projectId:f.projectA.id,role:'operator'},{projectId:f.projectB.id,role:'operator'}]);
  const response=await f.request('POST',`/services/${f.target.id}/restore`,{backupId:f.saved.id,confirmationName:f.target.name},operator.cookie);assert.equal(response.statusCode,202);await until(async()=>f.driver.events.includes('validate')?true:undefined);
  for(const [method,path,payload] of [['POST',`/services/${f.target.id}/deploy`,undefined],['POST',`/services/${f.target.id}/backups`,undefined],['POST',`/services/${f.target.id}/stop`,undefined],['PATCH',`/services/${f.target.id}`,{notes:'race'}],['DELETE',`/services/${f.target.id}`,undefined],['PUT',`/projects/${f.projectB.id}/environment`,{env:{TOKEN:'racing-value'}}]] as [InjectOptions['method'],string,Record<string,unknown>?][])assert.equal((await f.request(method,path,payload)).statusCode,409,path);
  await f.request('PATCH',`/users/${operator.id}`,{memberships:[{projectId:f.projectA.id,role:'viewer'},{projectId:f.projectB.id,role:'operator'}]});release();let job=await f.waitRestore(response.json().id);assert.equal(job.status,'failed');assert.equal(job.preRestoreBackupId,undefined);assert.deepEqual(f.driver.events,['validate']);
  f.driver.validationGate=undefined;f.driver.events=[];f.driver.afterValidation=async()=>{await rm(join(f.directory,'backups',f.saved.filename));};
  const second=await f.request('POST',`/services/${f.target.id}/restore`,{backupId:f.saved.id,confirmationName:f.target.name});assert.equal(second.statusCode,202,second.body);job=await f.waitRestore(second.json().id);assert.equal(job.status,'success',job.error);assert.match(f.driver.restores[0].contents,/snapshot:source/);
});

test('restoration uses applied target mounts and credentials despite pending edits and reports runtime failures without changing applied mappings',async t=>{
  const f=await prepared();t.after(f.close);const oldMount=f.target.mounts[0];
  await f.request('PATCH',`/services/${f.target.id}`,{env:{...f.target.env,POSTGRES_PASSWORD:'not-applied-password'},mounts:[{name:'pending-volume',mountPath:oldMount.mountPath}]});
  f.driver.restoreFailure=`Restore failed using ${f.source.env.POSTGRES_PASSWORD}`;const response=await f.request('POST',`/services/${f.target.id}/restore`,{backupId:f.saved.id,confirmationName:f.target.name}),job=await f.waitRestore(response.json().id);assert.equal(job.status,'failed');assert.ok(!job.output.includes(f.source.env.POSTGRES_PASSWORD));assert.match(job.error!,/REDACTED/);
  assert.equal(f.driver.backups.at(-1)!.env.POSTGRES_PASSWORD,f.target.env.POSTGRES_PASSWORD);assert.equal(f.driver.restores[0].target.mounts[0].name,oldMount.name);
  const target=(await f.request('GET',`/services/${f.target.id}`)).json();assert.equal(target.env.POSTGRES_PASSWORD,'not-applied-password');assert.equal(target.containerId,`container-${target.id}`);
  await f.reopen(store=>{assert.equal(store.state.appliedServices[f.target.id].env.POSTGRES_PASSWORD,f.target.env.POSTGRES_PASSWORD);assert.equal(store.state.appliedServices[f.target.id].volumeOverrides?.[oldMount.name],undefined);});
  assert.equal((await f.request('GET',`/restores/${job.id}`)).json().status,'failed');
});

test('legacy backups without restore manifests are refused and interrupted durable jobs recover as failed',async t=>{
  const f=await prepared();t.after(f.close);const id=randomUUID();
  await f.reopen(store=>{delete store.state.backups.find(item=>item.id===f.saved.id)!.metadata;store.state.restores.push({id,sourceBackupId:f.saved.id,sourceProjectId:f.projectA.id,targetServiceId:f.target.id,targetProjectId:f.projectB.id,requestedBy:store.state.users[0].id,status:'running',phase:'restoring',createdAt:new Date().toISOString(),output:'Previous volumes retained.'});});
  const response=await f.request('POST',`/services/${f.target.id}/restore`,{backupId:f.saved.id,confirmationName:f.target.name});assert.equal(response.statusCode,409);assert.match(response.json().error,/metadata/);assert.deepEqual(f.driver.events,[]);
  const recovered=(await f.request('GET',`/restores/${id}`)).json();assert.equal(recovered.status,'failed');assert.equal(recovered.phase,'finished');assert.ok(recovered.finishedAt);assert.match(recovered.error,/restart/);
});

test('project environment is operator-only, applies explicit service overrides and backups keep the last deployed environment after pending edits',async t=>{
  const f=await fixture();t.after(f.close);
  const env={SHARED_SECRET:'inherited-secret-123456',CHOICE:'project-default',EMPTY:'project-default'};
  assert.equal((await f.request('PUT',`/projects/${f.projectA.id}/environment`,{env})).statusCode,200);
  const web=await f.create(f.projectA.id,'volume-app',{kind:'app',env:{CHOICE:'service-value',EMPTY:''},mounts:[{name:'data',mountPath:'/data'}]});
  const viewer=await f.user('env-viewer',[{projectId:f.projectA.id,role:'viewer'}]),operator=await f.user('env-operator',[{projectId:f.projectA.id,role:'operator'}]);
  for(const path of [`/projects/${f.projectA.id}/environment`,`/services/${web.id}/environment`]){assert.equal((await f.request('GET',path,undefined,viewer.cookie)).statusCode,403);assert.equal((await f.request('GET',path,undefined,operator.cookie)).statusCode,200);}
  assert.equal((await f.request('PUT',`/projects/${f.projectB.id}/environment`,{env},operator.cookie)).statusCode,404);
  const read=(await f.request('POST','/api-keys',{name:'env-read',projectIds:[f.projectA.id],permission:'read'})).json();assert.equal((await f.request('GET',`/services/${web.id}/environment`,undefined,read.token)).statusCode,403);
  const effective=(await f.request('GET',`/services/${web.id}/environment`)).json();assert.deepEqual(effective.inherited,env);assert.deepEqual(effective.overrides,{CHOICE:'service-value',EMPTY:''});assert.deepEqual(effective.effective,{...env,CHOICE:'service-value',EMPTY:''});
  await f.deploy(web);assert.deepEqual(f.driver.deployments.at(-1)!.service.env,effective.effective);
  assert.equal((await f.request('PUT',`/projects/${f.projectA.id}/environment`,{env:{...env,SHARED_SECRET:'next-inherited-secret-654321'}})).statusCode,200);
  await f.request('PATCH',`/services/${web.id}`,{env:{CHOICE:'pending-service-value',EMPTY:''},mounts:[{name:'pending',mountPath:'/data'}]});
  f.driver.logText='inherited-secret-123456 next-inherited-secret-654321 pending-service-value';const log=(await f.request('GET',`/services/${web.id}/logs`)).json().logs;assert.equal(log.includes('inherited-secret'),false);assert.equal(log.includes('pending-service-value'),false);
  await f.backup(web);assert.deepEqual(f.driver.backups.at(-1)!.env,effective.effective);assert.equal(f.driver.backups.at(-1)!.mounts[0].name,'data');
  assert.deepEqual((await f.request('GET','/services')).json()[0].env,{});
  await f.reopen(store=>{assert.equal(store.state.projectEnvironments[f.projectA.id].SHARED_SECRET,'next-inherited-secret-654321');assert.equal(store.state.appliedServices[web.id].env.SHARED_SECRET,env.SHARED_SECRET);});
});

test('project environment marks only changed effective configurations, validates without echoing values and preserves Compose precedence inputs',async t=>{
  const f=await fixture();t.after(f.close);
  await f.request('PUT',`/projects/${f.projectA.id}/environment`,{env:{CHOICE:'initial-project-value'}});
  const shadowed=await f.create(f.projectA.id,'shadowed',{kind:'app',env:{CHOICE:'service-choice'}}),inherited=await f.create(f.projectA.id,'inherited',{kind:'app'});
  await new Promise(resolve=>setTimeout(resolve,3));
  await f.request('PUT',`/projects/${f.projectA.id}/environment`,{env:{CHOICE:'changed-project-value'}});
  assert.equal((await f.request('GET',`/services/${shadowed.id}`)).json().updatedAt,shadowed.updatedAt);assert.ok((await f.request('GET',`/services/${inherited.id}`)).json().updatedAt>inherited.updatedAt);
  const invalid=await f.request('PUT',`/projects/${f.projectA.id}/environment`,{env:{TOKEN:'private-string\nNEXT=value'}});assert.equal(invalid.statusCode,400);assert.equal(invalid.body.includes('private-string'),false);
  const stack=await f.create(f.projectA.id,'stack',{kind:'compose',source:{type:'compose',compose:'services:\n  web:\n    image: nginx:alpine\n    environment:\n      CHOICE: child-choice\n'},env:{OWN:'service-own'}});
  await f.deploy(stack);const deployment=f.driver.deployments.at(-1)!;assert.deepEqual(deployment.service.env,{OWN:'service-own'});assert.deepEqual(deployment.options.projectEnvironment,{CHOICE:'changed-project-value'});
});

test('restart reconciliation commits the verified candidate or original volume mapping and blocks mutations for unknown runtime identities',async t=>{
  const f=await prepared();t.after(f.close);const mount=f.target.mounts[0],candidateVolume=`hl-${f.target.id}-restore-${randomUUID()}-data`;
  let preparedJobId='';
  const seedIntent=async(store:Store)=>{
    const previousService=structuredClone(store.state.appliedServices[f.target.id]),result={containerId:`replacement-${f.target.id}`,volumeOverrides:{[mount.name]:candidateVolume},environment:{POSTGRES_PASSWORD:f.source.env.POSTGRES_PASSWORD}};
    const preparedService={...previousService,containerId:result.containerId,env:{...previousService.env,...result.environment},volumeOverrides:result.volumeOverrides};
    const job:RestoreJob={id:randomUUID(),sourceBackupId:f.saved.id,sourceProjectId:f.projectA.id,targetServiceId:f.target.id,targetProjectId:f.projectB.id,requestedBy:store.state.users[0].id,status:'running',phase:'restoring',createdAt:new Date().toISOString(),output:'Checkpoint persisted.'};
    preparedJobId=job.id;await mkdir(join(f.directory,'restore-work',job.id),{recursive:true});await link(join(f.directory,'backups',f.saved.filename),join(f.directory,'restore-work',job.id,'pinned.backup'));
    store.state.restores.unshift(job);store.state.restoreIntents[job.id]={previousService,preparedService,result,checkpoint:{restoreId:randomUUID(),previousContainerId:previousService.containerId!,candidateContainerId:result.containerId,previousWasRunning:true}};
  };
  f.driver.recoveryFailure='Unexpected unowned canonical container';await f.reopen(seedIntent);
  assert.equal((await f.request('GET',`/services/${f.target.id}`)).json().status,'failed');
  assert.ok((await lstat(join(f.directory,'restore-work',preparedJobId,'pinned.backup'))).isFile(),'Unresolved restore must retain pinned evidence');
  for(const [method,path,payload] of [['POST',`/services/${f.target.id}/deploy`,undefined],['POST',`/services/${f.target.id}/backups`,undefined],['POST',`/services/${f.target.id}/start`,undefined],['PATCH',`/services/${f.target.id}`,{notes:'unsafe'}],['DELETE',`/services/${f.target.id}`,undefined],['PUT',`/projects/${f.projectB.id}/environment`,{env:{TOKEN:'new-env'}}]] as [InjectOptions['method'],string,Record<string,unknown>?][])assert.equal((await f.request(method,path,payload)).statusCode,409,path);
  f.driver.recoveryFailure=undefined;f.driver.recoveryOutcome='activated';await f.reopen(store=>{assert.equal(Object.keys(store.state.restoreIntents).length,1);});
  await assert.rejects(lstat(join(f.directory,'restore-work',preparedJobId)),{code:'ENOENT'});
  const recovered=(await f.request('GET','/restores')).json()[0];assert.equal(recovered.status,'failed');assert.match(recovered.error,/replacement volumes are active/);
  let target=(await f.request('GET',`/services/${f.target.id}`)).json() as Service;assert.equal(target.containerId,`replacement-${f.target.id}`);assert.equal(target.env.POSTGRES_PASSWORD,f.source.env.POSTGRES_PASSWORD);await f.deploy(target);assert.equal(f.driver.deployments.at(-1)!.service.volumeOverrides?.[mount.name],candidateVolume);
  f.driver.recoveryOutcome='rolled-back';await f.reopen(seedIntent);target=(await f.request('GET',`/services/${f.target.id}`)).json();assert.equal(target.containerId,`container-${target.id}`);assert.match((await f.request('GET','/restores')).json()[0].error,/original volumes were restored/);
  await assert.rejects(lstat(join(f.directory,'restore-work',preparedJobId)),{code:'ENOENT'});
  await f.reopen(store=>{assert.deepEqual(store.state.restoreIntents,{});assert.equal(store.state.appliedServices[f.target.id].volumeOverrides?.[mount.name],candidateVolume);});
});

test('startup removes only known finished restore workspaces and never follows parent or job directory symlinks',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'harborlight-workspace-cleanup-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=new Store(directory),driver=new RecoveryDriver();t.after(()=>store.close());
  const record=(id:string):RestoreJob=>({id,sourceBackupId:randomUUID(),targetServiceId:randomUUID(),targetProjectId:randomUUID(),requestedBy:randomUUID(),status:'failed',phase:'finished',createdAt:new Date().toISOString(),output:''});
  const finished=randomUUID(),unknown=randomUUID(),linked=randomUUID(),parent=join(directory,'restore-work'),outside=join(directory,'outside');
  for(const path of [join(parent,finished),join(parent,unknown),outside]){await mkdir(path,{recursive:true});await writeFile(join(path,'keep'),'evidence');}
  await symlink(outside,join(parent,linked));store.state.restores.push(record(finished),record(linked),record('../outside'));store.save();
  await recoverPreparedRestores(store,driver);
  await assert.rejects(lstat(join(parent,finished)),{code:'ENOENT'});
  assert.equal(await readFile(join(parent,unknown,'keep'),'utf8'),'evidence');assert.equal(await readFile(join(outside,'keep'),'utf8'),'evidence');assert.ok((await lstat(join(parent,linked))).isSymbolicLink());
  await rm(parent,{recursive:true,force:true});await mkdir(join(outside,finished));await writeFile(join(outside,finished,'keep'),'outside-parent');await symlink(outside,parent);
  await recoverPreparedRestores(store,driver);
  assert.equal(await readFile(join(outside,finished,'keep'),'utf8'),'outside-parent');assert.ok((await lstat(parent)).isSymbolicLink());
});
