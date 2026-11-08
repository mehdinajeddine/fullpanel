import { hash } from 'bcryptjs';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Service } from '../shared/types.js';
import type { ProxyAuthCredential, ProxyAuthStatus } from '../shared/proxy.js';

export interface ProxyAuthDependencies {
  getService(serviceId: string): Service | undefined;
  authorize(request: FastifyRequest, serviceId: string, permission: 'read' | 'write'): void | Promise<void>;
  getAuth(serviceId: string, domainId: string): ProxyAuthCredential | undefined;
  /** Persist atomically, mark service.updatedAt and record activity, without logging credentials. */
  setAuth(serviceId: string, domainId: string, credential: ProxyAuthCredential | null): void;
}

const params = z.object({ id: z.string().uuid(), domainId: z.string().uuid() });
const input = z.object({
  username: z.string().regex(/^[a-zA-Z0-9_.@-]{1,64}$/, 'Use 1–64 letters, numbers, dots, hyphens, @ or underscores.'),
  password: z.string().min(12).max(72).refine(value => Buffer.byteLength(value, 'utf8') <= 72 && !value.includes('\0'), 'Use at most 72 UTF-8 bytes without null characters.'),
}).strict();

export function registerProxyAuth(app: FastifyInstance, dependencies: ProxyAuthDependencies) {
  function requireRoute(serviceId: string, domainId: string) {
    const service = dependencies.getService(serviceId);
    if (!service || !service.domains.some(domain => domain.id === domainId)) throw Object.assign(new Error('Domain route not found.'), { statusCode: 404 });
    if (service.kind === 'compose') throw Object.assign(new Error('Proxy authentication is not available for Compose routes.'), { statusCode: 400 });
  }
  function status(serviceId: string, domainId: string): ProxyAuthStatus {
    const credential = dependencies.getAuth(serviceId, domainId);
    return credential ? { enabled: true, username: credential.username } : { enabled: false };
  }
  const path = '/api/services/:id/domains/:domainId/auth';
  app.get(path, async request => {
    const { id, domainId } = params.parse(request.params);
    await dependencies.authorize(request, id, 'read');
    requireRoute(id, domainId);
    return status(id, domainId);
  });
  app.put(path, { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => {
    const { id, domainId } = params.parse(request.params);
    await dependencies.authorize(request, id, 'write');
    requireRoute(id, domainId);
    const credentials = input.parse(request.body);
    const passwordHash = await hash(credentials.password, 12);
    // Hashing yields to the event loop: reject a concurrently deleted route or revoked access.
    await dependencies.authorize(request, id, 'write');
    requireRoute(id, domainId);
    dependencies.setAuth(id, domainId, { username: credentials.username, passwordHash });
    return status(id, domainId);
  });
  app.delete(path, async request => {
    const { id, domainId } = params.parse(request.params);
    await dependencies.authorize(request, id, 'write');
    requireRoute(id, domainId);
    dependencies.setAuth(id, domainId, null);
    return status(id, domainId);
  });
}
