import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import { createAgentHarnessTool } from './agent-harness-tool.ts';

type AgentSupportAction = 'status' | 'bundle';

interface AgentSupportToolArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly id?: unknown;
  readonly bundlePath?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

interface AgentSupportToolDeps {
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

function normalizeSupportAction(value: unknown): AgentSupportAction | null {
  const action = readString(value).toLowerCase().replace(/-/g, '_');
  if (!action) return null;
  if (['status', 'summary', 'list', 'catalog', 'routes', 'bundles', 'diagnostics'].includes(action)) return 'status';
  if (['bundle', 'inspect', 'show', 'get', 'support_bundle'].includes(action)) return 'bundle';
  return null;
}

function readAction(args: AgentSupportToolArgs): AgentSupportAction | null {
  const explicit = normalizeSupportAction(args.action) ?? normalizeSupportAction(args.mode);
  if (explicit) return explicit;
  if (readString(args.bundlePath) || readString(args.id)) return 'bundle';
  return 'status';
}

function compactArgs(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== ''));
}

function statusArgs(args: AgentSupportToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'support_bundles',
    query: args.query ?? args.target,
    includeParameters: args.includeParameters,
    limit: args.limit,
  });
}

function bundleArgs(args: AgentSupportToolArgs): Record<string, unknown> {
  const bundlePath = readString(args.bundlePath) || readString(args.id);
  return compactArgs({
    mode: 'support_bundle',
    bundlePath,
    target: bundlePath ? undefined : args.target,
    query: bundlePath ? undefined : args.query,
    includeParameters: args.includeParameters,
  });
}

export function createAgentSupportTool(deps: AgentSupportToolDeps): Tool {
  const harnessTool = deps.harnessTool ?? createAgentHarnessTool({
    commandRegistry: deps.commandRegistry,
    commandContext: deps.commandContext,
    toolRegistry: deps.toolRegistry,
  });

  return {
    definition: {
      name: 'support',
      description: 'Read support-bundle routes and redacted bundle summaries.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'bundle'],
            description: 'List support bundle routes or inspect one existing bundle.',
          },
          mode: { type: 'string', description: 'Alias for action.' },
          id: { type: 'string', description: 'Alias for bundlePath.' },
          bundlePath: { type: 'string', description: 'Workspace-relative support bundle path to inspect.' },
          target: { type: 'string', description: 'Lookup target or search text.' },
          query: { type: 'string', description: 'Search text.' },
          includeParameters: { type: 'boolean', description: 'Include detailed route and policy metadata.' },
          limit: { type: 'number', description: 'Maximum bundle routes returned.' },
        },
        additionalProperties: false,
      },
      sideEffects: [],
      concurrency: 'parallel',
    },
    execute: async (rawArgs: unknown) => {
      const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as AgentSupportToolArgs;
      const action = readAction(args);
      if (!action) return error('Unknown support action. Use action:"status" or action:"bundle".');
      if (action === 'status') return harnessTool.execute(statusArgs(args));
      if (action === 'bundle') return harnessTool.execute(bundleArgs(args));
      return error('Unknown support action. Use action:"status" or action:"bundle".');
    },
  };
}

export function registerAgentSupportTool(
  registry: ToolRegistry,
  commandRegistry: CommandRegistry,
  commandContext: CommandContext,
): void {
  if (!registry.has('support')) registry.register(createAgentSupportTool({ commandRegistry, commandContext, toolRegistry: registry }));
}
