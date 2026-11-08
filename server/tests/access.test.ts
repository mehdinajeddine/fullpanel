import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { InjectOptions } from 'fastify';
import { createApp } from '../app.js';
import { DemoDriver, type DeployOptions, type Output } from '../docker.js';
import type { Service, PublicUser } from '../../shared/types.js';
import { Store } from '../store.js';

class AccessDriver extends DemoDriver {
  lastOptions?: DeployOptions;
  override async deploy(service: Service, output: Output, options: DeployOptions = {}) {
    this.lastOptions = options;
    output(`Build output for ${service.name}\n`);
    for (const credential of [options.sourceCredentials?.git?.token, options.sourceCredentials?.registry?.password]) if (credential) { output(credential.slice(0, 3)); output(credential.slice(3)); }
    return { image: service.source.image || 'built' };
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'harborlight-access-'));
  const driver = new AccessDriver();
  const app = await createApp({ dataDir: directory, mode: 'docker', driver });
  const request = (cookie: string, method: InjectOptions['method'], path: string, payload?: Record<string, unknown>, headers: Record<string,string> = {}) => app.inject({ method, url: `/api${path}`, headers: { ...(cookie ? { cookie } : {}), ...headers }, ...(payload === undefined ? {} : { payload }) });
  const setup = await request('', 'POST', '/auth/setup', { name: 'Owner', email: 'owner@example.test', password: 'test-password-owner-123' });
  assert.equal(setup.statusCode, 200, setup.body);
  const ownerCookie = String(setup.headers['set-cookie']).split(';')[0], owner = setup.json().user as PublicUser;
  const login = async (email: string, password = 'test-password-member-123') => { const response = await request('', 'POST', '/auth/login', { email, password }); assert.equal(response.statusCode, 200, response.body); return String(response.headers['set-cookie']).split(';')[0]; };
  const createUser = async (name: string, role: 'member' | 'admin', memberships: PublicUser['memberships']) => { const response = await request(ownerCookie, 'POST', '/users', { name, email: `${name}@example.test`, password: 'test-password-member-123', role, memberships }); assert.equal(response.statusCode, 201, response.body); return response.json() as PublicUser; };
  const projectA = (await request(ownerCookie, 'POST', '/projects', { name: 'alpha' })).json(), projectB = (await request(ownerCookie, 'POST', '/projects', { name: 'beta' })).json();
  const createService = async (projectId: string, name: string) => { const response = await request(ownerCookie, 'POST', '/services', { projectId, name, kind: 'postgres', env: { PRIVATE: `${name}-secret-123456` } }); assert.equal(response.statusCode, 201, response.body); return response.json() as Service; };
  const serviceA = await createService(projectA.id, 'alpha-db'), serviceB = await createService(projectB.id, 'beta-db');
  const viewer = await createUser('viewer', 'member', [{ projectId: projectA.id, role: 'viewer' }]);
  const operator = await createUser('operator', 'member', [{ projectId: projectA.id, role: 'operator' }]);
  const admin = await createUser('admin', 'admin', []);
  const viewerCookie = await login(viewer.email), operatorCookie = await login(operator.email), adminCookie = await login(admin.email);
  const finish = async () => { await app.close(); await rm(directory, { recursive: true, force: true }); };
  const deploy = async (service: Service) => { const response = await request(ownerCookie, 'POST', `/services/${service.id}/deploy`); assert.equal(response.statusCode, 202, response.body); await until(async () => (await request(ownerCookie, 'GET', `/deployments/${response.json().id}`)).json().status === 'success'); return response.json(); };
  return { app, directory, driver, request, ownerCookie, owner, viewer, viewerCookie, operator, operatorCookie, admin, adminCookie, projectA, projectB, serviceA, serviceB, login, createUser, finish, deploy };
}
async function until(check: () => Promise<boolean>) { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Timed out.'); }

test('project isolation applies to every collection and cross-project resource route', async t => {
  const f = await fixture(); t.after(f.finish);
  const deployA = await f.deploy(f.serviceA), deployB = await f.deploy(f.serviceB);
  const backupA = (await f.request(f.ownerCookie, 'POST', `/services/${f.serviceA.id}/backups`)).json();
  await until(async () => (await f.request(f.ownerCookie, 'GET', '/backups')).json().find((item: {id: string}) => item.id === backupA.id).status === 'success');
  const backupB = (await f.request(f.ownerCookie, 'POST', `/services/${f.serviceB.id}/backups`)).json();
  await until(async () => (await f.request(f.ownerCookie, 'GET', '/backups')).json().find((item: {id: string}) => item.id === backupB.id).status === 'success');
  const scheduleB = (await f.request(f.ownerCookie, 'POST', `/services/${f.serviceB.id}/backup-schedules`, { enabled: false })).json();
  await f.request(f.ownerCookie, 'POST', `/services/${f.serviceA.id}/backup-schedules`, { enabled: false });
  for (const cookie of [f.viewerCookie, f.operatorCookie]) {
    assert.deepEqual((await f.request(cookie, 'GET', '/projects')).json().map((item: {id:string}) => item.id), [f.projectA.id]);
    assert.deepEqual((await f.request(cookie, 'GET', '/services')).json().map((item: {id:string}) => item.id), [f.serviceA.id]);
    assert.deepEqual((await f.request(cookie, 'GET', '/deployments')).json().map((item: {id:string}) => item.id), [deployA.id]);
    assert.deepEqual((await f.request(cookie, 'GET', '/backups')).json().map((item: {id:string}) => item.id), [backupA.id]);
    assert.equal((await f.request(cookie, 'GET', '/backup-schedules')).json().length, 1);
    const overview = (await f.request(cookie, 'GET', '/overview')).json(); assert.equal(overview.projects.length, 1); assert.equal(overview.services.length, 1); assert.equal(overview.metrics.restricted, true); assert.equal(overview.metrics.dockerVersion, null);
    const activity = (await f.request(cookie, 'GET', '/activity')).json(); assert.ok(activity.length); assert.ok(activity.every((item: {projectId:string}) => item.projectId === f.projectA.id));
    const probes: [InjectOptions['method'], string, Record<string,unknown>?][] = [
      ['GET', `/services?projectId=${f.projectB.id}`], ['GET', `/services/${f.serviceB.id}`], ['PATCH', `/services/${f.serviceB.id}`, { notes: 'attack' }], ['DELETE', `/services/${f.serviceB.id}`],
      ['POST', `/services/${f.serviceB.id}/deploy`], ['POST', `/services/${f.serviceB.id}/stop`], ['GET', `/services/${f.serviceB.id}/logs`], ['GET', `/services/${f.serviceB.id}/deployments`], ['GET', `/deployments/${deployB.id}`],
      ['GET', `/services/${f.serviceB.id}/backups`], ['POST', `/services/${f.serviceB.id}/backups`], ['GET', `/backups/${backupB.id}/download`], ['GET', `/services/${f.serviceB.id}/backup-schedules`], ['PATCH', `/backup-schedules/${scheduleB.id}`, {enabled:true}], ['POST', `/backup-schedules/${scheduleB.id}/run`],
      ['GET', `/services/${f.serviceB.id}/trigger`], ['POST', `/services/${f.serviceB.id}/trigger/rotate`], ['GET', `/services/${f.serviceB.id}/source-credentials`], ['PUT', `/services/${f.serviceB.id}/source-credentials/registry`, {username:'x',password:'attack'}],
      ['POST', '/services', { projectId: f.projectB.id, name: 'attack', kind: 'app' }], ['POST', '/templates/nginx/install', {projectId:f.projectB.id,name:'attack'}], ['PATCH', `/projects/${f.projectB.id}`, {name:'attack'}]
    ];
    for (const [method, path, payload] of probes) assert.equal((await f.request(cookie, method, path, payload)).statusCode, 404, `${method} ${path}`);
  }
});

test('viewer permissions omit secrets and deny every mutation, logs, dumps and credential issuance', async t => {
  const f = await fixture(); t.after(f.finish);
  const deploy = await f.deploy(f.serviceA);
  const backup = (await f.request(f.ownerCookie, 'POST', `/services/${f.serviceA.id}/backups`)).json(); await until(async () => (await f.request(f.ownerCookie, 'GET', '/backups')).json()[0].status === 'success');
  const detail = (await f.request(f.viewerCookie, 'GET', `/services/${f.serviceA.id}`)).json(); assert.deepEqual(detail.env, {});
  assert.equal((await f.request(f.viewerCookie, 'GET', `/deployments/${deploy.id}`)).json().output, '');
  assert.deepEqual((await f.request(f.ownerCookie, 'GET', '/overview')).json().services[0].env, {});
  const probes: [InjectOptions['method'],string,Record<string,unknown>?][] = [
    ['PATCH', `/services/${f.serviceA.id}`, {env:{PRIVATE:'stolen'}}], ['DELETE', `/services/${f.serviceA.id}`], ['POST', `/services/${f.serviceA.id}/deploy`], ['POST', `/services/${f.serviceA.id}/restart`], ['GET', `/services/${f.serviceA.id}/logs`], ['GET', `/backups/${backup.id}/download`], ['POST', `/services/${f.serviceA.id}/trigger/rotate`],
    ['POST', `/services/${f.serviceA.id}/backup-schedules`, {}], ['PUT', `/services/${f.serviceA.id}/source-credentials/registry`, {username:'test',password:'test'}], ['POST', '/services', {projectId:f.projectA.id,name:'attack',kind:'app'}], ['POST', '/templates/nginx/install', {projectId:f.projectA.id,name:'attack'}],
    ['GET','/settings'], ['PATCH','/settings',{serverName:'attack'}], ['GET','/metrics'], ['GET','/users'], ['POST','/users',{name:'attack',email:'attack@example.test',password:'long-password-123',role:'admin'}], ['POST','/projects',{name:'attack'}]
  ];
  for (const [method,path,payload] of probes) assert.equal((await f.request(f.viewerCookie,method,path,payload)).statusCode,403,`${method} ${path}`);
  const operatorDetail = (await f.request(f.operatorCookie,'GET',`/services/${f.serviceA.id}`)).json(); assert.equal(operatorDetail.env.PRIVATE,f.serviceA.env.PRIVATE);
  assert.equal((await f.request(f.operatorCookie,'PATCH',`/services/${f.serviceA.id}`,{notes:'Authorized change'})).statusCode,200);
  const app = (await f.request(f.ownerCookie,'POST','/services',{projectId:f.projectA.id,name:'inline',kind:'app',source:{type:'dockerfile',dockerfile:'FROM alpine\nENV SECRET=hunter2secret'}})).json();
  assert.equal((await f.request(f.viewerCookie,'GET',`/services/${app.id}`)).json().source.dockerfile,undefined);
});

test('owner privileges are immutable and user updates revoke sessions, keys and deployment triggers', async t => {
  const f = await fixture(); t.after(f.finish);
  for (const [method,path,payload] of [['PATCH',`/users/${f.owner.id}`,{role:'member'}],['PATCH',`/users/${f.owner.id}`,{disabled:true}],['DELETE',`/users/${f.owner.id}`,undefined],['POST',`/users/${f.owner.id}/password`,{password:'another-password-123'}]] as [InjectOptions['method'],string,Record<string,unknown>?][]) assert.equal((await f.request(f.adminCookie,method,path,payload)).statusCode,403);
  assert.equal((await f.request(f.ownerCookie,'POST','/users',{name:'fake-owner',email:'fake@example.test',password:'long-password-123',role:'owner'})).statusCode,400);
  const key = (await f.request(f.operatorCookie,'POST','/api-keys',{name:'pipeline',projectIds:[f.projectA.id],permission:'write'})).json();
  const trigger = (await f.request(f.operatorCookie,'POST',`/services/${f.serviceA.id}/trigger/rotate`)).json();
  assert.equal((await f.request(f.ownerCookie,'PATCH',`/users/${f.operator.id}`,{memberships:[{projectId:f.projectA.id,role:'viewer'}]})).statusCode,200);
  assert.equal((await f.request(f.operatorCookie,'GET','/projects')).statusCode,401);
  assert.equal((await f.request('','GET','/projects',undefined,{authorization:`Bearer ${key.token}`})).statusCode,401);
  assert.equal((await f.request('','POST',`/hooks/deploy/${f.serviceA.id}`,undefined,{authorization:`Bearer ${trigger.token}`})).statusCode,401);
  const changedCookie = await f.login(f.operator.email);
  assert.equal((await f.request(changedCookie,'PATCH',`/services/${f.serviceA.id}`,{notes:'attack'})).statusCode,403);
  assert.equal((await f.request(f.ownerCookie,'POST',`/users/${f.operator.id}/password`,{password:'replacement-password-123'})).statusCode,200);
  assert.equal((await f.request(changedCookie,'GET','/projects')).statusCode,401);
  assert.equal((await f.request('','POST','/auth/login',{email:f.operator.email,password:'test-password-member-123'})).statusCode,401);
  await f.login(f.operator.email,'replacement-password-123');
  assert.equal((await f.request(f.ownerCookie,'PATCH',`/users/${f.viewer.id}`,{disabled:true})).statusCode,200);
  assert.equal((await f.request(f.viewerCookie,'GET','/projects')).statusCode,401);
  const adminKey = (await f.request(f.adminCookie,'POST','/api-keys',{name:'admin-pipeline',projectIds:[f.projectB.id],permission:'write'})).json();
  assert.equal((await f.request(f.ownerCookie,'DELETE',`/users/${f.admin.id}`)).statusCode,200);
  assert.equal((await f.request(f.adminCookie,'GET','/users')).statusCode,401);
  assert.equal((await f.request('','GET','/projects',undefined,{authorization:`Bearer ${adminKey.token}`})).statusCode,401);
});

test('API keys intersect project roles, expire, revoke, hide secrets and never become administration credentials', async t => {
  const f = await fixture(); t.after(f.finish);
  assert.equal((await f.request(f.viewerCookie,'POST','/api-keys',{name:'too-wide',projectIds:[f.projectA.id],permission:'write'})).statusCode,403);
  assert.equal((await f.request(f.operatorCookie,'POST','/api-keys',{name:'cross-project',projectIds:[f.projectB.id],permission:'read'})).statusCode,404);
  const read = (await f.request(f.ownerCookie,'POST','/api-keys',{name:'read-alpha',projectIds:[f.projectA.id],permission:'read',expiresInDays:1})).json();
  const write = (await f.request(f.operatorCookie,'POST','/api-keys',{name:'write-alpha',projectIds:[f.projectA.id],permission:'write'})).json();
  assert.match(read.token,/^hl_[A-Za-z0-9_-]{43}$/); assert.equal(read.hash,undefined);
  const list = (await f.request(f.ownerCookie,'GET','/api-keys')).json(); assert.equal(list.length,1); assert.equal(list[0].token,undefined); assert.equal(list[0].hash,undefined);
  const api = (token:string,method:InjectOptions['method'],path:string,payload?:Record<string,unknown>) => f.request('',method,path,payload,{authorization:`Bearer ${token}`});
  assert.deepEqual((await api(read.token,'GET','/projects')).json().map((item:{id:string})=>item.id),[f.projectA.id]);
  assert.deepEqual((await api(read.token,'GET',`/services/${f.serviceA.id}`)).json().env,{});
  assert.equal((await api(read.token,'POST',`/services/${f.serviceA.id}/deploy`)).statusCode,403);
  assert.equal((await api(write.token,'PATCH',`/services/${f.serviceA.id}`,{notes:'pipeline edit'})).statusCode,200);
  assert.equal((await api(write.token,'GET',`/services/${f.serviceB.id}`)).statusCode,404);
  for (const token of [read.token,write.token]) for (const [method,path] of [['GET','/users'],['GET','/settings'],['GET','/metrics'],['GET','/api-keys'],['GET','/auth/session'],['POST',`/services/${f.serviceA.id}/trigger/rotate`]] as [InjectOptions['method'],string][]) assert.equal((await api(token,method,path)).statusCode,403,`${method} ${path}`);
  assert.equal((await f.request(f.viewerCookie,'DELETE',`/api-keys/${write.id}`)).statusCode,404);
  assert.equal((await f.request(f.operatorCookie,'DELETE',`/api-keys/${write.id}`)).statusCode,200);
  assert.equal((await api(write.token,'GET','/projects')).statusCode,401);
  assert.equal((await f.request(f.ownerCookie,'GET','/projects',undefined,{authorization:'Bearer invalid-token'})).statusCode,401,'Invalid API authorization must not fall back to an owner cookie.');
  const encrypted = await readFile(join(f.directory,'state.enc')); assert.equal(encrypted.includes(Buffer.from(read.token)),false);
});

test('proxy/source credentials remain private, scoped and excluded from all public service representations', async t => {
  const f = await fixture(); t.after(f.finish);
  const domainId = randomUUID();
  await f.request(f.ownerCookie,'PATCH',`/services/${f.serviceA.id}`,{domains:[{id:domainId,hostname:'db.example.test',port:5432,https:false,path:'/'}]});
  const path = `/services/${f.serviceA.id}/domains/${domainId}/auth`;
  assert.equal((await f.request(f.viewerCookie,'PUT',path,{username:'user',password:'proxy-password-123'})).statusCode,403);
  const saved = await f.request(f.operatorCookie,'PUT',path,{username:'user',password:'proxy-password-123'}); assert.equal(saved.statusCode,200,saved.body); assert.deepEqual(saved.json(),{enabled:true,username:'user'});
  assert.equal((await f.request(f.operatorCookie,'GET',`/services/${f.serviceB.id}/domains/${domainId}/auth`)).statusCode,404);
  const credential = 'registry-secret-123456';
  assert.equal((await f.request(f.operatorCookie,'PUT',`/services/${f.serviceA.id}/source-credentials/registry`,{username:'registry-user',password:credential})).statusCode,200);
  const sourceStatus = (await f.request(f.operatorCookie,'GET',`/services/${f.serviceA.id}/source-credentials`)).json(); assert.equal(sourceStatus.registry.password,undefined);
  await f.deploy(f.serviceA);
  assert.equal(f.driver.lastOptions?.sourceCredentials?.registry?.password,credential); assert.match(f.driver.lastOptions?.proxyAuth?.[domainId].passwordHash || '',/^\$2/);
  const deployments = (await f.request(f.operatorCookie,'GET',`/services/${f.serviceA.id}/deployments`)).json(); assert.equal(JSON.stringify(deployments).includes(credential),false); assert.equal(JSON.stringify(deployments).includes('passwordHash'),false);
  assert.equal(JSON.stringify((await f.request(f.ownerCookie,'GET',`/services/${f.serviceA.id}`)).json()).includes(credential),false);
  await f.request(f.operatorCookie,'PATCH',`/services/${f.serviceA.id}`,{source:{type:'image',image:'postgres:16-alpine'}});
  assert.equal((await f.request(f.operatorCookie,'GET',`/services/${f.serviceA.id}/source-credentials`)).json().registry.configured,true,'Changing the tag preserves an exact repository scope.');
  await f.request(f.operatorCookie,'PATCH',`/services/${f.serviceA.id}`,{source:{type:'image',image:'example/another:1'},domains:[]});
  assert.equal((await f.request(f.operatorCookie,'GET',`/services/${f.serviceA.id}/source-credentials`)).json().registry.configured,false);
  await f.app.close(); const store = new Store(f.directory); assert.deepEqual(store.state.proxyAuth[f.serviceA.id],{}); assert.deepEqual(store.state.sourceCredentials[f.serviceA.id],{}); store.close();
});

test('legacy owner state and sessions migrate without losing access; expired keys are rejected', async t => {
  const f = await fixture(); t.after(f.finish);
  const keyResponse = (await f.request(f.ownerCookie,'POST','/api-keys',{name:'expired',projectIds:[f.projectA.id],permission:'read'})).json();
  await f.app.close();
  const key = await readFile(join(f.directory,'encryption.key')), file = join(f.directory,'state.enc'), contents = await readFile(file);
  const decipher = createDecipheriv('aes-256-gcm',key,contents.subarray(0,12)); decipher.setAuthTag(contents.subarray(12,28));
  const state = JSON.parse(Buffer.concat([decipher.update(contents.subarray(28)),decipher.final()]).toString());
  state.users = undefined; state.sessions = state.sessions.filter((session:{userId:string})=>session.userId===f.owner.id).map(({userId:_userId,...rest}:{userId:string;hash:string;expires:number})=>rest); state.apiKeys[0].expiresAt='2000-01-01T00:00:00.000Z';
  const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key,iv), body=Buffer.concat([cipher.update(JSON.stringify(state)),cipher.final()]); await writeFile(file,Buffer.concat([iv,cipher.getAuthTag(),body]));
  const reopened=await createApp({dataDir:f.directory,mode:'docker',driver:f.driver});
  try {
    const session=(await reopened.inject({url:'/api/auth/session',headers:{cookie:f.ownerCookie}})).json(); assert.equal(session.authenticated,true); assert.equal(session.user.role,'owner'); assert.equal(session.setupRequired,false);
    assert.equal((await reopened.inject({url:'/api/projects',headers:{authorization:`Bearer ${keyResponse.token}`}})).statusCode,401);
  } finally { await reopened.close(); }
});

test('encoded paths, alternate methods and cookie/header combinations cannot bypass canonical route authorization', async t => {
  const f = await fixture(); t.after(f.finish);
  const urls = ['/api/services', '/%61pi/services', '/api%2Fservices', '//api/services', '/API/services', '/api/services/', `/api/services/${f.serviceA.id}`, `/api/services/%${f.serviceA.id.charCodeAt(0).toString(16)}${f.serviceA.id.slice(1)}`];
  for (const url of urls) {
    const response = await f.app.inject({ url });
    assert.ok([400,401,404].includes(response.statusCode), `${url}: ${response.statusCode} ${response.body}`);
    assert.equal(response.body.includes(f.serviceA.env.PRIVATE),false);
  }
  for (const method of ['PUT','PATCH','DELETE'] as const) for (const url of ['/api/auth/setup','/api/auth/login','/api/auth/session']) {
    const response = await f.app.inject({method,url,payload:{role:'owner'}}); assert.ok([400,401,404].includes(response.statusCode),`${method} ${url}: ${response.statusCode}`);
  }
  assert.equal((await f.request(f.viewerCookie,'GET',`/services/%${f.serviceB.id.charCodeAt(0).toString(16)}${f.serviceB.id.slice(1)}`)).statusCode,404);
});

test('expiry rejects an otherwise valid API key while preserving its active owner session', async t => {
  const f = await fixture(); t.after(f.finish);
  const created = (await f.request(f.ownerCookie,'POST','/api-keys',{name:'one-day-key',projectIds:[f.projectA.id],permission:'write'})).json();
  assert.equal((await f.request('','GET','/projects',undefined,{authorization:`Bearer ${created.token}`})).statusCode,200);
  await f.app.close();
  const store = new Store(f.directory); store.state.apiKeys.find(key=>key.id===created.id)!.expiresAt='2000-01-01T00:00:00.000Z'; store.save(); store.close();
  const reopened = await createApp({dataDir:f.directory,mode:'docker',driver:f.driver});
  try {
    assert.equal((await reopened.inject({url:'/api/projects',headers:{cookie:f.ownerCookie}})).statusCode,200);
    assert.equal((await reopened.inject({url:'/api/projects',headers:{authorization:`Bearer ${created.token}`}})).statusCode,401);
  } finally { await reopened.close(); }
});

test('Git URL credentials and unsupported URL forms are rejected before they enter viewer-visible source state', async t => {
  const f = await fixture(); t.after(f.finish);
  const app = (await f.request(f.ownerCookie,'POST','/services',{projectId:f.projectA.id,name:'git-app',kind:'app',source:{type:'git',repository:'https://Git.Example.test/team/app.git/'}})).json();
  assert.equal(app.source.repository,'https://git.example.test/team/app.git');
  const secret='url-secret-do-not-save-987654';
  for (const repository of [`https://git.example.test/team/app.git?access_token=${secret}`,`https://git.example.test/team/app.git#${secret}`,`https://user:${secret}@git.example.test/team/app.git`,'https://git.example.test/','https://git.example.test/team%2Fapp.git']) {
    const response=await f.request(f.operatorCookie,'PATCH',`/services/${app.id}`,{source:{type:'git',repository}});
    assert.equal(response.statusCode,400,repository); assert.match(response.json().error,/repository/);
  }
  const failedCreate=await f.request(f.operatorCookie,'POST','/services',{projectId:f.projectA.id,name:'invalid-new',kind:'app',source:{type:'git',repository:`https://git.example.test/app.git?token=${secret}`}}); assert.equal(failedCreate.statusCode,400);
  for (const path of ['/services','/overview',`/services/${app.id}`]) assert.equal((await f.request(f.viewerCookie,'GET',path)).body.includes(secret),false,path);
  assert.equal((await f.request(f.viewerCookie,'GET',`/services/${app.id}`)).json().source.repository,'https://git.example.test/team/app.git');
  // A pre-upgrade state may already contain a rejected URL; the viewer projection is defensive too.
  await f.app.close();
  const store=new Store(f.directory); store.state.services.find(service=>service.id===app.id)!.source.repository=`https://git.example.test/team/app.git?token=${secret}`; store.save(); store.close();
  const reopened=await createApp({dataDir:f.directory,mode:'docker',driver:f.driver});
  try { for (const path of ['/api/services','/api/overview',`/api/services/${app.id}`]) assert.equal((await reopened.inject({url:path,headers:{cookie:f.viewerCookie}})).body.includes(secret),false,`legacy ${path}`); }
  finally { await reopened.close(); }
});
