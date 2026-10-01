import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import { createAgentHarnessTool } from './agent-harness-tool.ts';
import { createAgentSettingsImportTool } from './agent-settings-import-tool.ts';

type AgentSetupAction =
  | 'status'
  | 'item'
  | 'repair'
  | 'checkpoint'
  | 'save_checkpoint'
  | 'clear_checkpoint'
  | 'token'
  | 'smoke'
  | 'finish'
  | 'import_settings';

interface AgentSetupToolArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly setupItemId?: unknown;
  readonly itemId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly fields?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

interface AgentSetupToolDeps {
  readonly commandRegistry: CommandRegistry;
  readonly commandContext: CommandContext;
  readonly toolRegistry: ToolRegistry;
  readonly harnessTool?: Tool;
  readonly settingsImportTool?: Tool;
}

function output(value: unknown): { readonly success: true; readonly output: string } {
  return {
    success: true,
    output: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  };
}

function error(message: string): { readonly success: false; readonly error: string } {
  return { success: false, error: message };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readBoolean(value: unknown): boolean {
  return value === true || (typeof value === 'string' && ['true', 'yes', 'apply', 'run'].includes(value.trim().toLowerCase()));
}

function normalizeSetupAction(value: unknown): AgentSetupAction | null {
  const action = readString(value).toLowerCase().replace(/-/g, '_');
  if (!action) return null;
  if (action === 'setup' || action === 'posture' || action === 'status' || action === 'summary' || action === 'list') return 'status';
  if (action === 'item' || action === 'show' || action === 'inspect') return 'item';
  if (action === 'repair' || action === 'fix' || action === 'diagnose_repair' || action === 'host_repair' || action === 'repair_host' || action === 'launch_host') return 'repair';
  if (action === 'checkpoint' || action === 'resume' || action === 'checkpoint_status') return 'checkpoint';
  if (action === 'save_checkpoint' || action === 'mark_checkpoint' || action === 'checkpoint_save' || action === 'save') return 'save_checkpoint';
  if (action === 'clear_checkpoint' || action === 'reset_checkpoint' || action === 'checkpoint_clear' || action === 'clear') return 'clear_checkpoint';
  if (action === 'token' || action === 'auth' || action === 'provision_token' || action === 'repair_token') return 'token';
  if (action === 'smoke' || action === 'run_smoke' || action === 'install_smoke') return 'smoke';
  if (action === 'finish' || action === 'closeout' || action === 'apply_close' || action === 'apply_and_close') return 'finish';
  if (action === 'import' || action === 'import_settings' || action === 'settings_import') return 'import_settings';
  return null;
}

function readAction(args: AgentSetupToolArgs): AgentSetupAction {
  const explicit = normalizeSetupAction(args.action) ?? normalizeSetupAction(args.mode);
  if (explicit) return explicit;
  if (readString(args.setupItemId) || readString(args.itemId)) return 'item';
  return 'status';
}

function itemLookup(args: AgentSetupToolArgs): string {
  return readString(args.setupItemId) || readString(args.itemId);
}

function compactArgs(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== ''));
}

function setupStatusArgs(args: AgentSetupToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'setup_posture',
    query: args.query,
    limit: args.limit,
    includeParameters: args.includeParameters,
  });
}

function setupItemArgs(args: AgentSetupToolArgs): Record<string, unknown> {
  const setupItemId = itemLookup(args);
  return compactArgs({
    mode: 'setup_item',
    setupItemId,
    target: setupItemId ? undefined : args.target,
    query: setupItemId ? undefined : args.query,
    includeParameters: args.includeParameters,
  });
}

function confirmedArgs(args: AgentSetupToolArgs): Record<string, unknown> {
  return compactArgs({
    confirm: args.confirm,
    explicitUserRequest: args.explicitUserRequest,
  });
}

export function createAgentSetupTool(deps: AgentSetupToolDeps): Tool {
  const harnessTool = deps.harnessTool ?? createAgentHarnessTool({
    commandRegistry: deps.commandRegistry,
    commandContext: deps.commandContext,
    toolRegistry: deps.toolRegistry,
  });
  const settingsImportTool = deps.settingsImportTool ?? createAgentSettingsImportTool(deps.commandContext);

  return {
    definition: {
      name: 'setup',
      description: 'Inspect and complete first-run Agent setup.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'item', 'repair', 'checkpoint', 'save_checkpoint', 'clear_checkpoint', 'token', 'smoke', 'finish', 'import_settings'],
            description: 'Setup action; read status/item/checkpoint, confirm mutations.',
          },
          mode: { type: 'string', description: 'Alias for action.' },
          setupItemId: { type: 'string', description: 'Setup item id.' },
          itemId: { type: 'string', description: 'Alias for setupItemId.' },
          target: { type: 'string', description: 'Setup item lookup text.' },
          query: { type: 'string', description: 'Filter setup status or lookup a setup item.' },
          fields: { type: 'object', description: 'Optional redacted setup-smoke evidence fields.' },
          includeParameters: { type: 'boolean', description: 'Include bounded route details and parameters where supported.' },
          limit: { type: 'number', description: 'Optional status list limit.' },
          confirm: { type: 'boolean', description: 'Required true for setup mutations.' },
          explicitUserRequest: { type: 'string', description: 'User request authorizing confirmed setup effects.' },
        },
        additionalProperties: false,
      },
      sideEffects: ['state'],
      concurrency: 'serial',
    },
    execute: async (rawArgs: unknown) => {
      const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as AgentSetupToolArgs;
      const action = readAction(args);

      if (action === 'status') return harnessTool.execute(setupStatusArgs(args));
      if (action === 'item') return harnessTool.execute(setupItemArgs(args));
      if (action === 'repair') {
        return harnessTool.execute(compactArgs({
          mode: 'setup_repair',
          setupItemId: itemLookup(args) || undefined,
          target: itemLookup(args) ? undefined : args.target,
          query: itemLookup(args) ? undefined : args.query,
          includeParameters: args.includeParameters,
        }));
      }
      if (action === 'checkpoint') return harnessTool.execute({ mode: 'setup_checkpoint' });
      if (action === 'save_checkpoint') {
        return harnessTool.execute({
          mode: 'mark_setup_checkpoint',
          ...compactArgs({ setupItemId: itemLookup(args) || undefined }),
          ...confirmedArgs(args),
        });
      }
      if (action === 'clear_checkpoint') {
        return harnessTool.execute({
          mode: 'clear_setup_checkpoint',
          ...confirmedArgs(args),
        });
      }
      if (action === 'token') {
        return harnessTool.execute({
          mode: 'provision_connected_host_token',
          setupItemId: itemLookup(args) || 'connected-host-auth',
          ...confirmedArgs(args),
        });
      }
      if (action === 'smoke') {
        return harnessTool.execute({
          mode: 'run_setup_smoke',
          setupItemId: itemLookup(args) || 'install-smoke',
          ...compactArgs({
            fields: args.fields,
            includeParameters: args.includeParameters,
          }),
          ...confirmedArgs(args),
        });
      }
      if (action === 'finish') {
        return harnessTool.execute({
          mode: 'run_workspace_action',
          actionId: 'onboarding-apply-close',
          ...confirmedArgs(args),
        });
      }
      if (action === 'import_settings') {
        return settingsImportTool.execute({
          action: readBoolean(args.confirm) ? 'apply' : 'preview',
          ...confirmedArgs(args),
        });
      }

      return error('Unknown setup action. Use action:"status" to inspect first-run setup.');
    },
  };
}

export function registerAgentSetupTool(
  registry: ToolRegistry,
  commandRegistry: CommandRegistry,
  commandContext: CommandContext,
): void {
  if (!registry.has('setup')) registry.register(createAgentSetupTool({ commandRegistry, commandContext, toolRegistry: registry }));
}
