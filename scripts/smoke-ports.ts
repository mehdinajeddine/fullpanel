/** Real Linux socket tables; this fixture never publishes a host port or modifies shared resources. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { command } from '../server/docker.js';
import { collectDockerServicePorts } from '../server/docker-ports.js';
import type { Service } from '../shared/types.js';

const fixtureId = randomUUID(), projectId = randomUUID(), serviceId = randomUUID();
const name = `hl-${serviceId}`, now = new Date().toISOString();
const service: Service = {
  id: serviceId, projectId, name: 'ports-proof', kind: 'app', status: 'not-deployed',
  source: { type: 'image', image: 'node:24-alpine' }, env: {}, domains: [], mounts: [], ports: [],
  resources: { cpu: 0.25, memoryMb: 128 }, notes: '', createdAt: now, updatedAt: now,
};
type Container = { Id: string; Name: string; Config: { Labels: Record<string, string> }; HostConfig: { PortBindings: unknown; NetworkMode: string } };
async function inspect(): Promise<Container | undefined> {
  try { return JSON.parse(await command('docker', ['container', 'inspect', name], { timeout: 5000 }))[0]; }
  catch (error) { if (/No such (container|object)/i.test(String(error))) return undefined; throw error; }
}
function verify(container: Container) {
  assert.match(container.Id, /^[a-f0-9]{64}$/);
  assert.equal(container.Name, `/${name}`);
  assert.equal(container.Config.Labels['io.harborlight.managed'], 'true');
  assert.equal(container.Config.Labels['io.harborlight.project'], projectId);
  assert.equal(container.Config.Labels['io.harborlight.service'], serviceId);
  assert.equal(container.Config.Labels['io.fullpanel.ports-fixture'], fixtureId);
  if (service.containerId) assert.equal(container.Id, service.containerId);
}
const fixtureProgram = `
const net = require('node:net');
function listen(host, port, optional = false) {
  return new Promise((resolve, reject) => {
    const server = net.createServer(socket => socket.end());
    server.once('error', error => {
      if (optional && ['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT'].includes(error.code)) resolve({host, port, available:false, reason:error.code});
      else reject(error);
    });
    server.listen({host, port, ipv6Only:true}, () => resolve({host, port, available:true}));
  });
}
Promise.all([listen('0.0.0.0', 3000), listen('127.0.0.1', 3001), listen('::', 3002, true)])
  .then(listeners => console.log('PORTS_READY ' + JSON.stringify(listeners)))
  .catch(error => { console.error(error.code || 'Listener failed'); process.exit(1); });
`;

try {
  console.log('Docker runtime:', (await command('docker', ['info', '--format', '{{.ServerVersion}} / {{.OSType}} / {{.Architecture}}'])).trim());
  const initial = await collectDockerServicePorts(service, command);
  assert.equal(initial.state, 'not-deployed');
  assert.deepEqual(initial.listeners, []);
  let image;
  try { image = JSON.parse(await command('docker', ['image', 'inspect', 'node:24-alpine']))[0]; }
  catch (error) {
    if (!/No such image|not found/i.test(String(error))) throw error;
    await command('docker', ['pull', 'node:24-alpine'], { timeout: 120000 });
    image = JSON.parse(await command('docker', ['image', 'inspect', 'node:24-alpine']))[0];
  }
  assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
  console.log('Fixture image:', image.Id, JSON.stringify(image.RepoDigests));
  await command('docker', ['create', '--name', name,
    '--label', 'io.harborlight.managed=true', '--label', `io.harborlight.project=${projectId}`,
    '--label', `io.harborlight.service=${serviceId}`, '--label', `io.fullpanel.ports-fixture=${fixtureId}`,
    '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--user', 'node', '--memory', '128m', '--cpus', '0.25', '--expose', '8080/tcp',
    image.Id, 'node', '-e', fixtureProgram]);
  const container = await inspect(); assert(container); verify(container);
  assert.equal(container.HostConfig.NetworkMode, 'none');
  assert.equal(Object.keys(container.HostConfig.PortBindings || {}).length, 0);
  service.containerId = container.Id;
  await command('docker', ['start', container.Id]);
  service.deployedAt = new Date().toISOString(); service.status = 'running';
  let ready: { host: string; port: number; available: boolean; reason?: string }[] | undefined;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const logs = await command('docker', ['logs', '--tail', '10', container.Id], { timeout: 5000 });
    const line = logs.split('\n').find(value => value.startsWith('PORTS_READY '));
    if (line) { ready = JSON.parse(line.slice('PORTS_READY '.length)); break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert(ready, 'Fixture listeners did not become ready within 15 seconds.');
  const sample = await collectDockerServicePorts(service, command);
  assert(['available', 'partial'].includes(sample.state), JSON.stringify(sample));
  assert.equal(sample.mode, 'docker'); assert.equal(sample.serviceId, serviceId);
  assert(sample.sampledAt && Date.now() - Date.parse(sample.sampledAt) < 15000);
  assert(sample.listeners.some(port => port.port === 3000 && port.address === '0.0.0.0' && port.scope === 'wildcard' && port.family === 'ipv4'));
  assert(sample.listeners.some(port => port.port === 3001 && port.address === '127.0.0.1' && port.scope === 'loopback' && port.family === 'ipv4'));
  if (ready.find(item => item.port === 3002)?.available) {
    assert.equal(sample.state, 'available');
    assert(sample.listeners.some(port => port.port === 3002 && port.address === '::' && port.scope === 'wildcard' && port.family === 'ipv6'));
    console.log('PASS: real IPv6 wildcard listener parsed from /proc/net/tcp6.');
  } else console.log('SKIP: IPv6 listener unavailable in fixture namespace:', ready.find(item => item.port === 3002)?.reason);
  assert(sample.exposed.some(port => port.port === 8080 && port.protocol === 'tcp'));
  assert(!sample.listeners.some(port => port.port === 8080), 'Container declaration must not be treated as a listening socket.');
  console.log('PASS: real IPv4 wildcard/loopback sockets; declared container port 8080 is not listening; no host port published.');
  console.log(JSON.stringify(sample));

  await command('docker', ['stop', '--time', '2', container.Id]); service.status = 'stopped';
  const stopped = await collectDockerServicePorts(service, command);
  assert.equal(stopped.state, 'stopped'); assert.equal(stopped.sampledAt, null); assert.deepEqual(stopped.listeners, []);
  assert(stopped.exposed.some(port => port.port === 8080));
  const beforeRemoval = await inspect(); assert(beforeRemoval); verify(beforeRemoval);
  await command('docker', ['rm', beforeRemoval.Id]);
  const removed = await collectDockerServicePorts(service, command);
  assert.equal(removed.state, 'unavailable'); assert.equal(removed.sampledAt, null);
  assert.deepEqual(removed.listeners, []); assert.deepEqual(removed.exposed, []);
  console.log('PASS: stopped runtime has no observed listeners; removed previously deployed runtime is unavailable, without stale results.');
} finally {
  // Resolve even after a partial create/start failure, then guard all labels and remove only its exact ID.
  const remaining = await inspect();
  if (remaining) { verify(remaining); await command('docker', ['rm', '-f', remaining.Id]); }
  assert.equal(await inspect(), undefined);
  console.log('PASS: exact UUID fixture cleaned up; no host ports, networks or volumes provisioned; image cache retained.');
}
