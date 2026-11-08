/** Opt-in integration check. Uses only UUID-owned resources and temporary credentials. */
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { chmod, mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from 'bcryptjs';
import { DockerDriver, command } from '../server/docker.js';
import { registryScopeForImage, sourceCredentialSecrets, withDockerSourceCredentials, withGitSourceCredentials, type RegistrySourceCredential } from '../server/source-credentials.js';
import type { Service } from '../shared/types.js';

const testId = randomUUID();
const directory = await mkdtemp(join(tmpdir(), 'harborlight-credentials-smoke-'));
await chmod(directory, 0o700);
const registryName = `hl-test-registry-${testId}`;
const projectId = randomUUID();
const timestamp = new Date().toISOString();
const service: Service = { id: randomUUID(), projectId, name: 'private-image', kind: 'app', status: 'not-deployed', source: { type: 'image' }, env: {}, domains: [], mounts: [], ports: [], resources: { cpu: 0.5, memoryMb: 256 }, notes: '', createdAt: timestamp, updatedAt: timestamp };
const driver = new DockerDriver(directory);
let image: string | undefined;
let registryCreated = false;
const password = randomBytes(32).toString('base64url');
let deploymentOutput = '';
const output = (value: string) => { deploymentOutput += value; };

async function eventually(check: () => Promise<void>, milliseconds = 60000) {
  const until = Date.now() + milliseconds;
  let last: unknown;
  while (Date.now() < until) {
    try { await check(); return; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw last;
}
async function inspectRuntime() {
  const [container] = JSON.parse(await command('docker', ['container', 'inspect', `hl-${service.id}`]));
  assert.equal(container.Config.Labels['io.harborlight.service'], service.id);
  assert.equal(container.State.Running, true);
  return container;
}
try {
  await command('docker', ['info', '--format', '{{.ServerVersion}}']);
  // No login to the developer's ambient Docker configuration occurs during setup.
  await withDockerSourceCredentials(undefined, undefined, command, async env => {
    for (const source of ['registry:2', 'nginx:1.28-alpine']) await command('docker', ['pull', source], { env, timeout: 300000 });
  });
  const authDirectory = join(directory, 'auth'); await mkdir(authDirectory, { mode: 0o700 });
  await writeFile(join(authDirectory, 'htpasswd'), `harborlight:${await hash(password, 10)}\n`, { mode: 0o600 });
  await command('docker', ['run', '-d', '--name', registryName, '--label', `io.harborlight.test=${testId}`, '-p', '127.0.0.1::5000', '--mount', `type=bind,src=${authDirectory},dst=/auth,readonly`, '-e', 'REGISTRY_AUTH=htpasswd', '-e', 'REGISTRY_AUTH_HTPASSWD_REALM=harborlight-test', '-e', 'REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd', 'registry:2']);
  registryCreated = true;
  const [registry] = JSON.parse(await command('docker', ['container', 'inspect', registryName]));
  const port = registry.NetworkSettings.Ports['5000/tcp'][0].HostPort;
  await eventually(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/v2/`);
    assert.equal(response.status, 401);
    await response.arrayBuffer();
  });
  image = `localhost:${port}/harborlight/${testId}:proof`;
  service.source.image = image;
  const credential: RegistrySourceCredential = { serviceId: service.id, ...registryScopeForImage(image), username: 'harborlight', password, updatedAt: timestamp };
  await command('docker', ['tag', 'nginx:1.28-alpine', image]);
  await withDockerSourceCredentials(image, credential, command, env => command('docker', ['push', image!], { env, timeout: 300000 }));
  await command('docker', ['image', 'rm', image]);
  await assert.rejects(driver.deploy(service, output), /unauthorized|no basic auth credentials|authentication required|denied/i);
  await driver.deploy(service, output, { sourceCredentials: { registry: credential } });
  const container = await inspectRuntime();
  await eventually(async () => {
    assert.match(await command('docker', ['exec', container.Id, 'wget', '-qO-', 'http://127.0.0.1']), /Welcome to nginx/);
  });
  console.log('PASS: private registry rejects anonymous access; stdin login, private pull and application HTTP succeed.');

  const wrongCredential = { ...credential, password: randomBytes(32).toString('base64url') };
  await assert.rejects(driver.deploy(service, output, { sourceCredentials: { registry: wrongCredential } }), /unauthorized|denied|authentication/i);
  assert.equal((await inspectRuntime()).Id, container.Id);
  // The image now exists locally: deploy must still pull and fail after revocation.
  await assert.rejects(driver.deploy(service, output), /unauthorized|no basic auth credentials|authentication required|denied/i);
  assert.equal((await inspectRuntime()).Id, container.Id);
  await assert.rejects(driver.deploy({ ...service, source: { type: 'image', image: `localhost:${port}/another/repository:proof` } }, output, { sourceCredentials: { registry: credential } }), /no longer match/);
  assert.equal((await inspectRuntime()).Id, container.Id);
  for (const secret of [...sourceCredentialSecrets({ registry: credential }), ...sourceCredentialSecrets({ registry: wrongCredential })]) assert.equal(deploymentOutput.includes(secret), false);
  assert.deepEqual(await readdir(join(directory, 'work')), []);
  console.log('PASS: wrong password, revoked credential and changed repository preserve the previous runtime; deployment output contains no credential.');

  // Network/TLS/isolated configuration sanity check; this is a public repository, not private-provider coverage.
  const revision = await withGitSourceCredentials('https://github.com/docker-library/hello-world.git', undefined, git => command('git', [...git.args, 'ls-remote', '--exit-code', git.repository, 'HEAD'], { cwd: git.cwd, env: git.env, timeout: 60000 }));
  assert.match(revision, /^[a-f0-9]{40,64}\s+HEAD\s*$/);
  console.log('PASS: public Git HTTPS works with verified TLS, isolated helpers and redirects disabled.');
  console.log('All source credential smoke checks passed.');
} finally {
  await driver.remove(service).catch(error => { if (!/No such/.test(String(error))) console.error('Owned service cleanup failed:', String(error)); });
  if (registryCreated) {
    const [registry] = JSON.parse(await command('docker', ['container', 'inspect', registryName]));
    if (registry.Config.Labels?.['io.harborlight.test'] === testId) await command('docker', ['rm', '-f', registryName]);
  }
  if (image) await command('docker', ['image', 'rm', image]).catch(() => {});
  try {
    const [network] = JSON.parse(await command('docker', ['network', 'inspect', `hl-project-${projectId}`]));
    if (network.Labels?.['io.harborlight.managed'] === 'true' && network.Labels?.['io.harborlight.project'] === projectId) await command('docker', ['network', 'rm', network.Name]);
  } catch { /* The network may not have been created yet. */ }
  await rm(directory, { recursive: true, force: true });
}
