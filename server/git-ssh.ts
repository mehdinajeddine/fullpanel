import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, isIP, type Socket } from 'node:net';
import { mkdtemp, chmod, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, chmodSync, readdirSync, rmSync } from 'node:fs';

const execute = promisify(execFile);
const error = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
export interface SshRepository { repository: string; hostname: string; port: number; username: string; path: string; knownHost: string }
export interface GitSshCredential { serviceId: string; repository: string; privateKey: string; publicKey: string; fingerprint: string; knownHosts?: string; hostFingerprints?: string[]; updatedAt: string; hostKeyUpdatedAt?: string }
export type EffectiveGitSshCredential = GitSshCredential & { hostKeySource?: 'github-published' | 'manual' };

// GitHub's published Ed25519 host key, verified 2026-11-08. Deliberately not fetched or learned at runtime.
// https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
export const GITHUB_KNOWN_HOSTS = 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n';
export const GITHUB_HOST_FINGERPRINT = 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU';

/** Resolve trust without mutating stored credentials. Explicit pins always win, including invalid ones. */
export function effectiveSshCredential(credential: GitSshCredential): EffectiveGitSshCredential {
  if (credential.knownHosts !== undefined && credential.knownHosts !== '') return { ...credential, hostKeySource: 'manual' };
  const scope = parseSshRepository(credential.repository);
  if (scope.hostname === 'github.com' && scope.port === 22) return {
    ...credential, knownHosts: GITHUB_KNOWN_HOSTS, hostFingerprints: [GITHUB_HOST_FINGERPRINT], hostKeySource: 'github-published'
  };
  return { ...credential };
}

export function isSshRepository(repository: string): boolean { return repository.startsWith('ssh://') || /^[^/]+@[^/]+:/.test(repository); }

/** scp paths are relative to the remote home; URI paths are absolute. Do not conflate them. */
export function parseSshRepository(value: string): SshRepository {
  if (value.length > 1000 || /[\s\0\\%?#]/.test(value)) throw error(400, 'Use an explicit SSH repository URL without spaces, escapes, query or fragment.');
  let hostname = '', username = '', path = '', port = 22, absolute = false;
  if (value.startsWith('ssh://')) {
    const match = /^ssh:\/\/([A-Za-z_][A-Za-z0-9_-]{0,63})@(\[[a-fA-F0-9:]+\]|[A-Za-z0-9.-]+)(?::([0-9]{1,5}))?(\/.*)$/.exec(value);
    if (!match) throw error(400, 'Use ssh://user@host[:port]/repository.');
    [, username, hostname, , path] = match;
    if (match[3]) port = Number(match[3]);
    absolute = true;
  } else {
    const match = /^([A-Za-z_][A-Za-z0-9_-]{0,63})@(\[[a-fA-F0-9:]+\]|[A-Za-z0-9.-]+):(.+)$/.exec(value);
    if (!match) throw error(400, 'Use user@host:owner/repository.git.');
    [, username, hostname, path] = match;
    if (path.startsWith('/')) throw error(400, 'Use an ssh:// URL for an absolute repository path.');
  }
  hostname = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (port < 1 || port > 65535 || hostname.length > 253 || !(isIP(hostname) || /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(hostname))) throw error(400, 'Invalid SSH host or port.');
  path = path.replace(/\/+$/, '');
  const parts = (absolute ? path.slice(1) : path).split('/');
  if (!parts.length || parts.some(part => !/^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/.test(part) || part === '.' || part === '..')) throw error(400, 'Use a repository path with simple names and no traversal or shell characters.');
  const host = hostname.includes(':') ? `[${hostname}]` : hostname;
  return { repository: absolute ? `ssh://${username}@${host}${port === 22 ? '' : `:${port}`}${path}` : `${username}@${host}:${path}`, hostname, username, port, path, knownHost: port === 22 ? hostname : `[${hostname}]:${port}` };
}

/** Call only after acquiring the panel's data-directory writer lock. Unknown entries are untouched. */
export function initializeSshCredentialDirectory(directory: string): void {
  try { mkdirSync(directory, { mode: 0o700 }); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; }
  const root = lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('SSH credential workspace must be a real directory.');
  chmodSync(directory, 0o700);
  for (const name of readdirSync(directory)) {
    if (!/^(?:key|git)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(name)) continue;
    const path = join(directory, name), entry = lstatSync(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('SSH credential workspace contains an unexpected managed entry.');
    rmSync(path, { recursive: true, force: false });
  }
}

async function temporaryDirectory(prefix: string, credentialsDirectory?: string) {
  if (credentialsDirectory) {
    const root = lstatSync(credentialsDirectory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('SSH credential workspace must be a real directory.');
    const directory = join(credentialsDirectory, `${prefix}-${randomUUID()}`); await mkdir(directory, { mode: 0o700 }); return directory;
  }
  const directory = await mkdtemp(join(tmpdir(), prefix)); await chmod(directory, 0o700); return directory;
}
function keygenEnvironment(): NodeJS.ProcessEnv { const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C' }; delete env.SSH_AUTH_SOCK; delete env.SSH_AGENT_PID; return env; }

/** OpenSSH writes and verifies its own native private-key format. */
export async function generateSshKeyPair(serviceId: string, credentialsDirectory?: string): Promise<Pick<GitSshCredential, 'privateKey' | 'publicKey' | 'fingerprint'>> {
  if (!/^[a-f0-9-]{36}$/i.test(serviceId)) throw error(400, 'Invalid service identifier.');
  const directory = await temporaryDirectory(credentialsDirectory ? 'key' : 'harborlight-ssh-keygen-', credentialsDirectory);
  const filename = join(directory, 'identity');
  try {
    await execute('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `fullpanel-${serviceId}`, '-f', filename], { timeout: 15000, maxBuffer: 16000, env: keygenEnvironment() });
    await chmod(filename, 0o600);
    const privateKey = await readFile(filename, 'utf8'), publicKey = (await readFile(`${filename}.pub`, 'utf8')).trim();
    const { stdout } = await execute('ssh-keygen', ['-lf', `${filename}.pub`, '-E', 'sha256'], { timeout: 10000, maxBuffer: 16000, env: keygenEnvironment() });
    const fingerprint = stdout.trim().split(/\s+/)[1];
    if (!privateKey.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----\n') || !publicKey.startsWith('ssh-ed25519 ') || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint || '')) throw new Error('Unexpected key output.');
    return { privateKey, publicKey, fingerprint };
  } catch { throw error(503, 'SSH key generation failed. Ensure OpenSSH tools are installed.'); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

/** Explicit exact-host pins only: no automatic scans, aliases, CA markers or wildcard trust. */
export async function validateSshKnownHosts(repository: string, input: string): Promise<{ knownHosts: string; hostFingerprints: string[] }> {
  const scope = parseSshRepository(repository);
  if (!input || input.length > 16000 || /[\0\r]/.test(input)) throw error(400, 'Provide at most 16000 characters of known_hosts entries.');
  const lines = input.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  if (!lines.length || lines.length > 10) throw error(400, 'Provide between 1 and 10 exact-host keys.');
  const normalized: string[] = [];
  for (const line of lines) {
    const match = /^(\S+)\s+(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))\s+([A-Za-z0-9+/]+={0,2})(?:\s+[^\x00-\x1f]*)?$/.exec(line);
    if (!match || match[1] !== scope.knownHost) throw error(400, `Every known_hosts entry must use the exact host ${scope.knownHost} and a supported public key.`);
    const blob = Buffer.from(match[3], 'base64');
    if (blob.length < 16 || blob.length > 8192 || blob.toString('base64').replace(/=+$/, '') !== match[3].replace(/=+$/, '') || blob.readUInt32BE(0) !== Buffer.byteLength(match[2]) || blob.subarray(4, 4 + blob.readUInt32BE(0)).toString() !== match[2]) throw error(400, 'Invalid SSH public key.');
    normalized.push(`${scope.knownHost} ${match[2]} ${blob.toString('base64')}`);
  }
  const directory = await temporaryDirectory('harborlight-ssh-hostkey-');
  try {
    const fingerprints: string[] = [];
    for (const [index, line] of [...new Set(normalized)].entries()) {
      const filename = join(directory, `host-${index}`); await writeFile(filename, `${line}\n`, { mode: 0o600, flag: 'wx' });
      const { stdout } = await execute('ssh-keygen', ['-lf', filename, '-E', 'sha256'], { timeout: 10000, maxBuffer: 16000, env: keygenEnvironment() });
      const parts = stdout.trim().split(/\s+/);
      if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(parts[1] || '') || line.includes(' ssh-rsa ') && Number(parts[0]) < 2048) throw new Error('Invalid key.');
      fingerprints.push(parts[1]);
    }
    return { knownHosts: [...new Set(normalized)].join('\n') + '\n', hostFingerprints: fingerprints };
  } catch { throw error(400, 'The server public key is invalid or unsupported. RSA keys require at least 2048 bits.'); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

export interface GitCredentialContext { repository: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }
export function isolatedGitEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of Object.keys(env)) if (/^(GIT_|HL_GIT_|SSH_|CURL_VERBOSE|NODE_OPTIONS|NODE_PATH)/.test(key)) delete env[key];
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
}

/** Each wrapper acknowledges only after its SSH child has closed, including a killed Git parent. */
async function openSshControl(filename: string): Promise<() => Promise<void>> {
  const clients = new Set<{ socket: Socket; done: Promise<Error | undefined> }>();
  let closing = false;
  const server = createServer(socket => {
    let received = '', confirmed = false;
    const done = new Promise<Error | undefined>(resolve => {
      socket.on('data', chunk => {
        received += chunk.toString();
        if (received === 'closed\n') { confirmed = true; socket.end(); }
        else if (received.length > 64 || !'closed\n'.startsWith(received)) socket.destroy();
      });
      socket.on('error', () => {});
      socket.on('close', () => resolve(confirmed ? undefined : new Error('SSH transport cleanup could not be verified.')));
    });
    clients.add({ socket, done });
    if (closing) socket.write('close\n');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(filename, () => { server.removeListener('error', reject); resolve(); }); });
  await chmod(filename, 0o600);
  return async () => {
    closing = true;
    const finished = new Promise<void>(resolve => server.close(() => resolve()));
    for (const client of clients) if (!client.socket.destroyed) client.socket.write('close\n');
    const timer = setTimeout(() => { for (const client of clients) client.socket.destroy(); }, 4000);
    try {
      await finished;
      const failures = await Promise.all([...clients].map(client => client.done));
      if (failures.some(Boolean)) throw new Error('SSH transport cleanup could not be verified.');
    } finally { clearTimeout(timer); }
  };
}

/** The wrapper accepts only this repository's upload-pack command and never an arbitrary SSH command. */
function sshWrapper(scope: SshRepository, identity: string, hosts: string, control: string): string {
  const options = ['-F', '/dev/null', '-i', identity, '-p', String(scope.port), '-o', `UserKnownHostsFile=${hosts}`, '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'CertificateFile=none', '-o', 'PKCS11Provider=none', '-o', 'SecurityKeyProvider=none', '-o', 'PreferredAuthentications=publickey', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'ClearAllForwardings=yes', '-o', 'ProxyCommand=none', '-o', 'ProxyJump=none', '-o', 'PermitLocalCommand=no', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'KnownHostsCommand=none', '-o', 'VerifyHostKeyDNS=no', '-o', 'UpdateHostKeys=no', '-o', 'CanonicalizeHostname=no', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'RequestTTY=no'];
  return `#!/usr/bin/env node
'use strict';
const { spawn } = require('node:child_process');
const { connect } = require('node:net');
const scope = ${JSON.stringify(scope)};
const args = process.argv.slice(2);
let port = 22;
while (args.length > 2) {
  const option = args.shift();
  if (option === '-o' && args[0] === 'SendEnv=GIT_PROTOCOL') args.shift();
  else if (option === '-p' && /^\\d+$/.test(args[0] || '')) port = Number(args.shift());
  else process.exit(255);
}
const targets = [scope.username + '@' + scope.hostname, scope.username + '@[' + scope.hostname + ']'];
const remote = "git-upload-pack '" + scope.path + "'";
if (args.length !== 2 || !targets.includes(args[0]) || args[1] !== remote || port !== scope.port) process.exit(255);
let child, stopping = false, finished = false, killTimer, connectionTimer;
const gitParent = process.ppid;
const socket = connect(${JSON.stringify(control)});
function finish(code) {
  if (finished) return;
  finished = true; clearTimeout(timer); clearTimeout(killTimer); clearTimeout(connectionTimer); clearInterval(parentMonitor);
  if (child) process.stdin.unpipe(child.stdin);
  process.stdin.pause();
  process.exitCode = code === null ? 255 : code;
  if (!socket.destroyed) socket.end('closed\\n');
}
function stop() {
  if (stopping || finished) return;
  stopping = true;
  if (!child) return finish(255);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
  }
}
const timer = setTimeout(stop, 300000);
const parentMonitor = setInterval(() => { try { process.kill(gitParent, 0); } catch { stop(); } }, 100);
connectionTimer = setTimeout(stop, 5000);
socket.on('connect', () => {
  clearTimeout(connectionTimer);
  if (stopping) return;
  // Own the Git-facing descriptors: killing this guardian must close Git's pipes,
  // even if an SSH process survives. pipe() preserves binary data and backpressure.
  child = spawn('ssh', [...${JSON.stringify(options)}, '--', scope.username + '@' + scope.hostname, remote], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  process.stdin.on('error', stop); process.stdout.on('error', stop); process.stderr.on('error', stop);
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') stop(); });
  child.stdout.on('error', stop); child.stderr.on('error', stop);
  process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  child.on('error', () => { process.stderr.write('SSH transport could not start.\\n'); });
  child.on('close', code => finish(code));
});
socket.on('data', stop); socket.on('error', stop); socket.on('close', stop);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, stop);
`;
}

export async function withSshSourceCredentials<T>(repository: string, credential: GitSshCredential | undefined, callback: (context: GitCredentialContext) => Promise<T>, baseEnv: NodeJS.ProcessEnv, credentialsDirectory?: string): Promise<T> {
  const scope = parseSshRepository(repository);
  if (!credential || credential.repository !== scope.repository) throw error(409, 'Generate an SSH deploy key for this saved repository before deployment.');
  credential = effectiveSshCredential(credential);
  if (!credential.knownHosts) throw error(409, 'Verify and save the SSH server public key before deployment.');
  // Revalidate private stored trust; stale or corrupted records cannot expand host scope.
  const trust = await validateSshKnownHosts(scope.repository, credential.knownHosts);
  const directory = await temporaryDirectory(credentialsDirectory ? 'git' : 'hl-ssh-', credentialsDirectory);
  let closeControl: (() => Promise<void>) | undefined;
  let controlDirectory: string | undefined;
  try {
    controlDirectory = await temporaryDirectory('hl-sc-');
    const identity = join(directory, 'identity'), hosts = join(directory, 'known_hosts'), wrapper = join(directory, 'ssh.cjs'), templates = join(directory, 'templates'), control = join(controlDirectory, 'c');
    if (Buffer.byteLength(control) >= 104) throw error(503, 'The temporary directory path is too long for SSH control. Configure a shorter TMPDIR.');
    closeControl = await openSshControl(control);
    await writeFile(identity, credential.privateKey, { mode: 0o600, flag: 'wx' });
    await writeFile(hosts, trust.knownHosts, { mode: 0o600, flag: 'wx' });
    await writeFile(wrapper, sshWrapper(scope, identity, hosts, control), { mode: 0o700, flag: 'wx' });
    await mkdir(templates, { mode: 0o700 });
    const env = { ...isolatedGitEnvironment(baseEnv), HOME: directory, XDG_CONFIG_HOME: directory, GIT_SSH: wrapper, GIT_SSH_VARIANT: 'ssh', GIT_TEMPLATE_DIR: templates };
    const args = ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '-c', 'protocol.ssh.allow=always'];
    return await callback({ repository: scope.repository, args, env, cwd: directory });
  } finally { try { await closeControl?.(); } finally { await rm(directory, { recursive: true, force: true }); if (controlDirectory) await rm(controlDirectory, { recursive: true, force: true }); } }
}
