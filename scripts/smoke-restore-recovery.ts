/**
 * Real process-crash proof for the restore journal. Uses only cached PostgreSQL 17.
 * Run: node --import tsx scripts/smoke-restore-recovery.ts
 * Each scenario creates its own encrypted state, project, services and Docker volumes.
 * The child is deliberately SIGKILLed; no product crash hooks or graceful close run.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createDecipheriv, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { command, DockerDriver, type Output, type RestoreOptions, type RestoreResult } from '../server/docker.js';
import { NativeDatabaseTools } from '../server/database-restore.js';
import type { State } from '../server/store.js';
import type { Backup, Deployment, RestoreJob, Service, Session } from '../shared/types.js';

type CrashPoint = 'prepared' | 'activated';
type Exit = { code: number | null; signal: NodeJS.Signals | null };
interface ServerProcess { process: ChildProcess; endpoint: string; exited: Promise<Exit> }
const script = fileURLToPath(import.meta.url);
const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const delay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const sensitive = new Set<string>();
const redact = (text: string) => [...sensitive].filter(value => value.length >= 4).reduce((result, value) => result.split(value).join('[REDACTED]'), text);

async function killedProcess(): Promise<never> {
  process.kill(process.pid, 'SIGKILL');
  // Do not permit a return into the app even if the OS schedules signal delivery later.
  return new Promise<never>(() => {});
}

async function childServer(directory: string, crashPoint: string) {
  assert.ok(['prepared', 'activated', 'none'].includes(crashPoint), 'Invalid child crash point.');
  class CrashDriver extends DockerDriver {
    override async restore(target: Service, backup: Backup, filename: string, output: Output, options: RestoreOptions = {}): Promise<RestoreResult> {
      const result = await super.restore(target, backup, filename, output, crashPoint === 'prepared' ? {
        ...options,
        onPrepared: async (prepared, checkpoint) => {
          assert.ok(options.onPrepared, 'The app must persist its recovery checkpoint.');
          await options.onPrepared(prepared, checkpoint);
          await killedProcess();
        }
      } : options);
      if (crashPoint === 'activated') return killedProcess();
      return result;
    }
  }
  const driver = crashPoint === 'none' ? new DockerDriver(directory) : new CrashDriver(directory);
  const app = await createApp({ dataDir: directory, mode: 'docker', driver });
  const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
  assert.ok(process.send, 'Child server must be started by this harness.');
  process.send({ type: 'ready', endpoint });
  const stop = () => { void app.close().then(() => process.exit(0), () => process.exit(1)); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

async function startServer(directory: string, crashPoint: CrashPoint | 'none'): Promise<ServerProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', script, '--child', directory, crashPoint], {
    cwd: projectDirectory, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { output = (output + String(chunk)).slice(-8000); });
  const exited = new Promise<Exit>(resolve => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', () => resolve({ code: -1, signal: null })); });
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Child startup timed out. ${redact(output)}`)), 90000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Child exited before readiness (${code ?? signal}). ${redact(output)}`)); });
      child.on('message', value => {
        const message = value as { type?: string; endpoint?: string };
        if (message.type !== 'ready' || !message.endpoint) return;
        clearTimeout(timer);
        const url = new URL(message.endpoint);
        assert.equal(url.hostname, '127.0.0.1');
        resolve(url.origin);
      });
    });
    return { process: child, endpoint, exited };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    throw error;
  }
}

async function stopServer(server?: ServerProcess) {
  if (!server || server.process.exitCode !== null || server.process.signalCode !== null) return;
  server.process.kill('SIGTERM');
  const timer = setTimeout(() => server.process.kill('SIGKILL'), 15000);
  try { await server.exited; } finally { clearTimeout(timer); }
}

async function readState(directory: string): Promise<State> {
  // Read without opening Store: opening it would itself mutate restart bookkeeping.
  const [bytes, key] = await Promise.all([readFile(join(directory, 'state.enc')), readFile(join(directory, 'encryption.key'))]);
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString()) as State;
}

async function inspect(service: Service) {
  const [container] = JSON.parse(await command('docker', ['container', 'inspect', `hl-${service.id}`]));
  assert.equal(container.Config.Labels['io.harborlight.managed'], 'true');
  assert.equal(container.Config.Labels['io.harborlight.service'], service.id);
  return container;
}

async function cleanup(services: Service[], projectId?: string) {
  const failures: string[] = [];
  for (const service of services) {
    try {
      const ids = (await command('docker', ['container', 'ls', '-aq', '--filter', 'label=io.harborlight.managed=true', '--filter', `label=io.harborlight.service=${service.id}`])).trim().split('\n').filter(Boolean);
      for (const id of ids) {
        const [container] = JSON.parse(await command('docker', ['container', 'inspect', id]));
        assert.equal(container.Config.Labels['io.harborlight.managed'], 'true');
        assert.equal(container.Config.Labels['io.harborlight.service'], service.id);
        await command('docker', ['rm', '-f', '-v', container.Id]);
      }
      const names = (await command('docker', ['volume', 'ls', '-q', '--filter', 'label=io.harborlight.managed=true', '--filter', `label=io.harborlight.service=${service.id}`])).trim().split('\n').filter(Boolean);
      for (const name of names) {
        const [volume] = JSON.parse(await command('docker', ['volume', 'inspect', name]));
        assert.equal(volume.Labels['io.harborlight.managed'], 'true');
        assert.equal(volume.Labels['io.harborlight.service'], service.id);
        assert.ok(name.startsWith(`hl-${service.id}-`));
        await command('docker', ['volume', 'rm', name]);
      }
    } catch (error) { failures.push(`${service.id}: ${redact(String(error))}`); }
  }
  if (projectId) {
    try {
      const [network] = JSON.parse(await command('docker', ['network', 'inspect', `hl-project-${projectId}`]).catch(() => '[]'));
      if (network) {
        assert.equal(network.Labels['io.harborlight.managed'], 'true');
        assert.equal(network.Labels['io.harborlight.project'], projectId);
        await command('docker', ['network', 'rm', network.Id]);
      }
    } catch (error) { failures.push(`Project ${projectId}: ${redact(String(error))}`); }
  }
  assert.deepEqual(failures, [], 'Cleanup failed for resources owned by this harness.');
}

async function scenario(crashPoint: CrashPoint, image: string) {
  const directory = await mkdtemp(join(tmpdir(), `harborlight-recovery-${crashPoint}-`));
  const dataDirectory = join(directory, 'state'), nativeDirectory = join(directory, 'native');
  await mkdir(nativeDirectory, { mode: 0o700 });
  const native = new NativeDatabaseTools(command, nativeDirectory);
  const services: Service[] = [];
  let projectId: string | undefined, server: ServerProcess | undefined, cookie = '';
  async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    assert.ok(server);
    const response = await fetch(`${server.endpoint}/api${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const value = await response.json();
    assert.ok(response.ok, redact(`${method} ${path}: ${response.status} ${JSON.stringify(value)}`));
    const sessionCookie = response.headers.get('set-cookie');
    if (sessionCookie) cookie = sessionCookie.split(';')[0];
    return value as T;
  }
  async function deploy(service: Service) {
    const deployment = await api<Deployment>('POST', `/services/${service.id}/deploy`, {});
    for (let attempt = 0; attempt < 240; attempt++) {
      const job = await api<Deployment>('GET', `/deployments/${deployment.id}`);
      assert.notEqual(job.status, 'failed', redact(job.output));
      if (job.status === 'success') return;
      await delay(500);
    }
    throw new Error('Deployment did not finish.');
  }
  async function ready(service: Service) {
    let last: unknown;
    for (let attempt = 0; attempt < 240; attempt++) {
      try { const runtime = await inspect(service); assert.ok(runtime.State.Running); await native.ready(runtime.Id, service); return; }
      catch (error) { last = error; await delay(500); }
    }
    throw new Error(redact(`Database readiness timed out: ${String(last)}`));
  }
  async function sql(service: Service, query: string) {
    return (await native.execute((await inspect(service)).Id, service, ['psql', '-X', '-h', '127.0.0.1', '-U', service.env.POSTGRES_USER, '-d', service.env.POSTGRES_DB, '-v', 'ON_ERROR_STOP=1', '-Atc', query])).trim();
  }
  try {
    console.log(`Checking real SIGKILL at ${crashPoint} restore checkpoint.`);
    server = await startServer(dataDirectory, crashPoint);
    const password = randomUUID() + randomUUID(); sensitive.add(password);
    await api('POST', '/auth/setup', { name: 'Recovery QA', email: 'recovery@example.test', password });
    const project = await api<{ id: string }>('POST', '/projects', { name: `recovery-${randomUUID().slice(0, 8)}` }); projectId = project.id;
    for (const name of ['source', 'target']) {
      const databasePassword = randomUUID(); sensitive.add(databasePassword);
      const service = await api<Service>('POST', '/services', {
        projectId, name, kind: 'postgres', source: { type: 'image', image },
        env: { POSTGRES_USER: `${name}_owner`, POSTGRES_PASSWORD: databasePassword, POSTGRES_DB: `${name}_data` }, resources: { cpu: 1, memoryMb: 256 }
      });
      services.push(service); await deploy(service); await ready(service);
      await sql(service, `CREATE TABLE recovery_proof (value text NOT NULL); INSERT INTO recovery_proof VALUES ('${name}-records');`);
    }
    const [source, target] = services;
    const original = await inspect(target), originalMapping = structuredClone((await readState(dataDirectory)).appliedServices[target.id]);
    const backup = await api<Backup>('POST', `/services/${source.id}/backups`);
    let completed: Backup | undefined;
    for (let attempt = 0; attempt < 120; attempt++) {
      completed = (await api<Backup[]>('GET', '/backups')).find(item => item.id === backup.id);
      assert.notEqual(completed?.status, 'failed', redact(completed?.error || ''));
      if (completed?.status === 'success') break;
      await delay(500);
    }
    assert.equal(completed?.status, 'success'); assert.equal(completed.metadata?.schemaVersion, 1); assert.match(completed.sha256 || '', /^[a-f0-9]{64}$/);
    await api('POST', `/services/${source.id}/stop`);
    const job = await api<RestoreJob>('POST', `/services/${target.id}/restore`, { backupId: backup.id, confirmationName: target.name });
    let timedOut = false;
    const killTimeout = setTimeout(() => { timedOut = true; server?.process.kill('SIGKILL'); }, 180000);
    let exit: Exit;
    try { exit = await server.exited; } finally { clearTimeout(killTimeout); }
    assert.equal(timedOut, false, 'The restore must reach its deliberate crash point before the timeout.');
    assert.equal(exit.signal, 'SIGKILL', 'The failure must be a real abrupt process death at the requested checkpoint.');
    assert.equal(exit.code, null);
    const interrupted = await readState(dataDirectory), intent = interrupted.restoreIntents[job.id];
    assert.ok((await lstat(join(dataDirectory,'restore-work',job.id))).isDirectory(),'The crash must leave the pinned restore workspace for startup recovery.');
    assert.ok(intent, 'The recovery intent must already exist on disk before the child dies.');
    assert.equal(interrupted.restores.find(item => item.id === job.id)?.status, 'running');
    assert.equal(interrupted.appliedServices[target.id].containerId, original.Id, 'The app must not have committed the restore result before the kill.');
    assert.equal(intent.previousService.containerId, original.Id);
    assert.notEqual(intent.preparedService.containerId, original.Id);
    assert.equal(intent.preparedService.env.POSTGRES_PASSWORD, source.env.POSTGRES_PASSWORD);
    assert.equal(intent.checkpoint.candidateContainerId, intent.preparedService.containerId);
    const beforeRecovery = await inspect(target);
    assert.equal(beforeRecovery.Id, crashPoint === 'activated' ? intent.checkpoint.candidateContainerId : original.Id);
    if (crashPoint === 'prepared') assert.equal(await sql(target, 'SELECT value FROM recovery_proof'), 'target-records');

    // A plain createApp with a plain DockerDriver performs startup recovery and removes the stale writer lock.
    server = await startServer(dataDirectory, 'none');
    assert.equal((await api<Session>('GET', '/auth/session')).authenticated, true);
    const recoveredJob = await api<RestoreJob>('GET', `/restores/${job.id}`);
    assert.equal(recoveredJob.status, 'failed', 'An interrupted request must never be relabeled as an uninterrupted success.');
    assert.equal(recoveredJob.phase, 'finished'); assert.ok(recoveredJob.finishedAt); assert.match(recoveredJob.error || '', /restart/);
    assert.match(recoveredJob.error || '', crashPoint === 'activated' ? /replacement volumes are active/ : /original volumes were restored/);
    assert.ok(recoveredJob.preRestoreBackupId);
    const safety = (await api<Backup[]>('GET', '/backups')).find(item => item.id === recoveredJob.preRestoreBackupId);
    assert.equal(safety?.status, 'success'); assert.equal(safety.restoreJobId, job.id);
    const state = await readState(dataDirectory), recovered = await api<Service>('GET', `/services/${target.id}`), runtime = await inspect(target);
    assert.deepEqual(state.restoreIntents, {});
    await assert.rejects(lstat(join(dataDirectory,'restore-work',job.id)),{code:'ENOENT'},'Reconciled jobs must release the pinned backup workspace after restart.');
    assert.equal(state.appliedServices[target.id].containerId, runtime.Id);
    assert.equal(recovered.containerId, runtime.Id);
    const expected = crashPoint === 'activated' ? intent.preparedService : originalMapping;
    assert.deepEqual(state.appliedServices[target.id].volumeOverrides || {}, expected.volumeOverrides || {});
    assert.equal(recovered.env.POSTGRES_PASSWORD, expected.env.POSTGRES_PASSWORD);
    assert.equal(state.appliedServices[target.id].env.POSTGRES_PASSWORD, expected.env.POSTGRES_PASSWORD);
    assert.equal(runtime.Mounts.find((mount: { Destination: string }) => mount.Destination === '/var/lib/postgresql/data').Name, expected.volumeOverrides?.data || `hl-${target.id}-data`);
    await ready(recovered);
    const expectedValue = crashPoint === 'activated' ? 'source-records' : 'target-records';
    assert.equal(await sql(recovered, 'SELECT value FROM recovery_proof'), expectedValue);
    await deploy(recovered); await ready(recovered);
    assert.equal(await sql(recovered, 'SELECT value FROM recovery_proof'), expectedValue, 'A later deployment must keep the recovered data volume and credentials.');
    const final = await readState(dataDirectory);
    assert.deepEqual(final.appliedServices[target.id].volumeOverrides || {}, expected.volumeOverrides || {});
    assert.equal(final.appliedServices[target.id].env.POSTGRES_PASSWORD, expected.env.POSTGRES_PASSWORD);
    assert.equal((await readFile(join(dataDirectory, 'state.enc'))).includes(Buffer.from(source.env.POSTGRES_PASSWORD)), false);
    console.log(`PASS: ${crashPoint} SIGKILL, durable checkpoint, authenticated SQL records, ${crashPoint === 'activated' ? 'activated volume reconciliation' : 'original-volume rollback'}, session persistence and redeploy data preservation.`);
  } finally {
    await stopServer(server);
    try { await cleanup(services, projectId); } finally { await rm(directory, { recursive: true, force: true }); }
  }
}

if (process.argv[2] === '--child') {
  assert.ok(process.argv[3], 'Missing child data directory.');
  await childServer(process.argv[3], process.argv[4]);
} else {
  // Check the local cache before starting any workloads; never download a different test image implicitly.
  const [cached] = JSON.parse(await command('docker', ['image', 'inspect', 'postgres:17-alpine']));
  const image = cached.RepoDigests?.find((digest: string) => digest.startsWith('postgres@'));
  assert.ok(image, 'Cache postgres:17-alpine explicitly before running this check.');
  await scenario('activated', image);
  await scenario('prepared', image);
  console.log('All real restore SIGKILL recovery checks passed.');
}
