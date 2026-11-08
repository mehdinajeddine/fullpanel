import { randomUUID } from 'node:crypto';
import { lstat, realpath, unlink } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Backup, Service } from '../shared/types.js';

export interface BackupSchedule {
  id: string;
  serviceId: string;
  frequency: 'hourly' | 'daily' | 'weekly';
  minute: number;
  hour: number;
  weekday: number;
  retention: number;
  enabled: boolean;
  timezone: 'UTC';
  createdAt: string;
  nextRunAt: string | null;
  lastRunAt?: string;
  lastBackupId?: string;
  lastStatus: 'idle' | 'running' | 'success' | 'failed' | 'deferred';
  lastError?: string;
  retentionError?: string;
}

export type ScheduledBackup = Backup & { scheduleId?: string };
export interface BackupScheduleDependencies {
  listSchedules(): BackupSchedule[];
  saveSchedules(schedules: BackupSchedule[]): void;
  getService(serviceId: string): Pick<Service, 'id' | 'kind' | 'mounts'> | undefined;
  getBackups(): ScheduledBackup[];
  queueBackup(serviceId: string, scheduleId: string): ScheduledBackup;
  forgetBackup(backupId: string): void;
  backupDirectory: string;
  now?: () => Date;
  /** Tests can tick explicitly; production registers one timer per process. */
  startTimer?: boolean;
}

const editableSchema = z.object({
  frequency: z.enum(['hourly', 'daily', 'weekly']),
  minute: z.number().int().min(0).max(59),
  hour: z.number().int().min(0).max(23),
  weekday: z.number().int().min(0).max(6),
  retention: z.number().int().min(1).max(100),
  enabled: z.boolean()
}).strict();
const configSchema = editableSchema.extend({
  frequency: editableSchema.shape.frequency.default('daily'),
  minute: editableSchema.shape.minute.default(0),
  hour: editableSchema.shape.hour.default(2),
  weekday: editableSchema.shape.weekday.default(0),
  retention: editableSchema.shape.retention.default(7),
  enabled: editableSchema.shape.enabled.default(true)
});
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function fail(statusCode: number, message: string) { return Object.assign(new Error(message), { statusCode }); }
function parameter(request: FastifyRequest) {
  const id = (request.params as { id?: unknown }).id;
  if (typeof id !== 'string' || !uuid.test(id)) throw fail(400, 'Invalid identifier.');
  return id;
}

/** The next strictly future UTC occurrence. Missed occurrences are never replayed in a loop. */
export function nextBackupOccurrence(schedule: Pick<BackupSchedule, 'frequency' | 'minute' | 'hour' | 'weekday'>, from: Date): string {
  if (!Number.isFinite(from.getTime())) throw new Error('Invalid scheduler clock.');
  const next = new Date(from);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(schedule.minute);
  if (schedule.frequency === 'hourly') {
    if (next.getTime() <= from.getTime()) next.setUTCHours(next.getUTCHours() + 1);
  } else {
    next.setUTCHours(schedule.hour);
    if (schedule.frequency === 'weekly') {
      next.setUTCDate(next.getUTCDate() + (schedule.weekday - next.getUTCDay() + 7) % 7);
      if (next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + 7);
    } else if (next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.toISOString();
}

export class BackupScheduler {
  private ticking = false;
  private timer?: ReturnType<typeof setInterval>;
  private activeTick?: Promise<void>;
  constructor(readonly dependencies: BackupScheduleDependencies) {}
  private now() { return this.dependencies.now?.() || new Date(); }
  private save() { this.dependencies.saveSchedules(this.dependencies.listSchedules()); }
  private find(id: string) {
    const schedule = this.dependencies.listSchedules().find(item => item.id === id);
    if (!schedule) throw fail(404, 'Backup schedule not found.');
    return schedule;
  }
  private requireService(serviceId: string) {
    const service = this.dependencies.getService(serviceId);
    if (!service) throw fail(404, 'Service not found.');
    if (service.kind === 'compose' || service.kind === 'app' && !service.mounts.length) throw fail(400, 'Scheduled backups require a database or an application with persistent volumes.');
    return service;
  }
  list(serviceId?: string) {
    if (serviceId) this.requireService(serviceId);
    return this.dependencies.listSchedules().filter(item => !serviceId || item.serviceId === serviceId);
  }
  create(serviceId: string, input: unknown) {
    this.requireService(serviceId);
    const config = configSchema.parse(input);
    if (this.list(serviceId).length >= 10) throw fail(400, 'A service may have at most 10 backup schedules.');
    const now = this.now();
    const schedule: BackupSchedule = { ...config, id: randomUUID(), serviceId, timezone: 'UTC', createdAt: now.toISOString(), nextRunAt: config.enabled ? nextBackupOccurrence(config, now) : null, lastStatus: 'idle' };
    this.dependencies.saveSchedules([...this.dependencies.listSchedules(), schedule]);
    return schedule;
  }
  update(id: string, input: unknown) {
    const schedule = this.find(id);
    this.requireService(schedule.serviceId);
    const update = editableSchema.partial().parse(input);
    const config = { ...schedule, ...update };
    Object.assign(schedule, update, { nextRunAt: config.enabled ? nextBackupOccurrence(config, this.now()) : null });
    this.save();
    return schedule;
  }
  remove(id: string) {
    this.find(id);
    this.dependencies.saveSchedules(this.dependencies.listSchedules().filter(item => item.id !== id));
    return { ok: true, backupsRetained: true };
  }
  run(id: string) {
    const schedule = this.find(id);
    this.requireService(schedule.serviceId);
    const backup = this.dependencies.queueBackup(schedule.serviceId, schedule.id);
    schedule.lastRunAt = this.now().toISOString();
    schedule.lastBackupId = backup.id;
    schedule.lastStatus = 'running';
    delete schedule.lastError;
    if (schedule.enabled) schedule.nextRunAt = nextBackupOccurrence(schedule, this.now());
    this.save();
    return backup;
  }
  start(onError: (error: unknown) => void) {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(onError); }, 15000);
    this.timer.unref();
    void this.tick().catch(onError);
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.activeTick;
  }
  tick(): Promise<void> {
    if (this.ticking) return this.activeTick || Promise.resolve();
    this.ticking = true;
    this.activeTick = this.performTick().finally(() => { this.ticking = false; this.activeTick = undefined; });
    return this.activeTick;
  }
  private async performTick() {
    if (!this.dependencies.listSchedules().length) return;
    const now = this.now();
    let changed = false;
    for (const schedule of this.dependencies.listSchedules()) {
      if (schedule.lastBackupId && schedule.lastStatus === 'running') {
        const backup = this.dependencies.getBackups().find(item => item.id === schedule.lastBackupId && item.serviceId === schedule.serviceId && item.scheduleId === schedule.id);
        if (!backup) { schedule.lastStatus = 'failed'; schedule.lastError = 'The previous backup record is missing. Run a backup manually to retry.'; changed = true; }
        else if (backup.status === 'success') { schedule.lastStatus = 'success'; delete schedule.lastError; changed = true; }
        else if (backup.status === 'failed') { schedule.lastStatus = 'failed'; schedule.lastError = backup.error || 'The previous backup failed. Retry manually or wait for the next scheduled run.'; changed = true; }
      }
      if (!schedule.enabled || !schedule.nextRunAt || Date.parse(schedule.nextRunAt) > now.getTime()) continue;
      // Advance first, before submission. A long outage produces at most one catch-up attempt.
      schedule.nextRunAt = nextBackupOccurrence(schedule, now);
      this.save();
      try {
        this.requireService(schedule.serviceId);
        this.run(schedule.id);
      } catch (error) {
        changed = true;
        const statusCode = (error as { statusCode?: number }).statusCode;
        schedule.lastError = statusCode === 409 ? 'Service is busy. This backup will retry in one minute.' : (error instanceof Error ? error.message : 'Could not start the scheduled backup.');
        if (statusCode === 409) {
          schedule.lastStatus = 'deferred';
          schedule.nextRunAt = new Date(now.getTime() + 60000).toISOString();
        } else {
          schedule.lastStatus = 'failed';
          if (statusCode === 404) { schedule.enabled = false; schedule.nextRunAt = null; }
        }
      }
    }
    if (changed) this.save();
    // Retention is independent of dump success. A cleanup error never changes backup success.
    for (const schedule of [...this.dependencies.listSchedules()]) {
      try {
        await this.prune(schedule);
        const current = this.dependencies.listSchedules().find(item => item.id === schedule.id);
        if (current?.retentionError) { delete current.retentionError; this.save(); }
      } catch {
        const current = this.dependencies.listSchedules().find(item => item.id === schedule.id);
        const message = 'Retention could not safely remove old files. Backups were retained; inspect the backup directory and permissions.';
        if (current && current.retentionError !== message) { current.retentionError = message; this.save(); }
      }
    }
  }
  private async safeFile(directory: string, filename: string, requireContents: boolean) {
    if (!filename || basename(filename) !== filename || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename)) throw new Error('Invalid backup filename.');
    const candidate = join(directory, filename);
    const info = await lstat(candidate);
    if (!info.isFile() || info.isSymbolicLink() || requireContents && info.size === 0) throw new Error('Unsafe or empty backup file.');
    const resolved = await realpath(candidate);
    if (!resolved.startsWith(directory + sep)) throw new Error('Backup path escapes destination.');
    return candidate;
  }
  private async prune(schedule: BackupSchedule) {
    if (!Number.isInteger(schedule.retention) || schedule.retention < 1 || schedule.retention > 100) throw new Error('Invalid persisted retention; no backups may be removed.');
    const owned = this.dependencies.getBackups()
      .filter(backup => backup.scheduleId === schedule.id && backup.serviceId === schedule.serviceId && backup.status === 'success')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const keep = Math.max(1, Math.min(100, schedule.retention));
    if (owned.length <= keep) return;
    const directory = await realpath(this.dependencies.backupDirectory);
    // Missing/unsafe retained copies must never cause deletion of the last usable older copy.
    for (const backup of owned.slice(0, keep)) await this.safeFile(directory, backup.filename, true);
    for (const backup of owned.slice(keep)) {
      if (!this.dependencies.listSchedules().some(item => item.id === schedule.id)) return;
      // Refuse a metadata alias to a retained/manual/other-job file before touching the filesystem.
      if (this.dependencies.getBackups().some(item => item.id !== backup.id && item.filename === backup.filename)) throw new Error('Backup file is referenced by another record.');
      try {
        const filename = await this.safeFile(directory, backup.filename, false);
        await unlink(filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      this.dependencies.forgetBackup(backup.id);
    }
  }
}

/** All routes are authenticated by the host application's ordinary /api session hook. */
export function registerBackupSchedules(app: FastifyInstance, dependencies: BackupScheduleDependencies) {
  const scheduler = new BackupScheduler(dependencies);
  app.get('/api/backup-schedules', async () => scheduler.list());
  app.get('/api/services/:id/backup-schedules', async request => scheduler.list(parameter(request)));
  app.post('/api/services/:id/backup-schedules', async (request, reply) => reply.status(201).send(scheduler.create(parameter(request), request.body)));
  app.patch('/api/backup-schedules/:id', async request => scheduler.update(parameter(request), request.body));
  app.delete('/api/backup-schedules/:id', async request => scheduler.remove(parameter(request)));
  app.post('/api/backup-schedules/:id/run', async (request, reply) => reply.status(202).send(scheduler.run(parameter(request))));
  if (dependencies.startTimer !== false) app.addHook('onReady', async () => { scheduler.start(error => app.log.error({ err: error }, 'Backup scheduler failed.')); });
  app.addHook('onClose', async () => { await scheduler.stop(); });
  return scheduler;
}
