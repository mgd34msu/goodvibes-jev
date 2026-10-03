import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import { createAgentHarnessTool } from './agent-harness-tool.ts';

type AgentMemoryAction =
  | 'status'
  | 'provider'
  | 'refinement'
  | 'run_refinement'
  | 'curator'
  | 'candidate'
  | 'list'
  | 'search'
  | 'get'
  | 'create'
  | 'update'
  | 'review'
  | 'stale'
  | 'delete';

interface AgentMemoryToolArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly id?: unknown;
  readonly recordId?: unknown;
  readonly providerId?: unknown;
  readonly candidateId?: unknown;
  readonly knowledgeSpaceId?: unknown;
  readonly sourceIds?: unknown;
  readonly gapIds?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
  readonly cls?: unknown;
  readonly scope?: unknown;
  readonly summary?: unknown;
  readonly detail?: unknown;
  readonly body?: unknown;
  readonly confidence?: unknown;
  readonly tags?: unknown;
  readonly reason?: unknown;
  readonly maxRunMs?: unknown;
  readonly force?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

interface AgentMemoryToolDeps {
  readonly commandRegistry: CommandRegistry;
  readonly commandContext: CommandContext;
  readonly toolRegistry: ToolRegistry;
  readonly harnessTool?: Tool;
  readonly localRegistryTool?: Tool;
}

function error(message: string): { readonly success: false; readonly error: string } {
  return { success: false, error: message };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeMemoryAction(value: unknown): AgentMemoryAction | null {
  const action = readString(value).toLowerCase().replace(/-/g, '_');
  if (!action) return null;
  if (action === 'status' || action === 'summary' || action === 'posture' || action === 'memory_posture' || action === 'recall' || action === 'providers') return 'status';
  if (action === 'provider' || action === 'memory_provider' || action === 'embedding' || action === 'external' || action === 'external_provider') return 'provider';
  if (action === 'refinement' || action === 'refinement_tasks' || action === 'semantic_refinement' || action === 'self_improvement' || action === 'semantic_self_improvement' || action === 'learning_loop') return 'refinement';
  if (action === 'run_refinement' || action === 'refine' || action === 'run_semantic_refinement' || action === 'run_self_improvement' || action === 'self_improve') return 'run_refinement';
  if (action === 'curator' || action === 'learning' || action === 'learning_curator' || action === 'queue' || action === 'review_queue' || action === 'plan') return 'curator';
  if (action === 'candidate' || action === 'learning_candidate' || action === 'card' || action === 'inspect_candidate') return 'candidate';
  if (action === 'list' || action === 'records' || action === 'memories') return 'list';
  if (action === 'search' || action === 'find' || action === 'lookup') return 'search';
  if (action === 'get' || action === 'show' || action === 'inspect' || action === 'read') return 'get';
  if (action === 'create' || action === 'add' || action === 'remember') return 'create';
  if (action === 'update' || action === 'edit') return 'update';
  if (action === 'review' || action === 'approve') return 'review';
  if (action === 'stale' || action === 'mark_stale') return 'stale';
  if (action === 'delete' || action === 'remove' || action === 'forget') return 'delete';
  return null;
}

function readAction(args: AgentMemoryToolArgs): AgentMemoryAction {
  const explicit = normalizeMemoryAction(args.action) ?? normalizeMemoryAction(args.mode);
  if (explicit) return explicit;
  if (readString(args.providerId)) return 'provider';
  if (readString(args.candidateId)) return 'candidate';
  if (readString(args.id) || readString(args.recordId)) return 'get';
  if (readString(args.query) || readString(args.target)) return 'search';
  return 'status';
}

function compactArgs(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== ''));
}

function lookupId(args: AgentMemoryToolArgs): string {
  return readString(args.id) || readString(args.recordId);
}

function findRegisteredTool(registry: ToolRegistry, name: string): Tool | null {
  return registry.list().find((tool) => tool.definition.name === name) ?? null;
}

function localMemoryArgs(action: AgentMemoryAction, args: AgentMemoryToolArgs): Record<string, unknown> {
  return compactArgs({
    domain: 'memory',
    action,
    id: lookupId(args),
    query: args.query ?? args.target,
    cls: args.cls,
    scope: args.scope,
    summary: args.summary,
    detail: args.detail,
    body: args.body,
    confidence: args.confidence,
    tags: args.tags,
    reason: args.reason,
    confirm: args.confirm,
    explicitUserRequest: args.explicitUserRequest,
  });
}

export function createAgentMemoryTool(deps: AgentMemoryToolDeps): Tool {
  const harnessTool = deps.harnessTool ?? createAgentHarnessTool({
    commandRegistry: deps.commandRegistry,
    commandContext: deps.commandContext,
    toolRegistry: deps.toolRegistry,
  });

  return {
    definition: {
      name: 'memory',
      description: 'Inspect memory posture, providers, curator, and records.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'provider', 'refinement', 'run_refinement', 'curator', 'candidate', 'list', 'search', 'get', 'create', 'update', 'review', 'stale', 'delete'],
            description: 'Read memory posture/providers/curator or operate records.',
          },
          mode: { type: 'string', description: 'Alias for action.' },
          id: { type: 'string', description: 'Agent-local memory record id.' },
          recordId: { type: 'string', description: 'Alias for id.' },
          providerId: { type: 'string', description: 'Embedding or external-memory provider id.' },
          candidateId: { type: 'string', description: 'Learning curator candidate id.' },
          knowledgeSpaceId: { type: 'string', description: 'Agent Knowledge space id for semantic refinement.' },
          sourceIds: { type: 'array', items: { type: 'string' }, description: 'Agent Knowledge source ids for scoped semantic refinement.' },
          gapIds: { type: 'array', items: { type: 'string' }, description: 'Agent Knowledge semantic gap ids for scoped refinement.' },
          target: { type: 'string', description: 'Lookup target or search text.' },
          query: { type: 'string', description: 'Search text.' },
          includeParameters: { type: 'boolean', description: 'Include provider setup contracts or candidate details.' },
          limit: { type: 'number', description: 'Maximum posture, curator, or search rows.' },
          cls: { type: 'string', description: 'Memory class for create/update.' },
          scope: { type: 'string', description: 'Memory scope for create/update.' },
          summary: { type: 'string', description: 'Memory summary for create/update.' },
          detail: { type: 'string', description: 'Memory detail for create/update.' },
          body: { type: 'string', description: 'Alias for detail.' },
          confidence: { type: 'number', description: 'Review confidence, 0-100.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Memory tags.' },
          reason: { type: 'string', description: 'Reason for stale/delete decisions.' },
          maxRunMs: { type: 'number', description: 'Maximum semantic refinement run budget in milliseconds.' },
          force: { type: 'boolean', description: 'Force semantic refinement reprocessing where supported.' },
          confirm: { type: 'boolean', description: 'Required for deletion and other confirmed memory effects.' },
          explicitUserRequest: { type: 'string', description: 'User request authorizing confirmed memory effects.' },
        },
        additionalProperties: false,
      },
      sideEffects: ['state'],
      concurrency: 'serial',
    },
    execute: async (rawArgs: unknown) => {
      const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as AgentMemoryToolArgs;
      const action = readAction(args);

      if (action === 'status') {
        return harnessTool.execute(compactArgs({
          mode: 'memory_posture',
          query: args.query ?? args.target,
          limit: args.limit,
          includeParameters: args.includeParameters,
        }));
      }
      if (action === 'provider') {
        return harnessTool.execute(compactArgs({
          mode: 'memory_provider',
          providerId: args.providerId ?? args.id,
          target: args.providerId || args.id ? undefined : args.target,
          query: args.providerId || args.id ? undefined : args.query,
          includeParameters: args.includeParameters,
        }));
      }
      if (action === 'refinement') {
        return harnessTool.execute(compactArgs({
          mode: 'memory_refinement',
          target: args.target,
          query: args.query,
          knowledgeSpaceId: args.knowledgeSpaceId,
          sourceIds: args.sourceIds,
          gapIds: args.gapIds,
          limit: args.limit,
          includeParameters: args.includeParameters,
        }));
      }
      if (action === 'run_refinement') {
        return harnessTool.execute(compactArgs({
          mode: 'run_memory_refinement',
          knowledgeSpaceId: args.knowledgeSpaceId,
          sourceIds: args.sourceIds,
          gapIds: args.gapIds,
          limit: args.limit,
          maxRunMs: args.maxRunMs,
          force: args.force,
          confirm: args.confirm,
          explicitUserRequest: args.explicitUserRequest,
        }));
      }
      if (action === 'curator') {
        return harnessTool.execute(compactArgs({
          mode: 'learning_curator',
          query: args.query ?? args.target,
          limit: args.limit,
          includeParameters: args.includeParameters,
        }));
      }
      if (action === 'candidate') {
        return harnessTool.execute(compactArgs({
          mode: 'learning_candidate',
          candidateId: args.candidateId ?? args.id,
          target: args.candidateId || args.id ? undefined : args.target,
          query: args.candidateId || args.id ? undefined : args.query,
          includeParameters: args.includeParameters,
        }));
      }

      const localRegistryTool = deps.localRegistryTool ?? findRegisteredTool(deps.toolRegistry, 'agent_local_registry');
      if (!localRegistryTool) return error('Agent-local memory registry is unavailable in this runtime.');
      return localRegistryTool.execute(localMemoryArgs(action, args));
    },
  };
}

export function registerAgentMemoryTool(
  registry: ToolRegistry,
  commandRegistry: CommandRegistry,
  commandContext: CommandContext,
): void {
  if (!registry.has('memory')) registry.register(createAgentMemoryTool({ commandRegistry, commandContext, toolRegistry: registry }));
}
