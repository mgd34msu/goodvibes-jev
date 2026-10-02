import type { AgentWorkspaceLocalLibraryItem } from '../input/agent-workspace-types.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import type { LearningCandidate, LearningConsolidationDiff, LearningConsolidationFields, LearningConsolidationPlan, LocalLearningCandidateDomain } from './agent-harness-learning-curator-types.ts';
import { clampScore, isReviewed, itemFreshness, itemSourceQuality, localRegistryModelRoute, localRegistryRoute, routeList, routeValue, scoresForItem } from './agent-harness-learning-curator-common.ts';
const CONSOLIDATION_DOMAINS: readonly LocalLearningCandidateDomain[] = ['memory', 'persona', 'skill', 'routine'];

function normalizeDuplicateKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function duplicateKeySlug(value: string): string {
  return normalizeDuplicateKey(value).replace(/\s+/g, '-').slice(0, 52) || 'duplicate';
}

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

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function itemConsolidationScore(item: AgentWorkspaceLocalLibraryItem): number {
  const scores = scoresForItem(item);
  const reviewSignal = isReviewed(item) ? 26 : item.reviewState === 'fresh' ? 10 : 0;
  const usageSignal = (item.enabled ? 12 : 0) + (item.active ? 16 : 0) + Math.min(12, (item.startCount ?? 0) * 3);
  const confidenceSignal = item.confidence === undefined ? 0 : item.confidence / 4;
  return scores.usefulness + scores.freshness + scores.sourceQuality - scores.risk + reviewSignal + usageSignal + confidenceSignal;
}

function chooseConsolidationSurvivor(items: readonly AgentWorkspaceLocalLibraryItem[]): AgentWorkspaceLocalLibraryItem {
  return [...items].sort((left, right) => {
    const byScore = itemConsolidationScore(right) - itemConsolidationScore(left);
    if (byScore !== 0) return byScore;
    const byReview = (isReviewed(right) ? 1 : 0) - (isReviewed(left) ? 1 : 0);
    if (byReview !== 0) return byReview;
    return left.id.localeCompare(right.id);
  })[0]!;
}

function mergeableDescription(domain: LocalLearningCandidateDomain, item: AgentWorkspaceLocalLibraryItem): string {
  if (domain === 'memory') {
    const fallback = item.scope && item.cls ? `${item.scope}/${item.cls}` : '';
    return item.description === fallback ? '' : item.description;
  }
  return item.description;
}

function mergedDescription(
  domain: LocalLearningCandidateDomain,
  survivor: AgentWorkspaceLocalLibraryItem,
  duplicates: readonly AgentWorkspaceLocalLibraryItem[],
): string {
  const descriptions = uniqueText([survivor, ...duplicates].map((item) => mergeableDescription(domain, item)));
  if (descriptions.length === 0) return '';
  return previewHarnessText(descriptions.join('\n\n'), 900);
}

function mergedTags(items: readonly AgentWorkspaceLocalLibraryItem[]): readonly string[] {
  return uniqueSorted(items.flatMap((item) => item.tags));
}

function mergedTriggers(items: readonly AgentWorkspaceLocalLibraryItem[]): readonly string[] {
  return uniqueSorted(items.flatMap((item) => item.triggers));
}

function updateFieldsForConsolidation(
  domain: LocalLearningCandidateDomain,
  survivor: AgentWorkspaceLocalLibraryItem,
  duplicates: readonly AgentWorkspaceLocalLibraryItem[],
): LearningConsolidationFields | undefined {
  const all = [survivor, ...duplicates];
  const tags = mergedTags(all);
  const triggers = mergedTriggers(all);
  const description = mergedDescription(domain, survivor, duplicates);
  if (domain === 'memory') {
    const fields: LearningConsolidationFields = {
      ...(description ? { detail: description } : {}),
      ...(tags.length > 0 ? { tags } : {}),
    };
    return Object.keys(fields).length > 0 ? fields : undefined;
  }
  const fields: LearningConsolidationFields = {
    ...(description ? { description } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(triggers.length > 0 ? { triggers } : {}),
  };
  return Object.keys(fields).length > 0 ? fields : undefined;
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
  const all = [survivor, ...duplicates];
  const tags = mergedTags(all).join(', ');
  const triggers = mergedTriggers(all).join(', ');
  return [
    consolidationDiff('name', survivor.name, duplicates.map((item) => item.name), survivor.name),
    consolidationDiff('description', mergeableDescription(domain, survivor), duplicates.map((item) => mergeableDescription(domain, item)), mergedDescription(domain, survivor, duplicates)),
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
      ? plan.diffs.map((diff) => `${diff.field}: keep [${diff.survivor}], merge [${diff.merged}]`).join('\n')
      : 'Visible metadata matches; inspect record bodies before marking duplicates stale.',
    staleFirst: plan.staleRoutes.join('\n'),
    rollback: plan.rollbackRoutes.join('\n'),
  };
}

function consolidationCandidate(
  domain: LocalLearningCandidateDomain,
  key: string,
  items: readonly AgentWorkspaceLocalLibraryItem[],
): LearningCandidate | null {
  if (items.length < 2) return null;
  const survivor = chooseConsolidationSurvivor(items);
  const duplicates = items.filter((item) => item.id !== survivor.id);
  if (duplicates.length === 0) return null;
  const updateRoute = updateRouteForConsolidation(domain, survivor, duplicates);
  const updateFields = updateFieldsForConsolidation(domain, survivor, duplicates);
  const rollbackFields = rollbackFieldsForConsolidation(domain, survivor);
  const staleRoutes = duplicates.map((item) => `${localRegistryRoute(domain, 'stale', item.id)} reason:"Duplicate of ${routeValue(survivor.id)}; staged by learning curator consolidation."`);
  const deleteRoutes = duplicates.map((item) => `${localRegistryRoute(domain, 'delete', item.id)} confirm:true explicitUserRequest:"Delete duplicate ${routeValue(domain)} ${routeValue(item.id)} after reviewed consolidation."`);
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
  const enabledDuplicateCount = duplicates.filter((item) => item.enabled || item.active).length;
  return {
    id: `consolidation:${domain}:${duplicateKeySlug(key)}`,
    label: `Consolidate duplicate ${domain}: ${survivor.name}`,
    domain,
    recordId: survivor.id,
    status: 'needs-consolidation',
    priority: clampScore(72 + Math.min(16, duplicates.length * 4) + enabledDuplicateCount * 5),
    reason: `${items.length} Agent-local ${domain} records share the same normalized name.`,
    next: 'Inspect every record, update the survivor with merged visible fields, mark duplicates stale first, then delete only after explicit review.',
    scores: {
      usefulness: clampScore(64 + Math.min(18, items.length * 4)),
      freshness: Math.max(...items.map(itemFreshness)),
      sourceQuality: Math.max(...items.map(itemSourceQuality)),
      risk: clampScore(34 + enabledDuplicateCount * 12 + Math.min(18, duplicates.length * 4)),
    },
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

export function consolidationCandidatesForDomain(
  domain: LocalLearningCandidateDomain,
  items: readonly AgentWorkspaceLocalLibraryItem[],
): readonly LearningCandidate[] {
  if (!CONSOLIDATION_DOMAINS.includes(domain)) return [];
  const groups = new Map<string, AgentWorkspaceLocalLibraryItem[]>();
  for (const item of items) {
    const key = normalizeDuplicateKey(item.name);
    if (key.length < 4) continue;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return [...groups.entries()].flatMap(([key, group]) => {
    const candidate = consolidationCandidate(domain, key, group);
    return candidate ? [candidate] : [];
  });
}
