import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import { createAgentHarnessTool } from './agent-harness-tool.ts';
import { createAgentSettingsImportTool } from './agent-settings-import-tool.ts';

type AgentSettingsAction =
  | 'list'
  | 'get'
  | 'set'
  | 'reset'
  | 'import';

interface AgentSettingsToolArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly key?: unknown;
  readonly setting?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly category?: unknown;
  readonly prefix?: unknown;
  readonly value?: unknown;
  readonly includeHidden?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

interface AgentSettingsToolDeps {
  readonly commandRegistry: CommandRegistry;
  readonly commandContext: CommandContext;
  readonly toolRegistry: ToolRegistry;
  readonly harnessTool?: Tool;
  readonly settingsImportTool?: Tool;
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

function normalizeSettingsAction(value: unknown): AgentSettingsAction | null {
  const action = readString(value).toLowerCase().replace(/-/g, '_');
  if (!action) return null;
  if (action === 'list' || action === 'status' || action === 'settings' || action === 'catalog' || action === 'search' || action === 'find' || action === 'browse') return 'list';
  if (action === 'get' || action === 'show' || action === 'inspect' || action === 'read' || action === 'setting' || action === 'get_setting') return 'get';
  if (action === 'set' || action === 'update' || action === 'change' || action === 'configure' || action === 'set_setting') return 'set';
  if (action === 'reset' || action === 'clear' || action === 'default' || action === 'restore' || action === 'reset_setting') return 'reset';
  if (action === 'import' || action === 'import_settings' || action === 'settings_import' || action === 'import_goodvibes' || action === 'goodvibes_import' || action === 'preview_import' || action === 'apply_import') return 'import';
  return null;
}

function readAction(args: AgentSettingsToolArgs): AgentSettingsAction {
  const explicit = normalizeSettingsAction(args.action) ?? normalizeSettingsAction(args.mode);
  if (explicit) return explicit;
  if (readString(args.key) || readString(args.setting)) return 'get';
  return 'list';
}

function compactArgs(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== ''));
}

function settingKey(args: AgentSettingsToolArgs): string {
  return readString(args.key) || readString(args.setting);
}

function confirmedArgs(args: AgentSettingsToolArgs): Record<string, unknown> {
  return compactArgs({
    confirm: args.confirm,
    explicitUserRequest: args.explicitUserRequest,
  });
}

function settingsListArgs(args: AgentSettingsToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'settings',
    category: args.category,
    prefix: args.prefix,
    query: args.query ?? args.target,
    includeHidden: args.includeHidden,
    includeParameters: args.includeParameters,
    limit: args.limit,
  });
}

function settingsLookupArgs(mode: 'get_setting' | 'set_setting' | 'reset_setting', args: AgentSettingsToolArgs): Record<string, unknown> {
  const key = settingKey(args);
  return compactArgs({
    mode,
    key,
    target: key ? undefined : args.target,
    query: key ? undefined : args.query,
    category: args.category,
    prefix: args.prefix,
    value: mode === 'set_setting' ? args.value : undefined,
    includeHidden: args.includeHidden,
    ...confirmedArgs(args),
  });
}

export function createAgentSettingsTool(deps: AgentSettingsToolDeps): Tool {
  const harnessTool = deps.harnessTool ?? createAgentHarnessTool({
    commandRegistry: deps.commandRegistry,
    commandContext: deps.commandContext,
    toolRegistry: deps.toolRegistry,
  });
  const settingsImportTool = deps.settingsImportTool ?? createAgentSettingsImportTool(deps.commandContext);

  return {
    definition: {
      name: 'settings',
      description: 'List, inspect, change, reset, or import settings.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'get', 'set', 'reset', 'import'],
            description: 'Read settings or confirm setting changes/imports.',
          },
          mode: { type: 'string', description: 'Alias for action.' },
          key: { type: 'string', description: 'Exact setting key.' },
          setting: { type: 'string', description: 'Alias for key.' },
          target: { type: 'string', description: 'Setting lookup text.' },
          query: { type: 'string', description: 'Setting search text.' },
          category: { type: 'string', description: 'Top-level setting category.' },
          prefix: { type: 'string', description: 'Setting key prefix.' },
          value: { description: 'Value for action:set.' },
          includeHidden: { type: 'boolean', description: 'Include scriptable or hidden settings.' },
          includeParameters: { type: 'boolean', description: 'Include full setting metadata.' },
          limit: { type: 'number', description: 'Maximum settings to return.' },
          confirm: { type: 'boolean', description: 'Required true for set/reset/import apply.' },
          explicitUserRequest: { type: 'string', description: 'User request authorizing confirmed setting effects.' },
        },
        additionalProperties: false,
      },
      sideEffects: ['state'],
      concurrency: 'serial',
    },
    execute: async (rawArgs: unknown) => {
      const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as AgentSettingsToolArgs;
      const action = readAction(args);

      if (action === 'list') return harnessTool.execute(settingsListArgs(args));
      if (action === 'get') return harnessTool.execute(settingsLookupArgs('get_setting', args));
      if (action === 'set') return harnessTool.execute(settingsLookupArgs('set_setting', args));
      if (action === 'reset') return harnessTool.execute(settingsLookupArgs('reset_setting', args));
      if (action === 'import') {
        return settingsImportTool.execute({
          action: readBoolean(args.confirm) ? 'apply' : 'preview',
          ...confirmedArgs(args),
        });
      }

      return error('Unknown settings action. Use action:"list" to inspect settings.');
    },
  };
}

export function registerAgentSettingsTool(
  registry: ToolRegistry,
  commandRegistry: CommandRegistry,
  commandContext: CommandContext,
): void {
  if (!registry.has('settings')) registry.register(createAgentSettingsTool({ commandRegistry, commandContext, toolRegistry: registry }));
}
