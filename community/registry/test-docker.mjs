/** Owns one UUID-labeled PostgreSQL container and volume. Never uses an ambient DATABASE_URL. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, chmod, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegistryDatabase } from './database.mjs';
import { createServer } from 'node:net';

const execute = promisify(execFile), fixture = randomUUID(), name = `fp-registry-${fixture}`, volume = `${name}-data`;
const work = await mkdtemp(join(tmpdir(), 'fullpanel-registry-')); await chmod(work, 0o700);
const password = randomBytes(32).toString('hex'), databaseName = 'registry_' + fixture.replaceAll('-', '');
const envFile = join(work, 'postgres.env');
await writeFile(envFile, `POSTGRES_USER=fixture\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=${databaseName}\n`, { mode: 0o600 });
let readiness, containerId;
async function docker(args, timeout = 30000) {
  try { return (await execute('docker', args, { timeout, maxBuffer: 2 * 1024 * 1024 })).stdout; }
  catch { throw new Error('Docker registry fixture command failed: ' + args[0]); }
}
async function inspect(kind, target) {
  const result = await execute('docker', [kind, 'inspect', target], { timeout: 10000, maxBuffer: 2 * 1024 * 1024 }).catch(error => {
    if (/No such|not found/.test(String(error.stderr))) return null;
    throw new Error('Unable to verify owned fixture resource.');
  });
  return result ? JSON.parse(result.stdout)[0] : undefined;
}
try {
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  let image;
  try { image = JSON.parse(await docker(['image', 'inspect', 'postgres:17-alpine']))[0]; }
  catch { await docker(['pull', 'postgres:17-alpine'], 120000); image = JSON.parse(await docker(['image', 'inspect', 'postgres:17-alpine']))[0]; }
  assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
  console.log('Registry fixture image:', image.Id);
  await docker(['volume', 'create', '--label', `io.fullpanel.registry-fixture=${fixture}`, volume]);
  await docker(['create', '--name', name, '--label', `io.fullpanel.registry-fixture=${fixture}`, '--env-file', envFile,
    '--publish', `127.0.0.1:${port}:5432`, '--memory', '384m', '--cpus', '0.5', '--mount', `type=volume,source=${volume},target=/var/lib/postgresql/data`, image.Id]);
  let container = await inspect('container', name); assert(container); assert.equal(container.Config.Labels['io.fullpanel.registry-fixture'], fixture);
  containerId = container.Id; await docker(['start', containerId]);
  container = await inspect('container', containerId);
  const binding = container.NetworkSettings.Ports['5432/tcp'][0]; assert.equal(binding.HostIp, '127.0.0.1'); assert.equal(Number(binding.HostPort), port);
  const databaseUrl = `postgresql://fixture:${password}@127.0.0.1:${binding.HostPort}/${databaseName}`;
  readiness = createRegistryDatabase({ connectionString: databaseUrl, allowInsecureLoopbackForTests: true });
  const deadline = Date.now() + 30000;
  let connected = false;
  while (!connected && Date.now() < deadline) {
    try { await readiness.pool.query('SELECT 1'); connected = true; } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  assert(connected, 'Disposable PostgreSQL did not become ready.'); await readiness.close(); readiness = undefined;
  const result = await execute(process.execPath, ['--test', 'registry/store.integration.test.mjs'], {
    cwd: dirname(fileURLToPath(new URL('../package.json', import.meta.url))), timeout: 120000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, DATABASE_URL: databaseUrl, REGISTRY_FIXTURE_ID: fixture, REGISTRY_FIXTURE_CONTAINER_ID: containerId, NODE_ENV: 'test' }
  }).catch(error => ({ stdout: error.stdout || '', stderr: error.stderr || '', failed: true }));
  const safe = value => value.replaceAll(password, '[REDACTED]').replaceAll(databaseUrl, '[REDACTED]').replace(/fpr_[A-Za-z0-9_-]{43}/g, '[REDACTED]');
  process.stdout.write(safe(result.stdout)); if (result.stderr) process.stderr.write(safe(result.stderr));
  if (result.failed) throw new Error('Registry integration assertions failed.');
} finally {
  await readiness?.close();
  const container = await inspect('container', name);
  if (container) { assert.equal(container.Config.Labels['io.fullpanel.registry-fixture'], fixture); if (containerId) assert.equal(container.Id, containerId); await docker(['rm', '-f', container.Id]); }
  const existing = await inspect('volume', volume);
  if (existing) { assert.equal(existing.Labels['io.fullpanel.registry-fixture'], fixture); await docker(['volume', 'rm', existing.Name]); }
  await rm(work, { recursive: true, force: true });
  console.log('Owned registry container, volume and temporary credentials cleaned up.');
}
