import type { AgentWorkspaceLocalLibraryItem } from '../input/agent-workspace-types.ts';
import type { LearningCandidate, LearningCandidateStatus, LearningScores, LocalLearningCandidateDomain } from './agent-harness-learning-curator-types.ts';
export function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function isReviewed(item: AgentWorkspaceLocalLibraryItem): boolean {
  return item.reviewState === 'reviewed';
}

export function missingRequirementCount(item: AgentWorkspaceLocalLibraryItem): number {
  return item.missingRequirementCount ?? 0;
}

export function itemUsefulness(item: AgentWorkspaceLocalLibraryItem): number {
  const triggerSignal = Math.min(20, item.triggers.length * 5);
  const tagSignal = Math.min(10, item.tags.length * 2);
  const usageSignal = (item.enabled ? 15 : 0) + (item.active ? 15 : 0) + Math.min(20, (item.startCount ?? 0) * 4);
  const confidenceSignal = item.confidence === undefined ? 10 : Math.max(0, Math.min(20, item.confidence / 5));
  return clampScore(35 + triggerSignal + tagSignal + usageSignal + confidenceSignal);
}

export function itemFreshness(item: AgentWorkspaceLocalLibraryItem): number {
  if (item.reviewState === 'stale') return 15;
  if (item.reviewState === 'fresh') return 55;
  return missingRequirementCount(item) > 0 ? 70 : 92;
}

export function itemSourceQuality(item: AgentWorkspaceLocalLibraryItem): number {
  const source = item.source.toLowerCase();
  const base = source.includes('workspace') || source.includes('import') ? 72 : source.includes('agent') ? 68 : 60;
  return clampScore(base + (isReviewed(item) ? 12 : 0) + Math.min(12, item.tags.length * 2));
}

export function itemRisk(item: AgentWorkspaceLocalLibraryItem): number {
  const reviewRisk = item.reviewState === 'stale' ? 60 : item.reviewState === 'fresh' ? 35 : 10;
  const injectionRisk = item.enabled || item.active ? 20 : 0;
  const setupRisk = Math.min(30, missingRequirementCount(item) * 10);
  const confidenceRisk = item.confidence === undefined ? 0 : Math.max(0, 70 - item.confidence);
  return clampScore(reviewRisk + injectionRisk + setupRisk + confidenceRisk);
}

export function scoresForItem(item: AgentWorkspaceLocalLibraryItem): LearningScores {
  return {
    usefulness: itemUsefulness(item),
    freshness: itemFreshness(item),
    sourceQuality: itemSourceQuality(item),
    risk: itemRisk(item),
  };
}

export function routeDomain(domain: LocalLearningCandidateDomain): string {
  return domain;
}

export function localRegistryRoute(domain: LocalLearningCandidateDomain, action: string, id: string): string {
  return `agent_local_registry domain:"${routeDomain(domain)}" action:"${action}" id:"${id}"`;
}

export function localRegistryModelRoute(domain: LocalLearningCandidateDomain): string {
  return `agent_local_registry domain:"${routeDomain(domain)}" action:"get"`;
}

export function routeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function routeList(values: readonly string[]): string {
  return `[${values.map((value) => `"${routeValue(value)}"`).join(',')}]`;
}

export function candidateBase(
  domain: LocalLearningCandidateDomain,
  item: AgentWorkspaceLocalLibraryItem,
  status: LearningCandidateStatus,
  priority: number,
  reason: string,
  next: string,
): LearningCandidate {
  const missingRequirements = item.missingRequirements ?? [];
  return {
    id: `${domain}:${item.id}:${status}`,
    label: item.name,
    domain,
    recordId: item.id,
    status,
    priority: clampScore(priority),
    reason,
    next,
    scores: scoresForItem(item),
    reviewState: item.reviewState,
    ...(item.enabled === undefined ? {} : { enabled: item.enabled }),
    ...(item.active === undefined ? {} : { active: item.active }),
    ...(item.confidence === undefined ? {} : { confidence: item.confidence }),
    ...(missingRequirements.length === 0 ? {} : { missingRequirements }),
    inspectRoute: localRegistryRoute(domain, 'get', item.id),
    modelRoute: localRegistryModelRoute(domain),
    reviewRoute: localRegistryRoute(domain, 'review', item.id),
    staleRoute: `${localRegistryRoute(domain, 'stale', item.id)} reason:"..."`,
    deleteRoute: `${localRegistryRoute(domain, 'delete', item.id)} confirm:true explicitUserRequest:"..."`,
  };
}
