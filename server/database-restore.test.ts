import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { assertBackupCompatibility, assertEngineCompatible, assertManagedDataPath, restoredEnvironment, NativeDatabaseTools, validateVolumeArchive, validateRestoreFile, verifyPostgresPassword, type RestoreCommand } from './database-restore.js';
import { command } from './docker.js';
import type { Backup, Service } from '../shared/types.js';

function service(kind: Service['kind'] = 'app'): Service {
  return { id: randomUUID(), projectId: randomUUID(), name: 'test', kind, source: { type: 'image', image: 'test:latest' }, env: { POSTGRES_PASSWORD: 'postgres-secret', MONGO_INITDB_ROOT_USERNAME: 'owner', MONGO_INITDB_ROOT_PASSWORD: 'mongo-secret' }, domains: [], mounts: [{ id: randomUUID(), name: 'data', mountPath: kind === 'postgres' ? '/var/lib/postgresql/data' : '/data' }], ports: [], resources: { cpu: 1, memoryMb: 256 }, status: 'running', notes: '', createdAt: '', updatedAt: '' };
}
function backup(source: Service): Backup {
  return { id: randomUUID(), serviceId: source.id, status: 'success', createdAt: '', sizeBytes: 1, filename: 'test.tgz', metadata: { schemaVersion: 1, kind: source.kind, format: source.kind === 'postgres' ? 'postgres-sql' : 'volume-tar', engineVersion: source.kind === 'postgres' ? '17.6' : undefined, mounts: source.mounts.map(({ name, mountPath }) => ({ name, mountPath })) } };
}
async function directory(t: test.TestContext) { const dir = await mkdtemp(join(tmpdir(), 'harborlight-restore-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
function tar(entries: { name: string; type?: string; body?: string; link?: string }[]) {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512), body = Buffer.from(entry.body || '');
    header.write(entry.name); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136); header.fill(32, 148, 156);
    header[156] = (entry.type || '0').charCodeAt(0); if (entry.link) header.write(entry.link, 157);
    header.write('ustar\0', 257); header.write('00', 263);
    const checksum = header.reduce((sum, value) => sum + value, 0); header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    chunks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}

test('archive validator streams regular data and directories within the configured volumes', async t => {
  const filename = join(await directory(t), 'valid.tgz');
  await writeFile(filename, gzipSync(tar([{ name: './', type: '5' }, { name: './data/', type: '5' }, { name: './data/file', body: 'recovered data' }, { name: './data/empty' }])));
  assert.deepEqual(await validateVolumeArchive(filename, ['data']), { files: 2, bytes: 14 });
  await writeFile(filename, gzipSync(tar([{ name: 'dump.rdb', body: 'REDIS00011sample' }])));
  assert.deepEqual(await validateVolumeArchive(filename, ['data'], true), { files: 1, bytes: 16 });
});

test('archives reject traversal, links, extension headers, duplicate paths and unexpected roots before extraction', async t => {
  const filename = join(await directory(t), 'invalid.tgz');
  const invalid = [
    [{ name: '../outside', body: 'x' }], [{ name: '/absolute', body: 'x' }], [{ name: './data/../../outside', body: 'x' }], [{ name: 'data\\outside', body: 'x' }],
    [{ name: 'data/link', type: '2', link: '/outside' }], [{ name: 'data/hard', type: '1', link: 'data/elsewhere' }], [{ name: 'data/device', type: '3' }],
    [{ name: 'data/pax', type: 'x', body: '25 path=../../outside\n' }], [{ name: 'data/long', type: 'L', body: '../outside' }],
    [{ name: 'data/file', body: 'one' }, { name: 'data/file', body: 'two' }], [{ name: 'other/file', body: 'x' }],
    [{ name: 'data/file', body: 'x' }, { name: 'data/file/child', body: 'x' }], [{ name: 'data/file/child', body: 'x' }, { name: 'data/file', body: 'x' }],
    [{ name: 'data/dir/', type: '5', body: 'invalid directory payload' }]
  ];
  for (const entries of invalid) { await writeFile(filename, gzipSync(tar(entries))); await assert.rejects(validateVolumeArchive(filename, ['data']), entries[0].name); }
  await writeFile(filename, gzipSync(tar([{ name: 'dump.rdb', body: 'x' }, { name: 'appendonly.aof', body: 'x' }])));
  await assert.rejects(validateVolumeArchive(filename, ['data'], true), /unexpected/);
});

test('archive integrity rejects malformed checksums, truncation and hidden trailing payload', async t => {
  const filename = join(await directory(t), 'integrity.tgz');
  const valid = tar([{ name: 'data/file', body: 'data' }]);
  const damaged = Buffer.from(valid); damaged[0] ^= 1;
  for (const content of [damaged, valid.subarray(0, 600), Buffer.concat([valid, valid])]) {
    await writeFile(filename, gzipSync(content)); await assert.rejects(validateVolumeArchive(filename, ['data']));
  }
  await writeFile(filename, gzipSync(valid).subarray(0, 20)); await assert.rejects(validateVolumeArchive(filename, ['data']));
});

test('archive validation handles many sibling files without pairwise path comparisons', async t => {
  const filename = join(await directory(t), 'many.tgz');
  await writeFile(filename, gzipSync(tar(Array.from({ length: 5000 }, (_, index) => ({ name: `data/nested/file-${index}`, body: 'x' })))));
  assert.deepEqual(await validateVolumeArchive(filename, ['data']), { files: 5000, bytes: 5000 });
});

test('restore compatibility refuses legacy profiles, wrong engines, unsafe volume remapping and major changes', () => {
  const source = service(), record = backup(source);
  assert.doesNotThrow(() => assertBackupCompatibility(source, record, source));
  assert.throws(() => assertBackupCompatibility(source, { ...record, metadata: undefined }, source), /Legacy/);
  assert.throws(() => assertBackupCompatibility(source, record), /private runtime profile/);
  assert.throws(() => assertBackupCompatibility({ ...source, mounts: [{ ...source.mounts[0], mountPath: '/elsewhere' }] }, record, source), /identical/);
  assert.throws(() => assertBackupCompatibility({ ...source, kind: 'redis' }, record, source), /engine/);
  assert.doesNotThrow(() => assertEngineCompatible('postgres', '17.6', '17.8'));
  assert.doesNotThrow(() => assertEngineCompatible('mysql', '8.4.4', '8.4.7'));
  assert.throws(() => assertEngineCompatible('postgres', '16.8', '17.2'), /incompatible/);
  assert.throws(() => assertEngineCompatible('mysql', '8.0.44', '8.4.7'), /incompatible/);
  assert.throws(() => assertEngineCompatible('redis', 'not-a-version', '7.4.1'), /Unrecognized/);
});

test('native restore validates the actual file format before command execution', async t => {
  const filename = join(await directory(t), 'dump.sql'), source = service('postgres'), record = backup(source);
  await writeFile(filename, '--\n-- PostgreSQL database cluster dump\n--\nSELECT 1;\n');
  await validateRestoreFile(source, record, filename, source);
  await writeFile(filename, 'not a native SQL dump'); await assert.rejects(validateRestoreFile(source, record, filename, source), /header/);
});

test('native commands stream input files and isolate passwords from argv including Mongo readiness', async t => {
  const work = await directory(t), source = service('postgres'); source.env.POSTGRES_USER = 'owner';
  const calls: { args: string[]; inputFile?: string }[] = []; let lastEnvFile = '';
  const run: RestoreCommand = async (_binary, args, options = {}) => {
    calls.push({ args, inputFile: options.inputFile });
    assert.ok(!args.some(value => value.includes('postgres-secret') || value.includes('mongo-secret')));
    const envIndex = args.indexOf('--env-file');
    if (envIndex >= 0) {
      lastEnvFile = args[envIndex + 1]; const env = await readFile(lastEnvFile, 'utf8');
      assert.equal((await stat(lastEnvFile)).mode & 0o777, 0o600);
      assert.ok(env.includes(args.includes('mongosh') ? 'MONGO_INITDB_ROOT_PASSWORD=mongo-secret' : 'PGPASSWORD=postgres-secret'));
    }
    return '1\n';
  };
  const native = new NativeDatabaseTools(run, work);
  await native.restore('candidate', source, '/private/dump.sql');
  assert.equal(calls[0].inputFile, '/private/dump.sql'); assert.ok(calls[0].args.includes('-i')); assert.ok(calls[0].args.includes('-X'));
  await assert.rejects(stat(lastEnvFile), { code: 'ENOENT' });
  await native.ready('candidate', service('mongo'));
  await assert.rejects(stat(lastEnvFile), { code: 'ENOENT' });
});

test('command reads file stdin as a stream, reports missing input and rejects ambiguous input sources', async t => {
  const filename = join(await directory(t), 'input'); await writeFile(filename, Buffer.alloc(1024 * 1024 + 7, 65));
  const result = await command(process.execPath, ['-e', 'let size=0;process.stdin.on("data",x=>size+=x.length);process.stdin.on("end",()=>process.stdout.write(String(size)));'], { inputFile: filename });
  assert.equal(result, String(1024 * 1024 + 7));
  await assert.rejects(command(process.execPath, ['-e', 'process.stdin.resume()'], { inputFile: filename + '.missing' }), /ENOENT/);
  await assert.rejects(command(process.execPath, ['-e', ''], { inputFile: filename, input: 'ambiguous' }), /one command input/);
});

test('command destination is complete and private before success and refuses overwriting an existing backup', async t => {
  const filename = join(await directory(t), 'backup.bin');
  await command(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(3*1024*1024+11,42))'], { destination: filename });
  const bytes = await readFile(filename);
  assert.equal(bytes.length, 3 * 1024 * 1024 + 11); assert.ok(bytes.every(value => value === 42));
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  await assert.rejects(command(process.execPath, ['-e', 'process.stdout.write("replacement")'], { destination: filename }), /EEXIST/);
  assert.equal((await stat(filename)).size, bytes.length);
});

const scram = 'SCRAM-SHA-256$4096:ABEiM0RVZneImaq7zN3u/w==$jLIRlGXjc0AI5Pe6HNd3R/DCcrJHY3yiry3viubzY8Y=:qcBGvAre1E5f93c1XSEHOqL5GFG4+tzUAPgkJBY8+1s=';
const normalizedScram = 'SCRAM-SHA-256$4096:ABEiM0RVZneImaq7zN3u/w==$0qh0eOUyu9IpdsEqv+dJmpamh1DnaQJbJi6+zj/a1oI=:Rp2e2ZyLIEpCh3gvHSi9UdJMqwsswnk/iHtGzCfqc0w=';
const prohibitedScram = 'SCRAM-SHA-256$4096:ABEiM0RVZneImaq7zN3u/w==$5LX+UY72k8ljWauIIOM804pdrDrFyqgyAVfYB0ovWxw=:EPcbY2lbJTq9BBfHdAVuuVo7agzXNSMeK4e/zMd6SLM=';
test('PostgreSQL verifier checks both SCRAM keys, wrong passwords and exact MD5 role names', async () => {
  const rfc7677 = 'SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=';
  assert.equal(await verifyPostgresPassword('pencil', 'user', rfc7677), true);
  assert.equal(await verifyPostgresPassword('pencil', 'owner', scram), true);
  assert.equal(await verifyPostgresPassword('wrong', 'owner', scram), false);
  assert.equal(await verifyPostgresPassword('pencil', 'owner', scram.replace('qcBG', 'rcBG')), false);
  assert.equal(await verifyPostgresPassword('pencil', 'Mixed"Role', 'md5be8c05229df850eebfbd8b2bc5f4c433'), true);
  assert.equal(await verifyPostgresPassword('pencil', 'mixed"role', 'md5be8c05229df850eebfbd8b2bc5f4c433'), false);
  for (const malformed of ['', 'not-a-verifier', scram.replace('$4096:', '$1000001:'), scram.replace('$4096:', '$0:'), scram.replace('ABEi', '***!'), scram.replace('qcBG', ''), scram.replace('3u/w==', '3u/w')]) assert.equal(await verifyPostgresPassword('pencil', 'owner', malformed), false);
});

test('PostgreSQL SCRAM follows SASLprep normalization and its prohibited-character raw fallback', async () => {
  assert.equal(await verifyPostgresPassword('I\u00ADX', 'owner', normalizedScram), true);
  assert.equal(await verifyPostgresPassword('\u2168', 'owner', normalizedScram), true);
  assert.equal(await verifyPostgresPassword('bad\x07password', 'owner', prohibitedScram), true);
  assert.equal(await verifyPostgresPassword('badpassword', 'owner', prohibitedScram), false);
});

test('PostgreSQL readiness verifies real role metadata and rejects stale profiles before dumping even under trust', async t => {
  const work = await directory(t), source = service('postgres');
  source.env = { POSTGRES_USER: 'owner', POSTGRES_PASSWORD: 'pencil', POSTGRES_DB: 'app', PGHOSTADDR: 'hostile.example.test', PGPORT: '9999', PGSERVICE: 'hostile', PGOPTIONS: '-c role=other' };
  let calls = 0, metadata = { name: 'owner', password: scram, canLogin: true, valid: true, identityMatches: true, dataDirectory: '/var/lib/postgresql/data', defaultTablespaces: true };
  const run: RestoreCommand = async (_binary, args) => {
    if (args.includes('readlink')) return '/var/lib/postgresql/data';
    calls++;
    assert.ok(args.includes('env')); assert.ok(args.includes('PGSERVICE'));
    assert.ok(args.some(arg => arg.includes('FROM pg_catalog.pg_authid')));
    assert.ok(args.some(arg => arg.includes('SESSION_USER')));
    assert.ok(!args.includes('pg_dumpall'));
    const env = await readFile(args[args.indexOf('--env-file') + 1], 'utf8');
    assert.match(env, /PGHOSTADDR=127\.0\.0\.1\n/); assert.match(env, /PGPORT=5432\n/); assert.match(env, /PGOPTIONS=\n/);
    assert.ok(!env.includes('PGSERVICE=')); assert.ok(!env.includes('hostile'));
    return JSON.stringify(metadata);
  };
  const native = new NativeDatabaseTools(run, work);
  await native.ready('container', source);
  await assert.rejects(native.backup('container', { ...source, env: { ...source.env, POSTGRES_PASSWORD: 'wrong' } }, join(work, 'backup.sql')), /credentials do not match/);
  assert.equal(calls, 2);
  for (const invalid of [{ canLogin: false }, { valid: false }, { identityMatches: false }, { name: 'different' }, { password: '' }]) {
    const original = metadata; metadata = { ...metadata, ...invalid };
    await assert.rejects(native.ready('container', source), error => error instanceof Error && !error.message.includes(scram) && /credentials do not match/.test(error.message)); metadata = original;
  }
  const count = calls;
  await assert.rejects(native.ready('container', { ...source, env: { ...source.env, POSTGRES_DB: 'host=hostile password=x' } }), /literal PostgreSQL database name/);
  assert.equal(calls, count);
});

test('database environment restoration clears missing source keys instead of retaining stale target settings', () => {
  const postgres = service('postgres'); postgres.env = { POSTGRES_PASSWORD: 'password' };
  assert.deepEqual(restoredEnvironment(postgres), { POSTGRES_USER: 'postgres', POSTGRES_PASSWORD: 'password', POSTGRES_DB: 'postgres', PGDATA: '/var/lib/postgresql/data' });
  const mysql = service('mysql'); mysql.env = { MYSQL_ROOT_PASSWORD: 'root-password' };
  const replaced = { MYSQL_USER: 'old-user', MYSQL_PASSWORD: 'old-password', MYSQL_DATABASE: 'old-db', ...restoredEnvironment(mysql) };
  assert.equal(replaced.MYSQL_USER, ''); assert.equal(replaced.MYSQL_PASSWORD, ''); assert.equal(replaced.MYSQL_DATABASE, '');
});

test('PostgreSQL data paths outside the volume, traversal and custom tablespaces are rejected', async t => {
  const postgres = service('postgres');
  assert.doesNotThrow(() => assertManagedDataPath(postgres, '/var/lib/postgresql/data/nested'));
  for (const path of ['/tmp/db', '/var/lib/postgresql/data-other', '/var/lib/postgresql/data/../other', '/var/lib/postgresql/data//sub', 'relative']) assert.throws(() => assertManagedDataPath(postgres, path), /managed data volume/);
  const record = backup(postgres);
  assert.throws(() => assertBackupCompatibility({ ...postgres, env: { ...postgres.env, PGDATA: '/tmp/db' } }, record, postgres), /managed data volume/);
  assert.throws(() => assertBackupCompatibility(postgres, record, { ...postgres, env: { ...postgres.env, PGDATA: '/tmp/db' } }), /managed data volume/);
  const work = await directory(t); postgres.env = { POSTGRES_USER: 'owner', POSTGRES_PASSWORD: 'pencil', POSTGRES_DB: 'app' };
  const valid = { name: 'owner', password: scram, canLogin: true, valid: true, identityMatches: true, dataDirectory: '/var/lib/postgresql/data', defaultTablespaces: true };
  const outside = new NativeDatabaseTools(async () => JSON.stringify({ ...valid, dataDirectory: '/tmp/db' }), work);
  await assert.rejects(outside.ready('container', postgres), /managed data volume/);
  const tablespace = new NativeDatabaseTools(async () => JSON.stringify({ ...valid, defaultTablespaces: false }), work);
  await assert.rejects(tablespace.ready('container', postgres), /tablespaces/);
  const symlink = new NativeDatabaseTools(async (_binary, args) => args.includes('readlink') ? '/tmp/db' : JSON.stringify(valid), work);
  await assert.rejects(symlink.ready('container', postgres), /managed data volume/);
});
