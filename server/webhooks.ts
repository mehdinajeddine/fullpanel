import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Deployment } from '../shared/types.js';

export interface DeploymentWebhookDependencies {
  /** The caller supplies authenticated admin routes; only the exact POST hook is public. */
  getService(serviceId: string): { id: string } | undefined;
  getTokenHash(serviceId: string): string | undefined;
  /** Persist synchronously before returning; a null value revokes the credential. */
  setTokenHash(serviceId: string, hash: string | null): void;
  /** Reuse the same authorization-independent queue and concurrency lock as manual deploy. */
  enqueueDeploy(serviceId: string, trigger: string): Deployment | Promise<Deployment>;
  publicUrl?: string;
}

export interface DeploymentTriggerStatus {
  enabled: boolean;
  endpoint: string;
  method: 'POST';
  authorization: 'Bearer';
  tokenVisibleOnce: true;
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const digest = (token: string) => createHash('sha256').update(token).digest();
function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

function parameter(request: FastifyRequest) {
  const value = (request.params as { id?: unknown }).id;
  if (typeof value !== 'string' || !uuid.test(value)) throw httpError(400, 'Invalid service identifier.');
  return value;
}

/**
 * Register scoped deployment credentials. No raw token is stored or accepted in a URL.
 * The host application must register @fastify/rate-limit and keep the three management
 * routes protected by its ordinary session authentication hook.
 */
export function registerDeploymentWebhooks(app: FastifyInstance, dependencies: DeploymentWebhookDependencies) {
  let origin: string | undefined;
  if (dependencies.publicUrl) {
    const parsed = new URL(dependencies.publicUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Webhook public URL must be an HTTP(S) URL without credentials.');
    origin = parsed.origin;
  }

  function status(serviceId: string): DeploymentTriggerStatus {
    return {
      enabled: !!dependencies.getTokenHash(serviceId),
      endpoint: `${origin || ''}/api/hooks/deploy/${serviceId}`,
      method: 'POST',
      authorization: 'Bearer',
      tokenVisibleOnce: true
    };
  }

  function requireService(serviceId: string) {
    if (!dependencies.getService(serviceId)) throw httpError(404, 'Service not found.');
  }

  app.get('/api/services/:id/trigger', async request => {
    const serviceId = parameter(request);
    requireService(serviceId);
    return status(serviceId);
  });

  app.post('/api/services/:id/trigger/rotate', async (request, reply) => {
    const serviceId = parameter(request);
    requireService(serviceId);
    const token = randomBytes(32).toString('base64url');
    dependencies.setTokenHash(serviceId, digest(token).toString('hex'));
    reply.header('Cache-Control', 'no-store');
    return { ...status(serviceId), token };
  });

  app.delete('/api/services/:id/trigger', async request => {
    const serviceId = parameter(request);
    requireService(serviceId);
    dependencies.setTokenHash(serviceId, null);
    return status(serviceId);
  });

  app.post('/api/hooks/deploy/:id', {
    bodyLimit: 16 * 1024,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } }
  }, async (request, reply) => {
    const serviceId = parameter(request);
    // A fixed-format token prevents ambiguous/multiple Authorization header parsing.
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(request.headers.authorization || '');
    const supplied = digest(match?.[1] || '');
    const stored = dependencies.getTokenHash(serviceId);
    const expected = stored && /^[a-f0-9]{64}$/.test(stored) ? Buffer.from(stored, 'hex') : Buffer.alloc(32);
    const valid = timingSafeEqual(supplied, expected) && !!match && !!stored;
    if (!valid) throw httpError(401, 'Invalid or revoked deployment token.');
    // Reject orphaned credentials even if a service was deleted outside the normal API.
    try {
      if (!dependencies.getService(serviceId)) throw new Error('Missing service');
    } catch {
      throw httpError(401, 'Invalid or revoked deployment token.');
    }
    const deployment = await dependencies.enqueueDeploy(serviceId, 'Webhook');
    return reply.status(202).send(deployment);
  });
}
