import { z } from 'zod';
import type { Domain } from '../shared/types.js';
import type { ProxyAuthMap } from '../shared/proxy.js';

const hostname = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
export const domainInput = z.object({
  id: z.string().uuid().optional(),
  hostname: z.string().max(253).regex(hostname).transform(value => value.toLowerCase()),
  port: z.number().int().min(1).max(65535),
  https: z.boolean().default(true),
  path: z.string().max(200).regex(/^\/[a-zA-Z0-9_./~-]*$/)
    .refine(value => !value.includes('//') && !value.split('/').some(part => part === '.' || part === '..'), 'Use a path without repeated slashes or dot segments.')
    .transform(value => value === '/' ? value : value.replace(/\/$/, '')).default('/'),
  primary: z.boolean().optional(),
  upstreamScheme: z.enum(['http', 'https']).optional(),
  stripPrefix: z.boolean().optional(),
  redirectToHttps: z.boolean().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.redirectToHttps && !value.https) ctx.addIssue({ code: 'custom', path: ['redirectToHttps'], message: 'Enable HTTPS before redirecting HTTP requests.' });
  if (value.hostname.startsWith('*.') && value.https) ctx.addIssue({ code: 'custom', path: ['https'], message: 'Wildcard HTTPS requires DNS certificate validation, which the bundled proxy does not configure. Use HTTP or an exact hostname.' });
  if (value.hostname.startsWith('*.') && value.primary) ctx.addIssue({ code: 'custom', path: ['primary'], message: 'Choose an exact hostname as the primary domain.' });
  if (value.stripPrefix && value.path === '/') ctx.addIssue({ code: 'custom', path: ['stripPrefix'], message: 'Choose a non-root path before stripping its prefix.' });
});

/** Only validated domain data enters this renderer; no expression or label input is accepted. */
export function proxyLabels(domains: Domain[], serviceId: string, auth: ProxyAuthMap = {}): string[] {
  const labels: string[] = [];
  const add = (key: string, value: string | number) => labels.push('--label', `traefik.http.${key}=${value}`);
  for (const domain of domains) {
    // Validate again at the runtime boundary, including callers outside the HTTP API.
    const config = domainInput.parse(domain);
    if (!config.id) throw new Error('A saved route identifier is required.');
    const route = `hl-${serviceId}-${config.id}`;
    const wildcard = config.hostname.startsWith('*.');
    const host = wildcard
      ? `HostRegexp(\`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.${config.hostname.slice(2).replaceAll('.', '\\.')}$\`)`
      : `Host(\`${config.hostname}\`)`;
    const pathRule = config.path === '/' ? '' : ` && (Path(\`${config.path}\`) || PathPrefix(\`${config.path}/\`))`;
    const rule = host + pathRule;
    // Explicit hostnames win over wildcards; more specific paths win within a hostname.
    const priority = (wildcard ? 10000 : 20000) + config.path.length;
    add(`routers.${route}.rule`, rule);
    add(`routers.${route}.priority`, priority);
    add(`routers.${route}.entrypoints`, config.https ? 'websecure' : 'web');
    add(`routers.${route}.service`, route);
    add(`services.${route}.loadbalancer.server.port`, config.port);
    add(`services.${route}.loadbalancer.server.scheme`, config.upstreamScheme || 'http');
    const middlewares: string[] = [];
    const credential = auth[config.id];
    if (credential) {
      if (!/^[a-zA-Z0-9_.@-]{1,64}$/.test(credential.username) || !/^\$2[aby]\$\d{2}\$[./a-zA-Z0-9]{53}$/.test(credential.passwordHash)) throw new Error('Invalid stored proxy credentials.');
      const middleware = `${route}-auth`;
      add(`middlewares.${middleware}.basicauth.users`, `${credential.username}:${credential.passwordHash}`);
      add(`middlewares.${middleware}.basicauth.removeheader`, 'true');
      middlewares.push(middleware);
    }
    if (config.stripPrefix) {
      const middleware = `${route}-strip`;
      add(`middlewares.${middleware}.stripprefix.prefixes`, config.path);
      middlewares.push(middleware);
    }
    if (middlewares.length) add(`routers.${route}.middlewares`, middlewares.join(','));
    if (config.https) {
      add(`routers.${route}.tls`, 'true');
      add(`routers.${route}.tls.certresolver`, 'letsencrypt');
      if (config.redirectToHttps) {
        const redirect = `${route}-redirect`;
        add(`routers.${redirect}.rule`, rule);
        add(`routers.${redirect}.priority`, priority);
        add(`routers.${redirect}.entrypoints`, 'web');
        add(`routers.${redirect}.service`, 'noop@internal');
        add(`routers.${redirect}.middlewares`, redirect);
        add(`middlewares.${redirect}.redirectscheme.scheme`, 'https');
        add(`middlewares.${redirect}.redirectscheme.permanent`, 'true');
      }
    }
  }
  return labels;
}
