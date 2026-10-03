import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import { createAgentHarnessTool } from './agent-harness-tool.ts';

type AgentSessionsAction = 'list' | 'get';

interface AgentSessionsToolArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly id?: unknown;
  readonly sessionId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

interface AgentSessionsToolDeps {
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

function normalizeSessionsAction(value: unknown): AgentSessionsAction | null {
  const action = readString(value).toLowerCase().replace(/-/g, '_');
  if (!action) return null;
  if (['list', 'search', 'status', 'summary', 'catalog', 'sessions', 'bookmarks'].includes(action)) return 'list';
  if (['get', 'show', 'inspect', 'session'].includes(action)) return 'get';
  return null;
}

function readAction(args: AgentSessionsToolArgs): AgentSessionsAction | null {
  const explicit = normalizeSessionsAction(args.action) ?? normalizeSessionsAction(args.mode);
  if (explicit) return explicit;
  if (readString(args.sessionId) || readString(args.id)) return 'get';
  return 'list';
}

function compactArgs(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== ''));
}

function listArgs(args: AgentSessionsToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'sessions',
    query: args.query ?? args.target,
    includeParameters: args.includeParameters,
    limit: args.limit,
  });
}

function getArgs(args: AgentSessionsToolArgs): Record<string, unknown> {
  const sessionId = readString(args.sessionId) || readString(args.id);
  return compactArgs({
    mode: 'session',
    sessionId,
    target: sessionId ? undefined : args.target,
    query: sessionId ? undefined : args.query,
    includeParameters: args.includeParameters,
  });
}

export function createAgentSessionsTool(deps: AgentSessionsToolDeps): Tool {
  const harnessTool = deps.harnessTool ?? createAgentHarnessTool({
    commandRegistry: deps.commandRegistry,
    commandContext: deps.commandContext,
    toolRegistry: deps.toolRegistry,
  });

  return {
    definition: {
      name: 'sessions',
      description: 'Read saved sessions, bookmarks, and transcript continuity.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'search', 'status', 'get'],
            description: 'List/search sessions or inspect one saved session.',
          },
          mode: { type: 'string', description: 'Alias for action.' },
          id: { type: 'string', description: 'Alias for sessionId.' },
          sessionId: { type: 'string', description: 'Saved session id.' },
          target: { type: 'string', description: 'Lookup target or search text.' },
          query: { type: 'string', description: 'Search text.' },
          includeParameters: { type: 'boolean', description: 'Include detail, snippets, and route metadata.' },
          limit: { type: 'number', description: 'Maximum sessions returned.' },
        },
        additionalProperties: false,
      },
      sideEffects: [],
      concurrency: 'parallel',
    },
    execute: async (rawArgs: unknown) => {
      const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as AgentSessionsToolArgs;
      const action = readAction(args);
      if (!action) return error('Unknown sessions action. Use action:"list" or action:"get".');
      if (action === 'list') return harnessTool.execute(listArgs(args));
      if (action === 'get') return harnessTool.execute(getArgs(args));
      return error('Unknown sessions action. Use action:"list" or action:"get".');
    },
  };
}

export function registerAgentSessionsTool(
  registry: ToolRegistry,
  commandRegistry: CommandRegistry,
  commandContext: CommandContext,
): void {
  if (!registry.has('sessions')) registry.register(createAgentSessionsTool({ commandRegistry, commandContext, toolRegistry: registry }));
}
