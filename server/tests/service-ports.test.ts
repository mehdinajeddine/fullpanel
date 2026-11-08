import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { milestoneFixture, MilestoneDriver, until } from './milestone-fixture.js';
import { ServicePortsCache } from '../service-ports.js';
import { DemoDriver } from '../docker.js';
import type { Service } from '../../shared/types.js';
import type { ServicePorts } from '../../shared/ports.js';

const time = '2026-11-08T12:00:00.000Z';
function result(service: Service): ServicePorts { return { mode: 'docker', serviceId: service.id, state: 'available', sampledAt: time, checkedAt: time, listeners: [{ port: 3000, protocol: 'tcp', family: 'ipv4', address: '0.0.0.0', scope: 'wildcard' }], exposed: [{ port: 80, protocol: 'tcp' }] }; }
class PortsDriver extends MilestoneDriver { calls: string[] = []; override async servicePorts(service: Service) { this.calls.push(service.id); await this.gate; if (this.failure) throw Error(this.failure); return result(service); } }
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

test('port inspection allows project viewers and scoped read keys, hides other services and never edits desired configuration', async t => {
  const driver = new PortsDriver(), f = await milestoneFixture({ driver }); t.after(f.close);
  const s = await f.create(), other = await f.create({ projectId: f.otherProject.id, name: 'foreign' }), viewer = await f.user('port-viewer', 'viewer');
  const key = (await f.request('POST', '/api-keys', { name: 'read-ports', permission: 'read', projectIds: [f.project.id] }, viewer.cookie)).json();
  for (const credential of [viewer.cookie, key.token]) {
    const response = await f.request('GET', `/services/${s.id}/ports`, undefined, credential);
    assert.equal(response.statusCode, 200); assert.deepEqual(response.json(), result(s));
    assert.equal((await f.request('GET', `/services/${other.id}/ports`, undefined, credential)).statusCode, 404);
  }
  assert.equal((await f.request('GET', `/services/${s.id}/ports`, undefined, '')).statusCode, 401);
  const after = (await f.request('GET', `/services/${s.id}`)).json();
  assert.deepEqual(after.domains, s.domains); assert.deepEqual(after.ports, s.ports); assert.equal(after.updatedAt, s.updatedAt); assert.deepEqual(driver.calls, [s.id]);
});

test('port responses recheck session and API-key revocation after the asynchronous runtime read', async t => {
  for (const keyAuth of [false, true]) {
    const driver = new PortsDriver(), blocked = gate(); driver.gate = blocked.promise;
    const f = await milestoneFixture({ driver }); t.after(f.close);
    const s = await f.create(), viewer = await f.user(`port-revoke-${keyAuth}`, 'viewer');
    const key = keyAuth ? (await f.request('POST', '/api-keys', { name: 'pending-ports', permission: 'read', projectIds: [f.project.id] }, viewer.cookie)).json() : undefined;
    const pending = f.request('GET', `/services/${s.id}/ports`, undefined, key?.token || viewer.cookie).then(value => value);
    try {
      await until(async () => driver.calls.length ? true : undefined);
      if (key) assert.equal((await f.request('DELETE', `/api-keys/${key.id}`, undefined, viewer.cookie)).statusCode, 200);
      else assert.equal((await f.request('PATCH', `/users/${viewer.user.id}`, { memberships: [] })).statusCode, 200);
    } finally { blocked.release(); }
    const response = await pending; assert.equal(response.statusCode, 401); assert(!response.body.includes('listeners'));
  }
});

test('port cache is invalidated by lifecycle mutations and suppresses raw errors; demo has no simulated listeners', async t => {
  const driver = new PortsDriver(), f = await milestoneFixture({ driver }); t.after(f.close);
  const s = await f.create(); await f.deploy(s);
  assert.equal((await f.request('GET', `/services/${s.id}/ports`)).json().state, 'available');
  await f.request('POST', `/services/${s.id}/stop`); driver.failure = 'secret host connection error';
  const response = await f.request('GET', `/services/${s.id}/ports`);
  assert.equal(response.statusCode, 200); assert.equal(response.json().state, 'unavailable'); assert.equal(response.json().sampledAt, null); assert.deepEqual(response.json().listeners, []); assert(!response.body.includes('secret host')); assert.equal(driver.calls.length, 2);
  const demo = await new DemoDriver().servicePorts(s); assert.equal(demo.mode, 'demo'); assert.equal(demo.state, 'unavailable'); assert.deepEqual(demo.listeners, []); assert.deepEqual(demo.exposed, []);
});

test('port cache bounds concurrency and capacity, retains real sample age and never resurrects invalidated results', async () => {
  const blocked = gate(), s = { id: randomUUID(), projectId: randomUUID(), kind: 'app', status: 'running' } as Service;
  let calls = 0, now = 1000;
  const cache = new ServicePortsCache(async service => { calls++; await blocked.promise; return result(service); }, 'docker', () => now, 100, 2, 1);
  const first = cache.get(s), second = cache.get(s);
  try { await Promise.resolve(); assert.equal(calls, 1); assert.equal((await cache.get({ ...s, id: randomUUID() })).state, 'unavailable'); }
  finally { blocked.release(); }
  assert.deepEqual(await first, await second); now += 50; assert.equal((await cache.get(s)).sampledAt, time); assert.equal(calls, 1);
  now += 51; await cache.get(s); assert.equal(calls, 2);
  await cache.get({ ...s, id: randomUUID() }); await cache.get({ ...s, id: randomUUID() }); await cache.get(s); assert.equal(calls, 5);
  cache.clear(); await cache.get(s); assert.equal(calls, 6);
  const next = gate(), pendingCache = new ServicePortsCache(async service => { await next.promise; return result(service); }, 'docker');
  const pending = pendingCache.get(s); pendingCache.invalidate(s.id); next.release(); assert.equal((await pending).state, 'unavailable');
  assert.equal((await new ServicePortsCache(undefined, 'docker').get(s)).state, 'unavailable');
});
