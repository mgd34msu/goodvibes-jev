import { describe, expect, test } from 'bun:test';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { CommandContext, CommandRegistry } from '../../input/command-registry.ts';
import { createAgentComputerTool, registerAgentComputerTool } from '../../tools/agent-computer-tool.ts';

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
  return createAgentComputerTool({
    commandRegistry: {} as CommandRegistry,
    commandContext: { workspace: {}, platform: {}, session: { runtime: {} } } as CommandContext,
    toolRegistry: new ToolRegistry(),
    harnessTool: fakeTool(calls),
  });
}

describe('computer adapter', () => {
  test('routes computer control browser setup and MCP inspection', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({});
    await tool.execute({ action: 'plan', query: 'take a screenshot of the dashboard', includeParameters: true });
    await tool.execute({ action: 'screenshot' });
    await tool.execute({ action: 'desktop', includeParameters: false });
    await tool.execute({ action: 'browser' });
    await tool.execute({ action: 'setup' });
    await tool.execute({ action: 'mcp', query: 'browser screenshot' });

    expect(calls).toEqual([
      { mode: 'execution_route', executionRouteId: 'browser-or-desktop-control', includeParameters: true },
      { mode: 'browser_control_route', query: 'take a screenshot of the dashboard', includeParameters: true },
      { mode: 'browser_control_route', query: 'screenshot' },
      { mode: 'execution_route', executionRouteId: 'browser-or-desktop-control', includeParameters: false },
      { mode: 'ui_surface', surfaceId: 'connected-browser-cockpit', includeParameters: true },
      { mode: 'setup_item', setupItemId: 'browser-desktop-control', includeParameters: true },
      { mode: 'mcp_servers', query: 'browser screenshot' },
    ]);
  });

  test('routes confirmed connected browser open through the existing visible UI gate', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({
      action: 'open_browser',
      confirm: true,
      explicitUserRequest: 'Open the connected browser cockpit.',
    });

    expect(calls).toEqual([
      {
        mode: 'open_ui_surface',
        surfaceId: 'connected-browser-cockpit',
        confirm: true,
        explicitUserRequest: 'Open the connected browser cockpit.',
      },
    ]);
  });

  test('rejects unknown computer actions instead of guessing', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    const result = await tool.execute({ action: 'takeover' });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unknown action unexpectedly succeeded');
    expect(result.error).toContain('Unknown computer action');
    expect(calls).toEqual([]);
  });

  test('registers the direct computer adapter once', () => {
    const registry = new ToolRegistry();

    registerAgentComputerTool(registry, {} as CommandRegistry, { workspace: {}, platform: {}, session: { runtime: {} } } as CommandContext);
    registerAgentComputerTool(registry, {} as CommandRegistry, { workspace: {}, platform: {}, session: { runtime: {} } } as CommandContext);

    expect(registry.has('computer')).toBe(true);
    expect(registry.getToolDefinitions().filter((definition) => definition.name === 'computer')).toHaveLength(1);
  });
});
