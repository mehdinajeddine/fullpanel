import test from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { DOMAIN_PROOF_LIMITS, DOMAIN_PROOF_PATH, isPublicProofIpv4, createDomainProof, expectedDomainProof, createDomainProofVerifier } from './domain-proof.mjs';

// No HTTP server, DNS resolver, native socket, or Internet connection is used.
// Native node:http parses bytes received through these in-memory Duplex sockets.
const NOW = Date.parse('2026-11-08T12:00:00.000Z');
const binding = Object.freeze({ installationId: '4d2cda40-f289-4a51-9e43-1ed1257aa2e8', serverId: `s-${'a'.repeat(32)}`, ipv4: '8.8.8.8' });
const newProof = (input = {}) => createDomainProof({ ...binding, ...input }, { clock: () => NOW });
const failure = { ok: false, code: 'DOMAIN_PROOF_FAILED', message: 'Unable to verify server control.' };

class FixtureSocket extends Duplex {
  constructor(options, scenario) {
    super();
    this.connecting = true;
    this.remoteAddress = scenario.remoteAddress ?? options.host;
    this.remotePort = scenario.remotePort ?? 80;
    this.remoteFamily = scenario.remoteFamily ?? 'IPv4';
    this.scenario = scenario;
    this.writes = [];
    this.timers = new Set();
    if (!scenario.noConnect) this.later(() => {
      scenario.beforeConnect?.(this);
      this.connecting = false;
      this.emit('connect');
    }, scenario.connectDelay ?? 0);
  }
  _read() {}
  _write(chunk, _encoding, callback) {
    this.writes.push(Buffer.from(chunk));
    callback();
    if (!this.responded && Buffer.concat(this.writes).includes('\r\n\r\n')) {
      this.responded = true;
      this.later(() => this.scenario.respond?.(this), 0);
    }
  }
  _destroy(_error, callback) {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    callback();
  }
  later(callback, delay) {
    const timer = setTimeout(() => { this.timers.delete(timer); if (!this.destroyed) callback(); }, delay);
    this.timers.add(timer);
  }
  setTimeout() { return this; }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  ref() { return this; }
  unref() { return this; }
}
function transport(scenario = {}) {
  const calls = [], sockets = [];
  return {
    calls, sockets,
    connect(options) {
      calls.push(options);
      const socket = new FixtureSocket(options, scenario);
      sockets.push(socket);
      return socket;
    },
  };
}
function response(body, { status = '200 OK', headers = {}, trailing = true } = {}) {
  return socket => {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    socket.push(Buffer.from(`HTTP/1.1 ${status}\r\nContent-Length: ${bytes.length}\r\nConnection: close\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}\r\n`).join('')}\r\n`));
    socket.push(bytes);
    if (trailing) socket.push(null);
  };
}
function verifier(fixture, options = {}) {
  return createDomainProofVerifier({ connect: fixture.connect, clock: () => NOW, connectionTimeoutMs: 50, totalTimeoutMs: 150, ...options });
}
const forbidden = [
  '0.0.0.0', '0.255.255.255', '10.0.0.0', '10.255.255.255', '100.64.0.0', '100.127.255.255', '100.100.100.200',
  '127.0.0.1', '127.255.255.255', '169.254.0.0', '169.254.169.254', '169.254.170.2', '169.254.255.255',
  '172.16.0.0', '172.31.255.255', '192.0.0.0', '192.0.0.9', '192.0.0.10', '192.0.0.170', '192.0.0.255',
  '192.0.2.0', '192.0.2.255', '192.31.196.1', '192.52.193.1', '192.88.99.1', '192.88.99.2', '192.168.0.0', '192.168.255.255', '192.175.48.1',
  '198.18.0.0', '198.19.255.255', '198.51.100.1', '203.0.113.1', '224.0.0.0', '239.255.255.255', '240.0.0.0', '255.255.255.255', '168.63.129.16',
  '', null, undefined, 134744072, {}, [], '8.8.8', '8.8.8.8.8', '8.8.8.256', '08.8.8.8', '8.008.8.8', '+8.8.8.8', '8.8.8.8\n', ' 8.8.8.8', '8.8.8.8 ',
  '0x08080808', '134744072', '0177.0.0.1', '127.1', '8.8.8.8:80', 'https://8.8.8.8', '８.８.８.８', '8.8.8.8\0', 'localhost', 'metadata.google.internal',
  '::1', '::ffff:8.8.8.8', '::ffff:127.0.0.1', '[8.8.8.8]', '[::1]', 'fe80::1%eth0',
];

test('only canonical ordinary public IPv4 destinations are accepted, including special-range boundaries', () => {
  for (const value of forbidden) assert.equal(isPublicProofIpv4(value), false, String(value));
  for (const value of ['1.1.1.1', '8.8.8.8', '9.9.9.9', '100.63.255.255', '100.128.0.0', '169.253.255.255', '169.255.0.0', '172.15.255.255', '172.32.0.0', '192.0.1.1', '192.0.3.1', '198.17.255.255', '198.20.0.0', '223.255.255.255']) {
    assert.equal(isPublicProofIpv4(value), true, value);
  }
});

test('challenges have independent 256-bit IDs/nonces, immutable binding, canonical dates and bounded TTL', () => {
  const first = newProof(), second = newProof();
  assert(Object.isFrozen(first));
  assert.match(first.id, /^[a-f0-9]{64}$/);
  assert.equal(Buffer.from(first.nonce, 'base64url').length, 32);
  assert.notEqual(first.id, second.id); assert.notEqual(first.nonce, second.nonce);
  assert.equal(first.createdAt, '2026-11-08T12:00:00.000Z');
  assert.equal(first.expiresAt, '2026-11-08T12:05:00.000Z');
  assert.throws(() => { first.ipv4 = '127.0.0.1'; }, TypeError);
  for (const ttlMs of [0, -1, 29_999, 600_001, NaN, Infinity, '300000', 30_000.1]) assert.throws(() => newProof({ ttlMs }), /Invalid domain proof request/);
  assert.equal(Date.parse(newProof({ ttlMs: 30_000 }).expiresAt) - NOW, 30_000);
  assert.equal(Date.parse(newProof({ ttlMs: 600_000 }).expiresAt) - NOW, 600_000);
  for (const input of [{ serverId: 'www' }, { serverId: `s-${'A'.repeat(32)}` }, { serverId: `s-${'a'.repeat(31)}` }, { serverId: `s-${'a'.repeat(32)}.evil.test` }, { serverId: binding.serverId + '\n' }, { installationId: binding.installationId + '\n' }, { installationId: binding.installationId.toUpperCase() }, { port: 8080 }, { path: '/metadata' }, { url: 'http://127.0.0.1' }]) assert.throws(() => newProof(input), /Invalid domain proof request/);
  assert.throws(() => createDomainProof(binding, { clock: () => NaN }), /Invalid domain proof request/);
  assert.throws(() => createDomainProof(binding, { clock: () => 253402300799999 }), /Invalid domain proof request/);
});

test('the exact expected response binds the challenge, installation, server, IPv4, nonce and lifetime', () => {
  const proof = newProof(), body = expectedDomainProof(proof);
  assert.equal(body, `fullpanel-domain-proof:v1\nchallenge=${proof.id}\ninstallation=${binding.installationId}\nserver=${binding.serverId}\nipv4=${binding.ipv4}\nnonce=${proof.nonce}\ncreated=${proof.createdAt}\nexpires=${proof.expiresAt}\n`);
  assert(Buffer.byteLength(body) < DOMAIN_PROOF_LIMITS.bodyBytes);
  for (const change of [{ id: 'b'.repeat(64) }, { installationId: randomUUID() }, { serverId: `s-${'b'.repeat(32)}` }, { ipv4: '1.1.1.1' }, { nonce: newProof().nonce }, { expiresAt: '2026-11-08T12:06:00.000Z' }]) {
    assert.notEqual(expectedDomainProof({ ...proof, ...change }), body);
  }
});

test('invalid destinations and bindings cause zero socket creation, even when injected transport could accept them', async () => {
  const fixture = transport(), verify = verifier(fixture), proof = newProof();
  for (const ipv4 of forbidden) {
    assert.deepEqual(await verify.verify({ ...proof, ipv4 }, { ...binding, ipv4 }), failure);
    assert.throws(() => newProof({ ipv4 }), /Invalid domain proof request/);
  }
  for (const input of [null, {}, { ...proof, port: 80 }, { ...proof, path: '/' }, { ...proof, host: 'evil.example' }, { ...proof, nonce: 'A'.repeat(42) }, { ...proof, id: '../secret' }, { ...proof, id: proof.id + '\n' }, { ...proof, version: 2 }, { ...proof, createdAt: '2026-11-08T12:00:00Z' }, { ...proof, expiresAt: '2026-11-08T12:20:00.000Z' }]) assert.deepEqual(await verify.verify(input, binding), failure);
  for (const other of [{ ...binding, installationId: randomUUID() }, { ...binding, serverId: `s-${'b'.repeat(32)}` }, { ...binding, ipv4: '1.1.1.1' }, { ...binding, url: 'http://example.com' }, undefined]) assert.deepEqual(await verify.verify(proof, other), failure);
  assert.equal(fixture.calls.length, 0);
});

test('expired/future challenges are refused before connecting; expiry is checked again before success', async () => {
  const proof = newProof();
  const empty = transport();
  for (const now of [NOW - 1, Date.parse(proof.expiresAt), Date.parse(proof.expiresAt) + 1, NaN]) {
    assert.deepEqual(await verifier(empty, { clock: () => now }).verify(proof, binding), failure);
  }
  assert.equal(empty.calls.length, 0);
  let now = NOW;
  const expiredDuringResponse = transport({ respond(socket) { now = Date.parse(proof.expiresAt); response(expectedDomainProof(proof))(socket); } });
  assert.deepEqual(await verifier(expiredDuringResponse, { clock: () => now }).verify(proof, binding), failure);
  assert.equal(expiredDuringResponse.calls.length, 1);
  now = NOW;
  const expiredBeforeHttp = transport({ beforeConnect() { now = Date.parse(proof.expiresAt); }, respond: response(expectedDomainProof(proof)) });
  assert.deepEqual(await verifier(expiredBeforeHttp, { clock: () => now }).verify(proof, binding), failure);
  assert.equal(expiredBeforeHttp.sockets[0].writes.length, 0);
  const nearExpiry = transport({ noConnect: true });
  const started = performance.now();
  assert.deepEqual(await verifier(nearExpiry, { clock: () => Date.parse(proof.expiresAt) - 5, connectionTimeoutMs: 1000, totalTimeoutMs: 2000 }).verify(proof, binding), failure);
  assert(performance.now() - started < 500, 'A nearly expired challenge has a shortened total deadline.');
});

test('native HTTP uses the fixed path, server Host and literal IPv4, with no proxy, DNS or authorization', async t => {
  const proof = newProof();
  const fixture = transport({ respond: response(expectedDomainProof(proof)) });
  for (const [key, value] of Object.entries({ HTTP_PROXY: 'http://127.0.0.1:9999', http_proxy: 'http://169.254.169.254', HTTPS_PROXY: 'http://127.0.0.1', NODE_USE_ENV_PROXY: '1' })) {
    const old = process.env[key]; process.env[key] = value;
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
  const result = await verifier(fixture).verify(proof, binding);
  assert.deepEqual(result, { ok: true, challengeId: proof.id, ...binding, verifiedAt: '2026-11-08T12:00:00.000Z' });
  assert.equal(fixture.calls.length, 1);
  const options = fixture.calls[0];
  assert(Object.isFrozen(options));
  assert.deepEqual(Object.keys(options).sort(), ['family', 'host', 'lookup', 'port']);
  assert.equal(options.host, binding.ipv4); assert.equal(options.port, 80); assert.equal(options.family, 4);
  let dnsError;
  options.lookup('untrusted.example', {}, error => { dnsError = error; });
  assert.equal(dnsError?.message, 'DNS resolution is disabled.');
  const wire = Buffer.concat(fixture.sockets[0].writes).toString();
  assert.match(wire, new RegExp(`^GET ${DOMAIN_PROOF_PATH} HTTP/1.1\\r\\n`));
  assert(wire.includes(`Host: ${binding.serverId}.fullpanel.dev\r\n`));
  assert(wire.includes('Accept-Encoding: identity\r\n'));
  assert(wire.includes('Connection: close\r\n'));
  assert(!/Authorization|Proxy-|Cookie|nonce=|https?:\/\//i.test(wire));
  assert(fixture.sockets[0].destroyed);
});

test('mismatched remote address, port or address family receives zero HTTP bytes', async () => {
  const proof = newProof();
  for (const peer of [{ remoteAddress: '127.0.0.1' }, { remoteAddress: '169.254.169.254' }, { remoteAddress: '1.1.1.1' }, { remoteAddress: '::ffff:8.8.8.8' }, { remotePort: 8080 }, { remoteFamily: 'IPv6' }]) {
    const fixture = transport({ ...peer, respond: response(expectedDomainProof(proof)) });
    assert.deepEqual(await verifier(fixture).verify(proof, binding), failure);
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.sockets[0].writes.length, 0);
    assert(fixture.sockets[0].destroyed);
  }
});

test('socket peer is checked again after connect and before accepting the response', async () => {
  const proof = newProof();
  const fixture = transport({ respond(socket) { socket.remoteAddress = '1.1.1.1'; response(expectedDomainProof(proof))(socket); } });
  assert.deepEqual(await verifier(fixture).verify(proof, binding), failure);
});

test('redirects, non-200 statuses, upgrades and informational responses are never followed', async () => {
  const proof = newProof();
  for (const status of ['301 Moved', '302 Found', '307 Temporary Redirect', '308 Permanent Redirect', '204 No Content', '401 Unauthorized', '500 Server Error']) {
    const fixture = transport({ respond: response(expectedDomainProof(proof), { status, headers: { Location: 'http://169.254.169.254/latest/meta-data/' } }) });
    assert.deepEqual(await verifier(fixture).verify(proof, binding), failure);
    assert.equal(fixture.calls.length, 1);
  }
  for (const raw of ['HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nsecret', 'HTTP/1.1 103 Early Hints\r\nLink: <http://127.0.0.1>\r\n\r\n']) {
    const fixture = transport({ respond(socket) { socket.push(raw); } });
    assert.deepEqual(await verifier(fixture).verify(proof, binding), failure);
    assert(fixture.sockets[0].destroyed);
  }
});

test('body matching is byte-exact with no trimming, parsing or decompression; failures are generic', async () => {
  const proof = newProof(), expected = expectedDomainProof(proof);
  for (const body of ['', expected.trim(), ' ' + expected, expected + '\n', expected.replace(proof.nonce, newProof().nonce), JSON.stringify({ proof: expected }), 'private-cloud-token-must-not-escape', Buffer.concat([Buffer.from(expected), Buffer.from([0])])]) {
    const fixture = transport({ respond: response(body) });
    const result = await verifier(fixture).verify(proof, binding);
    assert.deepEqual(result, failure); assert(!JSON.stringify(result).includes('private-cloud-token'));
  }
  const compressed = transport({ respond: response(expected, { headers: { 'Content-Encoding': 'gzip' } }) });
  assert.deepEqual(await verifier(compressed).verify(proof, binding), failure);
});

test('oversized declared/chunked bodies, headers, truncated messages and malformed HTTP are bounded and refused', async () => {
  const proof = newProof();
  const rawResponses = [
    `HTTP/1.1 200 OK\r\nContent-Length: 2049\r\n\r\n${'x'.repeat(2049)}`,
    `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n801\r\n${'x'.repeat(2049)}\r\n0\r\n\r\n`,
    `HTTP/1.1 200 OK\r\nX-Untrusted: ${'secret'.repeat(800)}\r\nContent-Length: 0\r\n\r\n`,
    'HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort',
    'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\nxx',
    'NOT HTTP secret-response-content',
  ];
  for (const raw of rawResponses) {
    const fixture = transport({ respond(socket) { socket.push(raw); socket.push(null); } });
    assert.deepEqual(await verifier(fixture).verify(proof, binding), failure);
    assert(fixture.sockets[0].destroyed);
  }
  const chunked = transport({ respond(socket) {
    const body = expectedDomainProof(proof);
    socket.push(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n0\r\n\r\n`);
    socket.push(null);
  } });
  assert.equal((await verifier(chunked).verify(proof, binding)).ok, true);
});

test('connection and total deadlines stop stalled and slowly streaming peers without exposing errors', async () => {
  const proof = newProof();
  for (const scenario of [{ noConnect: true }, {}, { respond(socket) {
    socket.push('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n');
    const drip = () => { socket.push('1\r\nx\r\n'); socket.later(drip, 4); };
    drip();
  } }]) {
    const fixture = transport(scenario), started = performance.now();
    assert.deepEqual(await verifier(fixture, { connectionTimeoutMs: 15, totalTimeoutMs: 40 }).verify(proof, binding), failure);
    assert(performance.now() - started < 500);
    assert(fixture.sockets[0].destroyed);
    assert.equal(fixture.sockets[0].timers.size, 0);
  }
  const throwing = { connect() { throw new Error('credential=do-not-leak private-infrastructure'); } };
  assert.deepEqual(await verifier(throwing).verify(proof, binding), failure);
  const errorSocket = transport({ respond(socket) { socket.destroy(new Error('remote-error-secret')); } });
  assert.deepEqual(await verifier(errorSocket).verify(proof, binding), failure);
});

test('per-verifier and process-wide concurrency are bounded without queues and capacity is recovered', async () => {
  const proof = newProof();
  const blocked = transport({ noConnect: true });
  const one = verifier(blocked, { maxConcurrent: 1 });
  const inFlight = one.verify(proof, binding);
  assert.deepEqual(await one.verify(proof, binding), failure);
  assert.equal(blocked.calls.length, 1);
  await inFlight;
  await one.verify(proof, binding);
  assert.equal(blocked.calls.length, 2);
  const fixtures = Array.from({ length: 9 }, () => transport({ noConnect: true }));
  const pending = fixtures.slice(0, 8).map(fixture => verifier(fixture).verify(proof, binding));
  assert.deepEqual(await verifier(fixtures[8]).verify(proof, binding), failure);
  assert.equal(fixtures[8].calls.length, 0);
  await Promise.all(pending);
  const success = transport({ respond: response(expectedDomainProof(proof)) });
  assert.equal((await verifier(success).verify(proof, binding)).ok, true);
  for (const options of [{ maxConcurrent: 0 }, { maxConcurrent: 9 }, { connectionTimeoutMs: 2001 }, { totalTimeoutMs: 10001 }, { connectionTimeoutMs: 50, totalTimeoutMs: 20 }]) assert.throws(() => verifier(success, options), /Invalid domain proof verifier/);
});

test('in-flight input mutation cannot change the literal destination, binding or expected payload', async () => {
  const proof = { ...newProof() }, original = { ...proof };
  const fixture = transport({ respond: response(expectedDomainProof(proof)) });
  const inFlight = verifier(fixture).verify(proof, { ...binding });
  proof.ipv4 = '127.0.0.1'; proof.serverId = 'attacker'; proof.nonce = newProof().nonce;
  const result = await inFlight;
  assert.equal(result.ok, true); assert.equal(result.ipv4, original.ipv4); assert.equal(result.serverId, original.serverId);
  assert.equal(fixture.calls[0].host, original.ipv4);
});

test('proof observation does not claim replay prevention: consumption belongs to a future durable registry transaction', async () => {
  const proof = newProof(), fixture = transport({ respond: response(expectedDomainProof(proof)) }), verify = verifier(fixture);
  assert.equal((await verify.verify(proof, binding)).ok, true);
  assert.equal((await verify.verify(proof, binding)).ok, true);
  assert.equal(fixture.calls.length, 2);
  assert(!('consumedAt' in proof));
});
