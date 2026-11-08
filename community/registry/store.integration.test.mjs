import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRegistryDatabase } from './database.mjs';
import { createRegistryStore } from './store.mjs';

const fixtureId = process.env.REGISTRY_FIXTURE_ID;
if (!fixtureId || !/^[a-f0-9-]{36}$/.test(fixtureId) || !process.env.REGISTRY_FIXTURE_CONTAINER_ID || !process.env.DATABASE_URL) throw new Error('Use npm run test:registry to create an owned disposable PostgreSQL fixture.');
const url = new URL(process.env.DATABASE_URL);
assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.pathname, '/registry_' + fixtureId.replaceAll('-', ''));
const execute = promisify(execFile);
const options = { connectionString: process.env.DATABASE_URL, allowInsecureLoopbackForTests: true };
let database = createRegistryDatabase(options), store = createRegistryStore(database);
const rawTokens = [];
let primary;

async function fixtureContainer() {
  const { stdout } = await execute('docker', ['container', 'inspect', process.env.REGISTRY_FIXTURE_CONTAINER_ID], { timeout: 10000 });
  const container = JSON.parse(stdout)[0];
  assert.equal(container.Id, process.env.REGISTRY_FIXTURE_CONTAINER_ID); assert.equal(container.Config.Labels['io.fullpanel.registry-fixture'], fixtureId);
  return container.Id;
}

test.after(async () => { await database.close(); });

test('real PostgreSQL migration is transactional, concurrently serialized and idempotent', async () => {
  assert.deepEqual(await database.readiness(), { ready: false, schemaVersion: null });
  const results = await Promise.all([database.migrate(), database.migrate()]);
  assert.equal(results.filter(result => result.applied).length, 1);
  assert.deepEqual(await database.migrate(), { schemaVersion: 1, applied: false });
  assert.deepEqual(await database.readiness(), { ready: true, schemaVersion: 1 });
  assert.equal((await database.pool.query('SELECT count(*)::int AS n FROM fullpanel_registry.schema_migrations')).rows[0].n, 1);
});

test('concurrent identical reservations mint one immutable identifier and return one token once', async () => {
  const requests = await Promise.all(Array.from({ length: 12 }, () => store.reserveInstallation('owner-a', { idempotencyKey: 'reserve-primary', desiredIpv4: '8.8.8.8' })));
  assert.equal(requests.filter(result => result.token).length, 1);
  assert.equal(requests.filter(result => !result.replayed).length, 1);
  assert.equal(new Set(requests.map(result => result.installation.id)).size, 1);
  primary = requests.find(result => result.token); rawTokens.push(primary.token);
  assert.match(primary.installation.serverId, /^s-[a-f0-9]{32}$/); assert.equal(primary.installation.status, 'pending'); assert.equal(primary.installation.appliedIpv4, null);
  assert.match(primary.token, /^fpr_[A-Za-z0-9_-]{43}$/);
  assert.equal((await store.verifyInstallationToken(primary.installation.id, primary.token)).id, primary.installation.id);
  assert.equal(await store.verifyInstallationToken(primary.installation.id, 'fpr_' + randomBytes(32).toString('base64url')), null);
  await assert.rejects(store.reserveInstallation('owner-a', { idempotencyKey: 'reserve-primary', desiredIpv4: '1.1.1.1' }), { code: 'IDEMPOTENCY_CONFLICT', statusCode: 409 });
  const other = await store.reserveInstallation('owner-b', { idempotencyKey: 'reserve-primary', desiredIpv4: '1.1.1.1' }); rawTokens.push(other.token);
  assert.notEqual(other.installation.id, primary.installation.id);
  for (const value of ['127.0.0.1', '10.0.0.1', '001.2.3.4', '8.8.8.8\n', 'http://8.8.8.8']) await assert.rejects(store.reserveInstallation('owner-a', { idempotencyKey: randomUUID(), desiredIpv4: value }), { statusCode: 400 });
});

test('owner-scoped reads, rotation and revocation return indistinguishable not-found errors cross-owner', async () => {
  for (const invoke of [() => store.getInstallation('owner-b', primary.installation.id), () => store.rotateToken('owner-b', primary.installation.id, { idempotencyKey: 'foreign-rotate' }), () => store.revokeInstallation('owner-b', primary.installation.id, { idempotencyKey: 'foreign-revoke' })]) await assert.rejects(invoke(), { statusCode: 404, code: 'INSTALLATION_NOT_FOUND' });
  assert.equal((await store.getInstallation('owner-a', primary.installation.id)).status, 'pending');
});

test('queued reservations snapshot validated input before yielding to the pool', async () => {
  const clients = await Promise.all(Array.from({ length: 3 }, () => database.pool.connect()));
  const options = { idempotencyKey: 'immutable-input', desiredIpv4: '8.8.8.8' };
  let queued;
  try {
    queued = store.reserveInstallation('owner-input', options);
    options.desiredIpv4 = '127.0.0.1';
  } finally { clients.forEach(client => client.release()); }
  const result = await queued; rawTokens.push(result.token);
  assert.equal(result.installation.desiredIpv4, '8.8.8.8');
  assert.equal((await store.reserveInstallation('owner-input', { idempotencyKey: 'immutable-input', desiredIpv4: '8.8.8.8' })).replayed, true);
});

test('rotation atomically revokes old tokens, retries are safe, and concurrent rotations preserve all generations', async () => {
  const first = await store.rotateToken('owner-a', primary.installation.id, { idempotencyKey: 'rotate-1' }); rawTokens.push(first.token);
  assert.equal(await store.verifyInstallationToken(primary.installation.id, primary.token), null);
  assert.equal((await store.verifyInstallationToken(primary.installation.id, first.token)).tokenVersion, 2);
  const replay = await store.rotateToken('owner-a', primary.installation.id, { idempotencyKey: 'rotate-1' }); assert.equal(replay.replayed, true); assert.equal(replay.token, undefined);
  const rotations = await Promise.all(['rotate-2', 'rotate-3'].map(idempotencyKey => store.rotateToken('owner-a', primary.installation.id, { idempotencyKey })));
  rotations.forEach(result => rawTokens.push(result.token)); assert.deepEqual(rotations.map(result => result.installation.tokenVersion).sort(), [3, 4]);
  const valid = await Promise.all(rotations.map(result => store.verifyInstallationToken(primary.installation.id, result.token))); assert.equal(valid.filter(Boolean).length, 1);
  const tokens = await database.pool.query('SELECT version, revoked_at FROM fullpanel_registry.tokens WHERE installation_id=$1 ORDER BY version', [primary.installation.id]);
  assert.deepEqual(tokens.rows.map(row => row.version), [1, 2, 3, 4]); assert.equal(tokens.rows.filter(row => row.revoked_at === null).length, 1);
  assert.equal((await database.pool.query('SELECT count(*)::int AS n FROM fullpanel_registry.events WHERE installation_id=$1', [primary.installation.id])).rows[0].n, 4);
});

test('a failure after revocation but before replacement-token insertion rolls back the entire rotation', async () => {
  const current = await store.getInstallation('owner-a', primary.installation.id);
  const faulty = createRegistryStore({ pool: { async connect() {
    const client = await database.pool.connect();
    return { release: () => client.release(), query: (sql, values) => {
      if (sql.startsWith('INSERT INTO fullpanel_registry.tokens')) throw new Error('private-connection-details-must-not-escape');
      return client.query(sql, values);
    } };
  } } });
  await assert.rejects(faulty.rotateToken('owner-a', primary.installation.id, { idempotencyKey: 'interrupted-rotation' }), error => error.code === 'REGISTRY_UNAVAILABLE' && !error.message.includes('private-connection'));
  assert.equal((await store.getInstallation('owner-a', primary.installation.id)).tokenVersion, current.tokenVersion);
  assert.equal((await Promise.all(rawTokens.map(token => store.verifyInstallationToken(primary.installation.id, token)))).filter(Boolean).length, 1);
  assert.equal((await database.pool.query("SELECT count(*)::int AS n FROM fullpanel_registry.operations WHERE idempotency_key='interrupted-rotation'")).rows[0].n, 0);
});

test('suspended installations cannot authenticate or rotate management tokens', async () => {
  const pending = await store.reserveInstallation('owner-suspended', { idempotencyKey: 'reserve', desiredIpv4: '9.9.9.9' }); rawTokens.push(pending.token);
  await database.pool.query("UPDATE fullpanel_registry.installations SET status='suspended' WHERE id=$1", [pending.installation.id]);
  assert.equal(await store.verifyInstallationToken(pending.installation.id, pending.token), null);
  await assert.rejects(store.rotateToken('owner-suspended', pending.installation.id, { idempotencyKey: 'blocked-rotate' }), { statusCode: 409, code: 'INSTALLATION_INACTIVE' });
  await assert.rejects(database.pool.query("UPDATE fullpanel_registry.installations SET status='unsupported' WHERE id=$1", [pending.installation.id]));
});

test('revocation retains a terminal tombstone, never reassigns its public identifier and does not overwrite history', async () => {
  const revoked = await store.revokeInstallation('owner-a', primary.installation.id, { idempotencyKey: 'revoke-1' }); assert.equal(revoked.installation.status, 'revoked'); assert.ok(revoked.installation.revokedAt);
  for (const token of rawTokens) assert.equal(await store.verifyInstallationToken(primary.installation.id, token), null);
  assert.equal((await store.revokeInstallation('owner-a', primary.installation.id, { idempotencyKey: 'revoke-1' })).replayed, true);
  assert.equal((await store.revokeInstallation('owner-a', primary.installation.id, { idempotencyKey: 'revoke-again' })).installation.revokedAt, revoked.installation.revokedAt);
  await assert.rejects(store.rotateToken('owner-a', primary.installation.id, { idempotencyKey: 'after-revoke' }), { statusCode: 409, code: 'INSTALLATION_INACTIVE' });
  const repeated = await store.reserveInstallation('owner-a', { idempotencyKey: 'reserve-primary', desiredIpv4: '8.8.8.8' }); assert.equal(repeated.installation.status, 'revoked'); assert.equal(repeated.token, undefined);
  let attempts = 0;
  const collisionStore = createRegistryStore(database, { publicIdFactory: () => ++attempts === 1 ? primary.installation.serverId : 's-' + randomBytes(16).toString('hex') });
  const replacement = await collisionStore.reserveInstallation('owner-a', { idempotencyKey: 'replacement', desiredIpv4: '8.8.4.4' }); rawTokens.push(replacement.token);
  assert.equal(attempts, 2); assert.notEqual(replacement.installation.serverId, primary.installation.serverId);
  assert.equal((await database.pool.query('SELECT count(*)::int AS n FROM fullpanel_registry.events WHERE installation_id=$1', [primary.installation.id])).rows[0].n, 5);
  for (const query of ["UPDATE fullpanel_registry.installations SET public_id='s-00000000000000000000000000000000' WHERE id=$1", "UPDATE fullpanel_registry.installations SET owner_id='other' WHERE id=$1", "UPDATE fullpanel_registry.installations SET status='pending',revoked_at=NULL WHERE id=$1", 'DELETE FROM fullpanel_registry.installations WHERE id=$1']) await assert.rejects(database.pool.query(query, [primary.installation.id]));
  await assert.rejects(database.pool.query('DELETE FROM fullpanel_registry.events'));
  await assert.rejects(database.pool.query('TRUNCATE fullpanel_registry.events'));
});

test('no plaintext tokens exist in SQL rows or audit history; failed allocation rolls back everything', async () => {
  const result = await database.pool.query("SELECT row_to_json(r)::text AS value FROM fullpanel_registry.installations r UNION ALL SELECT row_to_json(r)::text FROM fullpanel_registry.tokens r UNION ALL SELECT row_to_json(r)::text FROM fullpanel_registry.operations r UNION ALL SELECT row_to_json(r)::text FROM fullpanel_registry.events r");
  const serialized = JSON.stringify(result.rows);
  for (const token of rawTokens) assert(!serialized.includes(token)); assert(!serialized.includes('fpr_'));
  const count = (await database.pool.query('SELECT count(*)::int AS n FROM fullpanel_registry.installations')).rows[0].n;
  const collisions = createRegistryStore(database, { publicIdFactory: () => primary.installation.serverId });
  await assert.rejects(collisions.reserveInstallation('owner-a', { idempotencyKey: 'allocation-failed', desiredIpv4: '8.8.8.8' }), { code: 'REGISTRY_ID_ALLOCATION_FAILED' });
  assert.equal((await database.pool.query('SELECT count(*)::int AS n FROM fullpanel_registry.installations')).rows[0].n, count);
  assert.equal((await database.pool.query("SELECT count(*)::int AS n FROM fullpanel_registry.operations WHERE idempotency_key='allocation-failed'")).rows[0].n, 0);
});

test('real PostgreSQL restart and fresh pool preserve reservations, tombstones and immutable token history', async () => {
  await database.close();
  await execute('docker', ['restart', '--time', '2', await fixtureContainer()], { timeout: 30000 });
  database = createRegistryDatabase(options); store = createRegistryStore(database);
  const deadline = Date.now() + 30000;
  while (!(await database.readiness()).ready && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
  assert.deepEqual(await database.readiness(), { ready: true, schemaVersion: 1 });
  assert.equal((await store.getInstallation('owner-a', primary.installation.id)).status, 'revoked');
  assert.equal((await store.getInstallation('owner-a', primary.installation.id)).serverId, primary.installation.serverId);
  assert.equal((await database.pool.query('SELECT count(*)::int AS n FROM fullpanel_registry.tokens WHERE installation_id=$1', [primary.installation.id])).rows[0].n, 4);
  assert.deepEqual(await database.migrate(), { schemaVersion: 1, applied: false });
});

test('migration checksum mismatch fails readiness and refuses migration without changing history', async () => {
  const original = (await database.pool.query('SELECT checksum FROM fullpanel_registry.schema_migrations WHERE version=1')).rows[0].checksum;
  await database.pool.query('UPDATE fullpanel_registry.schema_migrations SET checksum=$1 WHERE version=1', ['0'.repeat(64)]);
  try {
    assert.deepEqual(await database.readiness(), { ready: false, schemaVersion: null });
    await assert.rejects(database.migrate(), { code: 'REGISTRY_SCHEMA_MISMATCH', statusCode: 503 });
    assert.equal((await database.pool.query('SELECT count(*)::int AS n FROM fullpanel_registry.tokens WHERE installation_id=$1', [primary.installation.id])).rows[0].n, 4);
  } finally { await database.pool.query('UPDATE fullpanel_registry.schema_migrations SET checksum=$1 WHERE version=1', [original]); }
});
