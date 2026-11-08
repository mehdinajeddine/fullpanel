import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { copyFile, link, lstat, mkdir, realpath, rm } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Backup, BackupMetadata, RestoreJob, RuntimeMode, Service, ServiceKind } from '../shared/types.js';
import type { Store } from './store.js';
import type { RuntimeDriver } from './docker.js';
import { AccessControl, accessError } from './access.js';

export async function backupFileHash(filename: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

export interface RestoreDependencies {
  store: Store;
  access: AccessControl;
  driver: RuntimeDriver;
  dataDir: string;
  mode: RuntimeMode;
  requireIdle(serviceId: string): void;
  enqueue(serviceId: string, action: () => Promise<void>): Promise<unknown>;
  runtimeService(service: Service): Service;
  createBackup(service: Service, options: { restoreJobId: string }): Backup;
  performBackup(service: Service, backup: Backup): Promise<void>;
  secrets(service: Service): string[];
}

const restoreInput = z.object({ backupId: z.string().uuid(), confirmationName: z.string().min(1).max(63) }).strict();
const formats: Partial<Record<ServiceKind, BackupMetadata['format']>> = { postgres: 'postgres-sql', mysql: 'mysql-sql', mariadb: 'mariadb-sql', mongo: 'mongo-archive', redis: 'redis-rdb-tar', app: 'volume-tar' };
const managedKeys: Partial<Record<ServiceKind, string[]>> = {
  postgres: ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'PGDATA'],
  mysql: ['MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_ROOT_PASSWORD', 'MYSQL_DATABASE'],
  mariadb: ['MARIADB_USER', 'MARIADB_PASSWORD', 'MARIADB_ROOT_PASSWORD', 'MARIADB_DATABASE'],
  mongo: ['MONGO_INITDB_ROOT_USERNAME', 'MONGO_INITDB_ROOT_PASSWORD', 'MONGO_INITDB_DATABASE'],
  redis: ['REDIS_PASSWORD']
};

function managedEnvironment(kind: ServiceKind, values: Record<string,string> = {}) {
  return Object.fromEntries(Object.entries(values).filter(([key]) => managedKeys[kind]?.includes(key)));
}

/** Reconcile only the exact owned container IDs recorded before the switch. */
async function resolveRestoreIntent(store: Store, driver: RuntimeDriver, jobId: string) {
  const intent=store.state.restoreIntents[jobId];
  if (!intent || !driver.recoverRestore) throw new Error('The runtime cannot reconcile a prepared restore.');
  const target=store.state.services.find(service=>service.id===intent.previousService.id);
  if (!target || target.id!==intent.preparedService.id) throw new Error('The restore target no longer matches its checkpoint.');
  const outcome=await driver.recoverRestore(intent.previousService,intent.preparedService,intent.checkpoint);
  const applied=structuredClone(outcome==='activated'?intent.preparedService:intent.previousService);
  store.state.appliedServices[target.id]=applied;
  if (outcome==='activated') target.env={...target.env,...managedEnvironment(target.kind,intent.result.environment)};
  target.containerId=applied.containerId; target.status='running'; delete target.error;
  delete store.state.restoreIntents[jobId];
  return outcome;
}

/** Remove only a known job directory; never traverse a substituted work parent. */
async function removeRestoreWorkspace(dataDir: string, jobId: string) {
  if (!z.string().uuid().safeParse(jobId).success) return;
  const parent=join(dataDir,'restore-work');
  let parentInfo;
  try { parentInfo=await lstat(parent); } catch(error) { if ((error as NodeJS.ErrnoException).code==='ENOENT') return; throw error; }
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error('The restore workspace parent is unsafe.');
  const directory=join(await realpath(parent),jobId);
  let info;
  try { info=await lstat(directory); } catch(error) { if ((error as NodeJS.ErrnoException).code==='ENOENT') return; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The restore workspace is unsafe.');
  await rm(directory,{recursive:true,force:true});
}

export async function recoverPreparedRestores(store: Store, driver: RuntimeDriver) {
  for (const [jobId,intent] of Object.entries(store.state.restoreIntents)) {
    const job=store.state.restores.find(item=>item.id===jobId), target=store.state.services.find(service=>service.id===intent.previousService.id);
    try {
      const outcome=await resolveRestoreIntent(store,driver,jobId);
      if (job) { job.status='failed'; job.phase='finished'; job.finishedAt=new Date().toISOString(); job.error=`Restore interrupted by restart. Recovery verified ${outcome==='activated'?'the replacement volumes are active':'the original volumes were restored'}. Inspect the recovered service before retrying.`; job.output+=`\n${job.error}\n`; }
      store.activity('Restore recovery verified',target?.name || 'Service',outcome,target?.projectId);
    } catch {
      if (target) { target.status='failed'; target.error='Restore recovery is incomplete. Resolve the runtime conflict and restart Harborlight before modifying this service.'; }
      if (job) { job.status='failed'; job.phase='finished'; job.error='Restore recovery could not verify the recorded containers. Service mutations are blocked until recovery succeeds after restart.'; job.output+=`\n${job.error}\n`; }
    }
    store.save();
  }
  // Interrupted jobs without an intent also leave pinned backups. Never remove an unresolved intent's evidence.
  let changed=false;
  for (const job of store.state.restores) {
    if (!['success','failed'].includes(job.status) || store.state.restoreIntents[job.id]) continue;
    try { await removeRestoreWorkspace(store.directory,job.id); }
    catch {
      const notice='Temporary restore files were retained because safe cleanup could not be completed. Inspect the data directory.';
      if (!job.output.includes(notice)) { job.output+=`\n${notice}\n`; changed=true; }
    }
  }
  if (changed) store.save();
}

function metadataCheck(backup: Backup, target: Service, profile: Service | undefined, mode: RuntimeMode) {
  if (backup.status !== 'success' || !backup.sizeBytes) throw accessError(409, 'Select a completed, nonempty backup.');
  if (!backup.metadata || backup.metadata.schemaVersion !== 1 || !backup.sha256 || !/^[a-f0-9]{64}$/.test(backup.sha256) || !profile) throw accessError(409, 'This backup predates restore metadata. Create a new backup before using automatic restoration.');
  if (backup.metadata.kind !== target.kind || profile.kind !== target.kind || profile.id !== backup.serviceId) throw accessError(409, 'The backup engine must match the target service.');
  const expected = mode === 'demo' ? 'demo' : formats[target.kind];
  if (!expected || backup.metadata.format !== expected) throw accessError(409, 'This backup format is not supported for the selected target.');
  if (mode !== 'demo' && target.kind !== 'app' && !backup.metadata.engineVersion) throw accessError(409, 'The backup does not contain a verified database version. Create a new backup.');
}

export async function safeLocalBackupPath(dataDir: string, backup: Backup) {
  if (basename(backup.filename) !== backup.filename || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(backup.filename)) throw new Error('The backup filename is invalid.');
  const directory = await realpath(join(dataDir, 'backups'));
  const candidate = join(directory, backup.filename), info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== backup.sizeBytes || info.size === 0) throw new Error('The backup file is missing, unsafe or has changed size.');
  const filename = await realpath(candidate);
  if (!filename.startsWith(directory + sep)) throw new Error('The backup file escapes its storage directory.');
  return filename;
}

export function registerRestoreJobs(app: FastifyInstance, dependencies: RestoreDependencies) {
  const { store, access, driver } = dependencies;
  const now = () => new Date().toISOString();
  const parameter = (request: FastifyRequest) => z.string().uuid().parse((request.params as { id: string }).id);
  app.get('/api/restores', async request => store.state.restores.filter(job => access.canReadRestore(request, job)).map(job => access.restore(request, job)));
  app.get('/api/services/:id/restores', async request => { const service = access.requireService(request, parameter(request)); return store.state.restores.filter(job => job.targetServiceId === service.id && access.canReadRestore(request, job)).map(job => access.restore(request, job)); });
  app.get('/api/restores/:id', async request => { const job = store.state.restores.find(item => item.id === parameter(request)); if (!job || !access.canReadRestore(request, job)) throw accessError(404, 'Restore job not found.'); return access.restore(request, job); });
  app.post('/api/services/:id/restore', async (request, reply) => {
    store.assertWritable();
    const input = restoreInput.parse(request.body), target = access.requireService(request, parameter(request), 'write');
    const backup = access.requireBackup(request, input.backupId, 'write');
    if (input.confirmationName !== target.name) throw accessError(400, 'Type the target service name exactly to confirm restoration.');
    dependencies.requireIdle(target.id);
    if (!target.deployedAt || target.status !== 'running') throw accessError(409, 'Deploy and start the target service before restoring data.');
    if (!driver.restore || !driver.validateRestore || !driver.recoverRestore) throw accessError(501, 'This runtime does not support verified restoration.');
    const runtimeTarget = dependencies.runtimeService(target), sourceProfile = store.state.backupProfiles[backup.id];
    metadataCheck(backup, runtimeTarget, sourceProfile, dependencies.mode);
    const source = structuredClone(backup), profile = structuredClone(sourceProfile);
    const job: RestoreJob = { id: randomUUID(), sourceBackupId: source.id, sourceProjectId: access.recordProject(source), targetServiceId: target.id, targetProjectId: target.projectId, requestedBy: access.principal(request).user.id, status: 'queued', phase: 'validating', createdAt: now(), output: '' };
    store.state.restores.unshift(job); store.activity('Restore queued', target.name, 'A safety backup will be created before preparing replacement volumes.', target.projectId); store.save();
    void dependencies.enqueue(target.id, async () => {
      job.status = 'running'; job.startedAt = now(); store.save();
      const directory = join(dependencies.dataDir, 'restore-work', job.id), pinned = join(directory, source.filename);
      const secrets = [...new Set([...dependencies.secrets(runtimeTarget), ...dependencies.secrets(profile), ...Object.values(runtimeTarget.env), ...Object.values(profile.env)].filter(value => value.length >= 4))].sort((a,b) => b.length-a.length);
      const redact = (text: string) => secrets.reduce((value, secret) => value.split(secret).join('[REDACTED]'), text);
      let rawOutput = '', succeeded = false;
      const output = (chunk: string) => {
        rawOutput = (rawOutput + chunk).slice(-250000);
        let end = rawOutput.length;
        for (const secret of secrets) for (let length = Math.min(secret.length-1,rawOutput.length); length>0; length--) if (rawOutput.endsWith(secret.slice(0,length))) { end=Math.min(end,rawOutput.length-length); break; }
        job.output = redact(rawOutput.slice(0,end)).slice(-200000);
      };
      const authorizeAgain = () => { access.requireService(request, target.id, 'write'); if (!access.isGlobal(request)) access.requireProject(request, job.sourceProjectId || '', 'write'); };
      try {
        const filename = await safeLocalBackupPath(dependencies.dataDir, source);
        await mkdir(directory, {recursive:true,mode:0o700});
        // Pin the file so concurrent retention cannot remove it mid-restore. Fall back across filesystems.
        try { await link(filename,pinned); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error; await copyFile(filename,pinned); }
        if (!(await lstat(pinned)).isFile()) throw new Error('The pinned backup is not a regular file.');
        if (await backupFileHash(pinned) !== source.sha256) throw new Error('Backup integrity verification failed. The target was not modified.');
        output('Backup integrity verified. Checking target compatibility.\n');
        await driver.validateRestore!(runtimeTarget,source,pinned,{sourceService:profile});
        authorizeAgain();
        job.phase = 'pre-backup'; output('Creating an automatic safety backup of the target.\n');
        const safetyBackup = dependencies.createBackup(runtimeTarget,{restoreJobId:job.id}); job.preRestoreBackupId = safetyBackup.id; store.save();
        await dependencies.performBackup(runtimeTarget,safetyBackup);
        metadataCheck(safetyBackup,runtimeTarget,store.state.backupProfiles[safetyBackup.id],dependencies.mode);
        authorizeAgain(); job.phase = 'restoring'; store.save();
        output('Preparing replacement volumes. The current volumes are retained.\n');
        const result = await driver.restore!(runtimeTarget,source,pinned,output,{
          sourceService:profile,
          onPrepared:async (result,checkpoint) => {
            authorizeAgain(); store.assertWritable();
            if (checkpoint.candidateContainerId !== result.containerId || !checkpoint.previousContainerId || !checkpoint.restoreId) throw new Error('The runtime supplied an invalid restore checkpoint.');
            const environment = managedEnvironment(target.kind,result.environment);
            store.state.restoreIntents[job.id] = {
              result:structuredClone({...result,environment}), checkpoint:structuredClone(checkpoint),
              previousService:{...runtimeTarget,containerId:checkpoint.previousContainerId},
              preparedService:{...runtimeTarget,env:{...runtimeTarget.env,...environment},containerId:result.containerId,volumeOverrides:structuredClone(result.volumeOverrides),status:'running'}
            };
            output('Replacement volumes verified. Persisting the recovery checkpoint before switching.\n'); store.save();
          }
        });
        if (!store.state.restoreIntents[job.id] || store.state.restoreIntents[job.id].checkpoint.candidateContainerId !== result.containerId) throw new Error('The runtime did not persist a matching restore checkpoint.');
        const environment = managedEnvironment(target.kind,result.environment);
        target.env = { ...target.env, ...environment };
        target.containerId = result.containerId; target.status = 'running'; delete target.error;
        store.state.appliedServices[target.id] = { ...runtimeTarget, env:{...runtimeTarget.env,...environment}, containerId:result.containerId, volumeOverrides:structuredClone(result.volumeOverrides), status:'running' };
        delete store.state.restoreIntents[job.id];
        succeeded=true; job.output=redact(rawOutput).slice(-200000); store.activity('Restore completed',target.name,'Replacement volumes activated; previous volumes and the safety backup were retained.',target.projectId);
      } catch (error) {
        job.error=redact(error instanceof Error ? error.message : String(error)); output(`\nRestore failed: ${job.error}\n`);
        // Verify rollback or an already activated candidate from exact identities before allowing another mutation.
        if (store.state.restoreIntents[job.id]) {
          try { const result = await resolveRestoreIntent(store,driver,job.id); output(`Recovery verified: ${result}.\n`); }
          catch { target.status='failed'; target.error='Restore recovery is incomplete. Resolve the runtime conflict and restart Harborlight before modifying this service.'; output(`\n${target.error}\n`); }
        } else try { const states=await driver.statuses(); if (states[target.id]) target.status=states[target.id]; } catch { /* Keep the last observed status. */ }
        store.activity('Restore failed',target.name,undefined,target.projectId);
      } finally {
        if (!store.state.restoreIntents[job.id]) try { await removeRestoreWorkspace(dependencies.dataDir,job.id); } catch { output('\nTemporary restore files could not be removed. Inspect the data directory.\n'); }
        job.status=succeeded?'success':'failed'; job.phase='finished'; job.finishedAt=now(); store.save();
      }
    });
    return reply.status(202).send(job);
  });
}
