import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ReleasesResponse, Service } from '../../shared/types.js';
import { rename, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { milestoneFixture, until } from './milestone-fixture.js';

async function prepared(){const f=await milestoneFixture();const service=await f.create({env:{SECRET:'release-a-secret'},mounts:[{name:'data',mountPath:'/data'}]});const first=await f.deploy(service);const releaseA=(await f.request('GET',`/services/${service.id}/releases`)).json().releases[0];await f.request('PATCH',`/services/${service.id}`,{env:{SECRET:'release-b-secret'}});const second=await f.deploy(service);return {...f,service,first,second,releaseA};}

test('immutable release metadata omits configuration and secrets, while rollback preserves desired edits and current volumes',async t=>{
  const f=await prepared();t.after(f.close);const desired={SECRET:'desired-c-secret'};
  await f.request('PATCH',`/services/${f.service.id}`,{env:desired});const volume=`hl-${f.service.id}-restore-${randomUUID()}-data`;
  await f.inspectState(store=>{const record=store.state.releases.find(item=>item.metadata.id===f.releaseA.id)!;assert.equal(record.service.env.SECRET,'release-a-secret');assert.equal((record as unknown as {sourceCredentials?:unknown}).sourceCredentials,undefined);store.state.appliedServices[f.service.id].volumeOverrides={data:volume};});
  const viewer=await f.user('viewer','viewer');const listing=await f.request('GET',`/services/${f.service.id}/releases`,undefined,viewer.cookie);assert.equal(listing.statusCode,200);assert.ok(!listing.body.includes('release-a-secret'));assert.ok(!listing.body.includes('desired-c-secret'));assert.ok(!listing.body.includes('proxyAuth'));assert.ok(!listing.body.includes('releaseTag'));assert.ok(!listing.body.includes('dockerfile'));
  const response=await f.request('POST',`/services/${f.service.id}/rollback`,{releaseId:f.releaseA.id,confirmationName:f.service.name});assert.equal(response.statusCode,202,response.body);const job=await f.waitJob(response.json().id);assert.equal(job.status,'success',job.output);assert.equal(job.rollbackOf,f.releaseA.id);assert.ok(job.releaseId);assert.notEqual(job.releaseId,f.releaseA.id);
  const applied=f.driver.rollbacks[0];assert.equal(applied.options.imageId,f.releaseA.imageId);assert.equal(applied.options.releaseTag,`harborlight-release/${f.service.id}:${f.releaseA.id}`);assert.deepEqual(applied.service.env,{SECRET:'release-a-secret'});assert.deepEqual(applied.service.volumeOverrides,{data:volume});assert.equal((applied.options as unknown as {sourceCredentials?:unknown}).sourceCredentials,undefined);assert.ok(!job.output.includes('release-a-secret'));assert.match(job.output,/REDACTED/);
  const current=(await f.request('GET',`/services/${f.service.id}`)).json() as Service;assert.deepEqual(current.env,desired);assert.equal(current.pendingChanges,true);assert.equal(current.activeReleaseId,job.releaseId);assert.ok(current.deployedAt!>current.updatedAt);
  const releases=(await f.request('GET',`/services/${f.service.id}/releases`)).json() as ReleasesResponse;assert.equal(releases.releases[0].rollbackOf,f.releaseA.id);assert.equal(releases.releases[0].canRollback,false);assert.equal(releases.releases[0].imageId,f.releaseA.imageId);
  await f.deploy(current);assert.equal((await f.request('GET',`/services/${f.service.id}`)).json().pendingChanges,false);assert.equal(f.driver.deployments.at(-1)!.service.env.SECRET,desired.SECRET);
});

test('release snapshots retain effective project variables and proxy auth hashes without exposing either',async t=>{
  const f=await milestoneFixture();t.after(f.close);
  await f.request('PUT',`/projects/${f.project.id}/environment`,{env:{SHARED_SECRET:'project-a-secret'}});
  const domainId=randomUUID(),service=await f.create({domains:[{id:domainId,hostname:'releases.example.test',path:'/',https:false,port:80}]});
  await f.request('PUT',`/services/${service.id}/domains/${domainId}/auth`,{username:'owner',password:'proxy-password-first'});await f.deploy(service);
  const first=(await f.request('GET',`/services/${service.id}/releases`)).json().releases[0];let previousHash='';
  await f.inspectState(store=>{previousHash=store.state.releases[0].proxyAuth[domainId].passwordHash;assert.equal(store.state.releases[0].service.env.SHARED_SECRET,'project-a-secret');});
  await f.request('PUT',`/projects/${f.project.id}/environment`,{env:{SHARED_SECRET:'project-b-secret'}});await f.request('DELETE',`/services/${service.id}/domains/${domainId}/auth`);await f.deploy(service);
  const rollback=await f.request('POST',`/services/${service.id}/rollback`,{releaseId:first.id,confirmationName:service.name});const job=await f.waitJob(rollback.json().id);assert.equal(job.status,'success',job.output);assert.equal(f.driver.rollbacks[0].options.proxyAuth?.[domainId].passwordHash,previousHash);assert.equal(f.driver.rollbacks[0].service.env.SHARED_SECRET,'project-a-secret');
  const publicRows=await f.request('GET',`/services/${service.id}/releases`);assert.ok(!publicRows.body.includes(previousHash));assert.ok(!publicRows.body.includes('project-a-secret'));assert.equal((await f.request('GET',`/services/${service.id}`)).json().pendingChanges,true);
  await f.inspectState(store=>{assert.deepEqual(store.state.proxyAuth[service.id],{});assert.equal(store.state.appliedProxyAuth[service.id][domainId].passwordHash,previousHash);});
});

test('rollback authorizes the owning project, requires exact confirmation and never supports database or Compose releases',async t=>{
  const f=await prepared();t.after(f.close);const viewer=await f.user('viewer','viewer'),operator=await f.user('operator','operator');const path=`/services/${f.service.id}/rollback`,payload={releaseId:f.releaseA.id,confirmationName:f.service.name};
  assert.equal((await f.request('POST',path,{...payload,confirmationName:'WEB'})).statusCode,400);assert.equal((await f.request('POST',path,payload,viewer.cookie)).statusCode,403);
  const foreign=await f.create({projectId:f.otherProject.id,name:'other'});await f.deploy(foreign);const foreignRelease=(await f.request('GET',`/services/${foreign.id}/releases`)).json().releases[0];assert.equal((await f.request('POST',path,{...payload,releaseId:foreignRelease.id},operator.cookie)).statusCode,404);assert.equal((await f.request('GET',`/services/${foreign.id}/releases`,undefined,operator.cookie)).statusCode,404);
  for(const kind of ['postgres','compose']){const service=await f.create({name:kind,kind});const status=(await f.request('GET',`/services/${service.id}/releases`)).json();assert.equal(status.supported,false);assert.match(status.reason,/Database and Compose/);assert.equal((await f.request('POST',`/services/${service.id}/rollback`,{...payload,confirmationName:service.name})).statusCode,409);}
  const read=(await f.request('POST','/api-keys',{name:'read',projectIds:[f.project.id],permission:'read'})).json();assert.equal((await f.request('POST',path,payload,read.token)).statusCode,403);
});

test('rollback rejects active mount changes and domain, port or network alias conflicts retained only in another applied configuration',async t=>{
  const f=await milestoneFixture();t.after(f.close);const service=await f.create({name:'original-alias',mounts:[{name:'data',mountPath:'/data'}],domains:[{hostname:'old.example.test',path:'/',https:false,port:80}],ports:[{published:18081,target:80,protocol:'tcp'}]});await f.deploy(service);const first=(await f.request('GET',`/services/${service.id}/releases`)).json().releases[0];
  await f.request('PATCH',`/services/${service.id}`,{name:'new-alias',domains:[],ports:[]});await f.deploy(service);
  const other=await f.create({name:'original-alias',domains:[{hostname:'old.example.test',path:'/',https:false,port:80}],ports:[{published:18081,target:80,protocol:'tcp'}]});await f.deploy(other);
  await f.request('PATCH',`/services/${other.id}`,{name:'moved-alias',domains:[],ports:[]});
  const payload={releaseId:first.id,confirmationName:'new-alias'},path=`/services/${service.id}/rollback`;
  const alias=await f.request('POST',path,payload);assert.equal(alias.statusCode,409);assert.match(alias.json().error,/name/);
  assert.equal((await f.request('POST','/services',{projectId:f.project.id,name:'original-alias',kind:'app'})).statusCode,409);
  // Keep only each applied reservation in turn to prove the separate checks.
  await f.inspectState(store=>{store.state.appliedServices[other.id].name='moved-alias';});let denied=await f.request('POST',path,payload);assert.equal(denied.statusCode,409);assert.match(denied.json().error,/domain route/);
  await f.inspectState(store=>{store.state.appliedServices[other.id].domains=[];});denied=await f.request('POST',path,payload);assert.equal(denied.statusCode,409);assert.match(denied.json().error,/published port/);
  await f.deploy(other);await f.request('PATCH',`/services/${service.id}`,{mounts:[{name:'different',mountPath:'/elsewhere'}]});await f.deploy(service);denied=await f.request('POST',path,payload);assert.equal(denied.statusCode,409);assert.match(denied.json().error,/volume names or mount paths/);assert.equal(f.driver.rollbacks.length,0);
});

test('rollback shares mutation locks and runtime failures preserve applied release identity and redact old secrets',async t=>{
  const f=await prepared();let unlock!:()=>void;t.after(async()=>{unlock?.();await f.close();});const active=(await f.request('GET',`/services/${f.service.id}`)).json().activeReleaseId;
  f.driver.gate=new Promise(resolve=>{unlock=resolve;});f.driver.rollbackFailure='Local image unavailable; release-a-secret';
  const response=await f.request('POST',`/services/${f.service.id}/rollback`,{releaseId:f.releaseA.id,confirmationName:f.service.name});assert.equal(response.statusCode,202);
  assert.equal((await f.request('POST',`/services/${f.service.id}/deploy`,{})).statusCode,409);assert.equal((await f.request('POST',`/services/${f.service.id}/backups`)).statusCode,409);assert.equal((await f.request('PATCH',`/services/${f.service.id}`,{notes:'race'})).statusCode,409);
  unlock();const job=await f.waitJob(response.json().id);assert.equal(job.status,'failed');assert.ok(!job.output.includes('release-a-secret'));assert.match(job.output,/REDACTED/);assert.equal((await f.request('GET',`/services/${f.service.id}`)).json().activeReleaseId,active);
});

test('restart invalidates active-release claims after interrupted deployment and blocks rollback or backup until a successful deploy reconciles state',async t=>{
  const f=await prepared();t.after(f.close);
  await f.inspectState(store=>{store.state.deployments.unshift({id:randomUUID(),serviceId:f.service.id,projectId:f.project.id,status:'running',trigger:'Rollback',rollbackOf:f.releaseA.id,createdAt:new Date().toISOString(),output:''});store.state.services.find(item=>item.id===f.service.id)!.status='deploying';});
  const current=(await f.request('GET',`/services/${f.service.id}`)).json() as Service;assert.equal(current.runtimeUncertain,true);assert.equal(current.activeReleaseId,undefined);assert.equal(current.pendingChanges,true);
  assert.equal((await f.request('POST',`/services/${f.service.id}/rollback`,{releaseId:f.releaseA.id,confirmationName:f.service.name})).statusCode,409);assert.equal((await f.request('POST',`/services/${f.service.id}/backups`)).statusCode,409);
  assert.equal((await f.request('PATCH',`/services/${f.service.id}`,{domains:[],name:'free-old-alias'})).statusCode,409);
  assert.equal((await f.request('PUT',`/projects/${f.project.id}/environment`,{env:{SECRET:'replace-uncertain-env'}})).statusCode,409);
  await f.deploy(current);const reconciled=(await f.request('GET',`/services/${f.service.id}`)).json();assert.equal(reconciled.runtimeUncertain,undefined);assert.ok(reconciled.activeReleaseId);assert.equal(reconciled.pendingChanges,false);
});

test('a failed final state write never advertises a stale active release and forces reconciliation after restart',async t=>{
  const f=await prepared();t.after(f.close);const state=join(f.directory,'state.enc'),previous=join(f.directory,'previous-state.enc');
  await f.request('PATCH',`/services/${f.service.id}`,{env:{SECRET:'new-runtime-secret'}});
  f.driver.afterDeploy=async()=>{await rename(state,previous);await mkdir(state);};
  const accepted=await f.request('POST',`/services/${f.service.id}/deploy`,{});assert.equal(accepted.statusCode,202,accepted.body);
  try {
    await until(async()=>{const response=await f.request('POST',`/services/${f.service.id}/deploy`,{});return response.statusCode===503?true:undefined;});
    const service=(await f.request('GET',`/services/${f.service.id}`)).json();assert.equal(service.status,'failed');assert.equal(service.runtimeUncertain,true);assert.equal(service.activeReleaseId,undefined);
    const releases=(await f.request('GET',`/services/${f.service.id}/releases`)).json();assert.equal(releases.activeReleaseId,undefined);assert.ok(releases.releases.every((release:{canRollback:boolean})=>!release.canRollback));
  } finally {
    f.driver.afterDeploy=undefined;await rm(state,{recursive:true,force:true});await rename(previous,state);await f.restartAfterStorageFailure();
  }
  const service=(await f.request('GET',`/services/${f.service.id}`)).json();assert.equal(service.runtimeUncertain,true);assert.equal(service.activeReleaseId,undefined);
  await f.deploy(service);assert.equal((await f.request('GET',`/services/${f.service.id}`)).json().pendingChanges,false);
});

test('rollback candidate reservations and historical secret redaction survive interruption until reconciliation',async t=>{
  const f=await milestoneFixture();let unlock!:()=>void;t.after(async()=>{unlock?.();await f.close();});
  const service=await f.create({name:'historical-alias',env:{SECRET:'historical-only-password'},domains:[{hostname:'candidate.example.test',path:'/',https:false,port:80}],ports:[{published:18089,target:80,protocol:'tcp'}]});
  await f.deploy(service);const first=(await f.request('GET',`/services/${service.id}/releases`)).json().releases[0];
  await f.request('PATCH',`/services/${service.id}`,{name:'current-alias',env:{SECRET:'current-only-password'},domains:[],ports:[]});await f.deploy(service);
  f.driver.gate=new Promise(resolve=>{unlock=resolve;});f.driver.rollbackFailure='Simulated pre-switch failure';
  const accepted=await f.request('POST',`/services/${service.id}/rollback`,{releaseId:first.id,confirmationName:'current-alias'});assert.equal(accepted.statusCode,202,accepted.body);
  const attempts=[{name:'historical-alias'},{name:'claim-domain',domains:[{hostname:'candidate.example.test',path:'/',https:false,port:80}]},{name:'claim-port',ports:[{published:18089,target:80,protocol:'tcp'}]}];
  const assertReserved=async()=>{for(const attempt of attempts){const response=await f.request('POST','/services',{projectId:f.project.id,kind:'app',...attempt});assert.equal(response.statusCode,409,response.body);}};
  await assertReserved();unlock();await f.waitJob(accepted.json().id);f.driver.gate=undefined;f.driver.rollbackFailure=undefined;
  await f.inspectState(store=>{const job=store.state.deployments.find(item=>item.id===accepted.json().id)!;job.status='running';delete job.finishedAt;store.state.services.find(item=>item.id===service.id)!.status='deploying';assert.deepEqual(store.state.pendingReleaseIds[service.id],[first.id]);});
  await assertReserved();f.driver.logOutput='Current runtime contains historical-only-password';const logs=await f.request('GET',`/services/${service.id}/logs`);assert.equal(logs.statusCode,200);assert.ok(!logs.body.includes('historical-only-password'));assert.match(logs.body,/REDACTED/);
  await f.deploy(service);const reclaimed=await f.request('POST','/services',{projectId:f.project.id,kind:'app',name:'historical-alias'});assert.equal(reclaimed.statusCode,201,reclaimed.body);
  await f.inspectState(store=>{assert.equal(store.state.pendingReleaseIds[service.id],undefined);});
});
