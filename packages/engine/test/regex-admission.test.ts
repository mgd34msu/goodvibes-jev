import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { withTestTimeout } from './_helpers/test-timeout.ts';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFindTool } from '../sdk/src/platform/tools/find/executor.ts';
import { PermissionSimulator } from '../sdk/src/platform/runtime/permissions/simulation.ts';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { admitRegex, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { firstJsonSchemaFailure, firstJsonSchemaFailureAsync } from '../transport-http/src/client-plumbing.ts';
import { evaluateArgShapeRuleAsync } from '../sdk/src/platform/runtime/permissions/rules/arg-shape.ts';
import { LayeredPolicyEvaluator } from '../sdk/src/platform/runtime/permissions/evaluator.ts';
import { computeSingleEdit } from '../sdk/src/platform/tools/edit/match.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
function admit() {
  const fake = fakePort(() => noulAnswer(0.001));
  installJudgmentPort(fake.port);
  return fake;
}

test('actual regex edits retain numeric captures and flag-sensitive matching', async () => {
  const fake = admit();
  const result = await computeSingleEdit('Foo_bar', { path: 'file.ts', find: '(foo)_(bar)', replace: '$2_$1' }, 'regex', false);
  expect(result).toMatchObject({ newContent: 'bar_Foo', occurrencesReplaced: 1 });
  expect(fake.requests.map(request => (request.state as { flags: string }).flags)).toEqual(['gi', 'i']);
  expect(JSON.stringify(fake.requests.map(request => request.state))).not.toContain('Foo_bar');
});

test('native lookbehind, named/numbered captures, sticky lastIndex and replacement substitutions survive isolation', async () => {
  admit();
  await using pattern = await admitRegex('(?<=:)(?<word>[a-z]+)([0-9])?', 'g', { operation: 'fixture' });
  const input = ':abc2 :def';
  const replacement = '$$|$&|$1|$2|$<word>|$`|$\'|$01|$99';
  expect(await pattern.replace(input, replacement)).toBe(input.replace(/(?<=:)(?<word>[a-z]+)([0-9])?/g, replacement));
  expect(await pattern.exec(input, 5)).toMatchObject({ captures: ['def', 'def', undefined], index: 7, lastIndex: 10, groups: { word: 'def' } });
  await using sticky = await admitRegex('a', 'y', { operation: 'fixture' });
  expect(await sticky.exec('ba', 1)).toMatchObject({ index: 1, lastIndex: 2 });
  expect(await sticky.exec('ba', 0)).toBeNull();
  await using empty = await admitRegex('(?:)', 'gu', { operation: 'fixture' });
  expect(await empty.positions('🙂')).toEqual([{ start: 0, end: 0 }, { start: 2, end: 2 }]);
});

test('one async schema walker preserves refs, not, allOf, anyOf, oneOf and dictionary validation', async () => {
  const fake = admit();
  const schema = { type: 'object', $defs: { tag: { type: 'string', pattern: '^ok$' } },
    additionalProperties: { allOf: [{ $ref: '#/$defs/tag' }], not: { pattern: '^bad$' }, anyOf: [{ pattern: '^ok$' }, { const: 'alternate' }], oneOf: [{ pattern: '^ok$' }, { const: 'other' }] } };
  expect(await firstJsonSchemaFailureAsync(schema, { first: 'ok', second: 'ok' })).toBeUndefined();
  expect(fake.requests).toHaveLength(2); // Scoped to this invocation, one handle per exact source.
  expect((await firstJsonSchemaFailureAsync(schema, { first: 'bad' }))?.path).toBe('$.first');
  expect(fake.requests).toHaveLength(3); // A second request cannot reuse authorization.
});

test('unavailable readings hold permission deny rules instead of falling through to default allow', async () => {
  const rule = { type: 'arg-shape' as const, id: 'deny', origin: 'user' as const, effect: 'deny' as const, toolPattern: 'read', argMatchers: { path: '/private/' } };
  const evaluator = new LayeredPolicyEvaluator({ mode: 'default', rules: [rule], defaultEffect: 'allow' });
  await expect(evaluator.evaluateAsync('read', { path: 'private' }, 'read')).rejects.toThrow();
  await expect(evaluateArgShapeRuleAsync(rule, 'read', { path: '/private/' })).rejects.toThrow();
});

test('Bun native execution remains correct or retires within the independent worker deadline', async () => {
  admit(); // Deliberately wrong model verdict: runtime safety must remain independent.
  await using pattern = await admitRegex('(a|aa)+$', '', { operation: 'adversarial fixture' });
  // JSC can bound this native backtracking operation before the host deadline.
  const result = await pattern.test('a'.repeat(1000) + '!').then(
    value => ({ kind: 'settled' as const, value }),
    error => ({ kind: 'held' as const, error }),
  );
  if (result.kind === 'settled') {
    expect(result.value).toBe(false);
    expect(await pattern.test('a')).toBe(true);
  } else {
    expect(String(result.error)).toContain('executor');
    await expect(pattern.test('a')).rejects.toThrow();
  }
});

test('the actual Node worker deadline retires catastrophic native execution despite semantic admission', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'regex-node-deadline-'));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const entry = join(dir, 'entry.ts');
    const source = resolve(import.meta.dir, '../errors/src/regex-admission.ts');
    writeFileSync(entry, `
      import assert from 'node:assert/strict';
      import { admitRegex } from ${JSON.stringify(source)};
      const controller = new AbortController();
      const reading = { signal: controller.signal, assertCurrent() {}, async read() { return { outcome: 'act', verdict: 'no' }; } };
      await using pattern = await admitRegex('(a|aa)+$', '', { operation: 'native Node deadline', reading });
      await assert.rejects(pattern.test('a'.repeat(1000) + '!'), /executor/);
      await assert.rejects(pattern.test('a'), /executor/);
      console.log('native-node-deadline-retired');
    `);
    // The canonical suite guard requires an owned, bounded bundler child.
    const bundler = Bun.spawn([process.execPath, 'build', entry, '--target=node', '--format=esm',
      '--conditions=bun', `--outdir=${dir}`, '--entry-naming=entry.mjs'],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const buildStdout = new Response(bundler.stdout).text().catch(() => '');
    const buildStderr = new Response(bundler.stderr).text().catch(() => '');
    try {
      const exit = await withTestTimeout(bundler.exited, 3000, 'Node regex fixture bundle exceeded 3000ms');
      expect(exit, `${await buildStdout}\n${await buildStderr}`).toBe(0);
    } finally {
      try { bundler.kill('SIGKILL'); } catch { /* Already exited. */ }
      await bundler.exited.catch(() => undefined);
    }
    const nodeChild = Bun.spawn(['node', join(dir, 'entry.mjs')], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    child = nodeChild;
    const stdout = new Response(nodeChild.stdout).text(), stderr = new Response(nodeChild.stderr).text();
    // Bound the owned child even if the production worker deadline regresses.
    timer = setTimeout(() => { try { child?.kill('SIGKILL'); } catch { /* Already exited. */ } }, 5000);
    const exit = await nodeChild.exited;
    expect(exit, await stderr).toBe(0);
    expect(await stdout).toContain('native-node-deadline-retired');
  } finally {
    clearTimeout(timer);
    if (child) { try { child.kill('SIGKILL'); } catch { /* Already exited. */ } await child.exited.catch(() => {}); }
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);

test('worker output and input bounds cannot be relaxed by per-call options', async () => {
  admit();
  await using pattern = await admitRegex('a', 'g', { operation: 'fixture', maxInputChars: 100 });
  await expect(pattern.test('a', 101)).rejects.toThrow();
  await using expansion = await admitRegex('a', 'g', { operation: 'fixture' });
  await expect(expansion.replace('a'.repeat(50_000), 'b'.repeat(100))).rejects.toThrow();
});

test('yes and held readings veto execution; syntax and caps fail before a reading', async () => {
  const fake = fakePort(() => noulAnswer(0.999)); installJudgmentPort(fake.port);
  await expect(admitRegex('a', '', { operation: 'fixture' })).rejects.toThrow('backtracking');
  expect(fake.requests).toHaveLength(1);
  await expect(admitRegex('[', '', { operation: 'fixture' })).rejects.toThrow();
  await expect(admitRegex('a', 'gg', { operation: 'fixture' })).rejects.toThrow('flags');
  await expect(admitRegex('a'.repeat(513), '', { operation: 'fixture' })).rejects.toThrow('exceeds');
  expect(fake.requests).toHaveLength(1);
  installJudgmentPort(fakePort(() => noulAnswer(0.5)).port);
  await expect(admitRegex('a', '', { operation: 'fixture' })).rejects.toThrow('backtracking');
});

test('cancellation interrupts a noncooperating read and late settlement creates no reusable admission', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const fake = fakePort(() => noulAnswer(0.001));
  installJudgmentPort({ ...fake.port, async ask(request) { entered.resolve(); await release.promise; return fake.port.ask(request); } });
  const controller = new AbortController();
  const pending = admitRegex('a', '', { operation: 'fixture', signal: controller.signal });
  await entered.promise;
  controller.abort();
  await expect(pending).rejects.toThrow();
  release.resolve();
  installJudgmentPort(undefined);
  await expect(admitRegex('a', '', { operation: 'fixture' })).rejects.toThrow();
});

test('installed-port replacement retires an already-created executor', async () => {
  admit();
  await using pattern = await admitRegex('a', '', { operation: 'fixture' });
  expect(await pattern.test('a')).toBe(true);
  admit();
  await expect(pattern.test('a')).rejects.toThrow();
});

test('rule and schema source mutations during a held read cannot authorize changed values', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const fake = fakePort(() => noulAnswer(0.001));
  installJudgmentPort({ ...fake.port, async ask(request) { entered.resolve(); await release.promise; return fake.port.ask(request); } });
  const schema = { type: 'string', pattern: '^a$' };
  const pending = firstJsonSchemaFailureAsync(schema, 'a');
  await entered.promise;
  schema.pattern = '^b$'; release.resolve();
  await expect(pending).rejects.toThrow();
});

test('permission matcher mutation during a pending read is held rather than becoming an allow', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const fake = fakePort(() => noulAnswer(0.001));
  installJudgmentPort({ ...fake.port, async ask(request) { entered.resolve(); await release.promise; return fake.port.ask(request); } });
  const rule = { type: 'arg-shape' as const, id: 'allow', origin: 'user' as const, effect: 'allow' as const, toolPattern: 'read', argMatchers: { path: '/public/' } };
  const pending = evaluateArgShapeRuleAsync(rule, 'read', { path: 'public' });
  await entered.promise;
  rule.argMatchers.path = '/private/'; release.resolve();
  await expect(pending).rejects.toThrow();
});

test('cancellation during worker construction terminates the late startup handle', async () => {
  admit();
  const controller = new AbortController();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  let terminated = 0;
  class RetiringWorker {
    constructor() { controller.abort(); }
    terminate() { terminated++; }
    postMessage() { throw new Error('retired worker must never execute'); }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: RetiringWorker });
  try {
    await expect(admitRegex('a', '', { operation: 'fixture', signal: controller.signal })).rejects.toThrow();
    expect(terminated).toBe(1);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'Worker', descriptor);
    else Reflect.deleteProperty(globalThis, 'Worker');
  }
});

test('capture storage is bounded before native execution for deeply nested groups', async () => {
  admit();
  const source = '('.repeat(200) + 'a+' + ')'.repeat(200);
  await using pattern = await admitRegex(source, '', { operation: 'capture budget', maxInputChars: 500_000 });
  await expect(pattern.exec('a'.repeat(500_000))).rejects.toThrow('capture storage');
});

test('edit numeric substitution refuses excessive expansion before allocating the result', async () => {
  admit();
  await expect(computeSingleEdit('a'.repeat(50_000), { path: 'fixture', find: '(a+)', replace: '$1'.repeat(50_000) }, 'regex', true)).rejects.toThrow('output exceeds');
});


test('the four exact wire grammars retain native anchors, Unicode, nested-not and caps without readings', async () => {
  const cases = [
    ['^[a-f0-9]{64}$', /^[a-f0-9]{64}$/],
    ['^[!-~][ -~]{0,255}$', /^[!-~][ -~]{0,255}$/],
    ['[^!-~]', /[^!-~]/],
    ['\\S', /\S/],
  ] as const;
  const values = ['', 'abc', 'a'.repeat(64), 'a'.repeat(65), 'a'.repeat(256), 'a'.repeat(257),
    'x\n', 'x\r', 'x\r\n', 'x\u2028', 'x\u2029', '\u00a0', '\ufeff', '🙂', 'a'.repeat(64) + '\n'];
  for (const [source, literal] of cases) for (const value of values) {
    const schema = { type: 'string', pattern: source };
    expect(firstJsonSchemaFailure(schema, value) === undefined).toBe(literal.test(value));
    expect(await firstJsonSchemaFailureAsync(schema, value) === undefined).toBe(literal.test(value));
    expect(firstJsonSchemaFailure({ not: schema }, value) === undefined).toBe(!literal.test(value));
  }
  expect(firstJsonSchemaFailure({ pattern: '\\S' }, 'x'.repeat(60_000))).toBeUndefined();
  expect(() => firstJsonSchemaFailure({ pattern: '[^!-~]' }, 'x'.repeat(60_000))).toThrow('input exceeds');
  await expect(firstJsonSchemaFailureAsync({ pattern: '^a+$' }, 'a')).rejects.toThrow();
});

test('a session deny arriving during a held arg-shape reading invalidates pending policy allow', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const fake = fakePort(() => noulAnswer(0.001));
  installJudgmentPort({ ...fake.port, async ask(request) { entered.resolve(); await release.promise; return fake.port.ask(request); } });
  const rule = { type: 'arg-shape' as const, id: 'allow', origin: 'user' as const, effect: 'allow' as const, toolPattern: 'read', argMatchers: { path: '/public/' } };
  const args = { path: 'public' };
  const evaluator = new LayeredPolicyEvaluator({ mode: 'default', rules: [rule], defaultEffect: 'deny' });
  const pending = evaluator.evaluateAsync('read', args, 'read');
  await entered.promise;
  evaluator.recordSessionOverride('read', args, false, true);
  release.resolve();
  await expect(pending).rejects.toThrow();
});


test('simulator cannot publish an actual decision changed during the simulated reading', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const fake = fakePort(() => noulAnswer(0.001));
  let count = 0;
  installJudgmentPort({ ...fake.port, async ask(request) { if (++count === 2) { entered.resolve(); await release.promise; } return fake.port.ask(request); } });
  const rule = { type: 'arg-shape' as const, id: 'allow', origin: 'user' as const, effect: 'allow' as const, toolPattern: 'read', argMatchers: { path: '/public/' } };
  const simulated = { ...rule, argMatchers: { path: '/public/' } };
  const simulator = new PermissionSimulator({ mode: 'default', rules: [rule] }, { mode: 'default', rules: [simulated] }, 'simulation-only');
  const pending = simulator.evaluateAsync('read', { path: 'public' }, 'read');
  await entered.promise; rule.argMatchers.path = '/private/'; release.resolve();
  await expect(pending).rejects.toThrow();
});


test('actual find invocation cancellation reaches a suspended pattern reading', async () => {
  const root = mkdtempSync(join(tmpdir(), 'regex-find-cancel-'));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const fake = fakePort(() => noulAnswer(0.001));
  installJudgmentPort({ ...fake.port, async ask(request) { entered.resolve(); await release.promise; return fake.port.ask(request); } });
  const controller = new AbortController();
  const pending = createFindTool(root).execute({ queries: [{ id: 'q', mode: 'content', pattern: 'a' }] }, { signal: controller.signal });
  try {
    await entered.promise; controller.abort();
    expect((await pending).success).toBe(false);
  } finally { release.resolve(); await pending.catch(() => {}); rmSync(root, { recursive: true, force: true }); }
});
