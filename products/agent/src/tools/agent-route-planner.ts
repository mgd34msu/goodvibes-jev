import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { gateJudgmentRegistry } from '@goodvibes-jev/engine/sdk/platform/gate';
import {
  channelTargetNamedIds,
  modelProviderNamedIds,
  planTaskRoute,
  type TaskRouteArgs,
  type TaskRouteCandidate,
  type TaskRouteDraft,
  type TaskRoutePlan,
} from '@goodvibes-jev/engine/sdk/platform/routing';
import type { Rerank } from '@goodvibes-jev/judgment';
import type { CommandContext } from '../input/command-registry.ts';
import { listHarnessModes } from './agent-harness-mode-catalog.ts';
import { listWorkspaceActions } from './agent-harness-workspace-actions.ts';
import { externalMemoryLiveProviderRecords, externalMemoryProviderCatalog, externalMemoryReceiptEvidence } from './agent-harness-memory-external-providers.ts';

export type AgentRoutePlannerArgs = TaskRouteArgs;
export type AgentRouteCandidate = TaskRouteCandidate;
/** Legacy candidate builders remain accounted for, but neither live caller uses them. */
export type RouteCandidateDraft = TaskRouteDraft & { readonly score: number };

export interface AgentTaskRouteSources {
  readonly channelRegistry?: Parameters<typeof channelTargetNamedIds>[0];
}

/** Use the public decision registry, without copying its battery or its bands. */
function registryRank(): Rerank {
  const decision = gateJudgmentRegistry.get('engine.tools.registry-rank');
  if (!decision || !('rerank' in decision) || typeof decision.rerank !== 'function') {
    throw new Error('Task-route catalog ranking is unavailable: engine.tools.registry-rank is not installed.');
  }
  return decision as Rerank;
}

async function rankCatalog(
  request: string,
  records: readonly Record<string, unknown>[],
  limit: number,
  signal?: AbortSignal,
): Promise<readonly Record<string, unknown>[]> {
  const byId = new Map(records.map((record) => [String(record.id), record]));
  const site = 'agent.task-route.catalog';
  const result = await registryRank().rerank(judgmentPort(site), request, [...byId].map(([id, record]) => ({
    id,
    content: {
      type: 'tool',
      name: id,
      description: [record.label, record.summary, record.family, record.modelRoute].filter((value) => typeof value === 'string').join(' ').slice(0, 600),
    },
  })), { site, ...(signal ? { signal } : {}) });
  return result.ranked.filter((entry) => entry.reading.verdict !== 'no').slice(0, limit).map((entry) => byId.get(entry.id)!);
}

/** The installed runtime judgment port owns every reading; never install a fallback here. */
export async function planAgentTaskRoute(
  context: CommandContext,
  args: AgentRoutePlannerArgs,
  sources: AgentTaskRouteSources = {},
  options: { readonly signal?: AbortSignal } = {},
): Promise<TaskRoutePlan> {
  const request = (typeof args.query === 'string' ? args.query.trim() : '') || (typeof args.target === 'string' ? args.target.trim() : '');
  if (!request) return planTaskRoute(args);
  options.signal?.throwIfAborted();
  const providers = context.provider?.providerRegistry;
  const memory = externalMemoryProviderCatalog(await externalMemoryLiveProviderRecords(context, options), externalMemoryReceiptEvidence(context));
  options.signal?.throwIfAborted();
  const matchLimit = args.includeParameters === true ? 6 : 3;
  const modes = listHarnessModes({ limit: 1000 }).modes as readonly Record<string, unknown>[];
  // List the whole catalog, with no local substring shortlist or hand-scored ranking.
  const workspace = rankCatalog(request, listWorkspaceActions(context, { limit: 1000 }), matchLimit, options.signal);
  const harness = rankCatalog(request, modes, matchLimit, options.signal);
  // Await catalog readings ourselves too: the SDK deliberately treats optional catalog
  // failures as empty matches, while this product must report unavailable readings.
  const [plan] = await Promise.all([
    planTaskRoute(args, {
      namedIds: {
        ...(providers ? { modelProvider: () => modelProviderNamedIds(providers) } : {}),
        ...(sources.channelRegistry ? { channelTarget: () => channelTargetNamedIds(sources.channelRegistry!) } : {}),
        memoryProvider: () => memory.map(({ id, label }) => ({ id, names: [label, id] })),
      },
      workspaceMatches: () => workspace,
      modeMatches: () => harness,
    }, options),
    workspace,
    harness,
  ]);
  options.signal?.throwIfAborted();
  return plan;
}
