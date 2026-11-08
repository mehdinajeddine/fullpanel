/** Opt-in integration check. Creates only uniquely labeled, disposable resources. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerDriver, command } from '../server/docker.js';
import type { Service, ServiceKind } from '../shared/types.js';

const directory = await mkdtemp(join(tmpdir(), 'harborlight-smoke-'));
const driver = new DockerDriver(directory);
const projectId = randomUUID();
const services: Service[] = [];
function service(kind: ServiceKind, image: string, env: Record<string, string> = {}): Service {
  const timestamp = new Date().toISOString();
  const item: Service = { id: randomUUID(), projectId, name: `smoke-${kind}`, kind, status: 'not-deployed', source: { type: 'image', image }, env, domains: [], mounts: [], ports: [], resources: { cpu: 0.5, memoryMb: 256 }, notes: '', createdAt: timestamp, updatedAt: timestamp };
  services.push(item);
  return item;
}
async function eventually(check: () => Promise<void>, milliseconds = 60000) {
  const until = Date.now() + milliseconds;
  let last: unknown;
  while (Date.now() < until) {
    try { await check(); return; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw last;
}
const output = (chunk: string) => process.stdout.write(chunk);
try {
  await command('docker', ['info', '--format', '{{.ServerVersion}}']);
  const web = service('app', 'nginx:1.28-alpine');
  await driver.deploy(web, output);
  assert.match(await command('docker', ['exec', `hl-${web.id}`, 'wget', '-qO-', 'http://127.0.0.1']), /Welcome to nginx/);
  await driver.action(web, 'stop');
  assert.equal((await driver.statuses())[web.id], 'stopped');
  await driver.action(web, 'start');
  await driver.action(web, 'restart');
  assert.equal((await driver.statuses())[web.id], 'running');
  assert.ok((await driver.logs(web, 100)).length > 0);
  console.log('PASS: real image deploy, HTTP response, lifecycle, status and logs');

  // The same running service must survive an unsuccessful image pull.
  await assert.rejects(driver.deploy({ ...web, source: { type: 'image', image: 'nginx:harborlight-intentionally-nonexistent-test-tag' } }, () => {}));
  assert.equal((await driver.statuses())[web.id], 'running');
  console.log('PASS: failed pull preserves the previous runtime');

  web.source = { type: 'dockerfile', dockerfile: 'FROM nginx:1.28-alpine\nRUN printf harborlight-smoke > /usr/share/nginx/html/index.html\n' };
  await driver.deploy(web, output);
  assert.equal((await command('docker', ['exec', `hl-${web.id}`, 'wget', '-qO-', 'http://127.0.0.1'])).trim(), 'harborlight-smoke');
  console.log('PASS: inline Dockerfile build and replacement');

  const database = service('postgres', 'postgres:17-alpine', { POSTGRES_USER: 'smoketest', POSTGRES_PASSWORD: randomUUID(), POSTGRES_DB: 'smoketest' });
  database.mounts = [{ id: randomUUID(), name: 'data', mountPath: '/var/lib/postgresql/data' }];
  await driver.deploy(database, output);
  await eventually(async () => { await command('docker', ['exec', `hl-${database.id}`, 'pg_isready', '-h', '127.0.0.1', '-U', 'smoketest']); });
  await command('docker', ['exec', `hl-${database.id}`, 'psql', '-U', 'smoketest', '-c', "CREATE TABLE proof (value text); INSERT INTO proof VALUES ('harborlight-persistent');"]);
  const credentialFile = join(directory, 'client.env');
  await writeFile(credentialFile, `PGPASSWORD=${database.env.POSTGRES_PASSWORD}\nPGCONNECT_TIMEOUT=3\n`, { mode: 0o600 });
  const client = ['run', '--rm', '--network', `hl-project-${projectId}`, '--label', 'io.harborlight.role=test-client', '--env-file', credentialFile, 'postgres:17-alpine', 'psql', '-h', database.name, '-U', 'smoketest', '-Atc', 'SELECT value FROM proof'];
  assert.equal((await command('docker', client)).trim(), 'harborlight-persistent');
  await writeFile(credentialFile, 'PGPASSWORD=intentionally-wrong\nPGCONNECT_TIMEOUT=3\n', { mode: 0o600 });
  await assert.rejects(command('docker', client), /password authentication failed/);
  console.log('PASS: private cross-container database access requires the generated password');
  const dump = join(directory, 'database.sql');
  await driver.backup(database, dump);
  assert.match(await readFile(dump, 'utf8'), /harborlight-persistent/);
  const restored = service('postgres', 'postgres:17-alpine', { POSTGRES_USER: 'restore_admin', POSTGRES_PASSWORD: randomUUID(), POSTGRES_DB: 'restore_admin' });
  restored.name = 'smoke-restored';
  restored.mounts = [{ id: randomUUID(), name: 'data', mountPath: '/var/lib/postgresql/data' }];
  await driver.deploy(restored, output);
  await eventually(async () => { await command('docker', ['exec', `hl-${restored.id}`, 'pg_isready', '-h', '127.0.0.1', '-U', 'restore_admin']); });
  await command('docker', ['cp', dump, `hl-${restored.id}:/tmp/restore.sql`]);
  await command('docker', ['exec', `hl-${restored.id}`, 'psql', '-U', 'restore_admin', '-v', 'ON_ERROR_STOP=1', '-f', '/tmp/restore.sql']);
  assert.equal((await command('docker', ['exec', `hl-${restored.id}`, 'psql', '-U', 'smoketest', '-Atc', 'SELECT value FROM proof'])).trim(), 'harborlight-persistent');
  console.log('PASS: PostgreSQL dump restored into a second isolated database');
  await driver.deploy(database, output);
  await eventually(async () => {
    await command('docker', ['exec', `hl-${database.id}`, 'pg_isready', '-h', '127.0.0.1', '-U', 'smoketest']);
    const result = await command('docker', ['exec', `hl-${database.id}`, 'psql', '-U', 'smoketest', '-Atc', 'SELECT value FROM proof']);
    assert.equal(result.trim(), 'harborlight-persistent');
  });
  console.log('PASS: PostgreSQL credentials, volume persistence, database dump');

  const cache = service('redis', 'redis:7-alpine', { REDIS_PASSWORD: randomUUID() });
  cache.mounts = [{ id: randomUUID(), name: 'data', mountPath: '/data' }];
  await driver.deploy(cache, output);
  await eventually(async () => {
    const result = await command('docker', ['exec', `hl-${cache.id}`, 'sh', '-c', 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli PING']);
    assert.equal(result.trim(), 'PONG');
  });
  const archive = join(directory, 'redis.tar.gz');
  await driver.backup(cache, archive);
  assert.ok((await stat(archive)).size > 30);
  const redisArchive = gunzipSync(await readFile(archive));
  assert.ok(redisArchive.includes(Buffer.from('dump.rdb')));
  assert.ok(!redisArchive.includes(Buffer.from('.aof')));
  await command('docker', ['exec', `hl-${cache.id}`, 'sh', '-c', 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli SET smoke-proof survives-restart']);
  await driver.action(cache, 'restart');
  await eventually(async () => {
    assert.equal((await command('docker', ['exec', `hl-${cache.id}`, 'sh', '-c', 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli GET smoke-proof'])).trim(), 'survives-restart');
  });
  console.log('PASS: Redis authentication, persistence after restart, and RDB-only archive');

  const stack = service('compose', '');
  stack.source = { type: 'compose', compose: 'services:\n  web:\n    image: nginx:1.28-alpine\n  cache:\n    image: redis:7-alpine\n    volumes:\n      - cache-data:/data\nvolumes:\n  cache-data: {}\n' };
  await driver.deploy(stack, output);
  assert.equal((await driver.statuses())[stack.id], 'running');
  await driver.action(stack, 'stop');
  assert.equal((await driver.statuses())[stack.id], 'stopped');
  await driver.action(stack, 'start');
  assert.equal((await driver.statuses())[stack.id], 'running');
  // Track the managed Compose volume for exact cleanup after testing retention.
  stack.mounts = [{ id: randomUUID(), name: 'cache-data', mountPath: '/data' }];
  await driver.remove(stack);
  assert.equal(JSON.parse(await command('docker', ['volume', 'inspect', `hl-${stack.id}-cache-data`]))[0].Labels['io.harborlight.service'], stack.id);
  console.log('PASS: real Compose deployment and lifecycle');
  assert.ok((await driver.metrics()).dockerVersion);
  console.log('All Docker smoke checks passed.');
} finally {
  for (const item of services.reverse()) {
    await driver.remove(item).catch(error => console.error('Cleanup container:', String(error)));
    for (const mount of item.mounts) {
      const name = `hl-${item.id}-${mount.name}`;
      try {
        const [volume] = JSON.parse(await command('docker', ['volume', 'inspect', name]));
        if (volume.Labels?.['io.harborlight.managed'] === 'true' && volume.Labels?.['io.harborlight.service'] === item.id) await command('docker', ['volume', 'rm', name]);
      } catch (error) { console.error('Cleanup volume:', String(error)); }
    }
    const images = (await command('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', `harborlight/${item.id}`]).catch(() => '')).trim().split('\n').filter(Boolean);
    for (const image of images) await command('docker', ['image', 'rm', image]).catch(() => {});
  }
  await command('docker', ['network', 'rm', `hl-project-${projectId}`]).catch(error => console.error('Cleanup network:', String(error)));
  await rm(directory, { recursive: true, force: true });
}
