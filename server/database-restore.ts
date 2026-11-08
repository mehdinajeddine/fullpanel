import { createReadStream } from 'node:fs';
import { lstat, open, writeFile, rm } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { createHash, createHmac, pbkdf2, randomUUID, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { join } from 'node:path';
import saslprep from '@mongodb-js/saslprep';
import type { Backup, BackupMetadata, Service, ServiceKind } from '../shared/types.js';

export type RestoreCommand = (binary: string, args: string[], options?: { input?: string; inputFile?: string; destination?: string; timeout?: number; output?: (value: string) => void }) => Promise<string>;
const derivePassword = promisify(pbkdf2);
/** Verify the server's actual role secret even when pg_hba permits loopback trust. */
export async function verifyPostgresPassword(password: string, role: string, verifier: string): Promise<boolean> {
  if (!password || password.length > 16000 || verifier.length > 4096) return false;
  if (/^md5[a-f0-9]{32}$/.test(verifier)) return timingSafeEqual(createHash('md5').update(password + role, 'utf8').digest(), Buffer.from(verifier.slice(3), 'hex'));
  const matched = /^SCRAM-SHA-256\$([1-9][0-9]{0,6}):([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2}):([A-Za-z0-9+/]+={0,2})$/.exec(verifier);
  if (!matched) return false;
  const iterations = Number(matched[1]);
  if (iterations > 1_000_000) return false;
  const decode = (value: string) => { const decoded = Buffer.from(value, 'base64'); return decoded.toString('base64') === value ? decoded : undefined; };
  const salt = decode(matched[2]), expectedStored = decode(matched[3]), expectedServer = decode(matched[4]);
  if (!salt || salt.length < 1 || salt.length > 1024 || expectedStored?.length !== 32 || expectedServer?.length !== 32) return false;
  let prepared = password;
  try { prepared = saslprep(password); } catch { /* PostgreSQL uses the raw password when SASLprep rejects it. */ }
  const salted = await derivePassword(prepared, salt, iterations, 32, 'sha256');
  const client = createHmac('sha256', salted).update('Client Key').digest();
  const stored = createHash('sha256').update(client).digest();
  const server = createHmac('sha256', salted).update('Server Key').digest();
  try {
    const storedMatches = timingSafeEqual(stored, expectedStored), serverMatches = timingSafeEqual(server, expectedServer);
    return storedMatches && serverMatches;
  } finally { salted.fill(0); client.fill(0); stored.fill(0); server.fill(0); }
}
export const backupFormats: Record<Exclude<ServiceKind, 'compose'>, BackupMetadata['format']> = { app: 'volume-tar', postgres: 'postgres-sql', mysql: 'mysql-sql', mariadb: 'mariadb-sql', mongo: 'mongo-archive', redis: 'redis-rdb-tar' };
export const databasePaths: Partial<Record<ServiceKind, string>> = { postgres: '/var/lib/postgresql/data', mysql: '/var/lib/mysql', mariadb: '/var/lib/mysql', mongo: '/data/db', redis: '/data' };
export const databaseEnvironmentKeys: Partial<Record<ServiceKind, string[]>> = {
  postgres: ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'PGDATA'],
  mysql: ['MYSQL_ROOT_PASSWORD', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE'],
  mariadb: ['MARIADB_ROOT_PASSWORD', 'MARIADB_USER', 'MARIADB_PASSWORD', 'MARIADB_DATABASE'],
  mongo: ['MONGO_INITDB_ROOT_USERNAME', 'MONGO_INITDB_ROOT_PASSWORD', 'MONGO_INITDB_DATABASE'], redis: ['REDIS_PASSWORD']
};
export function restoredEnvironment(source: Service): Record<string, string> {
  const environment = Object.fromEntries((databaseEnvironmentKeys[source.kind] || []).map(key => [key, source.env[key] || '']));
  if (source.kind === 'postgres') {
    environment.POSTGRES_USER = source.env.POSTGRES_USER || 'postgres';
    environment.POSTGRES_DB = source.env.POSTGRES_DB || environment.POSTGRES_USER;
    environment.PGDATA = source.env.PGDATA || '/var/lib/postgresql/data';
  }
  if (source.kind === 'mongo') environment.MONGO_INITDB_DATABASE = source.env.MONGO_INITDB_DATABASE || 'test';
  return environment;
}
export function assertManagedDataPath(service: Service, path: string) {
  const root = databasePaths[service.kind], normalized = path.replace(/\/+$/, '');
  if (!root || service.mounts.length !== 1 || service.mounts[0].mountPath !== root || !normalized.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(normalized) || normalized.includes('//') || normalized.split('/').some(part => part === '..' || part === '.') || normalized !== root && !normalized.startsWith(root + '/')) throw new Error('The actual database data directory must be inside its single managed data volume.');
}
export function assertBackupCompatibility(target: Service, backup: Backup, source?: Service) {
  if (backup.status !== 'success' || !backup.metadata || backup.metadata.schemaVersion !== 1) throw new Error('Legacy or incomplete backup: create a new backup with restore metadata.');
  if (!source || source.id !== backup.serviceId || source.kind !== backup.metadata.kind) throw new Error('Backup has no matching private runtime profile. Create a new backup before restoring.');
  if (target.kind === 'compose' || target.kind !== backup.metadata.kind || backup.metadata.format !== backupFormats[target.kind]) throw new Error('Backup format or engine does not match this target.');
  if (target.kind === 'app') {
    const targetPaths = target.mounts.map(mount => `${mount.name}:${mount.mountPath}`).sort();
    const sourcePaths = backup.metadata.mounts.map(mount => `${mount.name}:${mount.mountPath}`).sort();
    if (!targetPaths.length || JSON.stringify(targetPaths) !== JSON.stringify(sourcePaths)) throw new Error('Volume restore requires identical logical volume names and mount paths.');
  } else {
    const path = databasePaths[target.kind];
    if (target.mounts.length !== 1 || target.mounts[0].mountPath !== path) throw new Error('Native restore requires one managed volume at the engine default data path.');
    if (!backup.metadata.engineVersion) throw new Error('Backup lacks its source engine version.');
    const passwordKey = { postgres: 'POSTGRES_PASSWORD', mysql: 'MYSQL_ROOT_PASSWORD', mariadb: 'MARIADB_ROOT_PASSWORD', mongo: 'MONGO_INITDB_ROOT_PASSWORD', redis: 'REDIS_PASSWORD' }[target.kind];
    if (!source.env[passwordKey]) throw new Error('Backup profile lacks the source database credentials.');
    if (target.kind === 'postgres') for (const profile of [target, source]) assertManagedDataPath(profile, profile.env.PGDATA || '/var/lib/postgresql/data');
  }
}
export function assertEngineCompatible(kind: ServiceKind, original: string, target: string) {
  const fields = kind === 'mysql' || kind === 'mariadb' ? 2 : 1;
  const version = (value: string) => { if (!/^\d+\.\d+(?:\.\d+)?(?:[-+].*)?$/.test(value)) throw new Error('Unrecognized database engine version.'); return value.split('.').slice(0, fields).join('.'); };
  if (version(original) !== version(target)) throw new Error(`Backup engine ${original} is incompatible with target ${target}; restore into the same engine ${fields === 2 ? 'major/minor series' : 'major version'}.`);
}

function textField(block: Buffer, start: number, length: number): string {
  const bytes = block.subarray(start, start + length), end = bytes.indexOf(0);
  return bytes.subarray(0, end < 0 ? bytes.length : end).toString('utf8');
}
function octal(block: Buffer, start: number, length: number): number {
  const text = textField(block, start, length).trim();
  if (!/^[0-7]*$/.test(text)) throw new Error('Archive uses unsupported numeric header encoding.');
  const value = text ? parseInt(text, 8) : 0;
  if (!Number.isSafeInteger(value) || value < 0 || value > 2 ** 40) throw new Error('Archive entry size exceeds supported limits.');
  return value;
}
/** Streaming tar validation: only regular files/directories, no traversal, links or extension headers. */
export async function validateVolumeArchive(filename: string, allowedRoots: string[], redis = false): Promise<{ files: number; bytes: number }> {
  const source = createReadStream(filename), gunzip = createGunzip(); source.pipe(gunzip);
  source.on('error', error => gunzip.destroy(error));
  let pending: Buffer = Buffer.alloc(0); let remaining = 0, zeros = 0, ended = false, count = 0, files = 0, bytes = 0;
  const seen = new Map<string, string>(), parentPaths = new Set<string>();
  try {
    for await (const value of gunzip) {
      let chunk = value as Buffer;
      if (remaining) { const skip = Math.min(chunk.length, remaining); chunk = chunk.subarray(skip); remaining -= skip; if (!chunk.length) continue; }
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= 512 && !remaining) {
        const header = pending.subarray(0, 512); pending = pending.subarray(512);
        if (header.every(byte => byte === 0)) { zeros++; if (zeros >= 2) ended = true; continue; }
        if (ended || zeros) throw new Error('Archive has data after its end marker.');
        let checksum = 0; for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
        if (checksum !== octal(header, 148, 8)) throw new Error('Archive header checksum is invalid.');
        const prefix = textField(header, 345, 155), rawName = `${prefix ? prefix + '/' : ''}${textField(header, 0, 100)}`;
        const type = String.fromCharCode(header[156] || 48);
        if (!['0', '5'].includes(type)) throw new Error('Archive links, devices and extended headers are not supported.');
        if (rawName.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(rawName) || rawName.split('/').some(part => part === '..')) throw new Error('Archive path escapes its volume.');
        const name = rawName.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
        if (!name || name === '.') { if (type !== '5') throw new Error('Archive root must be a directory.'); }
        else {
          if (name.split('/').some(part => !part || part === '.')) throw new Error('Archive contains a noncanonical path.');
          if (redis ? name !== 'dump.rdb' || type !== '0' : !allowedRoots.includes(name.split('/')[0])) throw new Error('Archive contains an unexpected volume or file.');
          if (seen.has(name)) throw new Error('Archive contains duplicate paths.');
          for (let parent = name.lastIndexOf('/'); parent > 0; parent = name.lastIndexOf('/', parent - 1)) {
            const path = name.slice(0, parent);
            if (seen.get(path) === '0') throw new Error('Archive places content inside a regular file.');
            parentPaths.add(path);
          }
          if (type === '0' && parentPaths.has(name)) throw new Error('Archive replaces a directory with a regular file.');
          seen.set(name, type);
        }
        const size = octal(header, 124, 12);
        if (type === '5' && size !== 0) throw new Error('Archive directory has an invalid payload.');
        if (++count > 1_000_000) throw new Error('Archive has too many entries.');
        if (type === '0') { files++; bytes += size; }
        remaining = Math.ceil(size / 512) * 512;
        const skip = Math.min(pending.length, remaining); pending = pending.subarray(skip); remaining -= skip;
      }
    }
    if (remaining || pending.length || !ended || redis && (!seen.has('dump.rdb') || !bytes)) throw new Error('Archive is truncated or does not contain the expected data.');
    return { files, bytes };
  } finally { source.destroy(); gunzip.destroy(); }
}

export async function validateRestoreFile(target: Service, backup: Backup, filename: string, source?: Service) {
  assertBackupCompatibility(target, backup, source);
  const details = await lstat(filename);
  if (!details.isFile() || details.isSymbolicLink() || details.size < 1) throw new Error('Restore requires a nonempty regular backup file.');
  if (target.kind === 'redis' || target.kind === 'app') return void await validateVolumeArchive(filename, target.mounts.map(mount => mount.name), target.kind === 'redis');
  const descriptor = await open(filename, 'r');
  try {
    const header = Buffer.alloc(512); const { bytesRead } = await descriptor.read(header, 0, header.length, 0);
    if (target.kind === 'mongo' && !(header[0] === 0x1f && header[1] === 0x8b)) throw new Error('MongoDB restore requires a gzip native archive.');
    if (['postgres', 'mysql', 'mariadb'].includes(target.kind) && (header.subarray(0, bytesRead).includes(0) || !/PostgreSQL database cluster dump|MySQL dump|MariaDB dump/.test(header.toString('utf8')))) throw new Error('SQL backup header does not match a supported native dump.');
  } finally { await descriptor.close(); }
}

export class NativeDatabaseTools {
  constructor(private run: RestoreCommand, private work: string) {}
  async version(container: string, kind: ServiceKind): Promise<string> {
    const binary = { postgres: 'postgres', mysql: 'mysqld', mariadb: 'mariadbd', mongo: 'mongod', redis: 'redis-server' }[kind as 'postgres'];
    if (!binary) throw new Error('This service has no native database engine.');
    const output = await this.run('docker', ['exec', container, binary, '--version']);
    const matched = output.match(kind === 'redis' ? /v=(\d+\.\d+(?:\.\d+)?)/ : /(?:PostgreSQL\)?\s*|Ver\s+|v)(\d+\.\d+(?:\.\d+)?)/i) || output.match(/(\d+\.\d+\.\d+)/);
    if (!matched) throw new Error('Could not identify the database engine version.');
    return matched[1];
  }
  async execute(container: string, service: Service, args: string[], options: { input?: string; inputFile?: string; destination?: string; timeout?: number } = {}) {
    const filename = join(this.work, `database-client-${randomUUID()}.env`);
    if (service.kind === 'postgres' && (service.env.POSTGRES_DB?.includes('=') || /^postgres(?:ql)?:\/\//i.test(service.env.POSTGRES_DB || ''))) throw new Error('Use a literal PostgreSQL database name, not a connection string.');
    const env = service.kind === 'postgres' ? { PGPASSWORD: service.env.POSTGRES_PASSWORD || '', PGCONNECT_TIMEOUT: '5', PGHOST: '127.0.0.1', PGHOSTADDR: '127.0.0.1', PGPORT: '5432', PGUSER: service.env.POSTGRES_USER || 'postgres', PGDATABASE: service.env.POSTGRES_DB || service.env.POSTGRES_USER || 'postgres', PGOPTIONS: '', PGPASSFILE: '/dev/null', PGCLIENTENCODING: 'UTF8' }
      : service.kind === 'mysql' ? { MYSQL_PWD: service.env.MYSQL_ROOT_PASSWORD || '' }
      : service.kind === 'mariadb' ? { MYSQL_PWD: service.env.MARIADB_ROOT_PASSWORD || '' }
      : service.kind === 'redis' ? { REDISCLI_AUTH: service.env.REDIS_PASSWORD || '' }
      : service.kind === 'mongo' ? { MONGO_INITDB_ROOT_USERNAME: service.env.MONGO_INITDB_ROOT_USERNAME || '', MONGO_INITDB_ROOT_PASSWORD: service.env.MONGO_INITDB_ROOT_PASSWORD || '' } : {};
    if (['mysql', 'mysqldump', 'mariadb', 'mariadb-dump'].includes(args[0])) args = [args[0], '--no-defaults', ...(service.kind === 'mysql' ? ['--no-login-paths'] : []), '--protocol=TCP', '-h', '127.0.0.1', '-P', '3306', ...args.slice(1)];
    if (args[0] === 'mongosh') args = [args[0], '--host', '127.0.0.1', '--port', '27017', ...args.slice(1)];
    if (args[0] === 'redis-cli') args = [args[0], '-h', '127.0.0.1', '-p', '6379', ...args.slice(1)];
    if (service.kind === 'postgres') args = ['env', '-u', 'PGSERVICE', '-u', 'PGSERVICEFILE', '-u', 'PGSYSCONFDIR', ...args];
    await writeFile(filename, Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600, flag: 'wx' });
    try { return await this.run('docker', ['exec', ...(options.input !== undefined || options.inputFile ? ['-i'] : []), '--env-file', filename, container, ...args], options); }
    finally { await rm(filename, { force: true }); }
  }
  private async mongo(container: string, service: Service, binary: string, args: string[], options: { inputFile?: string; destination?: string; timeout?: number }) {
    const name = `harborlight-mongo-${randomUUID()}.json`, local = join(this.work, name), remote = `/tmp/${name}`;
    await writeFile(local, JSON.stringify({ password: service.env.MONGO_INITDB_ROOT_PASSWORD }), { mode: 0o600, flag: 'wx' });
    try {
      await this.run('docker', ['cp', local, `${container}:${remote}`]);
      return await this.run('docker', ['exec', ...(options.inputFile ? ['-i'] : []), container, binary, '--host', '127.0.0.1', '--port', '27017', '--config', remote, '--username', service.env.MONGO_INITDB_ROOT_USERNAME, '--authenticationDatabase', 'admin', ...args], options);
    } finally { await this.run('docker', ['exec', container, 'rm', '-f', remote]).catch(() => {}); await rm(local, { force: true }); }
  }
  async ready(container: string, service: Service): Promise<void> {
    let output: string;
    switch (service.kind) {
      case 'postgres': {
        const role = service.env.POSTGRES_USER || 'postgres';
        const query = "SELECT pg_catalog.json_build_object('name',rolname,'password',rolpassword,'canLogin',rolcanlogin,'valid',rolvaliduntil IS NULL OR rolvaliduntil OPERATOR(pg_catalog.>) CURRENT_TIMESTAMP,'identityMatches',SESSION_USER OPERATOR(pg_catalog.=) CURRENT_USER,'dataDirectory',pg_catalog.current_setting('data_directory'),'defaultTablespaces',NOT EXISTS(SELECT 1 FROM pg_catalog.pg_tablespace WHERE pg_catalog.pg_tablespace_location(oid) OPERATOR(pg_catalog.<>) ''))::text FROM pg_catalog.pg_authid WHERE rolname OPERATOR(pg_catalog.=) SESSION_USER";
        const result = await this.execute(container, service, ['psql', '-X', '-h', '127.0.0.1', '-p', '5432', '-U', role, '-d', service.env.POSTGRES_DB || role, '-Atc', query]);
        let profile: { name?: unknown; password?: unknown; canLogin?: unknown; valid?: unknown; identityMatches?: unknown; dataDirectory?: unknown; defaultTablespaces?: unknown };
        try { profile = JSON.parse(result); } catch { throw new Error('PostgreSQL did not return valid credential verification metadata.'); }
        if (!profile || profile.name !== role || profile.canLogin !== true || profile.valid !== true || profile.identityMatches !== true || typeof profile.password !== 'string' || !await verifyPostgresPassword(service.env.POSTGRES_PASSWORD || '', role, profile.password)) throw new Error('PostgreSQL runtime credentials do not match the saved profile or the role cannot log in.');
        if (profile.defaultTablespaces !== true) throw new Error('Custom PostgreSQL tablespaces are not supported for automatic backup or recovery.');
        if (typeof profile.dataDirectory !== 'string') throw new Error('PostgreSQL did not report its actual data directory.');
        assertManagedDataPath(service, profile.dataDirectory);
        assertManagedDataPath(service, (await this.run('docker', ['exec', container, 'readlink', '-f', profile.dataDirectory])).trim());
        return;
      }
      case 'mysql': case 'mariadb': output = await this.execute(container, service, [service.kind === 'mysql' ? 'mysql' : 'mariadb', '--protocol=TCP', '-h', '127.0.0.1', '-u', 'root', '-Nse', 'SELECT 1']); break;
      case 'mongo': output = await this.execute(container, service, ['mongosh', '--quiet', '--eval', 'const a=db.getSiblingDB("admin"); if(!a.auth(process.env.MONGO_INITDB_ROOT_USERNAME,process.env.MONGO_INITDB_ROOT_PASSWORD).ok) quit(2); if(a.runCommand({ping:1}).ok!==1) quit(3); print("1");']); break;
      case 'redis': output = await this.execute(container, service, ['redis-cli', '-e', '--raw', 'PING']); break;
      default: return;
    }
    if (output.trim() !== (service.kind === 'redis' ? 'PONG' : '1')) throw new Error('Database did not pass authenticated readiness verification.');
  }
  async backup(container: string, service: Service, destination: string) {
    // A stale profile must never be attached to an otherwise valid native dump.
    await this.ready(container, service);
    const options = { destination, timeout: 1800000 };
    switch (service.kind) {
      case 'postgres': return this.execute(container, service, ['pg_dumpall', '-h', '127.0.0.1', '-U', service.env.POSTGRES_USER || 'postgres'], options);
      case 'mysql': return this.execute(container, service, ['mysqldump', '--all-databases', '--single-transaction', '--routines', '--events', '--triggers', '-u', 'root'], options);
      case 'mariadb': return this.execute(container, service, ['mariadb-dump', '--all-databases', '--single-transaction', '--routines', '--events', '--triggers', '-u', 'root'], options);
      case 'mongo': return this.mongo(container, service, 'mongodump', ['--archive', '--gzip'], options);
      case 'redis':
        await this.execute(container, service, ['redis-cli', '-e', 'SAVE']);
        return this.run('docker', ['exec', container, 'tar', '-czf', '-', '-C', '/data', 'dump.rdb'], options);
      default: throw new Error('This service does not support native database backups.');
    }
  }
  async restore(container: string, service: Service, filename: string) {
    const options = { inputFile: filename, timeout: 1800000 };
    switch (service.kind) {
      case 'postgres': return this.execute(container, service, ['psql', '-X', '-h', '127.0.0.1', '-U', service.env.POSTGRES_USER!, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], options);
      case 'mysql': case 'mariadb': return this.execute(container, service, [service.kind === 'mysql' ? 'mysql' : 'mariadb', '--binary-mode=1', '-u', 'root'], options);
      case 'mongo': return this.mongo(container, service, 'mongorestore', ['--archive', '--gzip', '--drop', '--stopOnError'], options);
      default: throw new Error('Use validated volume extraction for this backup format.');
    }
  }
}
