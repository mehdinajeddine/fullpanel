/** Real cross-service recovery proof. Select cached engines with HARBORLIGHT_RESTORE_TEST_ENGINES. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerDriver, command, type RestoreCheckpoint, type RestoreResult } from '../server/docker.js';
import { NativeDatabaseTools, databasePaths } from '../server/database-restore.js';
import { backupFileHash } from '../server/restore-jobs.js';
import type { Backup, Service, ServiceKind } from '../shared/types.js';

const images: Partial<Record<ServiceKind, string>> = { postgres: 'postgres:17-alpine', mysql: 'mysql:8.4', mariadb: 'mariadb:11.4', mongo: 'mongo:8', redis: 'redis:7-alpine', app: 'nginx:1.28-alpine' };
const engines = (process.env.HARBORLIGHT_RESTORE_TEST_ENGINES || 'postgres,mysql,mariadb,mongo,redis,app').split(',') as ServiceKind[];
assert.ok(engines.length && engines.every(kind => Object.hasOwn(images, kind)), 'Choose postgres,mysql,mariadb,mongo,redis,app.');
const directory = await mkdtemp(join(tmpdir(), 'harborlight-restore-smoke-'));
const driver = new DockerDriver(directory), native = new NativeDatabaseTools(command, directory);
const services: Service[] = [], anonymousVolumes = new Set<string>();
const projectId = randomUUID();
const nestedPath = '/usr/share/nginx/html/nested/été.txt';
const nestedContents = 'Données restaurées — café ☕\n';
async function inspect(service: Service) { return JSON.parse(await command('docker', ['container', 'inspect', `hl-${service.id}`]))[0]; }
async function trackAnonymous(service: Service) {
  const container = await inspect(service);
  for (const mount of container.Mounts || []) if (mount.Type === 'volume' && /^[a-f0-9]{64}$/.test(mount.Name)) anonymousVolumes.add(mount.Name);
  return container;
}
async function ready(service: Service) {
  const until = Date.now() + 180000; let last: unknown;
  while (Date.now() < until) {
    try { const container = await inspect(service); assert.equal(container.State.Running, true); if (service.kind === 'app') await command('docker', ['exec', container.Id, 'wget', '-qO-', 'http://127.0.0.1']); else await native.ready(container.Id, service); return; }
    catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 750)); }
  }
  throw last;
}
function make(kind: ServiceKind, image: string, name: string): Service {
  const password = randomUUID(), account = name === 'source' ? 'source_owner' : 'target_owner', database = name === 'source' ? 'recovery_source' : 'recovery_target';
  const env: Record<string, string> = kind === 'postgres' ? { POSTGRES_USER: account, POSTGRES_PASSWORD: password, POSTGRES_DB: database }
    : kind === 'mysql' ? { MYSQL_ROOT_PASSWORD: password, MYSQL_USER: account, MYSQL_PASSWORD: randomUUID(), MYSQL_DATABASE: database }
    : kind === 'mariadb' ? { MARIADB_ROOT_PASSWORD: password, MARIADB_USER: account, MARIADB_PASSWORD: randomUUID(), MARIADB_DATABASE: database }
    : kind === 'mongo' ? { MONGO_INITDB_ROOT_USERNAME: account, MONGO_INITDB_ROOT_PASSWORD: password, MONGO_INITDB_DATABASE: database }
    : kind === 'redis' ? { REDIS_PASSWORD: password } : {};
  const timestamp = new Date().toISOString();
  const service: Service = { id: randomUUID(), projectId, name: `${name}-${kind}`, kind, source: { type: 'image', image }, env, mounts: [{ id: randomUUID(), name: 'data', mountPath: kind === 'app' ? '/usr/share/nginx/html' : databasePaths[kind]! }], domains: [], ports: [], resources: { cpu: 1, memoryMb: ['mysql', 'mariadb', 'mongo'].includes(kind) ? 768 : 256 }, status: 'running', notes: '', createdAt: timestamp, updatedAt: timestamp };
  services.push(service); return service;
}
async function writeProof(service: Service, value: string) {
  const container = (await inspect(service)).Id;
  const sql = `CREATE TABLE IF NOT EXISTS recovery_proof (value varchar(100)); DELETE FROM recovery_proof; INSERT INTO recovery_proof VALUES ('${value}');`;
  if (service.kind === 'postgres') await native.execute(container, service, ['psql', '-X', '-h', '127.0.0.1', '-U', service.env.POSTGRES_USER, '-d', service.env.POSTGRES_DB, '-v', 'ON_ERROR_STOP=1', '-c', sql]);
  else if (service.kind === 'mysql' || service.kind === 'mariadb') await native.execute(container, service, [service.kind === 'mysql' ? 'mysql' : 'mariadb', '-u', 'root', service.env.MYSQL_DATABASE || service.env.MARIADB_DATABASE, '-e', sql]);
  else if (service.kind === 'mongo') await native.execute(container, service, ['mongosh', '--quiet', '--eval', `if(!db.getSiblingDB("admin").auth(process.env.MONGO_INITDB_ROOT_USERNAME,process.env.MONGO_INITDB_ROOT_PASSWORD).ok)quit(2); const x=db.getSiblingDB(${JSON.stringify(service.env.MONGO_INITDB_DATABASE)}); x.recovery_proof.deleteMany({}); x.recovery_proof.insertOne({value:${JSON.stringify(value)}});`]);
  else if (service.kind === 'redis') await native.execute(container, service, ['redis-cli', '-e', 'SET', 'recovery-proof', value]);
  else await command('docker', ['exec', '-i', container, 'sh', '-c', 'cat > /usr/share/nginx/html/index.html'], { input: value });
}
async function readProof(service: Service) {
  const container = (await inspect(service)).Id;
  if (service.kind === 'postgres') return (await native.execute(container, service, ['psql', '-X', '-h', '127.0.0.1', '-U', service.env.POSTGRES_USER, '-d', service.env.POSTGRES_DB, '-Atc', 'SELECT value FROM recovery_proof'])).trim();
  if (service.kind === 'mysql' || service.kind === 'mariadb') return (await native.execute(container, service, [service.kind === 'mysql' ? 'mysql' : 'mariadb', '-u', 'root', service.env.MYSQL_DATABASE || service.env.MARIADB_DATABASE, '-Nse', 'SELECT value FROM recovery_proof'])).trim();
  if (service.kind === 'mongo') return (await native.execute(container, service, ['mongosh', '--quiet', '--eval', `if(!db.getSiblingDB("admin").auth(process.env.MONGO_INITDB_ROOT_USERNAME,process.env.MONGO_INITDB_ROOT_PASSWORD).ok)quit(2); print(db.getSiblingDB(${JSON.stringify(service.env.MONGO_INITDB_DATABASE)}).recovery_proof.findOne().value);`])).trim();
  if (service.kind === 'redis') return (await native.execute(container, service, ['redis-cli', '-e', '--raw', 'GET', 'recovery-proof'])).trim();
  return (await command('docker', ['exec', container, 'wget', '-qO-', 'http://127.0.0.1'])).trim();
}
async function cleanup(service: Service) {
  const container = await inspect(service).catch(() => undefined);
  if (container?.Config.Labels?.['io.harborlight.service'] === service.id && container.Config.Labels['io.harborlight.managed'] === 'true') {
    await trackAnonymous(service); await command('docker', ['rm', '-f', '-v', container.Id]);
  }
  const volumes = (await command('docker', ['volume', 'ls', '-q', '--filter', `label=io.harborlight.service=${service.id}`])).trim().split('\n').filter(Boolean);
  for (const name of volumes) {
    const [volume] = JSON.parse(await command('docker', ['volume', 'inspect', name]));
    if (volume.Labels?.['io.harborlight.managed'] === 'true' && volume.Labels['io.harborlight.service'] === service.id) await command('docker', ['volume', 'rm', name]);
  }
}
try {
  for (const kind of engines) {
    // Refuse an implicit heavy image download; this also fixes the image digest for this run.
    const [cached] = JSON.parse(await command('docker', ['image', 'inspect', images[kind]!]));
    const image = cached.RepoDigests?.[0]; assert.ok(image, `Pull ${images[kind]} explicitly before running this check.`);
    if (kind === 'app' || kind === 'redis') await command('docker', ['image', 'inspect', 'alpine:3.21']);
    console.log(`Checking real ${kind} recovery using cached ${image}.`);
    const source = make(kind, image, 'source'), target = make(kind, image, 'target');
    if (kind === 'postgres') source.env.POSTGRES_PASSWORD = 'unicode-I\u00ADX-recovery-password';
    await driver.deploy(source, () => {}); await ready(source); await writeProof(source, 'source-snapshot');
    if (kind === 'postgres') {
      const stale = { ...source, env: { ...source.env, POSTGRES_PASSWORD: 'deliberately-wrong-profile-password' } };
      await assert.rejects(native.ready((await inspect(source)).Id, stale), /credentials do not match/);
      await assert.rejects(driver.backup(stale, join(directory, 'stale-profile.sql')), /credentials do not match/);
      await assert.rejects(readFile(join(directory, 'stale-profile.sql')), { code: 'ENOENT' });
      console.log('PASS: real PostgreSQL SCRAM with a SASLprep-normalized Unicode password is verified; stale password fails readiness and backup before any dump is written.');
    }
    if (kind === 'app') await command('docker', ['exec', '-i', (await inspect(source)).Id, 'sh', '-c', 'mkdir -p /usr/share/nginx/html/nested && cat > "$1" && chown 123:234 "$1" && chmod 640 "$1"', 'sh', nestedPath], { input: nestedContents });
    await trackAnonymous(source);
    const filename = join(directory, `${source.id}.backup`), metadata = await driver.backup(source, filename);
    const record: Backup = { id: randomUUID(), serviceId: source.id, status: 'success', createdAt: new Date().toISOString(), filename: `${source.id}.backup`, sizeBytes: (await readFile(filename)).length, metadata, sha256: await backupFileHash(filename) };
    assert.equal(metadata.kind, kind); if (kind !== 'app') assert.match(metadata.engineVersion || '', /^\d+\.\d+/);
    await driver.action(source, 'stop');
    // The source backup/profile are sufficient; release its disposable runtime and volume before recovery.
    await cleanup(source);
    await driver.deploy(target, () => {}); await ready(target); await writeProof(target, 'target-before-restore');
    const original = await trackAnonymous(target), previous = structuredClone(target);
    const oldVolume = `hl-${target.id}-data`;
    let logs = '';
    if (kind === 'postgres') {
      const corrupt = join(directory, 'invalid-postgres.sql');
      await writeFile(corrupt, '-- PostgreSQL database cluster dump\nSELECT * FROM harborlight_missing_restore_table;\n');
      await assert.rejects(driver.restore(target, record, corrupt, value => { logs += value; }, { sourceService: source }));
      assert.equal((await inspect(target)).Id, original.Id); assert.equal(await readProof(target), 'target-before-restore');
      let failedCheckpoint: RestoreCheckpoint | undefined, failedPrepared: Service | undefined;
      await assert.rejects(driver.restore(target, record, filename, value => { logs += value; }, { sourceService: source, onPrepared: async (result, checkpoint) => {
        failedCheckpoint = checkpoint; failedPrepared = { ...target, env: { ...target.env, ...result.environment }, volumeOverrides: result.volumeOverrides };
        throw new Error('Intent persistence failure fixture');
      } }), /Intent persistence failure/);
      assert.equal((await inspect(target)).Id, original.Id); assert.equal(await readProof(target), 'target-before-restore');
      assert.equal(await driver.recoverRestore(previous, failedPrepared!, failedCheckpoint!), 'rolled-back');
      console.log('PASS: failed native import and failed intent persistence preserve the exact previous container and records; rollback recovery is idempotent.');
    }
    let checkpoint: RestoreCheckpoint | undefined, prepared: Service | undefined;
    const result: RestoreResult = await driver.restore(target, record, filename, value => { logs += value; }, { sourceService: source, onPrepared: async (value, state) => {
      checkpoint = state; prepared = { ...target, env: { ...target.env, ...value.environment }, volumeOverrides: value.volumeOverrides };
      assert.equal((await inspect(target)).Id, original.Id); assert.equal((await inspect(target)).State.Running, true);
    } });
    target.env = { ...target.env, ...result.environment }; target.volumeOverrides = result.volumeOverrides;
    assert.notEqual((await inspect(target)).Id, original.Id); await ready(target); assert.equal(await readProof(target), 'source-snapshot');
    if (kind === 'app') {
      assert.equal(await command('docker', ['exec', result.containerId, 'cat', nestedPath]), nestedContents);
      assert.equal((await command('docker', ['exec', result.containerId, 'stat', '-c', '%u:%g:%a', nestedPath])).trim(), '123:234:640');
      console.log('PASS: application nested UTF-8 file contents, uid 123, gid 234 and mode 640 are preserved.');
    }
    assert.equal(await driver.recoverRestore(previous, prepared!, checkpoint!), 'activated');
    const [retained] = JSON.parse(await command('docker', ['volume', 'inspect', oldVolume])); assert.equal(retained.Labels['io.harborlight.service'], target.id);
    for (const secret of [...Object.values(source.env), ...Object.values(previous.env)].filter(value => value.length >= 8)) assert.ok(!logs.includes(secret));
    await writeProof(target, 'after-restore-write'); await driver.action(target, 'restart'); await ready(target); assert.equal(await readProof(target), 'after-restore-write');
    if (kind === 'redis') assert.match(await native.execute((await inspect(target)).Id, target, ['redis-cli', '-e', '--raw', 'CONFIG', 'GET', 'appendonly']), /appendonly\r?\nyes/);
    await driver.deploy(target, () => {}); await ready(target); assert.equal(await readProof(target), 'after-restore-write');
    console.log(`PASS: ${kind} native records recovered across services with different credentials, old volume retained, active recovery verified, restart and redeploy preserve new writes.`);
    await cleanup(source); await cleanup(target);
  }
  console.log('All selected real restore checks passed.');
} finally {
  for (const service of services) await cleanup(service).catch(error => console.error('Owned service cleanup:', String(error)));
  for (const name of anonymousVolumes) await command('docker', ['volume', 'rm', name]).catch(() => {});
  const [network] = JSON.parse(await command('docker', ['network', 'inspect', `hl-project-${projectId}`]).catch(() => '[]'));
  if (network?.Labels?.['io.harborlight.project'] === projectId && network.Labels['io.harborlight.managed'] === 'true') await command('docker', ['network', 'rm', network.Name]);
  await rm(directory, { recursive: true, force: true });
}
