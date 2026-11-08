import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import websocket from '@fastify/websocket';
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { existsSync, constants as fsConstants } from 'node:fs';
import { mkdir, stat, rm, open as openFile } from 'node:fs/promises';
import { z } from 'zod';
import { Store, type UserRecord } from './store.js';
import { AccessControl, publicUser } from './access.js';
import { registerAccounts } from './accounts.js';
import { registerTerminals, type TerminalRuntime, type TerminalPolicy, type TerminalManager } from './terminals.js';
import { DockerTerminalRuntime } from './container-terminal.js';
import { assertDomainOwnership } from './domain-ownership.js';
import { registerProjectEnvironment } from './project-environment.js';
import { effectiveServiceEnvironment } from '../shared/environment.js';
import { testDomainHostname } from '../shared/test-domains.js';
import { ServiceMetricsCache } from './service-metrics.js';
import { emptyMetricValues } from './docker-metrics.js';
import { registerRestoreJobs, recoverPreparedRestores, backupFileHash, safeLocalBackupPath } from './restore-jobs.js';
import { DockerDriver, DemoDriver, type RuntimeDriver, sanitizeCompose } from './docker.js';
import { templates } from './templates.js';
import { registerDeploymentWebhooks } from './webhooks.js';
import { registerGitHubWebhooks, disableChangedGitHubWebhook } from './github-webhooks.js';
import { registerReleases, recordRelease, pendingReleaseServices } from './releases.js';
import { registerBackupSchedules } from './backup-schedules.js';
import { registerProxyAuth } from './proxy-auth.js';
import { registerSourceCredentials, pruneSourceCredentials, resolveSourceCredentials, sourceCredentialSecrets } from './source-credentials.js';
import { initializeSshCredentialDirectory } from './git-ssh.js';
import { projectInput, projectPatch, serviceCreate, servicePatch, settingsInput, setupInput, loginInput, id } from './validation.js';
import type { Service, RuntimeMode, Session, Backup, Deployment } from '../shared/types.js';

const scrypt = promisify(scryptCallback);
const now = () => new Date().toISOString();
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const COOKIE = 'harborlight_session';
const ttl = 86400 * 7;
class HttpError extends Error { constructor(readonly statusCode: number, message: string) { super(message); } }
export interface AppOptions { dataDir?: string; mode?: RuntimeMode; driver?: RuntimeDriver; logger?: boolean; publicUrl?: string; cookieSecure?: boolean; staticDir?: string; terminalRuntime?: TerminalRuntime; terminalPolicy?: Partial<TerminalPolicy> }

export async function createApp(options: AppOptions = {}) {
  const mode = options.mode || (process.env.HARBORLIGHT_MODE === 'demo' ? 'demo' : 'docker');
  const dataDir = resolve(options.dataDir || process.env.DATA_DIR || (mode === 'demo' ? '.data/demo' : '.data'));
  const store = new Store(dataDir, mode);
  const credentialsDirectory = join(dataDir, 'ssh-credentials');
  // The Store writer lock ensures no other panel uses this private staging area.
  try { await initializeSshCredentialDirectory(credentialsDirectory); } catch (error) { store.close(); throw error; }
  const access = new AccessControl(store);
  const driver: RuntimeDriver = options.driver || (mode === 'demo' ? new DemoDriver() : new DockerDriver(dataDir));
  try { await recoverPreparedRestores(store,driver); } catch(error) { store.close(); throw error; }
  const publicUrl = options.publicUrl || process.env.PUBLIC_URL;
  const publicOrigin = publicUrl ? new URL(publicUrl).origin : undefined;
  const secureCookie = options.cookieSecure ?? (process.env.COOKIE_SECURE === 'true' || publicUrl?.startsWith('https:') || false);
  const app = Fastify({ logger: options.logger ? { redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers.x-hub-signature-256'] } : false, bodyLimit: 1024 * 1024, trustProxy: false, requestTimeout: 30000 });
  await app.register(websocket,{options:{maxPayload:16*1024,perMessageDeflate:false},errorHandler:(_error,socket)=>socket.terminate()});
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  const jobs = new Set<Promise<unknown>>();
  const busy = new Set<string>();
  const serviceMetrics = new ServiceMetricsCache(driver.serviceMetrics?.bind(driver), mode);
  let terminals:TerminalManager|undefined;
  let cachedMetrics: { at: number; value: Awaited<ReturnType<RuntimeDriver['metrics']>> } | undefined;
  let metricsPromise: Promise<Awaited<ReturnType<RuntimeDriver['metrics']>>> | undefined;
  async function metrics() {
    if (cachedMetrics && Date.now() - cachedMetrics.at < 5000) return cachedMetrics.value;
    if (!metricsPromise) metricsPromise = driver.metrics().then(value => { cachedMetrics = { at: Date.now(), value }; return value; }).finally(() => { metricsPromise = undefined; });
    return metricsPromise;
  }
  const session = (request: FastifyRequest): Session => {
    let user: UserRecord | undefined;
    try { user = access.principal(request).user; } catch { /* An absent/expired browser session is an unauthenticated session. */ }
    return { authenticated: !!user, setupRequired: !store.state.users.length, mode, ...(user ? { user: publicUser(user) } : {}) };
  };
  function signIn(reply: FastifyReply, user: UserRecord) {
    const token = randomBytes(32).toString('hex');
    store.state.sessions.push({ hash: hashToken(token), expires: Date.now() + ttl * 1000, userId: user.id });
    store.state.sessions = [...store.state.sessions.filter(item => item.userId !== user.id), ...store.state.sessions.filter(item => item.userId === user.id).slice(-20)]; store.save();
    reply.setCookie(COOKIE, token, { path: '/', httpOnly: true, sameSite: 'strict', secure: secureCookie, maxAge: ttl });
    return { authenticated: true, setupRequired: false, mode, user: publicUser(user) } satisfies Session;
  }
  const isPublicRoute = (request: FastifyRequest) => {
    const route = request.routeOptions.url || '';
    return (request.method === 'GET' || request.method === 'HEAD') && ['/api/health', '/api/auth/session'].includes(route)
      || request.method === 'POST' && ['/api/auth/setup', '/api/auth/login', '/api/hooks/deploy/:id', '/api/hooks/github/:id'].includes(route);
  };
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'same-origin').header('X-Frame-Options', 'DENY');
    if (request.url.startsWith('/api')) reply.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      store.assertWritable();
      const origin = request.headers.origin;
      const expected = publicOrigin || `${request.protocol}://${request.headers.host}`;
      if (origin && origin !== expected || request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Request origin is not allowed.');
      if (request.headers['content-type'] && !request.headers['content-type'].includes('application/json')) throw new HttpError(415, 'Use application/json.');
    }
    // Authorize the router's canonical route, never an attacker-controlled URL spelling.
    const route = request.routeOptions.url || '';
    let decodedPath: string;
    try { decodedPath = decodeURIComponent(request.url.split('?')[0]).replace(/^\/+/, '/').toLowerCase(); }
    catch { throw new HttpError(400, 'Invalid request path.'); }
    if (decodedPath.startsWith('/api/') && !route.startsWith('/api/')) throw new HttpError(404, 'API route not found.');
    if (!route.startsWith('/api/')) return;
    if (['/api/hooks/deploy/:id','/api/hooks/github/:id'].includes(route) && request.method === 'POST') return;
    if (route.startsWith('/api/auth/') && request.headers.authorization) throw new HttpError(403, 'API keys cannot manage authentication.');
    const principal = access.identify(request);
    if (!isPublicRoute(request) && !principal) throw new HttpError(401, 'Sign in to continue.');
  });
  app.addHook('preHandler', async request => { if (request.routeOptions.url?.startsWith('/api/') && !isPublicRoute(request)) access.authorize(request); });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.status(400).send({ error: error.issues.map(issue => `${issue.path.join('.') || 'Request'}: ${issue.message}`).join('; ') });
    const status = (error as { statusCode?: number }).statusCode || 500;
    if (status >= 500) app.log.error(error);
    return reply.status(status).send({ error: status >= 500 ? 'The operation could not be completed. Check the server logs.' : (error as Error).message });
  });
  const parameter = (request: FastifyRequest) => id.parse((request.params as { id: string }).id);
  const serviceById = (serviceId: string) => { const service = store.state.services.find(item => item.id === serviceId); if (!service) throw new HttpError(404, 'Service not found.'); return service; };
  const projectById = (projectId: string) => { const project = store.state.projects.find(item => item.id === projectId); if (!project) throw new HttpError(404, 'Project not found.'); return project; };
  const recoveryPending = (serviceId:string) => Object.values(store.state.restoreIntents).some(intent=>intent.previousService.id===serviceId);
  const requireIdle = (serviceId: string) => { if (recoveryPending(serviceId)) throw new HttpError(409,'Restore recovery is incomplete. Resolve the runtime conflict and restart Harborlight before modifying this service.'); if (busy.has(serviceId)) throw new HttpError(409, 'This service already has an operation in progress.'); };
  const secrets = (service: Service) => [...new Set([...Object.values(service.env), ...Object.values(store.state.projectEnvironments[service.projectId] || {}), ...Object.values(store.state.appliedServices[service.id]?.env || {}), ...pendingReleaseServices(store,service.id).flatMap(snapshot=>Object.values(snapshot.env)), ...Object.values(store.state.services.find(item => item.id === service.id)?.env || {})].filter(secret => secret.length >= 4)), ...sourceCredentialSecrets(store.state.sourceCredentials[service.id])];
  const redact = (service: Service, value: string) => secrets(service).reduce((text, secret) => text.split(secret).join('[REDACTED]'), value);
  const redactProgress = (service: Service, value: string) => {
    let safeEnd = value.length;
    for (const secret of secrets(service)) for (let length = Math.min(secret.length - 1, value.length); length > 0; length--) if (value.endsWith(secret.slice(0, length))) { safeEnd = Math.min(safeEnd, value.length - length); break; }
    return redact(service, value.slice(0, safeEnd));
  };
  const enqueue = (serviceId: string, action: () => Promise<void>) => {
    serviceMetrics.invalidate(serviceId);
    busy.add(serviceId);
    const job = Promise.resolve().then(async()=>{
      try{await terminals?.closeService(serviceId);}catch{
        const message='The existing terminal could not be stopped. The runtime operation was cancelled.';
        for(const deployment of store.state.deployments)if(deployment.serviceId===serviceId&&['queued','running'].includes(deployment.status)){deployment.status='failed';deployment.finishedAt=now();deployment.output+=`\n${message}\n`;}
        for(const backup of store.state.backups)if(backup.serviceId===serviceId&&backup.status==='running'){backup.status='failed';backup.error=message;}
        for(const restore of store.state.restores)if(restore.targetServiceId===serviceId&&['queued','running'].includes(restore.status)){restore.status='failed';restore.phase='finished';restore.finishedAt=now();restore.error=message;}
        const service=store.state.services.find(item=>item.id===serviceId);if(service){service.status='failed';service.error=message;}
        store.save();return;
      }
      await action();
    }).catch(error => { app.log.error(error); }).finally(() => { busy.delete(serviceId); jobs.delete(job); cachedMetrics = undefined; serviceMetrics.invalidate(serviceId); });
    jobs.add(job); return job;
  };
  const runtimeService = (service: Service): Service => {
    if(service.runtimeUncertain)throw new HttpError(409,'A deployment was interrupted. Deploy the saved configuration to reconcile the runtime before data operations.');
    const applied = store.state.appliedServices[service.id];
    // Legacy state had no deployment snapshot. Refuse to guess once its configuration is dirty.
    if (!applied && service.deployedAt && service.updatedAt > service.deployedAt) throw new HttpError(409, 'Redeploy this legacy service once before backing up or restoring its runtime.');
    return { ...structuredClone(applied || service), status: service.status, containerId: service.containerId || applied?.containerId };
  };
  async function refreshStatuses() {
    try {
      const states = await driver.statuses();
      for (const service of store.state.services) if (!busy.has(service.id) && !recoveryPending(service.id) && !service.runtimeUncertain && (states[service.id] || (mode === 'docker' && service.containerId))) service.status = states[service.id] || 'not-deployed';
    } catch { /* Keep the last known state; metrics carries the Docker connectivity error. */ }
  }
  function validateService(service: Service) {
    const configurations=[...store.state.services,...Object.values(store.state.appliedServices),...pendingReleaseServices(store)];
    if (configurations.some(item => item.id !== service.id && item.projectId === service.projectId && item.name === service.name)) throw new HttpError(409, 'A service with this name already exists in the project.');
    if (new Set(service.mounts.map(mount => mount.name)).size !== service.mounts.length || new Set(service.mounts.map(mount => mount.mountPath)).size !== service.mounts.length) throw new HttpError(400, 'Volume names and mount paths must be unique.');
    if (new Set(service.domains.map(domain => domain.hostname + domain.path)).size !== service.domains.length) throw new HttpError(400, 'Duplicate domain route.');
    if (new Set(service.domains.map(domain => domain.id)).size !== service.domains.length) throw new HttpError(400, 'Domain route identifiers must be unique.');
    if (service.domains.filter(domain => domain.primary).length > 1) throw new HttpError(400, 'Choose at most one primary domain.');
    assertDomainOwnership(service, configurations, [publicUrl ? new URL(publicUrl).hostname : '', process.env.PANEL_DOMAIN || '']);
    for (const domain of service.domains) if (configurations.some(item => item.id !== service.id && item.domains.some(other => other.hostname === domain.hostname && other.path === domain.path))) throw new HttpError(409, 'This domain route is already used by another service.');
    for (const port of service.ports) if (configurations.some(item => item.id !== service.id && item.ports.some(other => other.published === port.published && other.protocol === port.protocol))) throw new HttpError(409, 'This published port is already used by another service.');
    if (service.kind === 'compose') {
      if (service.source.type !== 'compose') throw new HttpError(400, 'Compose services require inline Compose source.');
      try { sanitizeCompose(service); } catch (error) { throw new HttpError(400, String((error as Error).message)); }
    } else if (service.source.type === 'compose') throw new HttpError(400, 'Use a Compose service for Compose source.');
    if (service.kind !== 'app' && service.kind !== 'compose' && service.source.type !== 'image') throw new HttpError(400, 'Database services require a database image.');
  }
  function newService(input: z.infer<typeof serviceCreate>, defaultPort = 80): Service {
    const project = projectById(input.projectId);
    const serviceId = randomUUID();
    const password = randomBytes(24).toString('base64url');
    const defaults: Record<string, { image: string; env: Record<string, string>; path: string }> = {
      postgres: { image: 'postgres:17-alpine', env: { POSTGRES_DB: input.name.replaceAll('-', '_'), POSTGRES_USER: 'harborlight', POSTGRES_PASSWORD: password }, path: '/var/lib/postgresql/data' },
      mysql: { image: 'mysql:8.4', env: { MYSQL_DATABASE: input.name.replaceAll('-', '_'), MYSQL_USER: 'harborlight', MYSQL_PASSWORD: password, MYSQL_ROOT_PASSWORD: randomBytes(24).toString('base64url') }, path: '/var/lib/mysql' },
      mariadb: { image: 'mariadb:11.4', env: { MARIADB_DATABASE: input.name.replaceAll('-', '_'), MARIADB_USER: 'harborlight', MARIADB_PASSWORD: password, MARIADB_ROOT_PASSWORD: randomBytes(24).toString('base64url') }, path: '/var/lib/mysql' },
      mongo: { image: 'mongo:8', env: { MONGO_INITDB_DATABASE: input.name.replaceAll('-', '_'), MONGO_INITDB_ROOT_USERNAME: 'harborlight', MONGO_INITDB_ROOT_PASSWORD: password }, path: '/data/db' },
      redis: { image: 'redis:7-alpine', env: { REDIS_PASSWORD: password }, path: '/data' }
    };
    const database = defaults[input.kind];
    const source = input.source || (database ? { type: 'image' as const, image: database.image } : input.kind === 'compose' ? { type: 'compose' as const, compose: 'services:\n  web:\n    image: nginx:1.28-alpine\n' } : { type: 'image' as const, image: 'nginx:1.28-alpine' });
    const { baseDomain, testDomainIp } = store.state.settings;
    const defaultDomains = input.domains === undefined && input.kind === 'app'
      ? baseDomain
        ? [{ id: randomUUID(), hostname: `${`${input.name}-${project.name}`.slice(0, 63).replace(/-$/, '')}.${baseDomain}`, port: defaultPort, https: true, path: '/' }]
        : testDomainIp ? [{ id: randomUUID(), hostname: testDomainHostname(serviceId, testDomainIp), port: defaultPort, https: false, path: '/' }] : []
      : [];
    if (defaultDomains.some(domain => domain.hostname.length > 253)) throw new HttpError(400, 'The automatic domain is too long. Choose a shorter base domain or add an explicit domain.');
    const service: Service = { id: serviceId, projectId: input.projectId, name: input.name, kind: input.kind, source, env: { ...database?.env, ...input.env }, status: 'not-deployed', domains: (input.domains || defaultDomains).map(domain => ({ ...domain, id: domain.id || randomUUID() })), mounts: (input.mounts || (database ? [{ name: 'data', mountPath: database.path }] : [])).map(mount => ({ ...mount, id: mount.id || randomUUID() })), ports: input.ports || [], resources: input.resources || { cpu: 1, memoryMb: database ? 512 : 256 }, notes: input.notes || '', createdAt: now(), updatedAt: now() };
    validateService(service); store.state.services.push(service); store.activity('Service created', service.name, undefined, service.projectId); store.save(); return service;
  }

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/auth/session', async request => session(request));
  const authLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
  app.post('/api/auth/setup', authLimit, async (request, reply) => {
    if (store.state.users.length) throw new HttpError(409, 'Setup is already complete.');
    const input = setupInput.parse(request.body), salt = randomBytes(16).toString('hex');
    const hash = (await scrypt(input.password, salt, 64) as Buffer).toString('hex');
    if (store.state.users.length) throw new HttpError(409, 'Setup is already complete.');
    store.state.owner = { name: input.name, email: input.email, hash, salt }; store.activity('Owner account created', input.name);
    const user: UserRecord = { ...store.state.owner, id: randomUUID(), role: 'owner', memberships: [], disabled: false, createdAt: now(), updatedAt: now() };
    store.state.users.push(user);
    return signIn(reply, user);
  });
  app.post('/api/auth/login', authLimit, async (request, reply) => {
    const input = loginInput.parse(request.body), user = store.state.users.find(item => item.email === input.email);
    const expectedHash = user?.hash;
    const calculated = await scrypt(input.password, user?.salt || 'harborlight-no-owner-salt', 64) as Buffer;
    const current = user && store.state.users.find(item => item.id === user.id && !item.disabled && item.hash === expectedHash && item.email === input.email);
    if (!current || !timingSafeEqual(calculated, Buffer.from(current.hash, 'hex'))) throw new HttpError(401, 'Email or password is incorrect.');
    return signIn(reply, current);
  });
  terminals=registerTerminals(app,{store,access,mode,runtime:options.terminalRuntime??(mode==='docker'&&process.env.HARBORLIGHT_EXPERIMENTAL_TERMINAL==='true'?new DockerTerminalRuntime():undefined),publicOrigin,requireIdle,policy:options.terminalPolicy});
  registerAccounts(app, store, access,userId=>terminals!.closeUser(userId));
  app.post('/api/auth/logout', async (request, reply) => { const hash = hashToken(request.cookies[COOKIE] || ''); store.state.sessions = store.state.sessions.filter(item => item.hash !== hash); store.save(); await terminals?.closeSession(hash); reply.clearCookie(COOKIE, { path: '/' }); return { ok: true }; });
  app.get('/api/metrics', async request => { access.requireGlobal(request); const result = await metrics(); access.requireGlobal(request); return result; });
  app.get('/api/overview', async request => {
    const global = access.isGlobal(request);
    const [currentMetrics] = await Promise.all([global ? metrics() : Promise.resolve(undefined), refreshStatuses()]);
    if (global) access.requireGlobal(request);
    const projects = store.state.projects.filter(project => access.canRead(request, project.id));
    const services = store.state.services.filter(service => access.canRead(request, service.projectId));
    return { projects, services: services.map(service => access.service(request, service, true)), deployments: store.state.deployments.filter(record => access.canReadRecord(request, record)).slice(0, 20).map(record => access.deployment(request, record)), activity: store.state.activity.filter(record => access.activity(request, record)).slice(0, 30), metrics: currentMetrics || { mode, restricted: true, cpuPercent: null, memoryUsedBytes: 0, memoryTotalBytes: 0, diskUsedBytes: null, diskTotalBytes: null, uptime: 0, dockerVersion: null, containersRunning: services.filter(service => service.status === 'running').length } };
  });
  app.get('/api/projects', async request => store.state.projects.filter(project => access.canRead(request, project.id)));
  app.post('/api/projects', async (request, reply) => { const input = projectInput.parse(request.body); if (store.state.projects.some(project => project.name === input.name)) throw new HttpError(409, 'A project with this name already exists.'); const project = { ...input, id: randomUUID(), createdAt: now() }; store.state.projects.push(project); store.activity('Project created', project.name, undefined, project.id); store.save(); return reply.status(201).send(project); });
  app.patch('/api/projects/:id', async request => { const project = projectById(parameter(request)), input = projectPatch.parse(request.body); if (input.name && store.state.projects.some(item => item.id !== project.id && item.name === input.name)) throw new HttpError(409, 'A project with this name already exists.'); Object.assign(project, input); store.activity('Project updated', project.name, undefined, project.id); store.save(); return project; });
  app.delete('/api/projects/:id', async request => { const project = projectById(parameter(request)); if (store.state.services.some(service => service.projectId === project.id)) throw new HttpError(409, 'Remove the project services first. Persistent volumes are retained.'); store.state.projects = store.state.projects.filter(item => item.id !== project.id); delete store.state.projectEnvironments[project.id]; for (const user of store.state.users) user.memberships = user.memberships.filter(item => item.projectId !== project.id); store.activity('Project deleted', project.name, undefined, project.id); store.save(); return { ok: true }; });
  registerProjectEnvironment(app, {
    getProject: projectId => store.state.projects.find(project => project.id === projectId),
    getService: serviceId => store.state.services.find(service => service.id === serviceId),
    getEnvironment: projectId => store.state.projectEnvironments[projectId],
    authorizeProject: (request, projectId) => { access.requireProject(request, projectId, 'write'); },
    authorizeService: (request, serviceId) => { access.requireService(request, serviceId, 'write'); },
    setEnvironment: (projectId, env) => {
      const services = store.state.services.filter(service => service.projectId === projectId);
      for (const service of services) { requireIdle(service.id); if(service.runtimeUncertain)throw new HttpError(409,'Reconcile interrupted deployments before changing the project environment.'); }
      const previous = store.state.projectEnvironments[projectId] || {};
      const comparable = (value: Record<string,string>) => JSON.stringify(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)));
      for (const service of services) if (comparable(effectiveServiceEnvironment(service,previous)) !== comparable(effectiveServiceEnvironment(service,env))) service.updatedAt = now();
      store.state.projectEnvironments[projectId] = env;
      store.activity('Project environment updated', projectById(projectId).name, 'Deploy affected services to apply inherited values.', projectId); store.save();
    }
  });
  app.get('/api/services', async request => { const projectId = (request.query as { projectId?: string }).projectId; if (projectId) id.parse(projectId); await refreshStatuses(); return store.state.services.filter(service => (!projectId || service.projectId === projectId) && access.canRead(request, service.projectId)).map(service => access.service(request, service, true)); });
  app.get('/api/services/:id', async request => { await refreshStatuses(); return access.service(request, access.requireService(request, parameter(request))); });
  app.get('/api/services/:id/metrics', async request => {
    const service = structuredClone(access.requireService(request, parameter(request)));
    const result = await serviceMetrics.get({ ...structuredClone(store.state.appliedServices[service.id] || service), status: service.status, containerId: service.containerId, deployedAt: service.deployedAt });
    const current = access.requireService(request, service.id);
    if (current.containerId !== service.containerId || current.deployedAt !== service.deployedAt || current.status !== service.status) return { mode, serviceId: service.id, state: 'unavailable', sampledAt: null, checkedAt: now(), containers: [], totals: emptyMetricValues(), message: 'The runtime changed during collection. Retry for a current measurement.' };
    return result;
  });
  app.post('/api/services', async (request, reply) => reply.status(201).send(newService(serviceCreate.parse(request.body))));
  app.patch('/api/services/:id', async request => {
    const current = serviceById(parameter(request)); requireIdle(current.id); if(current.runtimeUncertain)throw new HttpError(409,'A deployment was interrupted. Deploy the saved configuration before changing it.'); const input = servicePatch.parse(request.body);
    const updated: Service = { ...current, ...input, domains: input.domains?.map(domain => ({ ...domain, id: domain.id || randomUUID() })) || current.domains, mounts: input.mounts?.map(mount => ({ ...mount, id: mount.id || randomUUID() })) || current.mounts, updatedAt: now() };
    validateService(updated); Object.assign(current, updated); disableChangedGitHubWebhook(store,current);
    store.state.sourceCredentials[current.id] = pruneSourceCredentials(current, store.state.sourceCredentials[current.id]);
    if (store.state.proxyAuth[current.id]) store.state.proxyAuth[current.id] = Object.fromEntries(Object.entries(store.state.proxyAuth[current.id]).filter(([domainId]) => current.domains.some(domain => domain.id === domainId)));
    store.activity('Service configuration saved', current.name, 'Deploy to apply changes.', current.projectId); store.save(); return current;
  });
  app.delete('/api/services/:id', async request => {
    const service = serviceById(parameter(request)); requireIdle(service.id); busy.add(service.id); serviceMetrics.invalidate(service.id);
    try { await terminals?.closeService(service.id); if (service.deployedAt || service.containerId || service.status === 'failed') await driver.remove(service); store.state.services = store.state.services.filter(item => item.id !== service.id); store.state.backupSchedules = store.state.backupSchedules.filter(item => item.serviceId !== service.id); delete store.state.deployTokens[service.id]; delete store.state.deployTokenOwners[service.id]; delete store.state.proxyAuth[service.id]; delete store.state.sourceCredentials[service.id]; delete store.state.appliedServices[service.id]; delete store.state.appliedProxyAuth[service.id]; delete store.state.activeReleaseIds[service.id]; delete store.state.pendingReleaseIds[service.id]; delete store.state.githubWebhooks[service.id]; store.state.releases=store.state.releases.filter(release=>release.metadata.serviceId!==service.id); store.activity('Service deleted', service.name, 'Persistent volumes and backups retained.', service.projectId); store.save(); return { ok: true }; }
    catch (error) { throw new HttpError(502, redact(service, (error as Error).message)); } finally { busy.delete(service.id); }
  });
  function queueDeployment(serviceId: string, trigger: string, options: { forceRebuild?: boolean; expectedCommit?: string; onQueued?: (deployment:Deployment)=>void } = {}): Deployment {
    const service = serviceById(id.parse(serviceId)); requireIdle(service.id); validateService(service);
    const releaseId=mode==='docker'&&service.kind==='app'?randomUUID():undefined;
    const runtimeOptions = { forceRebuild:options.forceRebuild,expectedCommit:options.expectedCommit,releaseId, proxyAuth: structuredClone(store.state.proxyAuth[service.id] || {}), sourceCredentials: resolveSourceCredentials(service, store.state.sourceCredentials[service.id]), projectEnvironment: structuredClone(store.state.projectEnvironments[service.projectId] || {}) };
    const snapshot = { ...structuredClone(service), env: service.kind === 'compose' ? structuredClone(service.env) : effectiveServiceEnvironment(service,runtimeOptions.projectEnvironment), volumeOverrides: structuredClone(store.state.appliedServices[service.id]?.volumeOverrides || {}) };
    if (options.forceRebuild && !['git', 'dockerfile'].includes(service.source.type)) throw new HttpError(400, 'Force rebuild is available for Git and Dockerfile sources. Images are always pulled during deployment.');
    const deployment: Deployment = { id: randomUUID(), serviceId: service.id, projectId: service.projectId, status: 'queued', trigger, createdAt: now(), output: options.forceRebuild ? 'Build cache disabled; base images will be pulled.\n' : '', image: service.source.image, forceRebuild: !!options.forceRebuild,requestedCommit:options.expectedCommit };
    store.state.deployments.unshift(deployment); service.status = 'deploying'; delete service.error; store.activity('Deployment queued', service.name, undefined, service.projectId); options.onQueued?.(deployment); store.save();
    void enqueue(service.id, async () => {
      deployment.status = 'running'; store.save();
      try {
        let rawOutput = deployment.output;
        const result = await driver.deploy(snapshot, chunk => { rawOutput = (rawOutput + chunk).slice(-250000); deployment.output = redactProgress(snapshot, rawOutput).slice(-200000); }, runtimeOptions);
        deployment.output = redact(snapshot, rawOutput).slice(-200000);
        Object.assign(service, { status: 'running', containerId: result.containerId, deployedAt: now() }); delete service.runtimeUncertain; delete snapshot.runtimeUncertain;
        store.state.appliedServices[service.id] = { ...snapshot, env: effectiveServiceEnvironment(service,runtimeOptions.projectEnvironment), status:'running', containerId:result.containerId, deployedAt:service.deployedAt };
        store.state.appliedProxyAuth[service.id]=structuredClone(runtimeOptions.proxyAuth);
        deployment.status = 'success'; deployment.image = result.image; deployment.commit = result.commit;
        delete store.state.activeReleaseIds[service.id];
        if(releaseId)recordRelease(store,store.state.appliedServices[service.id],runtimeOptions.proxyAuth,deployment,result,releaseId); delete store.state.pendingReleaseIds[service.id]; store.activity('Deployment succeeded', service.name, undefined, service.projectId);
      } catch (error) { deployment.status = 'failed'; service.status = 'failed'; service.error = redact(snapshot, (error as Error).message); deployment.output += `\n${service.error}\n`; store.activity('Deployment failed', service.name, undefined, service.projectId); }
      finally { deployment.finishedAt = now(); store.save(); }
    });
    return deployment;
  }
  app.post('/api/services/:id/deploy', async (request, reply) => { const options = z.object({ forceRebuild: z.boolean().optional() }).strict().parse(request.body || {}); return reply.status(202).send(queueDeployment(parameter(request), 'Manual', options)); });
  registerGitHubWebhooks(app,{store,access,mode,publicUrl,enqueueDeploy:queueDeployment});
  registerReleases(app,{store,access,driver,mode,requireIdle,enqueue,validateService,secrets});
  registerSourceCredentials(app, {
    credentialsDirectory,
    getService: serviceId => store.state.services.find(service => service.id === serviceId),
    getCredentials: serviceId => store.state.sourceCredentials[serviceId],
    setCredentials: (serviceId, value) => { const service = serviceById(serviceId); requireIdle(serviceId); store.state.sourceCredentials[serviceId] = value; service.updatedAt = now(); store.activity('Source credentials updated', service.name, undefined, service.projectId); store.save(); },
    authorize: (request, serviceId) => { access.requireService(request, serviceId, 'write'); },
    requireIdle
  });
  registerProxyAuth(app, {
    getService: serviceId => store.state.services.find(service => service.id === serviceId),
    authorize: (request, serviceId, permission) => { access.requireService(request, serviceId, 'write'); if (permission === 'write') requireIdle(serviceId); },
    getAuth: (serviceId, domainId) => store.state.proxyAuth[serviceId]?.[domainId],
    setAuth: (serviceId, domainId, credential) => { const service = serviceById(serviceId); requireIdle(serviceId); store.state.proxyAuth[serviceId] ||= {}; if (credential) store.state.proxyAuth[serviceId][domainId] = credential; else delete store.state.proxyAuth[serviceId][domainId]; service.updatedAt = now(); store.activity(credential ? 'Domain authentication updated' : 'Domain authentication removed', service.name, undefined, service.projectId); store.save(); }
  });
  registerDeploymentWebhooks(app, {
    getService: serviceId => store.state.services.find(service => service.id === serviceId),
    getTokenHash: serviceId => { const issuer = store.state.users.find(user => user.id === store.state.deployTokenOwners[serviceId] && !user.disabled); const service = store.state.services.find(item => item.id === serviceId); return issuer && service && (issuer.role !== 'member' || issuer.memberships.some(item => item.projectId === service.projectId && item.role === 'operator')) ? store.state.deployTokens[serviceId] : undefined; },
    setTokenHash: (serviceId, hash, request) => { if (hash) { store.state.deployTokens[serviceId] = hash; store.state.deployTokenOwners[serviceId] = access.requireCookie(request!).user.id; } else { delete store.state.deployTokens[serviceId]; delete store.state.deployTokenOwners[serviceId]; } const service = serviceById(serviceId); store.activity(hash ? 'Deployment token rotated' : 'Deployment token revoked', service.name, undefined, service.projectId); store.save(); },
    enqueueDeploy: queueDeployment,
    publicUrl
  });
  for (const action of ['start', 'stop', 'restart'] as const) app.post(`/api/services/:id/${action}`, async request => {
    const service = serviceById(parameter(request)); requireIdle(service.id); if (!service.deployedAt && !service.containerId) throw new HttpError(409, 'Deploy this service first.'); busy.add(service.id); serviceMetrics.invalidate(service.id);
    try { await terminals?.closeService(service.id); await driver.action(service, action); service.status = action === 'stop' ? 'stopped' : 'running'; store.activity(`Service ${action === 'stop' ? 'stopped' : action === 'start' ? 'started' : 'restarted'}`, service.name, undefined, service.projectId); store.save(); return service; }
    catch (error) { throw new HttpError(502, redact(service, (error as Error).message)); } finally { busy.delete(service.id); serviceMetrics.invalidate(service.id); }
  });
  app.get('/api/services/:id/logs', async request => { const service = serviceById(parameter(request)); const tail = z.coerce.number().int().min(1).max(2000).default(200).parse((request.query as { tail?: string }).tail); if (!service.deployedAt && !service.containerId && service.status !== 'failed') return { logs: 'Deploy this service to view runtime logs.' }; try { return { logs: redact(service, await driver.logs(service, tail)) }; } catch (error) { throw new HttpError(502, redact(service, (error as Error).message)); } });
  app.get('/api/deployments', async request => store.state.deployments.filter(item => access.canReadRecord(request, item)).map(item => access.deployment(request, item)));
  app.get('/api/services/:id/deployments', async request => { const service = access.requireService(request, parameter(request)); return store.state.deployments.filter(item => item.serviceId === service.id).map(item => access.deployment(request, item)); });
  app.get('/api/deployments/:id', async request => { const deployment = store.state.deployments.find(item => item.id === parameter(request)); if (!deployment || !access.canReadRecord(request, deployment)) throw new HttpError(404, 'Deployment not found.'); return access.deployment(request, deployment); });
  app.get('/api/backups', async request => store.state.backups.filter(item => access.canReadRecord(request, item)).map(item => access.backup(request, item)));
  app.get('/api/services/:id/backups', async request => { const service = access.requireService(request, parameter(request)); return store.state.backups.filter(item => item.serviceId === service.id).map(item => access.backup(request, item)); });
  function createBackup(service: Service, options: {scheduleId?:string;restoreJobId?:string} = {}): Backup {
    const backupId = randomUUID(), extension = mode === 'demo' ? 'demo.txt' : ['postgres', 'mysql', 'mariadb'].includes(service.kind) ? 'sql' : service.kind === 'mongo' ? 'archive.gz' : 'tar.gz';
    const backup: Backup = { id: backupId, serviceId: service.id, projectId: service.projectId, status: 'running', createdAt: now(), sizeBytes: 0, filename: `${service.name}-${backupId}.${extension}`, ...options };
    store.state.backups.unshift(backup); store.save();
    return backup;
  }
  async function performBackup(service: Service, backup: Backup) {
    const directory = join(dataDir,'backups'), path = join(directory,backup.filename);
    try {
      await mkdir(directory,{recursive:true,mode:0o700});
      const metadata = await driver.backup(structuredClone(service),path);
      backup.sizeBytes = (await stat(path)).size; if (!backup.sizeBytes) throw new Error('Backup output is empty.');
      if (metadata) backup.metadata=metadata;
      backup.sha256=await backupFileHash(path); store.state.backupProfiles[backup.id]=structuredClone(service); backup.status='success';
      store.activity('Backup completed',service.name,undefined,service.projectId);
    } catch (error) { backup.status='failed'; backup.error=redact(service,(error as Error).message); delete store.state.backupProfiles[backup.id]; await rm(path,{force:true}); store.activity('Backup failed',service.name,undefined,service.projectId); throw error; }
    finally { store.save(); }
  }
  function queueBackup(serviceId: string, scheduleId?: string): Backup {
    store.assertWritable();
    const current=serviceById(id.parse(serviceId)); requireIdle(current.id); if(current.status!=='running') throw new HttpError(409,'Start the service before creating a backup.');
    const service=runtimeService(current);
    if(service.kind==='compose'||service.kind==='app'&&!service.mounts.length) throw new HttpError(400,'Backups require a database service or application volumes.');
    const backup=createBackup(service,{...(scheduleId?{scheduleId}:{})});
    void enqueue(service.id,async()=>{try{await performBackup(service,backup);}catch{/* performBackup records and redacts the failure. */}});
    return backup;
  }
  app.post('/api/services/:id/backups', async (request, reply) => reply.status(202).send(queueBackup(parameter(request))));
  const scheduler = registerBackupSchedules(app, {
    listSchedules: () => store.state.backupSchedules,
    saveSchedules: schedules => { store.state.backupSchedules = schedules; store.save(); },
    getService: serviceId => store.state.services.find(service => service.id === serviceId),
    getBackups: () => store.state.backups,
    filterSchedules: (request, schedules) => schedules.filter(schedule => { const service = store.state.services.find(item => item.id === schedule.serviceId); return !!service && access.canRead(request, service.projectId); }),
    queueBackup,
    forgetBackup: backupId => { store.state.backups = store.state.backups.filter(backup => backup.id !== backupId); delete store.state.backupProfiles[backupId]; store.save(); },
    backupDirectory: join(dataDir, 'backups')
  });
  registerRestoreJobs(app,{store,access,driver,dataDir,mode,requireIdle,enqueue,runtimeService,createBackup,performBackup,secrets});
  app.get('/api/backups/:id/download', async (request, reply) => { const backup = store.state.backups.find(item => item.id === parameter(request)); if (!backup || backup.status !== 'success') throw new HttpError(404, 'Completed backup not found.'); let handle; try{const path=await safeLocalBackupPath(dataDir,backup);handle=await openFile(path,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW);}catch{throw new HttpError(404,'Backup file is missing or unsafe.');} return reply.header('Content-Type', 'application/octet-stream').header('Content-Disposition', `attachment; filename="${backup.filename}"`).send(handle.createReadStream()); });
  app.get('/api/templates', async () => templates);
  app.post('/api/templates/:id/install', async (request, reply) => { const template = templates.find(item => item.id === (request.params as { id: string }).id); if (!template) throw new HttpError(404, 'Template not found.'); const input = z.object({ projectId: id, name: z.string() }).strict().parse(request.body); return reply.status(201).send(newService(serviceCreate.parse({ ...input, kind: template.kind, source: { type: 'image', image: template.image }, env: template.env, mounts: template.mounts }), template.port)); });
  app.get('/api/activity', async request => store.state.activity.filter(item => access.activity(request, item)));
  app.get('/api/settings', async () => store.state.settings);
  app.patch('/api/settings', async request => { const input = settingsInput.parse(request.body); Object.assign(store.state.settings, input); store.activity('Settings updated', 'Server'); store.save(); return store.state.settings; });
  const staticDir = options.staticDir || resolve('dist/client');
  if (existsSync(join(staticDir, 'index.html'))) {
    await app.register(staticFiles, { root: staticDir, prefix: '/' });
    app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.status(404).send({ error: 'API route not found.' }) : reply.type('text/html').sendFile('index.html'));
  } else app.setNotFoundHandler((_request, reply) => reply.status(404).send({ error: 'Route not found.' }));
  app.addHook('onClose', async () => { serviceMetrics.clear(); await scheduler.stop(); await Promise.allSettled([...jobs]); try { store.save(); } finally { store.close(); } });
  return app;
}
