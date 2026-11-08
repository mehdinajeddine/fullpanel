/** Real private SSH Git/API/build integration. Only UUID-labelled disposable resources. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InjectOptions } from 'fastify';
import { createApp } from '../server/app.js';
import { DockerDriver, command } from '../server/docker.js';
import { withDockerSourceCredentials, withGitSourceCredentials } from '../server/source-credentials.js';
import { Store } from '../server/store.js';
import type { Deployment, Service } from '../shared/types.js';

const testId = randomUUID(), directory = await mkdtemp(join(tmpdir(), 'fullpanel-ssh-smoke-'));
const fixtureName = `hl-test-ssh-${testId}`, fixtureImage = `fullpanel-ssh-test:${testId}`;
const stateDirectory = join(directory, 'state'), driver = new DockerDriver(stateDirectory);
let app: Awaited<ReturnType<typeof createApp>> | undefined, cookie = '', service: Service | undefined, projectId = '';
const allLogs: string[] = [], keys: string[] = [];
const isolatedGitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GIT_|SSH_|NODE_OPTIONS)/.test(key)));
Object.assign(isolatedGitEnv, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
async function request(method: InjectOptions['method'], path: string, payload?: Record<string, unknown>) {
  assert.ok(app);
  return app.inject({ method, url: `/api${path}`, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });
}
async function eventually<T>(check: () => Promise<T>, milliseconds = 30000): Promise<T> {
  const deadline = Date.now() + milliseconds;
  let error: unknown;
  while (Date.now() < deadline) {
    try { return await check(); } catch (caught) { error = caught; }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw error || Error('Timed out');
}
async function deployment(expect: 'success' | 'failed'): Promise<Deployment> {
  const queued = await request('POST', `/services/${service!.id}/deploy`, {});
  assert.equal(queued.statusCode, 202, queued.body);
  const result = await eventually(async () => {
    const response = await request('GET', `/deployments/${queued.json().id}`), job = response.json() as Deployment;
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(['success', 'failed'].includes(job.status), 'Deployment still running');
    return job;
  }, 180000);
  allLogs.push(result.output);
  assert.equal(result.status, expect, result.output);
  return result;
}
async function container() {
  const [value] = JSON.parse(await command('docker', ['inspect', `hl-${service!.id}`]));
  assert.equal(value.Config.Labels['io.harborlight.service'], service!.id);
  assert.equal(value.State.Running, true);
  return value;
}
async function rotate() {
  const result = await request('POST', `/services/${service!.id}/source-credentials/ssh/rotate`, {});
  assert.equal(result.statusCode, 200, result.body);
  const status = (await request('GET', `/services/${service!.id}/source-credentials`)).json();
  assert.equal(status.ssh.configured, true);
  assert.match(status.ssh.publicKey, /^ssh-ed25519 /);
  assert.match(status.ssh.fingerprint, /^SHA256:/);
  assert.equal(result.body.includes('PRIVATE KEY'), false);
  return status.ssh;
}
async function pin(knownHosts: string) {
  const result = await request('PUT', `/services/${service!.id}/source-credentials/ssh/host-key`, { knownHosts });
  assert.equal(result.statusCode, 200, result.body);
}
async function reopen() {
  assert.ok(app); await app.close(); app = undefined;
  const store = new Store(stateDirectory);
  try {
    const credential = store.state.sourceCredentials[service!.id]?.ssh;
    assert.ok(credential);
    keys.push(credential.privateKey);
    const bytes = await readFile(join(stateDirectory, 'state.enc'));
    assert.equal(bytes.includes(Buffer.from(credential.privateKey)), false);
    assert.equal(bytes.includes(Buffer.from(credential.publicKey)), false);
  } finally { store.close(); }
  app = await createApp({ dataDir: stateDirectory, mode: 'docker', driver, staticDir: join(directory, 'no-static') });
}
try {
  await command('docker', ['info', '--format', '{{.ServerVersion}}']);
  for (const name of ['build', 'source', 'keys', 'host']) await mkdir(join(directory, name), { mode: 0o755 });
  // This fixture's sshd accepts public keys only and exposes no Docker socket or host shell.
  await writeFile(join(directory, 'build', 'Dockerfile'), 'FROM alpine:3.21\nRUN apk add --no-cache git openssh-server && adduser -D -s /usr/bin/git-shell git && passwd -u git && git config --system --add safe.directory /srv/private.git\nENTRYPOINT ["/usr/sbin/sshd", "-D", "-e", "-f", "/fixture/sshd_config"]\n');
  await withDockerSourceCredentials(undefined, undefined, command, env => command('docker', ['build', '--label', `io.harborlight.test=${testId}`, '-t', fixtureImage, join(directory, 'build')], { env, timeout: 180000 }));
  await command('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(directory, 'host', 'key')]);
  await command('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(directory, 'host', 'wrong')]);
  await writeFile(join(directory, 'keys', 'authorized_keys'), '', { mode: 0o644 });
  await writeFile(join(directory, 'build', 'sshd_config'), 'Port 2222\nListenAddress 0.0.0.0\nHostKey /host/key\nPidFile /tmp/sshd.pid\nAuthorizedKeysFile /keys/authorized_keys\nPubkeyAuthentication yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nAllowUsers git\nStrictModes no\nAllowTcpForwarding no\nAllowAgentForwarding no\nPermitTTY no\nLogLevel VERBOSE\n');
  const source = join(directory, 'source'), bare = join(directory, 'private.git');
  await writeFile(join(source, 'Dockerfile'), 'FROM nginx:1.28-alpine\nCOPY . /usr/share/nginx/html\n');
  await writeFile(join(source, 'index.html'), `FullPanel private SSH source ${testId}\n`);
  await command('git', ['init', '--initial-branch=main', source], { env: isolatedGitEnv });
  await command('git', ['-c', 'core.hooksPath=/dev/null', 'add', '.'], { cwd: source, env: isolatedGitEnv });
  await command('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=FullPanel test', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Private source fixture'], { cwd: source, env: isolatedGitEnv });
  const expectedCommit = (await command('git', ['rev-parse', 'HEAD'], { cwd: source, env: isolatedGitEnv })).trim();
  await command('git', ['clone', '--bare', source, bare], { env: isolatedGitEnv });
  await chmod(bare, 0o755);
  await command('docker', ['run', '-d', '--name', fixtureName, '--label', `io.harborlight.test=${testId}`, '-p', '127.0.0.1::2222', '--mount', `type=bind,src=${bare},dst=/srv/private.git,readonly`, '--mount', `type=bind,src=${join(directory, 'host')},dst=/host,readonly`, '--mount', `type=bind,src=${join(directory, 'keys')},dst=/keys,readonly`, '--mount', `type=bind,src=${join(directory, 'build')},dst=/fixture,readonly`, fixtureImage]);
  const [fixture] = JSON.parse(await command('docker', ['inspect', fixtureName]));
  const port = fixture.NetworkSettings.Ports['2222/tcp'][0].HostPort, repository = `ssh://git@127.0.0.1:${port}/srv/private.git`;
  const hostKey = (await readFile(join(directory, 'host', 'key.pub'), 'utf8')).trim().split(' ').slice(0, 2).join(' ');
  const wrongHostKey = (await readFile(join(directory, 'host', 'wrong.pub'), 'utf8')).trim().split(' ').slice(0, 2).join(' ');
  const knownHosts = `[127.0.0.1]:${port} ${hostKey}\n`;
  await eventually(async () => assert.match(await command('docker', ['exec', fixtureName, 'cat', '/tmp/sshd.pid']), /^\d+/));
  app = await createApp({ dataDir: stateDirectory, mode: 'docker', driver, staticDir: join(directory, 'no-static') });
  const setup = await request('POST', '/auth/setup', { name: 'SSH test', email: 'ssh@example.test', password: randomUUID() });
  assert.equal(setup.statusCode, 200, setup.body); cookie = String(setup.headers['set-cookie']).split(';')[0];
  const project = await request('POST', '/projects', { name: `ssh-${testId.slice(0, 8)}` });
  assert.equal(project.statusCode, 201, project.body); projectId = project.json().id;
  const created = await request('POST', '/services', { projectId, name: 'private-web', kind: 'app', source: { type: 'git', repository, branch: 'main', dockerfile: 'Dockerfile' }, resources: { cpu: 0.5, memoryMb: 128 } });
  assert.equal(created.statusCode, 201, created.body); service = created.json();
  const firstKey = await rotate();
  await writeFile(join(directory, 'keys', 'authorized_keys'), `restrict ${firstKey.publicKey}\n`);
  const noHost = await deployment('failed'); assert.match(noHost.output, /host.key|known.host|server public key|trusted/i);
  await pin(knownHosts);
  await reopen();
  const first = await deployment('success'); assert.equal(first.commit, expectedCommit);
  const firstContainer = await container();
  const http = await command('docker', ['exec', firstContainer.Id, 'wget', '-qO-', 'http://127.0.0.1']);
  assert.equal(http.trim(), `FullPanel private SSH source ${testId}`);
  const [built] = JSON.parse(await command('docker', ['image', 'inspect', firstContainer.Image]));
  assert.equal(built.Config.Labels['org.opencontainers.image.revision'], expectedCommit);
  console.log(`PASS: API-generated Ed25519 key, pinned server identity, encrypted restart, private clone ${expectedCommit}, Docker build and HTTP response.`);

  await pin(`[127.0.0.1]:${port} ${wrongHostKey}\n`);
  const wrongPin = await deployment('failed'); assert.match(wrongPin.output, /host.key|verification|identification/i);
  assert.equal((await container()).Id, firstContainer.Id);
  await pin(knownHosts);
  await writeFile(join(directory, 'keys', 'authorized_keys'), '');
  const revoked = await deployment('failed'); assert.match(revoked.output, /denied|authentication/i);
  assert.equal((await container()).Id, firstContainer.Id);
  await writeFile(join(directory, 'keys', 'authorized_keys'), `restrict ${firstKey.publicKey}\n`);
  const rotated = await rotate(); assert.notEqual(rotated.publicKey, firstKey.publicKey);
  // Rotation retains a verified host pin but must not fall back to the old private key.
  await pin(knownHosts);
  const unregistered = await deployment('failed'); assert.match(unregistered.output, /denied|authentication/i);
  assert.equal((await container()).Id, firstContainer.Id);
  await writeFile(join(directory, 'keys', 'authorized_keys'), `restrict ${rotated.publicKey}\n`);
  await reopen();
  const second = await deployment('success'); assert.equal(second.commit, expectedCommit);
  assert.notEqual((await container()).Id, firstContainer.Id);
  console.log('PASS: host-key mismatch, revoked deploy key and unregistered rotation fail without replacing the running app; registered rotation deploys.');

  // A malicious ambient SSH command must be ignored. Scope remains exact and source credentials are transient.
  await app!.close(); app = undefined;
  const stored = new Store(stateDirectory);
  const credential = structuredClone(stored.state.sourceCredentials[service!.id].ssh!); stored.close();
  const contextPaths: string[] = [];
  const remote = await withGitSourceCredentials(repository, credential, async git => {
    contextPaths.push(git.cwd);
    assert.equal(git.env.SSH_AUTH_SOCK, undefined);
    return command('git', [...git.args, 'ls-remote', '--exit-code', git.repository, 'refs/heads/main'], { env: git.env, cwd: git.cwd });
  }, { ...process.env, GIT_SSH_COMMAND: 'exit 91', SSH_AUTH_SOCK: '/untrusted/agent' });
  assert.match(remote, new RegExp(`^${expectedCommit}\\s+refs/heads/main`));
  for (const path of contextPaths) await assert.rejects(readdir(path), /ENOENT/);
  await assert.rejects(withGitSourceCredentials(repository.replace('private.git', 'other.git'), credential, async () => { throw Error('Callback must not run'); }), /match|scope/i);
  app = await createApp({ dataDir: stateDirectory, mode: 'docker', driver, staticDir: join(directory, 'no-static') });
  const publicBodies = [(await request('GET', `/services/${service!.id}`)).body, (await request('GET', `/services/${service!.id}/source-credentials`)).body, ...allLogs];
  const current = await container();
  const contextDump = await command('docker', ['exec', current.Id, 'find', '/usr/share/nginx/html', '-type', 'f', '-exec', 'cat', '{}', ';']);
  for (const key of keys) for (const body of [...publicBodies, contextDump]) {
    assert.equal(body.includes(key), false);
    for (const line of key.split('\n').filter(line => line.length > 32 && !line.startsWith('---'))) assert.equal(body.includes(line), false);
  }
  assert.deepEqual(await readdir(join(stateDirectory, 'work')), []);
  const changed = await request('PATCH', `/services/${service!.id}`, { source: { ...service!.source, repository: repository.replace('private.git', 'other.git') } });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal((await request('GET', `/services/${service!.id}/source-credentials`)).json().ssh.configured, false);
  console.log('PASS: hostile ambient SSH ignored; repository scope, transient-file removal, public-output/build-context secrecy and source-change revocation verified.');
  console.log('All real SSH Git smoke checks passed.');
} finally {
  const cleanupErrors: unknown[] = [];
  const cleanup = async (action: () => Promise<unknown>) => { try { await action(); } catch (error) { cleanupErrors.push(error); } };
  if (app) await cleanup(() => app!.close());
  if (service) await cleanup(() => driver.remove(service!));
  await cleanup(async () => {
    const [fixture] = JSON.parse(await command('docker', ['inspect', fixtureName]).catch(() => '[]'));
    if (fixture?.Config.Labels?.['io.harborlight.test'] === testId) await command('docker', ['rm', '-f', fixtureName]);
  });
  if (service) await cleanup(async () => {
    const references = (await command('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'])).split('\n').filter(value => value.startsWith(`harborlight/${service!.id}:`) || value.startsWith(`harborlight-release/${service!.id}:`));
    for (const reference of references) {
      const [image] = JSON.parse(await command('docker', ['image', 'inspect', reference]));
      if (image.Config.Labels?.['io.harborlight.managed'] === 'true') await cleanup(() => command('docker', ['image', 'rm', reference]));
    }
  });
  await cleanup(async () => {
    const [image] = JSON.parse(await command('docker', ['image', 'inspect', fixtureImage]).catch(() => '[]'));
    if (image?.Config.Labels?.['io.harborlight.test'] === testId) await command('docker', ['image', 'rm', fixtureImage]);
  });
  if (projectId) await cleanup(async () => {
    const [network] = JSON.parse(await command('docker', ['network', 'inspect', `hl-project-${projectId}`]).catch(() => '[]'));
    if (network?.Labels?.['io.harborlight.project'] === projectId) await command('docker', ['network', 'rm', network.Name]);
  });
  await cleanup(() => rm(directory, { recursive: true, force: true }));
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, `SSH fixture cleanup failed (${testId}).`);
}
