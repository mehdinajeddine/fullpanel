/** Native engine checks use disposable labeled services, credentials and volumes. */
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, connect } from 'node:net';
import { DockerDriver, command } from '../server/docker.js';
import { NativeDatabaseTools } from '../server/database-restore.js';
import type { Service } from '../shared/types.js';

const directory = await mkdtemp(join(tmpdir(), 'harborlight-engine-smoke-'));
const projectId = randomUUID();
const driver = new DockerDriver(directory), native = new NativeDatabaseTools(command, directory);
const services: Service[] = [];
const anonymousVolumes = new Set<string>();
const output: string[] = [];
async function deploy(service: Service) {
  await driver.deploy(service, chunk => output.push(chunk));
  const [container] = JSON.parse(await command('docker', ['container', 'inspect', `hl-${service.id}`]));
  assert.equal(container.Config.Labels['io.harborlight.service'], service.id);
  // Some images declare an additional anonymous volume. Remember only mounts
  // observed on this fixture's exact owned container, including before redeploy.
  for (const mount of container.Mounts || []) if (mount.Type === 'volume' && /^[a-f0-9]{64}$/.test(mount.Name)) anonymousVolumes.add(mount.Name);
}
async function eventually(check: () => Promise<void>, timeout = 180000) {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    try { await check(); return; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw last;
}
async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
function tcp(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ port, host: '127.0.0.1' });
    const finish = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(2000, () => finish(false));
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
  });
}
async function query(service: Service, sql: string, applicationUser = false) {
  const env = { ...service.env };
  const user = service.kind === 'mysql' ? env.MYSQL_USER : env.MARIADB_USER;
  if (applicationUser) {
    if (service.kind === 'mysql') env.MYSQL_ROOT_PASSWORD = env.MYSQL_PASSWORD;
    else env.MARIADB_ROOT_PASSWORD = env.MARIADB_PASSWORD;
  }
  return native.execute(`hl-${service.id}`, { ...service, env }, [service.kind === 'mysql' ? 'mysql' : 'mariadb', '--protocol=TCP', '-h', '127.0.0.1', '-u', applicationUser ? user : 'root', '-Nse', sql]);
}
async function mongo(service: Service, expression: string) {
  return native.execute(`hl-${service.id}`, service, ['mongosh', '--quiet', '--eval', `const admin=db.getSiblingDB("admin"); if(!admin.auth(process.env.MONGO_INITDB_ROOT_USERNAME,process.env.MONGO_INITDB_ROOT_PASSWORD).ok) quit(2); const proof=db.getSiblingDB("proof"); ${expression}`]);
}
async function externalQuery(service: Service, port: number) {
  const file = join(directory, `${service.id}-remote-client.env`);
  const credentials = service.kind === 'mongo'
    ? { MONGO_INITDB_ROOT_USERNAME: service.env.MONGO_INITDB_ROOT_USERNAME, MONGO_INITDB_ROOT_PASSWORD: service.env.MONGO_INITDB_ROOT_PASSWORD }
    : { MYSQL_PWD: service.kind === 'mysql' ? service.env.MYSQL_PASSWORD : service.env.MARIADB_PASSWORD };
  await writeFile(file, Object.entries(credentials).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600, flag: 'wx' });
  const helper = `hl-engine-client-${randomUUID()}`;
  const binary = service.kind === 'mongo' ? 'mongosh' : service.kind === 'mysql' ? 'mysql' : 'mariadb';
  const args = service.kind === 'mongo'
    ? ['--quiet', `mongodb://hl-docker-host:${port}/admin`, '--eval', 'if(!db.auth(process.env.MONGO_INITDB_ROOT_USERNAME,process.env.MONGO_INITDB_ROOT_PASSWORD).ok) quit(2); print(db.getSiblingDB("proof").records.countDocuments({marker:"persisted"}));']
    : ['--protocol=TCP', '-h', 'hl-docker-host', '-P', String(port), '-u', service.kind === 'mysql' ? service.env.MYSQL_USER : service.env.MARIADB_USER, '-Nse', 'SELECT COUNT(*) FROM proof.records;'];
  try {
    return await command('docker', ['run', '--rm', '--name', helper, '--label', `io.harborlight.test=${projectId}`, '--network', 'bridge', '--add-host', 'hl-docker-host:host-gateway', '--env-file', file, '--entrypoint', binary, service.source.image!, ...args], { timeout: 30000 });
  } finally {
    await command('docker', ['rm', '-f', helper]).catch(() => {});
    await rm(file, { force: true });
  }
}
try {
  const selected = process.env.ENGINE_KINDS?.split(',') || ['mysql', 'mariadb', 'mongo'];
  assert(selected.every(kind => ['mysql', 'mariadb', 'mongo'].includes(kind)), 'ENGINE_KINDS must contain mysql, mariadb or mongo');
  for (const kind of selected as ('mysql' | 'mariadb' | 'mongo')[]) {
    const id = randomUUID(), timestamp = new Date().toISOString();
    const password = randomBytes(24).toString('base64url'), rootPassword = randomBytes(24).toString('base64url');
    const env = kind === 'mysql' ? { MYSQL_ROOT_PASSWORD: rootPassword, MYSQL_USER: 'proofuser', MYSQL_PASSWORD: password, MYSQL_DATABASE: 'proof' }
      : kind === 'mariadb' ? { MARIADB_ROOT_PASSWORD: rootPassword, MARIADB_USER: 'proofuser', MARIADB_PASSWORD: password, MARIADB_DATABASE: 'proof' }
      : { MONGO_INITDB_ROOT_USERNAME: 'proofuser', MONGO_INITDB_ROOT_PASSWORD: rootPassword, MONGO_INITDB_DATABASE: 'proof' };
    const service: Service = { id, projectId, name: `${kind}-proof`, kind, source: { type: 'image', image: kind === 'mysql' ? 'mysql:8.4' : kind === 'mariadb' ? 'mariadb:11.4' : 'mongo:8' }, env: Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) as Record<string, string>, domains: [], mounts: [{ id: randomUUID(), name: 'data', mountPath: kind === 'mongo' ? '/data/db' : '/var/lib/mysql' }], ports: [], resources: { cpu: 1, memoryMb: 768 }, status: 'not-deployed', notes: '', createdAt: timestamp, updatedAt: timestamp };
    services.push(service);
    await deploy(service);
    await eventually(() => native.ready(`hl-${id}`, service));
    const version = await native.version(`hl-${id}`, kind);
    assert.match(version, /^\d+\.\d+/);
    const passwordKey = kind === 'mysql' ? 'MYSQL_ROOT_PASSWORD' : kind === 'mariadb' ? 'MARIADB_ROOT_PASSWORD' : 'MONGO_INITDB_ROOT_PASSWORD';
    await assert.rejects(native.ready(`hl-${id}`, { ...service, env: { ...service.env, [passwordKey]: 'wrong-fixture-password' } }));
    if (kind === 'mongo') {
      assert.equal((await mongo(service, 'proof.records.insertOne({marker:"persisted"}); print(proof.records.countDocuments({marker:"persisted"}));')).trim(), '1');
    } else {
      assert.equal((await query(service, 'CREATE TABLE proof.records (marker VARCHAR(40)); INSERT INTO proof.records VALUES ("persisted"); SELECT COUNT(*) FROM proof.records;', true)).trim(), '1');
    }
    const backup = join(directory, `${kind}.${kind === 'mongo' ? 'archive.gz' : 'sql'}`);
    await native.backup(`hl-${id}`, service, backup);
    assert((await stat(backup)).size > 100);
    if (kind !== 'mongo') assert.match(await readFile(backup, 'utf8'), /persisted/);
    else assert.equal((await readFile(backup)).subarray(0, 2).toString('hex'), '1f8b');
    await driver.action(service, 'restart');
    await eventually(() => native.ready(`hl-${id}`, service));
    await deploy(service);
    await eventually(() => native.ready(`hl-${id}`, service));
    if (kind === 'mongo') assert.equal((await mongo(service, 'print(proof.records.countDocuments({marker:"persisted"}));')).trim(), '1');
    else assert.equal((await query(service, 'SELECT COUNT(*) FROM proof.records;', true)).trim(), '1');
    const [privateContainer] = JSON.parse(await command('docker', ['inspect', `hl-${id}`]));
    assert.deepEqual(privateContainer.HostConfig.PortBindings || {}, {});
    const port = await availablePort();
    service.ports = [{ published: port, target: kind === 'mongo' ? 27017 : 3306, protocol: 'tcp' }];
    await deploy(service);
    await eventually(() => native.ready(`hl-${id}`, service));
    assert.equal(await tcp(port), true);
    assert.equal((await externalQuery(service, port)).trim(), '1');
    service.ports = [];
    await deploy(service);
    await eventually(() => native.ready(`hl-${id}`, service));
    await eventually(async () => assert.equal(await tcp(port), false));
    assert(!output.join('').includes(password)); assert(!output.join('').includes(rootPassword));
    console.log(`PASS: ${kind} ${version} authenticated initialization, wrong-password denial, application data, native dump, restart/redeploy persistence and host-port opt-in/revocation.`);
    await driver.remove(service);
    await command('docker', ['volume', 'rm', `hl-${id}-data`]);
  }
} finally {
  for (const service of services.reverse()) {
    await driver.remove(service).catch(() => {});
    try {
      const [volume] = JSON.parse(await command('docker', ['volume', 'inspect', `hl-${service.id}-data`]));
      if (volume.Labels?.['io.harborlight.service'] === service.id && volume.Labels?.['io.harborlight.managed'] === 'true') await command('docker', ['volume', 'rm', volume.Name]);
    } catch { /* Already cleaned up. */ }
  }
  for (const name of anonymousVolumes) await command('docker', ['volume', 'rm', name]).catch(() => {});
  try {
    const [network] = JSON.parse(await command('docker', ['network', 'inspect', `hl-project-${projectId}`]));
    if (network.Labels?.['io.harborlight.project'] === projectId) await command('docker', ['network', 'rm', network.Name]);
  } catch { /* Nothing deployed. */ }
  await rm(directory, { recursive: true, force: true });
}
