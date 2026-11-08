import { readFile, stat } from 'node:fs/promises';
import { createRegistryDatabase } from './registry/database.mjs';

/** Configuration comes from the operator, never from an HTTP request. */
export async function createRegistryRuntime(env = process.env) {
  if (!env.DATABASE_URL) return null;
  let ca;
  if (env.COMMUNITY_DATABASE_CA_FILE) {
    const metadata = await stat(env.COMMUNITY_DATABASE_CA_FILE);
    if (!metadata.isFile() || metadata.size > 1024 * 1024) throw new Error('Invalid registry CA file.');
    ca = await readFile(env.COMMUNITY_DATABASE_CA_FILE, 'utf8');
  }
  return createRegistryDatabase({ connectionString: env.DATABASE_URL, ca });
}

/** Bound public probes to one sample per second and share concurrent work. */
export function registryReadiness(registry) {
  let pending;
  let sampledAt = 0;
  let ready = false;
  return async () => {
    if (!registry) return false;
    if (pending) return pending;
    if (Date.now() - sampledAt < 1000) return ready;
    pending = Promise.resolve().then(() => registry.readiness()).then(value => value?.ready === true, () => false);
    try { ready = await pending; sampledAt = Date.now(); return ready; }
    finally { pending = undefined; }
  };
}
