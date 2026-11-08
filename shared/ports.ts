import type { RuntimeMode } from './types.js';

export interface ListeningPort {
  port: number;
  protocol: 'tcp';
  address: string;
  family: 'ipv4' | 'ipv6';
  scope: 'wildcard' | 'loopback' | 'interface';
}
/** Container metadata (image EXPOSE, --expose, or published targets): never proof of a listener. */
export interface ExposedPort { port: number; protocol: 'tcp' | 'udp' }
export interface ServicePorts {
  mode: RuntimeMode;
  serviceId: string;
  state: 'available' | 'partial' | 'stopped' | 'not-deployed' | 'unavailable' | 'unsupported';
  sampledAt: string | null;
  checkedAt: string;
  listeners: ListeningPort[];
  exposed: ExposedPort[];
  message?: string;
}
