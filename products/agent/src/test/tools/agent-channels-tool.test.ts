import { describe, expect, test } from 'bun:test';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { CommandContext, CommandRegistry } from '../../input/command-registry.ts';
import { createAgentChannelsTool, registerAgentChannelsTool } from '../../tools/agent-channels-tool.ts';

function fakeHarnessTool(calls: Record<string, unknown>[]): Tool {
  return {
    definition: {
      name: 'agent_harness',
      description: 'Fake harness tool',
      parameters: { type: 'object', additionalProperties: true },
    },
    execute: async (args: Record<string, unknown>) => {
      calls.push(args);
      return { success: true, output: JSON.stringify({ args }) };
    },
  };
}

function makeTool(calls: Record<string, unknown>[] = []): Tool {
  return createAgentChannelsTool({
    commandRegistry: {} as CommandRegistry,
    commandContext: { workspace: {}, platform: {}, session: { runtime: {} } } as CommandContext,
    toolRegistry: new ToolRegistry(),
    harnessTool: fakeHarnessTool(calls),
  });
}

describe('channels adapter', () => {
  test('routes readiness and one-channel inspection', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({});
    await tool.execute({ query: 'telegram', limit: 5, includeParameters: true });
    await tool.execute({ channelId: 'slack' });
    await tool.execute({ action: 'channel', target: 'discord', includeParameters: true });

    expect(calls).toEqual([
      { mode: 'channels' },
      { mode: 'channels', query: 'telegram', limit: 5, includeParameters: true },
      { mode: 'channel', channelId: 'slack' },
      { mode: 'channel', target: 'discord', includeParameters: true },
    ]);
  });

  test('routes setup triage and delivery receipt aliases', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({ action: 'guide', id: 'telegram' });
    await tool.execute({ action: 'channel_triage', limit: 3, includeParameters: true });
    await tool.execute({ action: 'receipts', limit: 2 });

    expect(calls).toEqual([
      { mode: 'channel_setup_guide', channelId: 'telegram' },
      { mode: 'channel_triage', limit: 3, includeParameters: true },
      { mode: 'channel_deliveries', limit: 2 },
    ]);
  });

  test('registers the direct channels adapter once', () => {
    const registry = new ToolRegistry();

    registerAgentChannelsTool(registry, {} as CommandRegistry, { workspace: {}, platform: {}, session: { runtime: {} } } as CommandContext);
    registerAgentChannelsTool(registry, {} as CommandRegistry, { workspace: {}, platform: {}, session: { runtime: {} } } as CommandContext);

    expect(registry.has('channels')).toBe(true);
    expect(registry.getToolDefinitions().filter((definition) => definition.name === 'channels')).toHaveLength(1);
  });
});
