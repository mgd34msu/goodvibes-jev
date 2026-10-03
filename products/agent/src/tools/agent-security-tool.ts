import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import { createAgentHarnessTool } from './agent-harness-tool.ts';
import { explainAgentPolicyDecision } from './agent-policy-explanation.ts';

type AgentSecurityAction = 'status' | 'finding' | 'explain';

interface AgentSecurityToolArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly id?: unknown;
  readonly findingId?: unknown;
  readonly toolName?: unknown;
  readonly tool?: unknown;
  readonly toolArgs?: unknown;
  readonly args?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

interface AgentSecurityToolDeps {
  readonly commandRegistry: CommandRegistry;
  readonly commandContext: CommandContext;
  readonly toolRegistry: ToolRegistry;
  readonly harnessTool?: Tool;
}

function error(message: string): { readonly success: false; readonly error: string } {
  return { success: false, error: message };
}

function output(value: unknown): { readonly success: true; readonly output: string } {
  return { success: true, output: JSON.stringify(value, null, 2) };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSecurityAction(value: unknown): AgentSecurityAction | null {
  const action = readString(value).toLowerCase().replace(/-/g, '_');
  if (!action) return null;
  if (action === 'status' || action === 'summary' || action === 'review' || action === 'posture') return 'status';
  if (action === 'finding' || action === 'show' || action === 'inspect' || action === 'security_finding') return 'finding';
  if (action === 'explain' || action === 'policy' || action === 'policy_explain' || action === 'why') return 'explain';
  return null;
}

function readAction(args: AgentSecurityToolArgs): AgentSecurityAction | null {
  const explicit = readString(args.action) || readString(args.mode);
  if (explicit) return normalizeSecurityAction(explicit);
  if (readString(args.toolName) || readString(args.tool)) return 'explain';
  if (readString(args.findingId) || readString(args.id)) return 'finding';
  return 'status';
}

function compactArgs(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== ''));
}

function statusArgs(args: AgentSecurityToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'security_posture',
    query: args.query ?? args.target,
    includeParameters: args.includeParameters,
    limit: args.limit,
  });
}

function findingArgs(args: AgentSecurityToolArgs): Record<string, unknown> {
  const findingId = readString(args.findingId) || readString(args.id);
  return compactArgs({
    mode: 'security_finding',
    findingId,
    target: findingId ? undefined : args.target,
    query: findingId ? undefined : args.query,
    includeParameters: args.includeParameters,
  });
}

export function createAgentSecurityTool(deps: AgentSecurityToolDeps): Tool {
  const harnessTool = deps.harnessTool ?? createAgentHarnessTool({
    commandRegistry: deps.commandRegistry,
    commandContext: deps.commandContext,
    toolRegistry: deps.toolRegistry,
  });

  return {
    definition: {
      name: 'security',
      description: 'Read security posture, findings, and policy explanations.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'finding', 'explain'],
            description: 'Read posture, finding detail, or action policy.',
          },
          mode: { type: 'string', description: 'Alias for action.' },
          id: { type: 'string', description: 'Generic finding id.' },
          findingId: { type: 'string', description: 'Security finding id.' },
          toolName: { type: 'string', description: 'Model tool name for action:explain.' },
          tool: { type: 'string', description: 'Alias for toolName.' },
          toolArgs: { type: 'object', description: 'Arguments for policy explanation.' },
          args: { type: 'object', description: 'Alias for toolArgs.' },
          target: { type: 'string', description: 'Lookup target or search text.' },
          query: { type: 'string', description: 'Search text.' },
          includeParameters: { type: 'boolean', description: 'Include detailed evidence and tool metadata.' },
          limit: { type: 'number', description: 'Maximum findings returned.' },
        },
        additionalProperties: false,
      },
      sideEffects: [],
      concurrency: 'parallel',
    },
    execute: async (rawArgs: unknown, options) => {
      const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as AgentSecurityToolArgs;
      const action = readAction(args);
      if (!action) return error('Unknown security action. Use action:"status" or action:"explain".');

      if (action === 'status') return harnessTool.execute(statusArgs(args));
      if (action === 'finding') return harnessTool.execute(findingArgs(args));
      if (action === 'explain') {
        const resolved = await explainAgentPolicyDecision(deps.commandContext, deps.toolRegistry, args, options?.signal);
        if (resolved.status === 'found') return output(resolved.explanation);
        if (resolved.status === 'ambiguous') return error(`Ambiguous security policy target ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
        return error(resolved.usage);
      }

      return error('Unknown security action. Use action:"status" or action:"explain".');
    },
  };
}

export function registerAgentSecurityTool(
  registry: ToolRegistry,
  commandRegistry: CommandRegistry,
  commandContext: CommandContext,
): void {
  if (!registry.has('security')) registry.register(createAgentSecurityTool({ commandRegistry, commandContext, toolRegistry: registry }));
}
