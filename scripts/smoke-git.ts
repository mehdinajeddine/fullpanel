/** Real Git/API/build integration. Creates only disposable UUID-owned resources. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { DockerDriver, command, type DeployOptions, type Output } from '../server/docker.js';
import { withDockerSourceCredentials, withGitSourceCredentials } from '../server/source-credentials.js';
import { Store } from '../server/store.js';
import type { Deployment, Service } from '../shared/types.js';

const repository = 'https://github.com/docker/awesome-compose.git';
const branch = 'master';
const context = 'nginx-golang/backend';
const testId = randomUUID();
const directory = await mkdtemp(join(tmpdir(), 'harborlight-git-smoke-'));
class EvidenceDriver extends DockerDriver {
  options: DeployOptions[] = [];
  override async deploy(service: Service, output: Output, options: DeployOptions = {}) {
    this.options.push(structuredClone(options));
    return super.deploy(service, output, options);
  }
}
const driver = new EvidenceDriver(directory);
const app = await createApp({ dataDir: directory, mode: 'docker', driver, staticDir: join(directory, 'no-static') });
let cookie = '', projectId = '', service: Service | undefined;
const images: string[] = [];
let closed = false;
async function request(method: 'GET' | 'POST', path: string, payload?: Record<string, unknown>) {
  return app.inject({ method, url: `/api${path}`, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });
}
async function completed(deploymentId: string): Promise<Deployment> {
  const until = Date.now() + 15 * 60 * 1000;
  let lastReportedAt = Date.now();
  while (Date.now() < until) {
    const response = await request('GET', `/deployments/${deploymentId}`);
    assert.equal(response.statusCode, 200, response.body);
    const deployment = response.json() as Deployment;
    if (deployment.status === 'failed') throw new Error(`Git deployment failed:\n${deployment.output}`);
    if (deployment.status === 'success') return deployment;
    if (Date.now() - lastReportedAt > 25000) { console.log('Git deployment is building; waiting for the real runtime.'); lastReportedAt = Date.now(); }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Git deployment did not complete within 15 minutes.');
}
async function checkRuntime(deployment: Deployment, expectedCommit: string) {
  assert.equal(deployment.commit, expectedCommit);
  assert.match(deployment.output, new RegExp(`Source commit: ${expectedCommit}`));
  const [container] = JSON.parse(await command('docker', ['container', 'inspect', `hl-${service!.id}`]));
  assert.equal(container.State.Running, true);
  assert.equal(container.Config.Labels['io.harborlight.service'], service!.id);
  const [image] = JSON.parse(await command('docker', ['image', 'inspect', container.Image]));
  assert.equal(image.Config.Labels['io.harborlight.managed'], 'true');
  assert.equal(image.Config.Labels['org.opencontainers.image.revision'], expectedCommit);
  if (deployment.image) images.push(deployment.image);
  const client = `hl-test-git-client-${testId}`;
  try {
    const http = await command('docker', ['run', '--rm', '--name', client, '--label', `io.harborlight.test=${testId}`, '--network', `hl-project-${projectId}`, 'nginx:1.28-alpine', 'wget', '-qO-', `http://${service!.name}`], { timeout: 60000 });
    assert.match(http, /Hello from Docker!/);
  } finally {
    // --rm handles the usual path; inspect ownership before cleaning a timed-out client.
    const [remaining] = JSON.parse(await command('docker', ['container', 'inspect', client]).catch(() => '[]'));
    if (remaining?.Config.Labels?.['io.harborlight.test'] === testId) await command('docker', ['rm', '-f', client]);
  }
  return container.Id as string;
}
try {
  await command('docker', ['info', '--format', '{{.ServerVersion}}']);
  await withDockerSourceCredentials(undefined, undefined, command, env => command('docker', ['pull', 'nginx:1.28-alpine'], { env, timeout: 300000 }));
  const remote = await withGitSourceCredentials(repository, undefined, git => command('git', [...git.args, 'ls-remote', '--exit-code', git.repository, `refs/heads/${branch}`], { cwd: git.cwd, env: git.env, timeout: 60000 }));
  const expectedCommit = remote.split(/\s+/)[0]; assert.match(expectedCommit, /^[a-f0-9]{40}$/);
  const setup = await request('POST', '/auth/setup', { name: 'Git smoke test', email: 'git-smoke@example.test', password: randomUUID() });
  assert.equal(setup.statusCode, 200, setup.body); cookie = String(setup.headers['set-cookie']).split(';')[0];
  const project = await request('POST', '/projects', { name: `git-${testId.slice(0, 8)}` });
  assert.equal(project.statusCode, 201, project.body); projectId = project.json().id;
  const created = await request('POST', '/services', { projectId, name: 'git-http', kind: 'app', source: { type: 'git', repository, branch, context, dockerfile: 'Dockerfile' }, resources: { cpu: 0.5, memoryMb: 128 } });
  assert.equal(created.statusCode, 201, created.body); service = created.json() as Service;
  console.log(`Building official Docker Git fixture at ${expectedCommit}, context ${context}.`);
  const queued = await request('POST', `/services/${service.id}/deploy`, {});
  assert.equal(queued.statusCode, 202, queued.body);
  const first = await completed(queued.json().id);
  const firstContainerId = await checkRuntime(first, expectedCommit);
  console.log('PASS: real Git HTTPS clone, custom context Dockerfile build, application HTTP, Deployment.commit and OCI revision agree.');

  const rebuilding = await request('POST', `/services/${service.id}/deploy`, { forceRebuild: true });
  assert.equal(rebuilding.statusCode, 202, rebuilding.body);
  const second = await completed(rebuilding.json().id);
  const secondContainerId = await checkRuntime(second, expectedCommit);
  assert.notEqual(firstContainerId, secondContainerId);
  assert.equal(driver.options[1].forceRebuild, true);
  // Check that the costly RUN instructions actually ran; a cached build cannot satisfy this.
  const goSteps = [...second.output.matchAll(/^#(\d+) \[builder [^\]]+\] RUN .*go (?:mod download|build)/gm)].map(match => match[1]);
  assert.ok(goSteps.length >= 2, `Expected Go dependency and compile steps in BuildKit output:\n${second.output}`);
  for (const step of goSteps) {
    assert.match(second.output, new RegExp(`^#${step} DONE `, 'm'));
    assert.doesNotMatch(second.output, new RegExp(`^#${step} CACHED`, 'm'));
  }
  assert.deepEqual(await readdir(join(directory, 'work')), []);
  console.log('PASS: force rebuild reached the real driver and executed dependency/compile layers; replacement serves HTTP; temporary clone cleaned.');

  await app.close(); closed = true;
  const reopened = new Store(directory);
  try {
    for (const deployment of [first, second]) assert.equal(reopened.state.deployments.find(item => item.id === deployment.id)?.commit, expectedCommit);
  } finally { reopened.close(); }
  console.log(`PASS: both deployment commit records survive encrypted-store reopen (${expectedCommit}).`);
  console.log('All real Git smoke checks passed.');
} finally {
  if (!closed) await app.close();
  if (service) {
    await driver.remove(service);
    // Include a successfully built image even if a later API/assertion step failed.
    const built = (await command('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', `harborlight/${service.id}`])).trim().split('\n').filter(Boolean);
    for (const image of new Set([...images, ...built])) {
      const [info] = JSON.parse(await command('docker', ['image', 'inspect', image]).catch(() => '[]'));
      if (image.startsWith(`harborlight/${service.id}:`) && info?.Config.Labels?.['io.harborlight.managed'] === 'true') await command('docker', ['image', 'rm', image]).catch(() => {});
    }
  }
  if (projectId) {
    const [network] = JSON.parse(await command('docker', ['network', 'inspect', `hl-project-${projectId}`]).catch(() => '[]'));
    if (network?.Labels?.['io.harborlight.project'] === projectId && network.Labels['io.harborlight.managed'] === 'true') await command('docker', ['network', 'rm', network.Name]);
  }
  await rm(directory, { recursive: true, force: true });
}
