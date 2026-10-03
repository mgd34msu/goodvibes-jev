import { describe, expect, test } from 'bun:test';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { CommandContext, CommandRegistry } from '../../input/command-registry.ts';
import { createAgentAutonomyTool, registerAgentAutonomyTool } from '../../tools/agent-autonomy-tool.ts';

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
  return createAgentAutonomyTool({
    commandRegistry: {} as CommandRegistry,
    commandContext: { workspace: {}, platform: {}, session: { runtime: {} } } as CommandContext,
    toolRegistry: new ToolRegistry(),
    harnessTool: fakeTool(calls),
  });
}

describe('autonomy adapter', () => {
  test('routes ongoing-work requests through read-only intake', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({ query: 'Run a daily operator report.', includeParameters: true });
    await tool.execute({ action: 'intake', target: 'Cancel the running automation job.' });

    expect(calls).toEqual([
      { mode: 'autonomy_intake', query: 'Run a daily operator report.', includeParameters: true },
      { mode: 'autonomy_intake', target: 'Cancel the running automation job.' },
    ]);
  });

  test('routes visible queue, status, and item inspection', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({});
    await tool.execute({ action: 'queue', query: 'schedule', limit: 3 });
    await tool.execute({ action: 'status', target: 'approval' });
    await tool.execute({ queueItemId: 'connected-schedules' });
    await tool.execute({ action: 'item', id: 'automation-runs', includeParameters: true });
    await tool.execute({ action: 'item', query: 'research' });

    expect(calls).toEqual([
      { mode: 'autonomy_queue' },
      { mode: 'autonomy_queue', query: 'schedule', limit: 3 },
      { mode: 'autonomy_queue', query: 'approval' },
      { mode: 'autonomy_queue_item', queueItemId: 'connected-schedules' },
      { mode: 'autonomy_queue_item', queueItemId: 'automation-runs', includeParameters: true },
      { mode: 'autonomy_queue_item', query: 'research' },
    ]);
  });

  test('registers the direct autonomy adapter once', () => {
    const registry = new ToolRegistry();

    registerAgentAutonomyTool(registry, {} as CommandRegistry, { workspace: {}, platform: {}, session: { runtime: {} } } as CommandContext);
    registerAgentAutonomyTool(registry, {} as CommandRegistry, { workspace: {}, platform: {}, session: { runtime: {} } } as CommandContext);

    expect(registry.has('autonomy')).toBe(true);
    expect(registry.getToolDefinitions().filter((definition) => definition.name === 'autonomy')).toHaveLength(1);
  });
});
