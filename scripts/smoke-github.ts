/** Real HTTP -> signed GitHub push -> exact Git revision -> Docker build/runtime. */
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { command, DockerDriver } from '../server/docker.js';
import { withGitSourceCredentials } from '../server/source-credentials.js';
import type { Deployment, Service } from '../shared/types.js';

const repository = 'https://github.com/nginxinc/NGINX-Demos.git';
const branch = 'master';
const directory = await mkdtemp(join(tmpdir(), 'harborlight-github-smoke-'));
let app = await createApp({ dataDir: directory, mode: 'docker', staticDir: join(directory, 'no-static') });
let origin = await app.listen({ host: '127.0.0.1', port: 0 });
let cookie = '', projectId = '', secret = '', endpoint = '';
let service: Service | undefined, closed = false;

async function request(method: string, path: string, body?: unknown) {
  const response = await fetch(`${origin}/api${path}`, {
    method, headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const value = await response.json();
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0];
  return { response, value };
}
async function api(method: string, path: string, body?: unknown) {
  const result = await request(method, path, body);
  assert(result.response.ok, `${method} ${path}: ${result.response.status} ${JSON.stringify(result.value)}`);
  return result.value;
}
async function hook(body: string, delivery = randomUUID(), signatureBody = body, event = 'push', key = secret) {
  const response = await fetch(new URL(endpoint, origin), {
    method: 'POST', headers: {
      'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': delivery,
      'x-hub-signature-256': `sha256=${createHmac('sha256', key).update(signatureBody).digest('hex')}`
    }, body
  });
  return { status: response.status, value: await response.json() };
}
function deploymentId(value: { id?: string; deploymentId?: string; deployment?: { id?: string } }) {
  const id = value.deployment?.id || value.deploymentId || value.id;
  assert.match(id || '', /^[a-f0-9-]{36}$/i, 'The accepted hook must identify its deployment.');
  return id!;
}
async function completed(id: string): Promise<Deployment> {
  for (let attempt = 0; attempt < 600; attempt++) {
    const result: Deployment = await api('GET', `/deployments/${id}`);
    if (result.status === 'failed') throw new Error(`GitHub deployment failed:\n${result.output}`);
    if (result.status === 'success') return result;
    if (attempt > 0 && attempt % 50 === 0) console.log('Waiting for the signed push Git build and runtime.');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('GitHub deployment timed out.');
}
async function historyCount() { return (await api('GET', `/services/${service!.id}/deployments`)).length; }

try {
  await command('docker', ['info', '--format', '{{.ServerVersion}}']);
  const remote = await withGitSourceCredentials(repository, undefined, git => command('git', [...git.args, 'ls-remote', '--exit-code', git.repository, `refs/heads/${branch}`], { cwd: git.cwd, env: git.env, timeout: 60000 }));
  const expectedCommit = remote.split(/\s+/)[0];
  assert.match(expectedCommit, /^[a-f0-9]{40}$/);
  await api('POST', '/auth/setup', { name: 'GitHub QA', email: 'github@example.test', password: randomUUID() });
  projectId = (await api('POST', '/projects', { name: 'github-proof' })).id;
  service = await api('POST', '/services', {
    projectId, name: 'github-nginx', kind: 'app',
    source: { type: 'git', repository, branch, context: 'nginx-hello', dockerfile: 'Dockerfile' },
    resources: { cpu: 0.5, memoryMb: 128 }, env: { GITHUB_PROOF: 'signed-and-pinned' }
  });
  const management = `/services/${service!.id}/github-webhook`;
  const rotated = await api('POST', `${management}/rotate`, {});
  assert.equal(rotated.enabled, true); assert.equal(rotated.supported, true);
  secret = rotated.secret; endpoint = rotated.endpoint;
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await api('GET', management)).secret, undefined);
  const push = {
    ref: `refs/heads/${branch}`, before: '0'.repeat(40), after: expectedCommit, deleted: false,
    repository: { full_name: 'nginxinc/NGINX-Demos', html_url: 'https://github.com/nginxinc/NGINX-Demos', clone_url: repository },
    head_commit: { id: expectedCommit, message: 'UTF-8 proof — déploiement' }
  };
  const body = JSON.stringify(push, null, 2);
  const signedDelivery = randomUUID();
  assert.equal((await hook(body, randomUUID(), body, 'push', randomUUID())).status, 401);
  assert.equal((await hook(body + '\n', randomUUID(), body)).status, 401, 'Signature must cover the original request bytes.');
  assert.equal((await hook(JSON.stringify({ ...push, ref: 'refs/heads/other' }))).status, 200);
  assert.equal((await hook(JSON.stringify({ ...push, repository: { full_name: 'another/repo', html_url: 'https://github.com/another/repo', clone_url: 'https://github.com/another/repo.git' } }))).status, 200);
  assert.equal((await hook(JSON.stringify({ ...push, deleted: true }))).status, 200);
  assert.equal((await hook(JSON.stringify({ zen: 'Keep it simple' }), randomUUID(), JSON.stringify({ zen: 'Keep it simple' }), 'ping')).status, 200);
  assert.equal(await historyCount(), 0);
  console.log('PASS: real HTTP signature, raw-byte integrity, repository/branch/deletion and ping gates create no deployment.');

  const accepted = await hook(body, signedDelivery);
  assert.equal(accepted.status, 202, JSON.stringify(accepted.value));
  const firstId = deploymentId(accepted.value);
  const busyBody = JSON.stringify({ ...push, fixtureDelivery: randomUUID() });
  const busyId = randomUUID();
  const busy = await hook(busyBody, busyId);
  assert.equal(busy.status, 409, 'A second distinct push must not overlap the first deployment.');
  const first = await completed(firstId);
  assert.equal(first.commit, expectedCommit); assert.equal(first.requestedCommit, expectedCommit);
  assert(!first.output.includes(secret));
  const [container] = JSON.parse(await command('docker', ['container', 'inspect', `hl-${service!.id}`]));
  const [image] = JSON.parse(await command('docker', ['image', 'inspect', container.Image]));
  assert.equal(image.Config.Labels['org.opencontainers.image.revision'], expectedCommit);
  assert(container.Config.Env.includes('GITHUB_PROOF=signed-and-pinned'));
  assert.match(await command('docker', ['exec', container.Id, 'wget', '-qO-', 'http://127.0.0.1']), /<title>Hello World<\/title>/);
  console.log(`PASS: signed GitHub push built and started the exact official Nginx source commit ${expectedCommit}.`);

  assert.equal((await hook(body, signedDelivery)).status, 200);
  assert.equal((await hook(body, randomUUID())).status, 200, 'Changing the unsigned delivery header must not bypass signed-body deduplication.');
  assert.equal(await historyCount(), 1);
  const retried = await hook(busyBody, busyId);
  assert.equal(retried.status, 202, 'A busy rejection must remain eligible for redelivery.');
  await completed(deploymentId(retried.value));
  assert.equal(await historyCount(), 2);
  assert(!(await readFile(join(directory, 'state.enc'))).includes(Buffer.from(secret)), 'Webhook secret must be encrypted at rest.');

  await app.close(); closed = true;
  app = await createApp({ dataDir: directory, mode: 'docker', staticDir: join(directory, 'no-static') });
  origin = await app.listen({ host: '127.0.0.1', port: 0 }); closed = false;
  assert.equal((await api('GET', management)).enabled, true);
  assert.equal((await hook(body, randomUUID())).status, 200);
  assert.equal(await historyCount(), 2);
  console.log('PASS: duplicate deliveries, changed delivery IDs, busy retry and encrypted restart retain the correct deployment count.');

  const source = { ...service!.source, branch: 'changed-branch' };
  await api('PATCH', `/services/${service!.id}`, { source });
  assert.equal((await api('GET', management)).enabled, false);
  assert.equal((await hook(body)).status, 401);
  await api('PATCH', `/services/${service!.id}`, { source: service!.source });
  assert.equal((await api('GET', management)).enabled, false, 'Restoring a source must not resurrect an invalidated secret.');
  const replacement = await api('POST', `${management}/rotate`, {});
  assert.notEqual(replacement.secret, secret);
  assert.equal((await hook(body)).status, 401);
  secret = replacement.secret;
  await api('DELETE', management);
  assert.equal((await hook(body)).status, 401);
  console.log('PASS: source changes invalidate permanently; explicit rotation replaces the secret; revocation rejects delivery.');
  console.log('All native GitHub HTTP/Git/Docker smoke checks passed.');
} finally {
  if (!closed) await app.close();
  if (service) {
    await new DockerDriver(directory).remove(service).catch(() => {});
    for (const repositoryPrefix of [`harborlight/${service.id}`, `harborlight-release/${service.id}`]) {
      const tags = (await command('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', repositoryPrefix])).trim().split('\n').filter(value => value.startsWith(repositoryPrefix + ':') && !value.endsWith(':<none>'));
      for (const tag of tags) await command('docker', ['image', 'rm', tag]).catch(() => {});
    }
  }
  if (projectId) {
    const [network] = JSON.parse(await command('docker', ['network', 'inspect', `hl-project-${projectId}`]).catch(() => '[]'));
    if (network?.Labels?.['io.harborlight.project'] === projectId && network.Labels['io.harborlight.managed'] === 'true') await command('docker', ['network', 'rm', network.Name]);
  }
  await rm(directory, { recursive: true, force: true });
}
