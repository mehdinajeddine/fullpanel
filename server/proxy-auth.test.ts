import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { compare } from 'bcryptjs';
import { z } from 'zod';
import { registerProxyAuth } from './proxy-auth.js';
import { domainInput, proxyLabels } from './proxy-routing.js';
import type { ProxyAuthCredential } from '../shared/proxy.js';
import type { Service } from '../shared/types.js';

test('proxy credentials are hashed, never returned, rotatable and revocable', async t => {
  const app = Fastify();
  t.after(() => app.close());
  const serviceId = randomUUID(), domainId = randomUUID();
  const route = `/api/services/${serviceId}/domains/${domainId}/auth`;
  const service = { id: serviceId, kind: 'app', domains: [{ id: domainId }] } as Service;
  let credential: ProxyAuthCredential | undefined;
  let writes = 0;
  registerProxyAuth(app, {
    getService: id => id === serviceId ? service : undefined,
    authorize: request => { if (request.headers.authorization !== 'owner') throw Object.assign(new Error('Forbidden'), { statusCode: 403 }); },
    getAuth: () => credential,
    setAuth: (_id, _domain, next) => { credential = next || undefined; writes++; },
  });
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof z.ZodError ? 400 : (error as { statusCode?: number }).statusCode || 500).send({ error: 'Rejected' }));
  assert.equal((await app.inject({ method: 'GET', url: route })).statusCode, 403);
  const headers = { authorization: 'owner' };
  const secret = 'proxy-secret-first-password';
  const response = await app.inject({ method: 'PUT', url: route, headers, payload: { username: 'reader', password: secret } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { enabled: true, username: 'reader' });
  assert(credential);
  assert(await compare(secret, credential.passwordHash));
  assert(!JSON.stringify(credential).includes(secret));
  const previousHash = credential.passwordHash;
  assert.equal((await app.inject({ method: 'PUT', url: route, headers, payload: { username: 'reader', password: 'rotated-proxy-password' } })).statusCode, 200);
  assert.notEqual(credential!.passwordHash, previousHash);
  assert.equal(await compare(secret, credential!.passwordHash), false);
  assert.deepEqual((await app.inject({ method: 'GET', url: route, headers })).json(), { enabled: true, username: 'reader' });
  assert.equal((await app.inject({ method: 'PUT', url: route, headers, payload: { username: 'a:b', password: secret } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PUT', url: route, headers, payload: { username: 'reader', password: 'é'.repeat(40) } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PUT', url: route, headers, payload: { username: 'reader', password: secret, passwordHash: previousHash } })).statusCode, 400);
  assert.equal(writes, 2);
  assert.equal((await app.inject({ method: 'DELETE', url: route, headers })).statusCode, 200);
  assert.deepEqual((await app.inject({ method: 'GET', url: route, headers })).json(), { enabled: false });
  assert.equal(credential, undefined);
});

test('proxy credentials cannot be committed after authorization is revoked during hashing', async t => {
  const app = Fastify();
  t.after(() => app.close());
  const id = randomUUID(), domainId = randomUUID();
  let checks = 0, writes = 0;
  registerProxyAuth(app, {
    getService: () => ({ id, kind: 'app', domains: [{ id: domainId }] } as Service),
    authorize: () => { if (++checks > 1) throw Object.assign(new Error('Revoked'), { statusCode: 403 }); },
    getAuth: () => undefined,
    setAuth: () => { writes++; },
  });
  assert.equal((await app.inject({ method: 'PUT', url: `/api/services/${id}/domains/${domainId}/auth`, payload: { username: 'reader', password: 'long-enough-password' } })).statusCode, 403);
  assert.equal(writes, 0);
});

test('proxy route input rejects expression injection and unsupported certificate combinations', () => {
  const base = { id: randomUUID(), hostname: 'app.example.test', port: 80, https: false, path: '/' };
  for (const patch of [{ hostname: 'a.test`) || Host(`b.test' }, { path: '/a/../b' }, { path: '//a' }, { redirectToHttps: true }, { stripPrefix: true }, { hostname: '*.example.test', https: true }, { hostname: '*.example.test', primary: true }]) {
    assert.equal(domainInput.safeParse({ ...base, ...patch }).success, false);
  }
  assert.equal(domainInput.parse({ ...base, hostname: 'APP.EXAMPLE.TEST', path: '/api/' }).hostname, 'app.example.test');
  assert.equal(domainInput.parse({ ...base, path: '/api/' }).path, '/api');
});

test('routing uses bounded paths, verified upstream TLS, and isolates redirect middleware', () => {
  const id = randomUUID();
  const args = proxyLabels([{ id, hostname: 'app.example.test', port: 443, https: true, path: '/api', stripPrefix: true, redirectToHttps: true, upstreamScheme: 'https' }], randomUUID());
  const labels = args.filter((_value, index) => index % 2 === 1);
  assert(labels.some(value => value.endsWith('Host(`app.example.test`) && (Path(`/api`) || PathPrefix(`/api/`))')));
  assert(labels.some(value => value.endsWith('.loadbalancer.server.scheme=https')));
  assert(!labels.some(value => /insecureskipverify/i.test(value)));
  assert(labels.some(value => value.endsWith('-redirect.service=noop@internal')));
  assert(!labels.some(value => value.includes('websecure,web')));
});
