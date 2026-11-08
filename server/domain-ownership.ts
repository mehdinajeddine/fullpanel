import type { Service } from '../shared/types.js';

/** Wildcards match exactly one DNS label, matching the runtime proxy renderer. */
export function hostnamesOverlap(first: string, second: string): boolean {
  const normalize = (host: string) => host.trim().toLowerCase().replace(/\.$/, '');
  const a = normalize(first), b = normalize(second);
  if (a === b) return true;
  const covers = (wildcard: string, exact: string) => {
    if (!wildcard.startsWith('*.') || exact.startsWith('*.')) return false;
    const suffix = wildcard.slice(1);
    if (!exact.endsWith(suffix)) return false;
    const label = exact.slice(0, -suffix.length);
    return !!label && !label.includes('.');
  };
  return covers(a, b) || covers(b, a);
}

/**
 * A project owns its hostnames across every path. Otherwise an operator could steal
 * another project's traffic with a longer path or a more specific wildcard rule.
 */
export function assertDomainOwnership(candidate: Pick<Service, 'id' | 'projectId' | 'domains'>, services: Pick<Service, 'id' | 'projectId' | 'domains'>[], reservedHostnames: string[]) {
  const conflict = (message: string) => Object.assign(new Error(message), { statusCode: 409 });
  for (const domain of candidate.domains) {
    if (reservedHostnames.filter(Boolean).some(hostname => hostnamesOverlap(domain.hostname, hostname))) throw conflict('This hostname is reserved for the control panel.');
    if (services.some(service => service.id !== candidate.id && service.projectId !== candidate.projectId && service.domains.some(existing => hostnamesOverlap(domain.hostname, existing.hostname)))) throw conflict('This hostname is already assigned to another project.');
  }
}
