import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import { createAgentHarnessTool } from './agent-harness-tool.ts';

type AgentAutonomyAction = 'intake' | 'queue' | 'item' | 'status';

interface AgentAutonomyToolArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly id?: unknown;
  readonly queueItemId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

interface AgentAutonomyToolDeps {
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

function normalizeAutonomyAction(value: unknown): AgentAutonomyAction | null {
  const action = readString(value).toLowerCase().replace(/-/g, '_');
  if (!action) return null;
  if (action === 'intake' || action === 'request' || action === 'route' || action === 'plan' || action === 'triage' || action === 'autonomy_intake') return 'intake';
  if (action === 'queue' || action === 'list' || action === 'work' || action === 'ongoing' || action === 'autonomy_queue') return 'queue';
  if (action === 'item' || action === 'card' || action === 'show' || action === 'inspect' || action === 'autonomy_queue_item') return 'item';
  if (action === 'status' || action === 'summary' || action === 'overview') return 'status';
  return null;
}

function readAction(args: AgentAutonomyToolArgs): AgentAutonomyAction {
  const explicit = normalizeAutonomyAction(args.action) ?? normalizeAutonomyAction(args.mode);
  if (explicit) return explicit;
  if (readString(args.queueItemId) || readString(args.id)) return 'item';
  if (readString(args.query) || readString(args.target)) return 'intake';
  return 'queue';
}

function compactArgs(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== ''));
}

function queueItemId(args: AgentAutonomyToolArgs): string {
  return readString(args.queueItemId) || readString(args.id);
}

function intakeArgs(args: AgentAutonomyToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'autonomy_intake',
    query: args.query,
    target: args.target,
    includeParameters: args.includeParameters,
  });
}

function queueArgs(args: AgentAutonomyToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'autonomy_queue',
    query: args.query ?? args.target,
    limit: args.limit,
    includeParameters: args.includeParameters,
  });
}

function itemArgs(args: AgentAutonomyToolArgs): Record<string, unknown> {
  const itemId = queueItemId(args);
  return compactArgs({
    mode: 'autonomy_queue_item',
    queueItemId: itemId,
    target: itemId ? undefined : args.target,
    query: itemId ? undefined : args.query,
    includeParameters: args.includeParameters,
  });
}

export function createAgentAutonomyTool(deps: AgentAutonomyToolDeps): Tool {
  const harnessTool = deps.harnessTool ?? createAgentHarnessTool({
    commandRegistry: deps.commandRegistry,
    commandContext: deps.commandContext,
    toolRegistry: deps.toolRegistry,
  });

  return {
    definition: {
      name: 'autonomy',
      description: 'Route ongoing work and inspect visible autonomy.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['intake', 'queue', 'item', 'status'],
            description: 'Read-only autonomy intake, queue, item, or status view.',
          },
          mode: { type: 'string', description: 'Alias for action.' },
          id: { type: 'string', description: 'Alias for queueItemId.' },
          queueItemId: { type: 'string', description: 'Autonomy queue card id.' },
          target: { type: 'string', description: 'Lookup target or ongoing-work request.' },
          query: { type: 'string', description: 'Ongoing-work request or queue search text.' },
          includeParameters: { type: 'boolean', description: 'Include detailed routes, schemas, live records, and control evidence.' },
          limit: { type: 'number', description: 'Maximum queue rows returned.' },
        },
        additionalProperties: false,
      },
      sideEffects: [],
      concurrency: 'parallel',
    },
    execute: async (rawArgs: unknown) => {
      const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as AgentAutonomyToolArgs;
      const action = readAction(args);

      if (action === 'intake') return harnessTool.execute(intakeArgs(args));
      if (action === 'queue' || action === 'status') return harnessTool.execute(queueArgs(args));
      if (action === 'item') return harnessTool.execute(itemArgs(args));

      return error('Unknown autonomy action. Use action:"intake" for ongoing work or action:"queue" for visible autonomous work.');
    },
  };
}

export function registerAgentAutonomyTool(
  registry: ToolRegistry,
  commandRegistry: CommandRegistry,
  commandContext: CommandContext,
): void {
  if (!registry.has('autonomy')) registry.register(createAgentAutonomyTool({ commandRegistry, commandContext, toolRegistry: registry }));
}
