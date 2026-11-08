import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { milestoneFixture, MilestoneDriver, until } from './milestone-fixture.js';
import { ServiceMetricsCache } from '../service-metrics.js';
import { emptyMetricValues } from '../docker-metrics.js';
import { DemoDriver } from '../docker.js';
import type { Service } from '../../shared/types.js';
import type { ServiceMetrics } from '../../shared/metrics.js';

const sampledAt = '2026-11-08T12:00:00.000Z';
function result(service: Service): ServiceMetrics { return { mode: 'docker', serviceId: service.id, state: 'available', sampledAt, checkedAt: sampledAt, containers: [{ id: 'a'.repeat(64), name: `hl-${service.id}`, state: 'running', runtimeStartedAt: sampledAt, sampledAt, cpuPercent: 125, memoryUsedBytes: 4096, memoryLimitBytes: 134217728, networkRxBytes: 100, networkTxBytes: 200 }], totals: { cpuPercent: 125, memoryUsedBytes: 4096, memoryLimitBytes: 134217728, networkRxBytes: 100, networkTxBytes: 200 } }; }
class MetricsDriver extends MilestoneDriver {
  calls: string[] = [];
  override async serviceMetrics(service: Service) { this.calls.push(service.id); await this.gate; if (this.failure) throw Error(this.failure); return result(service); }
}
function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

test('service metrics authorize viewers and scoped read keys without exposing another project', async t => {
  const driver = new MetricsDriver(), f = await milestoneFixture({ driver }); t.after(f.close);
  const service = await f.create(), other = await f.create({ projectId: f.otherProject.id, name: 'other' });
  const viewer = await f.user('metrics-viewer', 'viewer');
  const key = (await f.request('POST', '/api-keys', { name: 'metrics-read', projectIds: [f.project.id], permission: 'read' }, viewer.cookie)).json();
  for (const credential of [viewer.cookie, key.token]) {
    const response = await f.request('GET', `/services/${service.id}/metrics`, undefined, credential);
    assert.equal(response.statusCode, 200, response.body); assert.deepEqual(response.json(), result(service));
    assert.equal((await f.request('GET', `/services/${other.id}/metrics`, undefined, credential)).statusCode, 404);
  }
  assert.equal((await f.request('GET', `/services/${service.id}/metrics`, undefined, '')).statusCode, 401);
  assert.deepEqual(driver.calls, [service.id]);
});

test('service metrics recheck browser and key revocation after asynchronous collection', async t => {
  for (const usingKey of [false, true]) {
    const driver = new MetricsDriver(), gate = deferred(); driver.gate = gate.promise;
    const f = await milestoneFixture({ driver }); t.after(f.close);
    const service = await f.create(), viewer = await f.user(`metrics-${usingKey}`, 'viewer');
    const key = usingKey ? (await f.request('POST', '/api-keys', { name: 'pending-metrics', projectIds: [f.project.id], permission: 'read' }, viewer.cookie)).json() : undefined;
    const pending = f.request('GET', `/services/${service.id}/metrics`, undefined, key?.token || viewer.cookie).then(response => response);
    try {
      await until(async () => driver.calls.length ? true : undefined);
      if (key) assert.equal((await f.request('DELETE', `/api-keys/${key.id}`, undefined, viewer.cookie)).statusCode, 200);
      else assert.equal((await f.request('PATCH', `/users/${viewer.user.id}`, { memberships: [] })).statusCode, 200);
    } finally { gate.release(); }
    const response = await pending;
    assert.equal(response.statusCode, 401, response.body); assert(!response.body.includes('memoryUsedBytes'));
  }
});

test('service metrics failures are safe, lifecycle invalidates cache and demo never invents samples', async t => {
  const driver = new MetricsDriver(), f = await milestoneFixture({ driver }); t.after(f.close);
  const service = await f.create(); await f.deploy(service);
  assert.equal((await f.request('GET', `/services/${service.id}/metrics`)).json().state, 'available');
  assert.equal((await f.request('POST', `/services/${service.id}/stop`)).statusCode, 200);
  driver.failure = 'raw Docker error with private-host-and-secret';
  const unavailable = await f.request('GET', `/services/${service.id}/metrics`);
  assert.equal(unavailable.statusCode, 200); assert.equal(unavailable.json().state, 'unavailable'); assert.equal(unavailable.json().sampledAt, null); assert.deepEqual(unavailable.json().totals, emptyMetricValues()); assert(!unavailable.body.includes('private-host'));
  assert.equal(driver.calls.length, 2);
  for (const status of ['stopped', 'running', 'not-deployed'] as const) {
    const demo = await new DemoDriver().serviceMetrics({ ...service, status });
    assert.equal(demo.mode, 'demo'); assert.equal(demo.sampledAt, null); assert.deepEqual(demo.totals, emptyMetricValues());
    assert.equal(demo.state, status === 'running' ? 'unavailable' : status);
  }
});

test('service metric cache coalesces work, preserves sample age, expires and bounds stored results', async () => {
  let now = 1000, calls = 0; const gate = deferred();
  const service = { id: randomUUID(), projectId: randomUUID(), kind: 'app', status: 'running' } as Service;
  const cache = new ServiceMetricsCache(async s => { calls++; await gate.promise; return result(s); }, 'docker', () => now, 100, 2);
  const first = cache.get(service), second = cache.get(service); await Promise.resolve(); assert.equal(calls, 1); gate.release();
  assert.deepEqual(await first, await second); now += 50; assert.equal((await cache.get(service)).sampledAt, sampledAt); assert.equal(calls, 1);
  now += 51; await cache.get(service); assert.equal(calls, 2);
  await cache.get({ ...service, id: randomUUID() }); await cache.get({ ...service, id: randomUUID() });
  await cache.get(service); assert.equal(calls, 5, 'Oldest entry is evicted when the cache reaches capacity.');
});

test('metric cache bounds in-flight work and invalidation cannot resurrect old samples', async () => {
  const gate = deferred(); let calls = 0;
  const service = { id: randomUUID(), projectId: randomUUID(), kind: 'app', status: 'running' } as Service;
  const cache = new ServiceMetricsCache(async s => { calls++; await gate.promise; return result(s); }, 'docker', Date.now, 5000, 2, 1);
  const pending = cache.get(service); await Promise.resolve(); cache.invalidate(service.id);
  assert.equal((await cache.get({ ...service, id: randomUUID() })).state, 'unavailable');
  gate.release(); assert.equal((await pending).state, 'unavailable'); await cache.get(service); assert.equal(calls, 2);
  cache.clear(); await cache.get(service); assert.equal(calls, 3);
  assert.equal((await new ServiceMetricsCache(undefined, 'docker').get(service)).state, 'unavailable');
});
