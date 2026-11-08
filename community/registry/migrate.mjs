/** Operator-only local command. No migration runs automatically when the public server starts. */
import { readFile, stat } from 'node:fs/promises';
import { createRegistryDatabase } from './database.mjs';
import { RegistryError } from './errors.mjs';

let database;
try {
  let ca;
  if (process.env.COMMUNITY_DATABASE_CA_FILE) {
    const file = await stat(process.env.COMMUNITY_DATABASE_CA_FILE);
    if (!file.isFile() || file.size > 1024 * 1024) throw new Error('Invalid CA bundle.');
    ca = await readFile(process.env.COMMUNITY_DATABASE_CA_FILE, 'utf8');
  }
  database = createRegistryDatabase({ connectionString: process.env.DATABASE_URL, ca });
  console.log(JSON.stringify(await database.migrate()));
} catch (cause) {
  console.error(JSON.stringify({ error: cause instanceof RegistryError ? cause.code : 'REGISTRY_MIGRATION_FAILED' }));
  process.exitCode = 1;
} finally { await database?.close(); }
