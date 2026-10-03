import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import { createAgentHarnessTool } from './agent-harness-tool.ts';

type AgentAuditAction = 'readiness' | 'item' | 'evidence' | 'artifact';

interface AgentAuditToolArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly id?: unknown;
  readonly itemId?: unknown;
  readonly artifactId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

interface AgentAuditToolDeps {
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

function normalizeAuditAction(value: unknown): AgentAuditAction | null {
  const action = readString(value).toLowerCase().replace(/-/g, '_');
  if (!action) return null;
  if (['readiness', 'status', 'summary', 'inventory', 'gate', 'gates', 'release_readiness'].includes(action)) return 'readiness';
  if (['item', 'readiness_item', 'release_readiness_item'].includes(action)) return 'item';
  if (['evidence', 'artifacts', 'release_evidence', 'ledger', 'verification'].includes(action)) return 'evidence';
  if (['artifact', 'evidence_artifact', 'release_evidence_artifact'].includes(action)) return 'artifact';
  return null;
}

function evidenceLikeText(args: AgentAuditToolArgs): boolean {
  const text = `${readString(args.query)}\n${readString(args.target)}`.toLowerCase();
  return /\b(evidence|artifact|ledger|verification|live[-\s]?verification|release notes|performance snapshot)\b/.test(text);
}

function readAction(args: AgentAuditToolArgs): AgentAuditAction | null {
  const explicit = normalizeAuditAction(args.action) ?? normalizeAuditAction(args.mode);
  if (explicit) return explicit;
  if (readString(args.artifactId)) return 'artifact';
  if (readString(args.itemId)) return 'item';
  if (evidenceLikeText(args)) return 'evidence';
  return 'readiness';
}

function compactArgs(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== ''));
}

function readinessArgs(args: AgentAuditToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'release_readiness',
    query: args.query ?? args.target,
    includeParameters: args.includeParameters,
    limit: args.limit,
  });
}

function itemArgs(args: AgentAuditToolArgs): Record<string, unknown> {
  const itemId = readString(args.itemId) || readString(args.id);
  return compactArgs({
    mode: 'release_readiness_item',
    itemId,
    target: itemId ? undefined : args.target,
    query: itemId ? undefined : args.query,
    includeParameters: args.includeParameters,
  });
}

function evidenceArgs(args: AgentAuditToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'release_evidence',
    query: args.query ?? args.target,
    includeParameters: args.includeParameters,
    limit: args.limit,
  });
}

function artifactArgs(args: AgentAuditToolArgs): Record<string, unknown> {
  const artifactId = readString(args.artifactId) || readString(args.id);
  return compactArgs({
    mode: 'release_evidence_artifact',
    artifactId,
    target: artifactId ? undefined : args.target,
    query: artifactId ? undefined : args.query,
    includeParameters: args.includeParameters,
  });
}

export function createAgentAuditTool(deps: AgentAuditToolDeps): Tool {
  const harnessTool = deps.harnessTool ?? createAgentHarnessTool({
    commandRegistry: deps.commandRegistry,
    commandContext: deps.commandContext,
    toolRegistry: deps.toolRegistry,
  });

  return {
    definition: {
      name: 'audit',
      description: 'Read release readiness and packaged release evidence.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['readiness', 'item', 'evidence', 'artifact'],
            description: 'Read release inventory, one item, evidence list, or one artifact.',
          },
          mode: { type: 'string', description: 'Alias for action.' },
          id: { type: 'string', description: 'Alias for itemId or artifactId depending on action.' },
          itemId: { type: 'string', description: 'Release readiness item id.' },
          artifactId: { type: 'string', description: 'Release evidence artifact id.' },
          target: { type: 'string', description: 'Lookup target or search text.' },
          query: { type: 'string', description: 'Search text.' },
          includeParameters: { type: 'boolean', description: 'Include detailed release artifact or item content.' },
          limit: { type: 'number', description: 'Maximum rows returned.' },
        },
        additionalProperties: false,
      },
      sideEffects: [],
      concurrency: 'parallel',
    },
    execute: async (rawArgs: unknown) => {
      const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as AgentAuditToolArgs;
      const action = readAction(args);
      if (!action) return error('Unknown audit action. Use action:"readiness", "item", "evidence", or "artifact".');
      if (action === 'readiness') return harnessTool.execute(readinessArgs(args));
      if (action === 'item') return harnessTool.execute(itemArgs(args));
      if (action === 'evidence') return harnessTool.execute(evidenceArgs(args));
      if (action === 'artifact') return harnessTool.execute(artifactArgs(args));
      return error('Unknown audit action. Use action:"readiness", "item", "evidence", or "artifact".');
    },
  };
}

export function registerAgentAuditTool(
  registry: ToolRegistry,
  commandRegistry: CommandRegistry,
  commandContext: CommandContext,
): void {
  if (!registry.has('audit')) registry.register(createAgentAuditTool({ commandRegistry, commandContext, toolRegistry: registry }));
}
