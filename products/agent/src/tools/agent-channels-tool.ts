import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import { createAgentHarnessTool } from './agent-harness-tool.ts';

type AgentChannelsAction = 'status' | 'channel' | 'setup' | 'triage' | 'deliveries';

interface AgentChannelsToolArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly channelId?: unknown;
  readonly id?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

interface AgentChannelsToolDeps {
  readonly commandRegistry: CommandRegistry;
  readonly commandContext: CommandContext;
  readonly toolRegistry: ToolRegistry;
  readonly harnessTool?: Tool;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeChannelsAction(value: unknown): AgentChannelsAction | null {
  const action = readString(value).toLowerCase().replace(/-/g, '_');
  if (!action) return null;
  if (action === 'status' || action === 'summary' || action === 'list' || action === 'readiness' || action === 'channels') return 'status';
  if (action === 'channel' || action === 'show' || action === 'inspect') return 'channel';
  if (action === 'setup' || action === 'guide' || action === 'setup_guide' || action === 'channel_setup_guide') return 'setup';
  if (action === 'triage' || action === 'inbox' || action === 'blockers' || action === 'retries' || action === 'channel_triage') return 'triage';
  if (action === 'deliveries' || action === 'delivery' || action === 'receipts' || action === 'history' || action === 'channel_deliveries') return 'deliveries';
  return null;
}

function readAction(args: AgentChannelsToolArgs): AgentChannelsAction {
  const explicit = normalizeChannelsAction(args.action) ?? normalizeChannelsAction(args.mode);
  if (explicit) return explicit;
  if (readString(args.channelId) || readString(args.id)) return 'channel';
  return 'status';
}

function compactArgs(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== ''));
}

function channelIdArg(args: AgentChannelsToolArgs): unknown {
  return readString(args.channelId) || readString(args.id) || undefined;
}

export function createAgentChannelsTool(deps: AgentChannelsToolDeps): Tool {
  const harnessTool = deps.harnessTool ?? createAgentHarnessTool({
    commandRegistry: deps.commandRegistry,
    commandContext: deps.commandContext,
    toolRegistry: deps.toolRegistry,
  });

  return {
    definition: {
      name: 'channels',
      description: 'Inspect channel readiness, setup, triage, and receipts.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'channel', 'setup', 'triage', 'deliveries'],
            description: 'Read channel status, setup, triage, or receipts.',
          },
          mode: { type: 'string', description: 'Alias for action.' },
          channelId: { type: 'string', description: 'Channel id to inspect.' },
          id: { type: 'string', description: 'Alias for channelId.' },
          target: { type: 'string', description: 'Channel lookup target.' },
          query: { type: 'string', description: 'Search text.' },
          includeParameters: { type: 'boolean', description: 'Include route detail and safe config-key names.' },
          limit: { type: 'number', description: 'Maximum triage, delivery, or channel rows.' },
        },
        additionalProperties: false,
      },
      sideEffects: [],
      concurrency: 'parallel',
    },
    execute: async (rawArgs: unknown) => {
      const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as AgentChannelsToolArgs;
      const action = readAction(args);

      if (action === 'channel') {
        return harnessTool.execute(compactArgs({
          mode: 'channel',
          channelId: channelIdArg(args),
          target: args.target,
          query: args.query,
          includeParameters: args.includeParameters,
        }));
      }
      if (action === 'setup') {
        return harnessTool.execute(compactArgs({
          mode: 'channel_setup_guide',
          channelId: channelIdArg(args),
          target: args.target,
          query: args.query,
          includeParameters: args.includeParameters,
        }));
      }
      if (action === 'triage') {
        return harnessTool.execute(compactArgs({
          mode: 'channel_triage',
          limit: args.limit,
          includeParameters: args.includeParameters,
        }));
      }
      if (action === 'deliveries') {
        return harnessTool.execute(compactArgs({
          mode: 'channel_deliveries',
          limit: args.limit,
          includeParameters: args.includeParameters,
        }));
      }
      return harnessTool.execute(compactArgs({
        mode: 'channels',
        query: args.query ?? args.target,
        limit: args.limit,
        includeParameters: args.includeParameters,
      }));
    },
  };
}

export function registerAgentChannelsTool(
  registry: ToolRegistry,
  commandRegistry: CommandRegistry,
  commandContext: CommandContext,
): void {
  if (!registry.has('channels')) registry.register(createAgentChannelsTool({ commandRegistry, commandContext, toolRegistry: registry }));
}
