import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rm, statfs, realpath, mkdtemp } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { cpus, freemem, totalmem, uptime } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'yaml';
import type { Service, Metrics, ServiceStatus, Backup, BackupMetadata } from '../shared/types.js';
import type { ProxyAuthMap } from '../shared/proxy.js';
import type { ServiceMetrics } from '../shared/metrics.js';
import type { ServicePorts } from '../shared/ports.js';
import { collectDockerServicePorts } from './docker-ports.js';
import { collectDockerServiceMetrics, emptyMetricValues } from './docker-metrics.js';
import { proxyLabels } from './proxy-routing.js';
import { resolveSourceCredentials, withGitSourceCredentials, withDockerSourceCredentials, normalizeGitRepository, type DeploymentSourceCredentials } from './source-credentials.js';
import { assertEngineCompatible, backupFormats, NativeDatabaseTools, restoredEnvironment, validateRestoreFile } from './database-restore.js';

const LABEL = 'io.harborlight.managed';
const SERVICE_LABEL = 'io.harborlight.service';
export type Output = (chunk: string) => void;
export interface DeployOptions { forceRebuild?: boolean; sourceCredentials?: DeploymentSourceCredentials; proxyAuth?: ProxyAuthMap; projectEnvironment?: Record<string, string>; releaseId?: string; expectedCommit?: string }
export interface DeploymentResult { containerId?: string; image?: string; imageId?: string; releaseTag?: string; commit?: string }
export interface RollbackOptions { imageId: string; releaseTag: string; proxyAuth?: ProxyAuthMap; releaseId?: string }
export interface RestoreCheckpoint { restoreId: string; previousContainerId: string; candidateContainerId: string; previousWasRunning: boolean }
export interface RestoreOptions { sourceService?: Service; onPrepared?: (result: RestoreResult, checkpoint: RestoreCheckpoint) => Promise<void> }
export interface RestoreResult { containerId: string; volumeOverrides: Record<string, string>; environment?: Record<string, string> }
export interface RuntimeDriver {
  deploy(service: Service, output: Output, options?: DeployOptions): Promise<DeploymentResult>;
  rollback?(service: Service, output: Output, options: RollbackOptions): Promise<DeploymentResult>;
  action(service: Service, action: 'start' | 'stop' | 'restart'): Promise<void>;
  remove(service: Service): Promise<void>;
  logs(service: Service, tail: number): Promise<string>;
  metrics(): Promise<Metrics>;
  serviceMetrics?(service: Service): Promise<ServiceMetrics>;
  servicePorts?(service: Service): Promise<ServicePorts>;
  statuses(): Promise<Record<string, ServiceStatus>>;
  backup(service: Service, filename: string): Promise<BackupMetadata | void>;
  validateRestore?(service: Service, backup: Backup, filename: string, options?: RestoreOptions): Promise<void>;
  restore?(service: Service, backup: Backup, filename: string, output: Output, options?: RestoreOptions): Promise<RestoreResult>;
  recoverRestore?(previous: Service, prepared: Service, checkpoint: RestoreCheckpoint): Promise<'activated' | 'rolled-back'>;
}

// Commands are always argument arrays, never interpolated shell commands.
export function command(binary: string, args: string[], options: { cwd?: string; output?: Output; timeout?: number; destination?: string; env?: NodeJS.ProcessEnv; input?: string; inputFile?: string } = {}): Promise<string> {
  if (options.input !== undefined && options.inputFile !== undefined) return Promise.reject(new Error('Choose one command input source.'));
  return new Promise((resolveCommand, reject) => {
    const child = spawn(binary, args, { cwd: options.cwd, env: options.env ?? process.env, shell: false, stdio: [options.input === undefined && options.inputFile === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let output = '', stderr = '', settled = false, timedOut = false;
    const sink = options.destination ? createWriteStream(options.destination, { flags: 'wx', mode: 0o600, flush: true }) : undefined;
    let source: ReturnType<typeof createReadStream> | undefined;
    const finish = (error?: Error) => { if (settled) return; settled = true; source?.destroy(); clearTimeout(timer); error ? reject(error) : resolveCommand(output); };
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeout ?? 30000);
    child.stdin?.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') finish(error); });
    if (options.input !== undefined) child.stdin?.end(options.input);
    if (options.inputFile !== undefined) { source = createReadStream(options.inputFile); source.on('error', error => { child.kill('SIGKILL'); finish(error); }); source.pipe(child.stdin!); }
    sink?.on('error', error => { child.kill('SIGKILL'); finish(error); });
    if (sink) child.stdout!.pipe(sink);
    else child.stdout!.on('data', chunk => { const text = chunk.toString(); output = (output + text).slice(-2_000_000); options.output?.(text); });
    child.stderr!.on('data', chunk => { const text = chunk.toString(); stderr = (stderr + text).slice(-20000); options.output?.(text); });
    child.on('error', finish);
    child.on('close', code => {
      if (code !== 0) { sink?.destroy(); finish(new Error(timedOut ? `${binary} operation timed out.` : `${binary} failed (${code}): ${stderr.trim().slice(-4000) || 'No error details.'}`)); }
      else if (sink && !sink.closed) sink.once('close', () => finish());
      else finish();
    });
  });
}

export class DockerDriver implements RuntimeDriver {
  constructor(readonly dataDir: string) {}
  private name(service: Service) { return `hl-${service.id}`; }
  private projectNetwork(service: Service) { return `hl-project-${service.projectId}`; }
  private volume(service: Service, name: string) { return service.volumeOverrides?.[name] || `hl-${service.id}-${name}`; }
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
  private async assertRuntimeVolumes(service: Service, inspected: { Mounts?: { Type: string; Name?: string; Destination: string }[] }) {
    for (const mount of service.mounts) {
      const name = this.volume(service, mount.name);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(name)) throw new Error('Invalid managed volume mapping.');
      const actual = inspected.Mounts?.find(item => item.Destination === mount.mountPath);
      if (!actual || actual.Type !== 'volume' || actual.Name !== name) throw new Error('Applied volume mapping does not match the current container.');
      const [volume] = JSON.parse(await command('docker', ['volume', 'inspect', name]));
      if (volume.Labels?.[LABEL] !== 'true' || volume.Labels?.[SERVICE_LABEL] !== service.id) throw new Error('Refusing to back up or restore an unmanaged volume.');
    }
  }
  private releaseTag(service: Service, releaseId: string) {
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
    if (service.kind !== 'app' || !uuid.test(service.id) || !uuid.test(releaseId)) throw new Error('Immutable releases require an application service and valid release identifiers.');
    return `harborlight-release/${service.id}:${releaseId}`;
  }
  private async exactImage(imageId: string) {
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('A complete immutable Docker image ID is required.');
    const [image] = JSON.parse(await command('docker', ['image', 'inspect', imageId]));
    if (image.Id !== imageId) throw new Error('Docker did not return the expected immutable image.');
    return imageId;
  }
  private async pinRelease(service: Service, releaseId: string, imageId: string) {
    const tag = this.releaseTag(service, releaseId);
    try {
      const [existing] = JSON.parse(await command('docker', ['image', 'inspect', tag]));
      if (existing.Id !== imageId) throw new Error('This release tag already belongs to a different immutable image.');
      return { tag, created: false };
    } catch (error) { if (!/No such image|No such object/i.test(String(error))) throw error; }
    // Adding our own reference does not change labels or other users' references on a shared image.
    await command('docker', ['image', 'tag', imageId, tag]);
    const [retained] = JSON.parse(await command('docker', ['image', 'inspect', tag]));
    if (retained.Id !== imageId) throw new Error('The release reference changed before it could be retained.');
    return { tag, created: true };
  }
  async deploy(service: Service, output: Output, options: DeployOptions = {}): Promise<DeploymentResult> {
    return this.deployInternal(service, output, options);
  }
  async rollback(service: Service, output: Output, options: RollbackOptions): Promise<DeploymentResult> {
    return this.deployInternal(service, output, { proxyAuth: options.proxyAuth, releaseId: options.releaseId }, options);
  }
  private async deployInternal(service: Service, output: Output, options: DeployOptions = {}, rollback?: RollbackOptions): Promise<DeploymentResult> {
    if (options.releaseId) this.releaseTag(service, options.releaseId);
    if (options.expectedCommit && (service.source.type !== 'git' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(options.expectedCommit))) throw new Error('A pinned commit requires a Git source and a complete commit SHA.');
    let imageId: string | undefined;
    if (rollback) {
      if (service.kind !== 'app' || !rollback.releaseTag.startsWith(`harborlight-release/${service.id}:`) || this.releaseTag(service, rollback.releaseTag.split(':').at(-1)!) !== rollback.releaseTag) throw new Error('This release does not belong to the application service.');
      imageId = await this.exactImage(rollback.imageId);
      const [reference] = JSON.parse(await command('docker', ['image', 'inspect', rollback.releaseTag]));
      if (reference.Id !== imageId) throw new Error('The retained release tag no longer matches its recorded image.');
      if (Object.keys(reference.Config?.Volumes || {}).some(path => !service.mounts.some(mount => mount.mountPath === path))) throw new Error('The retained image declares a persistent volume that is absent from the managed release mounts.');
      const current = await this.ownedContainer(service);
      const [runtime] = JSON.parse(await command('docker', ['container', 'inspect', current!]));
      await this.assertRuntimeVolumes(service, runtime);
      if ((runtime.Mounts || []).some((mount: { Type: string; Destination: string }) => mount.Type === 'volume' && !service.mounts.some(configured => configured.mountPath === mount.Destination))) throw new Error('Rollback requires every persistent container volume to be explicitly managed.');
      output(`Using retained immutable image ${imageId}. No source fetch, pull or build is performed.\n`);
    }
    const credentials = rollback ? {} : resolveSourceCredentials(service, options.sourceCredentials);
    for (const value of Object.values(service.env)) if (/[\r\n\0]/.test(value)) throw new Error('Docker environment values must be single-line. Encode multiline secrets before use.');
    if (service.domains.length) await command('docker', ['network', 'inspect', 'harborlight-proxy']);
    await this.network(service);
    if (service.kind === 'compose') return this.deployCompose(service, output, options.projectEnvironment);
    const work = join(this.dataDir, 'work', `${service.id}-${randomUUID()}`);
    await mkdir(work, { recursive: true, mode: 0o700 });
    let image = rollback?.releaseTag || service.source.image;
    let commit: string | undefined;
    let retained: { tag: string; created: boolean } | undefined, completed = false;
    try {
      if (rollback) { /* The exact image was verified before network, volume or container mutations. */ }
      else if (service.source.type === 'image') {
        if (!image) throw new Error('An image is required.');
        output(`Pulling ${image}\n`);
        await withDockerSourceCredentials(image, credentials.registry, command, env => command('docker', ['pull', image!], { env, output: credentials.registry ? undefined : output, timeout: 600000 }));
        if (credentials.registry) output('Private image authenticated and pulled.\n');
      } else if (service.source.type === 'dockerfile' || service.source.type === 'git') {
        image = `harborlight/${service.id}:${Date.now()}`;
        let context = work, dockerfile = 'Dockerfile';
        if (service.source.type === 'git') {
          const repo = join(work, 'repo');
          output('Cloning source repository…\n');
          commit = await withGitSourceCredentials(service.source.repository!, credentials.ssh ?? credentials.git, async git => {
            await command('git', [...git.args, 'clone', '--depth', '1', '--single-branch', '--branch', service.source.branch || 'main', '--', git.repository, repo], { cwd: git.cwd, timeout: 300000, output: credentials.git || credentials.ssh ? undefined : output, env: git.env });
            await command('git', [...git.args, 'remote', 'set-url', 'origin', normalizeGitRepository(service.source.repository!)], { cwd: repo, env: git.env });
            if (options.expectedCommit) {
              await command('git', [...git.args, 'fetch', '--depth', '1', '--no-tags', 'origin', options.expectedCommit], { cwd: repo, timeout: 300000, output: credentials.git || credentials.ssh ? undefined : output, env: git.env });
              await command('git', [...git.args, 'checkout', '--detach', options.expectedCommit], { cwd: repo, env: git.env });
            }
            return (await command('git', [...git.args, 'rev-parse', 'HEAD'], { cwd: repo, env: git.env })).trim();
          }, process.env, join(this.dataDir, 'ssh-credentials'));
          if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Git did not return a valid source commit.');
          if (options.expectedCommit && commit !== options.expectedCommit) throw new Error('Fetched source did not match the requested commit.');
          output(`Source commit: ${commit}\n`);
          const repoReal = await realpath(repo);
          context = await realpath(resolve(repo, service.source.context || '.'));
          if (context !== repoReal && !context.startsWith(repoReal + sep)) throw new Error('Build context escapes repository.');
          dockerfile = service.source.dockerfile || 'Dockerfile';
          const dockerfileReal = await realpath(join(context, dockerfile));
          if (!dockerfileReal.startsWith(repoReal + sep)) throw new Error('Dockerfile escapes repository.');
        } else await writeFile(join(work, 'Dockerfile'), service.source.dockerfile!, { mode: 0o600 });
        output('Building image…\n');
        const iidFile = join(work, 'built-image.id');
        await withDockerSourceCredentials(undefined, undefined, command, env => command('docker', ['build', '--iidfile', iidFile, '--label', `${LABEL}=true`, ...(commit ? ['--label', `org.opencontainers.image.revision=${commit}`] : []), ...(options.forceRebuild ? ['--no-cache', '--pull'] : []), '-t', image!, '-f', join(context, dockerfile), context], { env, output, timeout: 1800000 }));
        imageId = (await readFile(iidFile, 'utf8')).trim();
      } else throw new Error('Choose an image, Git repository or inline Dockerfile for this service.');
      if (!imageId) imageId = JSON.parse(await command('docker', ['image', 'inspect', image!]))[0].Id;
      imageId = await this.exactImage(imageId!);
      if (options.releaseId) retained = await this.pinRelease(service, options.releaseId, imageId);
      for (const mount of service.mounts) await this.ensureVolume(service, mount.name);
      // Create the candidate and validate its networks before touching the previous runtime.
      const existing = await this.ownedContainer(service, true);
      const envFile = join(work, 'environment');
      await writeFile(envFile, Object.entries(service.env).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600 });
      const candidateName = `${this.name(service)}-candidate-${randomUUID().slice(0, 8)}`;
      const previousName = `${this.name(service)}-previous-${randomUUID().slice(0, 8)}`;
      const args = ['create', '--pull=never', '--name', candidateName, '--label', `${LABEL}=true`, '--label', `${SERVICE_LABEL}=${service.id}`, '--label', `io.harborlight.project=${service.projectId}`, '--restart', 'unless-stopped', '--network', this.projectNetwork(service), '--network-alias', service.name, '--cpus', String(service.resources.cpu), '--memory', `${service.resources.memoryMb}m`, '--env-file', envFile];
      for (const mount of service.mounts) args.push('--mount', `type=volume,src=${this.volume(service, mount.name)},dst=${mount.mountPath}`);
      for (const port of service.ports) args.push('-p', `${port.published}:${port.target}/${port.protocol}`);
      args.push('--label', `traefik.enable=${service.domains.length > 0}`);
      if (service.domains.length) args.push('--label', 'traefik.docker.network=harborlight-proxy');
      args.push(...proxyLabels(service.domains, service.id, options.proxyAuth));
      args.push(imageId);
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
      completed = true;
      return { containerId, image, imageId, ...(retained ? { releaseTag: retained.tag } : rollback ? { releaseTag: rollback.releaseTag } : {}), ...(commit ? { commit } : {}) };
    } finally {
      if (!completed && retained?.created) {
        const [reference] = JSON.parse(await command('docker', ['image', 'inspect', retained.tag]).catch(() => '[]'));
        if (reference?.Id === imageId) await command('docker', ['image', 'rm', retained.tag]).catch(() => {});
      }
      await rm(work, { recursive: true, force: true });
    }
  }
  private composePath(service: Service) { return join(this.dataDir, 'compose', service.id, 'compose.yaml'); }
  private composeArgs(service: Service) { return ['compose', '-p', `hl-${service.id}`, '-f', this.composePath(service)]; }
  private async deployCompose(service: Service, output: Output, projectEnvironment: Record<string, string> = {}) {
    const config = sanitizeCompose(service, projectEnvironment);
    const ids = (await command('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=hl-${service.id}`])).trim();
    if (ids) await this.assertComposeOwnership(service);
    for (const name of Object.keys((config.volumes || {}) as object)) await this.ensureVolume(service, name);
    await mkdir(join(this.dataDir, 'compose', service.id), { recursive: true, mode: 0o700 });
    await writeFile(this.composePath(service), stringify(config), { mode: 0o600 });
    await withDockerSourceCredentials(undefined, undefined, command, env => command('docker', [...this.composeArgs(service), 'up', '-d', '--remove-orphans'], { env, timeout: 900000, output }));
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
    } else {
      const container = await this.ownedContainer(service, true);
      if (container) await command('docker', ['rm', '-f', container]);
    }
    // Delete only references in this service's exact release namespace, never image IDs or unrelated tags.
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(service.id)) throw new Error('Invalid service identifier for release reference cleanup.');
    const repository = `harborlight-release/${service.id}`;
    const references = (await command('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', repository])).trim().split('\n').filter(Boolean);
    const owned = new RegExp(`^${repository}:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`);
    for (const reference of new Set(references.filter(value => owned.test(value)))) {
      try { await command('docker', ['image', 'rm', reference]); }
      catch { throw new Error('The service container was removed, but a retained release reference is still in use. Inspect shared image use and retry deletion; no image was forcibly removed.'); }
    }
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
    const canonical: Record<string, ServiceStatus> = {}, compose: Record<string, ServiceStatus> = {};
    const rank = { running: 0, stopped: 1, failed: 2 };
    for (const line of output.trim().split('\n').filter(Boolean)) {
      const item = JSON.parse(line), labels = Object.fromEntries(item.Labels.split(',').map((pair: string) => { const index = pair.indexOf('='); return [pair.slice(0, index), pair.slice(index + 1)]; }));
      const serviceId = labels[SERVICE_LABEL];
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(serviceId || '')) continue;
      const status = item.State === 'running' ? 'running' : item.State === 'exited' || item.State === 'created' ? 'stopped' : 'failed';
      // Restore/deploy candidates and previous containers retain ownership labels, but are not the active runtime.
      if (item.Names === `hl-${serviceId}`) canonical[serviceId] = status;
      else if (labels['com.docker.compose.project'] === `hl-${serviceId}` && /^[a-z][a-z0-9_-]*$/.test(labels['com.docker.compose.service'] || '') && labels['com.docker.compose.oneoff']?.toLowerCase() !== 'true') {
        const previous = compose[serviceId] as keyof typeof rank | undefined;
        if (!previous || rank[status] > rank[previous]) compose[serviceId] = status;
      }
    }
    return { ...compose, ...canonical };
  }
  async serviceMetrics(service: Service): Promise<ServiceMetrics> { return collectDockerServiceMetrics(service, command); }
  async servicePorts(service: Service): Promise<ServicePorts> { return collectDockerServicePorts(service, command); }
  async metrics(): Promise<Metrics> {
    const base: Metrics = { mode: 'docker', cpuPercent: null, memoryUsedBytes: totalmem() - freemem(), memoryTotalBytes: totalmem(), diskUsedBytes: null, diskTotalBytes: null, uptime: uptime(), dockerVersion: null, containersRunning: 0 };
    try {
      const fs = await statfs(this.dataDir); base.diskTotalBytes = fs.blocks * fs.bsize; base.diskUsedBytes = (fs.blocks - fs.bfree) * fs.bsize;
      const info = JSON.parse(await command('docker', ['info', '--format', '{{json .}}']));
      base.dockerVersion = info.ServerVersion;
      const stats = (await command('docker', ['stats', '--no-stream', '--format', '{{json .}}'], { timeout: 15000 })).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      base.containersRunning = info.ContainersRunning;
      base.cpuPercent = Math.min(100, stats.reduce((sum, stat) => sum + (parseFloat(stat.CPUPerc) || 0), 0) / (info.NCPU || cpus().length || 1));
      base.sampledAt = new Date().toISOString();
    } catch { base.sampledAt = null; base.error = 'Server measurements are incomplete. Check Docker connectivity and data-directory access.'; }
    return base;
  }
  async backup(service: Service, destination: string): Promise<BackupMetadata> {
    if (service.kind === 'compose') throw new Error('Compose backup is not supported. Back up each database using its native tools.');
    const container = await this.ownedContainer(service);
    const [runtime] = JSON.parse(await command('docker', ['container', 'inspect', container!]));
    await this.assertRuntimeVolumes(service, runtime);
    await mkdir(join(this.dataDir, 'work'), { recursive: true, mode: 0o700 });
    const work = await mkdtemp(join(this.dataDir, 'work', 'backup-'));
    try {
      const native = new NativeDatabaseTools(command, work);
      const metadata: BackupMetadata = { schemaVersion: 1, kind: service.kind, format: backupFormats[service.kind], image: runtime.Image, mounts: service.mounts.map(({ name, mountPath }) => ({ name, mountPath })) };
      if (service.kind !== 'app') { metadata.engineVersion = await native.version(container!, service.kind); await native.backup(container!, service, destination); }
      else {
        if (!service.mounts.length) throw new Error('This service has no persistent volumes to back up.');
        await this.ensureArchiveHelper();
        const name = `hl-backup-${randomUUID()}`;
        const args = ['run', '--rm', '--name', name, '--network', 'none', '--read-only', '--label', `${LABEL}=true`, '--label', 'io.harborlight.role=backup'];
        for (const mount of service.mounts) args.push('--mount', `type=volume,src=${this.volume(service, mount.name)},dst=/volumes/${mount.name},readonly`);
        args.push('alpine:3.21', 'tar', '-czf', '-', '-C', '/volumes', '.');
        try { await command('docker', args, { destination, timeout: 1800000 }); }
        finally { await command('docker', ['rm', '-f', name]).catch(() => {}); }
      }
      return metadata;
    } finally { await rm(work, { recursive: true, force: true }); }
  }
  private async ensureArchiveHelper() {
    try { await command('docker', ['image', 'inspect', 'alpine:3.21']); }
    catch { await withDockerSourceCredentials('alpine:3.21', undefined, command, env => command('docker', ['pull', 'alpine:3.21'], { env, timeout: 300000 })); }
  }
  async validateRestore(service: Service, backup: Backup, filename: string, options: RestoreOptions = {}) {
    await validateRestoreFile(service, backup, filename, options.sourceService);
    const container = await this.ownedContainer(service);
    const [runtime] = JSON.parse(await command('docker', ['container', 'inspect', container!]));
    if (!runtime.State.Running) throw new Error('Start the target service before restoring so its safety backup can be created.');
    await this.assertRuntimeVolumes(service, runtime);
    if (service.kind !== 'app') assertEngineCompatible(service.kind, backup.metadata!.engineVersion!, await new NativeDatabaseTools(command, this.dataDir).version(container!, service.kind));
  }
  async restore(service: Service, backup: Backup, filename: string, output: Output, options: RestoreOptions = {}): Promise<RestoreResult> {
    await this.validateRestore(service, backup, filename, options);
    const previous = (await this.ownedContainer(service))!;
    const [old] = JSON.parse(await command('docker', ['container', 'inspect', previous]));
    await mkdir(join(this.dataDir, 'work'), { recursive: true, mode: 0o700 });
    const work = await mkdtemp(join(this.dataDir, 'work', 'restore-'));
    const restoreId = randomUUID(), initName = `hl-restore-init-${restoreId}`, finalName = `hl-restore-final-${restoreId}`, previousName = `hl-restore-previous-${restoreId}`;
    const volumeOverrides = Object.fromEntries(service.mounts.map(mount => [mount.name, `hl-${service.id}-restore-${restoreId}-${mount.name}`]));
    const environment = service.kind === 'app' ? undefined : restoredEnvironment(options.sourceService!);
    const restored: Service = { ...service, env: { ...service.env, ...environment }, volumeOverrides };
    const native = new NativeDatabaseTools(command, work);
    let init: string | undefined, candidate: string | undefined, renamedPrevious = false, stoppedPrevious = false, activated = false;
    const createdVolumes: string[] = [];
    const waitReady = async (container: string, configuration: Service, maximum = 240000) => {
      const until = Date.now() + maximum; let last: unknown;
      while (Date.now() < until) {
        const [state] = JSON.parse(await command('docker', ['container', 'inspect', container]));
        if (!state.State.Running) throw new Error('Restore candidate stopped before verification.');
        try {
          if (configuration.kind !== 'app') await native.ready(container, configuration);
          else if (state.State.Health && state.State.Health.Status !== 'healthy') throw new Error('Application health check is not healthy.');
          return;
        } catch (error) { last = error; }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 750));
      }
      throw new Error(`Restore candidate failed authenticated readiness verification: ${last instanceof Error ? last.message : 'timeout'}`);
    };
    const createCandidate = async (name: string, configuration: Service, isolated: boolean, redisRdb = false) => {
      const envFile = join(work, `${name}.env`);
      for (const value of Object.values(configuration.env)) if (/[\r\n\0]/.test(value)) throw new Error('Database environment must be single-line.');
      await writeFile(envFile, Object.entries(configuration.env).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600, flag: 'wx' });
      const args = ['create', '--name', name, '--restart', isolated ? 'no' : 'unless-stopped', '--network', isolated ? 'none' : this.projectNetwork(service), '--cpus', String(service.resources.cpu), '--memory', `${service.resources.memoryMb}m`, '--env-file', envFile];
      const labels = isolated ? { [LABEL]: 'true', [SERVICE_LABEL]: service.id, 'io.harborlight.restore': restoreId, 'io.harborlight.role': 'restore-candidate', 'traefik.enable': 'false' } : { ...old.Config.Labels, 'io.harborlight.restore': restoreId };
      for (const [key, value] of Object.entries(labels)) args.push('--label', `${key}=${value}`);
      if (!isolated) {
        args.push('--network-alias', service.name);
        for (const port of service.ports) args.push('-p', `${port.published}:${port.target}/${port.protocol}`);
      }
      for (const mount of service.mounts) args.push('--mount', `type=volume,src=${volumeOverrides[mount.name]},dst=${mount.mountPath}`);
      args.push(old.Image);
      if (redisRdb) args.push('sh', '-c', 'exec redis-server --appendonly no --requirepass "$REDIS_PASSWORD"');
      else if (Array.isArray(old.Config.Cmd)) args.push(...old.Config.Cmd);
      return (await command('docker', args)).trim();
    };
    const extract = async () => {
      await this.ensureArchiveHelper();
      const helper = `hl-restore-extract-${restoreId}`;
      const args = ['run', '--rm', '-i', '--name', helper, '--network', 'none', '--read-only', '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '--cap-add', 'DAC_OVERRIDE', '--label', `${LABEL}=true`, '--label', `io.harborlight.restore=${restoreId}`, '--label', 'io.harborlight.role=restore-extractor'];
      for (const mount of service.mounts) args.push('--mount', `type=volume,src=${volumeOverrides[mount.name]},dst=${service.kind === 'redis' ? '/volumes' : `/volumes/${mount.name}`}`);
      args.push('alpine:3.21', 'tar', '-xzpf', '-', '-C', '/volumes');
      try { await command('docker', args, { inputFile: filename, timeout: 1800000 }); }
      finally { await command('docker', ['rm', '-f', helper]).catch(() => {}); }
    };
    try {
      output('Preparing new managed volumes. The current service remains running.\n');
      for (const name of Object.values(volumeOverrides)) {
        await command('docker', ['volume', 'create', '--label', `${LABEL}=true`, '--label', `${SERVICE_LABEL}=${service.id}`, '--label', `io.harborlight.restore=${restoreId}`, name]); createdVolumes.push(name);
      }
      if (service.kind === 'app' || service.kind === 'redis') { output('Extracting validated archive into empty candidate volumes.\n'); await extract(); }
      const bootstrap: Service = service.kind === 'postgres' ? { ...restored, env: { ...restored.env, POSTGRES_USER: `hl_restore_${restoreId.replaceAll('-', '')}`, POSTGRES_PASSWORD: randomUUID(), POSTGRES_DB: 'postgres' } } : restored;
      init = await createCandidate(initName, bootstrap, true, service.kind === 'redis');
      await command('docker', ['start', init]);
      await waitReady(init, bootstrap);
      if (!['app', 'redis'].includes(service.kind)) {
        output('Importing the native database dump into the isolated candidate.\n');
        await native.restore(init, bootstrap, filename);
        if (service.kind === 'mysql' || service.kind === 'mariadb') await native.execute(init, restored, [service.kind === 'mysql' ? 'mysql' : 'mariadb', '-u', 'root', '-e', 'FLUSH PRIVILEGES']);
        await waitReady(init, restored, 30000);
        // PostgreSQL requires its bootstrap role (OID 10) to remain a superuser.
        // Disable every login and remove its password; the imported source owner manages the cluster.
        if (service.kind === 'postgres') await native.execute(init, restored, ['psql', '-X', '-h', '127.0.0.1', '-U', restored.env.POSTGRES_USER || 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', `ALTER ROLE "${bootstrap.env.POSTGRES_USER}" NOLOGIN PASSWORD NULL`]);
      }
      if (service.kind === 'redis') {
        output('Verified RDB loading; generating durable AOF before the final restart.\n');
        await native.execute(init, restored, ['redis-cli', '-e', 'CONFIG', 'SET', 'appendonly', 'yes']);
        const until = Date.now() + 120000; let ready = false;
        while (Date.now() < until) {
          const info = await native.execute(init, restored, ['redis-cli', '-e', '--raw', 'INFO', 'persistence']);
          if (/aof_enabled:1\r?\n/.test(info) && /aof_rewrite_in_progress:0\r?\n/.test(info) && /aof_last_bgrewrite_status:ok\r?\n/.test(info)) { ready = true; break; }
          await new Promise(resolveDelay => setTimeout(resolveDelay, 500));
        }
        if (!ready) throw new Error('Redis did not finish durable AOF creation.');
      }
      await command('docker', ['stop', '-t', '60', init], { timeout: 90000 });
      await command('docker', ['rm', '-v', init]); init = undefined;
      if (await this.ownedContainer(service) !== previous) throw new Error('The target runtime changed while restoration was preparing.');
      candidate = await createCandidate(finalName, restored, false);
      if (service.domains.length) await command('docker', ['network', 'connect', 'harborlight-proxy', candidate]);
      await options.onPrepared?.({ containerId: candidate, volumeOverrides, ...(environment ? { environment } : {}) }, { restoreId, previousContainerId: previous, candidateContainerId: candidate, previousWasRunning: !!old.State.Running });
      output('Candidate verified. Switching runtime; previous volumes will be retained.\n');
      await command('docker', ['stop', '-t', '60', previous], { timeout: 90000 }); stoppedPrevious = true;
      await command('docker', ['rename', previous, previousName]); renamedPrevious = true;
      await command('docker', ['rename', candidate, this.name(service)]);
      await command('docker', ['start', candidate]);
      await waitReady(candidate, restored, 120000);
      activated = true;
      await command('docker', ['rm', previous]).catch(() => output('The previous stopped container was retained because its cleanup failed.\n'));
      output('Restored runtime verified. Original volumes and the safety backup remain available.\n');
      return { containerId: candidate, volumeOverrides, ...(environment ? { environment } : {}) };
    } catch (error) {
      if (candidate && !activated) { await command('docker', ['rm', '-f', '-v', candidate]).catch(() => {}); candidate = undefined; }
      if (renamedPrevious) await command('docker', ['rename', previous, this.name(service)]);
      if (stoppedPrevious && old.State.Running) await command('docker', ['start', previous]);
      output('Restore failed. Previous runtime and original volumes were preserved.\n');
      throw error;
    } finally {
      if (init) await command('docker', ['rm', '-f', '-v', init]).catch(() => {});
      if (candidate && !activated) await command('docker', ['rm', '-f', '-v', candidate]).catch(() => {});
      if (!activated) for (const name of createdVolumes) {
        const [volume] = JSON.parse(await command('docker', ['volume', 'inspect', name]).catch(() => '[]'));
        if (volume?.Labels?.['io.harborlight.restore'] === restoreId && volume.Labels[SERVICE_LABEL] === service.id) await command('docker', ['volume', 'rm', name]).catch(() => {});
      }
      await rm(work, { recursive: true, force: true });
    }
  }
  async recoverRestore(previous: Service, prepared: Service, checkpoint: RestoreCheckpoint): Promise<'activated' | 'rolled-back'> {
    if (previous.id !== prepared.id || !/^[a-f0-9-]{36}$/.test(checkpoint.restoreId) || ![checkpoint.previousContainerId, checkpoint.candidateContainerId].every(id => /^[a-f0-9]{64}$/.test(id))) throw new Error('Invalid restore recovery checkpoint.');
    const inspect = async (id: string) => {
      try { return JSON.parse(await command('docker', ['container', 'inspect', id]))[0]; }
      catch (error) { if (/No such (container|object)/i.test(String(error))) return undefined; throw error; }
    };
    const owned = (container: any) => container?.Config?.Labels?.[LABEL] === 'true' && container.Config.Labels[SERVICE_LABEL] === previous.id;
    const canonical = await inspect(this.name(previous));
    const old = await inspect(checkpoint.previousContainerId), candidate = await inspect(checkpoint.candidateContainerId);
    if (canonical && ![checkpoint.previousContainerId, checkpoint.candidateContainerId].includes(canonical.Id)) throw new Error('Restore recovery found a different active container. Manual inspection is required.');
    if (old && !owned(old) || candidate && (!owned(candidate) || candidate.Config.Labels['io.harborlight.restore'] !== checkpoint.restoreId)) throw new Error('Restore recovery found a container with unexpected ownership labels.');
    for (const mount of prepared.mounts) if (prepared.volumeOverrides?.[mount.name] !== `hl-${previous.id}-restore-${checkpoint.restoreId}-${mount.name}`) throw new Error('Restore recovery volume mapping is invalid.');
    await mkdir(join(this.dataDir, 'work'), { recursive: true, mode: 0o700 });
    const work = await mkdtemp(join(this.dataDir, 'work', 'recovery-'));
    try {
      if (canonical?.Id === checkpoint.candidateContainerId && candidate?.State.Running) {
        try {
          await this.assertRuntimeVolumes(prepared, candidate);
          const until = Date.now() + 30000; let verified = false;
          while (Date.now() < until) {
            try {
              if (prepared.kind === 'app') {
                const state = await inspect(candidate.Id);
                if (!state?.State.Running || state.State.Health && state.State.Health.Status !== 'healthy') throw new Error('Candidate application is not healthy.');
              } else await new NativeDatabaseTools(command, work).ready(candidate.Id, prepared);
              verified = true; break;
            } catch { await new Promise(resolveDelay => setTimeout(resolveDelay, 750)); }
          }
          if (!verified) throw new Error('Candidate could not be verified after restart.');
          if (old) await command('docker', ['rm', '-f', old.Id]);
          return 'activated';
        } catch (error) {
          if (!old) throw new Error(`Active restore candidate could not be verified and its previous container is missing: ${error instanceof Error ? error.message : 'unknown error'}`);
          // Roll back only to the exact checkpoint container; original volumes are never deleted.
        }
      }
      if (!old) throw new Error('The previous restore container is missing. Manual recovery is required.');
      if (candidate) await command('docker', ['rm', '-f', '-v', candidate.Id]);
      if (old.Name !== `/${this.name(previous)}`) await command('docker', ['rename', old.Id, this.name(previous)]);
      if (checkpoint.previousWasRunning && !old.State.Running) await command('docker', ['start', old.Id]);
      await this.assertRuntimeVolumes(previous, old);
      for (const name of Object.values(prepared.volumeOverrides || {})) {
        const [volume] = JSON.parse(await command('docker', ['volume', 'inspect', name]).catch(() => '[]'));
        if (volume?.Labels?.[LABEL] === 'true' && volume.Labels[SERVICE_LABEL] === previous.id && volume.Labels['io.harborlight.restore'] === checkpoint.restoreId) await command('docker', ['volume', 'rm', name]).catch(() => {});
      }
      return 'rolled-back';
    } finally { await rm(work, { recursive: true, force: true }); }
  }
}

export function sanitizeCompose(service: Service, projectEnvironment: Record<string, string> = {}): Record<string, unknown> {
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
    const combined = { ...projectEnvironment, ...environment, ...service.env };
    // Escape Compose substitutions to avoid leaking ambient server environment into workloads.
    const escaped = JSON.parse(JSON.stringify(item).replace(/\$/g, '$$$$'));
    services[name] = { ...escaped, environment: Object.fromEntries(Object.entries(combined).map(([key, value]) => [key, value.replace(/\$/g, '$$$$')])), labels: { [LABEL]: 'true', [SERVICE_LABEL]: service.id, 'io.harborlight.project': service.projectId }, networks: ['project'], cpus: service.resources.cpu, mem_limit: `${service.resources.memoryMb}m` };
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
  async servicePorts(service: Service): Promise<ServicePorts> { return { mode: 'demo', serviceId: service.id, state: 'unavailable', sampledAt: null, checkedAt: new Date().toISOString(), listeners: [], exposed: [], message: 'Demo mode has no real container socket inspection.' }; }
  async serviceMetrics(service: Service): Promise<ServiceMetrics> { return { mode: 'demo', serviceId: service.id, state: service.status === 'stopped' ? 'stopped' : service.status === 'not-deployed' ? 'not-deployed' : 'unavailable', sampledAt: null, checkedAt: new Date().toISOString(), containers: [], totals: emptyMetricValues(), message: 'Demo mode has no real container measurements.' }; }
  async metrics(): Promise<Metrics> { return { mode: 'demo', cpuPercent: 12.8, memoryUsedBytes: 3.2 * 1024 ** 3, memoryTotalBytes: 8 * 1024 ** 3, diskUsedBytes: 21.4 * 1024 ** 3, diskTotalBytes: 80 * 1024 ** 3, uptime: 259200, dockerVersion: 'Demo', containersRunning: 3 }; }
  async backup(service: Service, destination: string): Promise<BackupMetadata | void> {
    await writeFile(destination, 'DEMO BACKUP — sample text, not restorable data.\n', { mode: 0o600, flag: 'wx' });
    return { schemaVersion: 1, kind: service.kind, format: 'demo', image: 'demo', mounts: service.mounts.map(({ name, mountPath }) => ({ name, mountPath })) };
  }
}
