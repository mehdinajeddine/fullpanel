import type { Service } from '../shared/types.js';
import type { ExposedPort, ListeningPort, ServicePorts } from '../shared/ports.js';

type Runner = (binary: string, args: string[], options?: { timeout?: number }) => Promise<string>;
type Inspect = { Id: string; Name: string; Config: { Labels?: Record<string, string>; ExposedPorts?: Record<string, unknown> }; State: { Status: string; StartedAt?: string } };
const exactId = /^[a-f0-9]{64}$/;
const inspectFormat = '{"Id":{{json .Id}},"Name":{{json .Name}},"Config":{"Labels":{{json .Config.Labels}},"ExposedPorts":{{json .Config.ExposedPorts}}},"State":{"Status":{{json .State.Status}},"StartedAt":{{json .State.StartedAt}}}}';

function address(hex: string, family: ListeningPort['family']): Pick<ListeningPort, 'address' | 'scope'> {
  const bytes: number[] = [];
  // /proc/net/tcp{,6} prints each native 32-bit word in little-endian order on our ARM64/x86_64 hosts.
  for (let offset = 0; offset < hex.length; offset += 8) for (let byte = 6; byte >= 0; byte -= 2) bytes.push(Number.parseInt(hex.slice(offset + byte, offset + byte + 2), 16));
  if (family === 'ipv4') return { address: bytes.join('.'), scope: bytes.every(value => value === 0) ? 'wildcard' : bytes[0] === 127 ? 'loopback' : 'interface' };
  const mapped = bytes.slice(0, 10).every(value => value === 0) && bytes[10] === 255 && bytes[11] === 255;
  if (mapped) return { address: `::ffff:${bytes.slice(12).join('.')}`, scope: bytes[12] === 127 ? 'loopback' : 'interface' };
  const groups = Array.from({ length: 8 }, (_, index) => (bytes[index * 2] * 256 + bytes[index * 2 + 1]).toString(16));
  let bestStart = -1, bestLength = 1;
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== '0') { index++; continue; }
    const start = index; while (groups[index] === '0') index++;
    if (index - start > bestLength) { bestStart = start; bestLength = index - start; }
  }
  const formatted = bestStart < 0 ? groups.join(':') : `${groups.slice(0, bestStart).join(':')}::${groups.slice(bestStart + bestLength).join(':')}`;
  return { address: formatted, scope: bytes.every(value => value === 0) ? 'wildcard' : bytes.slice(0, 15).every(value => value === 0) && bytes[15] === 1 ? 'loopback' : 'interface' };
}

/** Reject incomplete/truncated tables instead of treating a partial parse as exhaustive. */
export function parseProcTcp(text: string, family: ListeningPort['family']): ListeningPort[] {
  if (Buffer.byteLength(text) > 1_900_000 || !text.endsWith('\n') || text.includes('\0')) throw Error('Invalid socket table.');
  const lines = text.trimEnd().split('\n');
  const header = lines.shift()?.trim().split(/\s+/);
  if (!header || header[0] !== 'sl' || header[1] !== 'local_address' || !['rem_address', 'remote_address'].includes(header[2]) || header[3] !== 'st' || !header.includes('uid') || !header.includes('inode')) throw Error('Missing socket table header.');
  const endpoint = new RegExp(`^[0-9A-Fa-f]{${family === 'ipv4' ? 8 : 32}}:[0-9A-Fa-f]{4}$`);
  const listeners: ListeningPort[] = [];
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || !/^\d+:$/.test(fields[0]) || !endpoint.test(fields[1]) || !endpoint.test(fields[2]) || !/^[0-9A-Fa-f]{2}$/.test(fields[3]) || !/^[0-9A-Fa-f]{8}:[0-9A-Fa-f]{8}$/.test(fields[4]) || !/^[0-9A-Fa-f]{2}:[0-9A-Fa-f]{8}$/.test(fields[5]) || !/^[0-9A-Fa-f]{8}$/.test(fields[6]) || !fields.slice(7, 10).every(value => /^\d+$/.test(value))) throw Error('Invalid socket table row.');
    if (fields[3].toUpperCase() !== '0A') continue;
    const [hex, hexPort] = fields[1].split(':'), port = Number.parseInt(hexPort, 16);
    if (!port) throw Error('Invalid listening port.');
    listeners.push({ port, protocol: 'tcp', family, ...address(hex, family) });
    if (listeners.length > 2048) throw Error('Socket table exceeds inspection limits.');
  }
  const unique = [...new Map(listeners.map(listener => [`${listener.family}/${listener.address}/${listener.port}`, listener])).values()];
  return unique.sort((a, b) => a.port - b.port || a.family.localeCompare(b.family) || a.address.localeCompare(b.address));
}
export function declaredPorts(value: unknown): ExposedPort[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value).flatMap(key => { const match = /^([1-9][0-9]{0,4})\/(tcp|udp)$/.exec(key); return match && Number(match[1]) <= 65535 ? [{ port: Number(match[1]), protocol: match[2] as 'tcp' | 'udp' }] : []; }).sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol));
}
function owned(service: Service, container: Inspect) {
  const labels = container.Config?.Labels || {};
  return exactId.test(container.Id) && container.Name === `/hl-${service.id}` && labels['io.harborlight.managed'] === 'true' && labels['io.harborlight.service'] === service.id && labels['io.harborlight.project'] === service.projectId && (!service.containerId || container.Id === service.containerId);
}
export async function collectDockerServicePorts(service: Service, run: Runner, clock = () => new Date().toISOString()): Promise<ServicePorts> {
  const result = (state: ServicePorts['state'], message?: string): ServicePorts => ({ mode: 'docker', serviceId: service.id, state, sampledAt: null, checkedAt: clock(), listeners: [], exposed: [], ...(message ? { message } : {}) });
  const unavailable = () => result('unavailable', 'Port inspection is unavailable. Check the managed runtime and container tools.');
  if (service.kind === 'compose') return result('unsupported', 'Compose child port inspection is not supported yet.');
  if (service.runtimeUncertain || service.containerId && !exactId.test(service.containerId)) return unavailable();
  const inspect = async (id: string): Promise<Inspect> => JSON.parse(await run('docker', ['container', 'inspect', '--format', inspectFormat, id], { timeout: 5000 }));
  try {
    let before: Inspect;
    try { before = await inspect(`hl-${service.id}`); }
    catch (error) { if (/No such (container|object)/i.test(String(error)) && !service.deployedAt && !service.containerId) return result('not-deployed'); throw error; }
    if (!owned(service, before)) return unavailable();
    const exposed = declaredPorts(before.Config.ExposedPorts);
    if (['exited', 'created', 'dead'].includes(before.State.Status)) return { ...result('stopped'), exposed };
    if (before.State.Status !== 'running') return { ...unavailable(), exposed };
    const tables = await Promise.allSettled((['ipv4', 'ipv6'] as const).map(async family => ({ family, listeners: parseProcTcp(await run('docker', ['exec', before.Id, 'cat', family === 'ipv4' ? '/proc/net/tcp' : '/proc/net/tcp6'], { timeout: 5000 }), family) })));
    const sampledAt = clock();
    const after = await inspect(before.Id);
    if (!owned(service, after) || after.Id !== before.Id || after.State.Status !== 'running' || after.State.StartedAt !== before.State.StartedAt) return result('unavailable', 'The runtime changed during inspection. Refresh before choosing a port.');
    const available = tables.flatMap(table => table.status === 'fulfilled' ? [table.value] : []);
    if (!available.length) return { ...unavailable(), exposed };
    const partial = available.length !== 2;
    return { ...result(partial ? 'partial' : 'available', partial ? 'Only one IP socket table was readable. IPv6 may be disabled or container tools may be missing; results are incomplete.' : undefined), sampledAt, exposed, listeners: available.flatMap(table => table.listeners).sort((a, b) => a.port - b.port || a.family.localeCompare(b.family) || a.address.localeCompare(b.address)) };
  } catch { return unavailable(); }
}
