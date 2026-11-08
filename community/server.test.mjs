import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, symlink, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createCommunityServer, loadConfig, publicInfo } from './server.mjs';

async function fixture(t, environment = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'fullpanel-community-')), publicDirectory = join(directory, 'public');
  await mkdir(publicDirectory); await mkdir(join(publicDirectory, 'assets'));
  await writeFile(join(publicDirectory, 'index.html'), '<!doctype html><title>FullPanel</title>');
  await writeFile(join(publicDirectory, 'styles.css'), 'body{color:black}');
  await writeFile(join(publicDirectory, 'assets', 'inter.woff2'), 'font fixture');
  await writeFile(join(directory, 'secret.txt'), 'private fixture');
  await symlink(join(directory, 'secret.txt'), join(publicDirectory, 'escaped.txt'));
  await symlink(directory, join(publicDirectory, 'linked'));
  const server = await createCommunityServer({ publicDirectory, config: loadConfig(environment) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  function request(path = '/', { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method, headers, agent: false }, response => {
        let text = ''; response.setEncoding('utf8'); response.on('data', data => { text += data; });
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: text }));
      });
      req.setTimeout(3000, () => req.destroy(new Error('Test request timeout')));
      req.on('error', reject); req.end(body);
    });
  }
  return { request, directory, publicDirectory, server };
}

test('public API reports only process health, whitelisted metadata and a disabled planned domain service', async t => {
  const f = await fixture(t, { COMMUNITY_RELEASE_COMMIT: 'a'.repeat(40), DATABASE_URL: 'never-return-this', HEROKU_API_KEY: 'never-return-this' });
  const health = await f.request('/api/health'); assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { status: 'ok', service: 'fullpanel-community' });
  const info = await f.request('/api/v1/info'); assert.equal(info.status, 200);
  assert.equal(info.headers['cache-control'], 'no-store');
  const data = JSON.parse(info.body);
  assert.deepEqual(Object.keys(data).sort(), ['apiVersion', 'communityDomains', 'links', 'name', 'openSource', 'release']);
  assert.deepEqual(data.communityDomains, { status: 'planned', registrationEnabled: false });
  assert.equal(data.openSource.license, 'Apache-2.0'); assert.equal(data.release.commit, 'a'.repeat(40));
  assert(!info.body.includes('never-return-this'));
  const head = await f.request('/api/v1/info', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.body, ''); assert.equal(head.headers['content-length'], info.headers['content-length']);
  assert.equal(publicInfo(loadConfig({})).release.commit, null);
});

test('static GET/HEAD support explicit content types, safe validators and real 404 responses', async t => {
  const f = await fixture(t);
  const page = await f.request('/'); assert.equal(page.status, 200); assert.match(page.headers['content-type'], /^text\/html/);
  assert.equal(page.headers['cache-control'], 'public, max-age=0, must-revalidate');
  const head = await f.request('/', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.body, ''); assert.equal(head.headers['content-length'], page.headers['content-length']);
  const cached = await f.request('/', { headers: { 'if-none-match': page.headers.etag } }); assert.equal(cached.status, 304); assert.equal(cached.body, '');
  const css = await f.request('/styles.css?v=1'); assert.equal(css.status, 200); assert.match(css.headers['content-type'], /^text\/css/); assert.equal(css.headers['cache-control'], 'public, max-age=3600');
  assert.equal((await f.request('/assets/inter.woff2')).headers['content-type'], 'font/woff2');
  for (const path of ['/missing', '/api/no-such-route', '/assets/', '/api/health/']) {
    const response = await f.request(path); assert.equal(response.status, 404, path); assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(JSON.parse(response.body).error.code, 'NOT_FOUND'); assert(!response.body.includes(f.directory));
  }
});

test('encoded traversal, double escaping, hidden files and symlinks cannot escape the public directory', async t => {
  const f = await fixture(t);
  for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/%252e%252e/secret.txt', '/assets/%2f..%2fsecret.txt', '/assets/%5c..%5csecret.txt', '/%00secret.txt', '/%E0%A4%A', '/.env', '//evil.example/secret.txt', '/assets//inter.woff2', '/assets/./inter.woff2']) {
    const response = await f.request(path); assert.equal(response.status, 400, path); assert(!response.body.includes('private fixture'));
  }
  for (const path of ['/escaped.txt', '/linked/secret.txt']) {
    const response = await f.request(path); assert.equal(response.status, 404); assert(!response.body.includes('private fixture'));
  }
  const oversized = await f.request('/' + 'a'.repeat(2048)); assert.equal(oversized.status, 400);
});

test('disabled registration rejects POST without reflecting or retaining a submitted token', async t => {
  const f = await fixture(t);
  for (const path of ['/api/v1/community-domains', '/api/v1/community-domains/register']) {
    const response = await f.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"token":"do-not-process-secret"}' });
    assert.equal(response.status, 503); assert.equal(response.headers.connection, 'close'); assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(JSON.parse(response.body).error.code, 'COMMUNITY_DOMAINS_UNAVAILABLE'); assert(!response.body.includes('do-not-process-secret'));
  }
  assert.equal((await f.request('/api/unknown', { method: 'POST', body: 'secret' })).status, 404);
  assert.equal((await f.request('/api/v1/community-domains/register', { method: 'POST', headers: { 'content-length': '1073741824' } })).status, 503, 'Disabled registration must respond without awaiting a declared upload.');
  const refused = await f.request('/api/health', { method: 'POST', body: 'secret' }); assert.equal(refused.status, 405); assert.equal(refused.headers.allow, 'GET, HEAD');
  assert.equal((await f.request('/api/health', { headers: { 'content-length': '4' }, body: 'body' })).status, 413);
  assert.equal((await f.request('/api/v1/community-domains', { method: 'POST', headers: { Expect: '100-continue' } })).status, 417);
  assert.equal((await f.request('/api/health', { headers: { 'x-oversized': 'a'.repeat(9000) } })).status, 431);
});

test('security headers cover successful and failed requests; forwarded protocol is ignored by default', async t => {
  const f = await fixture(t);
  for (const path of ['/', '/api/health', '/not-found']) {
    const response = await f.request(path, { headers: { 'x-forwarded-proto': 'http', host: 'attacker.example' } });
    assert.equal(response.headers['x-content-type-options'], 'nosniff'); assert.equal(response.headers['x-frame-options'], 'DENY');
    assert(response.headers['content-security-policy'].includes("default-src 'none'")); assert(response.headers['content-security-policy'].includes("script-src 'self'"));
    assert(!response.headers['content-security-policy'].includes('unsafe-inline')); assert.equal(response.headers.location, undefined); assert.equal(response.headers['strict-transport-security'], undefined);
  }
});

test('explicit Heroku mode redirects only to validated canonical host and rejects ambiguous proxy headers', async t => {
  const f = await fixture(t, { COMMUNITY_TRUST_HEROKU_PROXY: 'true', COMMUNITY_CANONICAL_HOST: 'www.fullpanel.io' });
  const redirect = await f.request('/?source=heroku', { headers: { host: 'attacker.example', 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'http' } });
  assert.equal(redirect.status, 308); assert.equal(redirect.headers.location, 'https://www.fullpanel.io/?source=heroku');
  assert.equal((await f.request('/', { headers: { host: 'attacker.example', 'x-forwarded-proto': 'https' } })).status, 421);
  for (const protocol of [undefined, 'https,http', 'ftp']) assert.equal((await f.request('/', { headers: { host: 'www.fullpanel.io', ...(protocol ? { 'x-forwarded-proto': protocol } : {}) } })).status, 400);
  const okay = await f.request('/api/health', { headers: { host: 'www.fullpanel.io', 'x-forwarded-proto': 'https' } }); assert.equal(okay.status, 200); assert.match(okay.headers['strict-transport-security'], /max-age=/);
});

test('configuration accepts no arbitrary public metadata or unsafe canonical redirect authority', () => {
  for (const host of ['https://fullpanel.io', 'fullpanel.io:443', 'fullpanel.io/evil', 'fullpanel.io\n', 'user@fullpanel.io', 'fullpanel.io?x=y', 'UPPER.EXAMPLE', '']) {
    assert.throws(() => loadConfig({ COMMUNITY_TRUST_HEROKU_PROXY: 'true', COMMUNITY_CANONICAL_HOST: host }), /HOST|hostname/);
  }
  for (const commit of ['short', 'a'.repeat(40) + '\n', 'G'.repeat(40)]) assert.throws(() => loadConfig({ COMMUNITY_RELEASE_COMMIT: commit }), /commit SHA/);
  assert.throws(() => loadConfig({ COMMUNITY_TRUST_HEROKU_PROXY: 'yes' }));
  for (const port of ['-1', '65536', '1.2', 'not-a-port', '80\n']) assert.throws(() => loadConfig({ PORT: port }));
});

test('the standalone process handles SIGTERM with a clean bounded exit', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fullpanel-community-process-'));
  await mkdir(join(directory, 'public'));
  await writeFile(join(directory, 'public', 'index.html'), '<title>Process fixture</title>');
  await copyFile(new URL('./server.mjs', import.meta.url), join(directory, 'server.mjs'));
  const child = spawn(process.execPath, [join(directory, 'server.mjs')], { env: { PATH: process.env.PATH, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; await rm(directory, { recursive: true, force: true }); });
  const deadline = Date.now() + 3000;
  while (!output.includes('listening on port') && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(output, /listening on port/, errors);
  child.kill('SIGTERM');
  const result = await Promise.race([exited, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('SIGTERM timeout')), 3000); timer.unref(); })]);
  assert.deepEqual(result, [0, null]);
});
