import assert from 'node:assert/strict';
import { test } from 'node:test';
import { effectiveServiceEnvironment, parseEnvironmentText } from '../../shared/environment.js';
import { environmentInput } from '../project-environment.js';

test('.env import preserves supported values without evaluating variables or shell syntax', () => {
  const parsed = parseEnvironmentText('\uFEFF# ignored\r\nexport HOST = example.test\r\nEMPTY=\nQUOTED=" padded # value " # comment\nSINGLE=\'literal $VALUE\'\nUNQUOTED=abc#def # comment\nDOLLAR=${HOST}\nSHELL=$(touch /tmp/never-executed)\nESCAPED="quoted \\"word\\" and \\\\ slash"\n');
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual({ ...parsed.env }, {
    HOST: 'example.test', EMPTY: '', QUOTED: ' padded # value ', SINGLE: 'literal $VALUE',
    UNQUOTED: 'abc#def', DOLLAR: '${HOST}', SHELL: '$(touch /tmp/never-executed)', ESCAPED: 'quoted "word" and \\ slash',
  });
});

test('.env import reports lines without echoing secrets and rejects ambiguous partial input', () => {
  const parsed = parseEnvironmentText('GOOD=ok\nBAD NAME=hidden-secret\nDUP=first\nDUP=second-secret\nOPEN="unclosed-secret\nTAIL="quoted-secret" unexpected\nNEWLINE="secret\\nvalue"\nNULL=secret\0value');
  assert.deepEqual(parsed.errors.map(error => error.line), [2, 4, 5, 6, 7, 8]);
  for (const secret of ['hidden-secret', 'second-secret', 'unclosed-secret', 'quoted-secret', 'secret\\nvalue', 'secret\0value']) assert(!JSON.stringify(parsed.errors).includes(secret));
  assert.equal(parsed.env.GOOD, 'ok');
  assert.equal(parsed.env.DUP, 'first');
  assert.equal(parseEnvironmentText('x'.repeat(256 * 1024 + 1)).errors.length, 1);
  const tooMany = parseEnvironmentText(Array.from({ length: 201 }, (_, index) => `KEY_${index}=value`).join('\n'));
  assert.equal(tooMany.errors[0].line, 201);
});

test('environment precedence preserves empty overrides and rejects names reserved by the JSON API', () => {
  const parsed = parseEnvironmentText('EMPTY=');
  assert.deepEqual(parsed.errors, []);
  const merged = effectiveServiceEnvironment({ env: parsed.env }, { EMPTY: 'project', INHERITED: 'yes' });
  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
  assert.equal(merged.EMPTY, '');
  assert.equal(merged.INHERITED, 'yes');
  assert.deepEqual(parseEnvironmentText('__proto__=literal\nconstructor=also-literal').errors.map(error => error.line), [1, 2]);
  assert.equal(environmentInput.safeParse(JSON.parse('{"__proto__":"literal"}')).success, false);
  assert.equal(environmentInput.safeParse({ constructor: 'also-literal' }).success, false);
  assert.equal(environmentInput.safeParse({ BAD: 42 }).success, false);
  assert.equal(environmentInput.safeParse({ 'BAD KEY': 'value' }).success, false);
});
