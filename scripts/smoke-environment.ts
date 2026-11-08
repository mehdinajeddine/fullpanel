/** Real Docker proof of project defaults, service overrides and saved-versus-applied state. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { command } from '../server/docker.js';
import type { Service } from '../shared/types.js';

const directory = await mkdtemp(join(tmpdir(), 'harborlight-environment-smoke-'));
const app = await createApp({ dataDir: directory, mode: 'docker' });
const services: Service[] = [];
const projects: string[] = [];
let cookie = '';
async function api(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) {
  const response = await app.inject({ method, url: `/api${path}`, headers: cookie ? { cookie } : {}, ...(body === undefined ? {} : { payload: body as Record<string, unknown> }) });
  assert(response.statusCode < 300, `${method} ${path}: ${response.statusCode} ${response.body}`);
  if (response.cookies[0]) cookie = `${response.cookies[0].name}=${response.cookies[0].value}`;
  return response.json();
}
async function deploy(service: Service) {
  const job = await api('POST', `/services/${service.id}/deploy`, {});
  for (let attempt = 0; attempt < 180; attempt++) {
    const result = await api('GET', `/deployments/${job.id}`);
    if (result.status === 'failed') throw new Error(`Deployment failed: ${result.output}`);
    if (result.status === 'success') return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Deployment did not finish.');
}
async function environment(containerName: string) {
  const [container] = JSON.parse(await command('docker', ['container', 'inspect', containerName]));
  return Object.fromEntries(container.Config.Env.map((value: string) => { const split = value.indexOf('='); return [value.slice(0, split), value.slice(split + 1)]; }));
}
try {
  await api('POST', '/auth/setup', { name: 'Environment QA', email: 'environment@example.test', password: randomUUID() });
  const project = await api('POST', '/projects', { name: 'environment-proof' }); projects.push(project.id);
  const other = await api('POST', '/projects', { name: 'separate-project' }); projects.push(other.id);
  const beforeSecret = randomUUID(), afterSecret = randomUUID();
  const shared = { SHARED: 'project-default', COLLISION: 'project-value', EMPTY: 'project-value', YAML_SHADOW: 'project-value', RUNTIME_SECRET: beforeSecret, LITERAL: '${NOT_EXPANDED} and $() are literal', DOCKER_HOST: 'tcp://must-not-control-panel:9999' };
  await api('PUT', `/projects/${project.id}/environment`, { env: shared });
  const service: Service = await api('POST', '/services', { projectId: project.id, name: 'plain-app', kind: 'app', env: { COLLISION: 'service-value', EMPTY: '' }, source: { type: 'image', image: 'nginx:1.28-alpine' } });
  services.push(service);
  await deploy(service);
  const applied = await environment(`hl-${service.id}`);
  assert.equal(applied.SHARED, 'project-default');
  assert.equal(applied.COLLISION, 'service-value');
  assert.equal(applied.EMPTY, '');
  assert.equal(applied.LITERAL, shared.LITERAL);
  assert.equal(applied.DOCKER_HOST, shared.DOCKER_HOST);
  assert.equal(applied.RUNTIME_SECRET, beforeSecret);
  const stored = await api('GET', `/services/${service.id}`);
  assert.deepEqual(stored.env, { COLLISION: 'service-value', EMPTY: '' });
  const effective = await api('GET', `/services/${service.id}/environment`);
  assert.equal(effective.inherited.RUNTIME_SECRET, beforeSecret);
  assert.equal(effective.effective.COLLISION, 'service-value');
  assert((await api('GET', '/services')).every((item: Service) => Object.keys(item.env).length === 0));

  const compose: Service = await api('POST', '/services', { projectId: project.id, name: 'compose-app', kind: 'compose', env: { COLLISION: 'service-value' }, source: { type: 'compose', compose: 'services:\n  web:\n    image: nginx:1.28-alpine\n    environment:\n      COLLISION: yaml-value\n      YAML_SHADOW: yaml-value\n' } });
  services.push(compose);
  await deploy(compose);
  const child = await environment(`hl-${compose.id}-web-1`);
  assert.equal(child.SHARED, 'project-default');
  assert.equal(child.YAML_SHADOW, 'yaml-value');
  assert.equal(child.COLLISION, 'service-value');
  assert.equal(child.LITERAL, shared.LITERAL);
  console.log('PASS: real application and Compose precedence, empty overrides and literal values; workload Docker variables do not affect the panel.');

  await api('PUT', `/projects/${project.id}/environment`, { env: { ...shared, RUNTIME_SECRET: afterSecret } });
  const dirty = await api('GET', `/services/${service.id}`);
  assert(Date.parse(dirty.updatedAt) > Date.parse(dirty.deployedAt));
  assert.equal((await environment(`hl-${service.id}`)).RUNTIME_SECRET, beforeSecret, 'Saving must not redeploy the running container');
  await command('docker', ['exec', `hl-${service.id}`, 'sh', '-c', 'printf "%s\\n" "$RUNTIME_SECRET" > /proc/1/fd/1']);
  const logs = await api('GET', `/services/${service.id}/logs`);
  assert(!logs.logs.includes(beforeSecret), 'The previous applied environment remains redacted after changing a project secret');
  assert(logs.logs.includes('[REDACTED]'));
  await deploy(service);
  assert.equal((await environment(`hl-${service.id}`)).RUNTIME_SECRET, afterSecret);
  const isolated: Service = await api('POST', '/services', { projectId: other.id, name: 'isolated-app', kind: 'app' });
  services.push(isolated);
  const isolatedEnv = await api('GET', `/services/${isolated.id}/environment`);
  assert.deepEqual(isolatedEnv.inherited, {});
  assert.equal(isolatedEnv.effective.RUNTIME_SECRET, undefined);
  console.log('PASS: project environment changes require deployment, old runtime secrets remain masked, and another project inherits nothing.');
} finally {
  for (const service of services.reverse()) await api('DELETE', `/services/${service.id}`).catch(error => console.error('Owned service cleanup:', String(error)));
  await app.close();
  for (const projectId of projects) {
    try {
      const [network] = JSON.parse(await command('docker', ['network', 'inspect', `hl-project-${projectId}`]));
      if (network.Labels?.['io.harborlight.project'] === projectId && network.Labels?.['io.harborlight.managed'] === 'true') await command('docker', ['network', 'rm', network.Name]);
    } catch { /* Undeployed projects have no network. */ }
  }
  await rm(directory, { recursive: true, force: true });
}
