import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { z } from 'zod';
import type { Service } from '../shared/types.js';
import { command } from './docker.js';
import { normalizeGitRepository, registryScopeForImage, pruneSourceCredentials, resolveSourceCredentials, registerSourceCredentials, sourceCredentialSecrets, withGitSourceCredentials, withDockerSourceCredentials, type GitSourceCredential, type RegistrySourceCredential, type ServiceSourceCredentials, type CredentialCommand } from './source-credentials.js';

function service(type: 'git' | 'image' | 'dockerfile' = 'git'): Service {
  return { id: randomUUID(), projectId: randomUUID(), name: 'web', kind: 'app', status: 'not-deployed', source: type === 'git' ? { type, repository: 'https://git.example.test/team/app.git', branch: 'main' } : type === 'image' ? { type, image: 'ghcr.io/team/app:one' } : { type, dockerfile: 'FROM nginx:alpine' }, env: {}, domains: [], mounts: [], ports: [], resources: { cpu: 1, memoryMb: 256 }, notes: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}
function gitCredential(s: Service): GitSourceCredential { return { serviceId: s.id, repository: normalizeGitRepository(s.source.repository!), username: 'x-access-token', token: 'not-a-real-token-987654321', updatedAt: new Date().toISOString() }; }
function registryCredential(s: Service): RegistrySourceCredential { return { serviceId: s.id, ...registryScopeForImage(s.source.image!), username: 'example-user', password: 'not-a-real-password-987654321', updatedAt: new Date().toISOString() }; }

test('image scopes normalize Docker Hub aliases while keeping repository and registry boundaries', () => {
  assert.deepEqual(registryScopeForImage('nginx:1.28-alpine'), { registry: 'docker.io', imageRepository: 'docker.io/library/nginx' });
  assert.deepEqual(registryScopeForImage('index.docker.io/team/app:Tag'), { registry: 'docker.io', imageRepository: 'docker.io/team/app' });
  assert.deepEqual(registryScopeForImage(`registry-1.docker.io/team/app@sha256:${'a'.repeat(64)}`), { registry: 'docker.io', imageRepository: 'docker.io/team/app' });
  assert.deepEqual(registryScopeForImage('localhost:5000/team/app:one'), { registry: 'localhost:5000', imageRepository: 'localhost:5000/team/app' });
  for (const invalid of ['https://ghcr.io/team/app', 'ghcr.io/team/../app', 'ghcr.io/Team/App', 'localhost:99999/team/app', 'ghcr.io/team/app@sha256:bad', 'ghcr.io/team/app:']) assert.throws(() => registryScopeForImage(invalid));
});

test('Git scopes require HTTPS and an exact credential-free repository path', () => {
  assert.equal(normalizeGitRepository('https://GIT.example.test:443/team/app.git/'), 'https://git.example.test/team/app.git');
  for (const invalid of ['http://git.example.test/team/app.git', 'https://user:secret@git.example.test/team/app.git', 'https://git.example.test/team/app.git?token=x', 'https://git.example.test/', 'https://git.example.test/team%2fapp.git']) assert.throws(() => normalizeGitRepository(invalid));
});

test('source edits preserve credentials only inside the original service and repository scope', () => {
  const git = service(), credential = gitCredential(git);
  assert.ok(pruneSourceCredentials({ ...git, source: { ...git.source, branch: 'release' } }, { git: credential }).git);
  assert.deepEqual(pruneSourceCredentials({ ...git, source: { type: 'git', repository: 'https://git.example.test/team/other.git' } }, { git: credential }), {});
  assert.deepEqual(pruneSourceCredentials({ ...git, id: randomUUID() }, { git: credential }), {});
  assert.throws(() => resolveSourceCredentials({ ...git, source: { type: 'image', image: 'nginx' } }, { git: credential }), /no longer match/);
  const image = service('image'), registry = registryCredential(image);
  assert.ok(pruneSourceCredentials({ ...image, source: { type: 'image', image: 'ghcr.io/team/app:two' } }, { registry }).registry);
  assert.deepEqual(pruneSourceCredentials({ ...image, source: { type: 'image', image: 'ghcr.io/team/other:two' } }, { registry }), {});
  const resolved = resolveSourceCredentials(image, { registry }); resolved.registry!.password = 'changed-copy';
  assert.notEqual(registry.password, 'changed-copy');
});

test('credential API authorizes every route, derives scope from saved source and never returns secrets', async t => {
  const app = Fastify(); t.after(() => app.close());
  const s = service(), image = service('image');
  const services = new Map<string, Service>([[s.id, s], [image.id, image]]);
  const credentials = new Map<string, ServiceSourceCredentials>();
  app.setErrorHandler((error, _request, reply) => reply.status(error instanceof z.ZodError ? 400 : (error as { statusCode?: number }).statusCode || 500).send({ error: (error as Error).message }));
  registerSourceCredentials(app, {
    getService: id => services.get(id), getCredentials: id => credentials.get(id), setCredentials: (id, value) => { credentials.set(id, value); },
    authorize: (request, _id, access) => { if (request.headers['x-role'] !== 'operator' && !(access === 'read' && request.headers['x-role'] === 'viewer')) throw Object.assign(new Error('Forbidden'), { statusCode: 403 }); }
  });
  const url = `/api/services/${s.id}/source-credentials`;
  assert.equal((await app.inject({ url })).statusCode, 403);
  assert.equal((await app.inject({ method: 'PUT', url: `${url}/git`, headers: { 'x-role': 'viewer' }, payload: { username: 'alice', token: 'secret-value' } })).statusCode, 403);
  const stored = await app.inject({ method: 'PUT', url: `${url}/git`, headers: { 'x-role': 'operator' }, payload: { username: 'alice', token: 'secret-value' } });
  assert.equal(stored.statusCode, 200); assert.equal(stored.json().git.configured, true); assert.equal(stored.json().git.repository, s.source.repository);
  assert.ok(!stored.body.includes('secret-value')); assert.equal(stored.json().git.token, undefined);
  const shown = await app.inject({ url, headers: { 'x-role': 'viewer' } }); assert.ok(!shown.body.includes('secret-value'));
  const mismatched = await app.inject({ method: 'PUT', url: `${url}/git`, headers: { 'x-role': 'operator' }, payload: { username: 'alice', token: 'new-secret', repository: 'https://evil.test/a' } });
  assert.equal(mismatched.statusCode, 400); assert.equal(credentials.get(s.id)?.git?.token, 'secret-value');
  assert.equal((await app.inject({ method: 'PUT', url: `${url}/registry`, headers: { 'x-role': 'operator' }, payload: { username: 'alice', password: 'pw' } })).statusCode, 400);
  const registry = await app.inject({ method: 'PUT', url: `/api/services/${image.id}/source-credentials/registry`, headers: { 'x-role': 'operator' }, payload: { username: 'alice', password: 'registry-secret' } });
  assert.equal(registry.statusCode, 200); assert.ok(!registry.body.includes('registry-secret'));
  assert.equal(registry.json().registry.imageRepository, 'ghcr.io/team/app');
  const revoked = await app.inject({ method: 'DELETE', url: `${url}/git`, headers: { 'x-role': 'operator' } });
  assert.equal(revoked.json().git.configured, false); assert.deepEqual(credentials.get(s.id), {});
});

test('real Git askpass supplies only exact repository credentials and cleans private files', async () => {
  const s = service(), credential = gitCredential(s);
  let directory = '', askpass = '';
  await withGitSourceCredentials(s.source.repository!, credential, async context => {
    directory = context.cwd; askpass = context.env.GIT_ASKPASS!;
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(askpass)).mode & 0o777, 0o700);
    assert.ok(!(await readFile(askpass, 'utf8')).includes(credential.token));
    assert.ok(!context.repository.includes(credential.token)); assert.ok(!context.args.includes(credential.token));
    assert.equal(context.env.GIT_CONFIG_COUNT, undefined); assert.equal(context.env.GIT_TRACE_CURL, undefined); assert.equal(context.env.GIT_SSL_NO_VERIFY, undefined);
    assert.ok(context.args.includes('credential.helper=')); assert.ok(context.args.includes('http.followRedirects=false'));
    const filled = await command('git', [...context.args, 'credential', 'fill'], { cwd: context.cwd, env: context.env, input: 'protocol=https\nhost=git.example.test\npath=team/app.git\n\n' });
    assert.ok(filled.includes(`username=${credential.username}`)); assert.ok(filled.includes(`password=${credential.token}`));
    await assert.rejects(command('git', [...context.args, 'credential', 'fill'], { cwd: context.cwd, env: context.env, input: 'protocol=https\nhost=git.example.test\npath=team/other.git\n\n' }));
    await assert.rejects(command('git', [...context.args, 'credential', 'fill'], { cwd: context.cwd, env: context.env, input: 'protocol=https\nhost=other.example.test\npath=team/app.git\n\n' }));
  }, { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: 'store', GIT_TRACE_CURL: '1', GIT_SSL_NO_VERIFY: 'true' });
  await assert.rejects(stat(directory), { code: 'ENOENT' }); await assert.rejects(stat(askpass), { code: 'ENOENT' });
});

test('Git credentials cannot be redirected to a different repository and errors are redacted', async () => {
  const s = service(), credential = gitCredential(s); let called = false, directory = '';
  await assert.rejects(withGitSourceCredentials('https://git.example.test/other.git', credential, async () => { called = true; }), /scope/);
  assert.equal(called, false);
  await assert.rejects(withGitSourceCredentials(s.source.repository!, credential, async context => { directory = context.cwd; throw new Error(`remote echoed ${credential.token}`); }), error => error instanceof Error && !error.message.includes(credential.token) && error.message.includes('[REDACTED]'));
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('Docker login uses stdin and an isolated private config, preserving the selected Unix context', async () => {
  const s = service('image'), credential = registryCredential(s);
  let directory = '', logins = 0;
  const run: CredentialCommand = async (binary, args, options = {}) => {
    assert.equal(binary, 'docker'); assert.ok(!args.join(' ').includes(credential.password));
    if (args[0] === 'context') return JSON.stringify([{ Endpoints: { docker: { Host: 'unix:///test/docker.sock' } } }]);
    assert.deepEqual(args, ['login', '--username', credential.username, '--password-stdin', 'ghcr.io']);
    assert.equal(options.input, credential.password + '\n');
    directory = options.env!.DOCKER_CONFIG!;
    assert.equal(options.env!.DOCKER_CONTEXT, undefined); assert.equal(options.env!.DOCKER_AUTH_CONFIG, undefined);
    assert.equal(options.env!.DOCKER_HOST, 'unix:///test/docker.sock');
    const config = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'));
    assert.deepEqual(config.auths, { 'ghcr.io': {} });
    assert.deepEqual(Object.keys(config).sort(), ['auths', 'cliPluginsExtraDirs']);
    assert.ok(config.cliPluginsExtraDirs.some((path: string) => path.endsWith('/cli-plugins')));
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, 'config.json'))).mode & 0o777, 0o600);
    await writeFile(join(directory, 'config.json'), JSON.stringify({ auths: { 'ghcr.io': { auth: Buffer.from(`${credential.username}:${credential.password}`).toString('base64') } } }));
    logins++; return 'Login Succeeded';
  };
  await withDockerSourceCredentials(s.source.image, credential, run, async env => { assert.equal(env.DOCKER_CONFIG, directory); assert.equal(env.HL_GIT_TOKEN, undefined); }, { ...process.env, DOCKER_CONTEXT: 'some-context', DOCKER_AUTH_CONFIG: 'ambient-secrets', HL_GIT_TOKEN: 'old-secret' });
  assert.equal(logins, 1); await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('Docker mismatched sources never login; failed login is redacted and cleans credential files', async () => {
  const s = service('image'), credential = registryCredential(s); let called = false, directory = '';
  const run: CredentialCommand = async (_binary, _args, options = {}) => { called = true; directory = options.env!.DOCKER_CONFIG!; throw new Error(`Registry said ${credential.password} ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}`); };
  await assert.rejects(withDockerSourceCredentials('ghcr.io/team/other:one', credential, run, async () => {}), /scope/); assert.equal(called, false);
  await assert.rejects(withDockerSourceCredentials(undefined, credential, run, async () => {}), /image sources only/); assert.equal(called, false);
  await assert.rejects(withDockerSourceCredentials(s.source.image, credential, run, async () => {}, { DOCKER_HOST: 'unix:///test/docker.sock' }), error => error instanceof Error && !sourceCredentialSecrets({ registry: credential }).some(secret => error.message.includes(secret)) && error.message.includes('[REDACTED]'));
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('public pulls/builds use an empty auth config rather than ambient host credentials', async () => {
  let directory = '';
  const run: CredentialCommand = async () => { throw new Error('No login or context lookup expected'); };
  await withDockerSourceCredentials(undefined, undefined, run, async env => {
    directory = env.DOCKER_CONFIG!;
    assert.equal(env.DOCKER_AUTH_CONFIG, undefined);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')), { auths: { 'harborlight.invalid': {} }, cliPluginsExtraDirs: ['/should/not/be/read/cli-plugins'] });
  }, { DOCKER_HOST: 'unix:///test/docker.sock', DOCKER_AUTH_CONFIG: 'ambient', DOCKER_CONFIG: '/should/not/be/read' });
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('Docker plugin discovery survives config isolation without copying authentication or helper settings', async t => {
  const original = await mkdtemp(join(tmpdir(), 'harborlight-plugin-test-'));
  t.after(() => rm(original, { recursive: true, force: true }));
  await writeFile(join(original, 'config.json'), JSON.stringify({
    auths: { 'private.example.test': { auth: 'must-not-be-copied' } }, credsStore: 'desktop', credHelpers: { 'private.example.test': 'secret' },
    proxies: { default: { httpProxy: 'http://secret:password@example.test' } }, HttpHeaders: { Authorization: 'private-header' },
    cliPluginsExtraDirs: ['/opt/local/docker-plugins', 'relative/ignored', '/opt/local/docker-plugins', 123, '/bad\0path']
  }));
  await withDockerSourceCredentials(undefined, undefined, async () => { throw new Error('No Docker command needed'); }, async env => {
    const contents = await readFile(join(env.DOCKER_CONFIG!, 'config.json'), 'utf8');
    assert.deepEqual(JSON.parse(contents), { auths: { 'harborlight.invalid': {} }, cliPluginsExtraDirs: [join(original, 'cli-plugins'), '/opt/local/docker-plugins'] });
    assert.ok(!contents.includes('must-not-be-copied')); assert.ok(!contents.includes('password')); assert.ok(!contents.includes('private-header'));
  }, { DOCKER_HOST: 'unix:///test/docker.sock', DOCKER_CONFIG: original });
});
