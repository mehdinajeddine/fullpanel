import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { collectDockerServicePorts, declaredPorts, parseProcTcp } from './docker-ports.js';
import type { Service } from '../shared/types.js';

const timestamp = '2026-11-08T12:00:00.000Z';
const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
const row = (local: string, state = '0A') => `   0: ${local} ${'0'.repeat(local.split(':')[0].length)}:0000 ${state} 00000000:00000000 00:00000000 00000000 1000 0 123456 1 0000000000000000 100 0 0 10 0\n`;
function service(): Service { return { id: randomUUID(), projectId: randomUUID(), name: 'ports', kind: 'app', status: 'running', containerId: 'a'.repeat(64), deployedAt: timestamp, source: { type: 'image', image: 'nginx' }, env: {}, domains: [], mounts: [], ports: [], resources: { cpu: 1, memoryMb: 64 }, notes: '', createdAt: timestamp, updatedAt: timestamp }; }
function container(s: Service) { return { Id: 'a'.repeat(64), Name: `/hl-${s.id}`, Config: { Labels: { 'io.harborlight.managed': 'true', 'io.harborlight.service': s.id, 'io.harborlight.project': s.projectId } as Record<string, string>, ExposedPorts: { '80/tcp': {}, '53/udp': {} } }, State: { Status: 'running', StartedAt: timestamp } }; }
function fixture(s: Service, options: { before?: ReturnType<typeof container>; after?: ReturnType<typeof container>; v4?: string | Error; v6?: string | Error } = {}) {
  const calls: { args: string[]; timeout?: number }[] = []; let inspections = 0;
  const run = async (binary: string, args: string[], commandOptions?: { timeout?: number }) => {
    assert.equal(binary, 'docker'); calls.push({ args, timeout: commandOptions?.timeout });
    if (args[0] === 'container') return JSON.stringify(inspections++ ? options.after || options.before || container(s) : options.before || container(s));
    assert.deepEqual(args.slice(0, 3), ['exec', 'a'.repeat(64), 'cat']);
    const value = args[3] === '/proc/net/tcp' ? options.v4 ?? header + row('00000000:1F90') : options.v6 ?? header;
    if (value instanceof Error) throw value; return value;
  };
  return { calls, run };
}

test('Linux TCP table parsing distinguishes listeners, wildcard, interface and all IPv4 loopback addresses', () => {
  const listeners = parseProcTcp(header + row('00000000:1F90') + row('0100007F:0BB8') + row('0B00007F:D431') + row('020011AC:0050') + row('0100007F:1234', '01') + row('00000000:1F90'), 'ipv4');
  assert.deepEqual(listeners.map(value => [value.address, value.port, value.scope]), [['172.17.0.2', 80, 'interface'], ['127.0.0.1', 3000, 'loopback'], ['0.0.0.0', 8080, 'wildcard'], ['127.0.0.11', 54321, 'loopback']]);
  assert(listeners.every(value => value.protocol === 'tcp' && value.family === 'ipv4'));
});

test('Linux TCP6 word endianness decodes compressed IPv6 and mapped loopback without treating mapped interfaces as wildcard', () => {
  const value = parseProcTcp(header.replace('rem_address', 'remote_address') + row('00000000000000000000000000000000:0050') + row('00000000000000000000000001000000:0051') + row('0000000000000000FFFF00000100007F:0052') + row('B80D0120000000000000000001000000:0053') + row('0000000000000000FFFF0000020011AC:0054'), 'ipv6');
  assert.deepEqual(value.map(item => [item.address, item.scope]), [['::', 'wildcard'], ['::1', 'loopback'], ['::ffff:127.0.0.1', 'loopback'], ['2001:db8::1', 'interface'], ['::ffff:172.17.0.2', 'interface']]);
});

test('socket tables reject malformed rows, absent headers, truncated output and invalid listening ports', () => {
  assert.deepEqual(parseProcTcp(header, 'ipv4'), []);
  for (const value of [row('00000000:0050'), header + row('00000000:0050').trimEnd(), header + row('INVALID0:0050'), header + row('00000000:0000'), header + row('00000000:0050').replace('1000 0 123456', 'secret 0 123456'), header + 'x'.repeat(1_900_000)]) assert.throws(() => parseProcTcp(value, 'ipv4'));
  assert.throws(() => parseProcTcp(header + row('00000000:0050'), 'ipv6'));
  assert.deepEqual(declaredPorts({ '80/tcp': {}, '53/udp': {}, '0/tcp': {}, '65536/tcp': {}, '123/sctp': {}, 'invalid': {} }), [{ port: 53, protocol: 'udp' }, { port: 80, protocol: 'tcp' }]);
});

test('owned canonical Docker port inspection uses bounded fixed argv and separates EXPOSE from listeners', async () => {
  const s = service(), f = fixture(s), result = await collectDockerServicePorts(s, f.run, () => timestamp);
  assert.equal(result.state, 'available'); assert.equal(result.sampledAt, timestamp); assert.equal(result.checkedAt, timestamp);
  assert.deepEqual(result.listeners.map(item => item.port), [8080]); assert.deepEqual(result.exposed, [{ port: 53, protocol: 'udp' }, { port: 80, protocol: 'tcp' }]);
  assert.equal(f.calls.length, 4); assert(f.calls.every(call => call.timeout === 5000));
  assert(f.calls.filter(call => call.args[0] === 'exec').every(call => call.args.length === 4));
  assert.equal(f.calls.at(-1)?.args.at(-1), s.containerId);
});

test('port inspection rejects foreign ownership, candidates, short IDs and a known runtime ID mismatch before exec', async () => {
  const s = service(), original = container(s);
  for (const before of [{ ...original, Name: original.Name + '-candidate' }, { ...original, Id: 'b'.repeat(64) }, { ...original, Id: 'short' }, ...['io.harborlight.managed', 'io.harborlight.service', 'io.harborlight.project'].map(label => ({ ...original, Config: { ...original.Config, Labels: { ...original.Config.Labels, [label]: 'foreign-private-value' } } }))]) {
    const f = fixture(s, { before }), result = await collectDockerServicePorts(s, f.run, () => timestamp);
    assert.equal(result.state, 'unavailable'); assert.deepEqual(result.exposed, []); assert.deepEqual(result.listeners, []); assert(!f.calls.some(call => call.args[0] === 'exec')); assert(!JSON.stringify(result).includes('foreign-private-value'));
  }
});

test('missing IPv6 produces partial results; unavailable cat preserves only container metadata and never reveals stderr', async () => {
  const s = service();
  const partial = await collectDockerServicePorts(s, fixture(s, { v6: Error('No such file /secret/host') }).run, () => timestamp);
  assert.equal(partial.state, 'partial'); assert.equal(partial.listeners[0].port, 8080); assert(!JSON.stringify(partial).includes('/secret/host'));
  const failed = await collectDockerServicePorts(s, fixture(s, { v4: Error('secret daemon stderr'), v6: Error('cat not found') }).run, () => timestamp);
  assert.equal(failed.state, 'unavailable'); assert.equal(failed.sampledAt, null); assert.deepEqual(failed.listeners, []); assert.equal(failed.exposed.length, 2); assert(!JSON.stringify(failed).includes('stderr'));
});

test('stopped and absent runtimes stay honest; Compose is unsupported; restart or replacement discards observations', async () => {
  const s = service(), c = container(s), stoppedFixture = fixture(s, { before: { ...c, State: { ...c.State, Status: 'exited' } } });
  const stopped = await collectDockerServicePorts(s, stoppedFixture.run, () => timestamp);
  assert.equal(stopped.state, 'stopped'); assert.equal(stopped.sampledAt, null); assert.deepEqual(stopped.listeners, []); assert.equal(stoppedFixture.calls.length, 1);
  const missing = async () => { throw Error('No such container: canonical'); };
  assert.equal((await collectDockerServicePorts(s, missing)).state, 'unavailable');
  assert.equal((await collectDockerServicePorts({ ...s, deployedAt: undefined, containerId: undefined }, missing)).state, 'not-deployed');
  assert.equal((await collectDockerServicePorts({ ...s, kind: 'compose' }, async () => { throw Error('Should never execute'); })).state, 'unsupported');
  for (const after of [{ ...c, State: { ...c.State, StartedAt: '2026-11-08T12:01:00Z' } }, { ...c, Name: c.Name + '-previous' }, { ...c, State: { ...c.State, Status: 'exited' } }]) {
    const result = await collectDockerServicePorts(s, fixture(s, { after }).run);
    assert.equal(result.state, 'unavailable'); assert.deepEqual(result.listeners, []); assert.deepEqual(result.exposed, []); assert.equal(result.sampledAt, null);
  }
});
