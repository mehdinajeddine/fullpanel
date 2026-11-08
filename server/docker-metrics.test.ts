import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Service } from '../shared/types.js';
import { collectDockerServiceMetrics, parseDockerBytes, parseDockerPercent, parseDockerStats } from './docker-metrics.js';

const time = '2026-11-08T12:00:00.000Z';
function service(kind: Service['kind'] = 'app'): Service { return { id: randomUUID(), projectId: randomUUID(), name: 'metrics', kind, status: 'running', source: kind === 'compose' ? { type: 'compose', compose: 'services:\n  web:\n    image: nginx\n  worker:\n    image: nginx\n' } : { type: 'image', image: 'nginx' }, env: {}, domains: [], mounts: [], ports: [], resources: { cpu: 0, memoryMb: 128 }, notes: '', createdAt: time, updatedAt: time }; }
function container(s: Service, digit = 'a', child?: string, status = 'running') {
  return { Id: digit.repeat(64), Name: child ? `/hl-${s.id}-${child}-1` : `/hl-${s.id}`, Config: { Labels: { 'io.harborlight.managed': 'true', 'io.harborlight.service': s.id, 'io.harborlight.project': s.projectId, ...(child ? { 'com.docker.compose.project': `hl-${s.id}`, 'com.docker.compose.service': child, 'com.docker.compose.container-number': '1', 'com.docker.compose.oneoff': 'False' } : {}) } as Record<string, string> }, State: { Status: status, StartedAt: time } };
}
function stats(id: string) { return { ID: id, CPUPerc: '234.50%', MemUsage: '12.5MiB / 128MiB', NetIO: '1.2MB / 3kB' }; }
function runner(records: ReturnType<typeof container>[], rows = records.map(c => stats(c.Id)), after?: ReturnType<typeof container>[]) {
  const calls: string[][] = []; let inspections = 0;
  const run = async (_binary: string, args: string[]) => {
    calls.push(args);
    if (args[0] === 'ps') return records.map(c => c.Id).join('\n');
    if (args[0] === 'stats') return rows.map(row => JSON.stringify(row)).join('\n');
    if (args[0] === 'container') { const values = inspections++ && after ? after : records; if (!values.length) throw Error('No such container: missing'); return values.map(row => JSON.stringify(row)).join('\n'); }
    throw Error('Unexpected fixture command');
  };
  return { run, calls };
}

test('Docker metric parsing preserves multi-core CPU, binary memory and decimal cumulative network units', () => {
  assert.equal(parseDockerBytes('12.5MiB'), 13107200); assert.equal(parseDockerBytes('1.2 MB'), 1200000); assert.equal(parseDockerBytes('0B'), 0);
  assert.equal(parseDockerPercent('234.50%'), 234.5); assert.equal(parseDockerPercent('0.00%'), 0);
  for (const value of ['', '--', 'NaN', '-1B', 'InfinityB', '8XB', '1e3B', '100000PB', undefined]) assert.equal(parseDockerBytes(value), null);
  for (const value of ['', '--', '-1%', 'NaN%', '12%extra', undefined]) assert.equal(parseDockerPercent(value), null);
  assert.deepEqual(parseDockerStats({ CPUPerc: '--', MemUsage: '0B / 0B', NetIO: '--' }), { cpuPercent: null, memoryUsedBytes: 0, memoryLimitBytes: null, networkRxBytes: null, networkTxBytes: null });
});

test('single service metrics use only exact canonical ownership, retain collection time and never clamp CPU', async () => {
  const s = service(), c = container(s), f = runner([c], [stats(c.Id), stats('f'.repeat(64))]);
  const result = await collectDockerServiceMetrics(s, f.run, () => time);
  assert.equal(result.state, 'available'); assert.equal(result.sampledAt, time); assert.equal(result.checkedAt, time);
  assert.equal(result.containers[0].runtimeStartedAt, time); assert.equal(result.totals.cpuPercent, 234.5);
  assert.equal(result.totals.memoryUsedBytes, 13107200); assert.equal(result.totals.memoryLimitBytes, 134217728); assert.equal(result.totals.networkRxBytes, 1200000); assert.equal(result.totals.networkTxBytes, 3000);
  assert.deepEqual(f.calls.find(args => args[0] === 'stats')?.slice(-1), [c.Id]);
  assert(!JSON.stringify(result).includes('f'.repeat(64)));
  for (const label of ['io.harborlight.managed', 'io.harborlight.service', 'io.harborlight.project']) {
    const invalid = structuredClone(c); invalid.Config.Labels[label] = 'foreign-secret';
    const refused = await collectDockerServiceMetrics(s, runner([invalid]).run, () => time);
    assert.equal(refused.state, 'unavailable'); assert.deepEqual(refused.containers, []); assert(!JSON.stringify(refused).includes('foreign-secret'));
  }
});

test('Compose metrics exclude candidate, previous, oneoff and unrelated containers before requesting stats', async () => {
  const s = service('compose'), web = container(s, 'a', 'web'), worker = container(s, 'b', 'worker');
  const candidate = container(s, 'c', 'web'); candidate.Name += '-candidate';
  const previous = container(s, 'd', 'worker'); previous.Name += '-previous';
  const oneoff = container(s, 'e', 'web'); oneoff.Config.Labels['com.docker.compose.oneoff'] = 'True';
  const external = container(s, 'f', 'worker'); external.Name = '/foreign'; external.Config.Labels['io.harborlight.project'] = randomUUID();
  const f = runner([web, worker, candidate, previous, oneoff, external]);
  const result = await collectDockerServiceMetrics(s, f.run, () => time);
  assert.equal(result.state, 'available'); assert.equal(result.totals.cpuPercent, 469);
  assert.deepEqual(result.containers.map(c => c.id), [web.Id, worker.Id]);
  assert.deepEqual(f.calls.find(args => args[0] === 'stats')?.slice(-2), [web.Id, worker.Id]);
});

test('missing or ownership-inconsistent Compose members produce partial data without misleading aggregate totals', async () => {
  const s = service('compose'), web = container(s, 'a', 'web'), invalid = container(s, 'b', 'worker');
  invalid.Config.Labels['io.harborlight.project'] = randomUUID();
  for (const records of [[web], [web, invalid]]) {
    const result = await collectDockerServiceMetrics(s, runner(records).run, () => time);
    assert.equal(result.state, 'partial'); assert.equal(result.containers.length, 1); assert.equal(result.containers[0].cpuPercent, 234.5);
    assert.equal(result.totals.cpuPercent, null); assert.equal(result.totals.networkRxBytes, null);
    assert(!JSON.stringify(result).includes(invalid.Id));
  }
});

test('stopped, never deployed and disappeared runtimes have no synthetic zero samples', async () => {
  const s = service(), f = runner([container(s, 'a', undefined, 'exited')]);
  const stopped = await collectDockerServiceMetrics(s, f.run, () => time);
  assert.equal(stopped.state, 'stopped'); assert.equal(stopped.sampledAt, null); assert.equal(stopped.totals.cpuPercent, null); assert(!f.calls.some(args => args[0] === 'stats'));
  assert.equal((await collectDockerServiceMetrics(s, runner([]).run, () => time)).state, 'not-deployed');
  assert.equal((await collectDockerServiceMetrics({ ...s, deployedAt: time }, runner([]).run, () => time)).state, 'unavailable');
  assert.equal((await collectDockerServiceMetrics({ ...s, containerId: 'a'.repeat(64) }, runner([]).run, () => time)).state, 'unavailable');
});

test('partial stats, malformed counters and Docker failures retain null and never expose stderr', async () => {
  const s = service('compose'), web = container(s, 'a', 'web'), worker = container(s, 'b', 'worker');
  const partial = await collectDockerServiceMetrics(s, runner([web, worker], [stats(web.Id)]).run, () => time);
  assert.equal(partial.state, 'partial'); assert.equal(partial.totals.cpuPercent, null); assert.equal(partial.containers[1].sampledAt, null);
  const f = runner([web, worker]);
  const failed = await collectDockerServiceMetrics(s, async (binary, args) => { if (args[0] === 'stats') throw Error('Docker daemon secret-host-id password'); return f.run(binary, args); }, () => time);
  assert.equal(failed.state, 'unavailable'); assert.equal(failed.sampledAt, null); assert.equal(failed.totals.memoryUsedBytes, null); assert(!JSON.stringify(failed).includes('password'));
  const malformed = await collectDockerServiceMetrics(service(), async () => '{invalid', () => time);
  assert.equal(malformed.state, 'unavailable'); assert.equal(malformed.sampledAt, null);
});

test('a restart or canonical-name replacement during sampling invalidates the old runtime counters', async () => {
  const s = service(), c = container(s);
  for (const replacement of [{ ...c, State: { ...c.State, StartedAt: '2026-11-08T12:00:01Z' } }, { ...c, Name: `${c.Name}-previous` }, { ...c, State: { ...c.State, Status: 'exited' } }]) {
    const result = await collectDockerServiceMetrics(s, runner([c], [stats(c.Id)], [replacement]).run, () => time);
    assert.equal(result.sampledAt, null); assert.equal(result.totals.cpuPercent, null);
    assert.notEqual(result.state, 'available');
  }
});
