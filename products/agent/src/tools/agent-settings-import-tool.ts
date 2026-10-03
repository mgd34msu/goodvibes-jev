import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CommandContext } from '../input/command-registry.ts';
import {
  importAgentWorkspaceTuiSettings,
  previewAgentWorkspaceTuiSettingsImport,
} from '../input/agent-workspace-settings.ts';

type SettingsImportAction = 'preview' | 'apply';

interface AgentSettingsImportArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
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
  return value === true || (typeof value === 'string' && ['true', 'yes', 'apply', 'import'].includes(value.trim().toLowerCase()));
}

function readAction(args: AgentSettingsImportArgs): SettingsImportAction {
  const raw = (readString(args.action) || readString(args.mode)).toLowerCase();
  if (raw === 'apply' || raw === 'confirm') return 'apply';
  if (raw === 'import') return readBoolean(args.confirm) ? 'apply' : 'preview';
  return 'preview';
}

export function createAgentSettingsImportTool(commandContext: CommandContext): Tool {
  return {
    definition: {
      name: 'import_goodvibes_settings',
      description: 'Preview or apply shared GoodVibes settings import.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['preview', 'import', 'apply'],
            description: 'preview is read-only; apply/import with confirm mutates Agent settings.',
          },
          mode: { type: 'string', description: 'Alias for action.' },
          confirm: { type: 'boolean', description: 'Required true for action:apply.' },
          explicitUserRequest: { type: 'string', description: 'User request authorizing confirmed import.' },
        },
        additionalProperties: false,
      },
      sideEffects: ['state'],
      concurrency: 'serial',
    },
    execute: async (rawArgs: unknown) => {
      const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as AgentSettingsImportArgs;
      const preview = previewAgentWorkspaceTuiSettingsImport(commandContext);
      if (!preview) return error('GoodVibes settings import is unavailable in this runtime.');
      const action = readAction(args);

      if (action === 'preview' || !readBoolean(args.confirm)) {
        return output({
          status: 'confirmation_required',
          action: 'import_goodvibes_settings',
          preview,
          next: 'Run action:"apply" with confirm:true and explicitUserRequest after the user asks to import these settings.',
        });
      }

      const explicitUserRequest = readString(args.explicitUserRequest);
      if (!explicitUserRequest) return error('GoodVibes settings import requires explicitUserRequest when confirm is true.');

      const outcome = await importAgentWorkspaceTuiSettings(commandContext);
      return output({
        status: outcome.status,
        action: 'import_goodvibes_settings',
        preview,
        actionResult: outcome.result,
        runtimeSnapshot: outcome.runtimeSnapshot,
        policy: {
          effect: 'state',
          confirmation: 'confirmed',
          explicitUserRequest,
          boundary: 'Applied only Agent-owned settings and subscription state from published GoodVibes platform sources; source package stores were not mutated.',
        },
      });
    },
  };
}

export function registerAgentSettingsImportTool(registry: ToolRegistry, commandContext: CommandContext): void {
  if (!registry.has('import_goodvibes_settings')) registry.register(createAgentSettingsImportTool(commandContext));
}
