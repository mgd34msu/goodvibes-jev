import { describe, expect, test } from 'bun:test';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { CommandContext, CommandRegistry } from '../../input/command-registry.ts';
import { createAgentDelegationTool, registerAgentDelegationTool } from '../../tools/agent-delegation-tool.ts';

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
  return createAgentDelegationTool({
    commandRegistry: {} as CommandRegistry,
    commandContext: { workspace: {}, platform: {}, session: { runtime: {} } } as CommandContext,
    toolRegistry: new ToolRegistry(),
    harnessTool: fakeTool(calls),
  });
}

describe('delegation adapter', () => {
  test('routes policy and route catalog inspection through read-only delegation posture', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({});
    await tool.execute({ action: 'routes', query: 'remote', limit: 3 });
    await tool.execute({ action: 'decision', target: 'review', includeParameters: true });

    expect(calls).toEqual([
      { mode: 'delegation_posture' },
      { mode: 'delegation_posture', query: 'remote', limit: 3 },
      { mode: 'delegation_posture', query: 'review', includeParameters: true },
    ]);
  });

  test('routes exact and searched delegation route inspection', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({ delegationRouteId: 'delegate-build-task' });
    await tool.execute({ action: 'route', id: 'remote-runner-inspection', includeParameters: true });
    await tool.execute({ action: 'inspect', query: 'hidden fanout' });

    expect(calls).toEqual([
      { mode: 'delegation_route', delegationRouteId: 'delegate-build-task' },
      { mode: 'delegation_route', delegationRouteId: 'remote-runner-inspection', includeParameters: true },
      { mode: 'delegation_route', query: 'hidden fanout' },
    ]);
  });

  test('registers the direct delegation adapter once', () => {
    const registry = new ToolRegistry();

    registerAgentDelegationTool(registry, {} as CommandRegistry, { workspace: {}, platform: {}, session: { runtime: {} } } as CommandContext);
    registerAgentDelegationTool(registry, {} as CommandRegistry, { workspace: {}, platform: {}, session: { runtime: {} } } as CommandContext);

    expect(registry.has('delegation')).toBe(true);
    expect(registry.getToolDefinitions().filter((definition) => definition.name === 'delegation')).toHaveLength(1);
  });
});
