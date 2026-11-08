/** API-allocated test hosts -> real Traefik -> two isolated application runtimes.
 * All requests use loopback plus explicit Host; this does not prove public DNS or reachability.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InjectOptions } from 'fastify';
import { createApp } from '../server/app.js';
import { command, DockerDriver } from '../server/docker.js';
import { testDomainHostname } from '../shared/test-domains.js';
import type { Deployment, Service } from '../shared/types.js';

const fixtureId = randomUUID();
const directory = await mkdtemp(join(tmpdir(), 'fullpanel-test-domains-'));
const driver = new DockerDriver(directory);
const app = await createApp({ dataDir: directory, mode: 'docker', driver, staticDir: join(directory, 'no-static') });
const services: Service[] = [];
const proxyName = `hl-test-domains-${fixtureId}`;
let cookie = '', projectId = '', createdProxyNetwork = false;

async function api(method: InjectOptions['method'], path: string, payload?: object) {
  const response = await app.inject({ method, url: `/api${path}`, headers: { cookie }, ...(payload ? { payload } : {}) });
  assert(response.statusCode >= 200 && response.statusCode < 300, `${method} ${path}: ${response.statusCode} ${response.body}`);
  if (response.headers['set-cookie']) cookie = String(response.headers['set-cookie']).split(';')[0];
  return response.json();
}
async function deploy(service: Service) {
  const deployment: Deployment = await api('POST', `/services/${service.id}/deploy`, {});
  for (let attempt = 0; attempt < 180; attempt++) {
    const result: Deployment = await api('GET', `/deployments/${deployment.id}`);
    if (result.status === 'failed') throw new Error(`Deployment failed: ${result.output}`);
    if (result.status === 'success') return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Test hostname deployment timed out.');
}
function requestHost(url: string, hostname: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = get(url, { headers: { Host: hostname }, timeout: 3000 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 64 * 1024) request.destroy(new Error('Unexpectedly large fixture response.'));
      });
      response.on('end', () => resolve({ status: response.statusCode || 0, body }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Loopback HTTP request timed out.')));
    request.on('error', reject);
  });
}
async function inspect(type: 'container' | 'network', name: string) {
  try { return JSON.parse(await command('docker', [type, 'inspect', name]))[0]; }
  catch (error) { if (/No such|not found/.test(String(error))) return undefined; throw error; }
}

try {
  await command('docker', ['info', '--format', '{{.ServerVersion}}']);
  await api('POST', '/auth/setup', { name: 'Test domains QA', email: 'test-domains@example.test', password: randomUUID() });
  projectId = (await api('POST', '/projects', { name: 'test-domains-proof' })).id;
  await api('PATCH', '/settings', { baseDomain: '', testDomainIp: '8.8.8.8' });
  services.push(await api('POST', '/services', { projectId, name: 'first', kind: 'app', source: { type: 'image', image: 'traefik/whoami:v1.11' }, resources: { cpu: 0.25, memoryMb: 64 } }));
  services.push(await api('POST', '/templates/whoami/install', { projectId, name: 'second' }));
  for (const service of services) {
    assert.equal(service.domains.length, 1);
    assert.equal(service.domains[0].hostname, testDomainHostname(service.id, '8.8.8.8'));
    assert.equal(service.domains[0].https, false);
    assert.equal(service.domains[0].path, '/');
    assert.equal(service.domains[0].port, 80);
  }
  assert.notEqual(services[0].domains[0].hostname, services[1].domains[0].hostname);
  if (!await inspect('network', 'harborlight-proxy')) {
    await command('docker', ['network', 'create', '--label', `io.harborlight.test=${fixtureId}`, 'harborlight-proxy']);
    createdProxyNetwork = true;
  }
  await command('docker', ['run', '-d', '--name', proxyName, '--label', `io.harborlight.test=${fixtureId}`, '--network', 'harborlight-proxy', '-p', '127.0.0.1::80', '-v', '/var/run/docker.sock:/var/run/docker.sock:ro', 'traefik:v3.6', '--providers.docker=true', '--providers.docker.exposedbydefault=false', `--providers.docker.constraints=Label(\`io.harborlight.project\`,\`${projectId}\`)`, '--providers.docker.network=harborlight-proxy', '--entrypoints.web.address=:80', '--api.dashboard=false']);
  for (const service of services) await deploy(service);
  const proxy = await inspect('container', proxyName);
  assert.equal(proxy.Config.Labels['io.harborlight.test'], fixtureId);
  const binding = proxy.NetworkSettings.Ports['80/tcp'][0];
  assert.equal(binding.HostIp, '127.0.0.1');
  const url = `http://127.0.0.1:${binding.HostPort}`;
  const expectedHosts: string[] = [];
  for (const service of services) {
    const container = await inspect('container', `hl-${service.id}`);
    assert.equal(container.Config.Labels['io.harborlight.managed'], 'true');
    assert.equal(container.Config.Labels['io.harborlight.service'], service.id);
    assert.equal(container.Config.Labels['io.harborlight.project'], projectId);
    expectedHosts.push(container.Config.Hostname);
  }
  assert.notEqual(expectedHosts[0], expectedHosts[1]);
  for (let index = 0; index < services.length; index++) {
    let response: { status: number; body: string } | undefined;
    for (let attempt = 0; attempt < 60; attempt++) {
      response = await requestHost(url, services[index].domains[0].hostname).catch(() => undefined);
      if (response?.status === 200 && response.body.includes(`Hostname: ${expectedHosts[index]}\n`)) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.equal(response?.status, 200, `Generated host ${index + 1} did not route.`);
    assert(response.body.includes(`Hostname: ${expectedHosts[index]}\n`), 'Generated host selected the wrong service.');
    assert(!response.body.includes(`Hostname: ${expectedHosts[1 - index]}\n`), 'A generated host crossed services.');
  }
  assert.equal((await requestHost(url, `unmatched-${fixtureId}.example.test`)).status, 404);
  console.log('PASS: API-allocated UUID test hostnames route two separate real application containers through Traefik; direct creation and template installation use HTTP port 80.');
  console.log('Proof scope: loopback HTTP with explicit Host only. No public DNS, server-IP ownership, external reachability or TLS validation was performed.');
} finally {
  // The UUIDs belong exclusively to this invocation. Never prune shared Docker resources.
  const cleanupFailures: unknown[] = [];
  async function cleanup(action: () => Promise<unknown>) { try { await action(); } catch (error) { cleanupFailures.push(error); } }
  await cleanup(() => app.close());
  for (const service of services) await cleanup(() => driver.remove(service));
  await cleanup(async () => {
    const proxy = await inspect('container', proxyName);
    if (proxy) { assert.equal(proxy.Config.Labels['io.harborlight.test'], fixtureId); await command('docker', ['rm', '-f', proxy.Id]); }
  });
  if (projectId) await cleanup(async () => {
    const network = await inspect('network', `hl-project-${projectId}`);
    if (network) {
      assert.equal(network.Labels['io.harborlight.managed'], 'true'); assert.equal(network.Labels['io.harborlight.project'], projectId);
      await command('docker', ['network', 'rm', network.Id]);
    }
  });
  if (createdProxyNetwork) await cleanup(async () => {
    const network = await inspect('network', 'harborlight-proxy');
    if (network) { assert.equal(network.Labels['io.harborlight.test'], fixtureId); await command('docker', ['network', 'rm', network.Id]); }
  });
  await cleanup(() => rm(directory, { recursive: true, force: true }));
  if (cleanupFailures.length) throw new AggregateError(cleanupFailures, 'Test domain fixture cleanup failed.');
}
