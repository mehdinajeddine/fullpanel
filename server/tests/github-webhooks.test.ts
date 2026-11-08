import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { readFile, rename, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { githubBodyLimit, verifyGitHubSignature } from '../github-webhooks.js';
import { milestoneFixture } from './milestone-fixture.js';

const push=(extra:Record<string,unknown>={})=>({ref:'refs/heads/main',after:'b'.repeat(40),deleted:false,repository:{full_name:'acme/site',html_url:'https://github.com/acme/site'},...extra});
async function prepared(){const f=await milestoneFixture();const service=await f.create({source:{type:'git',repository:'https://github.com/acme/site.git',branch:'main'}});const rotate=await f.request('POST',`/services/${service.id}/github-webhook/rotate`,{});assert.equal(rotate.statusCode,200,rotate.body);const secret=rotate.json().secret as string;
  const hook=(payload:unknown=push(),options:{secret?:string;body?:Buffer;event?:string;delivery?:string;headers?:Record<string,string>}={})=>{const body=options.body||Buffer.from(JSON.stringify(payload));return f.raw({method:'POST',url:`/api/hooks/github/${service.id}`,payload:body,headers:{'content-type':'application/json','x-hub-signature-256':`sha256=${createHmac('sha256',options.secret||secret).update(body).digest('hex')}`,'x-github-event':options.event||'push','x-github-delivery':options.delivery||randomUUID(),...options.headers}});};
  return {...f,service,secret,hook};}

test('GitHub HMAC matches the official vector and preserves exact UTF-8 bytes and whitespace',()=>{
  assert.equal(verifyGitHubSignature("It's a Secret to Everybody",Buffer.from('Hello, World!'),'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17'),true);
  const body=Buffer.from('{ "message": "é 🚢" }'),secret='test-secret',signature=`sha256=${createHmac('sha256',secret).update(body).digest('hex')}`;
  assert.equal(verifyGitHubSignature(secret,body,signature),true);assert.equal(verifyGitHubSignature(secret,Buffer.from('{"message":"é 🚢"}'),signature),false);
  for(const invalid of [undefined,'sha1=abc','sha256=abc',signature+'00',signature.toUpperCase()])assert.equal(verifyGitHubSignature(secret,body,invalid),false);
});

test('GitHub accepts the bound branch commit once, suppresses changed delivery-id replays and never consumes ignored events',async t=>{
  const f=await prepared();t.after(f.close);
  const ping=await f.hook({zen:'Keep it simple'},{event:'ping'});assert.deepEqual(ping.json(),{status:'pong'});
  for(const payload of [push({deleted:true}),push({ref:'refs/tags/v1'}),push({ref:'refs/heads/other'}),push({repository:{full_name:'other/site',html_url:'https://github.com/other/site'}})])assert.equal((await f.hook(payload)).json().status,'ignored');
  assert.equal(f.driver.deployments.length,0);
  const delivery=randomUUID(),accepted=await f.hook(push(),{delivery});assert.equal(accepted.statusCode,202,accepted.body);assert.equal(accepted.json().requestedCommit,'b'.repeat(40));
  const job=await f.waitJob(accepted.json().deploymentId);assert.equal(job.status,'success',job.output);assert.equal(job.requestedCommit,'b'.repeat(40));assert.equal(job.commit,job.requestedCommit);assert.equal(f.driver.deployments[0].options.expectedCommit,job.requestedCommit);
  for(const id of [delivery,randomUUID()]){const duplicate=await f.hook(push(),{delivery:id});assert.equal(duplicate.statusCode,200);assert.deepEqual(duplicate.json(),{status:'duplicate',deploymentId:job.id});}
  const status=(await f.request('GET',`/services/${f.service.id}/github-webhook`)).json();assert.equal(status.enabled,true);assert.equal(status.secret,undefined);assert.equal(status.lastDelivery.deploymentId,job.id);
  assert.equal(f.driver.deployments.length,1);
  const encrypted=await readFile(join(f.directory,'state.enc'));assert.equal(encrypted.includes(Buffer.from(f.secret)),false);
  await f.reopen();assert.equal((await f.hook(push())).json().status,'duplicate');assert.equal(f.driver.deployments.length,1);
});

test('GitHub verifies raw JSON bytes before processing, rejects invalid types and bounds payload size',async t=>{
  const f=await prepared();t.after(f.close);
  const body=Buffer.from(JSON.stringify(push())),signature=`sha256=${createHmac('sha256',f.secret).update(body).digest('hex')}`;
  const tampered=await f.hook(push(),{body:Buffer.concat([body,Buffer.from(' ')]),headers:{'x-hub-signature-256':signature}});assert.equal(tampered.statusCode,401);
  assert.equal((await f.hook(push(),{secret:'incorrect'})).statusCode,401);
  assert.equal((await f.hook(push(),{headers:{'content-type':'text/plain'}})).statusCode,415);
  assert.equal((await f.hook(push(),{body:Buffer.from('not-json')})).statusCode,400);
  assert.equal((await f.hook(push(),{body:Buffer.alloc(githubBodyLimit+1,65)})).statusCode,413);
  assert.equal((await f.hook(push(),{headers:{'content-encoding':'gzip'}})).statusCode,415);
  assert.equal((await f.raw({method:'GET',url:`/api/hooks/github/${f.service.id}`})).statusCode,404);
  assert.equal(f.driver.deployments.length,0);
});

test('busy delivery retries succeed and the receipt is durable in the same queued deployment state',async t=>{
  const f=await prepared();let unlock!:()=>void;t.after(async()=>{unlock?.();await f.close();});f.driver.gate=new Promise(resolve=>{unlock=resolve;});
  const manual=await f.request('POST',`/services/${f.service.id}/deploy`,{});assert.equal(manual.statusCode,202);
  const delivery=randomUUID();assert.equal((await f.hook(push(),{delivery})).statusCode,409);
  assert.equal((await f.request('GET',`/services/${f.service.id}/github-webhook`)).json().lastDelivery,undefined);
  unlock();assert.equal((await f.waitJob(manual.json().id)).status,'success');f.driver.gate=undefined;
  const accepted=await f.hook(push(),{delivery});assert.equal(accepted.statusCode,202,accepted.body);await f.waitJob(accepted.json().deploymentId);
  await f.inspectState(store=>{const receipt=store.state.githubWebhooks[f.service.id].deliveries[0];assert.equal(receipt.deploymentId,accepted.json().deploymentId);assert.ok(store.state.deployments.some(item=>item.id===receipt.deploymentId));});
  assert.equal((await f.hook(push(),{delivery})).json().status,'duplicate');
});

test('GitHub management is cookie-operator only, source changes require rotation and issuer changes revoke secrets permanently',async t=>{
  const f=await prepared();t.after(f.close);const path=`/services/${f.service.id}/github-webhook`;
  const viewer=await f.user('viewer','viewer'),operator=await f.user('operator','operator');
  assert.equal((await f.request('GET',path,undefined,viewer.cookie)).statusCode,403);
  const key=(await f.request('POST','/api-keys',{name:'operator-key',projectIds:[f.project.id],permission:'write'})).json();assert.equal((await f.request('POST',`${path}/rotate`,{},key.token)).statusCode,403);
  await f.request('PATCH',`/services/${f.service.id}`,{source:{type:'git',repository:'https://github.com/acme/site.git',branch:'other'}});
  assert.equal((await f.hook()).statusCode,401);assert.equal((await f.request('GET',path)).json().enabled,false);
  await f.request('PATCH',`/services/${f.service.id}`,{source:{type:'git',repository:'https://github.com/acme/site.git',branch:'main'}});
  assert.equal((await f.hook()).statusCode,401,'Changing back must not revive a disabled secret.');
  const rotation=await f.request('POST',`${path}/rotate`,{},operator.cookie);assert.equal(rotation.statusCode,200);assert.notEqual(rotation.json().secret,f.secret);
  assert.equal((await f.hook()).statusCode,401);const payload=push({after:'c'.repeat(40)});const accepted=await f.hook(payload,{secret:rotation.json().secret});assert.equal(accepted.statusCode,202,accepted.body);await f.waitJob(accepted.json().deploymentId);
  await f.request('POST',`/users/${operator.user.id}/password`,{password:'replacement-password-12345'});
  assert.equal((await f.hook(payload,{secret:rotation.json().secret})).statusCode,401);assert.equal((await f.request('GET',path)).json().configured,false);
  await f.request('DELETE',path);assert.equal((await f.hook()).statusCode,401);
});

test('failed queue persistence rolls back both replay receipt and job, permitting the exact delivery after storage recovery',async t=>{
  const f=await prepared();t.after(f.close);const state=join(f.directory,'state.enc'),previous=join(f.directory,'state.previous'),delivery=randomUUID();
  await rename(state,previous);await mkdir(state);
  try {
    const rejected=await f.hook(push(),{delivery});assert.equal(rejected.statusCode,500,rejected.body);assert.equal(f.driver.deployments.length,0);
    assert.equal((await f.request('GET',`/services/${f.service.id}/github-webhook`)).json().lastDelivery,undefined);assert.deepEqual((await f.request('GET','/deployments')).json(),[]);
  } finally {
    await rm(state,{recursive:true,force:true});await rename(previous,state);await f.restartAfterStorageFailure();
  }
  const accepted=await f.hook(push(),{delivery});assert.equal(accepted.statusCode,202,accepted.body);assert.equal((await f.waitJob(accepted.json().deploymentId)).status,'success');
  assert.equal((await f.hook(push(),{delivery})).json().status,'duplicate');
});

test('GitHub persisted replay records remain bounded per rotated secret',async t=>{
  const f=await prepared();t.after(f.close);
  await f.inspectState(store=>{store.state.githubWebhooks[f.service.id].deliveries=Array.from({length:256},(_,index)=>({id:randomUUID(),bodyDigest:index.toString(16).padStart(64,'0'),deploymentId:randomUUID(),receivedAt:new Date().toISOString()}));});
  const accepted=await f.hook();assert.equal(accepted.statusCode,202,accepted.body);await f.waitJob(accepted.json().deploymentId);
  await f.inspectState(store=>{const records=store.state.githubWebhooks[f.service.id].deliveries;assert.equal(records.length,256);assert.equal(records[0].deploymentId,accepted.json().deploymentId);});
  await f.request('POST',`/services/${f.service.id}/github-webhook/rotate`,{});
  await f.inspectState(store=>assert.deepEqual(store.state.githubWebhooks[f.service.id].deliveries,[]));
});
