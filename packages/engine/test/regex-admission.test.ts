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
  expect(fake.requests).toHaveLength(0);
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

test('file-wide line matching preserves per-line flags and keeps owner checks independent of line count', async () => {
  const text = Array.from({ length: 20_000 }, (_, i) => i % 3 ? 'other' : 'Match:🙂').join('\n') + '\n';
  for (const [source, flags] of [['^match:', 'gi'], ['^', 'gm'], ['🙂$', 'gu'], ['Match', 'y']]) {
    let checks = 0;
    await using pattern = await admitRegex(source!, flags!, { operation: 'file search', assertCurrent() { checks++; } });
    const native = new RegExp(source!, flags!);
    const expected = text.split('\n').flatMap((line, i) => { native.lastIndex = 0; return native.test(line) ? [i] : []; });
    expect(await pattern.matchingLines(text)).toEqual(expected);
    expect(checks).toBeLessThan(20);
  }
});

test('one async schema walker preserves refs, not, allOf, anyOf, oneOf and dictionary validation', async () => {
  const fake = admit();
  const schema = { type: 'object', $defs: { tag: { type: 'string', pattern: '^ok$' } },
    additionalProperties: { allOf: [{ $ref: '#/$defs/tag' }], not: { pattern: '^bad$' }, anyOf: [{ pattern: '^ok$' }, { const: 'alternate' }], oneOf: [{ pattern: '^ok$' }, { const: 'other' }] } };
  expect(await firstJsonSchemaFailureAsync(schema, { first: 'ok', second: 'ok' })).toBeUndefined();
  expect(fake.requests).toHaveLength(0);
  expect((await firstJsonSchemaFailureAsync(schema, { first: 'bad' }))?.path).toBe('$.first');
  expect(fake.requests).toHaveLength(0);
});

test('configured permission deny expressions work without a judgment service', async () => {
  const rule = { type: 'arg-shape' as const, id: 'deny', origin: 'user' as const, effect: 'deny' as const, toolPattern: 'read', argMatchers: { path: '/private/' } };
  const evaluator = new LayeredPolicyEvaluator({ mode: 'default', rules: [rule], defaultEffect: 'allow' });
  expect((await evaluator.evaluateAsync('read', { path: 'private' }, 'read')).allowed).toBe(false);
  expect((await evaluateArgShapeRuleAsync(rule, 'read', { path: '/private/' })).matched).toBe(true);
});


test('Bun native execution remains correct or retires within the independent worker deadline', async () => {
  admit(); // Deliberately wrong model verdict: runtime safety must remain independent.
  await using pattern = await admitRegex('(a|aa)+$', '', { operation: 'adversarial fixture', timeoutMs: 1000 });
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
      await using pattern = await admitRegex('(a|aa)+$', '', { operation: 'native Node deadline', reading, timeoutMs: 1000 });
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
  expect((await expansion.replace('a'.repeat(50_000), 'b'.repeat(100))).length).toBe(5_000_000);
});

test('Jev verdicts cannot veto regex execution; invalid syntax and explicit owner limits still fail', async () => {
  const fake = fakePort(() => noulAnswer(0.999)); installJudgmentPort(fake.port);
  await using pattern = await admitRegex('a', '', { operation: 'fixture' });
  expect(await pattern.test('a')).toBe(true);
  await expect(admitRegex('[', '', { operation: 'fixture' })).rejects.toThrow();
  await expect(admitRegex('a', 'gg', { operation: 'fixture' })).rejects.toThrow('flags');
  await expect(admitRegex('a'.repeat(513), '', { operation: 'fixture', maxPatternChars: 512 })).rejects.toThrow('exceeds');
  expect(fake.requests).toHaveLength(0);
});


test('cancellation retires a regex executor without consulting Jev', async () => {
  const controller = new AbortController();
  await using pattern = await admitRegex('a', '', { operation: 'fixture', signal: controller.signal });
  controller.abort();
  await expect(pattern.test('a')).rejects.toThrow();
});


test('changing Jev configuration does not retire local regex execution', async () => {
  admit();
  await using pattern = await admitRegex('a', '', { operation: 'fixture' });
  installJudgmentPort(undefined);
  expect(await pattern.test('a')).toBe(true);
});


test('schema source mutations during worker startup cannot authorize changed values', async () => {
  const schema = { type: 'string', pattern: '^a$' };
  const pending = firstJsonSchemaFailureAsync(schema, 'a');
  schema.pattern = '^b$';
  await expect(pending).rejects.toThrow();
});


test('permission matcher mutation during worker startup cannot become an allow', async () => {
  const rule = { type: 'arg-shape' as const, id: 'allow', origin: 'user' as const, effect: 'allow' as const, toolPattern: 'read', argMatchers: { path: '/public/' } };
  const pending = evaluateArgShapeRuleAsync(rule, 'read', { path: 'public' });
  rule.argMatchers.path = '/private/';
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

test('large capture results survive deeply nested groups', async () => {
  admit();
  const source = '('.repeat(200) + 'a+' + ')'.repeat(200);
  await using pattern = await admitRegex(source, '', { operation: 'capture budget', maxInputChars: 500_000 });
  const result = await pattern.exec('a'.repeat(100_000));
  expect(result?.captures).toHaveLength(201);
  expect(result?.captures.at(-1)?.length).toBe(100_000);
});

test('edit numeric substitution preserves large valid expansions', async () => {
  admit();
  const result = await computeSingleEdit('a'.repeat(50_000), { path: 'fixture', find: '(a+)', replace: '$1'.repeat(100) }, 'regex', true);
  if ('error' in result) throw new Error(result.error);
  expect(result.newContent.length).toBe(5_000_000);
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
  expect(firstJsonSchemaFailure({ pattern: '[^!-~]' }, 'x'.repeat(60_000))?.received).toBe('non-matching string');
  expect(await firstJsonSchemaFailureAsync({ pattern: '^a+$' }, 'a')).toBeUndefined();
});

test('a session deny arriving during regex execution invalidates pending policy allow', async () => {
  const rule = { type: 'arg-shape' as const, id: 'allow', origin: 'user' as const, effect: 'allow' as const, toolPattern: 'read', argMatchers: { path: '/public/' } };
  const args = { path: 'public' };
  const evaluator = new LayeredPolicyEvaluator({ mode: 'default', rules: [rule], defaultEffect: 'deny' });
  const pending = evaluator.evaluateAsync('read', args, 'read');
  evaluator.recordSessionOverride('read', args, false, true);
  await expect(pending).rejects.toThrow();
});


test('simulator cannot publish a decision whose source changed during execution', async () => {
  const rule = { type: 'arg-shape' as const, id: 'allow', origin: 'user' as const, effect: 'allow' as const, toolPattern: 'read', argMatchers: { path: '/public/' } };
  const simulated = { ...rule, argMatchers: { path: '/public/' } };
  const simulator = new PermissionSimulator({ mode: 'default', rules: [rule] }, { mode: 'default', rules: [simulated] }, 'simulation-only');
  const pending = simulator.evaluateAsync('read', { path: 'public' }, 'read');
  rule.argMatchers.path = '/private/';
  await expect(pending).rejects.toThrow();
});


test('find searches long lines and large files without a Jev gate or a hidden skip', async () => {
  const root = mkdtempSync(join(tmpdir(), 'regex-find-large-'));
  try {
    writeFileSync(join(root, 'large.txt'), 'x'.repeat(600_000) + 'NEEDLE');
    const result = await createFindTool(root).execute({ queries: [{ id: 'q', mode: 'content', pattern: 'NEEDLE' }], output: { format: 'count_only' } });
    expect(result.success).toBe(true);
    expect(JSON.parse(result.output!).q.count).toBe(1);
    const content = 'x'.repeat(2_100_000) + 'NEEDLE';
    expect(await computeSingleEdit(content, { path: 'large.txt', find: 'NEEDLE', replace: 'done' }, 'regex', true)).toMatchObject({ newContent: 'x'.repeat(2_100_000) + 'done' });
    const controller = new AbortController(); controller.abort();
    expect((await createFindTool(root).execute({ queries: [{ id: 'q', mode: 'content', pattern: 'x' }] }, { signal: controller.signal })).success).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('concurrent regex operations queue instead of rejecting after 32 requests', async () => {
  await using pattern = await admitRegex('^a+$', '', { operation: 'queued fixture' });
  expect(await Promise.all(Array.from({ length: 100 }, () => pattern.test('a'.repeat(60_000))))).toEqual(Array(100).fill(true));
});

test('deep schema constraints are validated and cyclic references do not bypass validation', async () => {
  let schema: Record<string, unknown> = { type: 'string', pattern: '^required$' };
  let value: unknown = 'wrong';
  for (let i = 0; i < 100; i++) { schema = { type: 'object', properties: { child: schema } }; value = { child: value }; }
  expect((await firstJsonSchemaFailureAsync(schema, value))?.received).toBe('non-matching string');
  expect(firstJsonSchemaFailure({ $ref: '#' }, 'value')?.received).toBe('cyclic schema reference');
});
