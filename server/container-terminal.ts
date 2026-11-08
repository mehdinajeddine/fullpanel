import http from 'node:http';
import type { Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { Service, TerminalTarget } from '../shared/types.js';
import { command } from './docker.js';
import type { TerminalCallbacks, TerminalHandle, TerminalOpenOptions, TerminalRuntime } from './terminals.js';

const managed = 'io.harborlight.managed', serviceLabel = 'io.harborlight.service';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const dockerId = /^[a-f0-9]{64}$/;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
class EngineError extends Error { constructor(readonly statusCode: number, message: string) { super(message); } }
interface ContainerInfo { Id: string; Name: string; State: { Running: boolean; Paused?: boolean }; Config: { Labels?: Record<string,string> } }
interface ExecInfo { ID: string; ContainerID: string; Running: boolean; ExitCode: number; Pid: number }

/** Local Docker transport only. No URL, container ID or command is accepted from a browser. */
class Engine {
  private constructor(readonly socketPath: string, readonly version: string) {}
  static async connect() {
    let host = process.env.DOCKER_HOST;
    if (!host || process.env.DOCKER_CONTEXT) {
      const contexts = JSON.parse(await command('docker', ['context', 'inspect'], { timeout: 10000 }));
      host = contexts[0]?.Endpoints?.docker?.Host;
    }
    if (!host?.startsWith('unix:///') || host.includes('\0')) throw new Error('Interactive terminals require a local Docker Unix socket context.');
    const probe = new Engine(host.slice('unix://'.length), '');
    const version = await probe.json<{ ApiVersion: string; MinAPIVersion?: string; Os?: string }>('GET', '/version');
    const minor = /^1\.(\d+)$/.exec(version.ApiVersion)?.[1];
    if (!minor || Number(minor) < 44 || version.Os && version.Os !== 'linux') throw new Error('Interactive terminals require a Linux Docker Engine supporting API 1.44 or later.');
    const selected = Math.min(Number(minor), 51);
    const minimum = /^1\.(\d+)$/.exec(version.MinAPIVersion || '')?.[1];
    if (minimum && Number(minimum) > selected) throw new Error('This Docker Engine requires a newer terminal API version.');
    return new Engine(probe.socketPath, `/v1.${selected}`);
  }
  json<T = Record<string,unknown>>(method: string, path: string, value?: unknown): Promise<T> {
    const body = value === undefined ? undefined : JSON.stringify(value);
    return new Promise((resolve, reject) => {
      const request = http.request({ socketPath: this.socketPath, path: this.version + path, method, headers: body ? { 'content-type':'application/json','content-length':Buffer.byteLength(body) } : {} }, response => {
        const chunks: Buffer[] = []; let length = 0;
        response.on('data', (chunk: Buffer) => { length += chunk.length; if (length > 8*1024*1024) request.destroy(new Error('Docker returned an oversized response.')); else chunks.push(chunk); });
        response.on('error', reject);
        response.on('end', () => {
          const code = response.statusCode || 500;
          if (code < 200 || code >= 300) return reject(new EngineError(code, code === 404 ? 'The selected Docker resource no longer exists.' : 'Docker could not complete the terminal operation.'));
          try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
          catch { reject(new Error('Docker returned an invalid response.')); }
        });
      });
      request.setTimeout(10000, () => request.destroy(new Error('Docker terminal operation timed out.')));
      request.on('error', reject); request.end(body);
    });
  }
  attach(execId: string): Promise<{ socket: Socket; head: Buffer }> {
    const body = JSON.stringify({ Detach:false, Tty:true });
    return new Promise((resolve, reject) => {
      const request = http.request({ socketPath:this.socketPath, path:`${this.version}/exec/${execId}/start`, method:'POST', headers:{ 'content-type':'application/json', 'content-length':Buffer.byteLength(body), connection:'Upgrade', upgrade:'tcp' } });
      request.setTimeout(10000, () => request.destroy(new Error('Opening the Docker terminal timed out.')));
      request.on('upgrade', (_response, socket, head) => { request.setTimeout(0); socket.setTimeout(0); resolve({socket,head}); });
      request.on('response', response => { response.resume(); reject(new Error('Docker did not establish an interactive terminal stream.')); });
      request.on('error', reject); request.end(body);
    });
  }
  async container(id: string) { return this.json<ContainerInfo>('GET', `/containers/${encodeURIComponent(id)}/json`); }
  async exec(id: string) { return this.json<ExecInfo>('GET', `/exec/${id}/json`); }
}

function assertOwned(service: Service, container: ContainerInfo, target?: string) {
  const labels = container.Config.Labels || {};
  if (!dockerId.test(container.Id) || labels[managed] !== 'true' || labels[serviceLabel] !== service.id || labels['io.harborlight.project'] !== service.projectId) throw new Error('The terminal target is not owned by this service.');
  if (service.kind === 'compose') {
    if (labels['com.docker.compose.project'] !== `hl-${service.id}` || !/^[a-z][a-z0-9_-]*$/.test(labels['com.docker.compose.service'] || '') || labels['com.docker.compose.oneoff']?.toLowerCase() === 'true' || target && labels['com.docker.compose.service'] !== target) throw new Error('The terminal target is not a managed Compose service.');
  } else if (container.Name !== `/hl-${service.id}` || target && target !== 'main') throw new Error('The selected application container is no longer current.');
  if (!container.State.Running || container.State.Paused) throw new Error('The selected container must be running and unpaused.');
}

// This script runs inside the selected container, with its configured user. It never runs on the host.
// Docker's TTY exec must own a Linux session so cleanup can target that session without touching PID 1.
const startScript = `
set -f
command -v tr >/dev/null && command -v grep >/dev/null || exit 125
chosen=$1
IFS= read -r procstat < /proc/$$/stat || exit 125
procstat=\${procstat##*) }
set -- $procstat
group=$3; session=$4
shift 19
started=$1
[ "$group" = "$$" ] && [ "$session" = "$$" ] || exit 125
printf '\\036HL_TERMINAL:%s:%s:%s\\037' "$HARBORLIGHT_TERMINAL_ID" "$$" "$started"
exec "$chosen" -i
`;

// A random per-exec environment marker plus the Linux process/session identity constrains cleanup.
// Children in the same terminal session are stopped, including a foreground program that ignores Ctrl-C.
// Explicitly detached jobs which start a new session and erase the marker are outside this terminal session.
const stopScript = `
token=$1; leader=$2; expected=$3
owned_session=
if [ -n "$leader" ] && [ "$leader" -gt 1 ] 2>/dev/null && [ -r "/proc/$leader/stat" ]; then
  IFS= read -r info < "/proc/$leader/stat" || info=
  tail=\${info##*) }; set -- $tail
  sid=$4; shift 19
  if [ "$1" = "$expected" ] && [ "$sid" = "$leader" ]; then owned_session=$leader; fi
fi
for signal in TERM KILL; do
  for file in /proc/[0-9]*/stat; do
    [ -r "$file" ] || continue
    pid=\${file#/proc/}; pid=\${pid%/stat}
    [ "$pid" -gt 1 ] 2>/dev/null || continue
    [ "$pid" != "$$" ] || continue
    IFS= read -r info < "$file" || continue
    tail=\${info##*) }; set -- $tail
    sid=$4
    owned=false
    if [ -n "$owned_session" ] && [ "$sid" = "$owned_session" ]; then owned=true
    elif [ -r "/proc/$pid/environ" ] && tr '\\000' '\\n' < "/proc/$pid/environ" 2>/dev/null | grep -Fqx "HARBORLIGHT_TERMINAL_ID=$token"; then owned=true
    fi
    if [ "$owned" = true ]; then kill -"$signal" "$pid" 2>/dev/null || :; fi
  done
  [ "$signal" != TERM ] || sleep 0.15
done
`;

class ContainerSession implements TerminalHandle {
  private socket?: Socket;
  private execId?: string;
  private identity?: { pid: string; started: string };
  private readonly token = randomBytes(24).toString('hex');
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  private ended = false;
  private closingRequested = false;
  private initial = Buffer.alloc(0);
  private paused = false;
  private resolveHandshake?: () => void;
  private rejectHandshake?: (error: Error) => void;
  constructor(private engine: Engine, private service: Service, private container: ContainerInfo, private options: TerminalOpenOptions, private callbacks: TerminalCallbacks) {}
  async start() {
    this.opening = this.initialize();
    try { await this.opening; }
    catch (error) {
      try { await this.close(); }
      catch { throw Object.assign(new Error('The terminal could not be opened or safely stopped.'), { terminalCleanupFailed: true }); }
      throw error;
    }
  }
  private async initialize() {
    if (this.options.signal.aborted) throw new Error('Terminal opening was cancelled.');
    assertOwned(this.service, await this.engine.container(this.container.Id), this.options.target);
    const created = await this.engine.json<{Id:string}>('POST', `/containers/${this.container.Id}/exec`, {
      AttachStdin:true, AttachStdout:true, AttachStderr:true, Tty:true, Privileged:false,
      Env:[`HARBORLIGHT_TERMINAL_ID=${this.token}`, 'TERM=xterm-256color'],
      Cmd:['/bin/sh','-c',startScript,'harborlight-terminal',this.options.shell === 'bash' ? '/bin/bash' : '/bin/sh']
    });
    if (!dockerId.test(created.Id)) throw new Error('Docker returned an invalid terminal identity.');
    this.execId = created.Id;
    if (this.options.signal.aborted) throw new Error('Terminal opening was cancelled.');
    const attached = await this.engine.attach(this.execId);
    this.socket = attached.socket;
    const handshake = new Promise<void>((resolve,reject) => { this.resolveHandshake=resolve; this.rejectHandshake=reject; });
    const timer = setTimeout(() => this.rejectHandshake?.(new Error('The image needs sh, tr, grep and a Linux /proc filesystem for a managed terminal.')), 5000);
    this.socket.on('data', data => this.output(data));
    this.socket.on('error', () => { this.rejectHandshake?.(new Error('The Docker terminal stream failed.')); if (!this.closingRequested) void this.finish(new Error('The Docker terminal stream failed.')); });
    this.socket.on('close', () => { this.rejectHandshake?.(new Error('The requested shell is unavailable or exited during startup.')); if (!this.closingRequested) void this.finish(); });
    if (attached.head.length) this.output(attached.head);
    try { await handshake; }
    finally { clearTimeout(timer); this.resolveHandshake=undefined; this.rejectHandshake=undefined; }
    if (this.options.signal.aborted) throw new Error('Terminal opening was cancelled.');
    const inspected = await this.engine.exec(this.execId);
    if (inspected.ContainerID !== this.container.Id || !inspected.Running) throw new Error('The requested shell exited during startup.');
    await this.resize(this.options.cols, this.options.rows);
    if (this.paused) this.socket.pause();
  }
  private output(data: Buffer) {
    if (this.closingRequested) return;
    if (!this.identity) {
      this.initial = Buffer.concat([this.initial,data]);
      if (this.initial.length > 8192) { this.rejectHandshake?.(new Error('The terminal startup response was invalid.')); return; }
      const end = this.initial.indexOf(0x1f);
      if (end < 0) return;
      const frame = this.initial.subarray(0,end).toString('ascii');
      const match = new RegExp(`^\\x1eHL_TERMINAL:${this.token}:([1-9][0-9]{0,9}):([0-9]{1,20})$`).exec(frame);
      if (!match || Number(match[1]) < 2) { this.rejectHandshake?.(new Error('Docker could not establish a managed terminal session.')); return; }
      this.identity = {pid:match[1],started:match[2]};
      const remainder = this.initial.subarray(end+1); this.initial=Buffer.alloc(0);
      this.resolveHandshake?.();
      if (remainder.length) this.callbacks.output(remainder);
    } else this.callbacks.output(data);
  }
  write(data: Buffer) {
    if (!this.socket || !this.identity || this.closingRequested || this.socket.destroyed) throw new Error('The terminal is closed.');
    return new Promise<void>((resolve,reject) => this.socket!.write(data, error => error ? reject(new Error('Terminal input could not be delivered.')) : resolve()));
  }
  async resize(cols: number, rows: number) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 300 || rows < 5 || rows > 150) throw new Error('Invalid terminal dimensions.');
    if (!this.execId || this.closingRequested) return;
    await this.engine.json('POST', `/exec/${this.execId}/resize?h=${rows}&w=${cols}`);
  }
  pause() { this.paused=true; this.socket?.pause(); }
  resume() { this.paused=false; this.socket?.resume(); }
  async verify() {
    if (this.closingRequested || !this.execId) throw new Error('The terminal is closed.');
    assertOwned(this.service,await this.engine.container(this.container.Id),this.options.target);
    const exec=await this.engine.exec(this.execId);
    if(exec.ContainerID!==this.container.Id || !exec.Running) { await this.finish(); throw new Error('The terminal process has exited.'); }
  }
  close(): Promise<void> {
    if(this.closing) return this.closing;
    this.closingRequested=true;
    this.rejectHandshake?.(new Error('Terminal opening was cancelled.'));
    this.closing=this.stop().catch(error=>{this.closing=undefined;throw error;});
    return this.closing;
  }
  private async stop() {
    await this.opening?.catch(()=>{});
    try {
      if (!this.execId) return;
      let container:ContainerInfo;
      try { container=await this.engine.container(this.container.Id); }
      catch(error) { if(error instanceof EngineError && error.statusCode===404)return; throw error; }
      if(container.Config.Labels?.[managed]!=='true'||container.Config.Labels?.[serviceLabel]!==this.service.id)throw new Error('Refusing terminal cleanup on an unowned container.');
      if(!container.State.Running)return;
      const cleanup=await this.engine.json<{Id:string}>('POST',`/containers/${container.Id}/exec`,{AttachStdin:false,AttachStdout:false,AttachStderr:false,Tty:false,Privileged:false,Cmd:['/bin/sh','-c',stopScript,'harborlight-terminal-cleanup',this.token,this.identity?.pid||'',this.identity?.started||'']});
      if(!dockerId.test(cleanup.Id))throw new Error('Docker returned an invalid cleanup identity.');
      await this.engine.json('POST',`/exec/${cleanup.Id}/start`,{Detach:true,Tty:false});
      const deadline=Date.now()+7000;
      while(Date.now()<deadline) {
        const [original,cleaner]=await Promise.all([this.engine.exec(this.execId),this.engine.exec(cleanup.Id)]);
        if(!original.Running&&!cleaner.Running) { if(cleaner.ExitCode!==0)throw new Error('The container could not clean up its terminal session.'); return; }
        await delay(75);
      }
      throw new Error('The terminal process could not be stopped. Check the selected container before retrying.');
    } finally { this.socket?.destroy(); }
  }
  private async finish(error?: Error) {
    if(this.ended)return; this.ended=true;
    let code:number|null=null;
    try { if(this.execId)code=(await this.engine.exec(this.execId)).ExitCode; await this.close(); }
    catch(cleanupError) { error=cleanupError as Error; }
    if(error)this.callbacks.error(error);
    else this.callbacks.exit(code);
  }
}

export class DockerTerminalRuntime implements TerminalRuntime {
  private async selected(service: Service, target?: string) {
    if(!uuid.test(service.id)||!uuid.test(service.projectId))throw new Error('Invalid service identity.');
    const engine=await Engine.connect();
    if(service.kind!=='compose') {
      if(target&&target!=='main')throw new Error('Invalid terminal target.');
      const container=await engine.container(`hl-${service.id}`);assertOwned(service,container,'main');
      return {engine,containers:[container]};
    }
    if(target&&!/^[a-z][a-z0-9_-]*$/.test(target))throw new Error('Invalid Compose terminal target.');
    const filters=encodeURIComponent(JSON.stringify({label:[`${managed}=true`,`${serviceLabel}=${service.id}`,`com.docker.compose.project=hl-${service.id}`]}));
    const summaries=await engine.json<{Id:string}[]>('GET',`/containers/json?all=0&filters=${filters}`);
    const containers:ContainerInfo[]=[];
    for(const summary of summaries) {
      const container=await engine.container(summary.Id);
      if(container.Config.Labels?.['com.docker.compose.oneoff']?.toLowerCase()==='true')continue;
      if(target&&container.Config.Labels?.['com.docker.compose.service']!==target)continue;
      assertOwned(service,container,target);containers.push(container);
    }
    return {engine,containers};
  }
  async targets(service:Service):Promise<TerminalTarget[]> {
    const {containers}=await this.selected(service);
    const targets=containers.map(container=>({id:service.kind==='compose'?container.Config.Labels!['com.docker.compose.service']:'main',name:service.kind==='compose'?container.Config.Labels!['com.docker.compose.service']:service.name}));
    if(new Set(targets.map(target=>target.id)).size!==targets.length)throw new Error('Multiple containers match a Compose target; terminal selection is ambiguous.');
    return targets.sort((a,b)=>a.name.localeCompare(b.name));
  }
  async open(service:Service,options:TerminalOpenOptions,callbacks:TerminalCallbacks):Promise<TerminalHandle> {
    if(!['sh','bash'].includes(options.shell))throw new Error('Unsupported terminal shell.');
    const {engine,containers}=await this.selected(service,options.target);
    if(containers.length!==1)throw new Error('Choose exactly one running managed container.');
    const session=new ContainerSession(engine,structuredClone(service),containers[0],options,callbacks);
    const abort=()=>{void session.close().catch(error=>callbacks.error(error as Error));};
    options.signal.addEventListener('abort',abort,{once:true});
    try { await session.start(); if(options.signal.aborted){await session.close();throw new Error('Terminal opening was cancelled.');} return session; }
    catch(error) { options.signal.removeEventListener('abort',abort); throw error; }
  }
}
