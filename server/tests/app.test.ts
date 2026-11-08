import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../app.js';
import { DemoDriver, sanitizeCompose, type Output, type DeployOptions } from '../docker.js';
import { Store } from '../store.js';
import type { Service } from '../../shared/types.js';

class TestDriver extends DemoDriver {
  removals: string[] = [];
  deployments: Service[] = [];
  deployOptions: DeployOptions[] = [];
  failure?: string;
  gate?: Promise<void>;
  override async deploy(service: Service, output: Output, options: DeployOptions = {}) {
    this.deployments.push(service); this.deployOptions.push(options); output('Starting\n');
    await this.gate;
    if (service.env.SECRET) { output(service.env.SECRET.slice(0, 3)); output(service.env.SECRET.slice(3)); }
    if (this.failure) throw new Error(this.failure);
    return { containerId: 'fake-container', image: service.source.image || 'fake-build', ...(service.source.type === 'git' ? { commit: 'a'.repeat(40) } : {}) };
  }
  override async remove(service: Service) { this.removals.push(service.id); }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'harborlight-api-test-'));
  const driver = new TestDriver();
  const app = await createApp({ dataDir: directory, mode: 'docker', driver });
  let cookie = '';
  const request = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>, headers: Record<string, string> = {}) => app.inject({ method, url: `/api${url}`, ...(payload !== undefined ? { payload } : {}), headers: { cookie, ...headers } });
  const setup = async () => { const response = await request('POST', '/auth/setup', { name: 'Owner', email: 'owner@example.test', password: 'strong-test-password-123' }); assert.equal(response.statusCode, 200, response.body); cookie = response.headers['set-cookie']!.toString().split(';')[0]; return response; };
  const project = async () => { const response = await request('POST', '/projects', { name: 'my-project' }); assert.equal(response.statusCode, 201, response.body); return response.json(); };
  const service = async (projectId: string, fields: Record<string, unknown> = {}) => { const response = await request('POST', '/services', { projectId, name: 'web', kind: 'app', ...fields }); assert.equal(response.statusCode, 201, response.body); return response.json() as Service; };
  const finish = async () => { await app.close(); await rm(directory, { recursive: true, force: true }); };
  return { app, request, setup, project, service, driver, directory, finish };
}
async function poll(check: () => Promise<boolean>) { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Polling timed out.'); }

test('owner bootstrap, session cookies, CSRF checks and logout protect every private endpoint', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('GET', '/projects')).statusCode, 401);
    assert.equal((await f.request('GET', '/auth/session')).json().setupRequired, true);
    assert.equal((await f.request('POST', '/auth/setup', { name: 'Owner', email: 'owner@example.test', password: 'short' })).statusCode, 400);
    const setup = await f.setup();
    assert.match(String(setup.headers['set-cookie']), /HttpOnly/); assert.match(String(setup.headers['set-cookie']), /SameSite=Strict/);
    assert.equal((await f.request('POST', '/auth/setup', { name: 'Intruder', email: 'x@example.test', password: 'another-long-password' })).statusCode, 409);
    assert.equal((await f.request('POST', '/projects', { name: 'test' }, { origin: 'https://evil.example' })).statusCode, 403);
    assert.equal((await f.request('POST', '/projects', { name: 'test' }, { 'sec-fetch-site': 'cross-site' })).statusCode, 403);
    assert.equal((await f.request('POST', '/projects', { name: 'test' }, { origin: 'http://localhost:80' })).statusCode, 201);
    assert.equal((await f.request('POST', '/auth/logout')).statusCode, 200);
    assert.equal((await f.request('GET', '/projects')).statusCode, 401);
    assert.equal((await f.request('POST', '/auth/login', { email: 'owner@example.test', password: 'wrong' })).statusCode, 401);
    assert.equal((await f.request('POST', '/auth/login', { email: 'owner@example.test', password: 'strong-test-password-123' })).statusCode, 200);
  } finally { await f.finish(); }
});

test('server data is encrypted, durable and protected against simultaneous writers', async () => {
  const f = await fixture();
  try {
    await f.setup(); const project = await f.project(); await f.service(project.id, { env: { PRIVATE_TOKEN: 'super-secret-test-value' } });
    const encrypted = await readFile(join(f.directory, 'state.enc'));
    assert.equal(encrypted.includes(Buffer.from('super-secret-test-value')), false);
    assert.equal(encrypted.includes(Buffer.from('owner@example.test')), false);
    assert.equal((await stat(join(f.directory, 'encryption.key'))).mode & 0o777, 0o600);
    assert.throws(() => new Store(f.directory), /already open/);
    await f.app.close();
    const reopened = await createApp({ dataDir: f.directory, driver: f.driver });
    try { const response = await reopened.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.test', password: 'strong-test-password-123' } }); assert.equal(response.statusCode, 200); const authCookie = String(response.headers['set-cookie']).split(';')[0]; assert.equal((await reopened.inject({ url: '/api/services', headers: { cookie: authCookie } })).json()[0].env.PRIVATE_TOKEN, 'super-secret-test-value'); } finally { await reopened.close(); }
  } finally { await f.finish(); }
});

test('project/service validation rejects unsafe inputs and resource conflicts', async () => {
  const f = await fixture();
  try {
    await f.setup(); const project = await f.project();
    assert.equal((await f.request('POST', '/projects', { name: 'my-project' })).statusCode, 409);
    await f.request('PATCH', `/projects/${project.id}`, { description: 'Keep this description', color: '#112233' });
    const renamed = await f.request('PATCH', `/projects/${project.id}`, { name: 'renamed-project' });
    assert.equal(renamed.json().description, 'Keep this description'); assert.equal(renamed.json().color, '#112233');
    assert.equal((await f.request('POST', '/services', { projectId: project.id, name: '../escape', kind: 'app' })).statusCode, 400);
    assert.equal((await f.request('POST', '/services', { projectId: randomUUID(), name: 'missing', kind: 'app' })).statusCode, 404);
    const web = await f.service(project.id, { ports: [{ published: 8081, target: 80, protocol: 'tcp' }], domains: [{ hostname: 'web.example.com', port: 80, https: true, path: '/' }] });
    assert.equal((await f.request('POST', '/services', { projectId: project.id, name: 'second', kind: 'app', ports: [{ published: 8081, target: 80, protocol: 'tcp' }] })).statusCode, 409);
    assert.equal((await f.request('PATCH', `/services/${web.id}`, { env: { INVALID: 'value\nOTHER=secret' } })).statusCode, 400);
    assert.equal((await f.request('PATCH', `/services/${web.id}`, { source: { type: 'image', image: 'nginx; rm -rf /' } })).statusCode, 400);
    assert.equal((await f.request('PATCH', `/services/${web.id}`, { source: { type: 'git', repository: 'file:///etc' } })).statusCode, 400);
    assert.equal((await f.request('PATCH', `/services/${web.id}`, { source: { type: 'git', repository: 'https://github.com/a/b.git', context: '../secrets' } })).statusCode, 400);
    assert.equal((await f.request('PATCH', `/services/${web.id}`, { resources: { cpu: 0, memoryMb: 0 } })).statusCode, 400);
    assert.equal((await f.request('DELETE', `/projects/${project.id}`)).statusCode, 409);
    assert.equal((await f.request('DELETE', `/services/${web.id}`)).statusCode, 200);
    assert.equal((await f.request('DELETE', `/projects/${project.id}`)).statusCode, 200);
  } finally { await f.finish(); }
});

test('database services receive unique credentials, private networking and persistent mounts', async () => {
  const f = await fixture();
  try {
    await f.setup(); const project = await f.project();
    const one = await f.service(project.id, { name: 'db-one', kind: 'postgres' }), two = await f.service(project.id, { name: 'db-two', kind: 'postgres' });
    assert.notEqual(one.env.POSTGRES_PASSWORD, two.env.POSTGRES_PASSWORD);
    assert.ok(one.env.POSTGRES_PASSWORD.length >= 24); assert.deepEqual(one.ports, []); assert.deepEqual(one.domains, []);
    assert.equal(one.mounts[0].mountPath, '/var/lib/postgresql/data');
    const installed = await f.request('POST', '/templates/redis/install', { projectId: project.id, name: 'cache' });
    assert.equal(installed.statusCode, 201); assert.ok(installed.json().env.REDIS_PASSWORD); assert.equal(installed.json().status, 'not-deployed');
    assert.equal(f.driver.deployments.length, 0);
  } finally { await f.finish(); }
});

test('deployment queue rejects races, applies a snapshot and masks secrets across output chunks', async () => {
  const f = await fixture(); let unlock!: () => void;
  f.driver.gate = new Promise<void>(resolve => { unlock = resolve; });
  try {
    await f.setup(); const project = await f.project(); const web = await f.service(project.id, { env: { SECRET: 'sensitive-value-987654' } });
    const deploy = await f.request('POST', `/services/${web.id}/deploy`); assert.equal(deploy.statusCode, 202);
    assert.equal((await f.request('POST', `/services/${web.id}/deploy`)).statusCode, 409);
    assert.equal((await f.request('PATCH', `/services/${web.id}`, { notes: 'race' })).statusCode, 409);
    assert.equal((await f.request('DELETE', `/services/${web.id}`)).statusCode, 409);
    unlock();
    await poll(async () => (await f.request('GET', `/deployments/${deploy.json().id}`)).json().status === 'success');
    const detail = (await f.request('GET', `/services/${web.id}`)).json();
    assert.equal(detail.updatedAt, web.updatedAt); assert.ok(detail.deployedAt >= detail.updatedAt);
    const output = (await f.request('GET', `/deployments/${deploy.json().id}`)).json().output; assert.equal(output.includes(web.env.SECRET), false); assert.match(output, /REDACTED/);
    assert.equal((await f.request('POST', `/services/${web.id}/stop`)).json().status, 'stopped');
    assert.equal((await f.request('POST', `/services/${web.id}/start`)).json().status, 'running');
    assert.equal((await f.request('DELETE', `/services/${web.id}`)).statusCode, 200); assert.deepEqual(f.driver.removals, [web.id]);
  } finally { unlock?.(); await f.finish(); }
});

test('runtime errors produce a failed deployment, never a false success', async () => {
  const f = await fixture();
  try {
    await f.setup(); const project = await f.project(); const web = await f.service(project.id, { env: { SECRET: 'secret-value-123' } }); f.driver.failure = 'Rejected secret-value-123';
    const deploy = (await f.request('POST', `/services/${web.id}/deploy`)).json();
    await poll(async () => (await f.request('GET', `/deployments/${deploy.id}`)).json().status === 'failed');
    const detail = (await f.request('GET', `/services/${web.id}`)).json(); assert.equal(detail.status, 'failed'); assert.equal(detail.deployedAt, undefined); assert.equal(detail.error, 'Rejected [REDACTED]');
  } finally { await f.finish(); }
});

test('backups are asynchronous, retained after deletion and downloadable only with a session', async () => {
  const f = await fixture();
  try {
    await f.setup(); const project = await f.project(); const database = await f.service(project.id, { kind: 'postgres' });
    assert.equal((await f.request('POST', `/services/${database.id}/backups`)).statusCode, 409);
    const deploy = (await f.request('POST', `/services/${database.id}/deploy`)).json();
    await poll(async () => (await f.request('GET', `/deployments/${deploy.id}`)).json().status === 'success');
    const backup = await f.request('POST', `/services/${database.id}/backups`); assert.equal(backup.statusCode, 202);
    await poll(async () => (await f.request('GET', '/backups')).json()[0].status === 'success');
    const downloaded = await f.request('GET', `/backups/${backup.json().id}/download`); assert.equal(downloaded.statusCode, 200); assert.match(String(downloaded.headers['content-disposition']), /attachment/);
    assert.equal((await f.request('DELETE', `/services/${database.id}`)).statusCode, 200); assert.equal((await f.request('GET', '/backups')).json().length, 1);
    assert.equal((await f.app.inject(`/api/backups/${backup.json().id}/download`)).statusCode, 401);
  } finally { await f.finish(); }
});

test('Compose sanitizer prevents host access, driver options and ambient variable interpolation', () => {
  const base: Service = { id: randomUUID(), projectId: randomUUID(), name: 'stack', kind: 'compose', status: 'not-deployed', source: { type: 'compose' }, env: {}, domains: [], mounts: [], ports: [], resources: { cpu: 1, memoryMb: 256 }, notes: '', createdAt: '', updatedAt: '' };
  const parse = (compose: string) => sanitizeCompose({ ...base, source: { type: 'compose', compose } });
  assert.throws(() => parse('services:\n  web:\n    image: nginx:alpine\n    privileged: true\n'), /Unsupported Compose/);
  assert.throws(() => parse('services:\n  web:\n    image: nginx:alpine\n    volumes:\n      - /etc:/host\n'), /named volume/);
  assert.throws(() => parse('services:\n  web:\n    image: nginx:alpine\nvolumes:\n  data:\n    driver_opts:\n      device: /etc\n'), /driver options/);
  const result = parse('services:\n  web:\n    image: nginx:alpine\n    environment:\n      TOKEN: ${HOST_SECRET}\n    volumes:\n      - data:/data\nvolumes:\n  data: {}\n') as { services: { web: { environment: Record<string,string> } } };
  assert.equal(result.services.web.environment.TOKEN, '$${HOST_SECRET}');
});

test('restart recovery marks interrupted jobs failed without guessing a successful runtime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harborlight-recovery-'));
  try {
    const store = new Store(directory); const deploymentId = randomUUID(); store.state.deployments.push({ id: deploymentId, serviceId: randomUUID(), status: 'running', trigger: 'test', createdAt: new Date().toISOString(), output: 'Working' }); store.save(); store.close();
    const reopened = new Store(directory); assert.equal(reopened.state.deployments[0].status, 'failed'); assert.match(reopened.state.deployments[0].output, /restarted/); reopened.close();
    const key = await readFile(join(directory, 'encryption.key')); await writeFile(join(directory, 'encryption.key'), Buffer.alloc(key.length, 1)); assert.throws(() => new Store(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('stale lock with a recycled PID is recovered, but a live writer remains protected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harborlight-stale-lock-'));
  try {
    await writeFile(join(directory, 'writer.lock'), JSON.stringify({ pid: process.pid, identity: 'a-different-process-start', nonce: 'old-container' }));
    const store = new Store(directory);
    assert.throws(() => new Store(directory), /already open/);
    store.close();
    const reopened = new Store(directory); reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a failed persistent write rolls back memory and blocks later writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harborlight-failed-write-'));
  const store = new Store(directory);
  try {
    const previous = structuredClone(store.state.settings);
    // Replace the target with a directory to force atomic rename to fail, even as root.
    await rm(join(directory, 'state.enc')); const { mkdir } = await import('node:fs/promises'); await mkdir(join(directory, 'state.enc'));
    store.state.settings.serverName = 'Must never become durable';
    assert.throws(() => store.save());
    assert.deepEqual(store.state.settings, previous);
    assert.throws(() => store.assertWritable(), /Persistent storage failed/);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('integrated deployment hooks require scoped tokens and share the manual job lock', async () => {
  const f = await fixture(); let unlock!: () => void;
  f.driver.gate = new Promise<void>(resolve => { unlock = resolve; });
  try {
    await f.setup(); const project = await f.project(), web = await f.service(project.id);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/services/${web.id}/trigger/rotate` })).statusCode, 401);
    const rotation = await f.request('POST', `/services/${web.id}/trigger/rotate`); assert.equal(rotation.statusCode, 200);
    assert.equal((await f.request('GET', `/services/${web.id}/trigger`)).json().token, undefined);
    const hook = `/api/hooks/deploy/${web.id}`, token = rotation.json().token;
    assert.equal((await f.app.inject({ method: 'POST', url: hook })).statusCode, 401);
    const deploy = await f.app.inject({ method: 'POST', url: hook, headers: { authorization: `Bearer ${token}` } }); assert.equal(deploy.statusCode, 202); assert.equal(deploy.json().trigger, 'Webhook');
    assert.equal((await f.request('POST', `/services/${web.id}/deploy`)).statusCode, 409);
    await f.request('DELETE', `/services/${web.id}/trigger`);
    assert.equal((await f.app.inject({ method: 'POST', url: hook, headers: { authorization: `Bearer ${token}` } })).statusCode, 401);
    unlock();
  } finally { unlock?.(); await f.finish(); }
});

test('backup schedules persist configuration, share the backup queue and retain files on service deletion', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('GET', '/backup-schedules')).statusCode, 401);
    await f.setup(); const project = await f.project(), database = await f.service(project.id, { kind: 'postgres' });
    const deploy = (await f.request('POST', `/services/${database.id}/deploy`)).json();
    await poll(async () => (await f.request('GET', `/deployments/${deploy.id}`)).json().status === 'success');
    const created = await f.request('POST', `/services/${database.id}/backup-schedules`, { frequency: 'weekly', hour: 4, minute: 15, weekday: 2, retention: 3, enabled: false });
    assert.equal(created.statusCode, 201); assert.equal(created.json().timezone, 'UTC'); assert.equal(created.json().nextRunAt, null);
    const scheduleId = created.json().id;
    const updated = await f.request('PATCH', `/backup-schedules/${scheduleId}`, { retention: 5 });
    assert.equal(updated.json().frequency, 'weekly'); assert.equal(updated.json().hour, 4); assert.equal(updated.json().enabled, false);
    const run = await f.request('POST', `/backup-schedules/${scheduleId}/run`); assert.equal(run.statusCode, 202); assert.equal(run.json().scheduleId, scheduleId);
    await poll(async () => (await f.request('GET', '/backups')).json()[0].status === 'success');
    assert.equal((await f.request('GET', '/backup-schedules')).json().length, 1);
    await f.request('DELETE', `/services/${database.id}`);
    assert.equal((await f.request('GET', '/backup-schedules')).json().length, 0);
    assert.equal((await f.request('GET', '/backups')).json().length, 1);
    assert.equal((await f.request('GET', `/backups/${run.json().id}/download`)).statusCode, 200);
  } finally { await f.finish(); }
});

test('automatic domains apply only to new apps and use template-specific ports', async () => {
  const f = await fixture();
  try {
    await f.setup(); const project = await f.project();
    await f.request('PATCH', '/settings', { baseDomain: 'apps.example.com' });
    const app = await f.service(project.id);
    assert.equal(app.domains[0].hostname, 'web-my-project.apps.example.com'); assert.equal(app.domains[0].port, 80); assert.equal(app.domains[0].https, true);
    const database = await f.service(project.id, { name: 'db', kind: 'postgres' }); assert.deepEqual(database.domains, []);
    const explicit = await f.service(project.id, { name: 'private', domains: [] }); assert.deepEqual(explicit.domains, []);
    const template = (await f.request('POST', '/templates/uptime-kuma/install', { projectId: project.id, name: 'status' })).json(); assert.equal(template.domains[0].port, 3001);
    await f.request('PATCH', '/settings', { baseDomain: 'new.example.com' }); assert.equal((await f.request('GET', `/services/${app.id}`)).json().domains[0].hostname, 'web-my-project.apps.example.com');
  } finally { await f.finish(); }
});

test('force rebuild is source-specific and successful Git deployments retain the resolved commit', async () => {
  const f = await fixture();
  try {
    await f.setup(); const project = await f.project(), app = await f.service(project.id);
    assert.equal((await f.request('POST', `/services/${app.id}/deploy`, { forceRebuild: true })).statusCode, 400);
    await f.request('PATCH', `/services/${app.id}`, { source: { type: 'git', repository: 'https://github.com/example/app.git', branch: 'main' } });
    const deploy = await f.request('POST', `/services/${app.id}/deploy`, { forceRebuild: true }); assert.equal(deploy.statusCode, 202);
    await poll(async () => (await f.request('GET', `/deployments/${deploy.json().id}`)).json().status === 'success');
    const result = (await f.request('GET', `/deployments/${deploy.json().id}`)).json();
    assert.equal(result.commit, 'a'.repeat(40)); assert.equal(result.forceRebuild, true); assert.equal(f.driver.deployOptions[0].forceRebuild, true); assert.match(result.output, /Build cache disabled/);
  } finally { await f.finish(); }
});
