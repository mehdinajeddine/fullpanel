import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { milestoneFixture } from './milestone-fixture.js';

test('SSH keys enforce project authorization, survive encrypted restart and are revoked on source changes', async t => {
  const f = await milestoneFixture(); t.after(f.close);
  const service = await f.create({ source: { type: 'git', repository: 'git@localhost:private/repo.git', branch: 'main' } });
  const other = await f.create({ projectId: f.otherProject.id, name: 'other', source: { type: 'git', repository: 'git@localhost:private/other.git' } });
  const viewer = await f.user('sshviewer', 'viewer'), operator = await f.user('sshoperator', 'operator');
  const base = `/services/${service.id}/source-credentials`;
  assert.equal((await f.request('GET', base, undefined, viewer.cookie)).statusCode, 403);
  assert.equal((await f.request('POST', `${base}/ssh/rotate`, {}, viewer.cookie)).statusCode, 403);
  assert.equal((await f.request('POST', `/services/${other.id}/source-credentials/ssh/rotate`, {}, operator.cookie)).statusCode, 404);
  const generated = await f.request('POST', `${base}/ssh/rotate`, {}, operator.cookie);
  assert.equal(generated.statusCode, 200, generated.body); const publicKey = generated.json().ssh.publicKey;
  const pin = `localhost ${publicKey.split(' ').slice(0, 2).join(' ')}`;
  assert.equal((await f.request('PUT', `${base}/ssh/host-key`, { knownHosts: pin }, operator.cookie)).statusCode, 200);
  const encrypted = await readFile(join(f.directory, 'state.enc'), 'utf8');
  assert.ok(!encrypted.includes('PRIVATE KEY')); assert.ok(!encrypted.includes(publicKey));
  await f.reopen();
  const status = (await f.request('GET', base, undefined, operator.cookie)).json(); assert.equal(status.ssh.publicKey, publicKey); assert.equal(status.ssh.hostKeyConfigured, true);
  for (const path of ['/services', '/overview', `/services/${service.id}`]) { const response = await f.request('GET', path); assert.ok(!response.body.includes('PRIVATE KEY')); assert.ok(!response.body.includes(publicKey)); }
  assert.equal((await f.request('PATCH', `/services/${service.id}`, { source: { type: 'git', repository: 'git@localhost:private/repo.git', branch: 'release' } }, operator.cookie)).statusCode, 200);
  assert.equal((await f.request('GET', base, undefined, operator.cookie)).json().ssh.publicKey, publicKey);
  assert.equal((await f.request('PATCH', `/services/${service.id}`, { source: { type: 'git', repository: 'git@localhost:private/changed.git', branch: 'release' } }, operator.cookie)).statusCode, 200);
  assert.equal((await f.request('GET', base, undefined, operator.cookie)).json().ssh.configured, false);
});
