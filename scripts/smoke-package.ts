/** Verify the built production image, including API-to-Docker wiring and restart. */
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { command } from '../server/docker.js';

const runId = randomUUID(), containerName = `hl-package-test-${runId}`, volumeName = `${containerName}-data`;
let started = false, projectId = '', serviceId = '', cookie = '', endpoint = '';
const password = randomUUID() + randomUUID();
async function api(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`${endpoint}/api${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
  const sessionCookie = response.headers.get('set-cookie');
  if (sessionCookie) cookie = sessionCookie.split(';')[0];
  return value;
}
async function ready() {
  for (let attempt = 0; attempt < 40; attempt++) {
    const response = await fetch(`${endpoint}/api/health`).catch(() => undefined);
    if (response?.ok) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Production container did not become ready.');
}
try {
  await command('docker', ['volume', 'create', '--label', `io.harborlight.test=${runId}`, volumeName]);
  await command('docker', ['run', '-d', '--name', containerName, '--label', `io.harborlight.test=${runId}`, '-p', '127.0.0.1::3000', '-v', `${volumeName}:/var/lib/harborlight`, '-v', '/var/run/docker.sock:/var/run/docker.sock', 'harborlight:local']);
  started = true;
  const [container] = JSON.parse(await command('docker', ['inspect', containerName]));
  endpoint = `http://127.0.0.1:${container.NetworkSettings.Ports['3000/tcp'][0].HostPort}`;
  await ready();
  assert.match(await (await fetch(endpoint)).text(), /Harborlight/i);
  assert.equal((await api('/auth/session')).setupRequired, true);
  const session = await api('/auth/setup', { name: 'Package QA', email: 'package@example.test', password });
  assert.equal(session.mode, 'docker');
  assert.equal((await api('/projects')).length, 0);
  assert.ok((await api('/metrics')).dockerVersion);
  const project = await api('/projects', { name: 'package-check' }); projectId = project.id;
  await api(`/projects/${projectId}/environment`, { env: { PACKAGE_SHARED: 'inherited-in-built-image', PACKAGE_SECRET: 'project-default' } }, 'PUT');
  const service = await api('/services', { projectId, name: 'web', kind: 'app', env: { PACKAGE_SECRET: 'package-fixture-value' } }); serviceId = service.id;
  const deployment = await api(`/services/${serviceId}/deploy`, {});
  let deployed = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await api(`/deployments/${deployment.id}`);
    if (result.status === 'failed') throw new Error(result.output);
    if (result.status === 'success') { deployed = true; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(deployed, 'API-triggered Docker deployment must finish');
  assert.match(await command('docker', ['exec', `hl-${serviceId}`, 'wget', '-qO-', 'http://127.0.0.1']), /Welcome to nginx/);
  const [workload] = JSON.parse(await command('docker', ['inspect', `hl-${serviceId}`]));
  assert.ok(workload.Config.Env.includes('PACKAGE_SHARED=inherited-in-built-image'));
  assert.ok(workload.Config.Env.includes('PACKAGE_SECRET=package-fixture-value'));
  const releases = await api(`/services/${serviceId}/releases`);
  assert.equal(releases.supported, true);
  assert.equal(releases.releases.length, 1);
  assert.equal(releases.releases[0].imageId, workload.Image);
  assert.equal(releases.activeReleaseId, releases.releases[0].id);
  assert(!JSON.stringify(releases).includes('package-fixture-value'));
  await api(`/services/${serviceId}`, { source: { type: 'git', repository: 'https://github.com/nginxinc/NGINX-Demos.git', branch: 'master', context: 'nginx-hello', dockerfile: 'Dockerfile' } }, 'PATCH');
  assert.equal((await api(`/services/${serviceId}`)).pendingChanges, true);
  const github = await api(`/services/${serviceId}/github-webhook/rotate`, {});
  assert.equal(github.enabled, true);
  const pingBody = JSON.stringify({ zen: 'Production parser preserves UTF-8 — vérifié' });
  const pingHeaders = { 'Content-Type': 'application/json', 'X-GitHub-Event': 'ping', 'X-GitHub-Delivery': randomUUID(), 'X-Hub-Signature-256': `sha256=${createHmac('sha256', github.secret).update(pingBody).digest('hex')}` };
  const ping = await fetch(new URL(github.endpoint, endpoint), { method: 'POST', headers: pingHeaders, body: pingBody });
  assert.equal(ping.status, 200); assert.equal((await ping.json()).status, 'pong');
  const altered = await fetch(new URL(github.endpoint, endpoint), { method: 'POST', headers: pingHeaders, body: pingBody + ' ' });
  assert.equal(altered.status, 401);
  assert.deepEqual(await api('/restores'), []);
  await command('docker', ['exec', containerName, 'docker', 'compose', 'version']);
  await command('docker', ['exec', containerName, 'docker', 'buildx', 'version']);
  const reader = await api('/users', { name: 'Package Reader', email: 'reader@example.test', password, role: 'member', memberships: [{ projectId, role: 'viewer' }] });
  const key = await api('/api-keys', { name: 'Package read', projectIds: [projectId], permission: 'read' });
  const keyRead = await fetch(`${endpoint}/api/services/${serviceId}`, { headers: { Authorization: `Bearer ${key.token}` } });
  assert.equal(keyRead.status, 200);
  assert.deepEqual((await keyRead.json()).env, {});
  const keyWrite = await fetch(`${endpoint}/api/services/${serviceId}/stop`, { method: 'POST', headers: { Authorization: `Bearer ${key.token}` } });
  assert.equal(keyWrite.status, 403);
  // SIGKILL leaves the persistent writer lock behind; restart must recognize it as stale.
  await command('docker', ['kill', containerName]);
  await command('docker', ['start', containerName]);
  const [restarted] = JSON.parse(await command('docker', ['inspect', containerName]));
  endpoint = `http://127.0.0.1:${restarted.NetworkSettings.Ports['3000/tcp'][0].HostPort}`;
  await ready();
  assert.equal((await api('/auth/session')).authenticated, true);
  assert.equal((await api(`/services/${serviceId}`)).status, 'running');
  assert.equal((await api(`/services/${serviceId}`)).pendingChanges, true);
  assert.equal((await api(`/services/${serviceId}/releases`)).activeReleaseId, releases.activeReleaseId);
  assert.equal((await api(`/services/${serviceId}/github-webhook`)).enabled, true);
  const afterRestartPing = await fetch(new URL(github.endpoint, endpoint), { method: 'POST', headers: pingHeaders, body: pingBody });
  assert.equal(afterRestartPing.status, 200); assert.equal((await afterRestartPing.json()).status, 'pong');
  assert.equal((await api('/projects'))[0].name, 'package-check');
  assert.equal((await api(`/projects/${projectId}/environment`)).env.PACKAGE_SHARED, 'inherited-in-built-image');
  assert.equal((await api(`/services/${serviceId}/environment`)).effective.PACKAGE_SECRET, 'package-fixture-value');
  assert.equal((await api('/users')).find((user: { id: string }) => user.id === reader.id).memberships[0].role, 'viewer');
  assert.equal((await fetch(`${endpoint}/api/projects`, { headers: { Authorization: `Bearer ${key.token}` } })).status, 200);
  await api(`/api-keys/${key.id}`, undefined, 'DELETE');
  assert.equal((await fetch(`${endpoint}/api/projects`, { headers: { Authorization: `Bearer ${key.token}` } })).status, 401);
  console.log('PASS: production UI, accounts/scoped keys, real deployment/environment, immutable release identity, raw signed GitHub parsing and Docker plugins; encrypted session/access/environment/release/webhook state survive hard restart.');
} catch (error) {
  if (started) { let output = ''; await command('docker', ['logs', '--tail', '20', containerName], { output: value => { output += value; } }).catch(() => {}); console.error(output); }
  throw error;
} finally {
  if (serviceId && endpoint) await api(`/services/${serviceId}`, undefined, 'DELETE').catch(() => {});
  // Fallback cleanup validates ownership before touching the test application's container.
  if (serviceId) {
    try {
      const [service] = JSON.parse(await command('docker', ['inspect', `hl-${serviceId}`]));
      if (service.Config?.Labels?.['io.harborlight.service'] === serviceId && service.Config?.Labels?.['io.harborlight.managed'] === 'true') await command('docker', ['rm', '-f', service.Id]);
    } catch { /* Already removed by the API. */ }
  }
  if (started) await command('docker', ['rm', '-f', containerName]);
  if (projectId) await command('docker', ['network', 'rm', `hl-project-${projectId}`]).catch(() => {});
  const [volume] = JSON.parse(await command('docker', ['volume', 'inspect', volumeName]));
  if (volume.Labels?.['io.harborlight.test'] === runId) await command('docker', ['volume', 'rm', volumeName]);
}
