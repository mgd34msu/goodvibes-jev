import type { SQLiteStore } from '../state/sqlite-store.js';
import type { KnowledgeIssueRecord, KnowledgeIssueUpsertInput, KnowledgeNodeRecord, KnowledgeSourceRecord } from './types.js';
import { prepareKnowledgeIssueRecord, writeKnowledgeIssueRow } from './store-node-issue-writes.js';
import { getKnowledgeSpaceId } from './spaces.js';
import { homeGraphIssueId } from './home-graph/helpers.js';
export class KnowledgeIssueReplacementHeldError extends Error {
  override readonly name = 'KnowledgeIssueReplacementHeldError';
  constructor(readonly reason: 'stale' | 'malformed' | 'budget') { super(`Guarded issue replacement held (${reason}).`); }
}
interface IssueReplacementView {
  readonly sqlite: SQLiteStore;
  readonly issues: Map<string, KnowledgeIssueRecord>;
  readonly sources: ReadonlyMap<string, KnowledgeSourceRecord>;
  readonly nodes: ReadonlyMap<string, KnowledgeNodeRecord>;
}
function operatorReviewed(issue: KnowledgeIssueRecord): boolean {
  const review = issue.metadata.review;
  return Boolean(review && typeof review === 'object' && !Array.isArray(review)
    && typeof (review as Record<string, unknown>).action === 'string');
}
/** Only the precise legacy generator footprint can be reconciled into its intended namespace. */
export function isLegacyHomeGraphQualityIssue(issue: KnowledgeIssueRecord, spaceId: string): boolean {
  return issue.metadata.namespace === spaceId && getKnowledgeSpaceId(issue) === spaceId
    && issue.metadata.generated === true && issue.metadata.homeGraph === true
    && ['homegraph.device.missing_manual', 'homegraph.device.unknown_battery'].includes(issue.code)
    && typeof issue.nodeId === 'string' && issue.sourceId === undefined && issue.metadata.subjectId === issue.nodeId
    && issue.id === homeGraphIssueId(spaceId, issue.code, issue.nodeId);
}
/** Ordinary namespace replacement, never operator authority; no await between final guard and commit. */
export function commitGuardedKnowledgeIssueReplacement(view: IssueReplacementView,
  inputs: readonly KnowledgeIssueUpsertInput[], namespace: string, beforeWrite: () => void, legacyHomeGraphIssues: readonly KnowledgeIssueRecord[] = []): KnowledgeIssueRecord[] {
  const legacyIds = new Set<string>();
  if (legacyHomeGraphIssues.length > 2_000) throw new KnowledgeIssueReplacementHeldError('budget');
  if (new Set(legacyHomeGraphIssues.map((issue) => issue.id)).size !== legacyHomeGraphIssues.length) throw new KnowledgeIssueReplacementHeldError('malformed');
  for (const snapshot of legacyHomeGraphIssues) {
    const current = view.issues.get(snapshot.id);
    const spaceId = getKnowledgeSpaceId(snapshot);
    if (!current || JSON.stringify(current) !== JSON.stringify(snapshot) || namespace !== `homegraph:${spaceId}:quality`
      || !isLegacyHomeGraphQualityIssue(current, spaceId)) throw new KnowledgeIssueReplacementHeldError('stale');
    legacyIds.add(current.id);
  }
  const previous = [...view.issues.values()].filter((issue) => issue.metadata.namespace === namespace || legacyIds.has(issue.id));
  if (!namespace.trim() || inputs.length > 2_000 || previous.length > 2_000
    || new Set(inputs.map((input) => input.id)).size !== inputs.length) throw new KnowledgeIssueReplacementHeldError('budget');
  for (const input of inputs) {
    const existing = input.id ? view.issues.get(input.id) : undefined;
    const node = input.nodeId ? view.nodes.get(input.nodeId) : undefined;
    const source = input.sourceId ? view.sources.get(input.sourceId) : undefined;
    if (!input.id?.trim() || input.metadata?.namespace !== namespace || (!node && !source)
      || (input.nodeId && !node) || (input.sourceId && !source)
      || (node && getKnowledgeSpaceId({ metadata: input.metadata ?? {} }) !== getKnowledgeSpaceId(node))
      || (source && getKnowledgeSpaceId({ metadata: input.metadata ?? {} }) !== getKnowledgeSpaceId(source))
      || (existing && ((existing.metadata.namespace !== namespace && !legacyIds.has(existing.id)) || existing.code !== input.code
        || existing.nodeId !== input.nodeId || existing.sourceId !== input.sourceId))) {
      throw new KnowledgeIssueReplacementHeldError('malformed');
    }
  }
  const prepared = inputs.map((input) => prepareKnowledgeIssueRecord(view, input));
  const active = new Set(prepared.map(({ record }) => record.id));
  const removed = previous.filter((issue) => !active.has(issue.id) && issue.status !== 'resolved' && !operatorReviewed(issue));
  // Snapshot/abort callback runs once, after normalization and before every mutation.
  beforeWrite();
  view.sqlite.run('SAVEPOINT knowledge_guarded_issue_replacement');
  try {
    for (const { record, preserve } of prepared) if (!preserve) writeKnowledgeIssueRow(view.sqlite, record);
    for (const issue of removed) view.sqlite.run('DELETE FROM knowledge_issues WHERE id = ?', [issue.id]);
    view.sqlite.run('RELEASE SAVEPOINT knowledge_guarded_issue_replacement');
  } catch (error) {
    view.sqlite.run('ROLLBACK TO SAVEPOINT knowledge_guarded_issue_replacement');
    view.sqlite.run('RELEASE SAVEPOINT knowledge_guarded_issue_replacement');
    throw error;
  }
  for (const { record, preserve } of prepared) if (!preserve) view.issues.set(record.id, record);
  for (const issue of removed) view.issues.delete(issue.id);
  return prepared.map(({ record }) => record);
}
