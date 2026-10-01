import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import { createAgentHarnessTool } from './agent-harness-tool.ts';

type AgentContextAction =
  | 'status'
  | 'files'
  | 'file'
  | 'prompt'
  | 'receipts'
  | 'receipt';

interface AgentContextToolArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly contextFileId?: unknown;
  readonly receiptId?: unknown;
  readonly turnId?: unknown;
  readonly outcomeStatus?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

interface AgentContextToolDeps {
  readonly commandRegistry: CommandRegistry;
  readonly commandContext: CommandContext;
  readonly toolRegistry: ToolRegistry;
  readonly harnessTool?: Tool;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeContextAction(value: unknown): AgentContextAction | null {
  const action = readString(value).toLowerCase().replace(/-/g, '_');
  if (!action) return null;
  if (action === 'status' || action === 'summary' || action === 'context' || action === 'current') return 'status';
  if (action === 'files' || action === 'project' || action === 'project_context' || action === 'instructions') return 'files';
  if (action === 'file' || action === 'show' || action === 'project_context_file' || action === 'instruction') return 'file';
  if (action === 'prompt' || action === 'prompt_context' || action === 'composition' || action === 'budget') return 'prompt';
  if (action === 'receipts' || action === 'turns' || action === 'outcomes') return 'receipts';
  if (action === 'receipt' || action === 'turn' || action === 'outcome') return 'receipt';
  return null;
}

function readAction(args: AgentContextToolArgs): AgentContextAction {
  const explicit = normalizeContextAction(args.action) ?? normalizeContextAction(args.mode);
  if (explicit) return explicit;
  if (readString(args.receiptId) || readString(args.turnId) || readString(args.outcomeStatus)) return 'receipt';
  if (readString(args.contextFileId)) return 'file';
  if (readString(args.target) || readString(args.query)) return 'files';
  return 'status';
}

function compactArgs(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== ''));
}

export function createAgentContextTool(deps: AgentContextToolDeps): Tool {
  const harnessTool = deps.harnessTool ?? createAgentHarnessTool({
    commandRegistry: deps.commandRegistry,
    commandContext: deps.commandContext,
    toolRegistry: deps.toolRegistry,
  });

  return {
    definition: {
      name: 'context',
      description: 'Inspect project instructions and prompt context.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'files', 'file', 'prompt', 'receipts', 'receipt'],
            description: 'Read project files, prompt context, or receipt history.',
          },
          mode: { type: 'string', description: 'Alias for action.' },
          contextFileId: { type: 'string', description: 'Project context file id.' },
          receiptId: { type: 'string', description: 'Prompt context receipt id.' },
          turnId: { type: 'string', description: 'Prompt context turn id.' },
          outcomeStatus: { type: 'string', enum: ['completed', 'error', 'cancelled', 'pending'], description: 'Prompt receipt outcome filter.' },
          target: { type: 'string', description: 'Target file path or context lookup text.' },
          query: { type: 'string', description: 'Search text for context files.' },
          includeParameters: { type: 'boolean', description: 'Include bounded bodies and receipt detail.' },
          limit: { type: 'number', description: 'Maximum prompt receipts to return.' },
        },
        additionalProperties: false,
      },
      sideEffects: [],
      concurrency: 'parallel',
    },
    execute: async (rawArgs: unknown) => {
      const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as AgentContextToolArgs;
      const action = readAction(args);

      if (action === 'files') {
        return harnessTool.execute(compactArgs({
          mode: 'project_context',
          target: args.target,
          query: args.query,
          includeParameters: args.includeParameters,
        }));
      }
      if (action === 'file') {
        return harnessTool.execute(compactArgs({
          mode: 'project_context_file',
          contextFileId: args.contextFileId,
          target: args.target,
          query: args.query,
          includeParameters: args.includeParameters,
        }));
      }
      if (action === 'receipt' || action === 'receipts') {
        return harnessTool.execute(compactArgs({
          mode: 'prompt_context',
          receiptId: args.receiptId,
          turnId: args.turnId,
          outcomeStatus: args.outcomeStatus,
          limit: args.limit,
          includeParameters: action === 'receipt' ? args.includeParameters ?? true : args.includeParameters,
        }));
      }
      return harnessTool.execute(compactArgs({
        mode: 'prompt_context',
        limit: args.limit,
        includeParameters: args.includeParameters,
      }));
    },
  };
}

export function registerAgentContextTool(
  registry: ToolRegistry,
  commandRegistry: CommandRegistry,
  commandContext: CommandContext,
): void {
  if (!registry.has('context')) registry.register(createAgentContextTool({ commandRegistry, commandContext, toolRegistry: registry }));
}
