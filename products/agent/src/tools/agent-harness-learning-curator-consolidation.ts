import type { AgentWorkspaceLocalLibraryItem } from '../input/agent-workspace-types.ts';
import type { LearningCandidateDraft, LearningConsolidationDiff, LearningConsolidationFields, LearningConsolidationPlan, LocalLearningCandidateDomain } from './agent-harness-learning-curator-types.ts';
import { localRegistryRoute, routeList, routeValue } from './agent-harness-learning-curator-common.ts';
import type { CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import type { LearningRecord } from './agent-harness-learning-curator-source.ts';
import { readLearningDuplicatePair, readLearningSurvivor } from './agent-harness-learning-curator-readings.ts';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
const CONSOLIDATION_DOMAINS: readonly LocalLearningCandidateDomain[] = ['memory', 'persona', 'skill', 'routine'];

function uniqueText(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function mergeableDescription(domain: LocalLearningCandidateDomain, item: AgentWorkspaceLocalLibraryItem): string {
  if (domain === 'memory') {
    const fallback = item.scope && item.cls ? `${item.scope}/${item.cls}` : '';
    return item.description === fallback ? '' : item.description;
  }
  return item.description;
}

function updateFieldsForConsolidation(
  _domain: LocalLearningCandidateDomain,
  _survivor: AgentWorkspaceLocalLibraryItem,
  _duplicates: readonly AgentWorkspaceLocalLibraryItem[],
): LearningConsolidationFields | undefined {
  // Same-entity evidence cannot authorize synthesized descriptions or new triggers.
  // Retain the exact selected record and reversible stale markers on duplicates.
  return undefined;
}

function rollbackFieldsForConsolidation(
  domain: LocalLearningCandidateDomain,
  survivor: AgentWorkspaceLocalLibraryItem,
): LearningConsolidationFields {
  const description = mergeableDescription(domain, survivor);
  if (domain === 'memory') {
    return {
      ...(description ? { detail: description } : {}),
      tags: survivor.tags,
    };
  }
  return {
    ...(description ? { description } : {}),
    tags: survivor.tags,
    triggers: survivor.triggers,
  };
}

function consolidationDiff(
  field: string,
  survivor: string,
  duplicateValues: readonly string[],
  merged: string,
): LearningConsolidationDiff | null {
  const duplicates = uniqueText(duplicateValues);
  if (duplicates.length === 0 && !merged) return null;
  const normalizedSurvivor = survivor.trim().toLowerCase();
  const differs = duplicates.some((value) => value.trim().toLowerCase() !== normalizedSurvivor)
    || merged.trim().toLowerCase() !== normalizedSurvivor;
  if (!differs) return null;
  return {
    field,
    survivor: survivor || '(empty)',
    duplicates,
    merged: merged || '(empty)',
  };
}

function consolidationDiffs(
  domain: LocalLearningCandidateDomain,
  survivor: AgentWorkspaceLocalLibraryItem,
  duplicates: readonly AgentWorkspaceLocalLibraryItem[],
): readonly LearningConsolidationDiff[] {
  const tags = survivor.tags.join(', ');
  const triggers = survivor.triggers.join(', ');
  return [
    consolidationDiff('name', survivor.name, duplicates.map((item) => item.name), survivor.name),
    consolidationDiff('description', mergeableDescription(domain, survivor), duplicates.map((item) => mergeableDescription(domain, item)), mergeableDescription(domain, survivor)),
    consolidationDiff('tags', survivor.tags.join(', '), duplicates.map((item) => item.tags.join(', ')), tags),
    domain === 'memory' ? null : consolidationDiff('triggers', survivor.triggers.join(', '), duplicates.map((item) => item.triggers.join(', ')), triggers),
  ].filter((diff): diff is LearningConsolidationDiff => diff !== null);
}

function updateRouteForConsolidation(
  domain: LocalLearningCandidateDomain,
  survivor: AgentWorkspaceLocalLibraryItem,
  duplicates: readonly AgentWorkspaceLocalLibraryItem[],
): string | undefined {
  const updateFields = updateFieldsForConsolidation(domain, survivor, duplicates);
  if (!updateFields) return undefined;
  const fields: string[] = [];
  if (domain === 'memory') {
    if (updateFields.detail) fields.push(`detail:"${routeValue(updateFields.detail)}"`);
    if (updateFields.tags && updateFields.tags.length > 0) fields.push(`tags:${routeList(updateFields.tags)}`);
  } else {
    if (updateFields.description) fields.push(`description:"${routeValue(updateFields.description)}"`);
    if (updateFields.tags && updateFields.tags.length > 0) fields.push(`tags:${routeList(updateFields.tags)}`);
    if (updateFields.triggers && updateFields.triggers.length > 0) fields.push(`triggers:${routeList(updateFields.triggers)}`);
  }
  if (fields.length === 0) return undefined;
  return [
    localRegistryRoute(domain, 'update', survivor.id),
    ...fields,
    'provenance:"learning-curator-consolidation"',
  ].join(' ');
}

function rollbackUpdateRouteForConsolidation(domain: LocalLearningCandidateDomain, survivor: AgentWorkspaceLocalLibraryItem): string {
  const rollbackFields = rollbackFieldsForConsolidation(domain, survivor);
  const fields: string[] = [];
  if (domain === 'memory') {
    if (rollbackFields.detail) fields.push(`detail:"${routeValue(rollbackFields.detail)}"`);
    fields.push(`tags:${routeList(rollbackFields.tags ?? [])}`);
  } else {
    if (rollbackFields.description) fields.push(`description:"${routeValue(rollbackFields.description)}"`);
    fields.push(`tags:${routeList(rollbackFields.tags ?? [])}`);
    fields.push(`triggers:${routeList(rollbackFields.triggers ?? [])}`);
  }
  return [
    localRegistryRoute(domain, 'update', survivor.id),
    ...fields,
    'provenance:"rollback-learning-curator-consolidation"',
  ].join(' ');
}

function consolidationProposalFields(plan: LearningConsolidationPlan): Readonly<Record<string, string>> {
  return {
    survivorId: plan.survivorId,
    duplicateIds: plan.duplicateIds.join(','),
    visibleDiff: plan.diffs.length > 0
      ? plan.diffs.map((diff) => `${diff.field}: retain [${diff.survivor}]; duplicates [${diff.duplicates.join("; ")}]`).join('\n')
      : 'Visible metadata matches; inspect record bodies before marking duplicates stale.',
    staleFirst: plan.staleRoutes.join('\n'),
    rollback: plan.rollbackRoutes.join('\n'),
  };
}

function consolidationCandidate(
  domain: LocalLearningCandidateDomain,
  key: string,
  items: readonly AgentWorkspaceLocalLibraryItem[],
  survivor: AgentWorkspaceLocalLibraryItem,
): LearningCandidateDraft | null {
  if (items.length < 2) return null;
  const duplicates = items.filter((item) => item.id !== survivor.id);
  if (duplicates.length === 0) return null;
  const updateRoute = updateRouteForConsolidation(domain, survivor, duplicates);
  const updateFields = updateFieldsForConsolidation(domain, survivor, duplicates);
  const rollbackFields = rollbackFieldsForConsolidation(domain, survivor);
  const staleRoutes = duplicates.map((item) => `${localRegistryRoute(domain, 'stale', item.id)} reason:"Duplicate of ${routeValue(survivor.id)}; staged by learning curator consolidation."`);
  const deleteRoutes = duplicates.map((item) => `${localRegistryRoute(domain, 'delete', item.id)}`);
  const rollbackRoutes = [
    ...(updateRoute ? [rollbackUpdateRouteForConsolidation(domain, survivor)] : []),
    ...duplicates.map((item) => localRegistryRoute(domain, 'review', item.id)),
  ];
  const diffs = consolidationDiffs(domain, survivor, duplicates);
  const plan: LearningConsolidationPlan = {
    survivorId: survivor.id,
    duplicateIds: duplicates.map((item) => item.id),
    sharedKey: key,
    diffs,
    ...(updateFields ? { updateFields } : {}),
    rollbackFields,
    ...(updateRoute ? { updateRoute } : {}),
    staleRoutes,
    deleteRoutes,
    rollbackRoutes,
  };
  return {
    id: `consolidation:${domain}:${encodeURIComponent(key)}`,
    label: `Consolidate duplicate ${domain}: ${survivor.name}`,
    domain,
    recordId: survivor.id,
    status: 'needs-consolidation',
    reason: `${items.length} Agent-local ${domain} records have settled same-entity pair readings.`,
    next: 'Keep the selected record unchanged and mark settled duplicates stale, retaining their complete originals.',
    reviewState: survivor.reviewState,
    ...(survivor.enabled === undefined ? {} : { enabled: survivor.enabled }),
    ...(survivor.active === undefined ? {} : { active: survivor.active }),
    ...(survivor.confidence === undefined ? {} : { confidence: survivor.confidence }),
    proposalFields: consolidationProposalFields(plan),
    consolidation: plan,
    inspectRoute: localRegistryRoute(domain, 'get', survivor.id),
    modelRoute: 'memory action:"curator" query:"consolidation"',
    reviewRoute: localRegistryRoute(domain, 'review', survivor.id),
    ...(staleRoutes[0] ? { staleRoute: staleRoutes[0] } : {}),
    ...(updateRoute ? { updateRoute } : {}),
    ...(deleteRoutes[0] ? { deleteRoute: deleteRoutes[0] } : {}),
    cleanupRoutes: staleRoutes,
    rollbackRoutes,
  };
}

export async function consolidationCandidatesForDomain(
  domain: LocalLearningCandidateDomain,
  records: readonly LearningRecord[],
  options: CatalogRankingOptions,
  context?: unknown,
): Promise<readonly LearningCandidateDraft[]> {
  if (!CONSOLIDATION_DOMAINS.includes(domain) || records.length < 2) return [];
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const edges = records.map(() => new Set<number>());
  // Every same-domain pair is read. Name normalization cannot shortlist durable records.
  for (let left = 0; left < records.length; left++) {
    for (let right = left + 1; right < records.length; right++) {
      const a = records[left], b = records[right];
      if (!a || !b) throw new ToolInputProjectionError('held');
      const same = await readLearningDuplicatePair({ left: { domain, ...a }, right: { domain, ...b } }, options);
      options.signal?.throwIfAborted(); options.assertCurrent?.();
      if (same) { edges[left]?.add(right); edges[right]?.add(left); }
    }
  }
  const visited = new Set<number>();
  const result: LearningCandidateDraft[] = [];
  for (let first = 0; first < records.length; first++) {
    if (visited.has(first)) continue;
    const indexes = [first]; visited.add(first);
    for (let cursor = 0; cursor < indexes.length; cursor++) {
      const current = indexes[cursor];
      if (current === undefined) throw new ToolInputProjectionError('held');
      for (const neighbor of edges[current] ?? []) if (!visited.has(neighbor)) { visited.add(neighbor); indexes.push(neighbor); }
    }
    if (indexes.length < 2) continue;
    // Alignment is not assumed transitive. Every proposed group must be a complete same-entity clique.
    for (const left of indexes) for (const right of indexes)
      if (left !== right && !edges[left]?.has(right)) throw new ToolInputProjectionError('held');
    const group = indexes.map(index => {
      const record = records[index]; if (!record) throw new ToolInputProjectionError('held'); return record;
    }).sort((left, right) => left.item.id.localeCompare(right.item.id));
    const selected = await readLearningSurvivor({ domain, records: group, context }, options);
    options.signal?.throwIfAborted(); options.assertCurrent?.();
    const survivor = group[selected]; if (!survivor) throw new ToolInputProjectionError('held');
    const key = JSON.stringify(group.map(record => record.item.id));
    const candidate = consolidationCandidate(domain, key, group.map(record => record.item), survivor.item);
    if (candidate) result.push(candidate);
  }
  options.signal?.throwIfAborted(); options.assertCurrent?.(); return result;
}
