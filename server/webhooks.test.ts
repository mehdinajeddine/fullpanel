import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { registerDeploymentWebhooks } from './webhooks.js';
import type { Deployment } from '../shared/types.js';

async function fixture() {
  const app = Fastify({ logger: false });
  await app.register(rateLimit, { global: false });
  const first = randomUUID(), second = randomUUID();
  const services = new Set<string>([first, second]);
  const hashes = new Map<string, string>();
  const calls: { id: string; trigger: string }[] = [];
  let busy = false;
  // Mirrors the host's boundary: only the precise trigger POST is public.
  app.addHook('onRequest', async request => {
    const isHook = request.method === 'POST' && /^\/api\/hooks\/deploy\/[a-f0-9-]{36}$/.test(request.url.split('?')[0]);
    if (!isHook && request.headers['x-test-session'] !== 'owner') throw Object.assign(new Error('Sign in to continue.'), { statusCode: 401 });
  });
  registerDeploymentWebhooks(app, {
    getService: id => services.has(id) ? { id } : undefined,
    getTokenHash: id => hashes.get(id),
    setTokenHash: (id, hash) => { if (hash) hashes.set(id, hash); else hashes.delete(id); },
    enqueueDeploy: (id, trigger) => {
      if (busy) throw Object.assign(new Error('This service already has an operation in progress.'), { statusCode: 409 });
      calls.push({ id, trigger });
      return { id: randomUUID(), serviceId: id, status: 'queued', trigger, createdAt: new Date().toISOString(), output: '' } satisfies Deployment;
    },
    publicUrl: 'https://panel.example.test'
  });
  await app.ready();
  const admin = { 'x-test-session': 'owner' };
  const rotate = async (id = first) => {
    const response = await app.inject({ method: 'POST', url: `/api/services/${id}/trigger/rotate`, headers: admin });
    assert.equal(response.statusCode, 200);
    return response.json<{ token: string; endpoint: string; enabled: boolean }>();
  };
  const trigger = (token?: string, id = first) => app.inject({ method: 'POST', url: `/api/hooks/deploy/${id}`, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { app, first, second, services, hashes, calls, admin, rotate, trigger, setBusy: (value: boolean) => { busy = value; } };
}

test('trigger management remains session-authenticated and starts disabled', async t => {
  const f = await fixture(); t.after(() => f.app.close());
  for (const [method, suffix] of [['GET', ''], ['POST', '/rotate'], ['DELETE', '']] as const) {
    assert.equal((await f.app.inject({ method, url: `/api/services/${f.first}/trigger${suffix}` })).statusCode, 401);
  }
  const status = await f.app.inject({ method: 'GET', url: `/api/services/${f.first}/trigger`, headers: f.admin });
  assert.equal(status.json().enabled, false);
  assert.equal(status.json().endpoint, `https://panel.example.test/api/hooks/deploy/${f.first}`);
  assert.equal(f.hashes.size, 0);
});

test('raw token is returned once, only its hash is persisted, and a valid call queues the intended service', async t => {
  const f = await fixture(); t.after(() => f.app.close());
  const generated = await f.rotate();
  assert.match(generated.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(f.hashes.get(f.first)!, /^[a-f0-9]{64}$/);
  assert.notEqual(f.hashes.get(f.first), generated.token);
  const status = await f.app.inject({ method: 'GET', url: `/api/services/${f.first}/trigger`, headers: f.admin });
  assert.equal(status.json().enabled, true);
  assert.equal(status.json().token, undefined);
  assert.ok(!status.body.includes(f.hashes.get(f.first)!));
  const queued = await f.trigger(generated.token);
  assert.equal(queued.statusCode, 202);
  assert.equal(queued.json().serviceId, f.first);
  assert.deepEqual(f.calls, [{ id: f.first, trigger: 'Webhook' }]);
  assert.ok(!queued.body.includes(generated.token));
});

test('rotation immediately invalidates the old token and tokens are service-scoped', async t => {
  const f = await fixture(); t.after(() => f.app.close());
  const old = await f.rotate(), next = await f.rotate();
  await f.rotate(f.second);
  assert.notEqual(old.token, next.token);
  assert.equal((await f.trigger(old.token)).statusCode, 401);
  assert.equal((await f.trigger(next.token, f.second)).statusCode, 401);
  assert.equal((await f.trigger(next.token)).statusCode, 202);
  assert.equal(f.calls.length, 1);
});

test('revocation and service deletion prevent deployment even if an orphaned hash remains', async t => {
  const f = await fixture(); t.after(() => f.app.close());
  const first = await f.rotate();
  const revoked = await f.app.inject({ method: 'DELETE', url: `/api/services/${f.first}/trigger`, headers: f.admin });
  assert.equal(revoked.statusCode, 200);
  assert.equal(revoked.json().enabled, false);
  assert.equal((await f.trigger(first.token)).statusCode, 401);
  const second = await f.rotate();
  f.services.delete(f.first);
  assert.equal((await f.trigger(second.token)).statusCode, 401);
  assert.equal((await f.app.inject({ method: 'GET', url: `/api/services/${f.first}/trigger`, headers: f.admin })).statusCode, 404);
  assert.equal(f.calls.length, 0);
});

test('query strings and payload fields are not accepted as credentials', async t => {
  const f = await fixture(); t.after(() => f.app.close());
  const { token } = await f.rotate();
  const query = await f.app.inject({ method: 'POST', url: `/api/hooks/deploy/${f.first}?token=${token}` });
  const body = await f.app.inject({ method: 'POST', url: `/api/hooks/deploy/${f.first}`, payload: { token } });
  assert.equal(query.statusCode, 401);
  assert.equal(body.statusCode, 401);
  assert.equal((await f.trigger()).statusCode, 401);
  assert.equal(f.calls.length, 0);
});

test('queue concurrency refusal propagates without creating another deployment', async t => {
  const f = await fixture(); t.after(() => f.app.close());
  const { token } = await f.rotate(); f.setBusy(true);
  const response = await f.trigger(token);
  assert.equal(response.statusCode, 409);
  assert.equal(f.calls.length, 0);
  f.setBusy(false);
  assert.equal((await f.trigger(token)).statusCode, 202);
});

test('invalid trigger attempts are rate-limited', async t => {
  const f = await fixture(); t.after(() => f.app.close());
  for (let i = 0; i < 20; i++) assert.equal((await f.trigger('a'.repeat(43))).statusCode, 401);
  assert.equal((await f.trigger('a'.repeat(43))).statusCode, 429);
  assert.equal(f.calls.length, 0);
});

test('unexpected methods are not public, malformed credentials do not crash, and body size is bounded', async t => {
  const f = await fixture(); t.after(() => f.app.close());
  const { token } = await f.rotate();
  assert.equal((await f.app.inject({ method: 'GET', url: `/api/hooks/deploy/${f.first}` })).statusCode, 401);
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/hooks/deploy/${f.first}`, headers: { authorization: `Bearer ${token}, Bearer ${token}` } })).statusCode, 401);
  const oversized = await f.app.inject({ method: 'POST', url: `/api/hooks/deploy/${f.first}`, headers: { authorization: `Bearer ${token}` }, payload: { data: 'x'.repeat(17000) } });
  assert.equal(oversized.statusCode, 413);
  assert.equal(f.calls.length, 0);
});
