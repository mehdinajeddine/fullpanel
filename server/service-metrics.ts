import type { RuntimeMode, Service } from '../shared/types.js';
import type { ServiceMetrics } from '../shared/metrics.js';
import { emptyMetricValues } from './docker-metrics.js';

/** Small per-process cache. No persistent history, background polling, or unbounded work queue. */
export class ServiceMetricsCache {
  private entries = new Map<string, { key: string; expires: number; value: ServiceMetrics }>();
  private pending = new Map<string, { key: string; promise: Promise<ServiceMetrics> }>();
  constructor(private readonly collect: ((service: Service) => Promise<ServiceMetrics>) | undefined, private readonly mode: RuntimeMode, private readonly clock = Date.now, private readonly ttl = 5000, private readonly capacity = 128, private readonly concurrency = 8) {}
  invalidate(serviceId: string) { this.entries.delete(serviceId); const pending = this.pending.get(serviceId); if (pending) pending.key = ''; }
  clear() { this.entries.clear(); for (const pending of this.pending.values()) pending.key = ''; }
  async get(service: Service): Promise<ServiceMetrics> {
    const time = this.clock();
    for (const [id, entry] of this.entries) if (entry.expires <= time) this.entries.delete(id);
    const key = JSON.stringify([service.id, service.projectId, service.kind, service.containerId, service.deployedAt, service.status]);
    const cached = this.entries.get(service.id);
    if (cached?.key === key) return structuredClone(cached.value);
    const pending = this.pending.get(service.id);
    if (pending?.key === key) return structuredClone(await pending.promise);
    const unavailable = (): ServiceMetrics => ({ mode: this.mode, serviceId: service.id, state: 'unavailable', sampledAt: null, checkedAt: new Date(this.clock()).toISOString(), containers: [], totals: emptyMetricValues(), message: 'Service measurements are temporarily unavailable.' });
    if (pending || this.pending.size >= this.concurrency || !this.collect) return unavailable();
    const entry = { key, promise: Promise.resolve(undefined as unknown as ServiceMetrics) };
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
