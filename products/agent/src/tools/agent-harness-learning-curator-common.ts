import type { AgentWorkspaceLocalLibraryItem } from '../input/agent-workspace-types.ts';
import type { LearningCandidateDraft, LearningCandidateStatus, LocalLearningCandidateDomain } from './agent-harness-learning-curator-types.ts';
export function isReviewed(item: AgentWorkspaceLocalLibraryItem): boolean {
  return item.reviewState === 'reviewed';
}

export function missingRequirementCount(item: AgentWorkspaceLocalLibraryItem): number {
  return item.missingRequirementCount ?? 0;
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
  reason: string,
  next: string,
): LearningCandidateDraft {
  const missingRequirements = item.missingRequirements ?? [];
  return {
    id: `${domain}:${item.id}:${status}`,
    label: item.name,
    domain,
    recordId: item.id,
    status,
    reason,
    next,
    reviewState: item.reviewState,
    ...(item.enabled === undefined ? {} : { enabled: item.enabled }),
    ...(item.active === undefined ? {} : { active: item.active }),
    ...(item.confidence === undefined ? {} : { confidence: item.confidence }),
    ...(missingRequirements.length === 0 ? {} : { missingRequirements }),
    inspectRoute: localRegistryRoute(domain, 'get', item.id),
    modelRoute: localRegistryModelRoute(domain),
    reviewRoute: localRegistryRoute(domain, 'review', item.id),
    staleRoute: `${localRegistryRoute(domain, 'stale', item.id)} reason:"..."`,
    deleteRoute: `${localRegistryRoute(domain, 'delete', item.id)}`,
  };
}
