import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { RegistryError, unavailable } from './errors.mjs';

const configurationError = () => new RegistryError('REGISTRY_CONFIGURATION_INVALID', 503, 'The registry database configuration is invalid.');
const schemaError = () => new RegistryError('REGISTRY_SCHEMA_MISMATCH', 503, 'The registry schema requires operator attention.');
const migrationPath = new URL('./migrations/001-initial.sql', import.meta.url);
async function migration() {
  const sql = await readFile(migrationPath, 'utf8');
  return { version: 1, sql, checksum: createHash('sha256').update(sql).digest('hex') };
}

/** No connection-string parser is allowed to replace the explicit TLS policy. */
export function registryPoolOptions({ connectionString, ca, allowInsecureLoopbackForTests = false } = {}) {
  try {
    if (typeof connectionString !== 'string' || connectionString.length > 8192 || /[\s\0]/.test(connectionString)) throw configurationError();
    const url = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search || url.hash || !url.username || !url.password || !url.hostname) throw configurationError();
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const user = decodeURIComponent(url.username), password = decodeURIComponent(url.password), database = decodeURIComponent(url.pathname.slice(1));
    if (!/^[A-Za-z0-9_-]{1,63}$/.test(database) || [host, user, password].some(value => !value || value.includes('\0'))) throw configurationError();
    const port = url.port ? Number(url.port) : 5432;
    if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof allowInsecureLoopbackForTests !== 'boolean') throw configurationError();
    if (ca !== undefined && (typeof ca !== 'string' || Buffer.byteLength(ca) > 1024 * 1024 || !ca.includes('-----BEGIN CERTIFICATE-----') || ca.includes('PRIVATE KEY'))) throw configurationError();
    if (allowInsecureLoopbackForTests && !['127.0.0.1', '::1'].includes(host)) throw configurationError();
    return { host, port, user, password, database, ssl: allowInsecureLoopbackForTests ? false : { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
      sslnegotiation: 'postgres', max: 3, min: 0, connectionTimeoutMillis: 3000, idleTimeoutMillis: 10000, maxLifetimeSeconds: 300,
      statement_timeout: 5000, query_timeout: 7000, idle_in_transaction_session_timeout: 10000, application_name: 'fullpanel-registry',
      options: '-c search_path=fullpanel_registry,pg_catalog' };
  } catch { throw configurationError(); }
}

export function createRegistryDatabase(options) {
  const pool = new pg.Pool(registryPoolOptions(options));
  // Pool-level disconnects are expected during provider maintenance. Do not log driver errors containing credentials.
  pool.on('error', () => {});
  return {
    pool,
    async migrate() {
      let client;
      try {
        const expected = await migration();
        client = await pool.connect();
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(818714040)");
        await client.query('CREATE SCHEMA IF NOT EXISTS fullpanel_registry');
        await client.query('CREATE TABLE IF NOT EXISTS fullpanel_registry.schema_migrations (version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())');
        const applied = await client.query('SELECT version, checksum FROM fullpanel_registry.schema_migrations ORDER BY version');
        if (applied.rows.some(row => row.version !== expected.version || row.checksum !== expected.checksum)) throw schemaError();
        if (!applied.rowCount) {
          await client.query(expected.sql);
          await client.query('INSERT INTO fullpanel_registry.schema_migrations(version, checksum) VALUES ($1,$2)', [expected.version, expected.checksum]);
        }
        await client.query('COMMIT');
        return { schemaVersion: expected.version, applied: applied.rowCount === 0 };
      } catch (cause) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        throw cause instanceof RegistryError ? cause : unavailable();
      } finally { client?.release(); }
    },
    async readiness() {
      try {
        const expected = await migration();
        const result = await pool.query("SELECT version, checksum, to_regclass('fullpanel_registry.installations') IS NOT NULL AND to_regclass('fullpanel_registry.tokens') IS NOT NULL AND to_regclass('fullpanel_registry.operations') IS NOT NULL AND to_regclass('fullpanel_registry.events') IS NOT NULL AS tables_present FROM fullpanel_registry.schema_migrations ORDER BY version");
        const ready = result.rowCount === 1 && result.rows[0].version === expected.version && result.rows[0].checksum === expected.checksum && result.rows[0].tables_present;
        return { ready: !!ready, schemaVersion: ready ? expected.version : null };
      } catch { return { ready: false, schemaVersion: null }; }
    },
    async close() { await pool.end(); }
  };
}
