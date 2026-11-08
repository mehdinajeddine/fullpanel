import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { ApiKey, PublicUser, ProjectRole, Service, Deployment, Backup, Activity, RestoreJob } from '../shared/types.js';
import type { Store, UserRecord, ApiKeyRecord } from './store.js';
import { normalizeGitRepository } from './source-credentials.js';

export const SESSION_COOKIE = 'harborlight_session';
export const digestToken = (value: string) => createHash('sha256').update(value).digest('hex');
export function accessError(statusCode: number, message: string) { return Object.assign(new Error(message), { statusCode }); }
export function publicUser(user: UserRecord): PublicUser { const { hash: _hash, salt: _salt, ...safe } = user; return safe; }
export function publicApiKey(key: ApiKeyRecord): ApiKey { const { hash: _hash, ...safe } = key; return safe; }
export interface Principal { user: UserRecord; apiKey?: ApiKeyRecord }

/** Resource authorization is deny-by-default and evaluated again for each request. */
export class AccessControl {
  private identities = new WeakMap<FastifyRequest, { userId: string; keyId?: string }>();
  constructor(readonly store: Store) {}
  identify(request: FastifyRequest): Principal | undefined {
    const authorization = request.headers.authorization;
    if (authorization) {
      const match = /^Bearer (hl_[A-Za-z0-9_-]{43})$/.exec(authorization);
      const key = match && this.store.state.apiKeys.find(item => item.hash === digestToken(match[1]) && Date.parse(item.expiresAt) > Date.now());
      const user = key && this.store.state.users.find(item => item.id === key.userId && !item.disabled);
      if (!key || !user) throw accessError(401, 'Invalid, expired or revoked API key.');
      this.identities.set(request, { userId: user.id, keyId: key.id });
      return { user, apiKey: key };
    }
    const token = request.cookies[SESSION_COOKIE];
    const session = token && this.store.state.sessions.find(item => item.hash === digestToken(token) && item.expires > Date.now());
    const user = session && this.store.state.users.find(item => item.id === session.userId && !item.disabled);
    if (!user) return undefined;
    this.identities.set(request, { userId: user.id });
    return { user };
  }
  principal(request: FastifyRequest): Principal {
    const identity = this.identities.get(request);
    const user = identity && this.store.state.users.find(item => item.id === identity.userId && !item.disabled);
    if (!identity || !user) throw accessError(401, 'Sign in to continue.');
    if (identity.keyId) {
      const apiKey = this.store.state.apiKeys.find(item => item.id === identity.keyId && Date.parse(item.expiresAt) > Date.now());
      if (!apiKey) throw accessError(401, 'API key is no longer valid.');
      return { user, apiKey };
    }
    const token = request.cookies[SESSION_COOKIE];
    if (!this.store.state.sessions.some(item => item.userId === user.id && item.hash === digestToken(token || '') && item.expires > Date.now())) throw accessError(401, 'Your session has expired.');
    return { user };
  }
  isGlobal(request: FastifyRequest) { const actor = this.principal(request); return !actor.apiKey && actor.user.role !== 'member'; }
  requireCookie(request: FastifyRequest) { const actor = this.principal(request); if (actor.apiKey) throw accessError(403, 'Use a browser session for account management.'); return actor; }
  requireGlobal(request: FastifyRequest) { const actor = this.requireCookie(request); if (actor.user.role === 'member') throw accessError(403, 'Administrator access is required.'); return actor; }
  level(request: FastifyRequest, projectId: string): ProjectRole | undefined {
    if (!this.store.state.projects.some(project => project.id === projectId)) return undefined;
    const actor = this.principal(request);
    let level: ProjectRole | undefined = actor.user.role !== 'member' ? 'operator' : actor.user.memberships.find(item => item.projectId === projectId)?.role;
    if (actor.apiKey) {
      if (!actor.apiKey.projectIds.includes(projectId)) return undefined;
      if (actor.apiKey.permission === 'read' && level) level = 'viewer';
    }
    return level;
  }
  canRead(request: FastifyRequest, projectId?: string) { return !!projectId && !!this.level(request, projectId); }
  requireProject(request: FastifyRequest, projectId: string, permission: 'read' | 'write' = 'read') {
    const level = this.level(request, projectId);
    if (!level) throw accessError(404, 'Project not found.');
    if (permission === 'write' && level !== 'operator') throw accessError(403, 'Operator access is required for this project.');
    return level;
  }
  requireService(request: FastifyRequest, serviceId: string, permission: 'read' | 'write' = 'read') {
    const service = this.store.state.services.find(item => item.id === serviceId);
    if (!service || !this.canRead(request, service.projectId)) throw accessError(404, 'Service not found.');
    this.requireProject(request, service.projectId, permission);
    return service;
  }
  recordProject(record: { serviceId: string; projectId?: string }) { return record.projectId || this.store.state.services.find(service => service.id === record.serviceId)?.projectId; }
  canReadRecord(request: FastifyRequest, record: { serviceId: string; projectId?: string }) { return this.isGlobal(request) || this.canRead(request, this.recordProject(record)); }
  requireBackup(request: FastifyRequest, backupId: string, permission: 'read' | 'write' = 'read') {
    const backup = this.store.state.backups.find(item => item.id === backupId);
    if (!backup || !this.canReadRecord(request, backup)) throw accessError(404, 'Backup not found.');
    if (!this.isGlobal(request)) this.requireProject(request, this.recordProject(backup) || '', permission);
    return backup;
  }
  canReadRestore(request: FastifyRequest, job: RestoreJob) { return this.isGlobal(request) || this.level(request, job.sourceProjectId || '') === 'operator' && this.level(request, job.targetProjectId) === 'operator'; }
  restore(request: FastifyRequest, job: RestoreJob): RestoreJob { const write = this.isGlobal(request) || this.level(request, job.sourceProjectId || '') === 'operator' && this.level(request, job.targetProjectId) === 'operator'; return write ? job : { ...job, output: '', error: job.error ? 'Restore failed. Ask an operator to inspect the job.' : undefined, requestedBy: '' }; }
  service(request: FastifyRequest, service: Service, inventory = false): Service {
    const operator = this.level(request, service.projectId) === 'operator';
    if (operator && !inventory) return service;
    let repository: string | undefined;
    if (service.source.repository) try { repository = normalizeGitRepository(service.source.repository); } catch { /* Legacy invalid URLs can contain credentials; viewers must never receive them. */ }
    return { ...service, env: {}, ...(operator ? {} : { source: { type: service.source.type, image: service.source.image, repository, branch: service.source.branch, context: service.source.context }, notes: '', error: service.error ? 'This service reported an error. Ask an operator to inspect its logs.' : undefined }) };
  }
  deployment(request: FastifyRequest, deployment: Deployment): Deployment { return this.level(request, this.recordProject(deployment) || '') === 'operator' || this.isGlobal(request) ? deployment : { ...deployment, output: '' }; }
  backup(request: FastifyRequest, backup: Backup): Backup { return this.level(request, this.recordProject(backup) || '') === 'operator' || this.isGlobal(request) ? backup : { ...backup, error: backup.error ? 'Backup failed. Ask an operator to inspect the error.' : undefined }; }
  activity(request: FastifyRequest, activity: Activity) { return this.isGlobal(request) || this.canRead(request, activity.projectId); }

  authorize(request: FastifyRequest) {
    const route = request.routeOptions.url || '';
    const method = request.method;
    const params = request.params as { id?: string };
    const body = (request.body || {}) as { projectId?: unknown };
    const read = method === 'GET' || method === 'HEAD';
    const permission = read ? 'read' : 'write';
    this.principal(request);
    if (route === '/api/auth/logout') { this.requireCookie(request); return; }
    if (route.startsWith('/api/users') || route === '/api/settings' || route === '/api/metrics' || route.startsWith('/api/credentials')) { this.requireGlobal(request); return; }
    if (route.startsWith('/api/api-keys')) { this.requireCookie(request); return; }
    if (['/api/overview', '/api/activity', '/api/deployments', '/api/backups', '/api/backup-schedules', '/api/templates'].includes(route) && read) return;
    if (route === '/api/restores' && read) return;
    if (route === '/api/restores/:id' && read) { const job = this.store.state.restores.find(item => item.id === params.id); if (!job || !this.canReadRestore(request, job)) throw accessError(404, 'Restore job not found.'); return; }
    if (route === '/api/projects') { if (!read) this.requireGlobal(request); return; }
    if (route === '/api/projects/:id/environment') { this.requireProject(request, params.id || '', 'write'); return; }
    if (route === '/api/projects/:id') { this.requireProject(request, params.id || '', permission); if (!read) this.requireGlobal(request); return; }
    if (route === '/api/services') {
      if (read) { const projectId = (request.query as { projectId?: string }).projectId; if (projectId) this.requireProject(request, projectId); }
      else this.requireProject(request, typeof body.projectId === 'string' ? body.projectId : '', 'write');
      return;
    }
    if (route.startsWith('/api/services/:id')) {
      if (route.includes('/trigger')) this.requireCookie(request);
      const sensitiveRead = route.endsWith('/logs') || route.includes('/trigger') || route.endsWith('/auth') || route.endsWith('/environment');
      this.requireService(request, params.id || '', sensitiveRead ? 'write' : permission); return;
    }
    if (route === '/api/deployments/:id') {
      const record = this.store.state.deployments.find(item => item.id === params.id);
      if (!record || !this.canReadRecord(request, record)) throw accessError(404, 'Deployment not found.');
      if (!read) throw accessError(404, 'Route not found.'); return;
    }
    if (route === '/api/backups/:id/download') {
      const record = this.store.state.backups.find(item => item.id === params.id);
      if (!record || !this.canReadRecord(request, record)) throw accessError(404, 'Backup not found.');
      if (!this.isGlobal(request)) this.requireProject(request, this.recordProject(record) || '', 'write');
      return;
    }
    if (route.startsWith('/api/backup-schedules/:id')) {
      const schedule = this.store.state.backupSchedules.find(item => item.id === params.id);
      if (!schedule) throw accessError(404, 'Backup schedule not found.');
      this.requireService(request, schedule.serviceId, permission); return;
    }
    if (route === '/api/templates/:id/install') { this.requireProject(request, typeof body.projectId === 'string' ? body.projectId : '', 'write'); return; }
    throw accessError(404, 'API route not found.');
  }
}
