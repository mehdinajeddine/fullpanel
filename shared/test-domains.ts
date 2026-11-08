/** Ordinary public IPv4 destinations only; no DNS lookup or address discovery occurs here.
 * Special-use exclusions follow https://www.iana.org/assignments/iana-ipv4-special-registry/.
 * Protocol/anycast reservations are deliberately excluded from server test addresses as well.
 */
export function isPublicTestDomainIp(value: string): boolean {
  if (!/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(value)) return false;
  const octets = value.split('.').map(Number);
  if (octets.some(part => part > 255) || octets.join('.') !== value) return false;
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 31 && c === 196 || b === 52 && c === 193 || b === 88 && c === 99 || b === 175 && c === 48)) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113) return false;
  return true;
}

/** The UUID, rather than a mutable name, keeps the allocated hostname stable. */
export function testDomainHostname(serviceId: string, ip: string): string {
  if (serviceId.length !== 36 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(serviceId) || !isPublicTestDomainIp(ip)) throw new Error('A service UUID and a canonical public IPv4 address are required.');
  return `fp-${serviceId.replaceAll('-', '').toLowerCase()}.${ip.replaceAll('.', '-')}.sslip.io`;
}
