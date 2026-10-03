import { describe, expect, test } from 'bun:test';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { CommandContext, CommandRegistry } from '../../input/command-registry.ts';
import { createAgentSettingsTool, registerAgentSettingsTool } from '../../tools/agent-settings-tool.ts';

function fakeTool(name: string, calls: Record<string, unknown>[]): Tool {
  return {
    definition: {
      name,
      description: 'Fake tool',
      parameters: { type: 'object', additionalProperties: true },
    },
    execute: async (args: Record<string, unknown>) => {
      calls.push({ tool: name, ...args });
      return { success: true, output: JSON.stringify({ name, args }) };
    },
  };
}

function makeTool(calls: Record<string, unknown>[] = []): Tool {
  return createAgentSettingsTool({
    commandRegistry: {} as CommandRegistry,
    commandContext: { workspace: {}, platform: {} } as CommandContext,
    toolRegistry: new ToolRegistry(),
    harnessTool: fakeTool('agent_harness', calls),
    settingsImportTool: fakeTool('import_goodvibes_settings', calls),
  });
}

describe('settings adapter', () => {
  test('routes list and get reads through existing settings harness modes', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({ action: 'list', prefix: 'provider.', includeHidden: true, limit: 12 });
    await tool.execute({ action: 'get', key: 'provider.model' });
    await tool.execute({ action: 'show', target: 'reasoning effort' });

    expect(calls).toEqual([
      { tool: 'agent_harness', mode: 'settings', prefix: 'provider.', includeHidden: true, limit: 12 },
      { tool: 'agent_harness', mode: 'get_setting', key: 'provider.model' },
      { tool: 'agent_harness', mode: 'get_setting', target: 'reasoning effort' },
    ]);
  });

  test('routes confirmed setting mutations through existing confirmation gates', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({
      action: 'set',
      setting: 'behavior.saveHistory',
      value: false,
      confirm: true,
      explicitUserRequest: 'Disable history saving.',
    });
    await tool.execute({
      action: 'reset',
      key: 'provider.reasoningEffort',
      confirm: true,
      explicitUserRequest: 'Reset reasoning effort.',
    });

    expect(calls).toEqual([
      {
        tool: 'agent_harness',
        mode: 'set_setting',
        key: 'behavior.saveHistory',
        value: false,
        confirm: true,
        explicitUserRequest: 'Disable history saving.',
      },
      {
        tool: 'agent_harness',
        mode: 'reset_setting',
        key: 'provider.reasoningEffort',
        confirm: true,
        explicitUserRequest: 'Reset reasoning effort.',
      },
    ]);
  });

  test('previews import by default and applies only when confirmed', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({ action: 'import' });
    await tool.execute({
      action: 'import',
      confirm: true,
      explicitUserRequest: 'Import my existing GoodVibes settings into Agent.',
    });

    expect(calls).toEqual([
      { tool: 'import_goodvibes_settings', action: 'preview' },
      {
        tool: 'import_goodvibes_settings',
        action: 'apply',
        confirm: true,
        explicitUserRequest: 'Import my existing GoodVibes settings into Agent.',
      },
    ]);
  });

  test('registers the direct settings adapter', () => {
    const registry = new ToolRegistry();

    registerAgentSettingsTool(registry, {} as CommandRegistry, { workspace: {}, platform: {} } as CommandContext);

    expect(registry.has('settings')).toBe(true);
  });
});
