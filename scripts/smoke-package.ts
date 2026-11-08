/** Verify the built production image, including API-to-Docker wiring and restart. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
  const service = await api('/services', { projectId, name: 'web', kind: 'app' }); serviceId = service.id;
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
  await command('docker', ['exec', containerName, 'docker', 'compose', 'version']);
  await command('docker', ['exec', containerName, 'docker', 'buildx', 'version']);
  // SIGKILL leaves the persistent writer lock behind; restart must recognize it as stale.
  await command('docker', ['kill', containerName]);
  await command('docker', ['start', containerName]);
  const [restarted] = JSON.parse(await command('docker', ['inspect', containerName]));
  endpoint = `http://127.0.0.1:${restarted.NetworkSettings.Ports['3000/tcp'][0].HostPort}`;
  await ready();
  assert.equal((await api('/auth/session')).authenticated, true);
  assert.equal((await api(`/services/${serviceId}`)).status, 'running');
  assert.equal((await api('/projects'))[0].name, 'package-check');
  console.log('PASS: built container serves UI, owner auth, real API deployment, Docker plugins, encrypted state and session persistence across hard restart.');
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
