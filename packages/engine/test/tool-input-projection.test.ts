import { spawnSync } from 'node:child_process';
import { expect, test } from 'bun:test';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.ts';
import { ToolInputProjectionError, type ToolInputProjector, type ToolInputProjectionResult } from '../sdk/src/platform/tools/input-projection.ts';
import type { Tool, ToolExecuteOptions } from '../sdk/src/platform/types/tools.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(parameters: Record<string, unknown> = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }) {
  const registry = new ToolRegistry();
  const bodies: Array<{ args: Record<string, unknown>; opts: ToolExecuteOptions | undefined }> = [];
  const tool: Tool = {
    definition: { name: 'projection_fixture', description: 'A bounded synthetic fixture.', parameters },
    async execute(args, opts) { bodies.push({ args, opts }); return { success: true, output: 'ran' }; },
  };
  return { registry, tool, bodies };
}
const raw = () => ({ value: 'synthetic-original-reference' });
const safe = () => ({ value: 'opaque-reference-one' });

// These tests prove the generic registration boundary, not semantic URL screening.
test('registered projection receives immutable owned input and is reused by exact call identity', async () => {
  const { registry, tool, bodies } = fixture();
  let projects = 0; let releases = 0;
  const input = { value: 'source', nested: { values: ['before'] } };
  const ready = deferred<void>(); const resume = deferred<void>();
  registry.register(tool, { inputProjection: { async project(request) {
    projects++; expect(Object.isFrozen(request.args)).toBe(true);
    expect(Object.isFrozen(request.args.nested)).toBe(true);
    expect(Object.isFrozen((request.args.nested as { values: string[] }).values)).toBe(true);
    ready.resolve(); await resume.promise;
    expect(request.args).toEqual({ value: 'source', nested: { values: ['before'] } });
    return { status: 'projected', args: safe(), async release() { releases++; } };
  } } });
  const pending = registry.projectCall('one', tool.definition.name, input);
  await ready.promise; input.nested.values[0] = 'changed'; resume.resolve();
  const projected = await pending;
  expect(Object.isFrozen(projected)).toBe(true);
  expect(await registry.projectCall('one', tool.definition.name, projected.args)).toBe(projected);
  const prepared = await registry.prepareCall('one', tool.definition.name, projected.args);
  expect(projects).toBe(1);
  expect(await registry.executePrepared(prepared, () => {})).toMatchObject({ success: true, callId: 'one' });
  expect(bodies[0]?.args).toEqual(safe()); expect(releases).toBe(1);
  await registry.releaseProjected(projected); expect(releases).toBe(1);
  await expect(registry.executePrepared(prepared, () => {})).rejects.toThrow('claimed');
});

test.each(['getter', 'proxy', 'nested-proxy'])('rejects %s input without executing traps or the projector', async kind => {
  const { registry, tool, bodies } = fixture(); let traps = 0; let projects = 0;
  registry.register(tool, { inputProjection: { async project() { projects++; return { status: 'projected', args: safe() }; } } });
  const proxy = new Proxy({}, { ownKeys() { traps++; return []; }, getPrototypeOf() { traps++; return Object.prototype; } });
  const args = kind === 'proxy' ? proxy : kind === 'nested-proxy' ? { value: proxy } : Object.defineProperty({}, 'value', { enumerable: true, get() { traps++; return 'raw'; } });
  await expect(registry.projectCall('one', tool.definition.name, args)).rejects.toBeInstanceOf(ToolInputProjectionError);
  expect(traps).toBe(0); expect(projects).toBe(0); expect(bodies).toHaveLength(0);
});

test('projector and option accessors/proxies cannot execute during registration or capture', async () => {
  const { registry, tool } = fixture(); let traps = 0;
  const projector = Object.defineProperty({}, 'project', { get() { traps++; return async () => ({ status: 'held' }); } }) as ToolInputProjector;
  expect(() => registry.register(tool, { inputProjection: projector })).toThrow(ToolInputProjectionError);
  const proxy = new Proxy({ async project() { return { status: 'held' } as const; } }, { get() { traps++; return undefined; } });
  expect(() => registry.register(tool, { inputProjection: proxy })).toThrow(ToolInputProjectionError);
  registry.register(tool);
  const opts = Object.defineProperty({}, 'signal', { get() { traps++; return undefined; } });
  await expect(registry.projectCall('one', tool.definition.name, raw(), opts)).rejects.toBeInstanceOf(ToolInputProjectionError);
  expect(traps).toBe(0);
});

test.each(['held', 'unconfigured', 'throws'])('typed %s projection refuses with no raw fallback or empty success', async mode => {
  const { registry, tool, bodies } = fixture();
  registry.register(tool, { inputProjection: mode === 'unconfigured' ? null : { async project() {
    if (mode === 'throws') throw new Error('private-original-marker');
    return { status: 'held' };
  } } });
  for (const invoke of [() => registry.prepareCall('one', tool.definition.name, raw()), () => registry.execute('two', tool.definition.name, raw())]) {
    try { await invoke(); throw new Error('must refuse'); }
    catch (error) {
      expect(error).toBeInstanceOf(ToolInputProjectionError);
      expect(String(error)).not.toContain('private-original-marker');
      expect(String(error)).not.toContain(raw().value);
    }
  }
  expect(bodies).toHaveLength(0);
});

test('projection happens before param-fill, and ordinary semantic repair sees only the projection', async () => {
  const { registry, tool, bodies } = fixture({ type: 'object', properties: { query: { type: 'string' } }, required: ['query'] });
  const states: unknown[] = [];
  const fake = fakePort((name, question, state) => {
    states.push(state);
    return name === 'pick' ? choiceAnswer(question, 'spare', 0.99) : noulAnswer(0.99);
  });
  const log = new SqliteDecisionLog(':memory:');
  const port = withDecisionLog(fake.port, log);
  registry.register(tool, { inputProjection: { async project() {
    if (states.length > 0) expect(JSON.stringify(states)).not.toContain('synthetic-original-reference');
    return { status: 'projected', args: { spare: 'opaque-query-reference' }, assertRepairedArgs(args) {
      if (args.query !== 'opaque-query-reference' || Object.keys(args).length !== 1) throw new Error('changed');
    } };
  } } });
  try {
    const prepared = await registry.prepareCall('one', tool.definition.name, raw(), { port });
    expect(prepared.args).toEqual({ query: 'opaque-query-reference' });
    expect(prepared.judgmentDecisionIds.length).toBeGreaterThan(0);
    const readings = states.length;
    const projected = await registry.projectCall('two', tool.definition.name, raw());
    const [first, repeated] = await Promise.all([
      registry.prepareCall('two', tool.definition.name, projected.args, { port }),
      registry.prepareCall('two', tool.definition.name, projected.args, { port }),
    ]);
    expect(first).toBe(repeated);
    const after = states.length;
    expect(await registry.prepareCall('two', tool.definition.name, projected.args, { port })).toBe(first);
    expect(states.length).toBe(after); expect(after).toBeGreaterThan(readings);
    await registry.releaseProjected(projected);
    expect(JSON.stringify(states)).toContain('opaque-query-reference');
    expect(JSON.stringify(states)).not.toContain('synthetic-original-reference');
    await registry.executePrepared(prepared, () => {});
    expect(bodies[0]?.args).toEqual({ query: 'opaque-query-reference' });
  } finally { log[Symbol.dispose](); }
});

test('legacy execute also projects before semantic repair', async () => {
  const { registry, tool, bodies } = fixture({ type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] });
  const states: unknown[] = [];
  const fake = fakePort((_name, question, state) => { states.push(state); return choiceAnswer(question, 'true', 0.99); });
  const previous = installJudgmentPort(fake.port);
  registry.register(tool, { inputProjection: { async project() {
    expect(states).toHaveLength(0);
    return { status: 'projected', args: { enabled: 'yes' }, assertRepairedArgs(args) { if (args.enabled !== true) throw new Error(); } };
  } } });
  try {
    expect(await registry.execute('one', tool.definition.name, raw())).toMatchObject({ success: true });
    expect(states.length).toBeGreaterThan(0); expect(JSON.stringify(states)).not.toContain(raw().value);
    expect(bodies[0]?.args).toEqual({ enabled: true });
  } finally { installJudgmentPort(previous); }
});

test('a default projection refuses repaired bindings; ordinary numeric repair remains compatible', async () => {
  const { registry, tool, bodies } = fixture({ type: 'object', properties: { count: { type: 'number' } }, required: ['count'] });
  let releases = 0;
  registry.register(tool, { inputProjection: { async project() { return { status: 'projected', args: { count: '7' }, async release() { releases++; } }; } } });
  await expect(registry.prepareCall('one', tool.definition.name, raw())).rejects.toMatchObject({ problem: 'binding-changed' });
  expect(bodies).toHaveLength(0); expect(releases).toBe(1);
  registry.unregister(tool.definition.name); registry.register(tool);
  const prepared = await registry.prepareCall('two', tool.definition.name, { count: '7' });
  expect(prepared.args).toEqual({ count: 7 });
  await registry.executePrepared(prepared, () => {}); expect(bodies).toHaveLength(1);
  await expect(registry.prepareCall('invalid', tool.definition.name, { count: {} })).rejects.toThrow('schema');
});

test('copied handles and foreign/copied arguments cannot forge reuse or cross-call clearance', async () => {
  const { registry, tool } = fixture(); let projects = 0;
  registry.register(tool, { inputProjection: { async project(request) {
    projects++; return request.args.value === raw().value ? { status: 'projected', args: safe() } : { status: 'held' };
  } } });
  const call = await registry.projectCall('one', tool.definition.name, raw());
  expect(() => registry.assertProjected({ ...call })).toThrow(ToolInputProjectionError);
  await expect(registry.releaseProjected({ ...call })).rejects.toBeInstanceOf(ToolInputProjectionError);
  await expect(registry.projectCall('two', tool.definition.name, call.args)).rejects.toMatchObject({ problem: 'binding-changed' });
  await expect(registry.projectCall('one', tool.definition.name, { ...call.args })).rejects.toMatchObject({ problem: 'held' });
  const other = fixture(); other.registry.register(other.tool, { inputProjection: { async project() { return { status: 'held' }; } } });
  expect(() => other.registry.assertProjected(call)).toThrow(ToolInputProjectionError);
  await expect(other.registry.prepareCall('one', other.tool.definition.name, call.args)).rejects.toMatchObject({ problem: 'held' });
  expect(projects).toBe(2); await registry.releaseProjected(call);
});

test.each(['tool', 'schema', 'executor', 'projector', 'owner-signal', 'call-signal', 'authority'])('pending projection fails closed after %s changes and awaits cleanup', async change => {
  const { registry, tool, bodies } = fixture(); const waiting = deferred<void>(); const finish = deferred<void>();
  const owner = new AbortController(); const caller = new AbortController(); let current = true; let releases = 0;
  const projector: ToolInputProjector = { signal: owner.signal, async project() {
    waiting.resolve(); await finish.promise;
    return { status: 'projected', args: safe(), async release() { await Promise.resolve(); releases++; } };
  } };
  registry.register(tool, { inputProjection: projector });
  const pending = registry.projectCall('one', tool.definition.name, raw(), { signal: caller.signal, assertCurrent() { if (!current) throw new Error('private-authority'); } });
  await waiting.promise;
  if (change === 'tool') { registry.unregister(tool.definition.name); registry.register(tool, { inputProjection: projector }); }
  if (change === 'schema') tool.definition.description = 'changed';
  if (change === 'executor') tool.execute = async () => ({ success: true });
  if (change === 'projector') projector.project = async () => ({ status: 'held' });
  if (change === 'owner-signal') owner.abort();
  if (change === 'call-signal') caller.abort();
  if (change === 'authority') current = false;
  finish.resolve();
  await expect(pending).rejects.toBeInstanceOf(ToolInputProjectionError);
  expect(releases).toBe(1); expect(bodies).toHaveLength(0);
});

test('registration incarnation changes even when re-registering the exact same tool/projector', async () => {
  const { registry, tool } = fixture(); const projector: ToolInputProjector = { async project() { return { status: 'projected', args: safe() }; } };
  registry.register(tool, { inputProjection: projector });
  const first = await registry.projectCall('one', tool.definition.name, raw());
  registry.unregister(tool.definition.name); registry.register(tool, { inputProjection: projector });
  const second = await registry.projectCall('one', tool.definition.name, raw());
  expect(second.schemaRevision).toBe(first.schemaRevision);
  expect(second.projectionRevision).not.toBe(first.projectionRevision);
  expect(() => registry.assertProjected(first)).toThrow(ToolInputProjectionError);
  await registry.releaseProjected(first); await registry.releaseProjected(second);
});

test('scope authority is checked after an awaited repair and before each repair retry', async () => {
  for (const retry of [false, true]) {
    const { registry, tool, bodies } = fixture({ type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] });
    let current = true; let releases = 0; let readings = 0;
    const fake = fakePort((_name, question) => { readings++; return choiceAnswer(question, 'true', 0.99); });
    const inner: JudgmentPort = { model: fake.port.model, async ask(request) {
      request.beforeAttempt?.(); await Promise.resolve(); current = false;
      if (retry) request.beforeAttempt?.();
      return fake.port.ask(request);
    } };
    registry.register(tool, { inputProjection: { async project() { return { status: 'projected', args: { enabled: 'yes' }, assertRepairedArgs() {}, async release() { releases++; } }; } } });
    await expect(registry.prepareCall('one', tool.definition.name, raw(), { port: inner, assertCurrent() { if (!current) throw new Error(); } })).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(readings).toBe(retry ? 0 : 1); expect(releases).toBe(1); expect(bodies).toHaveLength(0);
  }
});

test('opaque execution context reaches only the body with final frozen args and is not model metadata', async () => {
  const { registry, tool } = fixture();
  const token = Object.freeze({}); const accepted = new WeakSet<object>(); let releases = 0;
  tool.execute = async (args, opts) => ({ success: opts?.inputProjectionContext === token && accepted.has(args) });
  registry.register(tool, { inputProjection: { async project() { return { status: 'projected', args: safe(), executionContext: token,
    assertRepairedArgs(args) { expect(Object.isFrozen(args)).toBe(true); accepted.add(args); }, async release() { releases++; } }; } } });
  const projected = await registry.projectCall('one', tool.definition.name, raw());
  expect(JSON.stringify(projected)).not.toContain('executionContext');
  expect(JSON.stringify(registry.getToolDefinitions())).not.toContain('inputProjection');
  expect(await tool.execute(projected.args)).toMatchObject({ success: false });
  expect(await tool.execute(projected.args, { inputProjectionContext: Object.freeze({}) })).toMatchObject({ success: false });
  const prepared = await registry.prepareCall('one', tool.definition.name, projected.args);
  expect(await registry.executePrepared(prepared, () => {}, { inputProjectionContext: Object.freeze({}) })).toMatchObject({ success: true });
  expect(releases).toBe(1);
});

test('no authority callback occurs after claim, but synchronous revocation still blocks the body', async () => {
  for (const revoke of ['none', 'signal', 'registration', 'release']) {
    const { registry, tool, bodies } = fixture(); const owner = new AbortController(); let claimed = false; let callbacks = 0;
    const projector: ToolInputProjector = { signal: owner.signal, assertCurrent() { expect(claimed).toBe(false); callbacks++; },
      async project() { return { status: 'projected', args: safe(), assertCurrent() { expect(claimed).toBe(false); callbacks++; } }; } };
    registry.register(tool, { inputProjection: projector });
    const projected = await registry.projectCall('one', tool.definition.name, raw());
    const prepared = await registry.prepareCall('one', tool.definition.name, projected.args);
    const pending = registry.executePrepared(prepared, () => {
      claimed = true;
      if (revoke === 'signal') owner.abort();
      if (revoke === 'registration') { registry.unregister(tool.definition.name); registry.register(tool, { inputProjection: projector }); }
      if (revoke === 'release') void registry.releaseProjected(projected);
    });
    if (revoke === 'none') expect(await pending).toMatchObject({ success: true });
    else await expect(pending).rejects.toThrow();
    expect(bodies).toHaveLength(revoke === 'none' ? 1 : 0); expect(callbacks).toBeGreaterThan(0);
  }
});

test('failed claims and body failures await resource release, and repeated execution cannot release a running body', async () => {
  const { registry, tool } = fixture(); const bodyStarted = deferred<void>(); const finishBody = deferred<void>(); let releases = 0;
  tool.execute = async () => { bodyStarted.resolve(); await finishBody.promise; throw new Error('body failure'); };
  registry.register(tool, { inputProjection: { async project() { return { status: 'projected', args: safe(), async release() { await Promise.resolve(); releases++; } }; } } });
  const prepared = await registry.prepareCall('one', tool.definition.name, raw());
  const running = registry.executePrepared(prepared, () => {}); await bodyStarted.promise;
  await expect(registry.executePrepared(prepared, () => {})).rejects.toThrow('claimed'); expect(releases).toBe(0);
  finishBody.resolve(); await expect(running).rejects.toThrow('body failure'); expect(releases).toBe(1);
  const next = await registry.prepareCall('two', tool.definition.name, raw());
  await expect(registry.executePrepared(next, () => { throw new Error('claim refused'); })).rejects.toThrow('claim refused'); expect(releases).toBe(2);
});

test('explicit release waits for cleanup and invalidates every derived preparation', async () => {
  const { registry, tool, bodies } = fixture(); const finish = deferred<void>(); let releases = 0;
  registry.register(tool, { inputProjection: { async project() { return { status: 'projected', args: safe(), async release() { releases++; await finish.promise; } }; } } });
  const projected = await registry.projectCall('one', tool.definition.name, raw());
  const first = await registry.prepareCall('one', tool.definition.name, projected.args);
  const second = await registry.prepareCall('one', tool.definition.name, projected.args);
  let settled = false; const releasing = registry.releaseProjected(projected).then(() => { settled = true; });
  await Promise.resolve(); expect(settled).toBe(false);
  expect(() => registry.assertPrepared(first)).toThrow(); expect(() => registry.assertPrepared(second)).toThrow();
  finish.resolve(); await releasing; await registry.releaseProjected(projected);
  expect(releases).toBe(1); expect(bodies).toHaveLength(0);
});

test('invalid returned accessors or context metadata are held and cleaned without reading values', async () => {
  for (const mode of ['args-getter', 'args-proxy', 'mutable-context', 'context-data']) {
    const { registry, tool } = fixture(); let traps = 0; let releases = 0;
    const result: Record<string, unknown> = { status: 'projected', args: safe(), async release() { releases++; } };
    if (mode === 'args-getter') Object.defineProperty(result, 'args', { get() { traps++; return raw(); } });
    if (mode === 'args-proxy') result.args = new Proxy({}, { ownKeys() { traps++; return []; } });
    if (mode === 'mutable-context') result.executionContext = {};
    if (mode === 'context-data') result.executionContext = Object.freeze({ value: 'private' });
    registry.register(tool, { inputProjection: { async project() { return result as ToolInputProjectionResult; } } });
    await expect(registry.projectCall('one', tool.definition.name, raw())).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(traps).toBe(0); expect(releases).toBe(1);
  }
});

test('ordinary model argument fields cannot request or disable the registration projector', async () => {
  const { registry, tool, bodies } = fixture(); let projects = 0;
  registry.register(tool, { inputProjection: { async project() { projects++; return { status: 'held' }; } } });
  await expect(registry.execute('one', tool.definition.name, { ...raw(), inputProjection: null, projected: true })).rejects.toMatchObject({ problem: 'held' });
  expect(projects).toBe(1); expect(bodies).toHaveLength(0);
});

test('the declared-material privacy floor runs before the trusted projector', async () => {
  const { registry, tool } = fixture(); let projects = 0;
  registry.register(tool, { inputProjection: { async project() { projects++; return { status: 'projected', args: safe() }; } } });
  await expect(registry.projectCall('one', tool.definition.name, { value: 'password=synthetic-secret' })).rejects.toThrow('inline credential');
  expect(projects).toBe(0);
});


test('protected live capture capacity is bounded and only awaited release restores capacity', async () => {
  const { registry, tool } = fixture(); let projects = 0;
  registry.register(tool, { inputProjection: { async project() { projects++; return { status: 'projected', args: safe() }; } } });
  const calls = [];
  for (let i = 0; i < 128; i++) calls.push(await registry.projectCall(`call-${i}`, tool.definition.name, raw()));
  await expect(registry.projectCall('overflow', tool.definition.name, raw())).rejects.toMatchObject({ problem: 'capacity' });
  expect(projects).toBe(128);
  await registry.releaseProjected(calls[0]!);
  const restored = await registry.projectCall('restored', tool.definition.name, raw());
  expect(projects).toBe(129);
  await Promise.all([...calls, restored].map(call => registry.releaseProjected(call)));
});


test('an explicitly missing projector cannot silently register an ordinary tool', async () => {
  const { registry, tool, bodies } = fixture();
  registry.register(tool, { inputProjection: undefined });
  await expect(registry.prepareCall('one', tool.definition.name, raw())).rejects.toMatchObject({ problem: 'unconfigured' });
  expect(bodies).toHaveLength(0);
});

test('final projection snapshot checks do not run owner callbacks', async () => {
  const { registry, tool } = fixture(); let currentCalls = 0;
  registry.register(tool, { inputProjection: { assertCurrent() { currentCalls++; }, async project() { return { status: 'projected', args: safe() }; } } });
  const call = await registry.projectCall('one', tool.definition.name, raw());
  const before = currentCalls;
  registry.assertProjectedSnapshot(call); expect(currentCalls).toBe(before);
  registry.assertProjected(call); expect(currentCalls).toBeGreaterThan(before);
  registry.unregister(tool.definition.name);
  expect(() => registry.assertProjectedSnapshot(call)).toThrow(ToolInputProjectionError);
  await registry.releaseProjected(call);
});


test('concurrent legacy reuse cannot clean another execution while repair is pending', async () => {
  const { registry, tool, bodies } = fixture({ type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] });
  const started = deferred<void>(); const finish = deferred<void>(); let releases = 0;
  const fake = fakePort((_name, question) => choiceAnswer(question, 'true', 0.99));
  const previous = installJudgmentPort({ ...fake.port, async ask(request) { started.resolve(); await finish.promise; return fake.port.ask(request); } });
  registry.register(tool, { inputProjection: { async project() { return { status: 'projected', args: { enabled: 'yes' }, assertRepairedArgs() {}, async release() { releases++; } }; } } });
  try {
    const projected = await registry.projectCall('one', tool.definition.name, raw());
    const first = registry.execute('one', tool.definition.name, projected.args);
    await started.promise;
    await expect(registry.execute('one', tool.definition.name, projected.args)).rejects.toMatchObject({ problem: 'stale' });
    expect(releases).toBe(0);
    finish.resolve(); expect(await first).toMatchObject({ success: true });
    expect(releases).toBe(1); expect(bodies).toHaveLength(1);
  } finally { finish.resolve(); installJudgmentPort(previous); }
});


test('later preparation guards can inspect their own projected catalog without recursion', async () => {
  const { registry, tool, bodies } = fixture(); let captureChecks = 0; let stageChecks = 0; let current = true; let claimed = false;
  registry.register(tool, { inputProjection: { async project() { return { status: 'projected', args: safe() }; } } });
  const projected = await registry.projectCall('one', tool.definition.name, raw(), { assertCurrent() { captureChecks++; } });
  const prepared = await registry.prepareCall('one', tool.definition.name, projected.args, { assertCurrent() {
    stageChecks++; expect(claimed).toBe(false); registry.assertProjected(projected);
    if (!current) throw new Error('changed catalog');
  } });
  const before = stageChecks; registry.assertProjected(projected);
  expect(stageChecks).toBe(before); expect(captureChecks).toBeGreaterThan(stageChecks);
  current = false;
  await expect(registry.executePrepared(prepared, () => { claimed = true; })).rejects.toMatchObject({ problem: 'stale' });
  expect(claimed).toBe(false); expect(bodies).toHaveLength(0);
});

test('cancellation added during preparation stays bound when execution omits options', async () => {
  const { registry, tool, bodies } = fixture(); const later = new AbortController(); let claims = 0;
  registry.register(tool, { inputProjection: { async project() { return { status: 'projected', args: safe() }; } } });
  const projected = await registry.projectCall('one', tool.definition.name, raw());
  const prepared = await registry.prepareCall('one', tool.definition.name, projected.args, { signal: later.signal });
  later.abort(new Error('private cancellation context'));
  expect(() => registry.assertPrepared(prepared)).toThrow(ToolInputProjectionError);
  await expect(registry.executePrepared(prepared, () => { claims++; })).rejects.toMatchObject({ problem: 'cancelled' });
  expect(claims).toBe(0); expect(bodies).toHaveLength(0);
});


test('DOM-realm imports are harmless while missing native signal intrinsics fail closed', () => {
  const projectionUrl = new URL('../sdk/src/platform/tools/input-projection.ts', import.meta.url).href;
  const registryUrl = new URL('../sdk/src/platform/tools/registry.ts', import.meta.url).href;
  const script = `
    const native = new AbortController();
    globalThis.AbortSignal = class UnsupportedSignal {};
    const projection = await import(${JSON.stringify(projectionUrl)});
    projection.assertProjectionSignal(undefined);
    if (projection.combineProjectionSignals(undefined) !== undefined) throw new Error('empty signal changed');
    let reads = 0;
    for (const signal of [native.signal, { get aborted() { reads++; return false; } }]) {
      for (const check of [projection.projectionSignal, projection.assertProjectionSignal]) {
        let refused = false;
        try { check(signal); } catch (error) { refused = error instanceof projection.ToolInputProjectionError; }
        if (!refused) throw new Error('unavailable signal validation passed');
      }
    }
    if (reads !== 0) throw new Error('signal accessor ran');
    const { ToolRegistry } = await import(${JSON.stringify(registryUrl)});
    const registry = new ToolRegistry();
    const args = { value: 'ordinary' };
    registry.register({ definition: { name: 'ordinary', description: 'ordinary fixture', parameters: { type: 'object' } },
      async execute(received) { if (received !== args) throw new Error('legacy identity changed'); return { success: true }; } });
    if (!(await registry.execute('ordinary-call', 'ordinary', args)).success) throw new Error('ordinary execution failed');
  `;
  const child = spawnSync(process.execPath, ['--eval', script], { encoding: 'utf8', timeout: 20_000 });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
});

test('ordinary legacy execution preserves input and option identity without a projection capability', async () => {
  const { registry, tool, bodies } = fixture();
  registry.register(tool);
  const args = raw(); const options = { signal: new AbortController().signal };
  expect(await registry.execute('legacy-identity', tool.definition.name, args, options)).toMatchObject({ success: true });
  expect(bodies[0]?.args).toBe(args);
  expect(bodies[0]?.opts).toBe(options);
  expect(Object.isFrozen(args)).toBe(false);
});
