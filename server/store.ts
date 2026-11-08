import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Activity, Backup, Deployment, Project, Service, Settings, RuntimeMode, PublicUser, ApiKey, RestoreJob } from '../shared/types.js';
import type { BackupSchedule } from './backup-schedules.js';
import type { ProxyAuthMap } from '../shared/proxy.js';
import type { ServiceSourceCredentials } from './source-credentials.js';
import type { RestoreCheckpoint, RestoreResult } from './docker.js';
import type { GitHubWebhookRecord } from './github-webhooks.js';
import type { ReleaseSnapshot } from './releases.js';

export interface Owner { name: string; email: string; hash: string; salt: string }
export interface UserRecord extends PublicUser { hash: string; salt: string }
export interface ApiKeyRecord extends ApiKey { hash: string }
export interface RestoreIntent { result: RestoreResult; checkpoint: RestoreCheckpoint; previousService: Service; preparedService: Service }
export interface State { version: 1; owner?: Owner; users: UserRecord[]; apiKeys: ApiKeyRecord[]; sessions: { hash: string; expires: number; userId: string }[]; projects: Project[]; services: Service[]; deployments: Deployment[]; backups: Backup[]; restores: RestoreJob[]; activity: Activity[]; settings: Settings; deployTokens: Record<string, string>; deployTokenOwners: Record<string,string>; backupSchedules: BackupSchedule[]; proxyAuth: Record<string,ProxyAuthMap>; sourceCredentials: Record<string,ServiceSourceCredentials>; projectEnvironments: Record<string,Record<string,string>>; appliedServices: Record<string,Service>; backupProfiles: Record<string,Service>; restoreIntents: Record<string,RestoreIntent>; githubWebhooks: Record<string,GitHubWebhookRecord>; releases: ReleaseSnapshot[]; activeReleaseIds: Record<string,string>; pendingReleaseIds: Record<string,string[]>; appliedProxyAuth: Record<string,ProxyAuthMap> }
const now = () => new Date().toISOString();
const activeDirectories = new Set<string>();
function processIdentity(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    if (process.platform === 'linux') {
      const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)!.split(' ');
      return `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${fields[19]}`;
    }
    return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch { return undefined; }
}
export class Store {
  readonly file: string;
  private key!: Buffer;
  private lockFile: string;
  private lockToken = JSON.stringify({ pid: process.pid, identity: processIdentity(process.pid), nonce: randomUUID() });
  private committed?: State;
  private persistenceError?: Error;
  state!: State;
  constructor(readonly directory: string, mode: RuntimeMode = 'docker') {
    mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
    this.lockFile = join(directory, 'writer.lock');
    this.file = join(directory, 'state.enc');
    if (activeDirectories.has(directory)) throw new Error('The data directory is already open in another FullPanel process.');
    if (existsSync(this.lockFile)) {
      const previous = readFileSync(this.lockFile, 'utf8');
      let owner: { pid: number; identity?: string };
      try { owner = JSON.parse(previous); } catch { owner = { pid: Number(previous.split(':')[0]) }; }
      const identity = processIdentity(owner.pid);
      if (identity && (!owner.identity || identity === owner.identity)) throw new Error('The data directory is already open in another FullPanel process.');
      if (readFileSync(this.lockFile, 'utf8') === previous) unlinkSync(this.lockFile);
    }
    writeFileSync(this.lockFile, this.lockToken, { mode: 0o600, flag: 'wx' });
    activeDirectories.add(directory);
    try {
    const keyFile = join(directory, 'encryption.key');
    if (existsSync(this.file) && !existsSync(keyFile)) throw new Error('Missing encryption.key: restore it alongside state.enc.');
    if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' });
    this.key = readFileSync(keyFile);
    if (this.key.length !== 32) throw new Error('Invalid data encryption key.');
    chmodSync(keyFile, 0o600);
    if (existsSync(this.file)) {
      const encrypted = readFileSync(this.file);
      const decipher = createDecipheriv('aes-256-gcm', this.key, encrypted.subarray(0, 12));
      decipher.setAuthTag(encrypted.subarray(12, 28));
      this.state = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString());
      if (this.state.version !== 1) throw new Error('Unsupported state version.');
      for (const deployment of this.state.deployments) if (['queued', 'running'].includes(deployment.status)) { deployment.status = 'failed'; deployment.finishedAt = now(); deployment.output += '\nServer restarted before completion. Inspect the runtime before redeploying.'; const service=this.state.services.find(item=>item.id===deployment.serviceId); if(service)service.runtimeUncertain=true; if(this.state.activeReleaseIds)delete this.state.activeReleaseIds[deployment.serviceId]; }
      for (const service of this.state.services) if (service.status === 'deploying') { service.status = 'failed'; service.error = 'Deployment interrupted by server restart.'; }
      for (const backup of this.state.backups) if (backup.status === 'running') { backup.status = 'failed'; backup.error = 'Backup interrupted by server restart.'; }
    } else {
      this.state = { version: 1, sessions: [], users: [], apiKeys: [], projects: [], services: [], deployments: [], backups: [], restores: [], activity: [], deployTokens: {}, deployTokenOwners: {}, backupSchedules: [], proxyAuth: {}, sourceCredentials: {}, projectEnvironments: {}, appliedServices: {}, backupProfiles: {}, restoreIntents: {}, githubWebhooks: {}, releases: [], activeReleaseIds: {}, pendingReleaseIds: {}, appliedProxyAuth: {}, settings: { serverName: 'My server', baseDomain: '', letsEncryptEmail: '', theme: 'light' } };
      if (mode === 'demo') this.seed();
    }
    this.state.deployTokens ||= {};
    this.state.backupSchedules ||= [];
    this.state.users ||= [];
    this.state.apiKeys ||= [];
    this.state.deployTokenOwners ||= {};
    this.state.proxyAuth ||= {};
    this.state.sourceCredentials ||= {};
    this.state.projectEnvironments ||= {};
    this.state.appliedServices ||= {};
    this.state.backupProfiles ||= {};
    this.state.restores ||= [];
    this.state.restoreIntents ||= {};
    this.state.githubWebhooks ||= {};
    this.state.releases ||= [];
    this.state.activeReleaseIds ||= {};
    this.state.pendingReleaseIds ||= {};
    this.state.appliedProxyAuth ||= {};
    this.state.settings.testDomainIp ??= '';
    for (const restore of this.state.restores) if (restore.status === 'queued' || restore.status === 'running') { restore.status = 'failed'; restore.phase = 'finished'; restore.finishedAt = now(); restore.error = 'Restore interrupted by server restart. Inspect the runtime and retained volumes before retrying.'; restore.output += `\n${restore.error}\n`; }
    // Upgrade the original single-owner state and preserve its valid browser sessions.
    if (!this.state.users.length && this.state.owner) this.state.users.push({ ...this.state.owner, id: randomUUID(), role: 'owner', memberships: [], disabled: false, createdAt: now(), updatedAt: now() });
    const ownerId = this.state.users.find(user => user.role === 'owner')?.id;
    if (ownerId) {
      for (const session of this.state.sessions) session.userId ||= ownerId;
      for (const serviceId of Object.keys(this.state.deployTokens)) this.state.deployTokenOwners[serviceId] ||= ownerId;
    }
    for (const record of [...this.state.deployments, ...this.state.backups]) record.projectId ||= this.state.services.find(service => service.id === record.serviceId)?.projectId;
    this.save();
    } catch (error) { this.close(); throw error; }
  }
  close() { if (existsSync(this.lockFile) && readFileSync(this.lockFile, 'utf8') === this.lockToken) unlinkSync(this.lockFile); activeDirectories.delete(this.directory); }
  assertWritable() { if (this.persistenceError) throw Object.assign(new Error('Persistent storage failed. Fix the data directory and restart FullPanel.'), { statusCode: 503 }); }
  save() {
    this.assertWritable();
    this.state.sessions = this.state.sessions.filter(session => session.expires > Date.now());
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(this.state)), cipher.final()]);
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
    writeFileSync(temp, Buffer.concat([iv, cipher.getAuthTag(), body]), { mode: 0o600 });
    const fd = openSync(temp, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, this.file);
    this.committed = structuredClone(this.state);
    } catch (error) {
      // Cleanup failure must never prevent the fail-closed persistence latch.
      try { if (existsSync(temp)) unlinkSync(temp); } catch { /* Retain the temporary file for recovery. */ }
      if (this.committed) this.state = structuredClone(this.committed);
      this.persistenceError = error as Error;
      // Docker may already have switched containers before this write failed.
      // The committed snapshot is safe to retain, but cannot describe the active runtime.
      for (const deployment of this.state.deployments) if (['queued', 'running'].includes(deployment.status)) {
        deployment.status = 'failed'; deployment.finishedAt = now();
        deployment.output += '\nPersistent storage failed before deployment completion was recorded. Restart FullPanel and reconcile the runtime.';
        const service = this.state.services.find(item => item.id === deployment.serviceId);
        if (service) { service.runtimeUncertain = true; service.status = 'failed'; service.error = 'Persistent storage failed before runtime state could be recorded.'; }
        delete this.state.activeReleaseIds[deployment.serviceId];
      }
      throw error;
    }
  }
  activity(action: string, resource: string, detail?: string, projectId?: string) {
    this.state.activity.unshift({ id: randomUUID(), action, resource, createdAt: now(), ...(detail ? { detail } : {}), ...(projectId ? { projectId } : {}) });
    this.state.activity = this.state.activity.slice(0, 1000);
  }
  private seed() {
    const createdAt = new Date(Date.now() - 86400000 * 3).toISOString();
    const web = randomUUID(), tools = randomUUID();
    this.state.settings.serverName = 'FullPanel demo';
    this.state.projects = [
      { id: web, name: 'studio', description: 'The things we are building', color: '#6366f1', createdAt },
      { id: tools, name: 'workspace', description: 'A home for our everyday tools', color: '#16a085', createdAt }
    ];
    const fixtures = [
      { projectId: web, name: 'website', kind: 'app' as const, image: 'nginx:1.28-alpine', port: 80 },
      { projectId: web, name: 'database', kind: 'postgres' as const, image: 'postgres:17-alpine', port: 5432 },
      { projectId: web, name: 'cache', kind: 'redis' as const, image: 'redis:7-alpine', port: 6379 },
      { projectId: tools, name: 'analytics', kind: 'app' as const, image: 'ghcr.io/umami-software/umami:postgresql-latest', port: 3000 }
    ];
    this.state.services = fixtures.map((fixture, i) => ({ id: randomUUID(), projectId: fixture.projectId, name: fixture.name, kind: fixture.kind, source: { type: 'image', image: fixture.image }, status: i === 3 ? 'stopped' : 'running', env: {}, domains: fixture.kind === 'app' ? [{ id: randomUUID(), hostname: `${fixture.name}.example.com`, https: true, port: fixture.port, path: '/' }] : [], mounts: [], ports: [], resources: { cpu: 1, memoryMb: 512 }, notes: '', createdAt, updatedAt: createdAt, deployedAt: createdAt }));
    this.state.deployments = this.state.services.map(service => ({ id: randomUUID(), serviceId: service.id, status: 'success', trigger: 'Demo fixture', createdAt, finishedAt: createdAt, output: 'DEMO — illustrative deployment output. No container was created.\nImage pulled. Container started.\n', image: service.source.image }));
    this.activity('Demo workspace created', 'FullPanel', 'Illustrative data only; Docker is never accessed in demo mode.');
  }
}
