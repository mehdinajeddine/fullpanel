import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isPublicProofIpv4 } from '../domain-proof.mjs';
import { RegistryError, invalid, notFound, unavailable } from './errors.mjs';

const installationColumns = 'id, public_id, status, host(desired_ipv4) AS desired_ipv4, host(applied_ipv4) AS applied_ipv4, token_version, created_at, updated_at, revoked_at';
const digest = value => createHash('sha256').update(value).digest('hex');
const conflict = () => new RegistryError('IDEMPOTENCY_CONFLICT', 409, 'This idempotency key was already used for a different operation.');
const inactive = () => new RegistryError('INSTALLATION_INACTIVE', 409, 'The installation does not allow this operation.');
function owner(value) { if (typeof value !== 'string' || value.length < 1 || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/.test(value)) throw invalid(); return value; }
function identifier(value) { if (typeof value !== 'string' || value.length !== 36 || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) throw invalid(); return value; }
function input(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw invalid();
  const key = value.idempotencyKey;
  if (typeof key !== 'string' || key.length < 1 || key.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(key)) throw invalid();
  return key;
}
function view(row) {
  return { id: row.id, serverId: row.public_id, status: row.status, desiredIpv4: row.desired_ipv4, appliedIpv4: row.applied_ipv4,
    tokenVersion: row.token_version, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), revokedAt: row.revoked_at?.toISOString() || null };
}
async function owned(client, ownerId, id, lock = false) {
  const result = await client.query(`SELECT ${installationColumns} FROM fullpanel_registry.installations WHERE id=$1 AND owner_id=$2${lock ? ' FOR UPDATE' : ''}`, [id, ownerId]);
  if (!result.rowCount) throw notFound();
  return result.rows[0];
}

/** Internal ownership-scoped persistence only. ownerId is supplied by a future trusted authentication layer. */
export function createRegistryStore(database, { publicIdFactory = () => 's-' + randomBytes(16).toString('hex') } = {}) {
  const pool = database.pool;
  async function transact(callback) {
    let client;
    try {
      client = await pool.connect(); await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (cause) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      throw cause instanceof RegistryError ? cause : unavailable();
    } finally { client?.release(); }
  }
  async function operation(ownerId, key, kind, payload, callback) {
    const payloadHash = digest(JSON.stringify([kind, payload]));
    return transact(async client => {
      // Serialize the same owner/key across processes; a hash collision only adds harmless contention.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([ownerId, key])]);
      const previous = await client.query('SELECT payload_hash, installation_id FROM fullpanel_registry.operations WHERE owner_id=$1 AND idempotency_key=$2', [ownerId, key]);
      if (previous.rowCount) {
        if (previous.rows[0].payload_hash !== payloadHash) throw conflict();
        return { installation: view(await owned(client, ownerId, previous.rows[0].installation_id, true)), replayed: true };
      }
      const result = await callback(client);
      await client.query('INSERT INTO fullpanel_registry.operations(owner_id,idempotency_key,payload_hash,operation,installation_id) VALUES($1,$2,$3,$4,$5)', [ownerId, key, payloadHash, kind, result.installation.id]);
      return { ...result, replayed: false };
    });
  }
  async function mint(client, id, version) {
    const token = 'fpr_' + randomBytes(32).toString('base64url');
    await client.query('INSERT INTO fullpanel_registry.tokens(id,installation_id,version,token_hash) VALUES($1,$2,$3,$4)', [randomUUID(), id, version, digest(token)]);
    return token;
  }
  async function event(client, id, action, version) {
    await client.query('INSERT INTO fullpanel_registry.events(installation_id,action,token_version) VALUES($1,$2,$3)', [id, action, version]);
  }
  return {
    async reserveInstallation(ownerId, options) {
      owner(ownerId); const key = input(options, ['idempotencyKey', 'desiredIpv4']);
      const desiredIpv4 = options.desiredIpv4;
      if (!isPublicProofIpv4(desiredIpv4)) throw invalid();
      return operation(ownerId, key, 'reserve', { desiredIpv4 }, async client => {
        let row;
        for (let attempt = 0; attempt < 5 && !row; attempt++) {
          const publicId = publicIdFactory();
          if (typeof publicId !== 'string' || publicId.length !== 34 || !/^s-[a-f0-9]{32}$/.test(publicId)) throw unavailable();
          const result = await client.query(`INSERT INTO fullpanel_registry.installations(id,public_id,owner_id,desired_ipv4) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING ${installationColumns}`, [randomUUID(), publicId, ownerId, desiredIpv4]);
          row = result.rows[0];
        }
        if (!row) throw new RegistryError('REGISTRY_ID_ALLOCATION_FAILED', 503, 'An installation identifier could not be allocated.');
        const token = await mint(client, row.id, 1); await event(client, row.id, 'reserved', 1);
        return { installation: view(row), token };
      });
    },
    async getInstallation(ownerId, id) {
      owner(ownerId); identifier(id);
      try { return view(await owned(pool, ownerId, id)); }
      catch (cause) { throw cause instanceof RegistryError ? cause : unavailable(); }
    },
    async rotateToken(ownerId, id, options) {
      owner(ownerId); identifier(id); const key = input(options, ['idempotencyKey']);
      return operation(ownerId, key, 'rotate-token', { installationId: id }, async client => {
        const current = await owned(client, ownerId, id, true);
        if (!['pending', 'active'].includes(current.status)) throw inactive();
        await client.query('UPDATE fullpanel_registry.tokens SET revoked_at=clock_timestamp() WHERE installation_id=$1 AND revoked_at IS NULL', [id]);
        const result = await client.query(`UPDATE fullpanel_registry.installations SET token_version=token_version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING ${installationColumns}`, [id]);
        const row = result.rows[0], token = await mint(client, id, row.token_version);
        await event(client, id, 'token-rotated', row.token_version);
        return { installation: view(row), token };
      });
    },
    async revokeInstallation(ownerId, id, options) {
      owner(ownerId); identifier(id); const key = input(options, ['idempotencyKey']);
      return operation(ownerId, key, 'revoke', { installationId: id }, async client => {
        let row = await owned(client, ownerId, id, true);
        if (row.status !== 'revoked') {
          await client.query('UPDATE fullpanel_registry.tokens SET revoked_at=clock_timestamp() WHERE installation_id=$1 AND revoked_at IS NULL', [id]);
          const result = await client.query(`UPDATE fullpanel_registry.installations SET status='revoked',revoked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 RETURNING ${installationColumns}`, [id]);
          row = result.rows[0]; await event(client, id, 'revoked', row.token_version);
        }
        return { installation: view(row) };
      });
    },
    async verifyInstallationToken(id, token) {
      identifier(id);
      if (typeof token !== 'string' || token.length !== 47 || !/^fpr_[A-Za-z0-9_-]{43}$/.test(token)) return null;
      try {
        const result = await pool.query(`SELECT ${installationColumns.split(', ').map(column => column.startsWith('host(') ? column.replace('host(', 'host(i.') : 'i.' + column).join(', ')} FROM fullpanel_registry.installations i JOIN fullpanel_registry.tokens t ON t.installation_id=i.id AND t.version=i.token_version WHERE i.id=$1 AND t.token_hash=$2 AND t.revoked_at IS NULL AND i.status IN ('pending','active')`, [id, digest(token)]);
        return result.rowCount ? view(result.rows[0]) : null;
      } catch { throw unavailable(); }
    }
  };
}
