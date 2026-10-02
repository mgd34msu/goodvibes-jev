import { afterEach, expect, test } from 'bun:test';
import { run } from '../sdk/src/platform/hooks/runners/agent.js';
import type { HookDefinition, HookEvent } from '../sdk/src/platform/hooks/types.js';
import { ASK, makeHarness, oneUnitPlan, waitFor, type Harness } from './contract/runner-support.js';

let harness: Harness | undefined;
afterEach(() => { harness?.dispose(); harness = undefined; });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const event: HookEvent = { path: 'Post:tool:write', phase: 'Post', category: 'tool', specific: 'write', sessionId: 'owned-hook', timestamp: 1, payload: {} };
const hook: HookDefinition = { match: event.path, type: 'agent', prompt: ASK, timeout: 5 };
function setup(options: Parameters<typeof makeHarness>[0]) {
  const h = harness = makeHarness(options);
  h.manager.setContractRunner(h.runner);
  return h;
}

test('scoped agent hook joins real unit executor finally after cancellation', async () => {
  const h = setup({ plan: oneUnitPlan(1), scripts: {} });
  const entered = deferred();
  const cleanup = deferred();
  h.manager.setExecutor({ runAgent: async (record) => {
    record.status = 'running';
    entered.resolve();
    try {
      const signal = h.manager.getCancellationSignal(record.id)!;
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    } finally {
      await cleanup.promise;
    }
  } });
  const controller = new AbortController();
  let finished = false;
  const result = run(hook, event, h.manager, { signal: controller.signal }).then((value) => { finished = true; return value; });
  await entered.promise;
  controller.abort();
  await tick();
  expect(h.manager.list().find((record) => record.contractRole === 'owner')?.status).toBe('cancelled');
  expect(finished).toBe(false);
  cleanup.resolve();
  expect(await result).toMatchObject({ ok: false, error: 'agent hook cancelled' });
});

test('scoped hook waits for planner finally even after owner becomes cancelled', async () => {
  const entered = deferred();
  const cleanup = deferred();
  const h = setup({ plan: oneUnitPlan(1), scripts: {}, planner: { run: async (request) => {
    entered.resolve();
    try {
      if (!request.signal?.aborted) await new Promise<void>((resolve) => request.signal!.addEventListener('abort', () => resolve(), { once: true }));
      return { status: 'cancelled', output: '', elapsedMs: 1 };
    } finally { await cleanup.promise; }
  } } });
  const controller = new AbortController();
  let finished = false;
  const result = run(hook, event, h.manager, { signal: controller.signal }).then((value) => { finished = true; return value; });
  await entered.promise;
  controller.abort();
  await tick();
  expect(finished).toBe(false);
  cleanup.resolve();
  expect((await result).ok).toBe(false);
});

test('successful contract status does not finish scoped hook before completion-step cleanup', async () => {
  const cleanup = deferred();
  const terminal = deferred();
  const h = setup({
    plan: oneUnitPlan(1),
    scripts: { u1: () => [{ files: { 'src/csv.ts': 'export const parse = () => [];\n' }, text: 'done' }] },
    steps: { groupsPassed: async (contractRun) => {
      try {
        contractRun.moveContract('judging');
        contractRun.moveContract('committing');
        contractRun.control.finishPassed({ answer: 'answer', statusLine: 'complete' });
        terminal.resolve();
      }
      finally { await cleanup.promise; }
    } },
  });
  let finished = false;
  const result = run(hook, event, h.manager, { signal: new AbortController().signal }).then((value) => { finished = true; return value; });
  await terminal.promise;
  await tick();
  expect(h.manager.list().find((record) => record.contractRole === 'owner')?.status).toBe('completed');
  expect(finished).toBe(false);
  cleanup.resolve();
  expect(await result).toEqual({ ok: true, additionalContext: 'answer' });
});

test('abort inside the owner spawn event cancels the correct returned record and joins it', async () => {
  const controller = new AbortController();
  const h = setup({ plan: oneUnitPlan(1), scripts: {} });
  const register = h.messageBus.registerAgent.bind(h.messageBus);
  h.messageBus.registerAgent = (...args) => { controller.abort(); return register(...args); };
  expect((await run(hook, event, h.manager, { signal: controller.signal })).ok).toBe(false);
  const owner = h.manager.list().find((record) => record.contractRole === 'owner')!;
  expect(owner.status).toBe('cancelled');
  expect(h.store.get(owner.contractId!)?.status).toBe('cancelled');
  expect(h.manager.list()).toHaveLength(1);
});

test('scoped timeout requests cancellation but still awaits genuine executor cleanup', async () => {
  const cleanup = deferred();
  const h = setup({ plan: oneUnitPlan(1), scripts: {} });
  h.manager.setExecutor({ runAgent: async (record) => {
    record.status = 'running';
    try {
      const signal = h.manager.getCancellationSignal(record.id)!;
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    } finally { await cleanup.promise; }
  } });
  let finished = false;
  const result = run({ ...hook, timeout: 0.2 }, event, h.manager, { signal: new AbortController().signal }).then((value) => { finished = true; return value; });
  await waitFor(() => h.manager.list().some((record) => record.contractRole === 'unit'), 'unit admission');
  await waitFor(() => h.manager.list().some((record) => record.contractRole === 'owner' && record.status === 'cancelled'), 'timeout cancellation');
  expect(finished).toBe(false);
  cleanup.resolve();
  expect((await result).error).toContain('timed out after 0.2s');
});


for (const status of ['completed', 'failed'] as const) {
  test(`scoped cancellation reaches the exact engine signal after unit ${status}, and joins delayed cleanup`, async () => {
    const entered = deferred();
    const aborted = deferred();
    const cleanup = deferred();
    const h = setup({ plan: oneUnitPlan(1), scripts: {} });
    let signal!: AbortSignal;
    let unitId!: string;
    h.manager.setExecutor({ runAgent: async (record) => {
      // Let spawn return so the phase can install its external signal.
      await Promise.resolve();
      unitId = record.id;
      signal = h.manager.getCancellationSignal(record.id)!;
      record.status = status;
      entered.resolve();
      try {
        if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => { aborted.resolve(); resolve(); }, { once: true }));
      } finally { await cleanup.promise; }
    } });
    const controller = new AbortController();
    let finished = false;
    const result = run(hook, event, h.manager, { signal: controller.signal }).then((value) => { finished = true; return value; });
    await entered.promise;
    expect(h.manager.getCancellationSignal(unitId)).toBe(signal);
    controller.abort();
    await aborted.promise;
    expect(signal.aborted).toBe(true);
    expect(h.manager.getStatus(unitId)?.status).toBe(status);
    expect(finished).toBe(false);
    cleanup.resolve();
    expect((await result).ok).toBe(false);
  });
}


test('owned native contract rejects a legacy engine before any phase or workstream starts', async () => {
  let created = 0;
  let started = 0;
  let disposed = 0;
  const h = setup({
    plan: oneUnitPlan(1), scripts: {},
    createEngine: () => ({
      createWorkstream() { created += 1; },
      start() { started += 1; },
      dispose() { disposed += 1; },
    }) as never,
  });
  const result = await run(hook, event, h.manager, {});
  expect(result.ok).toBe(false);
  expect(result.error).toContain('orchestration engine with execution settlement');
  expect(result.code).toBe('OWNED_AGENT_EXECUTION_UNSUPPORTED');
  expect(created).toBe(0);
  expect(started).toBe(0);
  expect(disposed).toBe(1);
  expect(h.manager.list().filter((record) => record.contractRole === 'unit')).toHaveLength(0);
});

test('empty options still enforces an owned deadline and joins real contract cleanup', async () => {
  const cleanup = deferred();
  const h = setup({ plan: oneUnitPlan(1), scripts: {} });
  h.manager.setExecutor({ runAgent: async (record) => {
    record.status = 'running';
    const signal = h.manager.getCancellationSignal(record.id)!;
    try {
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    } finally { await cleanup.promise; }
  } });
  let finished = false;
  const result = run({ ...hook, timeout: 0.2 }, event, h.manager, {}).then((value) => { finished = true; return value; });
  await waitFor(() => h.manager.list().some((record) => record.contractRole === 'owner' && record.status === 'cancelled'), 'empty-options deadline');
  expect(finished).toBe(false);
  cleanup.resolve();
  expect((await result).error).toContain('timed out after 0.2s');
});


test('native owned-start preflight refuses a manager without a real join before creating the owner', async () => {
  const h = setup({ plan: oneUnitPlan(1), scripts: {} });
  Object.defineProperty(h.manager, 'join', { value: undefined });
  const result = await run(hook, event, h.manager, {});
  expect(result.ok).toBe(false);
  expect(result.error).toContain('agent execution settlement');
  expect(result.code).toBe('OWNED_AGENT_EXECUTION_UNSUPPORTED');
  expect(h.manager.list()).toHaveLength(0);
  expect(h.events).toHaveLength(0);
});
