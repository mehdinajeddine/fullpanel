import type { RuntimeMode, Service } from '../shared/types.js';
import type { ServicePorts } from '../shared/ports.js';

export function unavailablePorts(mode: RuntimeMode, serviceId: string, checkedAt = new Date().toISOString()): ServicePorts { return { mode, serviceId, state: 'unavailable', sampledAt: null, checkedAt, listeners: [], exposed: [], message: 'Port inspection is temporarily unavailable or the runtime changed. Refresh before choosing a port.' }; }
/** Bounded, on-demand cache; no scanner, background polling, or persistent observation history. */
export class ServicePortsCache {
  private entries = new Map<string, { key: string; expires: number; value: ServicePorts }>();
  private pending = new Map<string, { key: string; promise: Promise<ServicePorts> }>();
  constructor(private readonly collect: ((service: Service) => Promise<ServicePorts>) | undefined, private readonly mode: RuntimeMode, private readonly clock = Date.now, private readonly ttl = 5000, private readonly capacity = 128, private readonly concurrency = 8) {}
  invalidate(serviceId: string) { this.entries.delete(serviceId); const pending = this.pending.get(serviceId); if (pending) pending.key = ''; }
  clear() { this.entries.clear(); for (const pending of this.pending.values()) pending.key = ''; }
  async get(service: Service): Promise<ServicePorts> {
    const time = this.clock();
    for (const [id, entry] of this.entries) if (entry.expires <= time) this.entries.delete(id);
    const key = JSON.stringify([service.id, service.projectId, service.kind, service.containerId, service.deployedAt, service.status, service.runtimeUncertain]);
    const cached = this.entries.get(service.id);
    if (cached?.key === key) return structuredClone(cached.value);
    const pending = this.pending.get(service.id);
    if (pending?.key === key) return structuredClone(await pending.promise);
    const unavailable = () => unavailablePorts(this.mode, service.id, new Date(this.clock()).toISOString());
    if (pending || this.pending.size >= this.concurrency || !this.collect) return unavailable();
    const entry = { key, promise: Promise.resolve(undefined as unknown as ServicePorts) };
    entry.promise = Promise.resolve().then(() => this.collect!(structuredClone(service))).catch(unavailable).then(value => {
      if (entry.key !== key) return unavailable();
      while (this.entries.size >= this.capacity) this.entries.delete(this.entries.keys().next().value!);
      this.entries.set(service.id, { key, expires: this.clock() + this.ttl, value: structuredClone(value) });
      return value;
    }).finally(() => { if (this.pending.get(service.id) === entry) this.pending.delete(service.id); });
    this.pending.set(service.id, entry);
    return structuredClone(await entry.promise);
  }
}
