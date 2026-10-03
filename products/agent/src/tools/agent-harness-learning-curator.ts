import type { CommandContext } from '../input/command-registry.ts';
import { buildAgentWorkspaceRuntimeSnapshot } from '../input/agent-workspace-snapshot.ts';
import type { AgentWorkspaceLocalLibraryItem } from '../input/agent-workspace-types.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import { buildLearningCandidates, candidateSearchText } from './agent-harness-learning-curator-proposals.ts';
import { clampScore, localRegistryRoute, missingRequirementCount, routeValue, scoresForItem } from './agent-harness-learning-curator-common.ts';
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
        merge: candidate.consolidation ? `agent_learning_consolidation mode=merge candidateId:"${routeValue(candidate.id)}" confirm:true explicitUserRequest:"..."` : null,
        stalePhase: candidate.consolidation ? `agent_learning_consolidation mode=stale candidateId:"${routeValue(candidate.id)}" confirm:true explicitUserRequest:"..."` : null,
        deletePhase: candidate.consolidation ? `agent_learning_consolidation mode=delete candidateId:"${routeValue(candidate.id)}" confirm:true explicitUserRequest:"..."` : null,
        create: candidate.createRoute ?? null,
        delete: candidate.deleteRoute ?? null,
      },
      policy: 'Learning curator rows are read-only. VIBE.md personality issues route to existing /vibe inspection/init/import commands. Duplicate consolidation phases use agent_learning_consolidation with confirmation, while create, review, promote, enable, schedule, and non-batch local effects stay on existing confirmed routes.',
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
      mergeRoute: `agent_learning_consolidation mode=merge candidateId:"${routeValue(candidate.id)}" confirm:true explicitUserRequest:"..."`,
      stalePhaseRoute: `agent_learning_consolidation mode=stale candidateId:"${routeValue(candidate.id)}" confirm:true explicitUserRequest:"..."`,
      deletePhaseRoute: `agent_learning_consolidation mode=delete candidateId:"${routeValue(candidate.id)}" confirm:true explicitUserRequest:"..."`,
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
        route: 'Use each topCandidates[].mergeRoute after explicit approval.',
      },
      {
        id: 'stale-duplicates',
        label: 'Stage duplicates as stale',
        goal: 'Mark duplicates stale before deleting them so rollback remains one reviewed route away.',
        route: 'Use each topCandidates[].stalePhaseRoute after explicit approval.',
      },
      {
        id: 'verify',
        label: 'Verify prompt impact and rollback',
        goal: 'Re-run the curator, check the survivor, and keep rollback routes visible until the user accepts the result.',
        route: 'memory action:"curator" query:"consolidation" includeParameters:true',
      },
      {
        id: 'delete-after-approval',
        label: 'Delete only after explicit approval',
        goal: 'Use delete routes only after the user confirms the stale duplicates are no longer needed.',
        route: 'Use each topCandidates[].deletePhaseRoute only after the stale phase has already run.',
      },
    ],
    topCandidates,
    policy: 'This is an ordered review plan. Use agent_learning_consolidation to preview or apply one confirmed candidate phase; low-level Agent-local routes remain visible for inspection and recovery.',
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

function promptRecordPriority(item: AgentWorkspaceLocalLibraryItem): number {
  const scores = scoresForItem(item);
  return clampScore((scores.usefulness * 0.35) + (scores.freshness * 0.25) + (scores.sourceQuality * 0.30) - (scores.risk * 0.25));
}

function isPromptEligibleRecord(domain: LocalLearningCandidateDomain, item: AgentWorkspaceLocalLibraryItem): boolean {
  // Fully autonomous learning: review gate removed, records qualify without human review.
  if (domain === 'memory') return (item.confidence ?? 100) >= 70;
  if (domain === 'persona') return item.active === true;
  if (domain === 'skill' || domain === 'skill_bundle' || domain === 'routine') {
    return item.enabled === true && missingRequirementCount(item) === 0;
  }
  return false;
}

function promptRecordEntry(domain: LocalLearningCandidateDomain, item: AgentWorkspaceLocalLibraryItem, includeParameters: boolean): Record<string, unknown> {
  return {
    id: `${domain}:${item.id}`,
    label: item.name,
    domain,
    recordId: item.id,
    priority: promptRecordPriority(item),
    scores: scoresForItem(item),
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

function promptEligibleRecords(context: CommandContext, includeParameters: boolean): readonly Record<string, unknown>[] {
  const snapshot = buildAgentWorkspaceRuntimeSnapshot(context);
  const records = [
    ...snapshot.localMemories
      .filter((item) => isPromptEligibleRecord('memory', item))
      .map((item) => promptRecordEntry('memory', item, includeParameters)),
    ...snapshot.localPersonas
      .filter((item) => isPromptEligibleRecord('persona', item))
      .map((item) => promptRecordEntry('persona', item, includeParameters)),
    ...snapshot.localSkills
      .filter((item) => isPromptEligibleRecord('skill', item))
      .map((item) => promptRecordEntry('skill', item, includeParameters)),
    ...snapshot.localSkillBundles
      .filter((item) => isPromptEligibleRecord('skill_bundle', item))
      .map((item) => promptRecordEntry('skill_bundle', item, includeParameters)),
    ...snapshot.localRoutines
      .filter((item) => isPromptEligibleRecord('routine', item))
      .map((item) => promptRecordEntry('routine', item, includeParameters)),
  ];
  return records.sort((left, right) => {
    const leftPriority = typeof left.priority === 'number' ? left.priority : 0;
    const rightPriority = typeof right.priority === 'number' ? right.priority : 0;
    if (rightPriority !== leftPriority) return rightPriority - leftPriority;
    return String(left.label ?? '').localeCompare(String(right.label ?? ''));
  });
}

function learningPromptPlan(context: CommandContext, candidates: readonly LearningCandidate[], includeParameters: boolean): LearningPromptPlan {
  const promptActiveRecords = promptEligibleRecords(context, includeParameters);
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
      'Usefulness, freshness, source-quality, and risk scores drive promotion priority and determine which records guide the assistant.',
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

export function learningCuratorCatalogStatus(context: CommandContext): Record<string, unknown> {
  const candidates = buildLearningCandidates(context);
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

export function learningCuratorSummary(context: CommandContext, args: AgentHarnessLearningCuratorArgs): Record<string, unknown> {
  const includeParameters = args.includeParameters === true;
  const query = readString(args.query).toLowerCase();
  const limit = readLimit(args.limit, 100);
  const all = buildLearningCandidates(context);
  const filtered = all.filter((candidate) => !query || candidateSearchText(candidate).includes(query));
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
    promptPlan: learningPromptPlan(context, all, includeParameters),
    candidates: filtered.slice(0, limit).map((candidate) => describeCandidate(candidate, includeParameters)),
    ...(consolidationBatch ? { consolidationBatch } : {}),
    returned: Math.min(filtered.length, limit),
    total: all.length,
    nextActions: nextActions(all),
    policy: 'Learning curator is read-only. Proposed memory and behavior changes use notes, completed work-plan items, completed research runs, saved sessions, VIBE.md personality health cards, duplicate consolidation, and existing confirmed capture routes; durable context still requires provenance, rollback via stale/delete routes, and explicit user intent for writes or promotion.',
  };
}

export type LearningConsolidationCandidateResolution =
  | { readonly status: 'found'; readonly candidate: LearningCandidate }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Pick<LearningCandidate, 'id' | 'label' | 'status' | 'priority'>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

export function resolveLearningConsolidationCandidate(context: CommandContext, input: string): LearningConsolidationCandidateResolution {
  const lookup = input.trim();
  if (!lookup) {
    return {
      status: 'missing_lookup',
      usage: 'candidateId or query is required. Use memory action:"curator" query:"consolidation" to inspect candidate ids.',
    };
  }
  const candidates = buildLearningCandidates(context).filter((candidate) => candidate.consolidation !== undefined);
  const normalized = lookup.toLowerCase();
  const exact = candidates.find((candidate) => candidate.id === lookup)
    ?? candidates.find((candidate) => candidate.id.toLowerCase() === normalized);
  if (exact) return { status: 'found', candidate: exact };
  const matches = candidates.filter((candidate) => candidateSearchText(candidate).includes(normalized));
  if (matches.length === 1) return { status: 'found', candidate: matches[0]! };
  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      input: lookup,
      candidates: matches.slice(0, 8).map((candidate) => ({
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

export function describeLearningCandidate(context: CommandContext, args: AgentHarnessLearningCuratorArgs): LearningCandidateResolution {
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
  const candidates = buildLearningCandidates(context);
  const exact = candidates.find((candidate) => candidate.id === input);
  if (exact) return { status: 'found', candidate: describeCandidate(exact, true, { source: candidateId ? 'candidateId' : target ? 'target' : 'query', input, resolvedBy: 'id' }) };
  const insensitive = candidates.find((candidate) => candidate.id.toLowerCase() === normalized);
  if (insensitive) return { status: 'found', candidate: describeCandidate(insensitive, true, { source: candidateId ? 'candidateId' : target ? 'target' : 'query', input, resolvedBy: 'case-insensitive-id' }) };
  const matches = candidates.filter((candidate) => candidateSearchText(candidate).includes(normalized));
  if (matches.length === 1) return { status: 'found', candidate: describeCandidate(matches[0]!, true, { source: candidateId ? 'candidateId' : target ? 'target' : 'query', input, resolvedBy: 'search' }) };
  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      input,
      candidates: matches.slice(0, 8).map((candidate) => ({
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
