import { createAgentHarnessResearchProjector, protectAgentHarnessResearchTool, isResearchReportEditor } from './agent-research-ingress.ts';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import { createAgentHarnessTool } from './agent-harness-tool.ts';

type AgentWorkspaceToolAction =
  | 'status'
  | 'actions'
  | 'action'
  | 'run'
  | 'surfaces'
  | 'surface'
  | 'open'
  | 'shortcuts'
  | 'keybindings'
  | 'keybinding'
  | 'run_keybinding'
  | 'set_keybinding'
  | 'reset_keybinding'
  | 'commands'
  | 'command'
  | 'run_command'
  | 'cli_commands'
  | 'cli_command';

interface AgentWorkspaceToolArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly id?: unknown;
  readonly actionId?: unknown;
  readonly workspaceActionId?: unknown;
  readonly surfaceId?: unknown;
  readonly command?: unknown;
  readonly commandName?: unknown;
  readonly args?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly category?: unknown;
  readonly categoryId?: unknown;
  readonly recordId?: unknown;
  readonly fields?: unknown;
  readonly combo?: unknown;
  readonly combos?: unknown;
  readonly key?: unknown;
  readonly value?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

interface AgentWorkspaceToolDeps {
  readonly commandRegistry: CommandRegistry;
  readonly commandContext: CommandContext;
  readonly toolRegistry: ToolRegistry;
  readonly harnessTool?: Tool;
}

function error(message: string): { readonly success: false; readonly error: string } {
  return { success: false, error: message };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeWorkspaceAction(value: unknown): AgentWorkspaceToolAction | null {
  const action = readString(value).toLowerCase().replace(/-/g, '_');
  if (!action) return null;
  if (action === 'status' || action === 'summary' || action === 'home' || action === 'workspace' || action === 'categories' || action === 'workspace_categories') return 'status';
  if (action === 'actions' || action === 'list_actions' || action === 'workspace_actions' || action === 'tasks') return 'actions';
  if (action === 'action' || action === 'show' || action === 'inspect' || action === 'workspace_action') return 'action';
  if (action === 'run' || action === 'submit' || action === 'run_action' || action === 'run_workspace_action') return 'run';
  if (action === 'surfaces' || action === 'ui_surfaces' || action === 'screens' || action === 'views') return 'surfaces';
  if (action === 'surface' || action === 'ui_surface' || action === 'screen' || action === 'view') return 'surface';
  if (action === 'open' || action === 'navigate' || action === 'open_surface' || action === 'open_ui_surface') return 'open';
  if (action === 'shortcuts' || action === 'shortcut_help' || action === 'help') return 'shortcuts';
  if (action === 'keybindings' || action === 'bindings' || action === 'keys') return 'keybindings';
  if (action === 'keybinding' || action === 'binding' || action === 'key') return 'keybinding';
  if (action === 'run_keybinding' || action === 'trigger_keybinding' || action === 'trigger_shortcut') return 'run_keybinding';
  if (action === 'set_keybinding' || action === 'bind' || action === 'set_binding') return 'set_keybinding';
  if (action === 'reset_keybinding' || action === 'unbind' || action === 'reset_binding') return 'reset_keybinding';
  if (action === 'commands' || action === 'slash_commands' || action === 'command_catalog') return 'commands';
  if (action === 'command' || action === 'slash_command' || action === 'inspect_command') return 'command';
  if (action === 'run_command' || action === 'execute_command' || action === 'execute') return 'run_command';
  if (action === 'cli_commands' || action === 'cli_catalog') return 'cli_commands';
  if (action === 'cli_command' || action === 'inspect_cli_command') return 'cli_command';
  return null;
}

function readAction(args: AgentWorkspaceToolArgs): AgentWorkspaceToolAction {
  const explicit = normalizeWorkspaceAction(args.action) ?? normalizeWorkspaceAction(args.mode);
  if (explicit) return explicit;
  if (readString(args.surfaceId)) return 'surface';
  if (readString(args.actionId) || readString(args.workspaceActionId)) return 'action';
  if (readString(args.command) || readString(args.commandName)) return 'command';
  if (readString(args.key)) return 'keybinding';
  if (readString(args.categoryId) || readString(args.category) || readString(args.query) || readString(args.target)) return 'actions';
  return 'status';
}

function compactArgs(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== ''));
}

function lookupId(args: AgentWorkspaceToolArgs): string {
  return readString(args.actionId) || readString(args.workspaceActionId) || readString(args.id);
}

function surfaceLookup(args: AgentWorkspaceToolArgs): string {
  return readString(args.surfaceId) || readString(args.id);
}

function confirmedArgs(args: AgentWorkspaceToolArgs): Record<string, unknown> {
  return compactArgs({
    confirm: args.confirm,
    explicitUserRequest: args.explicitUserRequest,
  });
}

function workspaceDiscoveryArgs(args: AgentWorkspaceToolArgs): Record<string, unknown> {
  return compactArgs({
    category: args.category,
    categoryId: args.categoryId,
    target: args.target,
    query: args.query,
    limit: args.limit,
    includeParameters: args.includeParameters,
  });
}

function workspaceActionArgs(mode: 'workspace_action' | 'run_workspace_action', args: AgentWorkspaceToolArgs): Record<string, unknown> {
  const actionId = lookupId(args);
  return compactArgs({
    mode,
    actionId,
    command: args.command,
    recordId: args.recordId,
    fields: args.fields,
    target: actionId || args.command ? undefined : args.target,
    query: actionId || args.command ? undefined : args.query,
    category: args.category,
    categoryId: args.categoryId,
    includeParameters: args.includeParameters,
    ...(mode === 'run_workspace_action' ? confirmedArgs(args) : {}),
  });
}

function surfaceArgs(mode: 'ui_surface' | 'open_ui_surface', args: AgentWorkspaceToolArgs): Record<string, unknown> {
  const surfaceId = surfaceLookup(args);
  return compactArgs({
    mode,
    surfaceId,
    category: args.category,
    categoryId: args.categoryId,
    target: surfaceId ? args.target : (args.target ?? args.query),
    query: surfaceId ? undefined : args.query,
    includeParameters: mode === 'ui_surface' ? args.includeParameters : undefined,
    ...(mode === 'open_ui_surface' ? confirmedArgs(args) : {}),
  });
}

function keybindingArgs(mode: 'keybinding' | 'run_keybinding' | 'set_keybinding' | 'reset_keybinding', args: AgentWorkspaceToolArgs): Record<string, unknown> {
  const actionId = lookupId(args);
  return compactArgs({
    mode,
    actionId,
    target: actionId ? undefined : args.target,
    query: actionId ? undefined : args.query,
    key: args.key,
    combo: args.combo,
    combos: args.combos,
    fields: args.fields,
    value: args.value,
    includeParameters: mode === 'keybinding' ? args.includeParameters : undefined,
    ...(mode === 'run_keybinding' || mode === 'set_keybinding' || mode === 'reset_keybinding' ? confirmedArgs(args) : {}),
  });
}

function commandArgs(mode: 'command' | 'run_command' | 'cli_command', args: AgentWorkspaceToolArgs): Record<string, unknown> {
  return compactArgs({
    mode,
    command: args.command,
    commandName: args.commandName,
    args: args.args,
    target: args.command || args.commandName ? undefined : args.target,
    query: args.command || args.commandName ? undefined : args.query,
    includeParameters: mode === 'run_command' ? undefined : args.includeParameters,
    ...(mode === 'run_command' ? confirmedArgs(args) : {}),
  });
}

function isWorkspaceReport(args: Record<string, unknown>): boolean {
  if (readAction(args) === 'run') return isResearchReportEditor(workspaceActionArgs('run_workspace_action', args));
  return isResearchReportEditor({ fields: args.fields });
}

export function createAgentWorkspaceTool(deps: AgentWorkspaceToolDeps): Tool {
  const harnessTool = deps.harnessTool ?? createAgentHarnessTool({
    commandRegistry: deps.commandRegistry,
    commandContext: deps.commandContext,
    toolRegistry: deps.toolRegistry,
  });

  const tool: Tool = {
    definition: {
      name: 'workspace',
      description: 'Inspect/open workspace actions, UI, commands, and keys.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'actions', 'action', 'run', 'surfaces', 'surface', 'open', 'shortcuts', 'keybindings', 'keybinding', 'run_keybinding', 'set_keybinding', 'reset_keybinding', 'commands', 'command', 'run_command', 'cli_commands', 'cli_command'],
            description: 'Inspect catalogs, open UI, or run approved workspace actions.',
          },
          mode: { type: 'string', description: 'Alias for action.' },
          id: { type: 'string', description: 'Generic action, surface, or keybinding id.' },
          actionId: { type: 'string', description: 'Workspace action or keybinding action id.' },
          workspaceActionId: { type: 'string', description: 'Workspace action id alias.' },
          surfaceId: { type: 'string', description: 'UI surface id.' },
          command: { type: 'string', description: 'Slash or CLI command string.' },
          commandName: { type: 'string', description: 'Slash or CLI command name.' },
          args: { type: 'array', items: { type: 'string' }, description: 'Command arguments when commandName is used.' },
          target: { type: 'string', description: 'Lookup target, UI target, or search text.' },
          query: { type: 'string', description: 'Catalog search text.' },
          category: { type: 'string', description: 'Workspace category filter.' },
          categoryId: { type: 'string', description: 'Workspace category id.' },
          recordId: { type: 'string', description: 'Selected local record id for workspace editors.' },
          fields: { type: 'object', additionalProperties: { type: 'string' }, description: 'Workspace editor field values.' },
          combo: { type: 'object', description: 'Single keybinding combo.' },
          combos: { type: 'array', items: { type: 'object' }, description: 'Multiple keybinding combos.' },
          key: { type: 'string', description: 'Keybinding lookup key.' },
          value: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }], description: 'Keybinding value such as Ctrl+G.' },
          includeParameters: { type: 'boolean', description: 'Include detailed schemas or route metadata.' },
          limit: { type: 'number', description: 'Maximum rows returned for catalog actions.' },
          confirm: { type: 'boolean', description: 'Required true for UI opens and side-effecting actions.' },
          explicitUserRequest: { type: 'string', description: 'User request authorizing confirmed workspace effects.' },
        },
        additionalProperties: false,
      },
      sideEffects: ['state'],
      concurrency: 'serial',
    },
    execute: async (rawArgs: unknown, options) => {
      const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as AgentWorkspaceToolArgs;
      const action = readAction(args);

      if (action === 'status') return harnessTool.execute(compactArgs({ mode: 'workspace', target: args.target, query: args.query, includeParameters: args.includeParameters }));
      if (action === 'actions') return harnessTool.execute({ mode: 'workspace_actions', ...workspaceDiscoveryArgs(args) });
      if (action === 'action') return harnessTool.execute(workspaceActionArgs('workspace_action', args));
      if (action === 'run') return harnessTool.execute(workspaceActionArgs('run_workspace_action', args), options);
      if (action === 'surfaces') return harnessTool.execute(compactArgs({ mode: 'ui_surfaces', target: args.target, query: args.query, limit: args.limit, includeParameters: args.includeParameters }));
      if (action === 'surface') return harnessTool.execute(surfaceArgs('ui_surface', args));
      if (action === 'open') return harnessTool.execute(surfaceArgs('open_ui_surface', args));
      if (action === 'shortcuts') return harnessTool.execute(compactArgs({ mode: 'shortcuts', target: args.target, query: args.query, limit: args.limit, includeParameters: args.includeParameters }));
      if (action === 'keybindings') return harnessTool.execute(compactArgs({ mode: 'keybindings', target: args.target, query: args.query, limit: args.limit, includeParameters: args.includeParameters }));
      if (action === 'keybinding') return harnessTool.execute(keybindingArgs('keybinding', args));
      if (action === 'run_keybinding') return harnessTool.execute(keybindingArgs('run_keybinding', args));
      if (action === 'set_keybinding') return harnessTool.execute(keybindingArgs('set_keybinding', args));
      if (action === 'reset_keybinding') return harnessTool.execute(keybindingArgs('reset_keybinding', args));
      if (action === 'commands') return harnessTool.execute(compactArgs({ mode: 'commands', target: args.target, query: args.query, limit: args.limit, includeParameters: args.includeParameters }));
      if (action === 'command') return harnessTool.execute(commandArgs('command', args));
      if (action === 'run_command') return harnessTool.execute(commandArgs('run_command', args));
      if (action === 'cli_commands') return harnessTool.execute(compactArgs({ mode: 'cli_commands', target: args.target, query: args.query, limit: args.limit, includeParameters: args.includeParameters }));
      if (action === 'cli_command') return harnessTool.execute(commandArgs('cli_command', args));

      return error('Unknown workspace action. Use action:"status" or action:"actions" to inspect the workspace.');
    },
  };
  return protectAgentHarnessResearchTool(tool, deps.toolRegistry, isWorkspaceReport);
}

export function registerAgentWorkspaceTool(
  registry: ToolRegistry,
  commandRegistry: CommandRegistry,
  commandContext: CommandContext,
): void {
  if (!registry.has('workspace')) registry.register(createAgentWorkspaceTool({ commandRegistry, commandContext, toolRegistry: registry }), {
    inputProjection: createAgentHarnessResearchProjector(registry, isWorkspaceReport),
  });
}
