/** Real service-scoped measurements. Every mutated Docker resource belongs to this invocation. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InjectOptions } from 'fastify';
import { createApp } from '../server/app.js';
import { command, DockerDriver } from '../server/docker.js';
import { collectDockerServiceMetrics } from '../server/docker-metrics.js';
import type { Deployment, Service } from '../shared/types.js';
import type { ServiceMetrics } from '../shared/metrics.js';

const fixtureId = randomUUID();
const directory = await mkdtemp(join(tmpdir(), 'fullpanel-service-metrics-'));
const driver = new DockerDriver(directory);
const app = await createApp({ dataDir: directory, mode: 'docker', driver, staticDir: join(directory, 'no-static') });
const services: Service[] = [];
const helpers: string[] = [];
let cookie = '', projectId = '';

async function api(method: InjectOptions['method'], path: string, payload?: object) {
  const result = await app.inject({ method, url: `/api${path}`, headers: { cookie }, ...(payload ? { payload } : {}) });
  assert(result.statusCode >= 200 && result.statusCode < 300, `${method} ${path}: ${result.statusCode} ${result.body}`);
  if (result.headers['set-cookie']) cookie = String(result.headers['set-cookie']).split(';')[0];
  return result.json();
}
async function create(name: string, fields: object = {}) {
  const service: Service = await api('POST', '/services', { projectId, name, kind: 'app', source: { type: 'image', image: 'nginx:1.28-alpine' }, resources: { cpu: 0.25, memoryMb: 128 }, domains: [], ...fields });
  services.push(service);
  return service;
}
async function deploy(service: Service) {
  const job: Deployment = await api('POST', `/services/${service.id}/deploy`, {});
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const current: Deployment = await api('GET', `/deployments/${job.id}`);
    if (current.status === 'failed') throw new Error(`Deployment failed: ${current.output}`);
    if (current.status === 'success') return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Metrics fixture deployment timed out.');
}
async function eventually(check: () => Promise<void>, milliseconds = 40000) {
  const deadline = Date.now() + milliseconds;
  let last: unknown;
  while (Date.now() < deadline) {
    try { await check(); return; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw last;
}
async function inspect(kind: 'container' | 'network', name: string) {
  try { return JSON.parse(await command('docker', [kind, 'inspect', name]))[0]; }
  catch (error) { if (/No such|not found/.test(String(error))) return undefined; throw error; }
}
async function metrics(service: Service): Promise<ServiceMetrics> { return api('GET', `/services/${service.id}/metrics`); }
function noNumbers(sample: ServiceMetrics) {
  assert(Object.values(sample.totals).every(value => value === null), 'Missing metrics must not become zeros.');
  assert.equal(sample.sampledAt, null);
}
async function helper(name: string, labels: string[] = [], network?: string) {
  helpers.push(name);
  await command('docker', ['run', '-d', '--name', name, '--label', `io.harborlight.test=${fixtureId}`, ...labels.flatMap(label => ['--label', label]), ...(network ? ['--network', network] : []), 'nginx:1.28-alpine']);
  return name;
}

try {
  console.log('Docker runtime:', (await command('docker', ['info', '--format', '{{.ServerVersion}} / {{.OSType}} / {{.Architecture}}'])).trim());
  await api('POST', '/auth/setup', { name: 'Metrics QA', email: 'metrics@example.test', password: randomUUID() });
  projectId = (await api('POST', '/projects', { name: 'service-metrics-proof' })).id;
  const web = await create('measured-web');
  const initial = await metrics(web);
  assert.equal(initial.state, 'not-deployed'); noNumbers(initial);
  await deploy(web);
  const runtime = await inspect('container', `hl-${web.id}`);
  assert.equal(runtime.Config.Labels['io.harborlight.project'], projectId);
  assert.equal(runtime.HostConfig.Memory, 128 * 1024 ** 2);
  const ownedLabels = [`io.harborlight.managed=true`, `io.harborlight.service=${web.id}`, `io.harborlight.project=${projectId}`];
  await helper(`hl-metrics-previous-${fixtureId}`, ownedLabels);
  const peer = await helper(`hl-metrics-peer-${fixtureId}`, [], `hl-project-${projectId}`);
  let first!: ServiceMetrics;
  await eventually(async () => {
    first = await metrics(web);
    assert.equal(first.state, 'available', JSON.stringify(first));
    assert.equal(first.mode, 'docker');
    assert.equal(first.serviceId, web.id);
    assert.deepEqual(first.containers.map(item => item.id), [runtime.Id]);
    assert.equal(first.totals.memoryLimitBytes, runtime.HostConfig.Memory);
    assert(first.totals.memoryUsedBytes! > 0);
    assert(first.totals.cpuPercent! >= 0);
    assert(first.totals.networkRxBytes! >= 0 && first.totals.networkTxBytes! >= 0);
    assert(first.sampledAt && Date.now() - Date.parse(first.sampledAt) < 15000);
  });
  const repeated = await metrics(web);
  assert.equal(repeated.sampledAt, first.sampledAt, 'Cached data must retain its original collection time.');
  await command('docker', ['exec', runtime.Id, 'sh', '-c', 'dd if=/dev/zero of=/usr/share/nginx/html/metrics-proof.bin bs=1048576 count=16 2>/dev/null']);
  await command('docker', ['exec', peer, 'wget', '-qO', '/dev/null', `http://${web.name}/metrics-proof.bin`]);
  // A short, bounded CPU workload inside the disposable 0.25-CPU service.
  await command('docker', ['exec', '-d', runtime.Id, 'sh', '-c', 'timeout 20 sh -c "while :; do :; done"']);
  let loaded!: ServiceMetrics;
  await eventually(async () => {
    loaded = await metrics(web);
    assert.equal(loaded.state, 'available');
    assert.notEqual(loaded.sampledAt, first.sampledAt);
    assert(loaded.totals.cpuPercent! > 0, 'Bounded CPU workload was not measured.');
    assert(loaded.totals.networkTxBytes! - first.totals.networkTxBytes! > 15 * 1024 ** 2, 'Network transmission did not reflect the private 16 MiB download.');
    assert(loaded.totals.networkRxBytes! > first.totals.networkRxBytes!);
  });
  console.log('PASS: measured service only; known 128 MiB limit, real memory, CPU load and >15 MiB network growth; cache timestamp preserved.');
  console.log(JSON.stringify({ cpuPercent: loaded.totals.cpuPercent, memoryUsedBytes: loaded.totals.memoryUsedBytes, networkTxBytes: loaded.totals.networkTxBytes, sampledAt: loaded.sampledAt }));

  // Exercise actual CLI failure without stopping or reconfiguring the shared Docker daemon.
  const disconnectedEnv = { ...process.env };
  delete disconnectedEnv.DOCKER_CONTEXT;
  delete disconnectedEnv.DOCKER_TLS_VERIFY;
  delete disconnectedEnv.DOCKER_CERT_PATH;
  const disconnected = await collectDockerServiceMetrics(web, (binary, args, options) => command(binary, ['--host', `unix://${join(directory, 'missing-docker.sock')}`, ...args], { ...options, env: disconnectedEnv }));
  assert.equal(disconnected.state, 'unavailable'); noNumbers(disconnected);
  assert(!JSON.stringify(disconnected).includes(directory), 'Docker connection details must not leak in metrics responses.');
  console.log('PASS: actual Docker CLI connection failure returns unavailable/null, without exposing raw connection errors.');

  await api('POST', `/services/${web.id}/stop`, {});
  await eventually(async () => { const value = await metrics(web); assert.equal(value.state, 'stopped'); noNumbers(value); });
  await api('POST', `/services/${web.id}/start`, {});
  await eventually(async () => { assert.equal((await metrics(web)).state, 'available'); });
  await deploy(web);
  const replacement = await inspect('container', `hl-${web.id}`);
  assert.notEqual(replacement.Id, runtime.Id);
  await eventually(async () => {
    const value = await metrics(web);
    assert.equal(value.state, 'available');
    assert.deepEqual(value.containers.map(item => item.id), [replacement.Id]);
    assert.equal(value.containers[0].runtimeStartedAt, replacement.State.StartedAt);
    assert(value.totals.networkTxBytes! < loaded.totals.networkTxBytes!, 'Replacement must expose its own counters, not previous-container totals.');
  });
  console.log('PASS: stop reports absent measurements; start recovers; redeploy selects the new runtime and resets its counters.');

  const stack = await create('measured-stack', { kind: 'compose', source: { type: 'compose', compose: 'services:\n  first:\n    image: nginx:1.28-alpine\n  second:\n    image: nginx:1.28-alpine\n' } });
  await deploy(stack);
  const memberIds = (await command('docker', ['ps', '-q', '--no-trunc', '--filter', `label=com.docker.compose.project=hl-${stack.id}`])).trim().split('\n').sort();
  assert.equal(memberIds.length, 2);
  await helper(`hl-metrics-oneoff-${fixtureId}`, ['io.harborlight.managed=true', `io.harborlight.service=${stack.id}`, `io.harborlight.project=${projectId}`, `com.docker.compose.project=hl-${stack.id}`, 'com.docker.compose.service=first', 'com.docker.compose.oneoff=True']);
  await eventually(async () => {
    const value = await metrics(stack);
    assert.equal(value.state, 'available', JSON.stringify(value));
    assert.deepEqual(value.containers.map(item => item.id).sort(), memberIds);
    assert.equal(value.totals.memoryUsedBytes, value.containers.reduce((sum, item) => sum + item.memoryUsedBytes!, 0));
    assert.equal(value.totals.networkTxBytes, value.containers.reduce((sum, item) => sum + item.networkTxBytes!, 0));
  });
  await command('docker', ['stop', '--time', '2', memberIds[0]]);
  await eventually(async () => {
    const value = await metrics(stack);
    assert.equal(value.state, 'partial');
    assert.equal(value.containers.filter(item => item.state === 'running').length, 1);
    assert.equal(value.totals.memoryUsedBytes, null, 'Partial totals must not imply a complete service sample.');
  });
  console.log('PASS: Compose aggregates exact active members, excludes one-off and unrelated containers, and reports a partially stopped stack.');
  const image = JSON.parse(await command('docker', ['image', 'inspect', 'nginx:1.28-alpine']))[0];
  console.log('Fixture image:', image.Id, JSON.stringify(image.RepoDigests));
} finally {
  const failures: unknown[] = [];
  async function cleanup(action: () => Promise<unknown>) { try { await action(); } catch (error) { failures.push(error); } }
  await cleanup(() => app.close());
  for (const name of helpers) await cleanup(async () => {
    const container = await inspect('container', name);
    if (container) { assert.equal(container.Config.Labels['io.harborlight.test'], fixtureId); await command('docker', ['rm', '-f', container.Id]); }
  });
  for (const service of services) await cleanup(() => driver.remove(service));
  if (projectId) await cleanup(async () => {
    const network = await inspect('network', `hl-project-${projectId}`);
    if (network) { assert.equal(network.Labels['io.harborlight.managed'], 'true'); assert.equal(network.Labels['io.harborlight.project'], projectId); await command('docker', ['network', 'rm', network.Id]); }
  });
  await cleanup(() => rm(directory, { recursive: true, force: true }));
  if (failures.length) throw new AggregateError(failures, 'Service metrics fixture cleanup failed.');
  console.log('PASS: exact fixture containers and networks cleaned up.');
}
