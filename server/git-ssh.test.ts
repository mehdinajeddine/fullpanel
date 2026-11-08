import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile, readdir, mkdir, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import { z } from 'zod';
import { generateSshKeyPair, initializeSshCredentialDirectory, parseSshRepository, validateSshKnownHosts, type GitSshCredential } from './git-ssh.js';
import { normalizeGitRepository, pruneSourceCredentials, registerSourceCredentials, resolveSourceCredentials, sourceCredentialSecrets, withGitSourceCredentials, type ServiceSourceCredentials } from './source-credentials.js';
import { command } from './docker.js';
import { sourceInput } from './validation.js';
import type { Service } from '../shared/types.js';

function service(repository = 'git@forge.example.test:team/app.git'): Service { return { id: randomUUID(), projectId: randomUUID(), name: 'web', kind: 'app', status: 'not-deployed', source: { type: 'git', repository, branch: 'main' }, env: {}, domains: [], mounts: [], ports: [], resources: { cpu: 1, memoryMb: 128 }, notes: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; }
async function credential(s: Service): Promise<GitSshCredential> { return { serviceId: s.id, repository: normalizeGitRepository(s.source.repository!), ...await generateSshKeyPair(s.id), updatedAt: new Date().toISOString() }; }
function hostEntry(repository: string, publicKey: string) { return `${parseSshRepository(repository).knownHost} ${publicKey.split(' ').slice(0, 2).join(' ')}`; }

test('SSH source normalization preserves remote path semantics, accepts explicit LAN and rejects command-like URLs', () => {
  assert.equal(normalizeGitRepository('git@FORGE.test:team/app.git/'), 'git@forge.test:team/app.git');
  assert.equal(normalizeGitRepository('ssh://git@FORGE.test:22/team/app.git/'), 'ssh://git@forge.test/team/app.git');
  assert.equal(parseSshRepository('git@forge.test:team/app.git').path, 'team/app.git');
  assert.equal(parseSshRepository('ssh://git@forge.test/team/app.git').path, '/team/app.git');
  for (const repository of ['git@localhost:repo.git', 'ssh://git@127.0.0.1:2222/repo.git', 'ssh://git@[::1]:2222/repo.git', 'git@10.0.0.1:repo.git']) assert.ok(sourceInput.safeParse({ type: 'git', repository }).success, repository);
  for (const repository of ['https://localhost/repo.git', 'https://10.0.0.1/repo.git', 'http://forge.test/repo.git', 'git://forge.test/repo.git', 'ssh://forge.test/repo.git', 'ssh://git:secret@forge.test/repo.git', 'git@forge.test:/absolute.git', 'git@forge.test:../repo.git', 'git@forge.test:team//repo.git', 'git@forge.test:team/./repo.git', 'git@forge.test:repo;touch.git', 'git@forge.test:$(touch).git', "git@forge.test:repo'bad.git", 'git@forge.test:-option', 'git@forge.test:repo.git?secret=x', 'git@forge.test:repo.git#branch', 'ssh://git@forge.test/%2e%2e/repo', 'ssh://git@forge.test:0/repo', 'ssh://git@forge.test:65536/repo', 'ssh://git@forge.test/', 'git@-option:repo.git']) assert.equal(sourceInput.safeParse({ type: 'git', repository }).success, false, repository);
});

test('OpenSSH generates independent native Ed25519 key pairs and fingerprints', async () => {
  const s = service(), first = await credential(s), second = await credential(s);
  assert.match(first.privateKey, /^-----BEGIN OPENSSH PRIVATE KEY-----/);
  assert.match(first.publicKey, /^ssh-ed25519 /); assert.match(first.fingerprint, /^SHA256:/);
  assert.notEqual(first.privateKey, second.privateKey); assert.notEqual(first.fingerprint, second.fingerprint);
  const directory = await mkdtemp(join(tmpdir(), 'hl-ssh-public-proof-'));
  try {
    const filename = join(directory, 'identity'); await writeFile(filename, first.privateKey, { mode: 0o600 });
    const derived = (await command('ssh-keygen', ['-y', '-f', filename])).trim();
    assert.equal(derived.split(' ').slice(0, 2).join(' '), first.publicKey.split(' ').slice(0, 2).join(' '));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('known_hosts accepts only valid explicit host+port pins and rejects broadened or malformed trust', async () => {
  const s = service('ssh://git@localhost:2222/repo.git'), c = await credential(s);
  const entry = hostEntry(c.repository, c.publicKey);
  const trust = await validateSshKnownHosts(c.repository, `# Verified out of band\n${entry} comment\n${entry}\n`);
  assert.equal(trust.knownHosts, `${entry}\n`); assert.deepEqual(trust.hostFingerprints, [c.fingerprint]);
  const key = c.publicKey.split(' ').slice(0, 2).join(' ');
  for (const input of [`localhost ${key}`, `* ${key}`, `[localhost]:2223 ${key}`, `[localhost]:2222,evil.test ${key}`, `@cert-authority [localhost]:2222 ${key}`, `|1|abc|def ${key}`, `[localhost]:2222 ssh-ed25519 AAAA`, `[localhost]:2222 ssh-rsa ${key.split(' ')[1]}`, '', '\n# empty\n', Array(11).fill(entry).join('\n')]) await assert.rejects(validateSshKnownHosts(c.repository, input), input);
});

test('SSH credentials are service and exact repository scoped, mutually exclusive with HTTPS', async () => {
  const s = service(), c = await credential(s);
  assert.ok(pruneSourceCredentials({ ...s, source: { ...s.source, branch: 'release' } }, { ssh: c }).ssh);
  for (const repository of ['git@other.test:team/app.git', 'other@forge.example.test:team/app.git', 'ssh://git@forge.example.test:2222/team/app.git', 'git@forge.example.test:team/other.git', 'https://forge.example.test/team/app.git']) assert.deepEqual(pruneSourceCredentials({ ...s, source: { ...s.source, repository } }, { ssh: c }), {});
  assert.deepEqual(pruneSourceCredentials({ ...s, id: randomUUID() }, { ssh: c }), {});
  assert.throws(() => resolveSourceCredentials({ ...s, source: { type: 'image', image: 'nginx' } }, { ssh: c }), /no longer match/);
  const isolated = resolveSourceCredentials(s, { ssh: c }); isolated.ssh!.privateKey = 'mutated'; assert.notEqual(c.privateKey, 'mutated');
  let called = false;
  await assert.rejects(withGitSourceCredentials(c.repository, undefined, async () => { called = true; }), /Generate/);
  await assert.rejects(withGitSourceCredentials(c.repository, c, async () => { called = true; }), /server public key/);
  assert.equal(called, false);
});

test('SSH wrapper constrains the Git command, removes ambient identities and deletes private files before returning', async () => {
  const s = service('ssh://git@localhost:2222/team/app.git'), c = await credential(s);
  Object.assign(c, await validateSshKnownHosts(c.repository, hostEntry(c.repository, c.publicKey)));
  const fakeBin = await mkdtemp(join(tmpdir(), 'hl-ssh-fake-')), captured = join(fakeBin, 'arguments.json');
  await writeFile(join(fakeBin, 'ssh'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(captured)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
  let directory = '';
  try {
    await withGitSourceCredentials(c.repository, c, async context => {
      directory = context.cwd;
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      for (const name of ['identity', 'known_hosts']) assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600);
      assert.equal(await readFile(join(directory, 'identity'), 'utf8'), c.privateKey);
      for (const name of ['SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'SSH_ASKPASS', 'GIT_SSH_COMMAND', 'GIT_CONFIG_COUNT', 'NODE_OPTIONS']) assert.equal(context.env[name], undefined);
      assert.equal(context.env.GIT_SSH_VARIANT, 'ssh');
      const env = { ...context.env, PATH: `${fakeBin}:${process.env.PATH}` };
      const wrapper = context.env.GIT_SSH!;
      await command(process.execPath, [wrapper, '-o', 'SendEnv=GIT_PROTOCOL', '-p', '2222', 'git@localhost', "git-upload-pack '/team/app.git'"], { env });
      const args: string[] = JSON.parse(await readFile(captured, 'utf8'));
      for (const required of ['StrictHostKeyChecking=yes', 'IdentityAgent=none', 'IdentitiesOnly=yes', 'GlobalKnownHostsFile=/dev/null', 'CertificateFile=none', 'ProxyCommand=none', 'ProxyJump=none', 'ControlPath=none', 'PreferredAuthentications=publickey']) assert.ok(args.includes(required), required);
      assert.deepEqual(args.slice(-3), ['--', 'git@localhost', "git-upload-pack '/team/app.git'"]);
      const configuration = await command('/usr/bin/ssh', ['-G', ...args]);
      assert.match(configuration, /identityagent none/); assert.match(configuration, /stricthostkeychecking true/);
      await rm(captured);
      for (const injection of [['-p', '2222', 'other@localhost', "git-upload-pack '/team/app.git'"], ['-p', '2223', 'git@localhost', "git-upload-pack '/team/app.git'"], ['-p', '2222', 'git@localhost', "git-upload-pack '/other.git'"], ['-p', '2222', 'git@localhost', 'sh'], ['-o', 'ProxyCommand=touch /tmp/forbidden', 'git@localhost', "git-upload-pack '/team/app.git'"]]) await assert.rejects(command(process.execPath, [wrapper, ...injection], { env }));
      await assert.rejects(stat(captured), { code: 'ENOENT' });
    }, { ...process.env, SSH_AUTH_SOCK: '/bad/agent', SSH_AGENT_PID: '123', SSH_ASKPASS: '/bad/askpass', GIT_SSH_COMMAND: 'touch /tmp/forbidden', GIT_CONFIG_COUNT: '1', NODE_OPTIONS: '--invalid-option' });
    await assert.rejects(stat(directory), { code: 'ENOENT' });
  } finally { await rm(fakeBin, { recursive: true, force: true }); }
});

test('SSH errors redact full keys and body lines while cleaning temporary credentials', async () => {
  const s = service(), c = await credential(s); Object.assign(c, await validateSshKnownHosts(c.repository, hostEntry(c.repository, c.publicKey)));
  let directory = '';
  const bodyLine = c.privateKey.split('\n')[1];
  await assert.rejects(withGitSourceCredentials(c.repository, c, async context => { directory = context.cwd; throw new Error(`${c.privateKey}\n${bodyLine}`); }), error => error instanceof Error && !error.message.includes(bodyLine) && error.message.includes('[REDACTED]'));
  assert.ok(sourceCredentialSecrets({ ssh: c }).includes(bodyLine));
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('SSH API rotation, trust and revocation expose public data only and preserve old credentials on invalid requests', async t => {
  const app = Fastify(); t.after(() => app.close());
  const s = service(); let stored: ServiceSourceCredentials = {}, idle = true;
  app.setErrorHandler((error, _request, reply) => reply.status(error instanceof z.ZodError ? 400 : (error as { statusCode?: number }).statusCode || 500).send({ error: (error as Error).message }));
  registerSourceCredentials(app, { getService: id => id === s.id ? s : undefined, getCredentials: () => stored, setCredentials: (_id, next) => { stored = next; }, authorize: request => { if (request.headers['x-role'] !== 'operator') throw Object.assign(Error('Operator required'), { statusCode: 403 }); }, requireIdle: () => { if (!idle) throw Object.assign(Error('Busy'), { statusCode: 409 }); } });
  const base = `/api/services/${s.id}/source-credentials`, headers = { 'x-role': 'operator' };
  assert.equal((await app.inject({ method: 'POST', url: `${base}/ssh/rotate`, payload: {} })).statusCode, 403);
  const generated = await app.inject({ method: 'POST', url: `${base}/ssh/rotate`, headers, payload: {} });
  assert.equal(generated.statusCode, 200, generated.body); assert.equal(generated.json().ssh.configured, true); assert.equal(generated.json().ssh.hostKeyConfigured, false);
  assert.equal(generated.json().ssh.privateKey, undefined); assert.ok(!generated.body.includes('PRIVATE KEY'));
  const old = stored.ssh!;
  assert.equal((await app.inject({ method: 'POST', url: `${base}/ssh/rotate`, headers, payload: { privateKey: 'injected' } })).statusCode, 400);
  idle = false; assert.equal((await app.inject({ method: 'POST', url: `${base}/ssh/rotate`, headers, payload: {} })).statusCode, 409); idle = true;
  assert.equal((await app.inject({ method: 'PUT', url: `${base}/ssh/host-key`, headers, payload: { knownHosts: 'invalid' } })).statusCode, 400);
  assert.equal(stored.ssh, old);
  const pinned = await app.inject({ method: 'PUT', url: `${base}/ssh/host-key`, headers, payload: { knownHosts: hostEntry(old.repository, old.publicKey) } });
  assert.equal(pinned.statusCode, 200, pinned.body); assert.equal(pinned.json().ssh.hostKeyConfigured, true);
  assert.deepEqual(pinned.json().ssh.hostFingerprints, [old.fingerprint]);
  const rotated = await app.inject({ method: 'POST', url: `${base}/ssh/rotate`, headers, payload: {} });
  assert.equal(rotated.statusCode, 200, rotated.body); assert.notEqual(rotated.json().ssh.fingerprint, old.fingerprint); assert.equal(rotated.json().ssh.knownHosts, pinned.json().ssh.knownHosts);
  assert.equal((await app.inject({ method: 'PUT', url: `${base}/git`, headers, payload: { username: 'git', token: 'secret' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'DELETE', url: `${base}/ssh`, headers })).json().ssh.configured, false); assert.deepEqual(stored, {});
});

test('SSH asynchronous issuance rechecks revocation, busy state, source and competing credential changes', async t => {
  for (const scenario of ['permission', 'busy', 'source', 'credential'] as const) {
    const app = Fastify(); t.after(() => app.close()); const s = service(); const old = await credential(s); let stored: ServiceSourceCredentials = { ssh: old }, calls = 0, writes = 0, busy = false;
    app.setErrorHandler((error, _request, reply) => reply.status((error as { statusCode?: number }).statusCode || 500).send({ error: (error as Error).message }));
    registerSourceCredentials(app, { getService: () => s, getCredentials: () => stored, setCredentials: (_id, value) => { writes++; stored = value; }, authorize: () => { if (++calls === 2) { if (scenario === 'permission') throw Object.assign(Error('Revoked'), { statusCode: 403 }); if (scenario === 'busy') busy = true; if (scenario === 'source') s.source.repository = 'git@forge.example.test:other.git'; if (scenario === 'credential') stored = {}; } }, requireIdle: () => { if (busy) throw Object.assign(Error('Busy'), { statusCode: 409 }); } });
    const response = await app.inject({ method: 'POST', url: `/api/services/${s.id}/source-credentials/ssh/rotate`, payload: {} });
    assert.equal(response.statusCode, scenario === 'permission' ? 403 : 409, `${scenario}: ${response.body}`); assert.equal(writes, 0);
    if (scenario !== 'credential') assert.equal(stored.ssh?.privateKey, old.privateKey);
  }
});

test('killing a timed-out real Git process terminates its blocked SSH child before helper cleanup', async () => {
  const s = service(), c = await credential(s); Object.assign(c, await validateSshKnownHosts(c.repository, hostEntry(c.repository, c.publicKey)));
  const fakeBin = await mkdtemp(join(tmpdir(), 'hl-ssh-timeout-')), pidfile = join(fakeBin, 'pid');
  await writeFile(join(fakeBin, 'ssh'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidfile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n`, { mode: 0o700 });
  let directory = '', pid = 0;
  const started = Date.now();
  try {
    await assert.rejects(withGitSourceCredentials(c.repository, c, async context => {
      directory = context.cwd;
      await command('git', [...context.args, 'ls-remote', '--', context.repository], { cwd: context.cwd, env: context.env, timeout: 2000 });
    }, { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` }), /timed out/);
    assert.ok(Date.now() - started < 6000, 'SSH must stop within the bounded kill grace period.');
    pid = Number(await readFile(pidfile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    await assert.rejects(stat(directory), { code: 'ENOENT' });
  } finally {
    if (!pid) try { pid = Number(await readFile(pidfile, 'utf8')); } catch {}
    if (pid) try { process.kill(pid, 'SIGKILL'); } catch {}
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test('SSH restart reaper removes only owned UUID workspaces and refuses symlink roots or managed entries', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'hl-ssh-reaper-')), directory = join(parent, 'credentials'), outside = join(parent, 'outside');
  try {
    initializeSshCredentialDirectory(directory);
    for (const prefix of ['key', 'git']) { const child = join(directory, `${prefix}-${randomUUID()}`); await mkdir(child); await writeFile(join(child, 'identity'), 'private fixture'); }
    await mkdir(join(directory, 'unknown-user-directory')); await mkdir(outside); await writeFile(join(outside, 'keep'), 'safe');
    initializeSshCredentialDirectory(directory);
    assert.deepEqual(await readdir(directory), ['unknown-user-directory']);
    const link = join(directory, `git-${randomUUID()}`); await symlink(outside, link);
    assert.throws(() => initializeSshCredentialDirectory(directory), /unexpected managed entry/); assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'safe');
    const rootLink = join(parent, 'linked-root'); await symlink(directory, rootLink); assert.throws(() => initializeSshCredentialDirectory(rootLink), /real directory/);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('SIGKILL before the SSH wrapper starts leaves a known workspace that restart safely erases', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'hl-ssh-crash-')), directory = join(parent, 'credentials');
  initializeSshCredentialDirectory(directory);
  const s = service(), c = await credential(s); Object.assign(c, await validateSshKnownHosts(c.repository, hostEntry(c.repository, c.publicKey)));
  const moduleUrl = new URL('./source-credentials.ts', import.meta.url).href;
  const script = `import {withGitSourceCredentials} from ${JSON.stringify(moduleUrl)};let input='';for await(const chunk of process.stdin)input+=chunk;const c=JSON.parse(input);await withGitSourceCredentials(c.repository,c,async context=>{process.stdout.write(context.cwd+'\\n');await new Promise(()=>{});},process.env,${JSON.stringify(directory)});`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit'); child.stdin.end(JSON.stringify(c));
  let controlDirectory = '';
  try {
    const ready = await Promise.race([once(child.stdout, 'data').then(([chunk]) => String(chunk).trim()), exited.then(() => { throw new Error(`Child exited before ready: ${stderr}`); })]);
    const wrapper = await readFile(join(ready, 'ssh.cjs'), 'utf8'), control = /const socket = connect\(("[^"\n]+")\)/.exec(wrapper); assert.ok(control); controlDirectory = dirname(JSON.parse(control[1]));
    assert.equal(await readFile(join(ready, 'identity'), 'utf8'), c.privateKey);
    child.kill('SIGKILL'); const [, signal] = await exited; assert.equal(signal, 'SIGKILL');
    assert.equal((await readdir(directory)).length, 1);
    initializeSshCredentialDirectory(directory); assert.deepEqual(await readdir(directory), []);
  } finally { child.kill('SIGKILL'); await exited; await rm(parent, { recursive: true, force: true }); if (controlDirectory) await rm(controlDirectory, { recursive: true, force: true }); }
});

test('SIGKILL of the panel closes its SSH transport even when the SSH child ignores SIGTERM', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'hl-ssh-parent-crash-')), directory = join(parent, 'credentials'), pidfile = join(parent, 'pid');
  initializeSshCredentialDirectory(directory);
  await writeFile(join(parent, 'ssh'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidfile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n`, { mode: 0o700 });
  const s = service(), c = await credential(s); Object.assign(c, await validateSshKnownHosts(c.repository, hostEntry(c.repository, c.publicKey)));
  const moduleUrl = new URL('./source-credentials.ts', import.meta.url).href, dockerUrl = new URL('./docker.ts', import.meta.url).href;
  const script = `import {withGitSourceCredentials} from ${JSON.stringify(moduleUrl)};import {command} from ${JSON.stringify(dockerUrl)};let input='';for await(const chunk of process.stdin)input+=chunk;const c=JSON.parse(input);await withGitSourceCredentials(c.repository,c,async context=>{process.stdout.write(context.cwd+'\\n');await command('git',[...context.args,'ls-remote','--',context.repository],{cwd:context.cwd,env:context.env,timeout:30000});},process.env,${JSON.stringify(directory)});`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), env: { ...process.env, PATH: `${parent}:${process.env.PATH}` }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '', controlDirectory = '', pid = 0; child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit'); child.stdin.end(JSON.stringify(c));
  try {
    const ready = await Promise.race([once(child.stdout, 'data').then(([chunk]) => String(chunk).trim()), exited.then(() => { throw new Error(`Child exited before ready: ${stderr}`); })]);
    const wrapper = await readFile(join(ready, 'ssh.cjs'), 'utf8'), control = /const socket = connect\(("[^"\n]+")\)/.exec(wrapper); assert.ok(control); controlDirectory = dirname(JSON.parse(control[1]));
    for (let index = 0; index < 100 && !pid; index++) { try { pid = Number(await readFile(pidfile, 'utf8')); } catch { await new Promise(resolve => setTimeout(resolve, 20)); } }
    assert.ok(pid, 'SSH child must start before the panel is killed.');
    child.kill('SIGKILL'); assert.equal((await exited)[1], 'SIGKILL');
    let stopped = false;
    for (let index = 0; index < 150 && !stopped; index++) { try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 20)); } catch { stopped = true; } }
    assert.equal(stopped, true, 'Parent socket disappearance must terminate SSH within its grace period.');
    initializeSshCredentialDirectory(directory); assert.deepEqual(await readdir(directory), []);
  } finally { child.kill('SIGKILL'); await exited; if (pid) try { process.kill(pid, 'SIGKILL'); } catch {} await rm(parent, { recursive: true, force: true }); if (controlDirectory) await rm(controlDirectory, { recursive: true, force: true }); }
});

test('SIGKILL of only the SSH guardian fails the Git job promptly and erases the private key', async () => {
  const fakeBin = await mkdtemp(join(tmpdir(), 'hl-ssh-guardian-crash-')), pidfile = join(fakeBin, 'pids');
  await writeFile(join(fakeBin, 'ssh'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidfile)}, JSON.stringify({ssh:process.pid,guardian:process.ppid})); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);\n`, { mode: 0o700 });
  const s = service(), c = await credential(s); Object.assign(c, await validateSshKnownHosts(c.repository, hostEntry(c.repository, c.publicKey)));
  let directory = '', pids: { ssh: number; guardian: number } | undefined, settled = false;
  const job = withGitSourceCredentials(c.repository, c, async context => {
    directory = context.cwd;
    await command('git', [...context.args, 'ls-remote', '--', context.repository], { cwd: context.cwd, env: context.env, timeout: 10000 });
  }, { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` });
  const outcome = job.then(() => { settled = true; return undefined; }, error => { settled = true; return error as Error; });
  try {
    for (let index = 0; index < 200 && !pids; index++) { try { pids = JSON.parse(await readFile(pidfile, 'utf8')); } catch { await new Promise(resolve => setTimeout(resolve, 20)); } }
    assert.ok(pids, 'SSH and guardian must exist before the fault is injected.');
    process.kill(pids.guardian, 'SIGKILL');
    for (let index = 0; index < 150 && !settled; index++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(settled, true, 'Guardian loss must fail promptly instead of waiting for inherited Git pipes.');
    const failure = await outcome;
    assert.match(failure?.message || '', /SSH transport cleanup could not be verified/);
    assert.ok(!failure?.message.includes(c.privateKey));
    await assert.rejects(stat(directory), { code: 'ENOENT' });
    // A deliberately killed guardian cannot attest SSH termination. The fixture owns and
    // explicitly reaps its recorded fake child; production never kills an unverified PID.
  } finally {
    if (pids) for (const pid of [pids.guardian, pids.ssh]) try { process.kill(pid, 'SIGKILL'); } catch {}
    await outcome; await rm(fakeBin, { recursive: true, force: true });
  }
});
