import { describe, expect, test } from 'bun:test';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { CommandContext, CommandRegistry } from '../../input/command-registry.ts';
import { createAgentExecutionTool, registerAgentExecutionTool } from '../../tools/agent-execution-tool.ts';

function fakeTool(calls: Record<string, unknown>[]): Tool {
  return {
    definition: {
      name: 'agent_harness',
      description: 'Fake harness',
      parameters: { type: 'object', additionalProperties: true },
    },
    execute: async (args: Record<string, unknown>) => {
      calls.push(args);
      return { success: true, output: JSON.stringify({ args }) };
    },
  };
}

function makeTool(calls: Record<string, unknown>[] = []): Tool {
  return createAgentExecutionTool({
    commandRegistry: {} as CommandRegistry,
    commandContext: { workspace: {}, platform: {}, session: { runtime: {} } } as CommandContext,
    toolRegistry: new ToolRegistry(),
    harnessTool: fakeTool(calls),
  });
}

describe('execution adapter', () => {
  test('routes posture and execution route inspection', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({});
    await tool.execute({ action: 'status', query: 'local', limit: 4 });
    await tool.execute({ executionRouteId: 'local-shell-command' });
    await tool.execute({ action: 'route', id: 'delegation-isolation-parallel-remote', includeParameters: true });

    expect(calls).toEqual([
      { mode: 'execution_posture' },
      { mode: 'execution_posture', query: 'local', limit: 4 },
      { mode: 'execution_route', executionRouteId: 'local-shell-command' },
      { mode: 'execution_route', executionRouteId: 'delegation-isolation-parallel-remote', includeParameters: true },
    ]);
  });

  test('routes execution history and record inspection', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({ action: 'history', target: 'test', limit: 5 });
    await tool.execute({ executionRecordId: 'rec-1' });
    await tool.execute({ action: 'record', id: 'rec-2', includeParameters: true });
    await tool.execute({ action: 'item', query: 'failed build' });

    expect(calls).toEqual([
      { mode: 'execution_history', query: 'test', limit: 5 },
      { mode: 'execution_history_item', executionRecordId: 'rec-1' },
      { mode: 'execution_history_item', executionRecordId: 'rec-2', includeParameters: true },
      { mode: 'execution_history_item', query: 'failed build' },
    ]);
  });

  test('routes background process and recovery inspection without effects', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({ action: 'processes', includeParameters: true });
    await tool.execute({ action: 'capabilities' });
    await tool.execute({ processId: 'proc-1' });
    await tool.execute({ action: 'process', sessionId: 'sess-1', includeParameters: true });
    await tool.execute({ id: 'bg_123' });
    await tool.execute({ action: 'recovery', includeParameters: true });

    expect(calls).toEqual([
      { mode: 'background_processes', includeParameters: true },
      { mode: 'run_background_process', processAction: 'capabilities' },
      { mode: 'background_process', processId: 'proc-1' },
      { mode: 'background_process', processId: 'sess-1', includeParameters: true },
      { mode: 'background_process', processId: 'bg_123' },
      { mode: 'file_recovery', includeParameters: true },
    ]);
  });

  test('rejects unknown execution actions instead of guessing', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    const result = await tool.execute({ action: 'run' });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unknown action unexpectedly succeeded');
    expect(result.error).toContain('Unknown execution action');
    expect(calls).toEqual([]);
  });

  test('registers the direct execution adapter once', () => {
    const registry = new ToolRegistry();

    registerAgentExecutionTool(registry, {} as CommandRegistry, { workspace: {}, platform: {}, session: { runtime: {} } } as CommandContext);
    registerAgentExecutionTool(registry, {} as CommandRegistry, { workspace: {}, platform: {}, session: { runtime: {} } } as CommandContext);

    expect(registry.has('execution')).toBe(true);
    expect(registry.getToolDefinitions().filter((definition) => definition.name === 'execution')).toHaveLength(1);
  });
});
