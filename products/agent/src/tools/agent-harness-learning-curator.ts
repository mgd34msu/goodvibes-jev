import { rankHarnessCatalog, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import type { CommandContext } from '../input/command-registry.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import { buildLearningCandidates, candidateSearchText } from './agent-harness-learning-curator-proposals.ts';
import { localRegistryRoute, missingRequirementCount, routeValue } from './agent-harness-learning-curator-common.ts';
import type { LearningCandidateCollection } from './agent-harness-learning-curator-source.ts';
import type { AgentHarnessLearningCuratorArgs, LearningCandidate, LearningCandidateResolution, LearningConsolidationBatchPlan, LearningPromptPlan, LocalLearningCandidateDomain } from './agent-harness-learning-curator-types.ts';
export type { LearningCandidate, LearningCandidateResolution, LearningConsolidationDiff, LearningConsolidationFields, LearningConsolidationPlan } from './agent-harness-learning-curator-types.ts';

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(200, Math.trunc(parsed)));
}

function describeCandidate(candidate: LearningCandidate, includeParameters: boolean, lookup?: Record<string, unknown>): Record<string, unknown> {
  return {
    candidateId: candidate.id,
    label: candidate.label,
    domain: candidate.domain,
    recordId: candidate.recordId,
    status: candidate.status,
    priority: candidate.priority,
    reason: previewHarnessText(candidate.reason, includeParameters ? 180 : 96),
    next: previewHarnessText(candidate.next, includeParameters ? 180 : 96),
    scores: candidate.scores,
    ...(candidate.reviewState ? { reviewState: candidate.reviewState } : {}),
    ...(candidate.enabled === undefined ? {} : { enabled: candidate.enabled }),
    ...(candidate.active === undefined ? {} : { active: candidate.active }),
    ...(candidate.confidence === undefined ? {} : { confidence: candidate.confidence }),
    ...(candidate.proposalTarget === undefined ? {} : { proposalTarget: candidate.proposalTarget }),
    ...(includeParameters && candidate.proposalFields ? { proposalFields: candidate.proposalFields } : {}),
    ...(candidate.missingRequirements ? { missingRequirements: candidate.missingRequirements } : {}),
    modelRoute: candidate.modelRoute,
    inspectRoute: candidate.inspectRoute,
    ...(candidate.reviewRoute ? { reviewRoute: candidate.reviewRoute } : {}),
    ...(candidate.staleRoute ? { staleRoute: candidate.staleRoute } : {}),
    ...(candidate.updateRoute ? { updateRoute: candidate.updateRoute } : {}),
    ...(candidate.createRoute ? { createRoute: candidate.createRoute } : {}),
    ...(candidate.deleteRoute ? { deleteRoute: candidate.deleteRoute } : {}),
    ...(includeParameters && candidate.cleanupRoutes ? { cleanupRoutes: candidate.cleanupRoutes } : {}),
    ...(includeParameters && candidate.rollbackRoutes ? { rollbackRoutes: candidate.rollbackRoutes } : {}),
    ...(includeParameters && candidate.consolidation ? { consolidation: candidate.consolidation } : {}),
    ...(lookup ? { lookup } : {}),
    ...(includeParameters ? {
      routes: {
        inspect: candidate.inspectRoute,
        model: candidate.modelRoute,
        review: candidate.reviewRoute ?? null,
        stale: candidate.staleRoute ?? null,
        update: candidate.updateRoute ?? null,
        apply: candidate.consolidation ? `agent_learning_consolidation mode=preview candidateId:"${routeValue(candidate.id)}"` : null,
        merge: candidate.consolidation ? `agent_learning_consolidation mode=merge candidateId:"${routeValue(candidate.id)}"` : null,
        stalePhase: candidate.consolidation ? `agent_learning_consolidation mode=stale candidateId:"${routeValue(candidate.id)}"` : null,
        deletePhase: candidate.consolidation ? `agent_learning_consolidation mode=delete candidateId:"${routeValue(candidate.id)}"` : null,
        create: candidate.createRoute ?? null,
        delete: candidate.deleteRoute ?? null,
      },
      policy: 'Learning curator rows are read-only. VIBE.md personality issues route to existing /vibe inspection/init/import commands. Duplicate consolidation phases use agent_learning_consolidation under current recorded admission; create, review, promote, enable, schedule, and non-batch local effects require current recorded admission on their owning routes.',
    } : {}),
  };
}

function learningConsolidationBatchPlan(
  candidates: readonly LearningCandidate[],
  includeParameters: boolean,
): LearningConsolidationBatchPlan | undefined {
  const consolidationCandidates = candidates.filter((candidate) => candidate.consolidation !== undefined);
  if (consolidationCandidates.length === 0) return undefined;
  const domainCounts = new Map<string, { candidates: number; duplicateRecords: number }>();
  for (const candidate of consolidationCandidates) {
    const duplicateRecords = candidate.consolidation?.duplicateIds.length ?? 0;
    const current = domainCounts.get(candidate.domain) ?? { candidates: 0, duplicateRecords: 0 };
    current.candidates += 1;
    current.duplicateRecords += duplicateRecords;
    domainCounts.set(candidate.domain, current);
  }
  const domains = [...domainCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([domain, counts]) => ({ domain, ...counts }));
  const topCandidates = consolidationCandidates.slice(0, 8).map((candidate) => {
    const consolidation = candidate.consolidation!;
    return {
      candidateId: candidate.id,
      label: candidate.label,
      domain: candidate.domain,
      survivorId: consolidation.survivorId,
      duplicateCount: consolidation.duplicateIds.length,
      ...(includeParameters ? { duplicateIds: consolidation.duplicateIds } : {}),
      diffFields: consolidation.diffs.map((diff) => diff.field),
      detailRoute: `memory action:"candidate" candidateId:"${routeValue(candidate.id)}"`,
      ...(candidate.updateRoute ? { updateRoute: candidate.updateRoute } : {}),
      applyRoute: `agent_learning_consolidation mode=preview candidateId:"${routeValue(candidate.id)}"`,
      mergeRoute: `agent_learning_consolidation mode=merge candidateId:"${routeValue(candidate.id)}"`,
      stalePhaseRoute: `agent_learning_consolidation mode=stale candidateId:"${routeValue(candidate.id)}"`,
      deletePhaseRoute: `agent_learning_consolidation mode=delete candidateId:"${routeValue(candidate.id)}"`,
      ...(candidate.staleRoute ? { staleRoute: candidate.staleRoute } : {}),
      ...(candidate.deleteRoute ? { deleteRoute: candidate.deleteRoute } : {}),
      ...(includeParameters ? {
        staleRoutes: consolidation.staleRoutes,
        deleteRoutes: consolidation.deleteRoutes,
        rollbackRoutes: consolidation.rollbackRoutes,
      } : {}),
    };
  });
  return {
    status: 'ready',
    candidates: consolidationCandidates.length,
    duplicateRecords: consolidationCandidates.reduce((total, candidate) => total + (candidate.consolidation?.duplicateIds.length ?? 0), 0),
    domains,
    routes: {
      reviewQueue: 'memory action:"curator" query:"consolidation" includeParameters:true',
      candidateDetail: 'memory action:"candidate" candidateId:"<candidateId>"',
      survivorRecord: 'agent_local_registry domain:"<domain>" action:"get" id:"<survivorId>"',
    },
    phases: [
      {
        id: 'inspect',
        label: 'Inspect every duplicate group',
        goal: 'Open the candidate detail and survivor/duplicate records before changing durable context.',
        route: 'memory action:"curator" query:"consolidation" includeParameters:true',
      },
      {
        id: 'merge-survivor',
        label: 'Merge visible survivor fields',
        goal: 'Apply the survivor update route only when the visible diffs preserve useful names, descriptions, tags, and triggers.',
        route: 'Use each topCandidates[].mergeRoute under current recorded admission.',
      },
      {
        id: 'stale-duplicates',
        label: 'Stage duplicates as stale',
        goal: 'Mark duplicates stale before deleting them so rollback remains one reviewed route away.',
        route: 'Use each topCandidates[].stalePhaseRoute under current recorded admission.',
      },
      {
        id: 'verify',
        label: 'Verify prompt impact and rollback',
        goal: 'Re-run the curator, check the survivor, and keep rollback routes visible while verifying the result.',
        route: 'memory action:"curator" query:"consolidation" includeParameters:true',
      },
      {
        id: 'delete-after-stale',
        label: 'Delete after verifying the stale phase',
        goal: 'Use delete routes under current recorded admission after verifying that the stale duplicates are no longer needed.',
        route: 'Use each topCandidates[].deletePhaseRoute only after the stale phase has already run.',
      },
    ],
    topCandidates,
    policy: 'This is an ordered review plan. Use agent_learning_consolidation to preview or apply one candidate phase under current recorded admission; low-level Agent-local routes remain visible for inspection and recovery.',
  };
}

function nextActions(candidates: readonly LearningCandidate[]): readonly string[] {
  return candidates
    .filter((candidate) => candidate.status !== 'ready')
    .slice(0, 5)
    .map((candidate) => `${candidate.label}: ${candidate.next}`);
}

function promptPlanCandidate(candidate: LearningCandidate, includeParameters: boolean): Record<string, unknown> {
  return {
    candidateId: candidate.id,
    label: candidate.label,
    domain: candidate.domain,
    status: candidate.status,
    priority: candidate.priority,
    scores: candidate.scores,
    reason: previewHarnessText(candidate.reason, includeParameters ? 160 : 96),
    next: previewHarnessText(candidate.next, includeParameters ? 160 : 96),
    inspectRoute: candidate.inspectRoute,
    ...(candidate.reviewRoute ? { reviewRoute: candidate.reviewRoute } : {}),
    ...(candidate.createRoute ? { createRoute: candidate.createRoute } : {}),
    ...(candidate.updateRoute ? { updateRoute: candidate.updateRoute } : {}),
  };
}

function promptRecordEntry(record: LearningCandidateCollection['promptRecords'][number], includeParameters: boolean): Record<string, unknown> {
  const { domain, item, priority, scores } = record;
  return {
    id: `${domain}:${item.id}`,
    label: item.name,
    domain,
    recordId: item.id,
    priority,
    scores,
    reason: domain === 'memory'
      ? 'High-confidence memory (confidence ≥ 70) is eligible for prompt recall.'
      : domain === 'persona'
        ? 'Active persona is eligible for prompt personality context.'
        : 'Enabled, setup-ready behavior is eligible for prompt context.',
    inspectRoute: localRegistryRoute(domain, 'get', item.id),
    ...(includeParameters ? {
      reviewState: item.reviewState,
      confidence: item.confidence ?? null,
      enabled: item.enabled ?? null,
      active: item.active ?? null,
      missingRequirementCount: missingRequirementCount(item),
      tags: item.tags,
    } : {}),
  };
}

function promptEligibleRecords(collection: LearningCandidateCollection, includeParameters: boolean): readonly Record<string, unknown>[] {
  collection.assertCurrent();
  return collection.promptRecords.map(record => promptRecordEntry(record, includeParameters));
}

function learningPromptPlan(collection: LearningCandidateCollection, candidates: readonly LearningCandidate[], includeParameters: boolean): LearningPromptPlan {
  const promptActiveRecords = promptEligibleRecords(collection, includeParameters);
  const reviewFirstCandidates = candidates.filter((candidate) => (
    candidate.status === 'needs-review'
    || candidate.status === 'low-confidence'
    || candidate.status === 'needs-setup'
    || candidate.status === 'needs-consolidation'
  ));
  const proposalCandidates = candidates.filter((candidate) => candidate.status === 'proposal-ready' || candidate.status === 'ready-to-promote');
  const consolidationCandidates = candidates.filter((candidate) => candidate.status === 'needs-consolidation');
  const suppressed = {
    needsReview: candidates.filter((candidate) => candidate.status === 'needs-review').length,
    needsSetup: candidates.filter((candidate) => candidate.status === 'needs-setup').length,
    lowConfidence: candidates.filter((candidate) => candidate.status === 'low-confidence').length,
    personalityIssues: candidates.filter((candidate) => candidate.domain === 'vibe').length,
    needsConsolidation: consolidationCandidates.length,
  };
  const suppressedCount = Object.values(suppressed).reduce((total, count) => total + count, 0);
  const status = promptActiveRecords.length === 0 && candidates.length === 0
    ? 'empty'
    : suppressedCount > 0 || proposalCandidates.length > 0
      ? 'attention'
      : 'ready';
  return {
    status,
    promptActiveCount: promptActiveRecords.length,
    suppressedCount,
    proposalCount: proposalCandidates.length,
    consolidationCount: consolidationCandidates.length,
    promptActiveRecords: promptActiveRecords.slice(0, includeParameters ? 12 : 5),
    reviewFirst: reviewFirstCandidates.slice(0, includeParameters ? 10 : 5).map((candidate) => promptPlanCandidate(candidate, includeParameters)),
    proposalQueue: proposalCandidates.slice(0, includeParameters ? 10 : 5).map((candidate) => promptPlanCandidate(candidate, includeParameters)),
    consolidationQueue: consolidationCandidates.slice(0, includeParameters ? 8 : 3).map((candidate) => promptPlanCandidate(candidate, includeParameters)),
    suppressed,
    orderingRules: [
      'Prompt context is limited to high-confidence memory (confidence ≥ 70), active personas, and enabled setup-ready behavior.',
      'Current admitted curator readings grade usefulness, freshness, source quality, risk, confidence and priority. Sorting uses the settled priority grade.',
      'Low-confidence, stale, setup-blocked, blocked VIBE.md, and duplicate records stay suppressed until their confidence or enabled/active state is repaired.',
      'Proposals from notes, completed work, completed research, and saved sessions require explicit create or promotion routes before they can guide the assistant.',
    ],
    routes: {
      memoryPosture: 'memory action:"status"',
      curator: 'memory action:"curator" includeParameters:true',
      candidate: 'memory action:"candidate" candidateId:"<candidateId>"',
      consolidation: 'agent_learning_consolidation mode=preview candidateId:"<candidateId>"',
    },
    policy: 'This prompt plan is read-only. It explains what can guide the assistant now, what remains suppressed, and which reviewed route should run before any durable memory, skill, routine, persona, or consolidation change.',
  };
}

export async function learningCuratorCatalogStatus(context: CommandContext, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  const collection = await buildLearningCandidates(context, options); collection.assertCurrent();
  const { candidates } = collection;
  return {
    modes: ['learning_curator', 'learning_candidate'],
    candidates: candidates.length,
    needsReview: candidates.filter((candidate) => candidate.status === 'needs-review').length,
    needsSetup: candidates.filter((candidate) => candidate.status === 'needs-setup').length,
    needsConsolidation: candidates.filter((candidate) => candidate.status === 'needs-consolidation').length,
    lowConfidence: candidates.filter((candidate) => candidate.status === 'low-confidence').length,
    proposedBehavior: candidates.filter((candidate) => candidate.status === 'proposal-ready').length,
    personalityIssues: candidates.filter((candidate) => candidate.domain === 'vibe').length,
    readyToPromote: candidates.filter((candidate) => candidate.status === 'ready-to-promote').length,
    readOnly: true,
  };
}

async function matchingLearningCandidates(collection: LearningCandidateCollection, candidates: readonly LearningCandidate[], query: string) {
  collection.assertCurrent();
  if (!query) return { matches: candidates.map((entry) => ({ entry, judgment: undefined })), judgments: [] };
  const result = await rankHarnessCatalog(candidates, query, (candidate) => ({ id: candidate.id, description: candidateSearchText(candidate), evidence: candidate }),
    'agent.harness.learning-curator', collection.options);
  collection.assertCurrent(); return result;
}

export async function learningCuratorSummary(context: CommandContext, args: AgentHarnessLearningCuratorArgs, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  const includeParameters = args.includeParameters === true;
  const query = readString(args.query);
  const limit = readLimit(args.limit, 100);
  const collection = await buildLearningCandidates(context, options); collection.assertCurrent();
  const all = collection.candidates;
  const selected = await matchingLearningCandidates(collection, all, query);
  collection.assertCurrent();
  const filtered = selected.matches;
  options.signal?.throwIfAborted();
  const consolidationBatch = learningConsolidationBatchPlan(all, includeParameters);
  return {
    summary: {
      candidates: all.length,
      needsReview: all.filter((candidate) => candidate.status === 'needs-review').length,
      needsSetup: all.filter((candidate) => candidate.status === 'needs-setup').length,
      needsConsolidation: all.filter((candidate) => candidate.status === 'needs-consolidation').length,
      lowConfidence: all.filter((candidate) => candidate.status === 'low-confidence').length,
      proposedBehavior: all.filter((candidate) => candidate.status === 'proposal-ready').length,
      personalityIssues: all.filter((candidate) => candidate.domain === 'vibe').length,
      readyToPromote: all.filter((candidate) => candidate.status === 'ready-to-promote').length,
      ready: all.filter((candidate) => candidate.status === 'ready').length,
    },
    promptPlan: learningPromptPlan(collection, all, includeParameters),
    candidates: filtered.slice(0, limit).map(({ entry, judgment }) => ({ ...describeCandidate(entry, includeParameters), ...(judgment ? { judgment } : {}) })),
    judgments: selected.judgments,
    ...(consolidationBatch ? { consolidationBatch } : {}),
    returned: Math.min(filtered.length, limit),
    total: all.length,
    nextActions: nextActions(all),
    policy: 'Learning curator is read-only. Proposed memory and behavior changes use notes, completed work-plan items, completed research runs, saved sessions, VIBE.md personality health cards, duplicate consolidation, and existing owning capture routes; durable context requires provenance, rollback via stale/delete routes, and current recorded admission for writes or promotion.',
  };
}

export type LearningConsolidationCandidateResolution =
  | { readonly status: 'found'; readonly candidate: LearningCandidate }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Pick<LearningCandidate, 'id' | 'label' | 'status' | 'priority'>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

export async function resolveLearningConsolidationCandidate(context: CommandContext, input: string, options: CatalogRankingOptions = {}): Promise<LearningConsolidationCandidateResolution> {
  options.signal?.throwIfAborted();
  const lookup = input.trim();
  if (!lookup) {
    return {
      status: 'missing_lookup',
      usage: 'candidateId or query is required. Use memory action:"curator" query:"consolidation" to inspect candidate ids.',
    };
  }
  const collection = await buildLearningCandidates(context, options); collection.assertCurrent();
  const candidates = collection.candidates.filter((candidate) => candidate.consolidation !== undefined);
  const normalized = lookup.toLowerCase();
  const exact = candidates.find((candidate) => candidate.id === lookup)
    ?? candidates.find((candidate) => candidate.id.toLowerCase() === normalized);
  if (exact) {
    collection.assertCurrent();
    return { status: 'found', candidate: exact };
  }
  const selected = await matchingLearningCandidates(collection, candidates, lookup);
  const matches = selected.matches;
  collection.assertCurrent();
  options.signal?.throwIfAborted();
  if (matches.length === 1 && matches[0]!.judgment?.reading.verdict === 'yes' && matches[0]!.judgment?.reading.outcome === 'act') return { status: 'found', candidate: matches[0]!.entry };
  if (matches.length > 0) {
    return {
      status: 'ambiguous',
      input: lookup,
      candidates: matches.slice(0, 8).map(({ entry: candidate, judgment }) => ({
        judgment,
        id: candidate.id,
        label: candidate.label,
        status: candidate.status,
        priority: candidate.priority,
      })),
    };
  }
  return {
    status: 'missing_lookup',
    usage: `Unknown duplicate-consolidation candidate ${lookup}. Use memory action:"curator" query:"consolidation" to inspect candidate ids.`,
  };
}

export async function describeLearningCandidate(context: CommandContext, args: AgentHarnessLearningCuratorArgs, options: CatalogRankingOptions = {}): Promise<LearningCandidateResolution> {
  options.signal?.throwIfAborted();
  const candidateId = readString(args.candidateId);
  const target = readString(args.target);
  const query = readString(args.query);
  const input = candidateId || target || query;
  if (!input) {
    return {
      status: 'missing_lookup',
      usage: 'memory action:"candidate" requires candidateId, target, or query. Use memory action:"curator" to inspect candidate ids.',
    };
  }
  const normalized = input.toLowerCase();
  const collection = await buildLearningCandidates(context, options); collection.assertCurrent();
  const candidates = collection.candidates;
  const exact = candidates.find((candidate) => candidate.id === input);
  if (exact) return { status: 'found', candidate: describeCandidate(exact, true, { source: candidateId ? 'candidateId' : target ? 'target' : 'query', input, resolvedBy: 'id' }) };
  const insensitive = candidates.find((candidate) => candidate.id.toLowerCase() === normalized);
  if (insensitive) return { status: 'found', candidate: describeCandidate(insensitive, true, { source: candidateId ? 'candidateId' : target ? 'target' : 'query', input, resolvedBy: 'case-insensitive-id' }) };
  const selected = candidateId ? { matches: [], judgments: [] } : await matchingLearningCandidates(collection, candidates, input);
  const matches = selected.matches;
  collection.assertCurrent();
  options.signal?.throwIfAborted();
  if (matches.length === 1 && matches[0]!.judgment?.reading.verdict === 'yes' && matches[0]!.judgment?.reading.outcome === 'act') return { status: 'found', candidate: { ...describeCandidate(matches[0]!.entry, true, { source: target ? 'target' : 'query', input, resolvedBy: 'search' }), judgment: matches[0]!.judgment } };
  if (matches.length > 0) {
    return {
      status: 'ambiguous',
      input,
      candidates: matches.slice(0, 8).map(({ entry: candidate, judgment }) => ({
        judgment,
        candidateId: candidate.id,
        label: candidate.label,
        status: candidate.status,
        priority: candidate.priority,
        modelRoute: candidate.modelRoute,
      })),
    };
  }
  return {
    status: 'missing_lookup',
    usage: `Unknown learning candidate ${input}. Use memory action:"curator" to inspect candidate ids.`,
  };
}
