import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile, rm, statfs, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { cpus, freemem, totalmem, uptime } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'yaml';
import type { Service, Metrics, ServiceStatus } from '../shared/types.js';

const LABEL = 'io.harborlight.managed';
const SERVICE_LABEL = 'io.harborlight.service';
export type Output = (chunk: string) => void;
export interface DeployOptions { forceRebuild?: boolean }
export interface RuntimeDriver {
  deploy(service: Service, output: Output, options?: DeployOptions): Promise<{ containerId?: string; image?: string; commit?: string }>;
  action(service: Service, action: 'start' | 'stop' | 'restart'): Promise<void>;
  remove(service: Service): Promise<void>;
  logs(service: Service, tail: number): Promise<string>;
  metrics(): Promise<Metrics>;
  statuses(): Promise<Record<string, ServiceStatus>>;
  backup(service: Service, filename: string): Promise<void>;
}

// Commands are always argument arrays, never interpolated shell commands.
export function command(binary: string, args: string[], options: { cwd?: string; output?: Output; timeout?: number; destination?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(binary, args, { cwd: options.cwd, env: options.env ?? process.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', stderr = '', settled = false, timedOut = false;
    const sink = options.destination ? createWriteStream(options.destination, { flags: 'wx', mode: 0o600 }) : undefined;
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolveCommand(output); };
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeout ?? 30000);
    sink?.on('error', error => { child.kill('SIGKILL'); finish(error); });
    if (sink) child.stdout.pipe(sink);
    else child.stdout.on('data', chunk => { const text = chunk.toString(); output = (output + text).slice(-2_000_000); options.output?.(text); });
    child.stderr.on('data', chunk => { const text = chunk.toString(); stderr = (stderr + text).slice(-20000); options.output?.(text); });
    child.on('error', finish);
    child.on('close', code => {
      if (code !== 0) { sink?.destroy(); finish(new Error(timedOut ? `${binary} operation timed out.` : `${binary} failed (${code}): ${stderr.trim().slice(-4000) || 'No error details.'}`)); }
      else if (sink && !sink.writableFinished) sink.once('finish', () => finish());
      else finish();
    });
  });
}

export class DockerDriver implements RuntimeDriver {
  constructor(readonly dataDir: string) {}
  private name(service: Service) { return `hl-${service.id}`; }
  private projectNetwork(service: Service) { return `hl-project-${service.projectId}`; }
  private volume(service: Service, name: string) { return `hl-${service.id}-${name}`; }
  private async ownedContainer(service: Service, optional = false): Promise<string | null> {
    try {
      const parsed = JSON.parse(await command('docker', ['container', 'inspect', this.name(service)]))[0];
      if (parsed.Config?.Labels?.[LABEL] !== 'true' || parsed.Config?.Labels?.[SERVICE_LABEL] !== service.id) throw new Error('Refusing to modify a container not owned by this service.');
      return parsed.Id;
    } catch (error) {
      if (optional && /No such (container|object)/i.test(String(error))) return null;
      throw error;
    }
  }
  private async network(service: Service) {
    const name = this.projectNetwork(service);
    try {
      const existing = JSON.parse(await command('docker', ['network', 'inspect', name]))[0];
      if (existing.Labels?.[LABEL] !== 'true' || existing.Labels?.['io.harborlight.project'] !== service.projectId) throw new Error('Network name belongs to an unmanaged resource.');
    } catch (error) {
      if (!/No such network|not found/i.test(String(error))) throw error;
      await command('docker', ['network', 'create', '--label', `${LABEL}=true`, '--label', `io.harborlight.project=${service.projectId}`, name]);
    }
  }
  private async ensureVolume(service: Service, name: string) {
    const volume = this.volume(service, name);
    try {
      const existing = JSON.parse(await command('docker', ['volume', 'inspect', volume]))[0];
      if (existing.Labels?.[SERVICE_LABEL] !== service.id || existing.Labels?.[LABEL] !== 'true') throw new Error('Volume name belongs to an unmanaged resource.');
    } catch (error) {
      if (!/No such volume|not found/i.test(String(error))) throw error;
      await command('docker', ['volume', 'create', '--label', `${LABEL}=true`, '--label', `${SERVICE_LABEL}=${service.id}`, volume]);
    }
  }
  async deploy(service: Service, output: Output, options: DeployOptions = {}) {
    for (const value of Object.values(service.env)) if (/[\r\n\0]/.test(value)) throw new Error('Docker environment values must be single-line. Encode multiline secrets before use.');
    if (service.domains.length) await command('docker', ['network', 'inspect', 'harborlight-proxy']);
    await this.network(service);
    if (service.kind === 'compose') return this.deployCompose(service, output);
    const work = join(this.dataDir, 'work', `${service.id}-${randomUUID()}`);
    await mkdir(work, { recursive: true, mode: 0o700 });
    let image = service.source.image;
    let commit: string | undefined;
    try {
      if (service.source.type === 'image') {
        if (!image) throw new Error('An image is required.');
        output(`Pulling ${image}\n`);
        await command('docker', ['pull', image], { output, timeout: 600000 });
      } else if (service.source.type === 'dockerfile' || service.source.type === 'git') {
        image = `harborlight/${service.id}:${Date.now()}`;
        let context = work, dockerfile = 'Dockerfile';
        if (service.source.type === 'git') {
          const repo = join(work, 'repo');
          output('Cloning source repository…\n');
          await command('git', ['-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', 'clone', '--depth', '1', '--single-branch', '--branch', service.source.branch || 'main', '--', service.source.repository!, repo], { timeout: 300000, output, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' } });
          commit = (await command('git', ['rev-parse', 'HEAD'], { cwd: repo })).trim();
          if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Git did not return a valid source commit.');
          output(`Source commit: ${commit}\n`);
          const repoReal = await realpath(repo);
          context = await realpath(resolve(repo, service.source.context || '.'));
          if (context !== repoReal && !context.startsWith(repoReal + sep)) throw new Error('Build context escapes repository.');
          dockerfile = service.source.dockerfile || 'Dockerfile';
          const dockerfileReal = await realpath(join(context, dockerfile));
          if (!dockerfileReal.startsWith(repoReal + sep)) throw new Error('Dockerfile escapes repository.');
        } else await writeFile(join(work, 'Dockerfile'), service.source.dockerfile!, { mode: 0o600 });
        output('Building image…\n');
        await command('docker', ['build', '--label', `${LABEL}=true`, ...(commit ? ['--label', `org.opencontainers.image.revision=${commit}`] : []), ...(options.forceRebuild ? ['--no-cache', '--pull'] : []), '-t', image, '-f', join(context, dockerfile), context], { output, timeout: 1800000 });
      } else throw new Error('Choose an image, Git repository or inline Dockerfile for this service.');
      for (const mount of service.mounts) await this.ensureVolume(service, mount.name);
      // Create the candidate and validate its networks before touching the previous runtime.
      const existing = await this.ownedContainer(service, true);
      const envFile = join(work, 'environment');
      await writeFile(envFile, Object.entries(service.env).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600 });
      const candidateName = `${this.name(service)}-candidate-${randomUUID().slice(0, 8)}`;
      const previousName = `${this.name(service)}-previous-${randomUUID().slice(0, 8)}`;
      const args = ['create', '--name', candidateName, '--label', `${LABEL}=true`, '--label', `${SERVICE_LABEL}=${service.id}`, '--label', `io.harborlight.project=${service.projectId}`, '--restart', 'unless-stopped', '--network', this.projectNetwork(service), '--network-alias', service.name, '--cpus', String(service.resources.cpu), '--memory', `${service.resources.memoryMb}m`, '--env-file', envFile];
      for (const mount of service.mounts) args.push('--mount', `type=volume,src=${this.volume(service, mount.name)},dst=${mount.mountPath}`);
      for (const port of service.ports) args.push('-p', `${port.published}:${port.target}/${port.protocol}`);
      args.push('--label', `traefik.enable=${service.domains.length > 0}`);
      if (service.domains.length) args.push('--label', 'traefik.docker.network=harborlight-proxy');
      for (const domain of service.domains) {
        const route = `hl-${service.id}-${domain.id}`;
        const rule = `Host(\`${domain.hostname}\`)${domain.path !== '/' ? ` && PathPrefix(\`${domain.path}\`)` : ''}`;
        args.push('--label', `traefik.http.routers.${route}.rule=${rule}`, '--label', `traefik.http.routers.${route}.entrypoints=${domain.https ? 'websecure' : 'web'}`, '--label', `traefik.http.routers.${route}.service=${route}`, '--label', `traefik.http.services.${route}.loadbalancer.server.port=${domain.port}`);
        if (domain.https) args.push('--label', `traefik.http.routers.${route}.tls=true`, '--label', `traefik.http.routers.${route}.tls.certresolver=letsencrypt`);
      }
      args.push(image!);
      if (service.kind === 'redis') args.push('sh', '-c', 'exec redis-server --appendonly yes --requirepass "$REDIS_PASSWORD"');
      const containerId = (await command('docker', args)).trim();
      let renamedPrevious = false, previousRunning = false;
      try {
        if (service.domains.length) await command('docker', ['network', 'connect', 'harborlight-proxy', containerId]);
        if (existing) {
          previousRunning = !!JSON.parse(await command('docker', ['container', 'inspect', existing]))[0].State.Running;
          output('Replacing previous container…\n');
          await command('docker', ['stop', existing], { timeout: 60000 });
          await command('docker', ['rename', existing, previousName]); renamedPrevious = true;
        }
        await command('docker', ['rename', containerId, this.name(service)]);
        await command('docker', ['start', containerId]);
        const inspected = JSON.parse(await command('docker', ['container', 'inspect', containerId]))[0];
        if (!inspected.State?.Running) throw new Error('Container exited immediately. Inspect its runtime logs.');
      } catch (error) {
        await command('docker', ['rm', '-f', containerId]).catch(() => {});
        if (existing) {
          if (renamedPrevious) await command('docker', ['rename', existing, this.name(service)]);
          if (previousRunning) await command('docker', ['start', existing]);
          output('Previous container restored after deployment failure.\n');
        }
        throw error;
      }
      if (existing) await command('docker', ['rm', existing]).catch(error => output(`Previous stopped container cleanup failed: ${(error as Error).message}\n`));
      output('Container started. Application readiness is not health-checked.\n');
      return { containerId, image, ...(commit ? { commit } : {}) };
    } finally { await rm(work, { recursive: true, force: true }); }
  }
  private composePath(service: Service) { return join(this.dataDir, 'compose', service.id, 'compose.yaml'); }
  private composeArgs(service: Service) { return ['compose', '-p', `hl-${service.id}`, '-f', this.composePath(service)]; }
  private async deployCompose(service: Service, output: Output) {
    const config = sanitizeCompose(service);
    const ids = (await command('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=hl-${service.id}`])).trim();
    if (ids) await this.assertComposeOwnership(service);
    for (const name of Object.keys((config.volumes || {}) as object)) await this.ensureVolume(service, name);
    await mkdir(join(this.dataDir, 'compose', service.id), { recursive: true, mode: 0o700 });
    await writeFile(this.composePath(service), stringify(config), { mode: 0o600 });
    await command('docker', [...this.composeArgs(service), 'up', '-d', '--remove-orphans'], { timeout: 900000, output });
    const statuses = await this.statuses();
    if (statuses[service.id] !== 'running') throw new Error('Compose containers are not all running. Check runtime logs.');
    return { image: 'Docker Compose' };
  }
  async action(service: Service, action: 'start' | 'stop' | 'restart') {
    if (service.kind === 'compose') { await this.assertComposeOwnership(service); await command('docker', [...this.composeArgs(service), action]); return; }
    const container = await this.ownedContainer(service); await command('docker', [action, container!]);
  }
  private async assertComposeOwnership(service: Service) {
    const ids = (await command('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=hl-${service.id}`])).trim().split('\n').filter(Boolean);
    if (!ids.length) throw new Error('Compose service has not been deployed.');
    for (const container of JSON.parse(await command('docker', ['inspect', ...ids]))) if (container.Config?.Labels?.[LABEL] !== 'true' || container.Config?.Labels?.[SERVICE_LABEL] !== service.id) throw new Error('Refusing to operate on unmanaged Compose containers.');
  }
  async remove(service: Service) {
    if (service.kind === 'compose') {
      const ids = (await command('docker', ['ps', '-aq', '--filter', `label=${SERVICE_LABEL}=${service.id}`])).trim();
      if (ids) { await this.assertComposeOwnership(service); await command('docker', [...this.composeArgs(service), 'down']); }
      return;
    }
    const container = await this.ownedContainer(service, true);
    if (container) await command('docker', ['rm', '-f', container]);
  }
  async logs(service: Service, tail: number) {
    if (service.kind === 'compose') { await this.assertComposeOwnership(service); return command('docker', [...this.composeArgs(service), 'logs', '--no-color', '--tail', String(tail)]); }
    const container = await this.ownedContainer(service);
    let logs = '';
    await command('docker', ['logs', '--timestamps', '--tail', String(tail), container!], { output: chunk => { logs += chunk; } });
    return logs;
  }
  async statuses() {
    const output = await command('docker', ['ps', '-a', '--filter', `label=${LABEL}=true`, '--format', '{{json .}}']);
    const result: Record<string, ServiceStatus> = {};
    for (const line of output.trim().split('\n').filter(Boolean)) {
      const item = JSON.parse(line), labels = Object.fromEntries(item.Labels.split(',').map((pair: string) => pair.split('=')));
      const serviceId = labels[SERVICE_LABEL];
      if (!serviceId) continue;
      const status = item.State === 'running' ? 'running' : item.State === 'exited' || item.State === 'created' ? 'stopped' : 'failed';
      if (!result[serviceId] || result[serviceId] === 'running') result[serviceId] = status;
    }
    return result;
  }
  async metrics(): Promise<Metrics> {
    const base: Metrics = { mode: 'docker', cpuPercent: null, memoryUsedBytes: totalmem() - freemem(), memoryTotalBytes: totalmem(), diskUsedBytes: null, diskTotalBytes: null, uptime: uptime(), dockerVersion: null, containersRunning: 0 };
    try {
      const fs = await statfs(this.dataDir); base.diskTotalBytes = fs.blocks * fs.bsize; base.diskUsedBytes = (fs.blocks - fs.bfree) * fs.bsize;
      const info = JSON.parse(await command('docker', ['info', '--format', '{{json .}}']));
      base.dockerVersion = info.ServerVersion;
      const stats = (await command('docker', ['stats', '--no-stream', '--format', '{{json .}}'], { timeout: 15000 })).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      base.containersRunning = info.ContainersRunning;
      base.cpuPercent = Math.min(100, stats.reduce((sum, stat) => sum + (parseFloat(stat.CPUPerc) || 0), 0) / (info.NCPU || cpus().length || 1));
    } catch (error) { base.error = String(error instanceof Error ? error.message : error).slice(0, 1000); }
    return base;
  }
  async backup(service: Service, destination: string) {
    if (service.kind === 'compose') throw new Error('Compose backup is not supported. Back up each database using its native tools.');
    const container = await this.ownedContainer(service);
    let args: string[];
    if (service.kind === 'postgres') args = ['exec', container!, 'pg_dumpall', '-U', service.env.POSTGRES_USER || 'harborlight'];
    else if (service.kind === 'mysql') args = ['exec', container!, 'sh', '-c', 'exec mysqldump --all-databases --single-transaction -u root -p"$MYSQL_ROOT_PASSWORD"'];
    else if (service.kind === 'mariadb') args = ['exec', container!, 'sh', '-c', 'exec mariadb-dump --all-databases --single-transaction -u root -p"$MARIADB_ROOT_PASSWORD"'];
    else if (service.kind === 'mongo') args = ['exec', container!, 'sh', '-c', 'exec mongodump --archive --gzip --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin'];
    else if (service.kind === 'redis') {
      // SAVE atomically replaces dump.rdb. Archive only that immutable snapshot, not a live AOF.
      await command('docker', ['exec', container!, 'sh', '-c', 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli SAVE']);
      args = ['exec', container!, 'tar', '-czf', '-', '-C', '/data', 'dump.rdb'];
    } else {
      if (!service.mounts.length) throw new Error('This service has no persistent volumes to back up.');
      args = ['run', '--rm', '--name', `hl-backup-${randomUUID()}`, '--network', 'none', '--label', `${LABEL}=true`, '--label', 'io.harborlight.role=backup'];
      for (const mount of service.mounts) args.push('--mount', `type=volume,src=${this.volume(service, mount.name)},dst=/volumes/${mount.name},readonly`);
      args.push('alpine:3.21', 'tar', '-czf', '-', '-C', '/volumes', '.');
    }
    try { await command('docker', args, { destination, timeout: 1800000 }); }
    finally { if (args[0] === 'run') await command('docker', ['rm', '-f', args[args.indexOf('--name') + 1]]).catch(() => {}); }
  }
}

export function sanitizeCompose(service: Service): Record<string, unknown> {
  if (service.domains.length) throw new Error('Compose domain routing is not supported yet. Use explicit published ports.');
  const parsed = parse(service.source.compose || '', { maxAliasCount: 25 });
  if (!parsed || typeof parsed !== 'object' || !parsed.services || typeof parsed.services !== 'object' || Array.isArray(parsed.services)) throw new Error('Compose requires a services mapping.');
  const top = Object.keys(parsed); if (top.some(key => !['name', 'version', 'services', 'volumes', 'networks'].includes(key))) throw new Error('Unsupported Compose top-level option.');
  const entries = Object.entries(parsed.services);
  if (!entries.length || entries.length > 20) throw new Error('Compose requires 1 to 20 services.');
  const allowed = new Set(['image', 'command', 'entrypoint', 'environment', 'ports', 'volumes', 'restart', 'depends_on', 'healthcheck', 'working_dir', 'user', 'init', 'stop_grace_period']);
  const volumes: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(parsed.volumes || {})) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name) || value && (typeof value !== 'object' || Object.keys(value as object).length)) throw new Error('Compose supports only managed named volumes without driver options.');
    // Created and ownership-checked by ensureVolume before Compose runs; retained on stack removal.
    volumes[name] = { name: `hl-${service.id}-${name}`, external: true };
  }
  const services: Record<string, unknown> = {};
  for (const [name, raw] of entries) {
    const item = raw as Record<string, unknown>;
    if (!/^[a-z][a-z0-9_-]*$/.test(name) || !item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid Compose service.');
    if (Object.keys(item).some(key => !allowed.has(key))) throw new Error(`Unsupported Compose option in ${name}. Host access, external networks, build and custom labels are not allowed.`);
    if (typeof item.image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$/.test(item.image)) throw new Error(`A valid image is required for ${name}.`);
    if (item.volumes !== undefined && !Array.isArray(item.volumes)) throw new Error('Compose volumes must be a list.');
    for (const volume of (item.volumes || []) as unknown[]) {
      if (typeof volume !== 'string' || !/^[a-z][a-z0-9_-]*:\/[a-zA-Z0-9_./-]+(?::ro|:rw)?$/.test(volume) || !volumes[volume.split(':')[0]] || volume.split('/').includes('..')) throw new Error('Compose supports declared named volume mounts only.');
    }
    let environment: Record<string, string> = {};
    if (Array.isArray(item.environment)) for (const pair of item.environment) { if (typeof pair !== 'string' || !pair.includes('=')) throw new Error('Compose environment entries require explicit values.'); const index = pair.indexOf('='); environment[pair.slice(0, index)] = pair.slice(index + 1); }
    else if (item.environment && typeof item.environment === 'object') environment = Object.fromEntries(Object.entries(item.environment).map(([key, value]) => [key, String(value)]));
    const combined = { ...environment, ...service.env };
    // Escape Compose substitutions to avoid leaking ambient server environment into workloads.
    const escaped = JSON.parse(JSON.stringify(item).replace(/\$/g, '$$$$'));
    services[name] = { ...escaped, environment: Object.fromEntries(Object.entries(combined).map(([key, value]) => [key, value.replace(/\$/g, '$$$$')])), labels: { [LABEL]: 'true', [SERVICE_LABEL]: service.id }, networks: ['project'], cpus: service.resources.cpu, mem_limit: `${service.resources.memoryMb}m` };
  }
  return { services, volumes, networks: { project: { name: `hl-project-${service.projectId}`, external: true } } };
}

export class DemoDriver implements RuntimeDriver {
  private states: Record<string, ServiceStatus> = {};
  async deploy(service: Service, output: Output, options: DeployOptions = {}) { output(`DEMO — no Docker operations are performed.\nPreparing configuration…\n${options.forceRebuild ? 'Simulating a build without cache.\n' : ''}`); await new Promise(resolveDelay => setTimeout(resolveDelay, 350)); this.states[service.id] = 'running'; output('Simulated deployment complete.\n'); return { image: service.source.image || 'demo-build' }; }
  async action(service: Service, action: 'start' | 'stop' | 'restart') { this.states[service.id] = action === 'stop' ? 'stopped' : 'running'; }
  async remove(service: Service) { delete this.states[service.id]; }
  async logs(service: Service) { return `DEMO — illustrative log output; no container is running.\n${service.createdAt} [info] ${service.name}: configuration loaded\n${service.updatedAt} [info] Ready to receive requests\n`; }
  async statuses() { return { ...this.states }; }
  async metrics(): Promise<Metrics> { return { mode: 'demo', cpuPercent: 12.8, memoryUsedBytes: 3.2 * 1024 ** 3, memoryTotalBytes: 8 * 1024 ** 3, diskUsedBytes: 21.4 * 1024 ** 3, diskTotalBytes: 80 * 1024 ** 3, uptime: 259200, dockerVersion: 'Demo', containersRunning: 3 }; }
  async backup(_service: Service, destination: string) { await writeFile(destination, 'DEMO BACKUP — sample text, not restorable data.\n', { mode: 0o600, flag: 'wx' }); }
}
