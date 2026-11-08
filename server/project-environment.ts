import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Service } from '../shared/types.js';
import { effectiveServiceEnvironment, environmentValueError } from '../shared/environment.js';

export const environmentInput = z.unknown().transform((value, ctx): Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    ctx.addIssue({ code: 'custom', message: 'Expected a map of environment variable names and string values.' });
    return z.NEVER;
  }
  const entries = Object.entries(value);
  if (entries.length > 200) ctx.addIssue({ code: 'custom', message: 'Use at most 200 variables.' });
  for (const [key, item] of entries) {
    const message = typeof item === 'string' ? environmentValueError(key, item) : 'Environment values must be strings.';
    if (message) ctx.addIssue({ code: 'custom', path: [key], message });
  }
  // Define only the validated own entries; never inherit environment keys.
  return Object.fromEntries(entries) as Record<string, string>;
});

export interface ProjectEnvironmentDependencies {
  getProject(projectId: string): { id: string } | undefined;
  getService(serviceId: string): Service | undefined;
  getEnvironment(projectId: string): Record<string, string> | undefined;
  /** Check idle project services, mark changed effective configurations and save atomically. */
  setEnvironment(projectId: string, env: Record<string, string>): void;
  /** All environment endpoints require operator authority, including reads. */
  authorizeProject(request: FastifyRequest, projectId: string): void | Promise<void>;
  authorizeService(request: FastifyRequest, serviceId: string): void | Promise<void>;
}

export function registerProjectEnvironment(app: FastifyInstance, dependencies: ProjectEnvironmentDependencies) {
  const parameter = (request: FastifyRequest) => z.string().uuid().parse((request.params as { id: string }).id);
  const missing = () => Object.assign(new Error('Project or service not found.'), { statusCode: 404 });
  const path = '/api/projects/:id/environment';
  app.get(path, async request => {
    const projectId = parameter(request);
    await dependencies.authorizeProject(request, projectId);
    if (!dependencies.getProject(projectId)) throw missing();
    return { env: dependencies.getEnvironment(projectId) || {} };
  });
  app.put(path, async request => {
    const projectId = parameter(request);
    await dependencies.authorizeProject(request, projectId);
    if (!dependencies.getProject(projectId)) throw missing();
    const { env } = z.object({ env: environmentInput }).strict().parse(request.body);
    dependencies.setEnvironment(projectId, env);
    return { env };
  });
  app.get('/api/services/:id/environment', async request => {
    const serviceId = parameter(request);
    await dependencies.authorizeService(request, serviceId);
    const service = dependencies.getService(serviceId);
    if (!service) throw missing();
    const inherited = dependencies.getEnvironment(service.projectId) || {};
    return { inherited, overrides: service.env, effective: effectiveServiceEnvironment(service, inherited) };
  });
}
