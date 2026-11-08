import type { Service } from '../shared/types.js';
import type { MetricValues, ServiceContainerMetrics, ServiceMetrics } from '../shared/metrics.js';
import { parse } from 'yaml';

export const emptyMetricValues = (): MetricValues => ({ cpuPercent: null, memoryUsedBytes: null, memoryLimitBytes: null, networkRxBytes: null, networkTxBytes: null });
const fields = Object.keys(emptyMetricValues()) as (keyof MetricValues)[];
const finite = (value: number) => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
export function parseDockerBytes(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*(B|kB|KB|MB|GB|TB|PB|KiB|MiB|GiB|TiB|PiB)$/.exec(value.trim());
  if (!match) return null;
  const units: Record<string, number> = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4, PiB: 1024 ** 5 };
  const amount = finite(Number(match[1]) * units[match[2]]);
  return amount === null ? null : Math.round(amount);
}
export function parseDockerPercent(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[0-9]+(?:\.[0-9]+)?%$/.test(value.trim())) return null;
  return finite(Number(value.trim().slice(0, -1)));
}
export function parseDockerStats(row: Record<string, unknown>): MetricValues {
  const pair = (value: unknown) => typeof value === 'string' && value.split('/').length === 2 ? value.split('/').map(parseDockerBytes) : [null, null];
  const [memoryUsedBytes, memoryLimitBytes] = pair(row.MemUsage), [networkRxBytes, networkTxBytes] = pair(row.NetIO);
  return { cpuPercent: parseDockerPercent(row.CPUPerc), memoryUsedBytes, memoryLimitBytes: memoryLimitBytes === 0 ? null : memoryLimitBytes, networkRxBytes, networkTxBytes };
}
export function summarizeServiceMetrics(serviceId: string, containers: ServiceContainerMetrics[], checkedAt: string): ServiceMetrics {
  const hasMeasurement = containers.some(container => fields.some(field => container[field] !== null));
  const complete = containers.length > 0 && containers.every(container => fields.every(field => container[field] !== null));
  const state = !containers.length ? 'not-deployed' : complete ? 'available' : hasMeasurement ? 'partial' : containers.every(container => container.state === 'stopped') ? 'stopped' : 'unavailable';
  const totals = emptyMetricValues();
  for (const field of fields) if (containers.length && containers.every(container => container[field] !== null)) totals[field] = finite(containers.reduce((sum, container) => sum + container[field]!, 0));
  const times = containers.flatMap(container => container.sampledAt ? [container.sampledAt] : []).sort();
  return { mode: 'docker', serviceId, state, sampledAt: times[0] || null, checkedAt, containers, totals, ...(state === 'partial' ? { message: 'Some container measurements are unavailable. Totals require a measurement from every member.' } : state === 'unavailable' ? { message: 'Container measurements are unavailable. The runtime may be changing or unreachable.' } : {}) };
}

type Inspect = { Id: string; Name: string; Config: { Labels?: Record<string, string> }; State: { Status: string; StartedAt?: string } };
type Runner = (binary: string, args: string[], options?: { timeout?: number }) => Promise<string>;
const inspectFormat = '{"Id":{{json .Id}},"Name":{{json .Name}},"Config":{"Labels":{{json .Config.Labels}}},"State":{{json .State}}}';
const exactId = /^[a-f0-9]{64}$/;
function composeMember(service: Service, container: Inspect): boolean {
  const labels = container.Config?.Labels || {}, child = labels['com.docker.compose.service'], number = labels['com.docker.compose.container-number'];
  return labels['com.docker.compose.project'] === `hl-${service.id}` && /^[a-z][a-z0-9_-]*$/.test(child || '') && /^[1-9][0-9]*$/.test(number || '') && labels['com.docker.compose.oneoff']?.toLowerCase() === 'false' && container.Name?.replace(/^\//, '') === `hl-${service.id}-${child}-${number}`;
}
function selected(service: Service, container: Inspect): boolean {
  const labels = container.Config?.Labels || {}, name = container.Name?.replace(/^\//, '');
  if (!exactId.test(container.Id) || labels['io.harborlight.managed'] !== 'true' || labels['io.harborlight.service'] !== service.id || labels['io.harborlight.project'] !== service.projectId) return false;
  if (service.kind !== 'compose') return name === `hl-${service.id}`;
  return composeMember(service, container);
}
function state(status: string): ServiceContainerMetrics['state'] {
  return status === 'running' || status === 'paused' || status === 'restarting' ? status : status === 'exited' || status === 'created' || status === 'dead' ? 'stopped' : 'unavailable';
}
export async function collectDockerServiceMetrics(service: Service, run: Runner, clock = () => new Date().toISOString()): Promise<ServiceMetrics> {
  const unavailable = (): ServiceMetrics => ({ mode: 'docker', serviceId: service.id, state: 'unavailable', sampledAt: null, checkedAt: clock(), containers: [], totals: emptyMetricValues(), message: 'Service measurements are unavailable. Check Docker connectivity and managed runtime ownership.' });
  const inspect = async (ids: string[]) => (await run('docker', ['container', 'inspect', '--format', inspectFormat, ...ids], { timeout: 5000 })).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Inspect);
  try {
    let candidates: Inspect[];
    if (service.kind === 'compose') {
      const ids = (await run('docker', ['ps', '-aq', '--no-trunc', '--filter', `label=io.harborlight.service=${service.id}`, '--filter', `label=com.docker.compose.project=hl-${service.id}`], { timeout: 5000 })).trim().split('\n').filter(Boolean);
      if (ids.length > 64 || ids.some(id => !exactId.test(id))) return unavailable();
      candidates = ids.length ? await inspect(ids) : [];
    } else {
      try { candidates = await inspect([`hl-${service.id}`]); }
      catch (error) { if (/No such (container|object)/i.test(String(error))) candidates = []; else throw error; }
    }
    const owned = candidates.filter(container => selected(service, container));
    let incomplete = false;
    if (service.kind === 'compose') {
      const expected = Object.keys(parse(service.source.compose || '', { maxAliasCount: 25 })?.services || {});
      incomplete = candidates.some(container => composeMember(service, container) && !selected(service, container)) || expected.some(child => !owned.some(container => container.Config.Labels?.['com.docker.compose.service'] === child));
    }
    if (!candidates.length && (service.deployedAt || service.containerId)) return unavailable();
    if (candidates.length && !owned.length) return unavailable();
    const containers: ServiceContainerMetrics[] = owned.map(container => ({ id: container.Id, name: container.Name.replace(/^\//, ''), state: state(container.State.Status), ...(container.State.StartedAt && !container.State.StartedAt.startsWith('0001-') && Number.isFinite(Date.parse(container.State.StartedAt)) ? { runtimeStartedAt: container.State.StartedAt } : {}), sampledAt: null, ...emptyMetricValues() }));
    const running = owned.filter(container => container.State.Status === 'running');
    if (running.length) {
      try {
        const rows = (await run('docker', ['stats', '--no-trunc', '--no-stream', '--format', '{{json .}}', ...running.map(container => container.Id)], { timeout: 10000 })).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
        const sampledAt = clock();
        // A stop/restart/replacement during the sample invalidates those measurements.
        const verified = await inspect(running.map(container => container.Id));
        for (const container of containers) {
          if (container.state !== 'running') continue;
          const current = verified.find(item => item.Id === container.id);
          if (!current || !selected(service, current) || current.State.Status !== 'running' || current.State.StartedAt !== owned.find(item => item.Id === container.id)?.State.StartedAt) { container.state = current && selected(service, current) ? state(current.State.Status) : 'unavailable'; continue; }
          const matches = rows.filter(row => (row.ID || row.Container) === container.id);
          if (matches.length !== 1) continue;
          const values = parseDockerStats(matches[0]); Object.assign(container, values);
          if (fields.some(field => values[field] !== null)) container.sampledAt = sampledAt;
        }
      } catch { /* Unknown measurements stay null; never expose Docker stderr or synthesize zero. */ }
    }
    const result = summarizeServiceMetrics(service.id, containers, clock());
    if (incomplete && candidates.length) { result.state = result.sampledAt ? 'partial' : 'unavailable'; result.totals = emptyMetricValues(); result.message = 'Some expected Compose members could not be verified. Aggregate measurements are unavailable.'; }
    return result;
  } catch { return unavailable(); }
}
