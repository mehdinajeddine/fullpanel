import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { effectiveSshCredential, generateSshKeyPair, GITHUB_HOST_FINGERPRINT, GITHUB_KNOWN_HOSTS, parseSshRepository, validateSshKnownHosts, type GitSshCredential } from './git-ssh.js';
import { resolveSourceCredentials, withGitSourceCredentials } from './source-credentials.js';
import type { Service } from '../shared/types.js';

function credential(repository: string): GitSshCredential {
  return { serviceId: randomUUID(), repository, privateKey: 'private fixture', publicKey: 'public fixture', fingerprint: 'fingerprint fixture', updatedAt: '2026-01-01T00:00:00.000Z' };
}

test('the bundled GitHub Ed25519 host key matches its published SHA256 fingerprint and OpenSSH validation', async () => {
  const blob = Buffer.from(GITHUB_KNOWN_HOSTS.trim().split(' ')[2], 'base64');
  assert.equal('SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, ''), 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU');
  const verified = await validateSshKnownHosts('git@github.com:team/app.git', GITHUB_KNOWN_HOSTS);
  assert.deepEqual(verified, { knownHosts: GITHUB_KNOWN_HOSTS, hostFingerprints: [GITHUB_HOST_FINGERPRINT] });
});

test('published trust applies only to normalized github.com port 22 and leaves private state untouched', () => {
  for (const repository of ['git@github.com:team/app.git', 'git@GITHUB.COM:team/app.git', 'ssh://git@GitHub.COM:22/team/app.git']) {
    for (const knownHosts of [undefined, '']) {
      const stored = Object.freeze({ ...credential(repository), knownHosts });
      const before = JSON.stringify(stored), effective = effectiveSshCredential(stored);
      assert.equal(effective.hostKeySource, 'github-published');
      assert.equal(effective.knownHosts, GITHUB_KNOWN_HOSTS);
      assert.deepEqual(effective.hostFingerprints, [GITHUB_HOST_FINGERPRINT]);
      assert.equal(effective.hostKeyUpdatedAt, undefined);
      assert.equal(effective.updatedAt, stored.updatedAt);
      assert.equal(JSON.stringify(stored), before);
    }
  }
  for (const repository of ['git@github.com.evil.test:team/app.git', 'git@ssh.github.com:team/app.git', 'ssh://git@github.com:443/team/app.git', 'git@localhost:team/app.git', 'git@gitlab.com:team/app.git']) {
    const effective = effectiveSshCredential(credential(repository));
    assert.equal(effective.knownHosts, undefined, repository); assert.equal(effective.hostKeySource, undefined, repository);
  }
});

test('saved manual pins always override published trust, including different keys and invalid whitespace', async () => {
  const repository = 'git@github.com:team/app.git', stored = credential(repository);
  const generated = await generateSshKeyPair(stored.serviceId);
  const manual = await validateSshKnownHosts(repository, `github.com ${generated.publicKey}`);
  assert.notEqual(manual.knownHosts, GITHUB_KNOWN_HOSTS);
  for (const knownHosts of [manual.knownHosts, ' \n\t', 'invalid pin']) {
    const pinned = { ...stored, ...generated, knownHosts, hostFingerprints: manual.hostFingerprints, hostKeyUpdatedAt: '2026-01-02T00:00:00.000Z' };
    const effective = effectiveSshCredential(pinned);
    assert.equal(effective.knownHosts, knownHosts); assert.equal(effective.hostKeySource, 'manual');
    assert.equal(effective.hostKeyUpdatedAt, pinned.hostKeyUpdatedAt);
    if (knownHosts !== manual.knownHosts) await assert.rejects(withGitSourceCredentials(repository, pinned, async () => { assert.fail('Invalid explicit trust must not fall back to GitHub.'); }), /exact-host keys|exact host/);
  }
});

test('existing GitHub credentials without saved trust resolve and stage the published pin with strict SSH options', async () => {
  const stored = credential('git@github.com:team/app.git');
  Object.assign(stored, await generateSshKeyPair(stored.serviceId));
  const service: Service = { id: stored.serviceId, projectId: randomUUID(), name: 'github', kind: 'app', status: 'not-deployed', source: { type: 'git', repository: stored.repository, branch: 'main' }, env: {}, domains: [], mounts: [], ports: [], resources: { cpu: 1, memoryMb: 128 }, notes: '', createdAt: stored.updatedAt, updatedAt: stored.updatedAt };
  const resolved = resolveSourceCredentials(service, { ssh: stored });
  assert.equal(resolved.ssh?.knownHosts, GITHUB_KNOWN_HOSTS); assert.equal(stored.knownHosts, undefined);
  let directory = '';
  await withGitSourceCredentials(stored.repository, stored, async context => {
    directory = context.cwd;
    assert.equal(await readFile(join(directory, 'known_hosts'), 'utf8'), GITHUB_KNOWN_HOSTS);
    const wrapper = await readFile(context.env.GIT_SSH!, 'utf8');
    assert(wrapper.includes('StrictHostKeyChecking=yes')); assert(wrapper.includes('UpdateHostKeys=no'));
  });
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  const otherRepository = 'ssh://git@github.com:443/team/app.git';
  await assert.rejects(withGitSourceCredentials(otherRepository, { ...stored, repository: parseSshRepository(otherRepository).repository }, async () => assert.fail('Unknown trust must refuse deployment.')), error => error instanceof Error && 'statusCode' in error && error.statusCode === 409);
  assert.equal(stored.knownHosts, undefined);
});
