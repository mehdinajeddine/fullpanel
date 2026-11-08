/** Immutable release proof. Uses cached Nginx, tiny local builds and exact UUID-owned cleanup. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { DockerDriver, command } from '../server/docker.js';
import { withDockerSourceCredentials } from '../server/source-credentials.js';
import type { Service } from '../shared/types.js';

const directory = await mkdtemp(join(tmpdir(), 'harborlight-release-smoke-'));
const projectId = randomUUID(), testId = randomUUID();
const driver = new DockerDriver(directory);
const services: Service[] = [];
const statusFixtureIds: string[] = [];
const blockerName = `hl-release-port-blocker-${testId}`;
const dockerBinary = execFileSync('which', ['docker'], { encoding: 'utf8' }).trim();
const guardDirectory = join(directory, 'guard'); await mkdir(guardDirectory, { mode: 0o700 });
const traceFile = join(directory, 'rollback-commands.jsonl');
const wrapper = `#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process');
const args=process.argv.slice(2),binary=require('node:path').basename(process.argv[1]);
fs.appendFileSync(process.env.HL_RELEASE_TRACE,JSON.stringify({binary,args})+'\\n',{mode:0o600});
if(binary==='git'||['pull','build','buildx','login','compose'].includes(args[0])){process.stderr.write('Source operation forbidden during rollback\\n');process.exit(87);}
const result=cp.spawnSync(process.env.HL_RELEASE_DOCKER,args,{stdio:'inherit',env:process.env});
if(result.error){process.stderr.write(result.error.message);process.exit(88);}process.exit(result.status===null?89:result.status);
`;
for (const binary of ['docker', 'git']) { await writeFile(join(guardDirectory, binary), wrapper, { mode: 0o700 }); await chmod(join(guardDirectory, binary), 0o700); }
async function noSourceOperations<T>(action: () => Promise<T>): Promise<T> {
  const previousPath = process.env.PATH, previousDocker = process.env.HL_RELEASE_DOCKER, previousTrace = process.env.HL_RELEASE_TRACE;
  process.env.PATH = guardDirectory + delimiter + (previousPath || ''); process.env.HL_RELEASE_DOCKER = dockerBinary; process.env.HL_RELEASE_TRACE = traceFile;
  try { return await action(); }
  finally {
    for (const [key, value] of [['PATH', previousPath], ['HL_RELEASE_DOCKER', previousDocker], ['HL_RELEASE_TRACE', previousTrace]] as const) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
function service(name: string, source: Service['source']): Service {
  const timestamp = new Date().toISOString();
  const value: Service = { id: randomUUID(), projectId, name, kind: 'app', status: 'not-deployed', source, env: {}, mounts: [], domains: [], ports: [], resources: { cpu: 0.25, memoryMb: 96 }, notes: '', createdAt: timestamp, updatedAt: timestamp };
  services.push(value); return value;
}
async function inspect(value: Service) { return JSON.parse(await command('docker', ['container', 'inspect', `hl-${value.id}`]))[0]; }
async function response(value: Service): Promise<string> {
  const until = Date.now() + 30000; let last: unknown;
  while (Date.now() < until) {
    try { return (await command('docker', ['exec', `hl-${value.id}`, 'wget', '-qO-', 'http://127.0.0.1'])).trim(); }
    catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  throw last;
}
async function check(value: Service, expected: { imageId: string; content: string; environment: string; cpu: number; memoryMb: number; volume: string }) {
  const runtime = await inspect(value);
  assert.equal(runtime.Image, expected.imageId); assert.equal(runtime.State.Running, true);
  assert.equal(await response(value), expected.content);
  assert.ok(runtime.Config.Env.includes(`DEPLOY_PROOF=${expected.environment}`));
  assert.equal(runtime.HostConfig.NanoCpus, expected.cpu * 1e9); assert.equal(runtime.HostConfig.Memory, expected.memoryMb * 1024 * 1024);
  assert.equal(runtime.Mounts.find((mount: { Destination: string }) => mount.Destination === '/data')?.Name, expected.volume);
  assert.equal((await command('docker', ['exec', runtime.Id, 'cat', '/data/proof'])).trim(), 'recent-data-in-active-volume');
  return runtime.Id as string;
}
try {
  const [base] = JSON.parse(await command('docker', ['image', 'inspect', 'nginx:1.28-alpine']));
  const baseDigest = base.RepoDigests?.[0]; assert.ok(baseDigest, 'Preinstall the Nginx fixture image before this test.');
  const originalLabels = structuredClone(base.Config.Labels || {});
  const dockerfile = (flavor: string) => `FROM ${baseDigest}\nENV RELEASE_FLAVOR=${flavor}\nRUN printf '%s' ${flavor} > /usr/share/nginx/html/release.txt\nVOLUME /data\nCMD ${JSON.stringify(['sh', '-c', 'printf "%s|%s" "$RELEASE_FLAVOR" "$DEPLOY_PROOF" > /usr/share/nginx/html/index.html; exec nginx -g "daemon off;"'])}\n`;
  const app = service('release-web', { type: 'dockerfile', dockerfile: dockerfile('alpha') });
  app.env = { DEPLOY_PROOF: 'config-one' }; app.mounts = [{ id: randomUUID(), name: 'data', mountPath: '/data' }];
  const snapshot = structuredClone(app), firstReleaseId = randomUUID();
  const first = await driver.deploy(app, () => {}, { releaseId: firstReleaseId });
  assert.ok(first.imageId && first.releaseTag && first.image); assert.match(first.imageId, /^sha256:[a-f0-9]{64}$/);
  assert.equal((await inspect(app)).Image, first.imageId);
  assert.equal(await response(app), 'alpha|config-one');
  await command('docker', ['exec', '-i', `hl-${app.id}`, 'sh', '-c', 'cat > /data/proof'], { input: 'older-data-in-original-volume' });

  // Model an already-restored volume mapping: release history must not revert to the old storage name.
  const activeVolume = `hl-${app.id}-restore-${randomUUID()}-data`;
  app.volumeOverrides = { data: activeVolume };
  app.source = { type: 'dockerfile', dockerfile: dockerfile('beta') };
  app.env = { DEPLOY_PROOF: 'config-two' }; app.resources = { cpu: 0.5, memoryMb: 128 };
  const second = await driver.deploy(app, () => {}, { releaseId: randomUUID() });
  assert.ok(second.imageId && second.releaseTag); assert.notEqual(second.imageId, first.imageId);
  await command('docker', ['exec', '-i', `hl-${app.id}`, 'sh', '-c', 'cat > /data/proof'], { input: 'recent-data-in-active-volume' });
  await check(app, { imageId: second.imageId, content: 'beta|config-two', environment: 'config-two', cpu: 0.5, memoryMb: 128, volume: activeVolume });

  // A mutable source/build tag now points at a different image; the retained release must remain exact.
  await command('docker', ['image', 'tag', second.imageId, first.image]);
  const selected = { ...snapshot, volumeOverrides: structuredClone(app.volumeOverrides) };
  const restored = await noSourceOperations(() => driver.rollback(selected, () => {}, { imageId: first.imageId!, releaseTag: first.releaseTag!, releaseId: randomUUID() }));
  assert.equal(restored.imageId, first.imageId); assert.ok(restored.releaseTag);
  let currentId = await check(app, { imageId: first.imageId, content: 'alpha|config-one', environment: 'config-one', cpu: 0.25, memoryMb: 96, volume: activeVolume });
  console.log('PASS: two real image/config releases, mutated source tag, exact-image rollback, saved environment/resources and current persistent data.');

  await assert.rejects(noSourceOperations(() => driver.rollback(selected, () => {}, { imageId: `sha256:${'0'.repeat(64)}`, releaseTag: first.releaseTag! })), /No such image|No such object/i);
  assert.equal((await inspect(app)).Id, currentId);
  await assert.rejects(noSourceOperations(() => driver.rollback(snapshot, () => {}, { imageId: first.imageId!, releaseTag: first.releaseTag! })), /volume mapping/);
  assert.equal((await inspect(app)).Id, currentId);
  await command('docker', ['image', 'tag', second.imageId, first.releaseTag]);
  await assert.rejects(noSourceOperations(() => driver.rollback(selected, () => {}, { imageId: first.imageId!, releaseTag: first.releaseTag! })), /no longer matches/);
  assert.equal((await inspect(app)).Id, currentId);
  await command('docker', ['image', 'tag', first.imageId, first.releaseTag]);
  console.log('PASS: missing image, stale active-volume mapping and changed private release tag fail before touching the current container.');

  // The target image itself must not introduce an unconfigured anonymous persistent volume.
  const extra = join(directory, 'extra-volume'); await mkdir(extra);
  await writeFile(join(extra, 'Dockerfile'), `FROM ${baseDigest}\nVOLUME /unmanaged-history\n`);
  const unsafeTag = `harborlight-release/${app.id}:${randomUUID()}`;
  await withDockerSourceCredentials(undefined, undefined, command, env => command('docker', ['build', '--label', 'io.harborlight.managed=true', '-t', unsafeTag, extra], { env, timeout: 300000 }));
  const [unsafeImage] = JSON.parse(await command('docker', ['image', 'inspect', unsafeTag]));
  await assert.rejects(noSourceOperations(() => driver.rollback(selected, () => {}, { imageId: unsafeImage.Id, releaseTag: unsafeTag })), /declares a persistent volume/);
  assert.equal((await inspect(app)).Id, currentId);
  console.log('PASS: an unmanaged volume declared only by the historical target image is rejected before replacement.');

  await command('docker', ['run', '--pull=never', '-d', '--name', blockerName, '--label', `io.harborlight.test=${testId}`, '-p', '127.0.0.1::80', base.Id]);
  const [blocker] = JSON.parse(await command('docker', ['container', 'inspect', blockerName]));
  const occupiedPort = Number(blocker.NetworkSettings.Ports['80/tcp'][0].HostPort);
  await assert.rejects(noSourceOperations(() => driver.rollback({ ...selected, ports: [{ published: occupiedPort, target: 80, protocol: 'tcp' }] }, () => {}, { imageId: first.imageId!, releaseTag: first.releaseTag! })), /failed|allocated|address already in use/i);
  assert.equal((await inspect(app)).Id, currentId);
  currentId = await check(app, { imageId: first.imageId, content: 'alpha|config-one', environment: 'config-one', cpu: 0.25, memoryMb: 96, volume: activeVolume });
  await command('docker', ['rm', '-f', blockerName]);
  console.log('PASS: a real start failure after stopping the previous runtime restores that exact container and its data.');

  const plain = service('shared-image', { type: 'image', image: baseDigest });
  const plainRelease = await driver.deploy(plain, () => {}, { releaseId: randomUUID() });
  assert.ok(plainRelease.releaseTag); assert.equal(plainRelease.imageId, base.Id);
  assert.deepEqual(JSON.parse(await command('docker', ['image', 'inspect', base.Id]))[0].Config.Labels || {}, originalLabels);

  // A crash can leave an old owned container beside the canonical runtime; it must not mask its status.
  async function statusFixture(serviceId: string, name: string, extraLabels: string[] = []) {
    const id = (await command('docker', ['create', '--pull=never', '--name', name, '--label', 'io.harborlight.managed=true', '--label', `io.harborlight.service=${serviceId}`, '--label', `io.harborlight.test=${testId}`, ...extraLabels.flatMap(label => ['--label', label]), base.Id])).trim();
    statusFixtureIds.push(id); return id;
  }
  const previous = await statusFixture(plain.id, `hl-${plain.id}-previous-${randomUUID()}`);
  await command('docker', ['start', previous]); await command('docker', ['stop', previous]);
  assert.equal(JSON.parse(await command('docker', ['inspect', previous]))[0].State.Status, 'exited');
  assert.equal((await driver.statuses())[plain.id], 'running', 'An exited previous runtime must not mask the canonical running container.');
  const candidateServiceId = randomUUID();
  await statusFixture(candidateServiceId, `hl-${candidateServiceId}-candidate-${randomUUID()}`);
  assert.equal((await driver.statuses())[candidateServiceId], undefined, 'A candidate alone is not an active service runtime.');

  const stack = service('status-stack', { type: 'compose', compose: `services:\n  web:\n    image: ${baseDigest}\n  worker:\n    image: ${baseDigest}\n` }); stack.kind = 'compose';
  await driver.deploy(stack, () => {});
  assert.equal((await driver.statuses())[stack.id], 'running');
  const workerId = (await command('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=hl-${stack.id}`, '--filter', 'label=com.docker.compose.service=worker'])).trim();
  assert.match(workerId, /^[a-f0-9]+$/);
  await command('docker', ['stop', workerId]);
  assert.equal((await driver.statuses())[stack.id], 'stopped', 'A stopped Compose child must affect the aggregate status.');
  await command('docker', ['start', workerId]);
  await statusFixture(stack.id, `hl-${stack.id}-oneoff-${randomUUID()}`, [`com.docker.compose.project=hl-${stack.id}`, 'com.docker.compose.service=job', 'com.docker.compose.oneoff=True']);
  await statusFixture(stack.id, `hl-${stack.id}-foreign-${randomUUID()}`, [`com.docker.compose.project=hl-${randomUUID()}`, 'com.docker.compose.service=worker']);
  assert.equal((await driver.statuses())[stack.id], 'running', 'Stopped one-off tasks and mismatched Compose projects must not mask active children.');
  console.log('PASS: stopped previous/candidate containers are ignored; real Compose children aggregate status, excluding one-off tasks and mismatched projects.');

  await driver.remove(plain);
  await assert.rejects(command('docker', ['image', 'inspect', plainRelease.releaseTag]), /No such image|No such object/i);
  assert.equal(JSON.parse(await command('docker', ['image', 'inspect', baseDigest]))[0].Id, base.Id);
  const trace = (await readFile(traceFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(trace.some(call => call.args[0] === 'create' && call.args.includes('--pull=never') && call.args.includes(first.imageId)));
  assert.ok(trace.every(call => call.binary === 'docker' && !['pull', 'build', 'buildx', 'login', 'compose'].includes(call.args[0])));
  console.log('PASS: rollback execution never invoked Git/build/pull/login; release cleanup preserves the shared image and its original labels/references.');
  console.log('All immutable release smoke checks passed.');
} finally {
  const [blocker] = JSON.parse(await command('docker', ['container', 'inspect', blockerName]).catch(() => '[]'));
  if (blocker?.Config.Labels?.['io.harborlight.test'] === testId) await command('docker', ['rm', '-f', blockerName]);
  for (const id of statusFixtureIds) {
    const [runtime] = JSON.parse(await command('docker', ['container', 'inspect', id]).catch(() => '[]'));
    if (runtime?.Id === id && runtime.Config.Labels?.['io.harborlight.test'] === testId && runtime.Config.Labels['io.harborlight.managed'] === 'true') await command('docker', ['rm', '-f', id]);
  }
  for (const value of services.reverse()) {
    await driver.remove(value).catch(error => console.error('Owned service/release cleanup:', String(error)));
    const volumes = (await command('docker', ['volume', 'ls', '-q', '--filter', `label=io.harborlight.service=${value.id}`])).trim().split('\n').filter(Boolean);
    for (const name of volumes) {
      const [volume] = JSON.parse(await command('docker', ['volume', 'inspect', name]));
      if (volume.Labels?.['io.harborlight.managed'] === 'true' && volume.Labels['io.harborlight.service'] === value.id) await command('docker', ['volume', 'rm', name]);
    }
    const built = (await command('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', `harborlight/${value.id}`])).trim().split('\n').filter(Boolean);
    for (const reference of built) if (reference.startsWith(`harborlight/${value.id}:`)) await command('docker', ['image', 'rm', reference]).catch(() => {});
  }
  const [network] = JSON.parse(await command('docker', ['network', 'inspect', `hl-project-${projectId}`]).catch(() => '[]'));
  if (network?.Labels?.['io.harborlight.project'] === projectId && network.Labels['io.harborlight.managed'] === 'true') await command('docker', ['network', 'rm', network.Name]);
  await rm(directory, { recursive: true, force: true });
}
