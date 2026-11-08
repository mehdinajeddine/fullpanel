import type { RuntimeMode } from './types.js';

/** Docker CPU convention: 100% is one logical core. Network counters are cumulative bytes, not a rate. */
export interface MetricValues {
  cpuPercent: number | null;
  memoryUsedBytes: number | null;
  memoryLimitBytes: number | null;
  networkRxBytes: number | null;
  networkTxBytes: number | null;
}
export interface ServiceContainerMetrics extends MetricValues {
  id: string;
  name: string;
  state: 'running' | 'paused' | 'restarting' | 'stopped' | 'unavailable';
  runtimeStartedAt?: string;
  sampledAt: string | null;
}
export interface ServiceMetrics {
  mode: RuntimeMode;
  serviceId: string;
  state: 'available' | 'partial' | 'stopped' | 'not-deployed' | 'unavailable';
  /** Last actual measurement; null when no measurement was available. Cache hits never update it. */
  sampledAt: string | null;
  checkedAt: string;
  containers: ServiceContainerMetrics[];
  /** A total is null if any selected member lacks that measurement, including stopped members. */
  totals: MetricValues;
  message?: string;
}
