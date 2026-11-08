import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertDomainOwnership, hostnamesOverlap } from '../domain-ownership.js';
import { createApp } from '../app.js';
import { DemoDriver } from '../docker.js';

test('host ownership matches proxy wildcard semantics and reserves panel names for every role', () => {
  assert.equal(hostnamesOverlap('*.example.com', 'app.example.com'), true);
  assert.equal(hostnamesOverlap('APP.EXAMPLE.COM.', '*.example.com'), true);
  assert.equal(hostnamesOverlap('*.example.com', 'example.com'), false);
  assert.equal(hostnamesOverlap('*.example.com', 'deep.app.example.com'), false);
  assert.equal(hostnamesOverlap('*.example.com', '*.app.example.com'), false);
  const candidate = { id: randomUUID(), projectId: randomUUID(), domains: [{ id: randomUUID(), hostname: '*.example.com', path: '/', port: 80, https: false }] };
  assert.throws(() => assertDomainOwnership(candidate, [], ['panel.example.com']), /reserved/);
  assert.throws(() => assertDomainOwnership({ ...candidate, domains: [{ ...candidate.domains[0], hostname: 'PANEL.EXAMPLE.COM' }] }, [], ['panel.example.com']), /reserved/);
});

test('operators cannot hijack other project hosts through paths or overlapping wildcards; panel host is reserved', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'harborlight-domain-owner-'));
  const previousPanelDomain = process.env.PANEL_DOMAIN;
  process.env.PANEL_DOMAIN = 'secondary.panel.test';
  const app = await createApp({ dataDir, mode: 'docker', driver: new DemoDriver(), publicUrl: 'https://control.example.test', cookieSecure: false });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); if (previousPanelDomain === undefined) delete process.env.PANEL_DOMAIN; else process.env.PANEL_DOMAIN = previousPanelDomain; });
  const call = (cookie: string, method: 'POST' | 'PATCH', path: string, payload: Record<string, unknown>) => app.inject({ method, url: `/api${path}`, headers: { cookie }, payload });
  const setup = await call('', 'POST', '/auth/setup', { name: 'owner', email: 'owner@example.test', password: 'owner-password-12345' });
  const ownerCookie = String(setup.headers['set-cookie']).split(';')[0];
  const a = (await call(ownerCookie, 'POST', '/projects', { name: 'alpha' })).json(), b = (await call(ownerCookie, 'POST', '/projects', { name: 'beta' })).json();
  const domain = (hostname: string, path = '/') => ({ hostname, path, https: false, port: 80 });
  const create = (projectId: string, name: string, hostname: string, path = '/') => call(ownerCookie, 'POST', '/services', { projectId, name, kind: 'app', domains: [domain(hostname, path)] });
  assert.equal((await create(a.id, 'victim', 'victim.example.test')).statusCode, 201);
  assert.equal((await create(a.id, 'path-multiplex', 'victim.example.test', '/api')).statusCode, 201);
  assert.equal((await call(ownerCookie, 'POST', '/users', { name: 'operator', email: 'operator@example.test', password: 'operator-password-12345', role: 'member', memberships: [{ projectId: b.id, role: 'operator' }] })).statusCode, 201);
  const login = await call('', 'POST', '/auth/login', { email: 'operator@example.test', password: 'operator-password-12345' }), operatorCookie = String(login.headers['set-cookie']).split(';')[0];
  const malicious = (hostname: string, path = '/') => call(operatorCookie, 'POST', '/services', { projectId: b.id, name: `attack-${randomUUID().slice(0, 8)}`, kind: 'app', domains: [domain(hostname, path)] });
  assert.equal((await malicious('victim.example.test', '/login')).statusCode, 409);
  assert.equal((await malicious('*.example.test')).statusCode, 409);
  assert.equal((await create(a.id, 'wildcard', '*.apps.example.test')).statusCode, 201);
  assert.equal((await malicious('steal.apps.example.test')).statusCode, 409);
  assert.equal((await malicious('*.apps.example.test', '/different')).statusCode, 409);
  const existing = (await create(b.id, 'existing', 'allowed.other.test')).json();
  assert.equal((await call(operatorCookie, 'PATCH', `/services/${existing.id}`, { domains: [domain('victim.example.test', '/signin')] })).statusCode, 409);
  for (const hostname of ['control.example.test', '*.example.test', 'secondary.panel.test', '*.panel.test']) {
    assert.equal((await malicious(hostname)).statusCode, 409, hostname);
    assert.equal((await create(a.id, `admin-${randomUUID().slice(0,8)}`, hostname)).statusCode, 409, `admin ${hostname}`);
  }
});
