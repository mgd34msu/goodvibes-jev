import { hasKnowledgeNodeOperatorReview } from '../../store-node-authority.js';
import { isTerminalRefinementState } from '../../store-lifecycle-authority.js';
import { prepareObservedKnowledgeNodeInput } from '../../store-node-observation.js';
import type { KnowledgeStore } from '../../store.js';
import type { KnowledgeEdgeUpsertInput, KnowledgeIssueRecord, KnowledgeNodeRecord, KnowledgeRefinementTaskRecord, KnowledgeSourceRecord } from '../../types.js';
import { semanticMetadata, readRecord, readString } from '../utils.js';
import { snapshotNodeInput } from '../../activation/projection.js';
import { KnowledgeAnswerGapHeldError as Held } from './types.js';
import { exactReferences, exactIds, originalText } from './references.js';

function closedNode(node: KnowledgeNodeRecord): boolean {
  return node.status !== 'active' || ['repaired', 'rejected', 'cancelled', 'closed', 'suppressed', 'not_applicable'].includes(readString(node.metadata.repairStatus) ?? '');
}
function reviewedIssue(issue: KnowledgeIssueRecord): boolean {
  return issue.status === 'resolved' || typeof readRecord(issue.metadata.review).action === 'string' || issue.metadata.suppression !== undefined;
}
// The existing recovery/status lifecycle includes queued work as active, while
// detected/blocked/failed tasks remain retryable. This never grants repair work.
const ACTIVE_REPAIR_STATES = new Set<KnowledgeRefinementTaskRecord['state']>(['queued', 'searching', 'evaluating', 'extracting', 'applying']);
export function isActionableAnswerGap(store: KnowledgeStore, node: KnowledgeNodeRecord): boolean {
  if (closedNode(node) || hasKnowledgeNodeOperatorReview(node)) return false;
  const issues = store.listIssues(Number.MAX_SAFE_INTEGER).filter((issue) => issue.nodeId === node.id);
  if (issues.some((issue) => issue.status === 'resolved' || (reviewedIssue(issue) && readRecord(issue.metadata.review).action !== 'reopen'))) return false;
  // A trusted explicit reopen supersedes only terminal tasks that demonstrably
  // preceded it. Equal timestamps or missing lifecycle evidence stay closed.
  const reopened = issues.filter((issue) => issue.code === 'knowledge.answer_gap' && issue.status === 'open'
    && readRecord(issue.metadata.review).action === 'reopen' && typeof readRecord(issue.metadata.issueLifecycle).id === 'string');
  return !store.listRefinementTasks(Number.MAX_SAFE_INTEGER).some((task) => task.gapId === node.id && isTerminalRefinementState(task.state)
    && !reopened.some((issue) => {
      const reviewedAt = readRecord(issue.metadata.review).reviewedAt;
      return (!task.issueId || task.issueId === issue.id) && typeof reviewedAt === 'number' && Number.isFinite(reviewedAt)
        && Number.isFinite(task.updatedAt) && reviewedAt > task.updatedAt;
    }));
}
export interface AnswerGapWritePlan {
  readonly spaceId: string; readonly query: string; readonly reason: string;
  readonly target: { readonly nodeId: string; readonly issueId: string; readonly fingerprint: string };
  readonly existing?: KnowledgeNodeRecord | undefined; readonly issue?: KnowledgeIssueRecord | undefined;
  readonly issues: readonly KnowledgeIssueRecord[]; readonly tasks: readonly KnowledgeRefinementTaskRecord[];
  readonly sources: readonly KnowledgeSourceRecord[]; readonly linkedObjects: readonly KnowledgeNodeRecord[];
  readonly reading: { readonly inputHash: string; readonly decisionIds: readonly string[] };
}
/** Internal only: the immutable plan and its read-set are closures, never JSON
 * authority. The ordinary observed research-task seam does not endorse facts.
 */
export async function persistPreparedAnswerGap(store: KnowledgeStore, input: AnswerGapWritePlan, assertCurrent: () => void,
  signal?: AbortSignal): Promise<KnowledgeNodeRecord> {
  const plan = snapshotNodeInput(input);
  assertCurrent();
  const { existing, issue, target, spaceId, query, reason, sources, linkedObjects } = plan;
  // Re-observation must not invalidate the gap snapshot held by an active
  // repair. The caller can still coordinate and wait on that existing task.
  if (existing && (closedNode(existing) || hasKnowledgeNodeOperatorReview(existing) || plan.issues.some(reviewedIssue)
    || plan.tasks.some((task) => isTerminalRefinementState(task.state)
      || ACTIVE_REPAIR_STATES.has(task.state)))) return store.getNode(existing.id)!;
  const sourceIds = exactIds([...exactReferences(existing?.metadata.sourceIds), ...exactReferences(issue?.metadata.sourceIds), existing?.sourceId, issue?.sourceId, ...sources.map((source) => source.id)]);
  const linkedObjectIds = exactIds([...exactReferences(existing?.metadata.linkedObjectIds), ...exactReferences(issue?.metadata.linkedObjectIds), ...linkedObjects.map((node) => node.id)]);
  const subject = originalText(existing?.metadata.subject);
  const shared = { query: originalText(existing?.metadata.query) ?? query, reason, ...(subject ? { subject } : {}),
    subjectFingerprint: target.fingerprint, sourceIds, linkedObjectIds };
  const nodeInput = prepareObservedKnowledgeNodeInput(store, {
    ...(existing ?? {}), id: target.nodeId, kind: 'knowledge_gap', slug: existing?.slug ?? `answer-gap-${target.fingerprint}`,
    title: existing?.title ?? query, summary: reason, confidence: existing?.confidence ?? 70,
    ...(existing?.sourceId ?? sources[0]?.id ? { sourceId: existing?.sourceId ?? sources[0]?.id } : {}),
    metadata: semanticMetadata(spaceId, { ...existing?.metadata, semanticKind: 'gap', gapKind: 'answer', ...shared,
      repairStatus: readString(existing?.metadata.repairStatus) ?? 'open', visibility: 'refinement', displayRole: 'knowledge-gap',
      answerGapReading: plan.reading }),
  }, 'research-task', { query, reason, sources, linkedObjects }, () => { assertCurrent(); return { query, reason, sources, linkedObjects }; });
  const edges: KnowledgeEdgeUpsertInput[] = [
    ...sources.map((source) => ({ fromKind: 'source' as const, fromId: source.id })),
    ...linkedObjects.map((node) => ({ fromKind: 'node' as const, fromId: node.id })),
  ].map((from) => ({ ...from, toKind: 'node', toId: target.nodeId, relation: 'has_gap', metadata: semanticMetadata(spaceId, { gapKind: 'answer' }) }));
  // Existing all-or-none graph seam preserves the branded observed input through
  // preparation. No evidence, serving facts, operator rights or API are added.
  await store.applyPreparedIngest({ sources: [], extractions: [], nodes: [], edges: [], issues: [] }, async () => {
    assertCurrent();
    return { nodes: [nodeInput], edges, issues: [{
      ...(issue ?? {}), id: target.issueId, severity: issue?.severity ?? 'info', code: 'knowledge.answer_gap',
      message: issue?.message ?? `No knowledge answer available for: ${query}`, status: issue?.status ?? 'open',
      ...(issue?.sourceId ?? sources[0]?.id ? { sourceId: issue?.sourceId ?? sources[0]?.id } : {}), nodeId: target.nodeId,
      metadata: semanticMetadata(spaceId, { ...issue?.metadata, ...shared,
        namespace: originalText(issue?.metadata.namespace) ?? `knowledge:${spaceId}:answers`,
        query: originalText(issue?.metadata.query) ?? shared.query,
        ...(issue?.metadata.subject !== undefined ? { subject: issue.metadata.subject } : {}),
        subjectFingerprint: originalText(issue?.metadata.subjectFingerprint) ?? target.fingerprint }),
    }], assertCurrent };
  }, { signal });
  const result = store.getNode(target.nodeId);
  if (!result) throw new Held('stale');
  return result;
}
