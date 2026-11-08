import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createRegistryDatabase, registryPoolOptions } from './database.mjs';

const connectionString = 'postgresql://registry:private-password@db.example.test:5432/registry';
test('registry configuration enforces verified TLS, explicit CA and a maximum of three connections', () => {
  const options = registryPoolOptions({ connectionString });
  assert.equal(options.max, 3); assert.equal(options.ssl.rejectUnauthorized, true); assert.equal(options.connectionString, undefined);
  const ca = '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----';
  assert.equal(registryPoolOptions({ connectionString, ca }).ssl.ca, ca);
  const original = process.env.PGSSLMODE; process.env.PGSSLMODE = 'disable';
  try { assert.equal(new pg.Client(options).connectionParameters.ssl.rejectUnauthorized, true); }
  finally { if (original === undefined) delete process.env.PGSSLMODE; else process.env.PGSSLMODE = original; }
  for (const query of ['sslmode=disable', 'sslmode=no-verify', 'sslmode=require', 'sslrootcert=/tmp/key', 'ssl=false', 'options=secret', 'host=127.0.0.1']) {
    assert.throws(() => registryPoolOptions({ connectionString: connectionString + '?' + query }), error => error.statusCode === 503 && !error.message.includes('private-password') && !error.message.includes('db.example.test'));
  }
  for (const invalid of ['', 'not a url', 'https://db.example.test/db', 'postgres://user@host/db', 'postgres://u:p@host/a/b', connectionString + '#fragment']) assert.throws(() => registryPoolOptions({ connectionString: invalid }));
  assert.throws(() => registryPoolOptions({ connectionString, ca: '-----BEGIN PRIVATE KEY-----' }));
  assert.throws(() => registryPoolOptions({ connectionString, ca: ca + 'a'.repeat(1024 * 1024) }));
});
test('plaintext is a fixture-only explicit opt-in for literal loopback addresses', () => {
  for (const host of ['127.0.0.1', '[::1]']) assert.equal(registryPoolOptions({ connectionString: `postgres://u:p@${host}:5432/fixture`, allowInsecureLoopbackForTests: true }).ssl, false);
  for (const host of ['localhost', '127.0.0.2', '10.0.0.1', 'db.example.test']) assert.throws(() => registryPoolOptions({ connectionString: `postgres://u:p@${host}:5432/fixture`, allowInsecureLoopbackForTests: true }));
  assert.throws(() => registryPoolOptions({ connectionString, allowInsecureLoopbackForTests: 'true' }));
});
test('registry creation is lazy and does not migrate or connect at import/construction', async () => {
  const database = createRegistryDatabase({ connectionString });
  assert.equal(database.pool.totalCount, 0); await database.close();
});
