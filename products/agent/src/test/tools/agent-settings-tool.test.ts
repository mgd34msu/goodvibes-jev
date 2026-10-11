import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { ordinaryResearchOwner, cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';

afterAll(cleanupResearchScreeningFixtures);
import { afterAll, describe, expect, test } from 'bun:test';
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
  const registry = new ToolRegistry();
  bindAgentResearchSourceOwner(registry, ordinaryResearchOwner());
  return createAgentSettingsTool({
    commandRegistry: {} as CommandRegistry,
    commandContext: { workspace: {}, platform: {} } as CommandContext,
    toolRegistry: registry,
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

  test('direct settings mutations cannot borrow authority from a harness or confirmation metadata', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);
    const set = await tool.execute({ action: 'set', setting: 'behavior.saveHistory', value: false,
      confirm: true, explicitUserRequest: 'Disable history saving.' });
    const reset = await tool.execute({ action: 'reset', key: 'provider.reasoningEffort',
      confirm: true, explicitUserRequest: 'Reset reasoning effort.' });
    expect(set.success).toBe(false); expect(reset.success).toBe(false); expect(calls).toEqual([]);
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
