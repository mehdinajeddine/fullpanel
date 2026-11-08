import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { hash } from 'bcryptjs';
import { DockerDriver, command } from '../server/docker.js';
import type { Service } from '../shared/types.js';

const directory = await mkdtemp(join(tmpdir(), 'harborlight-proxy-test-'));
const driver = new DockerDriver(directory);
const projectId = randomUUID(), serviceId = randomUUID();
const proxyName = `hl-proxy-test-${projectId}`;
let createdNetwork = false, createdProxy = false;
const timestamp = new Date().toISOString();
function requestHost(url: string, hostname: string, authorization?: string): Promise<{ status: number; text: string; location?: string }> {
  return new Promise((resolve, reject) => {
    const request = get(url, { headers: { Host: hostname, ...(authorization ? { Authorization: authorization } : {}) }, timeout: 3000 }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode || 0, text, location: response.headers.location }));
    });
    request.on('timeout', () => request.destroy(new Error('HTTP request timed out')));
    request.on('error', reject);
  });
}
const service: Service = { id: serviceId, projectId, name: 'proxy-test', kind: 'app', status: 'not-deployed', source: { type: 'image', image: 'nginx:1.28-alpine' }, env: {}, domains: [{ id: randomUUID(), hostname: 'smoke.harborlight.test', port: 80, path: '/', https: false }], mounts: [], ports: [], resources: { cpu: 0.5, memoryMb: 128 }, notes: '', createdAt: timestamp, updatedAt: timestamp };
const protectedRoute = randomUUID(), specificRoute = randomUUID();
service.domains.push(
  { id: protectedRoute, hostname: 'secure.harborlight.test', port: 80, path: '/private', https: false, stripPrefix: true },
  { id: randomUUID(), hostname: '*.wild.harborlight.test', port: 80, path: '/', https: false },
  { id: specificRoute, hostname: 'specific.wild.harborlight.test', port: 80, path: '/', https: false },
  { id: randomUUID(), hostname: 'redirect.harborlight.test', port: 80, path: '/app', https: true, redirectToHttps: true },
);
const password = 'disposable-proxy-test-password';
const passwordHash = await hash(password, 12);
const proxyAuth = { [protectedRoute]: { username: 'tester', passwordHash }, [specificRoute]: { username: 'tester', passwordHash } };
try {
  try { await command('docker', ['network', 'inspect', 'harborlight-proxy']); }
  catch (error) {
    if (!/No such network|not found/.test(String(error))) throw error;
    await command('docker', ['network', 'create', '--label', `io.harborlight.test=${projectId}`, 'harborlight-proxy']);
    createdNetwork = true;
  }
  await command('docker', ['run', '-d', '--name', proxyName, '--label', `io.harborlight.test=${projectId}`, '--network', 'harborlight-proxy', '-p', '127.0.0.1::80', '-v', '/var/run/docker.sock:/var/run/docker.sock:ro', 'traefik:v3.6', '--providers.docker=true', '--providers.docker.exposedbydefault=false', `--providers.docker.constraints=Label(\`io.harborlight.project\`,\`${projectId}\`)`, '--providers.docker.network=harborlight-proxy', '--entrypoints.web.address=:80', '--entrypoints.websecure.address=:443', '--api.dashboard=false', '--log.level=DEBUG']);
  createdProxy = true;
  await driver.deploy(service, text => process.stdout.write(text), { proxyAuth });
  const [container] = JSON.parse(await command('docker', ['inspect', `hl-${service.id}`]));
  assert.equal(container.HostConfig.NanoCpus, 500000000);
  assert.equal(container.HostConfig.Memory, 128 * 1024 ** 2);
  const [proxy] = JSON.parse(await command('docker', ['inspect', proxyName]));
  const port = proxy.NetworkSettings.Ports['80/tcp'][0].HostPort;
  const url = `http://127.0.0.1:${port}`;
  let routed = false, lastResponse = '';
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await requestHost(url, 'smoke.harborlight.test').catch(() => undefined);
    lastResponse = response ? `${response.status}: ${response.text}` : 'Connection failed';
    if (lastResponse.startsWith('200:') && lastResponse.includes('Welcome to nginx')) { routed = true; break; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!routed) {
    let logs = '';
    await command('docker', ['logs', '--tail', '80', proxyName], { output: value => { logs += value; } });
    const relevantLogs = logs.split('\n').filter(line => !line.includes('Filtering disabled container')).join('\n');
    throw new Error(`Traefik did not route the configured hostname. Last response ${lastResponse}. Proxy logs:\n${relevantLogs}`);
  }
  assert.equal((await requestHost(url, 'unmatched.harborlight.test')).status, 404);
  assert.equal((await requestHost(`${url}/private/`, 'secure.harborlight.test')).status, 401);
  assert.equal((await requestHost(`${url}/private/`, 'secure.harborlight.test', `Basic ${Buffer.from('tester:wrong-password').toString('base64')}`)).status, 401);
  const authorized = `Basic ${Buffer.from(`tester:${password}`).toString('base64')}`;
  const stripped = await requestHost(`${url}/private/`, 'secure.harborlight.test', authorized);
  assert.equal(stripped.status, 200);
  assert.match(stripped.text, /Welcome to nginx/);
  assert.equal((await requestHost(`${url}/privateish/`, 'secure.harborlight.test', authorized)).status, 404);
  assert.equal((await requestHost(url, 'tenant.wild.harborlight.test')).status, 200);
  assert.equal((await requestHost(url, 'wild.harborlight.test')).status, 404);
  assert.equal((await requestHost(url, 'nested.tenant.wild.harborlight.test')).status, 404);
  assert.equal((await requestHost(url, 'specific.wild.harborlight.test')).status, 401, 'Exact host takes priority over a wildcard');
  assert.equal((await requestHost(url, 'specific.wild.harborlight.test', authorized)).status, 200);
  const redirect = await requestHost(`${url}/app/detail?q=1`, 'redirect.harborlight.test');
  assert.equal(redirect.status, 301);
  assert.equal(redirect.location, 'https://redirect.harborlight.test/app/detail?q=1');
  assert.equal((await requestHost(`${url}/application`, 'redirect.harborlight.test')).status, 404);
  // This fixture belongs exclusively to this test. Echo the upstream path/header to prove
  // that successful proxy authentication does not forward credentials to the application.
  await command('docker', ['exec', '-i', `hl-${service.id}`, 'sh', '-c', 'cat > /etc/nginx/conf.d/default.conf && nginx -s reload'], {
    input: 'server { listen 80; location / { default_type text/plain; return 200 "path=$request_uri;authorization=$http_authorization"; } }\n',
  });
  let upstream = '';
  for (let attempt = 0; attempt < 20; attempt++) {
    upstream = (await requestHost(`${url}/private/check`, 'secure.harborlight.test', authorized)).text;
    if (upstream === 'path=/check;authorization=') break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(upstream, 'path=/check;authorization=');
  const rotatedPassword = 'rotated-disposable-proxy-password';
  const rotatedHash = await hash(rotatedPassword, 12);
  await driver.deploy(service, () => {}, { proxyAuth: { ...proxyAuth, [protectedRoute]: { username: 'tester', passwordHash: rotatedHash } } });
  const rotatedAuthorization = `Basic ${Buffer.from(`tester:${rotatedPassword}`).toString('base64')}`;
  for (let attempt = 0; attempt < 30; attempt++) {
    if ((await requestHost(`${url}/private/`, 'secure.harborlight.test', rotatedAuthorization)).status === 200) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal((await requestHost(`${url}/private/`, 'secure.harborlight.test', rotatedAuthorization)).status, 200);
  assert.equal((await requestHost(`${url}/private/`, 'secure.harborlight.test', authorized)).status, 401);
  console.log('PASS: real Traefik host/path boundaries, wildcard isolation, exact-host priority, prefix removal, bcrypt authentication/rotation, credential-header removal, HTTP-to-HTTPS redirect, CPU and memory limits.');
} finally {
  await driver.remove(service).catch(error => console.error('Service cleanup:', String(error)));
  if (createdProxy) await command('docker', ['rm', '-f', proxyName]);
  await command('docker', ['network', 'rm', `hl-project-${projectId}`]).catch(() => {});
  if (createdNetwork) {
    const [network] = JSON.parse(await command('docker', ['network', 'inspect', 'harborlight-proxy']));
    if (network.Labels?.['io.harborlight.test'] === projectId) await command('docker', ['network', 'rm', 'harborlight-proxy']);
  }
  await rm(directory, { recursive: true, force: true });
}
