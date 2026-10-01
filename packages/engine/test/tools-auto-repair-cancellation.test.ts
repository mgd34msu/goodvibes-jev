import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { JudgmentError, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { repairToolCall } from '../sdk/src/platform/tools/auto-repair.ts';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.ts';
import { wrapExecToolForAgentPolicy } from '../sdk/src/platform/gate/policy/tool-policy-guard.ts';
import { executeToolCalls } from '../sdk/src/platform/core/orchestrator-tool-runtime.ts';
import { ToolCallAbortRegistry } from '../sdk/src/platform/core/orchestrator-live-turn.ts';
import type { PermissionManager } from '../sdk/src/platform/permissions/manager.ts';
import type { Tool, ToolDefinition, ToolExecuteOptions } from '../sdk/src/platform/types/tools.ts';

const SECRET_REASON = 'synthetic-private-cancellation-context';
const SCHEMA: ToolDefinition = {
  name: 'exec', description: 'An intercepted synthetic tool; no command is run.',
  parameters: { type: 'object', required: ['command'], properties: {
    command: { type: 'string' }, enabled: { type: 'boolean' }, count: { type: 'number' },
  } },
};
const cases = [
  { name: 'param-fill', args: { cmd: 'synthetic fixture' }, fixed: { command: 'synthetic fixture' } },
  { name: 'boolean-value', args: { command: 'synthetic fixture', enabled: 'enabled' }, fixed: { command: 'synthetic fixture', enabled: true } },
];
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Cancelled argument repair did not settle')), 500);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const settledError = (work: Promise<unknown>): Promise<unknown> => work.then(() => null, (error: unknown) => error);
function expectCancelled(error: unknown): void {
  expect(error).toMatchObject({ message: 'the judgment call was cancelled' });
  const cause = (error as Error).cause;
  expect(cause ?? error).toMatchObject({ name: 'JudgmentError', kind: 'aborted' });
  expect(cause instanceof Error ? cause.cause : undefined).toBeUndefined();
  expect(JSON.stringify(error)).not.toContain(SECRET_REASON);
  expect(String(error)).not.toContain(SECRET_REASON);
}
function intercepted(guarded = true) {
  const calls: Array<{ args: Record<string, unknown>; options?: ToolExecuteOptions | undefined }> = [];
  const tool: Tool = { definition: structuredClone(SCHEMA), async execute(args, options) {
    calls.push({ args, options });
    return { success: true, output: 'intercepted' };
  } };
  if (guarded) wrapExecToolForAgentPolicy(tool);
  const registry = new ToolRegistry(); registry.register(tool);
  return { registry, calls };
}
function reader(confidence = 0.99, neither = false) {
  const fake = fakePort((name, question) => {
    if (name === 'pick') return choiceAnswer(question, neither ? 'none' : 'cmd', confidence);
    if (name === 'boolean_value') return choiceAnswer(question, neither ? 'neither' : 'true', confidence);
    if (name.startsWith('fits_')) return noulAnswer(0.99);
    throw new Error(`Unexpected synthetic repair question: ${name}`);
  });
  const readings: string[] = []; const actions: string[] = [];
  const port: JudgmentPort = {
    model: fake.port.model,
    recorder: { recordReadings(id) { readings.push(id); }, recordAction(id) { actions.push(id); } },
    async ask(request) { return { ...await fake.port.ask(request), decisionId: `repair-${fake.requests.length}` }; },
  };
  return { port, readings, actions, requests: fake.requests };
}
function delayedReader() {
  const started = deferred<AbortSignal | undefined>(); const release = deferred<void>();
  const base = reader(); let requests = 0;
  installJudgmentPort({ ...base.port, async ask(request) {
    requests++;
    if (requests === 1) { started.resolve(request.signal); await release.promise; }
    return base.port.ask(request);
  } });
  return { ...base, started, release, count: () => requests };
}

describe('ToolRegistry argument repair cancellation before guarded execution', () => {
  for (const entry of cases) {
    test(`${entry.name}: pre-aborted repair never asks or executes and hides its reason`, async () => {
      const base = reader(); installJudgmentPort(base.port);
      const { registry, calls } = intercepted();
      const controller = new AbortController(); controller.abort(new Error(SECRET_REASON));
      expectCancelled(await settledError(registry.execute('cancelled', 'exec', entry.args, { signal: controller.signal })));
      expect(base.requests).toHaveLength(0); expect(calls).toHaveLength(0);
    });

    test(`${entry.name}: abort promptly releases a reader that ignores its signal`, async () => {
      const delayed = delayedReader(); const { registry, calls } = intercepted();
      const args = structuredClone(entry.args); const before = structuredClone(args);
      const controller = new AbortController();
      const added = spyOn(controller.signal, 'addEventListener'); const removed = spyOn(controller.signal, 'removeEventListener');
      const result = settledError(registry.execute('cancelled', 'exec', args, { signal: controller.signal }));
      try {
        const signal = await delayed.started.promise;
        controller.abort(new Error(SECRET_REASON));
        expectCancelled(await within(result));
        expect(signal).toBe(controller.signal);
        expect(added.mock.calls.length).toBeGreaterThan(0);
        expect(removed.mock.calls.length).toBe(added.mock.calls.length);
        expect(calls).toHaveLength(0); expect(args).toEqual(before);
      } finally {
        delayed.release.resolve(); await result; await turn(); added.mockRestore(); removed.mockRestore();
      }
      expect(calls).toHaveLength(0); expect(args).toEqual(before);
      expect(delayed.readings).toHaveLength(0); expect(delayed.actions).toHaveLength(0);
    });

    test(`${entry.name}: a later active caller completes without an old late result changing it`, async () => {
      const delayed = delayedReader(); const { registry, calls } = intercepted();
      const args = structuredClone(entry.args);
      const first = new AbortController(); const second = new AbortController();
      const cancelled = settledError(registry.execute('old', 'exec', args, { signal: first.signal }));
      try {
        await delayed.started.promise; first.abort(new Error(SECRET_REASON));
        expectCancelled(await within(cancelled));
        const options = { signal: second.signal };
        const active = await registry.execute('active', 'exec', args, options);
        expect(active.success).toBe(true); expect(calls).toEqual([{ args: entry.fixed, options }]);
        expect(active.output).toStartWith('[Auto-repaired:');
        expect(calls[0]!.options).toBe(options); expect(second.signal.aborted).toBe(false);
        expect(delayed.actions).toHaveLength(1); expect(delayed.readings).toHaveLength(1);
      } finally { delayed.release.resolve(); await cancelled; await turn(); }
      expect(delayed.count()).toBe(2); expect(calls).toHaveLength(1);
      expect(delayed.actions).toHaveLength(1); expect(delayed.readings).toHaveLength(1);
      expect(args).toEqual(entry.args);
    });

    test(`${entry.name}: a late rejection is consumed and never starts execution`, async () => {
      const delayed = delayedReader(); const { registry, calls } = intercepted();
      const controller = new AbortController();
      const result = settledError(registry.execute('cancelled', 'exec', entry.args, { signal: controller.signal }));
      try {
        await delayed.started.promise; controller.abort(new Error(SECRET_REASON));
        expectCancelled(await within(result));
      } finally { delayed.release.reject(new Error('synthetic late reader rejection')); await result; await turn(); }
      expect(calls).toHaveLength(0); expect(delayed.actions).toHaveLength(0);
    });

    test(`${entry.name}: weak or negative readings keep their genuine unrepaired result`, async () => {
      for (const base of [reader(0.5), reader(0.99, true)]) {
        installJudgmentPort(base.port);
        const controller = new AbortController();
        const result = await repairToolCall('exec', entry.args, SCHEMA, controller.signal);
        expect(result.repaired).toBe(false); expect(result.fixed).toEqual(entry.args);
        expect(base.requests).toHaveLength(1); expect(base.requests[0]!.signal).toBe(controller.signal);
      }
    });
  }

  test('cancellation while recording a reading cannot apply it or start the next repair', async () => {
    const base = reader(); const controller = new AbortController();
    installJudgmentPort({ ...base.port, recorder: {
      recordReadings() { controller.abort(new Error(SECRET_REASON)); },
      recordAction: base.port.recorder!.recordAction,
    } });
    const { registry, calls } = intercepted();
    expectCancelled(await settledError(registry.execute('cancelled', 'exec', { cmd: 'synthetic fixture', enabled: 'enabled' }, { signal: controller.signal })));
    expect(base.requests).toHaveLength(1); expect(base.actions).toHaveLength(0); expect(calls).toHaveLength(0);
  });

  test('no reading or action is recorded after abort across response microtask boundaries', async () => {
    const late: string[] = [];
    for (const entry of cases) for (let depth = 0; depth < 15; depth++) {
      const controller = new AbortController(); const base = reader();
      const recorder = {
        recordReadings() { expect(this).toBe(recorder); if (controller.signal.aborted) late.push(`${entry.name}:${depth}:reading`); },
        recordAction() { expect(this).toBe(recorder); if (controller.signal.aborted) late.push(`${entry.name}:${depth}:action`); },
      };
      installJudgmentPort({ ...base.port, recorder, async ask(request) {
        const result = await base.port.ask(request);
        let remaining = depth;
        const abort = (): void => {
          if (remaining-- === 0) controller.abort(new Error(SECRET_REASON));
          else queueMicrotask(abort);
        };
        queueMicrotask(abort);
        return result;
      } });
      const error = await settledError(repairToolCall('exec', entry.args, SCHEMA, controller.signal));
      if (error !== null) expectCancelled(error);
      await turn();
    }
    expect(late).toEqual([]);
  });

  for (const guarded of [true, false]) for (const changeSignal of [false, true]) test(`cancellation at the completed repair await edge stops ${guarded ? 'guarded' : 'unwrapped'} execution${changeSignal ? ' with mutated options' : ''}`, async () => {
    const base = reader(); const controller = new AbortController();
    const options = { signal: controller.signal };
    installJudgmentPort({ ...base.port, recorder: {
      recordReadings: base.port.recorder!.recordReadings,
      recordAction() {
        if (changeSignal) options.signal = new AbortController().signal;
        queueMicrotask(() => controller.abort(new Error(SECRET_REASON)));
      },
    } });
    const { registry, calls } = intercepted(guarded);
    expectCancelled(await settledError(registry.execute('cancelled', 'exec', { command: 'synthetic fixture', enabled: 'enabled' }, options)));
    expect(calls).toHaveLength(0);
  });

  test('cancellation is not swallowed by structural warning recovery', async () => {
    const controller = new AbortController();
    const args = Object.defineProperty({}, 'unclonable', { enumerable: true, get() {
      controller.abort(new Error(SECRET_REASON)); throw new Error('synthetic clone failure');
    } });
    expectCancelled(await settledError(repairToolCall('exec', args, SCHEMA, controller.signal)));
  });

  test('structural-only repairs remain local and ordinary failures remain warnings', async () => {
    const result = await repairToolCall('exec', { command: 'synthetic fixture', enabled: 'false', count: '2' }, SCHEMA, new AbortController().signal);
    expect(result.fixed).toEqual({ command: 'synthetic fixture', enabled: false, count: 2 });
    const args = { command: 'synthetic fixture', unclonable: () => undefined };
    const failure = await repairToolCall('exec', args, SCHEMA);
    expect(failure).toMatchObject({ repaired: false, original: args, fixed: args });
    expect(failure.warnings).toHaveLength(1);
  });

  test('an uncancelled judgment failure keeps its typed identity and cleans its listener', async () => {
    const failure = new JudgmentError('unavailable', 'synthetic reader unavailable');
    installJudgmentPort({ model: 'synthetic', async ask() { throw failure; } });
    const controller = new AbortController();
    const added = spyOn(controller.signal, 'addEventListener'); const removed = spyOn(controller.signal, 'removeEventListener');
    try {
      expect(await settledError(repairToolCall('exec', { cmd: 'synthetic fixture' }, SCHEMA, controller.signal))).toBe(failure);
      expect(added.mock.calls.length).toBeGreaterThan(0);
      expect(removed.mock.calls.length).toBe(added.mock.calls.length);
    } finally { added.mockRestore(); removed.mockRestore(); }
  });

  test('the public orchestrator returns structured cancellation, closes ownership and continues its batch', async () => {
    const delayed = delayedReader(); const { registry, calls } = intercepted();
    const aborts = new ToolCallAbortRegistry();
    const result = executeToolCalls({
      toolRegistry: registry, permissionManager: { check: async () => true } as unknown as PermissionManager,
      hookDispatcher: null, runtimeBus: null, sessionId: 'synthetic-session',
      emitterContext: (turnId) => ({ sessionId: 'synthetic-session', traceId: turnId, source: 'orchestrator' }),
      toolCallSignals: aborts,
    }, 'synthetic-turn', [
      { id: 'cancelled', name: 'exec', arguments: { cmd: 'synthetic fixture' } },
      { id: 'active', name: 'exec', arguments: { command: 'synthetic fixture' } },
    ]);
    try {
      await delayed.started.promise; expect(aborts.cancel('cancelled')).toBe(true);
      // The tool never started, so the existing orchestrator error path has
      // no execution output to preserve. Do not invent an exec envelope.
      expect(await within(result)).toEqual([
        { callId: 'cancelled', success: false, error: 'cancelled by user', cancelled: true },
        { callId: 'active', success: true, output: 'intercepted' },
      ]);
      expect(aborts.list()).toHaveLength(0); expect(calls).toHaveLength(1);
    } finally { delayed.release.resolve(); await result; await turn(); }
    expect(calls).toHaveLength(1); expect(delayed.actions).toHaveLength(0);
  });

  for (const toolReportsCancellation of [true, false]) test(`an already-started tool retains its JSON when ${toolReportsCancellation ? 'tool and owner report' : 'only the owner reports'} cancellation`, async () => {
    const entered = deferred<void>(); const release = deferred<void>();
    const output = JSON.stringify({ cancelled: true, partial: 'synthetic intercepted output' });
    const registry = new ToolRegistry();
    const tool: Tool = { definition: structuredClone(SCHEMA), async execute() {
      entered.resolve(); await release.promise;
      return { success: false, ...(toolReportsCancellation ? { cancelled: true } : {}), output };
    } };
    wrapExecToolForAgentPolicy(tool); registry.register(tool);
    const aborts = new ToolCallAbortRegistry();
    const result = executeToolCalls({
      toolRegistry: registry, permissionManager: { check: async () => true } as unknown as PermissionManager,
      hookDispatcher: null, runtimeBus: null, sessionId: 'synthetic-session',
      emitterContext: (turnId) => ({ sessionId: 'synthetic-session', traceId: turnId, source: 'orchestrator' }),
      toolCallSignals: aborts,
    }, 'synthetic-turn', [{ id: 'started', name: 'exec', arguments: { command: 'synthetic fixture', enabled: 'true' } }]);
    await entered.promise; expect(aborts.cancel('started')).toBe(true); release.resolve();
    expect(await within(result)).toEqual([{ callId: 'started', success: false, error: 'cancelled by user', cancelled: true, output }]);
    const [cancelled] = await result;
    expect(JSON.parse(cancelled!.output as string)).toEqual({ cancelled: true, partial: 'synthetic intercepted output' });
    expect(aborts.list()).toHaveLength(0);
  });

  test('tool-reported cancellation preserves its JSON without an owner signal', async () => {
    const output = JSON.stringify({ cancelled: true });
    const registry = new ToolRegistry();
    registry.register({ definition: structuredClone(SCHEMA), async execute() { return { success: false, cancelled: true, output }; } });
    const result = await registry.execute('cancelled', 'exec', { command: 'synthetic fixture', enabled: 'true' });
    expect(result).toEqual({ callId: 'cancelled', success: false, cancelled: true, output });
    expect(JSON.parse(result.output as string)).toEqual({ cancelled: true });
  });
});
