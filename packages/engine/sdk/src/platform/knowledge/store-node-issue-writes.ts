import { randomUUID } from 'node:crypto';
import type { SQLiteStore } from '../state/sqlite-store.js';
import type { KnowledgeIssueRecord, KnowledgeIssueUpsertInput, KnowledgeNodeRecord, KnowledgeNodeRevisionRecord, KnowledgeNodeUpsertInput, KnowledgeSourceRecord } from './types.js';
import { nowMs, stableText } from './store-schema.js';
import { prepareKnowledgeIssueUpsert, type KnowledgeIssueOperatorMutation } from './store-lifecycle-authority.js';
import { getExplicitKnowledgeSpaceId, ensureKnowledgeSpaceMetadata } from './spaces.js';
import { inferRecordReferenceSpaceId, preferRelatedNonDefaultSpace } from './store-record-space.js';
import { writeKnowledgeNodeRow, recordKnowledgeNodeRevisions } from './store-node-history.js';
interface IssueView { readonly issues: ReadonlyMap<string, KnowledgeIssueRecord>; readonly sources: ReadonlyMap<string, KnowledgeSourceRecord>; readonly nodes: ReadonlyMap<string, KnowledgeNodeRecord>; }
export interface KnowledgeGuardedNodeIssueWrites { readonly nodes: readonly KnowledgeNodeUpsertInput[]; readonly issues: readonly KnowledgeIssueUpsertInput[]; }
export interface PreparedKnowledgeNode { readonly record: KnowledgeNodeRecord; readonly existing?: KnowledgeNodeRecord | undefined; readonly now: number; }
/** Shared ordinary issue normalization; caller metadata never creates operator authority. */
export function prepareKnowledgeIssueRecord(view: IssueView, input: KnowledgeIssueUpsertInput, mutation?: KnowledgeIssueOperatorMutation): { record: KnowledgeIssueRecord; preserve: boolean } {
    const existing = input.id ? view.issues.get(input.id) : undefined;
    const lifecycle = prepareKnowledgeIssueUpsert(existing, input, mutation);
    if (existing && lifecycle.preserve) return { record: existing, preserve: true };
    const now = nowMs();
    const _sourceId = stableText(input.sourceId);
    const _nodeId = stableText(input.nodeId);
    const mergedIssueMetadata = lifecycle.metadata;
    const issueSource = _sourceId !== null
      ? view.sources.get(_sourceId)
      : existing?.sourceId
        ? view.sources.get(existing.sourceId)
        : null;
    const issueNode = _nodeId !== null
      ? view.nodes.get(_nodeId)
      : existing?.nodeId
        ? view.nodes.get(existing.nodeId)
        : null;
    const issueSpaceId = preferRelatedNonDefaultSpace(
      getExplicitKnowledgeSpaceId({ metadata: mergedIssueMetadata }),
      inferRecordReferenceSpaceId({
        sourceId: _sourceId ?? existing?.sourceId,
        nodeId: _nodeId ?? existing?.nodeId,
        metadata: mergedIssueMetadata,
        sources: view.sources,
        nodes: view.nodes,
      }) ?? getExplicitKnowledgeSpaceId(issueSource) ?? getExplicitKnowledgeSpaceId(issueNode),
    );
    const issueMetadata = issueSpaceId
      ? ensureKnowledgeSpaceMetadata(mergedIssueMetadata, issueSpaceId)
      : mergedIssueMetadata;
    const record: KnowledgeIssueRecord = {
      id: existing?.id ?? input.id ?? `issue-${randomUUID().slice(0, 8)}`,
      severity: input.severity,
      code: input.code,
      message: input.message.trim(),
      status: lifecycle.status,
      ...(_sourceId !== null ? { sourceId: _sourceId } : {}),
      ...(_nodeId !== null ? { nodeId: _nodeId } : {}),
      metadata: issueMetadata,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    return { record, preserve: false };
}
export function writeKnowledgeIssueRow(sqlite: SQLiteStore, record: KnowledgeIssueRecord): void {
    sqlite.run(`
      INSERT OR REPLACE INTO knowledge_issues (
        id, severity, code, message, status, source_id, node_id, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.id,
      record.severity,
      record.code,
      record.message,
      record.status,
      record.sourceId ?? null,
      record.nodeId ?? null,
      JSON.stringify(record.metadata),
      record.createdAt,
      record.updatedAt,
    ]);
}

/** No await/callback occurs inside the SQL commit section; caches change only after release. */
export function commitKnowledgeNodeIssueWrites(view: {
  sqlite: SQLiteStore; nodes: Map<string, KnowledgeNodeRecord>; issues: Map<string, KnowledgeIssueRecord>;
  nodeRevisions: Map<string, KnowledgeNodeRevisionRecord[]>;
}, nodes: readonly PreparedKnowledgeNode[], issues: readonly KnowledgeIssueRecord[]): void {
  const revisions = new Map<string, KnowledgeNodeRevisionRecord[]>();
  for (const { record } of nodes) revisions.set(record.id, [...(view.nodeRevisions.get(record.id) ?? [])]);
  view.sqlite.run('SAVEPOINT knowledge_guarded_node_issue_write');
  try {
    for (const { record, existing, now } of nodes) {
      writeKnowledgeNodeRow(view.sqlite, record);
      recordKnowledgeNodeRevisions(view.sqlite, revisions, record, existing, now);
    }
    for (const record of issues) writeKnowledgeIssueRow(view.sqlite, record);
    view.sqlite.run('RELEASE SAVEPOINT knowledge_guarded_node_issue_write');
  } catch (error) {
    view.sqlite.run('ROLLBACK TO SAVEPOINT knowledge_guarded_node_issue_write');
    view.sqlite.run('RELEASE SAVEPOINT knowledge_guarded_node_issue_write');
    throw error;
  }
  for (const { record } of nodes) view.nodes.set(record.id, record);
  for (const [id, records] of revisions) view.nodeRevisions.set(id, records);
  for (const record of issues) view.issues.set(record.id, record);
}
