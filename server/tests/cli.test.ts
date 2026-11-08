import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.js';
// The command is directly runnable JavaScript; keeping it dependency-free also serves installers.
// @ts-expect-error CLI intentionally has no compilation step
import { runCli } from '../../scripts/harborlight.mjs';

test('CLI uses scoped credentials against real API authorization, deployment and revocation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'harborlight-cli-test-'));
  const app = await createApp({ dataDir: directory, mode: 'demo' });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { name: 'Owner', email: 'owner@example.test', password: 'long-cli-test-password' } });
  const cookie = setup.cookies[0].name + '=' + setup.cookies[0].value;
  const project = (await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: { name: 'cli-project' } })).json();
  const service = (await app.inject({ method: 'POST', url: '/api/services', headers: { cookie }, payload: { projectId: project.id, name: 'cli-web', kind: 'app' } })).json();
  const created = await app.inject({ method: 'POST', url: '/api/api-keys', headers: { cookie }, payload: { name: 'CLI deploy', projectIds: [project.id], permission: 'write' } });
  assert.equal(created.statusCode, 201);
  const key = created.json();
  const transport = async (url: URL, options: RequestInit) => {
    assert.equal(url.origin, 'http://panel.test');
    assert.equal(options.redirect, 'error', 'Never forward credentials to a redirected endpoint');
    assert(!url.href.includes(key.token));
    const reply = await app.inject({ method: options.method as 'GET' | 'POST', url: url.pathname + url.search, headers: options.headers as Record<string, string>, ...(options.body ? { payload: options.body as string } : {}) });
    return new Response(reply.body, { status: reply.statusCode, headers: { 'Content-Type': 'application/json' } });
  };
  const environment = { HARBORLIGHT_URL: 'http://panel.test', HARBORLIGHT_API_KEY: key.token };
  assert.deepEqual((await runCli(['projects'], environment, transport)).map((item: { id: string }) => item.id), [project.id]);
  const deployment = await runCli(['deploy', service.id, '--wait', '--timeout', '10'], environment, transport);
  assert.equal(deployment.status, 'success');
  assert.equal(deployment.serviceId, service.id);
  assert((await runCli(['logs', service.id], environment, transport)).logs.includes('DEMO'));
  assert.equal((await runCli(['action', service.id, 'stop'], environment, transport)).status, 'stopped');
  const outside = (await app.inject({ method: 'GET', url: '/api/services', headers: { cookie } })).json().find((item: { projectId: string }) => item.projectId !== project.id);
  if (outside) await assert.rejects(runCli(['inspect', outside.id], environment, transport), /HTTP 404/);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/api-keys/${key.id}`, headers: { cookie } })).statusCode, 200);
  await assert.rejects(runCli(['projects'], environment, transport), /HTTP 401/);
});

test('CLI rejects malformed input and credentials before sending requests', async () => {
  let calls = 0;
  const transport = () => { calls++; throw new Error('Unexpected request'); };
  const environment = { HARBORLIGHT_API_KEY: `hl_${'a'.repeat(43)}`, HARBORLIGHT_URL: 'https://panel.test' };
  for (const args of [['inspect', '../escape'], ['projects', '--force'], ['services', '--tail', '9000'], ['projects', '--token', environment.HARBORLIGHT_API_KEY], ['projects', '--url', 'https://user:secret@panel.test'], ['projects', '--url', 'https://panel.test/path']]) {
    await assert.rejects(runCli(args, environment, transport));
  }
  await assert.rejects(runCli(['projects'], {}, transport), /HARBORLIGHT_API_KEY/);
  assert.equal(calls, 0);
});
