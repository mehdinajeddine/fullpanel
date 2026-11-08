import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Agent, request } from 'node:http';
import { createConnection, isIP } from 'node:net';

export const DOMAIN_PROOF_PATH = '/.well-known/fullpanel-domain-proof';
export const DOMAIN_PROOF_LIMITS = Object.freeze({
  minTtlMs: 30_000, maxTtlMs: 600_000, defaultTtlMs: 300_000,
  bodyBytes: 2048, headerBytes: 4096,
  connectionTimeoutMs: 2000, totalTimeoutMs: 5000, maxTotalTimeoutMs: 10_000,
  defaultConcurrency: 4, processConcurrency: 8,
});
const FAILURE = Object.freeze({ ok: false, code: 'DOMAIN_PROOF_FAILED', message: 'Unable to verify server control.' });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SERVER_ID = /^s-[a-f0-9]{32}$/;
const CHALLENGE_KEYS = ['version', 'id', 'installationId', 'serverId', 'ipv4', 'nonce', 'createdAt', 'expiresAt'];
let processActive = 0;

/**
 * Ordinary public unicast IPv4 only. Conservative exclusions include all IANA
 * special-purpose assignments, including globally reachable protocol/anycast
 * exceptions that are not ordinary installation addresses. Reviewed 2026-11-08:
 * https://www.iana.org/assignments/iana-ipv4-special-registry/
 * https://www.rfc-editor.org/rfc/rfc1112.html#section-4
 * Azure's public-numbered platform endpoint must also remain excluded:
 * https://learn.microsoft.com/en-us/azure/virtual-network/what-is-ip-address-168-63-129-16
 * This filter does not replace an independently enforced worker egress policy.
 */
export function isPublicProofIpv4(value) {
  if (typeof value !== 'string' || isIP(value) !== 4) return false;
  const parts = value.split('.');
  if (parts.some(part => !/^(0|[1-9][0-9]{0,2})$/.test(part))) return false;
  const [a, b, c] = parts.map(Number);
  if (value !== parts.map(Number).join('.')) return false;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 31 && c === 196 || b === 52 && c === 193 || b === 88 && c === 99 || b === 175 && c === 48)) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113) return false;
  return value !== '168.63.129.16';
}

function onlyKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key));
}
function validBinding(value) {
  return onlyKeys(value, ['installationId', 'serverId', 'ipv4'])
    && typeof value.installationId === 'string' && value.installationId.length === 36 && UUID.test(value.installationId)
    && typeof value.serverId === 'string' && value.serverId.length === 34 && SERVER_ID.test(value.serverId)
    && isPublicProofIpv4(value.ipv4);
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : NaN;
}
function validChallenge(value) {
  if (!onlyKeys(value, CHALLENGE_KEYS) || Object.keys(value).length !== CHALLENGE_KEYS.length) return false;
  if (!validBinding({ installationId: value.installationId, serverId: value.serverId, ipv4: value.ipv4 })) return false;
  if (value.version !== 1 || typeof value.id !== 'string' || value.id.length !== 64 || !/^[a-f0-9]{64}$/.test(value.id)) return false;
  if (typeof value.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.nonce)
    || Buffer.from(value.nonce, 'base64url').toString('base64url') !== value.nonce) return false;
  const created = timestamp(value.createdAt), expires = timestamp(value.expiresAt);
  return Number.isFinite(created) && Number.isFinite(expires)
    && expires - created >= DOMAIN_PROOF_LIMITS.minTtlMs && expires - created <= DOMAIN_PROOF_LIMITS.maxTtlMs;
}
function fresh(challenge, now) {
  return Number.isSafeInteger(now) && timestamp(challenge.createdAt) <= now && now < timestamp(challenge.expiresAt);
}

/** Nonces are temporary PUBLIC proof material, never management credentials.
 * Persist the result in the future registry before exposing it to a requester.
 */
export function createDomainProof(input, { clock = Date.now } = {}) {
  if (!onlyKeys(input, ['installationId', 'serverId', 'ipv4', 'ttlMs'])) throw new TypeError('Invalid domain proof request.');
  const { installationId, serverId, ipv4, ttlMs = DOMAIN_PROOF_LIMITS.defaultTtlMs } = input;
  if (!validBinding({ installationId, serverId, ipv4 }) || !Number.isSafeInteger(ttlMs)
    || ttlMs < DOMAIN_PROOF_LIMITS.minTtlMs || ttlMs > DOMAIN_PROOF_LIMITS.maxTtlMs || typeof clock !== 'function') {
    throw new TypeError('Invalid domain proof request.');
  }
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0 || now + ttlMs > 253402300799999) throw new TypeError('Invalid domain proof request.');
  return Object.freeze({
    version: 1, id: randomBytes(32).toString('hex'), installationId, serverId, ipv4,
    nonce: randomBytes(32).toString('base64url'), createdAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlMs).toISOString(),
  });
}

/** Exact UTF-8/ASCII payload, including its final newline. No trimming/JSON parsing.
 * All binding fields are represented so a response for another reservation,
 * installation, address or validity period cannot satisfy this challenge.
 */
export function expectedDomainProof(challenge) {
  if (!validChallenge(challenge)) throw new TypeError('Invalid domain proof challenge.');
  return `fullpanel-domain-proof:v1\nchallenge=${challenge.id}\ninstallation=${challenge.installationId}\nserver=${challenge.serverId}\nipv4=${challenge.ipv4}\nnonce=${challenge.nonce}\ncreated=${challenge.createdAt}\nexpires=${challenge.expiresAt}\n`;
}

function boundedInteger(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}
function noLookup(_hostname, _options, callback) {
  const fail = typeof _options === 'function' ? _options : callback;
  fail(new Error('DNS resolution is disabled.'));
}

/**
 * Trusted dependency injection is socket-only: connect receives a frozen literal
 * IPv4/port80/family4 tuple, never request headers, URLs or a private-IP bypass.
 * Production defaults to native net.createConnection. Native HTTP parses the
 * bytes in both production and injected tests. A private per-request Agent with
 * an empty proxyEnv never inherits global/env proxy or connection pools.
 *
 * A success is ONLY an observation. This module does not authorize a caller,
 * persist/consume challenges, prevent replay, allocate DNS, or issue tokens.
 * The broker must load the original challenge from its trusted registry, pass
 * its current binding, then atomically reauthorize/consume before activation.
 * Never accept a replacement challenge object from an untrusted API request.
 */
export function createDomainProofVerifier({
  connect = createConnection,
  clock = Date.now,
  connectionTimeoutMs = DOMAIN_PROOF_LIMITS.connectionTimeoutMs,
  totalTimeoutMs = DOMAIN_PROOF_LIMITS.totalTimeoutMs,
  maxConcurrent = DOMAIN_PROOF_LIMITS.defaultConcurrency,
} = {}) {
  if (typeof connect !== 'function' || typeof clock !== 'function'
    || !boundedInteger(connectionTimeoutMs, 1, DOMAIN_PROOF_LIMITS.connectionTimeoutMs)
    || !boundedInteger(totalTimeoutMs, connectionTimeoutMs, DOMAIN_PROOF_LIMITS.maxTotalTimeoutMs)
    || !boundedInteger(maxConcurrent, 1, DOMAIN_PROOF_LIMITS.processConcurrency)) {
    throw new TypeError('Invalid domain proof verifier configuration.');
  }
  let active = 0;

  return Object.freeze({
    async verify(challenge, binding) {
      // Validate before constructing HTTP requests, agents or sockets. Snapshot
      // primitive fields so callers cannot redirect an in-flight verification.
      let proof, expected, startedAt;
      try {
        if (!validChallenge(challenge) || !validBinding(binding)) return FAILURE;
        proof = Object.freeze(Object.fromEntries(CHALLENGE_KEYS.map(key => [key, challenge[key]])));
        startedAt = clock();
        if (!validChallenge(proof) || !fresh(proof, startedAt)
          || proof.installationId !== binding.installationId || proof.serverId !== binding.serverId || proof.ipv4 !== binding.ipv4) return FAILURE;
        expected = Buffer.from(expectedDomainProof(proof), 'utf8');
      } catch { return FAILURE; }
      if (active >= maxConcurrent || processActive >= DOMAIN_PROOF_LIMITS.processConcurrency) return FAILURE;
      active += 1;
      processActive += 1;
      try {
        return await new Promise(resolve => {
          let settled = false, socket, req, response, connectionTimer, totalTimer;
          const agent = new Agent({ keepAlive: false, maxSockets: 1, maxTotalSockets: 1, proxyEnv: {} });
          const buffer = Buffer.alloc(DOMAIN_PROOF_LIMITS.bodyBytes);
          let length = 0;
          const peerMatches = candidate => candidate === socket && candidate?.remoteAddress === proof.ipv4
            && candidate.remotePort === 80 && candidate.remoteFamily === 'IPv4';
          const finish = result => {
            if (settled) return;
            settled = true;
            clearTimeout(connectionTimer);
            clearTimeout(totalTimer);
            response?.destroy();
            req?.destroy();
            socket?.destroy();
            agent.destroy();
            resolve(result);
          };
          const fail = () => finish(FAILURE);
          totalTimer = setTimeout(fail, Math.min(totalTimeoutMs, timestamp(proof.expiresAt) - startedAt));
          agent.createConnection = (_requestOptions, callback) => {
            if (settled) { callback(new Error('Verification ended.')); return; }
            connectionTimer = setTimeout(fail, connectionTimeoutMs);
            let delivered = false;
            const connected = () => {
              if (settled || delivered) return;
              let now;
              try { now = clock(); } catch { fail(); return; }
              if (!peerMatches(socket) || !fresh(proof, now)) { fail(); return; }
              delivered = true;
              clearTimeout(connectionTimer);
              callback(null, socket); // No HTTP bytes are written before this check.
            };
            try {
              socket = connect(Object.freeze({ host: proof.ipv4, port: 80, family: 4, lookup: noLookup }));
              socket.once('error', fail);
              socket.once('close', () => { if (!delivered) fail(); });
              socket.once('connect', connected);
              if (!socket.connecting) queueMicrotask(connected);
            } catch { fail(); }
            // Deliberately no returned socket: the Agent receives it only after
            // its actual peer address/port/family has been validated.
          };
          try {
            req = request({
              protocol: 'http:', hostname: proof.ipv4, port: 80, family: 4,
              method: 'GET', path: DOMAIN_PROOF_PATH, agent, lookup: noLookup,
              maxHeaderSize: DOMAIN_PROOF_LIMITS.headerBytes, insecureHTTPParser: false,
              headers: { Host: `${proof.serverId}.fullpanel.dev`, Accept: 'text/plain', 'Accept-Encoding': 'identity', Connection: 'close' },
            }, incoming => {
              response = incoming;
              incoming.on('error', fail);
              incoming.on('aborted', fail);
              if (settled) { incoming.destroy(); return; }
              if (!peerMatches(incoming.socket) || incoming.statusCode !== 200
                || incoming.headers['content-encoding'] && incoming.headers['content-encoding'] !== 'identity') { fail(); return; }
              const declared = incoming.headers['content-length'];
              if (declared !== undefined && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > DOMAIN_PROOF_LIMITS.bodyBytes)) { fail(); return; }
              incoming.on('data', chunk => {
                if (settled) return;
                if (!Buffer.isBuffer(chunk) || length + chunk.length > buffer.length) { fail(); return; }
                chunk.copy(buffer, length);
                length += chunk.length;
              });
              incoming.on('end', () => {
                if (settled) return;
                let now;
                try { now = clock(); } catch { fail(); return; }
                if (!incoming.complete || !peerMatches(socket) || !fresh(proof, now) || length !== expected.length
                  || !timingSafeEqual(buffer.subarray(0, length), expected)) { fail(); return; }
                finish(Object.freeze({ ok: true, challengeId: proof.id, installationId: proof.installationId,
                  serverId: proof.serverId, ipv4: proof.ipv4, verifiedAt: new Date(now).toISOString() }));
              });
              incoming.on('close', () => { if (!incoming.complete) fail(); });
            });
            req.on('error', fail);
            req.on('upgrade', (_message, upgraded) => { upgraded.destroy(); fail(); });
            req.on('connect', (_message, tunnel) => { tunnel.destroy(); fail(); });
            req.on('information', fail);
            // A synchronously failed connector can settle before request()
            // returns. Destroy the just-created request rather than ending it.
            if (settled) { req.destroy(); return; }
            req.end();
          } catch { fail(); }
        });
      } finally {
        active -= 1;
        processActive -= 1;
      }
    },
  });
}
