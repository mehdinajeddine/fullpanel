import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Service, SourceCredentialStatus } from '../shared/types.js';
import { generateSshKeyPair, isSshRepository, parseSshRepository, validateSshKnownHosts, withSshSourceCredentials, isolatedGitEnvironment, type GitSshCredential } from './git-ssh.js';
export type { GitSshCredential } from './git-ssh.js';

export interface GitSourceCredential { serviceId: string; repository: string; username: string; token: string; updatedAt: string }
export interface RegistrySourceCredential { serviceId: string; registry: string; imageRepository: string; username: string; password: string; updatedAt: string }
/** Private encrypted-store data. Never merge these properties into the public Service model. */
export interface ServiceSourceCredentials { git?: GitSourceCredential; ssh?: GitSshCredential; registry?: RegistrySourceCredential }
export type DeploymentSourceCredentials = ServiceSourceCredentials;
export interface SourceCredentialDependencies {
  getService(serviceId: string): Service | undefined;
  getCredentials(serviceId: string): ServiceSourceCredentials | undefined;
  setCredentials(serviceId: string, value: ServiceSourceCredentials): void;
  authorize(request: FastifyRequest, serviceId: string, access: 'read' | 'write'): void | Promise<void>;
  requireIdle?(serviceId: string): void;
  credentialsDirectory?: string;
}
export interface CredentialCommandOptions { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv; input?: string }
export type CredentialCommand = (binary: string, args: string[], options?: CredentialCommandOptions) => Promise<string>;
const identifier = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const username = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.@+\-]*$/, 'Use a registry or Git account username.');
const secret = z.string().min(1).max(16000).refine(value => !/[\r\n\0]/.test(value), 'Credential must be a single line.');
const gitInput = z.object({ username, token: secret }).strict();
const registryInput = z.object({ username, password: secret }).strict();
function fail(statusCode: number, message: string) { return Object.assign(new Error(message), { statusCode }); }

export function normalizeGitRepository(repository: string): string {
  if (isSshRepository(repository)) return parseSshRepository(repository).repository;
  let url: URL;
  try { url = new URL(repository); } catch { throw fail(400, 'Save a valid HTTPS repository URL first.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.hostname || url.pathname === '/' || /[\r\n\0\\]/.test(repository) || /%(?:2f|5c|00)/i.test(url.pathname)) throw fail(400, 'Git credentials require an exact HTTPS repository URL without credentials, query or fragment.');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}

export function registryScopeForImage(image: string): { registry: string; imageRepository: string } {
  if (!image || image.length > 300 || image.includes('://') || /[\s\\]/.test(image)) throw fail(400, 'Save a valid Docker image reference first.');
  const digestParts = image.split('@');
  if (digestParts.length > 2 || digestParts[1] && !/^sha256:[a-fA-F0-9]{64}$/.test(digestParts[1])) throw fail(400, 'Use a Docker image tag or a sha256 digest.');
  let reference = digestParts[0];
  const colon = reference.lastIndexOf(':');
  if (colon > reference.lastIndexOf('/')) {
    const tag = reference.slice(colon + 1);
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) throw fail(400, 'Invalid Docker image tag.');
    reference = reference.slice(0, colon);
  }
  const parts = reference.split('/');
  let registry = 'docker.io';
  if (parts.length > 1 && (/[.:]/.test(parts[0]) || parts[0] === 'localhost')) registry = parts.shift()!.toLowerCase();
  if (['index.docker.io', 'registry-1.docker.io'].includes(registry)) registry = 'docker.io';
  const [host, port, extra] = registry.split(':');
  if (extra !== undefined || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(host) || port !== undefined && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) throw fail(400, 'Invalid Docker registry host or port.');
  if (registry === 'docker.io' && parts.length === 1) parts.unshift('library');
  if (!parts.length || parts.some(part => !/^[a-z0-9]+(?:[._-]+[a-z0-9]+)*$/.test(part))) throw fail(400, 'Docker repository names must be lowercase path components.');
  return { registry, imageRepository: `${registry}/${parts.join('/')}` };
}

export function pruneSourceCredentials(service: Service, credentials: ServiceSourceCredentials = {}): ServiceSourceCredentials {
  try {
    if (service.source.type === 'git') {
      const repository = normalizeGitRepository(service.source.repository || '');
      if (isSshRepository(repository) && credentials.ssh?.serviceId === service.id && credentials.ssh.repository === repository) return { ssh: credentials.ssh };
      if (!isSshRepository(repository) && credentials.git?.serviceId === service.id && credentials.git.repository === repository) return { git: credentials.git };
    }
    if (service.kind !== 'compose' && service.source.type === 'image' && credentials.registry?.serviceId === service.id) {
      const scope = registryScopeForImage(service.source.image || '');
      if (credentials.registry.registry === scope.registry && credentials.registry.imageRepository === scope.imageRepository) return { registry: credentials.registry };
    }
  } catch { /* An invalid or changed source can never retain an old credential. */ }
  return {};
}

export function resolveSourceCredentials(service: Service, credentials: ServiceSourceCredentials = {}): DeploymentSourceCredentials {
  const scoped = pruneSourceCredentials(service, credentials);
  if (credentials.git && !scoped.git || credentials.ssh && !scoped.ssh || credentials.registry && !scoped.registry) throw fail(409, 'Source credentials no longer match this service source. Save new credentials before deployment.');
  return structuredClone(scoped);
}

export function sourceCredentialSecrets(credentials: ServiceSourceCredentials = {}): string[] {
  const values: string[] = [];
  for (const item of [credentials.git && { username: credentials.git.username, value: credentials.git.token }, credentials.registry && { username: credentials.registry.username, value: credentials.registry.password }]) {
    if (item) values.push(item.value, encodeURIComponent(item.value), Buffer.from(`${item.username}:${item.value}`).toString('base64'));
  }
  if (credentials.ssh) {
    const key = credentials.ssh.privateKey;
    values.push(key, key.trim(), Buffer.from(key).toString('base64'));
    const lines = key.split(/\r?\n/).filter(line => /^[A-Za-z0-9+/=]{32,}$/.test(line));
    values.push(...lines, lines.join(''));
  }
  return [...new Set(values.filter(Boolean))].sort((a, b) => b.length - a.length);
}

export function redactSourceCredentials(text: string, credentials: ServiceSourceCredentials): string {
  return sourceCredentialSecrets(credentials).reduce((value, current) => value.split(current).join('[REDACTED]'), text);
}

function status(service: Service, stored: ServiceSourceCredentials = {}): SourceCredentialStatus {
  const credentials = pruneSourceCredentials(service, stored);
  return {
    git: credentials.git ? { configured: true, repository: credentials.git.repository, username: credentials.git.username, updatedAt: credentials.git.updatedAt } : { configured: false },
    ssh: credentials.ssh ? { configured: true, repository: credentials.ssh.repository, publicKey: credentials.ssh.publicKey, fingerprint: credentials.ssh.fingerprint, knownHosts: credentials.ssh.knownHosts, hostKeyConfigured: !!credentials.ssh.knownHosts, hostFingerprints: credentials.ssh.hostFingerprints || [], updatedAt: credentials.ssh.updatedAt, hostKeyUpdatedAt: credentials.ssh.hostKeyUpdatedAt } : { configured: false },
    registry: credentials.registry ? { configured: true, registry: credentials.registry.registry, imageRepository: credentials.registry.imageRepository, username: credentials.registry.username, updatedAt: credentials.registry.updatedAt } : { configured: false },
    capabilities: { gitHttps: true, gitSsh: true, registryImages: true, registryBuilds: false }
  };
}

export function registerSourceCredentials(app: FastifyInstance, dependencies: SourceCredentialDependencies) {
  async function context(request: FastifyRequest, access: 'read' | 'write') {
    const serviceId = (request.params as { id?: string }).id;
    if (!serviceId || !identifier.test(serviceId)) throw fail(400, 'Invalid service identifier.');
    await dependencies.authorize(request, serviceId, access);
    const service = dependencies.getService(serviceId);
    if (!service) throw fail(404, 'Service not found.');
    if (access === 'write') dependencies.requireIdle?.(serviceId);
    return { service, stored: dependencies.getCredentials(serviceId) || {} };
  }
  app.get('/api/services/:id/source-credentials', async request => {
    const { service, stored } = await context(request, 'read');
    return status(service, stored);
  });
  app.put('/api/services/:id/source-credentials/git', async request => {
    const { service, stored } = await context(request, 'write');
    if (service.source.type !== 'git' || isSshRepository(service.source.repository || '')) throw fail(400, 'Save an HTTPS Git source before configuring its token.');
    const input = gitInput.parse(request.body);
    const next = { ...pruneSourceCredentials(service, stored), git: { ...input, serviceId: service.id, repository: normalizeGitRepository(service.source.repository || ''), updatedAt: new Date().toISOString() } };
    dependencies.setCredentials(service.id, next);
    return status(service, next);
  });
  function sshScope(service: Service): string {
    if (service.source.type !== 'git' || !isSshRepository(service.source.repository || '')) throw fail(400, 'Save an SSH Git repository before configuring its deploy key.');
    return parseSshRepository(service.source.repository!).repository;
  }
  async function unchanged(request: FastifyRequest, repository: string, previous: string) {
    // Key generation/validation yields. Recheck current authority, busy state, source and credential revision.
    const current = await context(request, 'write');
    if (sshScope(current.service) !== repository || JSON.stringify(current.stored) !== previous) throw fail(409, 'The source or credentials changed. Reload and try again.');
    return current;
  }
  app.post('/api/services/:id/source-credentials/ssh/rotate', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => {
    const { service, stored } = await context(request, 'write');
    z.object({}).strict().parse(request.body || {});
    const repository = sshScope(service), previous = JSON.stringify(stored);
    const generated = await generateSshKeyPair(service.id, dependencies.credentialsDirectory);
    const current = await unchanged(request, repository, previous);
    const old = pruneSourceCredentials(current.service, current.stored).ssh;
    const next: ServiceSourceCredentials = { ssh: { ...generated, serviceId: service.id, repository, updatedAt: new Date().toISOString(), ...(old?.knownHosts ? { knownHosts: old.knownHosts, hostFingerprints: old.hostFingerprints, hostKeyUpdatedAt: old.hostKeyUpdatedAt } : {}) } };
    dependencies.setCredentials(service.id, next);
    return status(current.service, next);
  });
  app.put('/api/services/:id/source-credentials/ssh/host-key', async request => {
    const { service, stored } = await context(request, 'write');
    const input = z.object({ knownHosts: z.string().min(1).max(16000) }).strict().parse(request.body);
    const repository = sshScope(service), previous = JSON.stringify(stored);
    if (!pruneSourceCredentials(service, stored).ssh) throw fail(409, 'Generate a deploy key before saving its server key.');
    const trust = await validateSshKnownHosts(repository, input.knownHosts);
    const current = await unchanged(request, repository, previous);
    const next: ServiceSourceCredentials = { ssh: { ...current.stored.ssh!, ...trust, hostKeyUpdatedAt: new Date().toISOString() } };
    dependencies.setCredentials(service.id, next);
    return status(current.service, next);
  });
  app.put('/api/services/:id/source-credentials/registry', async request => {
    const { service, stored } = await context(request, 'write');
    if (service.kind === 'compose' || service.source.type !== 'image') throw fail(400, 'Registry credentials currently support image sources only. Private build bases and Compose registry credentials are not supported.');
    const input = registryInput.parse(request.body);
    const scope = registryScopeForImage(service.source.image || '');
    const next = { ...pruneSourceCredentials(service, stored), registry: { ...input, ...scope, serviceId: service.id, updatedAt: new Date().toISOString() } };
    dependencies.setCredentials(service.id, next);
    return status(service, next);
  });
  for (const kind of ['git', 'ssh', 'registry'] as const) app.delete(`/api/services/:id/source-credentials/${kind}`, async request => {
    const { service, stored } = await context(request, 'write');
    const next = { ...stored }; delete next[kind];
    dependencies.setCredentials(service.id, next);
    return status(service, next);
  });
}

const askpassProgram = `#!/usr/bin/env node
'use strict';
try {
  const match = /^(Username|Password) for '([^']+)':\\s*$/.exec(process.argv[2] || '');
  if (!match || !process.env.HL_GIT_TOKEN) process.exit(1);
  const requested = new URL(match[2]);
  const expected = new URL(process.env.HL_GIT_REPOSITORY);
  if (requested.origin !== expected.origin || requested.pathname !== expected.pathname || requested.password || requested.search || requested.hash || requested.username && decodeURIComponent(requested.username) !== process.env.HL_GIT_USERNAME) process.exit(1);
  process.stdout.write(match[1] === 'Username' ? process.env.HL_GIT_USERNAME : process.env.HL_GIT_TOKEN);
} catch { process.exit(1); }
`;

/** Credentials exist only in the clone child environment; cleanup finishes before the build. */
export async function withGitSourceCredentials<T>(repository: string, credential: GitSourceCredential | GitSshCredential | undefined, callback: (context: { repository: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }) => Promise<T>, baseEnv = process.env, credentialsDirectory?: string): Promise<T> {
  const scope = normalizeGitRepository(repository);
  if (credential && credential.repository !== scope) throw fail(409, 'Git credential scope does not match the repository.');
  if (isSshRepository(scope)) {
    if (credential && !('privateKey' in credential)) throw fail(409, 'An HTTPS token cannot authenticate an SSH repository.');
    try { return await withSshSourceCredentials(scope, credential, callback, baseEnv, credentialsDirectory); }
    catch (error) { throw Object.assign(new Error(redactSourceCredentials(error instanceof Error ? error.message : String(error), credential ? { ssh: credential } : {})), { statusCode: (error as { statusCode?: number }).statusCode }); }
  }
  if (credential && 'privateKey' in credential) throw fail(409, 'An SSH key cannot authenticate an HTTPS repository.');
  const directory = await mkdtemp(join(tmpdir(), 'harborlight-git-auth-')); await chmod(directory, 0o700);
  const askpass = join(directory, 'askpass.cjs');
  try {
    await writeFile(askpass, askpassProgram, { mode: 0o700, flag: 'wx' });
    const templates = join(directory, 'templates'); await mkdir(templates, { mode: 0o700 });
    const env = { ...isolatedGitEnvironment(baseEnv), GIT_ASKPASS: askpass, GIT_TEMPLATE_DIR: templates };
    const target = new URL(scope);
    if (credential) {
      Object.assign(env, { HL_GIT_REPOSITORY: scope, HL_GIT_USERNAME: credential.username, HL_GIT_TOKEN: credential.token });
      // Providing the username asks Git to obtain its password before the authenticated request.
      // The public source remains credential-free; the transient URL contains no password/token.
      target.username = credential.username;
    }
    const args = ['-c', 'credential.helper=', '-c', 'credential.useHttpPath=true', '-c', 'http.followRedirects=false', '-c', 'http.sslVerify=true', '-c', 'http.extraHeader=', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always'];
    return await callback({ repository: target.toString(), args, env, cwd: directory });
  } catch (error) {
    throw new Error(redactSourceCredentials(error instanceof Error ? error.message : String(error), credential ? { git: credential } : {}));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function isolatedDockerEnvironment(run: CredentialCommand, configDirectory: string, base: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  let host = base.DOCKER_HOST;
  if (!host || base.DOCKER_CONTEXT) {
    const inspected = JSON.parse(await run('docker', ['context', 'inspect'], { env: base, timeout: 15000 }));
    host = inspected[0]?.Endpoints?.docker?.Host;
  }
  if (!host || !host.startsWith('unix://')) throw new Error('Credential-isolated deployments currently require a local Docker Unix socket context.');
  const env: NodeJS.ProcessEnv = { ...base, DOCKER_HOST: host, DOCKER_CONFIG: configDirectory };
  for (const key of ['DOCKER_CONTEXT', 'DOCKER_AUTH_CONFIG', 'DOCKER_CUSTOM_HEADERS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'HL_GIT_TOKEN', 'HL_GIT_USERNAME', 'HL_GIT_REPOSITORY']) delete env[key];
  return env;
}

async function dockerPluginDirectories(base: NodeJS.ProcessEnv): Promise<string[]> {
  const originalDirectory = resolve(base.DOCKER_CONFIG || join(homedir(), '.docker'));
  const directories = [join(originalDirectory, 'cli-plugins')];
  try {
    // Copy only plugin search locations: no auths, credential helpers, headers or proxies.
    const original: unknown = JSON.parse(await readFile(join(originalDirectory, 'config.json'), 'utf8'));
    const extra = original && typeof original === 'object' && 'cliPluginsExtraDirs' in original ? original.cliPluginsExtraDirs : undefined;
    if (Array.isArray(extra)) for (const path of extra.slice(0, 32)) if (typeof path === 'string' && path.length < 4096 && !path.includes('\0') && isAbsolute(path)) directories.push(path);
  } catch { /* A missing/malformed ambient config must not introduce authentication fallback. */ }
  return [...new Set(directories)];
}

/** Uses a throwaway config, preventing ambient registry credentials or native keychain writes. */
export async function withDockerSourceCredentials<T>(image: string | undefined, credential: RegistrySourceCredential | undefined, run: CredentialCommand, callback: (env: NodeJS.ProcessEnv) => Promise<T>, baseEnv = process.env): Promise<T> {
  if (credential) {
    if (!image) throw fail(400, 'Private registry credentials are supported for image sources only.');
    const scope = registryScopeForImage(image);
    if (credential.registry !== scope.registry || credential.imageRepository !== scope.imageRepository) throw fail(409, 'Registry credential scope does not match the image repository.');
  }
  const directory = await mkdtemp(join(tmpdir(), 'harborlight-docker-auth-')); await chmod(directory, 0o700);
  const filename = join(directory, 'config.json');
  try {
    // A nonempty auth map suppresses Docker CLI's automatic native credential-store detection.
    const key = credential?.registry === 'docker.io' ? 'https://index.docker.io/v1/' : credential?.registry || 'harborlight.invalid';
    await writeFile(filename, JSON.stringify({ auths: { [key]: {} }, cliPluginsExtraDirs: await dockerPluginDirectories(baseEnv) }), { mode: 0o600, flag: 'wx' });
    const env = await isolatedDockerEnvironment(run, directory, baseEnv);
    if (credential) {
      await run('docker', ['login', '--username', credential.username, '--password-stdin', credential.registry], { env, input: `${credential.password}\n`, timeout: 60000 });
      await chmod(filename, 0o600);
    }
    return await callback(env);
  } catch (error) {
    throw new Error(redactSourceCredentials(error instanceof Error ? error.message : String(error), credential ? { registry: credential } : {}));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
