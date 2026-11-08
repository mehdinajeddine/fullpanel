#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const help = `Harborlight CLI — JSON on stdout, errors on stderr

Set HARBORLIGHT_URL and HARBORLIGHT_API_KEY in your environment.
Create a scoped API key in the panel; never pass it as a command argument.

Usage:
  harborlight projects
  harborlight services [project-id]
  harborlight inspect <service-id>
  harborlight deploy <service-id> [--force] [--wait]
  harborlight logs <service-id> [--tail 200]
  harborlight action <service-id> <start|stop|restart>

Options: --url <base-url>, --timeout <seconds> (default 600), --help
Deploy --wait exits with failure if the deployment fails or times out.
`;

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export async function runCli(args, environment = process.env, transport = fetch) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    url: { type: 'string' }, timeout: { type: 'string', default: '600' },
    tail: { type: 'string', default: '200' }, force: { type: 'boolean' }, wait: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help || positionals.length === 0) return { help };
  const [operation, id, action] = positionals;
  const counts = { projects: [1], services: [1, 2], inspect: [2], deploy: [2], logs: [2], action: [3] };
  if (!counts[operation]?.includes(positionals.length)) throw new Error('Invalid command or argument count. Run with --help.');
  if (id && !uuid.test(id)) throw new Error('Use a valid project or service UUID.');
  if (operation === 'action' && !['start', 'stop', 'restart'].includes(action)) throw new Error('Action must be start, stop or restart.');
  if ((values.force || values.wait) && operation !== 'deploy') throw new Error('--force and --wait apply only to deploy.');
  const timeout = Number(values.timeout), tail = Number(values.tail);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) throw new Error('Timeout must be 1–3600 seconds.');
  if (!Number.isInteger(tail) || tail < 1 || tail > 2000) throw new Error('Tail must be 1–2000 lines.');
  const token = environment.HARBORLIGHT_API_KEY;
  if (!/^hl_[a-zA-Z0-9_-]{43}$/.test(token || '')) throw new Error('Set HARBORLIGHT_API_KEY to a valid scoped API key.');
  let base;
  try { base = new URL(values.url || environment.HARBORLIGHT_URL || 'http://127.0.0.1:3000'); } catch { throw new Error('Set a valid HARBORLIGHT_URL or --url.'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Use an HTTP(S) origin without credentials, path, query or fragment.');
  const deadline = Date.now() + timeout * 1000;
  async function request(path, method = 'GET', body) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Operation timed out. The server-side job may still be running.');
    const response = await transport(new URL(path, base), { method, redirect: 'error', signal: AbortSignal.timeout(Math.min(30000, remaining)), headers: {
      Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    let result;
    try { result = JSON.parse(text); } catch { throw new Error(`Server returned a non-JSON response (HTTP ${response.status}).`); }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${String(result.error || 'Request failed').split(token).join('[REDACTED]').slice(0, 2000)}`);
    return result;
  }
  if (operation === 'projects') return request('/api/projects');
  if (operation === 'services') return request(`/api/services${id ? `?projectId=${id}` : ''}`);
  if (operation === 'inspect') return request(`/api/services/${id}`);
  if (operation === 'logs') return request(`/api/services/${id}/logs?tail=${tail}`);
  if (operation === 'action') return request(`/api/services/${id}/${action}`, 'POST', {});
  let deployment = await request(`/api/services/${id}/deploy`, 'POST', { forceRebuild: !!values.force });
  if (!values.wait) return deployment;
  while (deployment.status === 'running' || deployment.status === 'queued') {
    if (Date.now() >= deadline) throw new Error(`Deployment ${deployment.id} is still running after the timeout.`);
    await new Promise(resolve => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
    deployment = await request(`/api/deployments/${deployment.id}`);
  }
  if (deployment.status !== 'success') throw new Error(`Deployment ${deployment.id} failed. Inspect its output in the panel.`);
  return deployment;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runCli(process.argv.slice(2));
    process.stdout.write(result?.help || `${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    // Transport exceptions can include request details in their cause: print only a bounded message.
    const message = String(error?.message || 'Request failed').split(process.env.HARBORLIGHT_API_KEY || '\0').join('[REDACTED]');
    process.stderr.write(`${JSON.stringify({ error: message.slice(0, 2000) })}\n`);
    process.exitCode = 1;
  }
}
