import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isPublicTestDomainIp, testDomainHostname } from '../../shared/test-domains.js';
import { milestoneFixture } from './milestone-fixture.js';

const rejected = ['0.0.0.0', '0.8.8.8', '10.0.0.1', '100.64.0.0', '100.127.255.255', '127.1.2.3', '169.254.8.8', '172.16.0.1', '172.31.255.255', '192.0.0.9', '192.0.2.1', '192.31.196.1', '192.52.193.1', '192.88.99.1', '192.168.1.1', '192.175.48.1', '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255', '8.8.8.256', '08.8.8.8', '8.008.8.8', '8.8.8', '8.8.8.8.', ' 8.8.8.8', '8.8.8.8 ', '8.8.8.8\n', '134744072', '0x08080808', 'https://8.8.8.8', '8.8.8.8:80', 'example.com', '::1', '::ffff:8.8.8.8', '2606:4700:4700::1111'];

test('test hostname input excludes malformed, noncanonical and special-use IPv4 addresses without DNS', () => {
  for (const value of rejected) assert.equal(isPublicTestDomainIp(value), false, value);
  for (const value of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '100.63.255.254', '100.128.0.1', '172.15.255.254', '172.32.0.1', '192.169.0.1', '198.17.255.254', '198.20.0.1', '223.255.255.254']) assert.equal(isPublicTestDomainIp(value), true, value);
  const id = randomUUID();
  assert.equal(testDomainHostname(id, '8.8.8.8'), `fp-${id.replaceAll('-', '')}.8-8-8-8.sslip.io`);
  assert.throws(() => testDomainHostname('hostname-injection.example', '8.8.8.8'));
  assert.throws(() => testDomainHostname(`${id}\n`, '8.8.8.8'));
  assert.throws(() => testDomainHostname(id, '127.0.0.1'));
});

test('test IP settings require browser administrator authority and reject invalid inputs without changing saved settings', async t => {
  const f = await milestoneFixture(); t.after(f.close);
  const viewer = await f.user('domain-viewer', 'viewer'), operator = await f.user('domain-operator', 'operator');
  for (const cookie of [viewer.cookie, operator.cookie]) {
    assert.equal((await f.request('GET', '/settings', undefined, cookie)).statusCode, 403);
    assert.equal((await f.request('PATCH', '/settings', { testDomainIp: '8.8.8.8' }, cookie)).statusCode, 403);
  }
  assert.equal((await f.request('PATCH', '/settings', { testDomainIp: '8.8.8.8' }, '')).statusCode, 401);
  const key = (await f.request('POST', '/api-keys', { name: 'domain-test', projectIds: [f.project.id], permission: 'write' })).json();
  assert.equal((await f.request('PATCH', '/settings', { testDomainIp: '8.8.8.8' }, key.token)).statusCode, 403);
  assert.equal((await f.request('PATCH', '/settings', { testDomainIp: '8.8.8.8' })).statusCode, 200);
  for (const value of [...rejected, null, 134744072]) assert.equal((await f.request('PATCH', '/settings', { testDomainIp: value })).statusCode, 400, String(value));
  assert.equal((await f.request('GET', '/settings')).json().testDomainIp, '8.8.8.8');
  const admin = (await f.request('POST', '/users', { name: 'Domain admin', email: 'domain-admin@example.test', password: 'domain-admin-password-12345', role: 'admin', memberships: [] })).json();
  const login = await f.request('POST', '/auth/login', { email: admin.email, password: 'domain-admin-password-12345' }, '');
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  assert.equal((await f.request('PATCH', '/settings', { testDomainIp: '1.1.1.1' }, cookie)).statusCode, 200);
});

test('test hostnames are opt-in, app-only, preserve explicit domains and use template target ports', async t => {
  const f = await milestoneFixture(); t.after(f.close);
  assert.equal((await f.request('GET', '/settings')).json().testDomainIp, '');
  const operator = await f.user('domain-creator', 'operator');
  const withoutSetting = await f.raw({ method: 'POST', url: '/api/services', headers: { cookie: operator.cookie, host: '8.8.8.8', 'x-forwarded-for': '1.1.1.1' }, payload: { projectId: f.project.id, name: 'no-discovery', kind: 'app' } });
  assert.equal(withoutSetting.statusCode, 201, withoutSetting.body); assert.deepEqual(withoutSetting.json().domains, []);
  await f.request('PATCH', '/settings', { testDomainIp: '8.8.8.8' });
  const created = await f.request('POST', '/services', { projectId: f.project.id, name: 'allocated', kind: 'app' }, operator.cookie);
  assert.equal(created.statusCode, 201, created.body); const app = created.json();
  assert.equal(app.domains[0].hostname, testDomainHostname(app.id, '8.8.8.8'));
  assert.deepEqual({ port: app.domains[0].port, https: app.domains[0].https, path: app.domains[0].path }, { port: 80, https: false, path: '/' });
  for (const kind of ['postgres', 'mysql', 'mariadb', 'mongo', 'redis', 'compose']) assert.deepEqual((await f.create({ kind, name: `private-${kind}` })).domains, []);
  assert.deepEqual((await f.create({ name: 'opt-out', domains: [] })).domains, []);
  const explicit = [{ id: randomUUID(), hostname: 'chosen.example.test', port: 8080, https: true, path: '/app' }];
  assert.deepEqual((await f.create({ name: 'explicit', domains: explicit })).domains, explicit);
  const template = await f.request('POST', '/templates/dozzle/install', { projectId: f.project.id, name: 'template' });
  assert.equal(template.statusCode, 201, template.body); const installed = template.json();
  assert.equal(installed.domains[0].hostname, testDomainHostname(installed.id, '8.8.8.8')); assert.equal(installed.domains[0].port, 8080); assert.equal(installed.domains[0].https, false);
  assert.deepEqual((await f.request('GET', `/services/${withoutSetting.json().id}`)).json().domains, []);
});

test('base domain keeps precedence and disabling test domains changes only future services', async t => {
  const f = await milestoneFixture(); t.after(f.close);
  await f.request('PATCH', '/settings', { baseDomain: 'apps.example.test', testDomainIp: '8.8.8.8' });
  const custom = await f.create({ name: 'custom' });
  assert.equal(custom.domains[0].hostname, 'custom-alpha.apps.example.test'); assert.equal(custom.domains[0].https, true);
  await f.request('PATCH', '/settings', { baseDomain: '' });
  const generated = await f.create({ name: 'generated' });
  await f.request('PATCH', '/settings', { testDomainIp: '' });
  assert.deepEqual((await f.create({ name: 'disabled' })).domains, []);
  assert.deepEqual((await f.request('GET', `/services/${generated.id}`)).json().domains, generated.domains);
  assert.deepEqual((await f.request('GET', `/services/${custom.id}`)).json().domains, custom.domains);
});

test('allocated hostnames survive renaming, source changes and encrypted restart; replacement gets a new UUID host', async t => {
  const f = await milestoneFixture(); t.after(f.close);
  await f.request('PATCH', '/settings', { testDomainIp: '8.8.8.8' });
  const original = await f.create();
  assert.equal((await f.request('PATCH', `/services/${original.id}`, { name: 'renamed', source: { type: 'dockerfile', dockerfile: 'FROM nginx:1.28-alpine' } })).statusCode, 200);
  assert.equal((await f.request('PATCH', `/projects/${f.project.id}`, { name: 'renamed-project' })).statusCode, 200);
  await f.reopen();
  assert.equal((await f.request('GET', '/settings')).json().testDomainIp, '8.8.8.8');
  assert.deepEqual((await f.request('GET', `/services/${original.id}`)).json().domains, original.domains);
  assert.equal((await f.request('DELETE', `/services/${original.id}`)).statusCode, 200);
  const replacement = await f.create({ name: 'renamed' });
  assert.notEqual(replacement.id, original.id); assert.notEqual(replacement.domains[0].hostname, original.domains[0].hostname);
  assert.equal(replacement.domains[0].hostname, testDomainHostname(replacement.id, '8.8.8.8'));
  await f.request('PATCH', '/settings', { testDomainIp: '1.1.1.1' });
  assert.deepEqual((await f.request('GET', `/services/${replacement.id}`)).json().domains, replacement.domains);
  assert.equal((await f.create({ name: 'new-address' })).domains[0].hostname.endsWith('.1-1-1-1.sslip.io'), true);
});

test('legacy settings acquire a disabled test domain option without migrating existing routes', async t => {
  const f = await milestoneFixture(); t.after(f.close);
  const service = await f.create({ domains: [{ hostname: 'existing.example.test', port: 80, https: true, path: '/' }] });
  await f.reopen(store => { delete store.state.settings.testDomainIp; });
  assert.equal((await f.request('GET', '/settings')).json().testDomainIp, '');
  assert.deepEqual((await f.request('GET', `/services/${service.id}`)).json().domains, service.domains);
  assert.deepEqual((await f.create({ name: 'legacy-disabled' })).domains, []);
});
