import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { existsSync, createReadStream } from 'node:fs';
import { mkdir, stat, rm } from 'node:fs/promises';
import { z } from 'zod';
import { Store } from './store.js';
import { DockerDriver, DemoDriver, type RuntimeDriver, sanitizeCompose } from './docker.js';
import { templates } from './templates.js';
import { registerDeploymentWebhooks } from './webhooks.js';
import { registerBackupSchedules } from './backup-schedules.js';
import { projectInput, projectPatch, serviceCreate, servicePatch, settingsInput, setupInput, loginInput, id } from './validation.js';
import type { Service, RuntimeMode, Session, Backup, Deployment } from '../shared/types.js';

const scrypt = promisify(scryptCallback);
const now = () => new Date().toISOString();
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const COOKIE = 'harborlight_session';
const ttl = 86400 * 7;
class HttpError extends Error { constructor(readonly statusCode: number, message: string) { super(message); } }
export interface AppOptions { dataDir?: string; mode?: RuntimeMode; driver?: RuntimeDriver; logger?: boolean; publicUrl?: string; cookieSecure?: boolean; staticDir?: string }

export async function createApp(options: AppOptions = {}) {
  const mode = options.mode || (process.env.HARBORLIGHT_MODE === 'demo' ? 'demo' : 'docker');
  const dataDir = resolve(options.dataDir || process.env.DATA_DIR || (mode === 'demo' ? '.data/demo' : '.data'));
  const store = new Store(dataDir, mode);
  const driver: RuntimeDriver = options.driver || (mode === 'demo' ? new DemoDriver() : new DockerDriver(dataDir));
  const publicUrl = options.publicUrl || process.env.PUBLIC_URL;
  const publicOrigin = publicUrl ? new URL(publicUrl).origin : undefined;
  const secureCookie = options.cookieSecure ?? (process.env.COOKIE_SECURE === 'true' || publicUrl?.startsWith('https:') || false);
  const app = Fastify({ logger: options.logger ? { redact: ['req.headers.authorization', 'req.headers.cookie'] } : false, bodyLimit: 1024 * 1024, trustProxy: false, requestTimeout: 30000 });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  const jobs = new Set<Promise<unknown>>();
  const busy = new Set<string>();
  let cachedMetrics: { at: number; value: Awaited<ReturnType<RuntimeDriver['metrics']>> } | undefined;
  let metricsPromise: Promise<Awaited<ReturnType<RuntimeDriver['metrics']>>> | undefined;
  async function metrics() {
    if (cachedMetrics && Date.now() - cachedMetrics.at < 5000) return cachedMetrics.value;
    if (!metricsPromise) metricsPromise = driver.metrics().then(value => { cachedMetrics = { at: Date.now(), value }; return value; }).finally(() => { metricsPromise = undefined; });
    return metricsPromise;
  }
  const session = (request: FastifyRequest): Session => {
    const token = request.cookies[COOKIE];
    const authenticated = !!token && store.state.sessions.some(item => item.hash === hashToken(token) && item.expires > Date.now());
    return { authenticated, setupRequired: !store.state.owner, mode, ...(authenticated && store.state.owner ? { user: { name: store.state.owner.name, email: store.state.owner.email } } : {}) };
  };
  function signIn(reply: FastifyReply) {
    const token = randomBytes(32).toString('hex');
    store.state.sessions.push({ hash: hashToken(token), expires: Date.now() + ttl * 1000 });
    store.state.sessions = store.state.sessions.slice(-20); store.save();
    reply.setCookie(COOKIE, token, { path: '/', httpOnly: true, sameSite: 'strict', secure: secureCookie, maxAge: ttl });
    return { authenticated: true, setupRequired: false, mode, user: { email: store.state.owner!.email, name: store.state.owner!.name } } satisfies Session;
  }
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
    const path = request.url.split('?')[0];
    const publicPaths = ['/api/health', '/api/auth/session', '/api/auth/setup', '/api/auth/login'];
    const isDeploymentHook = request.method === 'POST' && /^\/api\/hooks\/deploy\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(path);
    if (path.startsWith('/api/') && !publicPaths.includes(path) && !isDeploymentHook && !session(request).authenticated) throw new HttpError(401, 'Sign in to continue.');
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.status(400).send({ error: error.issues.map(issue => `${issue.path.join('.') || 'Request'}: ${issue.message}`).join('; ') });
    const status = (error as { statusCode?: number }).statusCode || 500;
    if (status >= 500) app.log.error(error);
    return reply.status(status).send({ error: status >= 500 ? 'The operation could not be completed. Check the server logs.' : (error as Error).message });
  });
  const parameter = (request: FastifyRequest) => id.parse((request.params as { id: string }).id);
  const serviceById = (serviceId: string) => { const service = store.state.services.find(item => item.id === serviceId); if (!service) throw new HttpError(404, 'Service not found.'); return service; };
  const projectById = (projectId: string) => { const project = store.state.projects.find(item => item.id === projectId); if (!project) throw new HttpError(404, 'Project not found.'); return project; };
  const requireIdle = (serviceId: string) => { if (busy.has(serviceId)) throw new HttpError(409, 'This service already has an operation in progress.'); };
  const redact = (service: Service, value: string) => Object.values(service.env).filter(secret => secret.length >= 4).reduce((text, secret) => text.split(secret).join('[REDACTED]'), value);
  const redactProgress = (service: Service, value: string) => {
    let safeEnd = value.length;
    for (const secret of Object.values(service.env).filter(secret => secret.length >= 4)) for (let length = Math.min(secret.length - 1, value.length); length > 0; length--) if (value.endsWith(secret.slice(0, length))) { safeEnd = Math.min(safeEnd, value.length - length); break; }
    return redact(service, value.slice(0, safeEnd));
  };
  const enqueue = (serviceId: string, action: () => Promise<void>) => {
    busy.add(serviceId);
    const job = Promise.resolve().then(action).catch(error => { app.log.error(error); }).finally(() => { busy.delete(serviceId); jobs.delete(job); cachedMetrics = undefined; });
    jobs.add(job); return job;
  };
  async function refreshStatuses() {
    try {
      const states = await driver.statuses();
      for (const service of store.state.services) if (!busy.has(service.id) && (states[service.id] || (mode === 'docker' && service.containerId))) service.status = states[service.id] || 'not-deployed';
    } catch { /* Keep the last known state; metrics carries the Docker connectivity error. */ }
  }
  function validateService(service: Service) {
    if (store.state.services.some(item => item.id !== service.id && item.projectId === service.projectId && item.name === service.name)) throw new HttpError(409, 'A service with this name already exists in the project.');
    if (new Set(service.mounts.map(mount => mount.name)).size !== service.mounts.length || new Set(service.mounts.map(mount => mount.mountPath)).size !== service.mounts.length) throw new HttpError(400, 'Volume names and mount paths must be unique.');
    if (new Set(service.domains.map(domain => domain.hostname + domain.path)).size !== service.domains.length) throw new HttpError(400, 'Duplicate domain route.');
    for (const domain of service.domains) if (store.state.services.some(item => item.id !== service.id && item.domains.some(other => other.hostname === domain.hostname && other.path === domain.path))) throw new HttpError(409, 'This domain route is already used by another service.');
    for (const port of service.ports) if (store.state.services.some(item => item.id !== service.id && item.ports.some(other => other.published === port.published && other.protocol === port.protocol))) throw new HttpError(409, 'This published port is already used by another service.');
    if (service.kind === 'compose') {
      if (service.source.type !== 'compose') throw new HttpError(400, 'Compose services require inline Compose source.');
      try { sanitizeCompose(service); } catch (error) { throw new HttpError(400, String((error as Error).message)); }
    } else if (service.source.type === 'compose') throw new HttpError(400, 'Use a Compose service for Compose source.');
    if (service.kind !== 'app' && service.kind !== 'compose' && service.source.type !== 'image') throw new HttpError(400, 'Database services require a database image.');
  }
  function newService(input: z.infer<typeof serviceCreate>, defaultPort = 80): Service {
    const project = projectById(input.projectId);
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
    const defaultDomains = input.domains === undefined && input.kind === 'app' && store.state.settings.baseDomain ? [{ id: randomUUID(), hostname: `${`${input.name}-${project.name}`.slice(0, 63).replace(/-$/, '')}.${store.state.settings.baseDomain}`, port: defaultPort, https: true, path: '/' }] : [];
    if (defaultDomains.some(domain => domain.hostname.length > 253)) throw new HttpError(400, 'The automatic domain is too long. Choose a shorter base domain or add an explicit domain.');
    const service: Service = { id: randomUUID(), projectId: input.projectId, name: input.name, kind: input.kind, source, env: { ...database?.env, ...input.env }, status: 'not-deployed', domains: (input.domains || defaultDomains).map(domain => ({ ...domain, id: domain.id || randomUUID() })), mounts: (input.mounts || (database ? [{ name: 'data', mountPath: database.path }] : [])).map(mount => ({ ...mount, id: mount.id || randomUUID() })), ports: input.ports || [], resources: input.resources || { cpu: 1, memoryMb: database ? 512 : 256 }, notes: input.notes || '', createdAt: now(), updatedAt: now() };
    validateService(service); store.state.services.push(service); store.activity('Service created', service.name); store.save(); return service;
  }

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/auth/session', async request => session(request));
  const authLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
  app.post('/api/auth/setup', authLimit, async (request, reply) => {
    if (store.state.owner) throw new HttpError(409, 'Setup is already complete.');
    const input = setupInput.parse(request.body), salt = randomBytes(16).toString('hex');
    const hash = (await scrypt(input.password, salt, 64) as Buffer).toString('hex');
    if (store.state.owner) throw new HttpError(409, 'Setup is already complete.');
    store.state.owner = { name: input.name, email: input.email, hash, salt }; store.activity('Owner account created', input.name);
    return signIn(reply);
  });
  app.post('/api/auth/login', authLimit, async (request, reply) => {
    const input = loginInput.parse(request.body), owner = store.state.owner;
    const calculated = await scrypt(input.password, owner?.salt || 'harborlight-no-owner-salt', 64) as Buffer;
    if (!owner || !timingSafeEqual(calculated, Buffer.from(owner.hash, 'hex')) || owner.email !== input.email) throw new HttpError(401, 'Email or password is incorrect.');
    return signIn(reply);
  });
  app.post('/api/auth/logout', async (request, reply) => { const hash = hashToken(request.cookies[COOKIE] || ''); store.state.sessions = store.state.sessions.filter(item => item.hash !== hash); store.save(); reply.clearCookie(COOKIE, { path: '/' }); return { ok: true }; });
  app.get('/api/metrics', async () => metrics());
  app.get('/api/overview', async () => { const [currentMetrics] = await Promise.all([metrics(), refreshStatuses()]); return { projects: store.state.projects, services: store.state.services, deployments: store.state.deployments.slice(0, 20), activity: store.state.activity.slice(0, 30), metrics: currentMetrics }; });
  app.get('/api/projects', async () => store.state.projects);
  app.post('/api/projects', async (request, reply) => { const input = projectInput.parse(request.body); if (store.state.projects.some(project => project.name === input.name)) throw new HttpError(409, 'A project with this name already exists.'); const project = { ...input, id: randomUUID(), createdAt: now() }; store.state.projects.push(project); store.activity('Project created', project.name); store.save(); return reply.status(201).send(project); });
  app.patch('/api/projects/:id', async request => { const project = projectById(parameter(request)), input = projectPatch.parse(request.body); if (input.name && store.state.projects.some(item => item.id !== project.id && item.name === input.name)) throw new HttpError(409, 'A project with this name already exists.'); Object.assign(project, input); store.activity('Project updated', project.name); store.save(); return project; });
  app.delete('/api/projects/:id', async request => { const project = projectById(parameter(request)); if (store.state.services.some(service => service.projectId === project.id)) throw new HttpError(409, 'Remove the project services first. Persistent volumes are retained.'); store.state.projects = store.state.projects.filter(item => item.id !== project.id); store.activity('Project deleted', project.name); store.save(); return { ok: true }; });
  app.get('/api/services', async request => { const projectId = (request.query as { projectId?: string }).projectId; if (projectId) id.parse(projectId); await refreshStatuses(); return store.state.services.filter(service => !projectId || service.projectId === projectId); });
  app.get('/api/services/:id', async request => { await refreshStatuses(); return serviceById(parameter(request)); });
  app.post('/api/services', async (request, reply) => reply.status(201).send(newService(serviceCreate.parse(request.body))));
  app.patch('/api/services/:id', async request => {
    const current = serviceById(parameter(request)); requireIdle(current.id); const input = servicePatch.parse(request.body);
    const updated: Service = { ...current, ...input, domains: input.domains?.map(domain => ({ ...domain, id: domain.id || randomUUID() })) || current.domains, mounts: input.mounts?.map(mount => ({ ...mount, id: mount.id || randomUUID() })) || current.mounts, updatedAt: now() };
    validateService(updated); Object.assign(current, updated); store.activity('Service configuration saved', current.name, 'Deploy to apply changes.'); store.save(); return current;
  });
  app.delete('/api/services/:id', async request => {
    const service = serviceById(parameter(request)); requireIdle(service.id); busy.add(service.id);
    try { if (service.deployedAt || service.containerId || service.status === 'failed') await driver.remove(service); store.state.services = store.state.services.filter(item => item.id !== service.id); store.state.backupSchedules = store.state.backupSchedules.filter(item => item.serviceId !== service.id); delete store.state.deployTokens[service.id]; store.activity('Service deleted', service.name, 'Persistent volumes and backups retained.'); store.save(); return { ok: true }; }
    catch (error) { throw new HttpError(502, redact(service, (error as Error).message)); } finally { busy.delete(service.id); }
  });
  function queueDeployment(serviceId: string, trigger: string, options: { forceRebuild?: boolean } = {}): Deployment {
    const service = serviceById(id.parse(serviceId)); requireIdle(service.id); validateService(service);
    if (options.forceRebuild && !['git', 'dockerfile'].includes(service.source.type)) throw new HttpError(400, 'Force rebuild is available for Git and Dockerfile sources. Images are always pulled during deployment.');
    const deployment: Deployment = { id: randomUUID(), serviceId: service.id, status: 'queued', trigger, createdAt: now(), output: options.forceRebuild ? 'Build cache disabled; base images will be pulled.\n' : '', image: service.source.image, forceRebuild: !!options.forceRebuild };
    store.state.deployments.unshift(deployment); service.status = 'deploying'; delete service.error; store.activity('Deployment queued', service.name); store.save();
    void enqueue(service.id, async () => {
      deployment.status = 'running'; store.save();
      const snapshot = structuredClone(service);
      try {
        let rawOutput = deployment.output;
        const result = await driver.deploy(snapshot, chunk => { rawOutput = (rawOutput + chunk).slice(-250000); deployment.output = redactProgress(snapshot, rawOutput).slice(-200000); }, options);
        deployment.output = redact(snapshot, rawOutput).slice(-200000);
        Object.assign(service, { status: 'running', containerId: result.containerId, deployedAt: now() }); deployment.status = 'success'; deployment.image = result.image; deployment.commit = result.commit; store.activity('Deployment succeeded', service.name);
      } catch (error) { deployment.status = 'failed'; service.status = 'failed'; service.error = redact(snapshot, (error as Error).message); deployment.output += `\n${service.error}\n`; store.activity('Deployment failed', service.name); }
      finally { deployment.finishedAt = now(); store.save(); }
    });
    return deployment;
  }
  app.post('/api/services/:id/deploy', async (request, reply) => { const options = z.object({ forceRebuild: z.boolean().optional() }).strict().parse(request.body || {}); return reply.status(202).send(queueDeployment(parameter(request), 'Manual', options)); });
  registerDeploymentWebhooks(app, {
    getService: serviceId => store.state.services.find(service => service.id === serviceId),
    getTokenHash: serviceId => store.state.deployTokens[serviceId],
    setTokenHash: (serviceId, hash) => { if (hash) store.state.deployTokens[serviceId] = hash; else delete store.state.deployTokens[serviceId]; store.activity(hash ? 'Deployment token rotated' : 'Deployment token revoked', serviceById(serviceId).name); store.save(); },
    enqueueDeploy: queueDeployment,
    publicUrl
  });
  for (const action of ['start', 'stop', 'restart'] as const) app.post(`/api/services/:id/${action}`, async request => {
    const service = serviceById(parameter(request)); requireIdle(service.id); if (!service.deployedAt && !service.containerId) throw new HttpError(409, 'Deploy this service first.'); busy.add(service.id);
    try { await driver.action(service, action); service.status = action === 'stop' ? 'stopped' : 'running'; store.activity(`Service ${action === 'stop' ? 'stopped' : action === 'start' ? 'started' : 'restarted'}`, service.name); store.save(); return service; }
    catch (error) { throw new HttpError(502, redact(service, (error as Error).message)); } finally { busy.delete(service.id); }
  });
  app.get('/api/services/:id/logs', async request => { const service = serviceById(parameter(request)); const tail = z.coerce.number().int().min(1).max(2000).default(200).parse((request.query as { tail?: string }).tail); if (!service.deployedAt && !service.containerId && service.status !== 'failed') return { logs: 'Deploy this service to view runtime logs.' }; try { return { logs: redact(service, await driver.logs(service, tail)) }; } catch (error) { throw new HttpError(502, redact(service, (error as Error).message)); } });
  app.get('/api/deployments', async () => store.state.deployments);
  app.get('/api/services/:id/deployments', async request => { const service = serviceById(parameter(request)); return store.state.deployments.filter(item => item.serviceId === service.id); });
  app.get('/api/deployments/:id', async request => { const deployment = store.state.deployments.find(item => item.id === parameter(request)); if (!deployment) throw new HttpError(404, 'Deployment not found.'); return deployment; });
  app.get('/api/backups', async () => store.state.backups);
  app.get('/api/services/:id/backups', async request => { const service = serviceById(parameter(request)); return store.state.backups.filter(item => item.serviceId === service.id); });
  function queueBackup(serviceId: string, scheduleId?: string): Backup & { scheduleId?: string } {
    store.assertWritable();
    const service = serviceById(id.parse(serviceId)); requireIdle(service.id); if (service.status !== 'running') throw new HttpError(409, 'Start the service before creating a backup.');
    if (service.kind === 'compose' || service.kind === 'app' && !service.mounts.length) throw new HttpError(400, 'Backups require a database service or application volumes.');
    const backupId = randomUUID(), extension = mode === 'demo' ? 'demo.txt' : ['postgres', 'mysql', 'mariadb'].includes(service.kind) ? 'sql' : service.kind === 'mongo' ? 'archive.gz' : 'tar.gz';
    const backup: Backup & { scheduleId?: string } = { id: backupId, serviceId: service.id, status: 'running', createdAt: now(), sizeBytes: 0, filename: `${service.name}-${backupId}.${extension}`, ...(scheduleId ? { scheduleId } : {}) };
    store.state.backups.unshift(backup); store.save();
    void enqueue(service.id, async () => {
      const directory = join(dataDir, 'backups'), path = join(directory, backup.filename);
      try { await mkdir(directory, { recursive: true, mode: 0o700 }); await driver.backup(structuredClone(service), path); backup.sizeBytes = (await stat(path)).size; if (!backup.sizeBytes) throw new Error('Backup output is empty.'); backup.status = 'success'; store.activity('Backup completed', service.name); }
      catch (error) { backup.status = 'failed'; backup.error = redact(service, (error as Error).message); await rm(path, { force: true }); store.activity('Backup failed', service.name); }
      finally { store.save(); }
    });
    return backup;
  }
  app.post('/api/services/:id/backups', async (request, reply) => reply.status(202).send(queueBackup(parameter(request))));
  const scheduler = registerBackupSchedules(app, {
    listSchedules: () => store.state.backupSchedules,
    saveSchedules: schedules => { store.state.backupSchedules = schedules; store.save(); },
    getService: serviceId => store.state.services.find(service => service.id === serviceId),
    getBackups: () => store.state.backups,
    queueBackup,
    forgetBackup: backupId => { store.state.backups = store.state.backups.filter(backup => backup.id !== backupId); store.save(); },
    backupDirectory: join(dataDir, 'backups')
  });
  app.get('/api/backups/:id/download', async (request, reply) => { const backup = store.state.backups.find(item => item.id === parameter(request)); if (!backup || backup.status !== 'success') throw new HttpError(404, 'Completed backup not found.'); const path = join(dataDir, 'backups', backup.filename); if (!existsSync(path)) throw new HttpError(404, 'Backup file is missing.'); return reply.header('Content-Type', 'application/octet-stream').header('Content-Disposition', `attachment; filename="${backup.filename}"`).send(createReadStream(path)); });
  app.get('/api/templates', async () => templates);
  app.post('/api/templates/:id/install', async (request, reply) => { const template = templates.find(item => item.id === (request.params as { id: string }).id); if (!template) throw new HttpError(404, 'Template not found.'); const input = z.object({ projectId: id, name: z.string() }).strict().parse(request.body); return reply.status(201).send(newService(serviceCreate.parse({ ...input, kind: template.kind, source: { type: 'image', image: template.image }, env: template.env, mounts: template.mounts }), template.port)); });
  app.get('/api/activity', async () => store.state.activity);
  app.get('/api/settings', async () => store.state.settings);
  app.patch('/api/settings', async request => { const input = settingsInput.parse(request.body); Object.assign(store.state.settings, input); store.activity('Settings updated', 'Server'); store.save(); return store.state.settings; });
  const staticDir = options.staticDir || resolve('dist/client');
  if (existsSync(join(staticDir, 'index.html'))) {
    await app.register(staticFiles, { root: staticDir, prefix: '/' });
    app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.status(404).send({ error: 'API route not found.' }) : reply.type('text/html').sendFile('index.html'));
  } else app.setNotFoundHandler((_request, reply) => reply.status(404).send({ error: 'Route not found.' }));
  app.addHook('onClose', async () => { await scheduler.stop(); await Promise.allSettled([...jobs]); try { store.save(); } finally { store.close(); } });
  return app;
}
