import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { z } from 'zod';
import { BackupScheduler, nextBackupOccurrence, registerBackupSchedules, type BackupSchedule, type BackupScheduleDependencies, type ScheduledBackup } from './backup-schedules.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'harborlight-scheduler-'));
  const directory = join(root, 'backups'); await mkdir(directory);
  const serviceId = randomUUID(), otherServiceId = randomUUID();
  const services = new Set<string>([serviceId, otherServiceId]);
  let schedules: BackupSchedule[] = [];
  let backups: ScheduledBackup[] = [];
  let now = new Date('2026-11-08T01:59:30.000Z');
  let busy = false, persisted = '[]';
  const calls: string[] = [];
  const dependencies: BackupScheduleDependencies = {
    listSchedules: () => schedules,
    saveSchedules: values => { schedules = values; persisted = JSON.stringify(values); },
    getService: id => services.has(id) ? { id, kind: 'postgres', mounts: [] } : undefined,
    getBackups: () => backups,
    queueBackup: (id, scheduleId) => {
      if (busy || backups.some(backup => backup.serviceId === id && backup.status === 'running')) throw Object.assign(new Error('Busy'), { statusCode: 409 });
      calls.push(id);
      const backup: ScheduledBackup = { id: randomUUID(), serviceId: id, scheduleId, status: 'running', filename: `${randomUUID()}.sql`, createdAt: now.toISOString(), sizeBytes: 0 };
      backups.push(backup); return backup;
    },
    forgetBackup: id => { backups = backups.filter(backup => backup.id !== id); },
    backupDirectory: directory,
    now: () => new Date(now),
    startTimer: false
  };
  const scheduler = new BackupScheduler(dependencies);
  async function seed(scheduleId: string | undefined, at: string, options: Partial<ScheduledBackup> = {}) {
    const backup: ScheduledBackup = { id: randomUUID(), serviceId, scheduleId, status: 'success', createdAt: at, sizeBytes: 10, filename: `${randomUUID()}.sql`, ...options };
    backups.push(backup);
    if (!backup.filename.includes('/') && backup.filename !== '..') await writeFile(join(directory, backup.filename), 'valid backup data');
    return backup;
  }
  return {
    root, directory, serviceId, otherServiceId, services, dependencies, scheduler, calls, seed,
    schedules: () => schedules, backups: () => backups,
    setTime: (value: string) => { now = new Date(value); },
    setBusy: (value: boolean) => { busy = value; },
    restart: () => { schedules = JSON.parse(persisted); return new BackupScheduler(dependencies); },
    close: async () => { await scheduler.stop(); await rm(root, { recursive: true, force: true }); }
  };
}

test('UTC next occurrences handle exact boundaries, weekly dates and year rollover', () => {
  const base = { frequency: 'daily' as const, hour: 2, minute: 0, weekday: 0 };
  assert.equal(nextBackupOccurrence(base, new Date('2026-11-08T01:59:59Z')), '2026-11-08T02:00:00.000Z');
  assert.equal(nextBackupOccurrence(base, new Date('2026-11-08T02:00:00Z')), '2026-11-09T02:00:00.000Z');
  assert.equal(nextBackupOccurrence({ ...base, frequency: 'weekly' }, new Date('2026-11-08T02:00:00Z')), '2026-11-15T02:00:00.000Z');
  assert.equal(nextBackupOccurrence({ ...base, frequency: 'weekly', weekday: 1 }, new Date('2026-11-08T02:00:00Z')), '2026-11-09T02:00:00.000Z');
  assert.equal(nextBackupOccurrence({ ...base, frequency: 'hourly', minute: 10 }, new Date('2026-12-31T23:55:00Z')), '2027-01-01T00:10:00.000Z');
});

test('corrupt persisted retention never removes any backup copy', async t => {
  const f = await fixture(); t.after(f.close);
  const schedule = f.scheduler.create(f.serviceId, { enabled: false, retention: 1 });
  const old = await f.seed(schedule.id, '2026-11-06T00:00:00.000Z');
  const latest = await f.seed(schedule.id, '2026-11-07T00:00:00.000Z');
  schedule.retention = Number.NaN;
  await f.scheduler.tick();
  assert.equal(f.backups().length, 2);
  assert.ok((await stat(join(f.directory, old.filename))).size > 0);
  assert.ok((await stat(join(f.directory, latest.filename))).size > 0);
  assert.match(schedule.retentionError || '', /could not safely/);
});

test('due schedule starts once, persists next run, and observes completed backup', async t => {
  const f = await fixture(); t.after(f.close);
  const schedule = f.scheduler.create(f.serviceId, {});
  assert.equal(schedule.timezone, 'UTC');
  assert.equal(schedule.nextRunAt, '2026-11-08T02:00:00.000Z');
  await f.scheduler.tick(); assert.equal(f.calls.length, 0);
  f.setTime('2026-11-08T02:00:00Z');
  await Promise.all([f.scheduler.tick(), f.scheduler.tick()]);
  assert.equal(f.calls.length, 1);
  assert.equal(schedule.lastStatus, 'running');
  assert.equal(schedule.nextRunAt, '2026-11-09T02:00:00.000Z');
  const backup = f.backups()[0];
  await writeFile(join(f.directory, backup.filename), 'database dump');
  backup.status = 'success';
  await f.scheduler.tick();
  assert.equal(schedule.lastStatus, 'success');
  assert.equal(f.calls.length, 1);
});

test('restart after a long outage produces one catch-up, not a storm', async t => {
  const f = await fixture(); t.after(f.close);
  f.scheduler.create(f.serviceId, {});
  f.setTime('2026-12-01T10:00:00Z');
  const restarted = f.restart();
  await restarted.tick(); await restarted.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.schedules()[0].nextRunAt, '2026-12-02T02:00:00.000Z');
  const persistedAgain = f.restart();
  await persistedAgain.tick();
  assert.equal(f.calls.length, 1);
});

test('busy services defer exactly one minute and then use the same queue', async t => {
  const f = await fixture(); t.after(f.close);
  const schedule = f.scheduler.create(f.serviceId, {});
  f.setTime('2026-11-08T02:00:00Z'); f.setBusy(true);
  await f.scheduler.tick();
  assert.equal(schedule.lastStatus, 'deferred');
  assert.equal(schedule.nextRunAt, '2026-11-08T02:01:00.000Z');
  assert.equal(f.calls.length, 0);
  f.setTime('2026-11-08T02:00:59Z'); f.setBusy(false);
  await f.scheduler.tick(); assert.equal(f.calls.length, 0);
  f.setTime('2026-11-08T02:01:00Z'); await f.scheduler.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(schedule.lastStatus, 'running');
  assert.equal(schedule.nextRunAt, '2026-11-09T02:00:00.000Z');
});

test('failed backups expose an error and allow a deliberate manual retry', async t => {
  const f = await fixture(); t.after(f.close);
  const schedule = f.scheduler.create(f.serviceId, {});
  f.setTime('2026-11-08T02:00:00Z'); await f.scheduler.tick();
  f.backups()[0].status = 'failed'; f.backups()[0].error = 'Destination unavailable';
  await f.scheduler.tick();
  assert.equal(schedule.lastStatus, 'failed');
  assert.equal(schedule.lastError, 'Destination unavailable');
  assert.equal(f.calls.length, 1);
  f.scheduler.run(schedule.id);
  assert.equal(f.calls.length, 2);
  assert.equal(schedule.lastStatus, 'running');
  assert.equal(schedule.lastError, undefined);
});

test('disabling and partial updates preserve unrelated configuration; deletion retains files', async t => {
  const f = await fixture(); t.after(f.close);
  const schedule = f.scheduler.create(f.serviceId, { frequency: 'weekly', hour: 5, minute: 15, weekday: 3, retention: 4 });
  f.scheduler.update(schedule.id, { enabled: false });
  assert.equal(schedule.frequency, 'weekly'); assert.equal(schedule.hour, 5); assert.equal(schedule.retention, 4);
  assert.equal(schedule.nextRunAt, null);
  f.setTime('2026-12-01T00:00:00Z'); await f.scheduler.tick(); assert.equal(f.calls.length, 0);
  const backup = await f.seed(schedule.id, '2026-10-01T00:00:00Z');
  f.scheduler.remove(schedule.id);
  assert.equal(f.schedules().length, 0); assert.equal(f.backups().length, 1);
  assert.ok((await stat(join(f.directory, backup.filename))).isFile());
});

test('deleted service is disabled without queueing new backups', async t => {
  const f = await fixture(); t.after(f.close);
  const schedule = f.scheduler.create(f.serviceId, {});
  f.services.delete(f.serviceId); f.setTime('2026-11-08T02:00:00Z');
  await f.scheduler.tick();
  assert.equal(schedule.enabled, false); assert.equal(schedule.nextRunAt, null);
  assert.equal(schedule.lastStatus, 'failed'); assert.equal(f.calls.length, 0);
});

test('retention only deletes successful files owned by the exact schedule and service', async t => {
  const f = await fixture(); t.after(f.close);
  const schedule = f.scheduler.create(f.serviceId, { retention: 1 });
  const old = await f.seed(schedule.id, '2026-11-01T02:00:00Z');
  const latest = await f.seed(schedule.id, '2026-11-02T02:00:00Z');
  const manual = await f.seed(undefined, '2026-10-01T02:00:00Z');
  const other = await f.seed(randomUUID(), '2026-10-01T02:00:00Z');
  const differentService = await f.seed(schedule.id, '2026-10-01T02:00:00Z', { serviceId: f.otherServiceId });
  await f.scheduler.tick();
  await assert.rejects(stat(join(f.directory, old.filename)), { code: 'ENOENT' });
  for (const backup of [latest, manual, other, differentService]) assert.ok((await stat(join(f.directory, backup.filename))).isFile());
  assert.ok(!f.backups().some(backup => backup.id === old.id));
  assert.equal(schedule.retentionError, undefined);
});

test('missing latest copy prevents retention from deleting the older usable backup', async t => {
  const f = await fixture(); t.after(f.close);
  const schedule = f.scheduler.create(f.serviceId, { retention: 1 });
  const old = await f.seed(schedule.id, '2026-11-01T02:00:00Z');
  const latest = await f.seed(schedule.id, '2026-11-02T02:00:00Z');
  await rm(join(f.directory, latest.filename));
  await f.scheduler.tick();
  assert.ok(schedule.retentionError);
  assert.ok((await stat(join(f.directory, old.filename))).isFile());
  assert.equal(f.backups().length, 2);
});

test('retention refuses path traversal, symlinks and filenames referenced by another backup', async t => {
  const f = await fixture(); t.after(f.close);
  const schedule = f.scheduler.create(f.serviceId, { retention: 1 });
  const outside = join(f.root, 'outside.sql'); await writeFile(outside, 'keep outside');
  const malicious = await f.seed(schedule.id, '2026-11-01T02:00:00Z', { filename: '../outside.sql' });
  await f.seed(schedule.id, '2026-11-02T02:00:00Z');
  await f.scheduler.tick();
  assert.ok(schedule.retentionError); assert.equal(await readFile(outside, 'utf8'), 'keep outside');
  malicious.filename = 'linked.sql'; await symlink(outside, join(f.directory, malicious.filename));
  await f.scheduler.tick();
  assert.ok(schedule.retentionError); assert.equal(await readFile(outside, 'utf8'), 'keep outside');
  await rm(join(f.directory, malicious.filename)); await writeFile(join(f.directory, malicious.filename), 'shared copy');
  await f.seed(undefined, '2026-10-01T02:00:00Z', { filename: malicious.filename });
  await f.scheduler.tick();
  assert.ok(schedule.retentionError); assert.ok((await stat(join(f.directory, malicious.filename))).isFile());
});

test('schedule API validates bounds and remains authenticated', async t => {
  const f = await fixture(); t.after(f.close);
  const app = Fastify(); t.after(() => app.close());
  app.addHook('onRequest', async request => { if (request.headers['x-test-owner'] !== 'yes') throw Object.assign(new Error('Sign in'), { statusCode: 401 }); });
  app.setErrorHandler((error, _request, reply) => { reply.status(error instanceof z.ZodError ? 400 : (error as { statusCode?: number }).statusCode || 500).send({ error: (error as Error).message }); });
  registerBackupSchedules(app, f.dependencies);
  assert.equal((await app.inject({ method: 'GET', url: '/api/backup-schedules' })).statusCode, 401);
  const headers = { 'x-test-owner': 'yes' };
  for (const payload of [{ retention: 0 }, { minute: 60 }, { hour: 24 }, { weekday: 7 }, { frequency: 'cron' }, { timezone: 'local' }]) {
    assert.equal((await app.inject({ method: 'POST', url: `/api/services/${f.serviceId}/backup-schedules`, headers, payload })).statusCode, 400);
  }
  const created = await app.inject({ method: 'POST', url: `/api/services/${f.serviceId}/backup-schedules`, headers, payload: {} });
  assert.equal(created.statusCode, 201);
  assert.equal((await app.inject({ method: 'GET', url: '/api/backup-schedules', headers })).json().length, 1);
  const run = await app.inject({ method: 'POST', url: `/api/backup-schedules/${created.json().id}/run`, headers });
  assert.equal(run.statusCode, 202);
  assert.equal(run.json().scheduleId, created.json().id);
});
