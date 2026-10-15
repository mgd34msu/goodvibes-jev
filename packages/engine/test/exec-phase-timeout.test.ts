/** Explicit execution budgets and cancellation remain effective without a default tool deadline. */

import { describe, expect, test } from 'bun:test';
import { createPhasedExecutor } from '../sdk/src/platform/runtime/tools/index.js';
import type { ToolRuntimeContext } from '../sdk/src/platform/runtime/tools/index.js';
import type { Tool } from '../sdk/src/platform/types/tools.js';

function sleepingTool(name: string, ms: number): Tool {
  return {
    definition: {
      name,
      description: 'Tool used by phase-timeout tests',
      parameters: { type: 'object', properties: {} },
    },
    async execute() {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return { success: true, output: 'done' };
    },
  };
}

function runtimeContext(): ToolRuntimeContext {
  return {
    runtime: {
      getState: () => ({}),
      subscribe: () => () => undefined,
    },
    ids: {
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      traceId: 'trace-1',
    },
    tasks: {},
    resources: {},
    provider: {
      providerId: 'test',
      modelId: 'test-model',
      contextWindow: 128_000,
    },
    cancellation: {
      signal: new AbortController().signal,
    },
    executionMode: 'background',
    hookDispatcher: { fire: async () => ({ ok: true }) },
  } as unknown as ToolRuntimeContext;
}

describe('executePhase: explicit budgets and cancellation', () => {
  test('an operation without a deadline receives and honors caller cancellation', async () => {
    const executor = createPhasedExecutor({ enableHooks: false, enablePermissions: false, enableEvents: false });
    const controller = new AbortController();
    const context = { ...runtimeContext(), cancellation: { signal: controller.signal } };
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let cancelled = false;
    const tool = sleepingTool('exec', 0);
    tool.execute = async (_args, options) => {
      await new Promise<never>((_, reject) => {
        options!.signal!.addEventListener('abort', () => { cancelled = true; reject(options!.signal!.reason); }, { once: true });
        started();
      });
      return { success: true };
    };
    const pending = executor.execute({ id: 'cancel-exec', name: 'exec', arguments: { commands: [{ cmd: 'true' }] } }, tool, context);
    await ready; controller.abort(new Error('Owner cancelled execution'));
    expect((await pending).success).toBe(false);
    expect(cancelled).toBe(true);
  });

  test('an exec argument cannot override an explicit phase deadline', async () => {
    const executor = createPhasedExecutor({
      enableHooks: false,
      enablePermissions: false,
      enableEvents: false,
      // Deliberately small so the sleeping tool would time out on the default path.
      phaseTimeouts: { executing: 50 },
    });

    const result = await executor.execute(
      { id: 'call-exec', name: 'exec', arguments: { timeout_ms: 2000, commands: [{ cmd: 'true' }] } },
      sleepingTool('exec', 300),
      runtimeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out after 50ms');
  });

  test('a non-exec tool is unaffected: the small configured phase timeout still applies', async () => {
    const executor = createPhasedExecutor({
      enableHooks: false,
      enablePermissions: false,
      enableEvents: false,
      phaseTimeouts: { executing: 50 },
    });

    let started = 0; let finished = false; let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    const tool = sleepingTool('some_other_tool', 300); const execute = tool.execute;
    tool.execute = async (args, options) => {
      started++;
      try { const result = await execute(args, options); finished = true; return result; }
      finally { settle(); }
    };
    try {
      const result = await executor.execute(
        { id: 'call-other', name: 'some_other_tool', arguments: { timeout_ms: 2000 } }, tool, runtimeContext(),
      );
      expect(result.success).toBe(false); expect(result.error).toContain('timed out after 50ms'); expect(result.output).toBeUndefined();
      expect(started).toBe(1); expect(finished).toBe(false);
      const record = executor.getRecord('call-other');
      if (!record) throw new Error('Timed-out call must retain its execution record');
      expect(record.currentPhase).toBe('failed'); expect(record.result).toBeUndefined();
      expect(record.phases.filter(phase => phase.phase === 'executing')).toEqual([
        expect.objectContaining({ phase: 'executing', success: false, abort: true, error: expect.stringContaining('timed out after 50ms') }),
      ]);
      await settled;
      expect(finished).toBe(true); expect(record.currentPhase).toBe('failed'); expect(record.result).toBeUndefined();
    } finally { if (started > 0) await settled; }
  });
});
