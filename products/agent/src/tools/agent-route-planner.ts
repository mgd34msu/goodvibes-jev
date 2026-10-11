import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import {
  channelTargetNamedIds,
  modelProviderNamedIds,
  planTaskRoute,
  type TaskRouteArgs,
  type TaskRouteCandidate,
  type TaskRouteCatalogRanking,
  type TaskRouteDraft,
  type TaskRoutePlan,
} from '@goodvibes-jev/engine/sdk/platform/routing';
import type { JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import type { CommandContext } from '../input/command-registry.ts';
import { AGENT_WORKSPACE_CATEGORIES } from '../input/agent-workspace-categories.ts';
import { HARNESS_MODE_DESCRIPTORS, listHarnessModes } from './agent-harness-mode-catalog.ts';
import { captureCatalogMethods, rankHarnessCatalog, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { captureModelReadingInput, captureModelReadingSnapshotGuard, withModelReadingSource } from './agent-harness-model-reading-source.ts';
import { listWorkspaceActions } from './agent-harness-workspace-actions.ts';
import { externalMemoryLiveProviderRecords, externalMemoryProviderCatalog, externalMemoryReceiptEvidence } from './agent-harness-memory-external-providers.ts';

/** These two native declaration trees have no mutable production consumers. */
function freezeRouteDeclarations(value: unknown, visited = new Set<object>()): void {
  if (value === null || typeof value !== 'object') return;
  if (visited.has(value)) return;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new ToolInputProjectionError('held');
  }
  visited.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor) || typeof descriptor.value === 'function') throw new ToolInputProjectionError('held');
    freezeRouteDeclarations(descriptor.value, visited);
  }
  Object.freeze(value);
}
freezeRouteDeclarations(HARNESS_MODE_DESCRIPTORS);
freezeRouteDeclarations(AGENT_WORKSPACE_CATEGORIES);
const assertDeclarationMethods = captureCatalogMethods(Array.prototype, ['flatMap', 'map', 'filter', 'slice', 'find', 'sort']);

export type AgentRoutePlannerArgs = TaskRouteArgs;
export type AgentRouteCandidate = TaskRouteCandidate;
/** Legacy candidate builders remain accounted for, but neither live caller uses them. */
export type RouteCandidateDraft = TaskRouteDraft & { readonly score: number };

export interface AgentTaskRouteSources {
  readonly channelRegistry?: Parameters<typeof channelTargetNamedIds>[0];
}

/** Rank complete locally screened catalogs through the canonical public reader. */
async function rankCatalog(
  request: string,
  records: readonly Record<string, unknown>[],
  options: CatalogRankingOptions,
  evidenceById?: ReadonlyMap<string, unknown>,
): Promise<TaskRouteCatalogRanking> {
  const result = await rankHarnessCatalog(records, request, record => {
    if (typeof record.id !== 'string') throw new ToolInputProjectionError('held');
    return { id: record.id, description: JSON.stringify(record), evidence: evidenceById?.get(record.id) ?? record };
  }, 'agent.task-route.catalog', { ...options, requirePreservedSource: true });
  return { records, ranked: result.judgments };
}

/** The installed runtime judgment port owns every reading; never install a fallback here. */
export async function planAgentTaskRoute(
  context: CommandContext,
  args: AgentRoutePlannerArgs,
  sources: AgentTaskRouteSources = {},
  options: CatalogRankingOptions = {},
): Promise<TaskRoutePlan> {
  const captured = captureModelReadingInput(args);
  const request = (typeof captured.query === 'string' ? captured.query.trim() : '') || (typeof captured.target === 'string' ? captured.target.trim() : '');
  if (!request) return planTaskRoute(captured);
  const modes = captureModelReadingInput(HARNESS_MODE_DESCRIPTORS);
  const workspace = captureModelReadingInput(listWorkspaceActions(context, { limit: 1000 }));
  freezeRouteDeclarations(workspace);
  const workspaceEvidence = new Map<string, unknown>();
  for (const category of AGENT_WORKSPACE_CATEGORIES) for (const action of category.actions) {
    workspaceEvidence.set(action.id, { category: { id: category.id, group: category.group, label: category.label,
      summary: category.summary, detail: category.detail }, action });
  }
  const assertArgs = captureModelReadingSnapshotGuard(captured);
  const assertModes = captureModelReadingSnapshotGuard(modes);
  const assertCategories = captureModelReadingSnapshotGuard(captureModelReadingInput(AGENT_WORKSPACE_CATEGORIES));
  const assertContext = captureCatalogMethods(context, ['provider']);
  const provider = context.provider;
  const assertProvider = provider ? captureCatalogMethods(provider, ['providerRegistry']) : undefined;
  const providers = context.provider?.providerRegistry;
  const assertSources = captureCatalogMethods(sources, ['channelRegistry']);
  const channels = sources.channelRegistry;
  const assertSourcesCurrent = () => {
    assertDeclarationMethods(); assertContext(); assertProvider?.(); assertSources();
    assertArgs(args); assertModes(HARNESS_MODE_DESCRIPTORS);
    assertCategories(AGENT_WORKSPACE_CATEGORIES);
    if (context.provider !== provider || provider?.providerRegistry !== providers || sources.channelRegistry !== channels) throw new ToolInputProjectionError('held');
  };
  options.retainCurrent?.(assertSourcesCurrent, 'agent.task-route.sources');
  const assertCurrent = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); assertSourcesCurrent(); };
  assertCurrent();
  return withModelReadingSource(captured, { ...options, assertCurrent }, async (protectedArgs, readingOptions) => {
    assertCurrent();
    const memory = externalMemoryProviderCatalog(await externalMemoryLiveProviderRecords(context, readingOptions), externalMemoryReceiptEvidence(context));
    readingOptions.assertCurrent?.();
    const envelope = await listHarnessModes({ limit: 1000 });
    readingOptions.assertCurrent?.();
    const modes: Record<string, unknown>[] = [];
    if (!Array.isArray(envelope.modes)) throw new ToolInputProjectionError('held');
    for (const mode of envelope.modes) {
      if (!mode || typeof mode !== 'object' || Array.isArray(mode)) throw new ToolInputProjectionError('held');
      modes.push(Object.fromEntries(Object.entries(mode)));
    }
    freezeRouteDeclarations(modes);
    const rankOptions = (current: JudgmentReadingOptions = {}): CatalogRankingOptions => ({ ...readingOptions,
      ...(current.signal ? { signal: current.signal } : {}), assertCurrent: () => {
        readingOptions.assertCurrent?.(); current.assertCurrent?.();
      } });
    const plan = await planTaskRoute(protectedArgs, {
      namedIds: {
        ...(providers ? { modelProvider: () => modelProviderNamedIds(providers) } : {}),
        ...(channels ? { channelTarget: () => channelTargetNamedIds(channels) } : {}),
        memoryProvider: () => memory.map(({ id, label }) => ({ id, names: [label, id] })),
      },
      workspaceMatches: (currentRequest, _limit, current) => rankCatalog(currentRequest, workspace, rankOptions(current), workspaceEvidence),
      modeMatches: (currentRequest, _limit, current) => rankCatalog(currentRequest, modes, rankOptions(current)),
    }, readingOptions);
    readingOptions.assertCurrent?.();
    return plan;
  });
}
