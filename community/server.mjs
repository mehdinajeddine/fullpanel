import http from 'node:http';
import { constants, realpathSync } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRegistryRuntime, registryReadiness } from './registry-runtime.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repository = 'https://github.com/mehdinajeddine/fullpanel';
const mimeTypes = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8'
}));
const reserved = new Set(['/api/v1/community-domains', '/api/v1/community-domains/register']);
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function loadConfig(env = process.env) {
  const port = env.PORT === undefined ? 3000 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || env.PORT !== undefined && (!/^\d{1,5}$/.test(env.PORT) || /\s/.test(env.PORT))) throw new Error('PORT must be an integer from 0 to 65535.');
  const commit = env.COMMUNITY_RELEASE_COMMIT || null;
  if (commit !== null && (commit.length !== 40 || !/^[a-f0-9]{40}$/.test(commit))) throw new Error('COMMUNITY_RELEASE_COMMIT must be a complete lowercase Git commit SHA.');
  const trust = env.COMMUNITY_TRUST_HEROKU_PROXY || 'false';
  if (!['true', 'false'].includes(trust)) throw new Error('COMMUNITY_TRUST_HEROKU_PROXY must be true or false.');
  const canonicalHost = env.COMMUNITY_CANONICAL_HOST || null;
  if (canonicalHost !== null && (canonicalHost.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(canonicalHost) || /[\s\r\n]/.test(canonicalHost))) throw new Error('COMMUNITY_CANONICAL_HOST must be a lowercase DNS hostname without scheme, port or path.');
  if (trust === 'true' && !canonicalHost) throw new Error('Heroku proxy mode requires COMMUNITY_CANONICAL_HOST.');
  return Object.freeze({ port, commit, trustHerokuProxy: trust === 'true', canonicalHost });
}

export function publicInfo(config) {
  return {
    apiVersion: 'v1', name: 'FullPanel',
    openSource: { license: 'Apache-2.0', repository },
    links: { repository, issues: `${repository}/issues`, license: `${repository}/blob/main/LICENSE` },
    release: { commit: config.commit },
    communityDomains: { status: 'planned', registrationEnabled: false }
  };
}

function safePath(target) {
  if (!target || target.length > 2048 || !target.startsWith('/') || target.startsWith('//') || target.includes('#')) return null;
  const rawPath = target.split('?', 1)[0];
  if (/%(?:2f|5c)/i.test(rawPath)) return null;
  let decoded;
  try { decoded = decodeURIComponent(rawPath); } catch { return null; }
  if (!/^\/[A-Za-z0-9_./-]*$/.test(decoded) || decoded.includes('//') || decoded.split('/').some(part => part === '.' || part === '..' || part.startsWith('.'))) return null;
  return decoded;
}

function headers(response) {
  response.setHeader('Content-Security-Policy', csp);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Cache-Control', 'no-store');
}

function json(request, response, status, body, extra = {}) {
  const encoded = JSON.stringify(body) + '\n';
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(encoded), ...extra });
  response.end(request.method === 'HEAD' ? undefined : encoded);
}

function error(request, response, status, code, message, extra) {
  json(request, response, status, { error: { code, message } }, extra);
}

function refuseBody(response) {
  // Do not attach data listeners or buffer user-supplied bodies. Close instead of retaining unread input.
  response.shouldKeepAlive = false;
  response.setHeader('Connection', 'close');
}

async function staticFile(root, pathname) {
  const parts = (pathname === '/' ? '/index.html' : pathname).slice(1).split('/');
  let filename = root;
  for (const part of parts) {
    filename = join(filename, part);
    const info = await lstat(filename);
    if (info.isSymbolicLink()) return null;
  }
  const type = mimeTypes.get(extname(filename));
  if (!type || !(await realpath(filename)).startsWith(root + '/')) return null;
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 16 * 1024 * 1024) { await handle.close(); return null; }
    return { handle, info, type };
  } catch (cause) { await handle.close(); throw cause; }
}

export async function createCommunityServer({ publicDirectory = join(here, 'public'), config = loadConfig(), registry = null } = {}) {
  const rootInfo = await lstat(publicDirectory);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('The public directory must be a real directory.');
  const root = await realpath(publicDirectory);
  const isRegistryReady = registryReadiness(registry);
  const server = http.createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 10000, keepAliveTimeout: 5000 }, (request, response) => {
    headers(response);
    void respond(request, response).catch(() => {
      if (response.headersSent) response.destroy();
      else error(request, response, 500, 'INTERNAL_ERROR', 'The request could not be completed.');
    });
  });
  server.maxHeadersCount = 32;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 256;
  server.setTimeout(10000, socket => socket.destroy());
  server.on('checkContinue', (request, response) => {
    headers(response); refuseBody(response);
    error(request, response, 417, 'BODY_NOT_ACCEPTED', 'Request bodies are not accepted.');
  });
  server.on('checkExpectation', (request, response) => {
    headers(response); refuseBody(response);
    error(request, response, 417, 'BODY_NOT_ACCEPTED', 'Request bodies are not accepted.');
  });

  async function respond(request, response) {
    const pathname = safePath(request.url);
    if (pathname === null) { refuseBody(response); return error(request, response, 400, 'INVALID_PATH', 'Invalid request path.'); }
    const readable = request.method === 'GET' || request.method === 'HEAD';
    if (!readable) refuseBody(response);
    if (reserved.has(pathname)) return error(request, response, 503, 'COMMUNITY_DOMAINS_UNAVAILABLE', 'Community domain registration is planned and is not available.', { 'Retry-After': '86400' });
    const knownApi = ['/api/health', '/api/ready', '/api/v1/info'].includes(pathname);
    if (pathname.startsWith('/api/') && !knownApi || pathname === '/api') return error(request, response, 404, 'NOT_FOUND', 'Not found.');
    if (!readable) return error(request, response, 405, 'METHOD_NOT_ALLOWED', 'Only GET and HEAD are supported.', { Allow: 'GET, HEAD' });
    if (request.headers['transfer-encoding'] || request.headers['content-length'] && request.headers['content-length'] !== '0') {
      refuseBody(response); return error(request, response, 413, 'BODY_NOT_ACCEPTED', 'Request bodies are not accepted.');
    }
    if (config.trustHerokuProxy) {
      const protocol = request.headers['x-forwarded-proto'];
      if (protocol !== 'http' && protocol !== 'https') return error(request, response, 400, 'INVALID_PROXY_HEADERS', 'A verified proxy protocol is required.');
      if (protocol === 'http') {
        response.writeHead(308, { Location: `https://${config.canonicalHost}${request.url}`, 'Content-Length': '0' }); response.end(); return;
      }
      response.setHeader('Strict-Transport-Security', 'max-age=86400');
      if (request.headers.host?.toLowerCase() !== config.canonicalHost) return error(request, response, 421, 'MISDIRECTED_REQUEST', 'Use the configured canonical hostname.');
    }
    if (pathname === '/api/health') return json(request, response, 200, { status: 'ok', service: 'fullpanel-community' });
    if (pathname === '/api/ready') {
      if (await isRegistryReady()) return json(request, response, 200, { status: 'ready', service: 'fullpanel-community' });
      return error(request, response, 503, 'REGISTRY_UNAVAILABLE', 'The installation registry is not ready.', { 'Retry-After': '5' });
    }
    if (pathname === '/api/v1/info') return json(request, response, 200, publicInfo(config));
    let file;
    try { file = await staticFile(root, pathname); }
    catch (cause) { if (!['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES'].includes(cause.code)) throw cause; }
    if (!file) return error(request, response, 404, 'NOT_FOUND', 'Not found.');
    if (response.destroyed) { await file.handle.close(); return; }
    const etag = `W/"${file.info.size.toString(16)}-${file.info.mtimeMs.toString(16)}"`;
    response.setHeader('Content-Type', file.type);
    response.setHeader('Cache-Control', file.type.startsWith('text/html') ? 'public, max-age=0, must-revalidate' : 'public, max-age=3600');
    response.setHeader('ETag', etag);
    response.setHeader('Last-Modified', file.info.mtime.toUTCString());
    if (request.headers['if-none-match'] === etag || request.headers['if-none-match'] === '*') {
      await file.handle.close(); response.writeHead(304); response.end(); return;
    }
    response.setHeader('Content-Length', file.info.size);
    if (request.method === 'HEAD') { await file.handle.close(); response.writeHead(200); response.end(); return; }
    const stream = file.handle.createReadStream();
    response.on('close', () => stream.destroy());
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  }
  return server;
}

export async function startCommunityServer() {
  const config = loadConfig();
  let registry;
  try { registry = await createRegistryRuntime(); }
  catch { console.error('Registry configuration unavailable. Website remains online.'); }
  let server;
  try {
    server = await createCommunityServer({ config, registry });
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(config.port, '0.0.0.0', () => { server.removeListener('error', reject); resolveListen(); });
    });
  } catch (cause) { await registry?.close().catch(() => {}); throw cause; }
  console.log(`FullPanel community listening on port ${server.address().port}`);
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => server.closeAllConnections(), 10000);
    deadline.unref();
    server.close(() => { clearTimeout(deadline); void registry?.close().catch(() => {}); });
  };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  server.once('close', () => { process.removeListener('SIGTERM', shutdown); process.removeListener('SIGINT', shutdown); });
  return server;
}

function invokedAsEntryPoint() {
  try { return !!process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url; }
  catch { return false; }
}
if (invokedAsEntryPoint()) {
  startCommunityServer().catch(() => { console.error('FullPanel community startup failed. Check the configured port and public directory.'); process.exitCode = 1; });
}
