import type { KnowledgeStore } from '../store.js';
import type { KnowledgeNodeRecord } from '../types.js';
import { isTerminalRefinementState } from '../store-lifecycle-authority.js';

/** Capture before yielding; a review/reopen of the same id is a new decision. */
export function captureGapRepairLifecycle(store: KnowledgeStore, gap: KnowledgeNodeRecord): (taskId: string) => boolean {
  const snapshot = gapLifecycle(gap);
  const issues = store.listIssues(Number.MAX_SAFE_INTEGER).filter((issue) => issue.nodeId === gap.id);
  const decisions = new Map(issues.map((issue) => [issue.id, issueDecision(issue)]));
  const resolved = issues.some((issue) => issue.status === 'resolved');
  return (taskId) => {
    const task = store.getRefinementTask(taskId);
    if (!task || isTerminalRefinementState(task.state) || resolved) return true;
    if (gapLifecycle(store.getNode(gap.id)) !== snapshot) return true;
    const currentIssues = store.listIssues(Number.MAX_SAFE_INTEGER).filter((issue) => issue.nodeId === gap.id);
    return currentIssues.some((issue) => issue.status === 'resolved'
      || (decisions.has(issue.id) && decisions.get(issue.id) !== issueDecision(issue)))
      || issues.some((issue) => !store.getIssue(issue.id));
  };
}

function issueDecision(issue: { readonly status: string; readonly metadata: Record<string, unknown> }): string {
  return JSON.stringify([issue.status, issue.metadata.review, issue.metadata.issueLifecycle]);
}

/** Idempotent producer refreshes do not cancel work merely by changing updatedAt. */
function gapLifecycle(gap: KnowledgeNodeRecord | null): string {
  if (!gap) return 'missing';
  const metadata = gap.metadata;
  return JSON.stringify({
    kind: gap.kind, slug: gap.slug, title: gap.title, summary: gap.summary, status: gap.status,
    sourceId: gap.sourceId, aliases: [...gap.aliases].sort(),
    gapKind: metadata.gapKind, query: metadata.query, subject: metadata.subject,
    subjectFingerprint: metadata.subjectFingerprint, knowledgeSpaceId: metadata.knowledgeSpaceId,
    sourceIds: sortedStrings(metadata.sourceIds), linkedObjectIds: sortedStrings(metadata.linkedObjectIds),
    repairStatus: metadata.repairStatus, review: metadata.review,
  });
}
function sortedStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').sort() : [];
}
