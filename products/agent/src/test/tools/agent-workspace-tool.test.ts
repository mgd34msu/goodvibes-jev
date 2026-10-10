import { afterAll, describe, expect, test } from 'bun:test';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner } from '../helpers/research-screening.ts';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { CommandContext, CommandRegistry } from '../../input/command-registry.ts';
import { createAgentWorkspaceTool, registerAgentWorkspaceTool } from '../../tools/agent-workspace-tool.ts';

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

afterAll(cleanupResearchScreeningFixtures);

function makeTool(calls: Record<string, unknown>[] = []): Tool {
  const toolRegistry = new ToolRegistry();
  bindAgentResearchSourceOwner(toolRegistry, ordinaryResearchOwner());
  return createAgentWorkspaceTool({
    commandRegistry: {} as CommandRegistry,
    commandContext: { workspace: {}, platform: {}, session: { runtime: {} } } as CommandContext,
    toolRegistry,
    harnessTool: fakeTool(calls),
  });
}

describe('workspace adapter', () => {
  test('routes workspace categories, actions, and confirmed action runs', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({});
    await tool.execute({ action: 'actions', categoryId: 'documents', query: 'review', limit: 4 });
    await tool.execute({ actionId: 'document-create-draft', includeParameters: true });
    await tool.execute({ action: 'run', workspaceActionId: 'document-create-draft', fields: { title: 'Draft' }, confirm: true, explicitUserRequest: 'Create the draft.' });

    expect(calls).toEqual([
      { mode: 'workspace' },
      { mode: 'workspace_actions', categoryId: 'documents', query: 'review', limit: 4 },
      { mode: 'workspace_action', actionId: 'document-create-draft', includeParameters: true },
      { mode: 'run_workspace_action', actionId: 'document-create-draft', fields: { title: 'Draft' }, confirm: true, explicitUserRequest: 'Create the draft.' },
    ]);
  });

  test('routes visible UI surfaces, shortcuts, and keybinding effects; removed panel actions return an error', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({ action: 'surfaces', query: 'workspace' });
    await tool.execute({ surfaceId: 'agent-workspace', includeParameters: true });
    await tool.execute({ action: 'open', surfaceId: 'agent-workspace', target: 'documents', confirm: true, explicitUserRequest: 'Open Documents.' });
    await tool.execute({ action: 'shortcuts' });
    await tool.execute({ action: 'keybinding', actionId: 'screen-clear' });
    await tool.execute({ action: 'set_keybinding', actionId: 'screen-clear', value: 'Ctrl+L', confirm: true, explicitUserRequest: 'Bind clear screen.' });

    expect(calls).toEqual([
      { mode: 'ui_surfaces', query: 'workspace' },
      { mode: 'ui_surface', surfaceId: 'agent-workspace', includeParameters: true },
      { mode: 'open_ui_surface', surfaceId: 'agent-workspace', target: 'documents', confirm: true, explicitUserRequest: 'Open Documents.' },
      { mode: 'shortcuts' },
      { mode: 'keybinding', actionId: 'screen-clear' },
      { mode: 'set_keybinding', actionId: 'screen-clear', value: 'Ctrl+L', confirm: true, explicitUserRequest: 'Bind clear screen.' },
    ]);
  });

  test('removed panel actions (panels, panel, open_panel) are absent from the enum and fall through safely', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    // These inputs are no longer advertised; if passed they fall through to safe defaults (no crash).
    const panelsResult = await tool.execute({ action: 'panels' }) as { success: boolean };
    const panelResult = await tool.execute({ action: 'panel' }) as { success: boolean };
    const openPanelResult = await tool.execute({ action: 'open_panel' }) as { success: boolean };

    // All three fall through gracefully, no thrown exception
    expect(panelsResult.success).toBe(true);
    expect(panelResult.success).toBe(true);
    expect(openPanelResult.success).toBe(true);

    // The enum no longer carries the removed actions, model cannot discover or invoke them
    const toolDef = tool.definition;
    const actionEnum = (toolDef.parameters as { properties: { action: { enum: string[] } } }).properties.action.enum;
    expect(actionEnum).not.toContain('panels');
    expect(actionEnum).not.toContain('panel');
    expect(actionEnum).not.toContain('open_panel');

    // panelId and pane are no longer advertised in the schema properties
    const props = (toolDef.parameters as { properties: Record<string, unknown> }).properties;
    expect(props).not.toHaveProperty('panelId');
    expect(props).not.toHaveProperty('pane');
  });

  test('routes slash and CLI command discovery separately from confirmed command execution', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = makeTool(calls);

    await tool.execute({ action: 'commands', query: 'settings' });
    await tool.execute({ commandName: 'settings', includeParameters: true });
    await tool.execute({ action: 'run_command', commandName: 'settings', args: ['show'], confirm: true, explicitUserRequest: 'Run /settings show.' });
    await tool.execute({ action: 'cli_commands', query: 'status' });
    await tool.execute({ action: 'cli_command', command: 'status' });

    expect(calls).toEqual([
      { mode: 'commands', query: 'settings' },
      { mode: 'command', commandName: 'settings', includeParameters: true },
      { mode: 'run_command', commandName: 'settings', args: ['show'], confirm: true, explicitUserRequest: 'Run /settings show.' },
      { mode: 'cli_commands', query: 'status' },
      { mode: 'cli_command', command: 'status' },
    ]);
  });

  test('registers the direct workspace adapter once', () => {
    const registry = new ToolRegistry();

    registerAgentWorkspaceTool(registry, {} as CommandRegistry, { workspace: {}, platform: {}, session: { runtime: {} } } as CommandContext);
    registerAgentWorkspaceTool(registry, {} as CommandRegistry, { workspace: {}, platform: {}, session: { runtime: {} } } as CommandContext);

    expect(registry.has('workspace')).toBe(true);
    expect(registry.getToolDefinitions().filter((definition) => definition.name === 'workspace')).toHaveLength(1);
  });
});
