import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import { authoredPrivacyAnswer, errorText } from './_helpers/authored-error-readings.ts';
import { redactSensitiveDataAsync } from '../sdk/src/platform/utils/redaction.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createPhasedExecutor } from '../sdk/src/platform/runtime/tools/index.js';
import type { ToolRuntimeContext } from '../sdk/src/platform/runtime/tools/index.js';
import type { Tool } from '../sdk/src/platform/types/tools.js';

function outputTool(name: string, output: string): Tool {
  return {
    definition: {
      name,
      description: 'Tool used by phased warning tests',
      parameters: { type: 'object', properties: {} },
    },
    async execute() {
      return { success: true, output };
    },
  };
}

function runtimeContext(
  fire: (event: { phase: string }) => Promise<{ ok: boolean; error?: string | undefined }> = async () => ({ ok: true }),
): ToolRuntimeContext {
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
    hookDispatcher: { fire },
  } as unknown as ToolRuntimeContext;
}

describe('phased tool phase warnings', () => {
  test('large output maps completely without an implicit size warning', async () => {
    const executor = createPhasedExecutor({
      enableHooks: false,
      enablePermissions: false,
      enableEvents: false,
    });

    const result = await executor.execute(
      { id: 'call-map', name: 'large_output_tool', arguments: {} },
      outputTool('large_output_tool', 'x'.repeat(205 * 1024)),
      runtimeContext(),
    );

    const mapped = executor.getRecord('call-map')?.phases.find((phase) => phase.phase === 'mapped');
    expect(result.success).toBe(true);
    expect(result.warnings ?? []).toEqual([]);
    expect(result.output).toBe('x'.repeat(205 * 1024));
    expect(mapped?.success).toBe(true);
    expect(mapped?.error).toBeUndefined();
    expect(mapped?.warnings?.[0]).toBe(result.warnings?.[0]);
  });

  test('posthook ok=false preserves success and surfaces visible warnings', async () => {
    const executor = createPhasedExecutor({
      enableHooks: true,
      enablePermissions: false,
      enableEvents: false,
    });

    const result = await executor.execute(
      { id: 'call-post', name: 'posthook_warning_tool', arguments: {} },
      outputTool('posthook_warning_tool', 'ok'),
      runtimeContext(async (event) => (
        event.phase === 'Post'
          ? { ok: false, error: 'audit sink unavailable' }
          : { ok: true }
      )),
    );

    const posthooked = executor.getRecord('call-post')?.phases.find((phase) => phase.phase === 'posthooked');
    expect(result.success).toBe(true);
    expect(result.warnings).toEqual(['Post-hook warning: audit sink unavailable']);
    expect(result.output).toBe('[Warning: Post-hook warning: audit sink unavailable]\nok');
    expect(posthooked?.success).toBe(true);
    expect(posthooked?.error).toBeUndefined();
    expect(posthooked?.warnings).toEqual(result.warnings);
  });

  test('posthook throws preserve success and surface visible warnings', async () => {
    expect(await redactSensitiveDataAsync('audit sink threw')).toBe('audit sink threw');
    const executor = createPhasedExecutor({
      enableHooks: true,
      enablePermissions: false,
      enableEvents: false,
    });

    const result = await executor.execute(
      { id: 'call-post-throw', name: 'posthook_throw_tool', arguments: {} },
      outputTool('posthook_throw_tool', 'ok'),
      runtimeContext(async (event) => {
        if (event.phase === 'Post') {
          throw new Error('audit sink threw');
        }
        return { ok: true };
      }),
    );

    const posthooked = executor.getRecord('call-post-throw')?.phases.find((phase) => phase.phase === 'posthooked');
    expect(result.success).toBe(true);
    expect(result.warnings).toEqual(['Post-hook warning: audit sink threw']);
    expect(result.output).toBe('[Warning: Post-hook warning: audit sink threw]\nok');
    expect(posthooked?.success).toBe(true);
    expect(posthooked?.error).toBeUndefined();
    expect(posthooked?.warnings).toEqual(result.warnings);
  });
});


const readDiagnostic = authoredPrivacyAnswer({ parts: [[errorText('audit sink threw')]] });
let previousDiagnosticPort: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  previousDiagnosticPort = installJudgmentPort(fakePort((name, question, state) => {
    const answer = readDiagnostic(name, question, state);
    if (answer === undefined) throw new Error('Unexpected authored diagnostic question');
    return answer;
  }).port);
});
afterEach(() => { installJudgmentPort(previousDiagnosticPort); });
