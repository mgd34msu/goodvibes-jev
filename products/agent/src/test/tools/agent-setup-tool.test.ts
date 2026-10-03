import { describe, expect, test } from 'bun:test';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { CommandContext, CommandRegistry } from '../../input/command-registry.ts';
import { createAgentSetupTool, registerAgentSetupTool } from '../../tools/agent-setup-tool.ts';

function fakeTool(name: string, calls: Record<string, unknown>[]): Tool {
  return {
    definition: {
      name,
      description: 'Fake tool',
      parameters: { type: 'object', additionalProperties: true },
    },
    execute: async (args: Record<string, unknown>) => {
      calls.push(args);
      return { success: true, output: JSON.stringify({ name, args }) };
    },
  };
}

function makeTool(calls: Record<string, unknown>[] = []): Tool {
  return createAgentSetupTool({
    commandRegistry: {} as CommandRegistry,
    commandContext: {} as CommandContext,
    toolRegistry: new ToolRegistry(),
    harnessTool: fakeTool('agent_harness', calls),
    settingsImportTool: fakeTool('import_goodvibes_settings', calls),
  });
}

describe('setup adapter', () => {
  test('routes status and item reads to the existing harness setup modes', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({ action: 'status', includeParameters: true, query: 'host' });
    await tool.execute({ action: 'show', itemId: 'provider-access' });
    await tool.execute({ action: 'repair', setupItemId: 'connected-host-readiness', includeParameters: true });

    expect(calls).toEqual([
      { mode: 'setup_posture', query: 'host', includeParameters: true },
      { mode: 'setup_item', setupItemId: 'provider-access' },
      { mode: 'setup_repair', setupItemId: 'connected-host-readiness', includeParameters: true },
    ]);
  });

  test('routes checkpoints, token provisioning, smoke, and finish through harness effects', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({ action: 'checkpoint' });
    await tool.execute({
      action: 'save_checkpoint',
      setupItemId: 'install-smoke',
      confirm: true,
      explicitUserRequest: 'Save my setup checkpoint.',
    });
    await tool.execute({
      action: 'token',
      confirm: true,
      explicitUserRequest: 'Repair connected-host auth.',
    });
    await tool.execute({
      action: 'smoke',
      fields: { firstAssistantTurn: 'ready' },
      confirm: true,
      explicitUserRequest: 'Run setup smoke.',
    });
    await tool.execute({
      action: 'finish',
      confirm: true,
      explicitUserRequest: 'Finish setup.',
    });

    expect(calls).toEqual([
      { mode: 'setup_checkpoint' },
      {
        mode: 'mark_setup_checkpoint',
        setupItemId: 'install-smoke',
        confirm: true,
        explicitUserRequest: 'Save my setup checkpoint.',
      },
      {
        mode: 'provision_connected_host_token',
        setupItemId: 'connected-host-auth',
        confirm: true,
        explicitUserRequest: 'Repair connected-host auth.',
      },
      {
        mode: 'run_setup_smoke',
        setupItemId: 'install-smoke',
        fields: { firstAssistantTurn: 'ready' },
        confirm: true,
        explicitUserRequest: 'Run setup smoke.',
      },
      {
        mode: 'run_workspace_action',
        actionId: 'onboarding-apply-close',
        confirm: true,
        explicitUserRequest: 'Finish setup.',
      },
    ]);
  });

  test('routes settings import preview and confirmed apply to the import adapter', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({ action: 'import_settings' });
    await tool.execute({
      action: 'import_settings',
      confirm: true,
      explicitUserRequest: 'Import my GoodVibes settings.',
    });

    expect(calls).toEqual([
      { action: 'preview' },
      {
        action: 'apply',
        confirm: true,
        explicitUserRequest: 'Import my GoodVibes settings.',
      },
    ]);
  });

  test('registers the direct setup adapter', () => {
    const registry = new ToolRegistry();

    registerAgentSetupTool(registry, {} as CommandRegistry, {} as CommandContext);

    expect(registry.has('setup')).toBe(true);
  });
});
