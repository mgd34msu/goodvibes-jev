import { knowledgeClockIso, knowledgeRawRepresentation, retainKnowledgeRepresentation } from './store-record-representation.js';
import { randomUUID } from 'node:crypto';
import { KnowledgeNodeActivationHeldError } from './activation/types.js';
import { preparedNodeWrite, markPreparedNodeWritten } from './store-node-activation.js';
import { retainKnowledgeNodeObservation } from './store-node-observation.js';
import type { SQLiteStore } from '../state/sqlite-store.js';
import { nowMs } from './store-schema.js';
import type { KnowledgeStore } from './store.js';
import { resolveKnowledgeNodeOperatorMutation, type KnowledgeNodeMutationContext } from './store-node-authority.js';
import type {
  KnowledgeEdgeRecord,
  KnowledgeEdgeUpsertInput,
  KnowledgeNodeRecord,
  KnowledgeNodeRevisionChangeKind,
  KnowledgeNodeRevisionRecord,
  KnowledgeNodeUpsertInput,
  KnowledgeSemanticEnrichmentStateRecord,
} from './types.js';

export function writeKnowledgeNodeRow(sqlite: SQLiteStore, record: KnowledgeNodeRecord): void {
  const raw = knowledgeRawRepresentation(record);
  sqlite.run(`
    INSERT OR REPLACE INTO knowledge_nodes (
      id, kind, slug, title, summary, aliases, status, confidence, source_id, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    record.id,
    record.kind,
    record.slug,
    record.title,
    record.summary ?? null,
    JSON.stringify([...record.aliases]),
    record.status,
    record.confidence,
    record.sourceId ?? null,
    JSON.stringify(raw.metadata),
    raw.createdAt,
    raw.updatedAt,
  ]);
}

/** Descriptive 0-100 producer score. Missing/nonfinite values never become evidence. */
export function clampConfidence(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Synchronous authority preflight. Model reads belong to the prepared activation pass. */
export function resolveNodeActivation(args: {
  readonly input: KnowledgeNodeUpsertInput;
  readonly candidate: KnowledgeNodeRecord;
  readonly existing: KnowledgeNodeRecord | undefined;
  readonly mutation?: KnowledgeNodeMutationContext | undefined;
  readonly now: number;
}): { status: KnowledgeNodeRecord['status']; metadata: Record<string, unknown> } | undefined {
  return resolveKnowledgeNodeOperatorMutation(args.candidate, args.existing, args.mutation, args.now);
}

/**
 * Record an append-only revision on a content-changing upsert: preserve the
 * overwritten prior content and note what changed. (Invariant 8.)
 */
export function recordKnowledgeNodeRevisions(
  sqlite: SQLiteStore,
  nodeRevisions: Map<string, KnowledgeNodeRevisionRecord[]>,
  record: KnowledgeNodeRecord,
  existing: KnowledgeNodeRecord | undefined,
  now: number,
): void {
  const list = nodeRevisions.get(record.id) ?? [];
  if (existing) {
    const changedFields = diffKnowledgeNodeFields(existing, record);
    if (changedFields.length === 0) return; // idempotent re-upsert (e.g. a provenance-only restamp)
    if (list.length === 0) {
      // First tracked change to a pre-existing node: preserve the overwritten prior
      // content as the baseline revision so it is never lost.
      appendNodeRevision(sqlite, list, existing, 'create', [], now);
    }
    appendNodeRevision(sqlite, list, record, 'update', changedFields, now);
  } else {
    appendNodeRevision(sqlite, list, record, 'create', [], now);
  }
  nodeRevisions.set(record.id, list);
}

export function listKnowledgeNodeRevisions(
  nodeRevisions: Map<string, KnowledgeNodeRevisionRecord[]>,
  nodeId: string,
): KnowledgeNodeRevisionRecord[] {
  return [...(nodeRevisions.get(nodeId) ?? [])].sort((a, b) => a.revision - b.revision);
}

function appendNodeRevision(
  sqlite: SQLiteStore,
  list: KnowledgeNodeRevisionRecord[],
  snapshot: KnowledgeNodeRecord,
  changeKind: KnowledgeNodeRevisionChangeKind,
  changedFields: readonly string[],
  now: number,
): void {
  const revision = (list[list.length - 1]?.revision ?? 0) + 1;
  const rev: KnowledgeNodeRevisionRecord = {
    id: `noderev-${snapshot.id}-${revision}`,
    nodeId: snapshot.id,
    revision,
    changeKind,
    changedFields: [...changedFields],
    kind: snapshot.kind,
    slug: snapshot.slug,
    title: snapshot.title,
    ...(snapshot.summary ? { summary: snapshot.summary } : {}),
    aliases: [...snapshot.aliases],
    status: snapshot.status,
    confidence: snapshot.confidence,
    ...(snapshot.sourceId ? { sourceId: snapshot.sourceId } : {}),
    metadata: snapshot.metadata,
    nodeCreatedAt: snapshot.createdAt,
    nodeUpdatedAt: snapshot.updatedAt,
    recordedAt: now,
  };
  const original = knowledgeRawRepresentation(snapshot);
  retainKnowledgeRepresentation(rev, { ...knowledgeRawRepresentation(rev), nodeCreatedAt: original.createdAt, nodeUpdatedAt: original.updatedAt, recordedAt: knowledgeClockIso(now) });
  const raw = knowledgeRawRepresentation(rev);
  sqlite.run(`
    INSERT OR REPLACE INTO knowledge_node_revisions (
      id, node_id, revision, change_kind, changed_fields, kind, slug, title, summary,
      aliases, status, confidence, source_id, metadata, node_created_at, node_updated_at, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    rev.id,
    rev.nodeId,
    rev.revision,
    rev.changeKind,
    JSON.stringify(rev.changedFields),
    rev.kind,
    rev.slug,
    rev.title,
    rev.summary ?? null,
    JSON.stringify([...rev.aliases]),
    rev.status,
    rev.confidence,
    rev.sourceId ?? null,
    JSON.stringify(raw.metadata),
    raw.nodeCreatedAt,
    raw.nodeUpdatedAt,
    raw.recordedAt,
  ]);
  list.push(rev);
}

function diffKnowledgeNodeFields(prev: KnowledgeNodeRecord, next: KnowledgeNodeRecord): string[] {
  const changed: string[] = [];
  // Identity fields are tracked: an id-based upsert that changes ONLY the kind or
  // slug (all other fields identical) is still a real content change and must
  // record a revision, otherwise `changedFields` is empty, the early return in
  // recordKnowledgeNodeRevisions fires, and the prior slug/kind is lost from
  // history with no trace.
  if (prev.kind !== next.kind) changed.push('kind');
  if (prev.slug !== next.slug) changed.push('slug');
  if (prev.title !== next.title) changed.push('title');
  if ((prev.summary ?? '') !== (next.summary ?? '')) changed.push('summary');
  if (prev.status !== next.status) changed.push('status');
  if (prev.confidence !== next.confidence) changed.push('confidence');
  if ((prev.sourceId ?? '') !== (next.sourceId ?? '')) changed.push('sourceId');
  if (!sameStringSet(prev.aliases, next.aliases)) changed.push('aliases');
  if (stableMetadataForDiff(prev.metadata) !== stableMetadataForDiff(next.metadata)) changed.push('metadata');
  return changed;
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((entry) => set.has(entry));
}

// Compare metadata for revision purposes ignoring the volatile review-provenance
// stamp (its decidedAt changes on every write); a provenance-only restamp must not
// count as a content change.
function stableMetadataForDiff(metadata: Record<string, unknown>): string {
  const { reviewProvenance: _reviewProvenance, ...rest } = metadata;
  return stableStringify(rest);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export interface KnowledgeNodeMergeView {
  readonly sqlite: SQLiteStore;
  readonly nodes: Map<string, KnowledgeNodeRecord>;
  readonly edges: Map<string, KnowledgeEdgeRecord>;
  readonly nodeRevisions: Map<string, KnowledgeNodeRevisionRecord[]>;
  readonly nodeActivationScope: object;
}

/**
 * Merge one node into another, preserving ordinary node authority. Preparation
 * and read-set validation precede every write. The SQL savepoint is synchronous;
 * cache publication happens only after every SQL mutation has succeeded.
 */
export async function mergeKnowledgeNodes(
  store: KnowledgeStore,
  loserId: string,
  winnerId: string,
  view: KnowledgeNodeMergeView,
): Promise<{ merged: boolean; repointedEdges: number }> {
  if (loserId === winnerId) return { merged: false, repointedEdges: 0 };
  const loser = store.getNode(loserId);
  const winner = store.getNode(winnerId);
  if (!loser || !winner) return { merged: false, repointedEdges: 0 };
  const edges = store.listEdges();
  const edgeSnapshot = stableStringify(edges);
  const previousMarker = edges.find((edge) => edge.fromKind === 'node' && edge.fromId === loserId
    && edge.toKind === 'node' && edge.toId === winnerId && edge.relation === 'merged_into');
  const alreadyMerged = loser.status === 'stale' && loser.metadata.mergedInto === winnerId;
  if (alreadyMerged && previousMarker && !edges.some((edge) => edge !== previousMarker && referencesNode(edge, loserId))) {
    return { merged: true, repointedEdges: 0 };
  }
  const mergedAt = alreadyMerged && typeof loser.metadata.mergedAt === 'number' ? loser.metadata.mergedAt : nowMs();
  const prepared = await store.prepareNodeWrites([{
    ...loser,
    status: 'stale',
    metadata: { ...loser.metadata, mergedInto: winnerId, mergedAt },
  }]);
  // Preparation awaits. A concurrent review, target replacement or graph edit
  // must survive the rejected merge, never be overwritten by its earlier plan.
  if (store.getNode(winnerId) !== winner || stableStringify(store.listEdges()) !== edgeSnapshot) {
    throw new KnowledgeNodeActivationHeldError('stale');
  }
  const plan = planMergedEdges(edges, loserId, winnerId, mergedAt);
  const { record, existing, now, observationEvidence } = preparedNodeWrite(store, prepared, 0, view.nodeActivationScope);
  const revisions = new Map([[record.id, [...(view.nodeRevisions.get(record.id) ?? [])]]]);
  view.sqlite.run('SAVEPOINT knowledge_node_merge');
  try {
    for (const edge of edges) if (!plan.edges.has(edge.id)) view.sqlite.run('DELETE FROM knowledge_edges WHERE id = ?', [edge.id]);
    for (const edge of plan.edges.values()) if (view.edges.get(edge.id) !== edge) writeMergedEdgeRow(view.sqlite, edge);
    if (record !== existing) {
      writeKnowledgeNodeRow(view.sqlite, record);
      recordKnowledgeNodeRevisions(view.sqlite, revisions, record, existing, now);
    }
    view.sqlite.run('RELEASE SAVEPOINT knowledge_node_merge');
  } catch (error) {
    view.sqlite.run('ROLLBACK TO SAVEPOINT knowledge_node_merge');
    view.sqlite.run('RELEASE SAVEPOINT knowledge_node_merge');
    throw error;
  }
  for (const edge of edges) if (!plan.edges.has(edge.id)) view.edges.delete(edge.id);
  for (const edge of plan.edges.values()) view.edges.set(edge.id, edge);
  view.nodes.set(record.id, record);
  view.nodeRevisions.set(record.id, revisions.get(record.id)!);
  retainKnowledgeNodeObservation(existing, record, observationEvidence);
  markPreparedNodeWritten(prepared, 0);
  // save() retains its normal contract, including outer batch-save deferral.
  // It is not a SQL transaction and is never used as rollback protection.
  await view.sqlite.save();
  return { merged: true, repointedEdges: plan.repointedEdges };
}

function referencesNode(edge: KnowledgeEdgeRecord, nodeId: string): boolean {
  return (edge.fromKind === 'node' && edge.fromId === nodeId) || (edge.toKind === 'node' && edge.toId === nodeId);
}

function planMergedEdges(original: readonly KnowledgeEdgeRecord[], loserId: string, winnerId: string, mergedAt: number): {
  edges: Map<string, KnowledgeEdgeRecord>; repointedEdges: number;
} {
  const edges = new Map(original.map((edge) => [edge.id, edge]));
  let repointedEdges = 0;
  const upsert = (input: KnowledgeEdgeUpsertInput): void => {
    const existing = [...edges.values()].find((edge) => edge.fromKind === input.fromKind && edge.fromId === input.fromId
      && edge.toKind === input.toKind && edge.toId === input.toId && edge.relation === input.relation);
    const record: KnowledgeEdgeRecord = {
      ...input, id: existing?.id ?? `edge-${randomUUID().slice(0, 8)}`,
      weight: Number.isFinite(input.weight) ? Number(input.weight) : existing?.weight ?? 1,
      metadata: { ...existing?.metadata, ...input.metadata },
      createdAt: existing?.createdAt ?? mergedAt, updatedAt: mergedAt,
    };
    edges.set(record.id, record);
  };
  for (const edge of original) {
    if (!referencesNode(edge, loserId)) continue;
    // Retain the canonical marker when processing new edges on a merged loser.
    if (edge.fromKind === 'node' && edge.fromId === loserId && edge.toKind === 'node'
      && edge.toId === winnerId && edge.relation === 'merged_into') continue;
    const fromId = edge.fromKind === 'node' && edge.fromId === loserId ? winnerId : edge.fromId;
    const toId = edge.toKind === 'node' && edge.toId === loserId ? winnerId : edge.toId;
    edges.delete(edge.id);
    if (fromId === toId && edge.fromKind === edge.toKind) continue;
    upsert({ ...edge, fromId, toId, metadata: { ...edge.metadata, repointedFromNodeId: loserId, repointedAt: mergedAt } });
    repointedEdges += 1;
  }
  upsert({ fromKind: 'node', fromId: loserId, toKind: 'node', toId: winnerId, relation: 'merged_into', metadata: { mergedAt } });
  return { edges, repointedEdges };
}

function writeMergedEdgeRow(sqlite: SQLiteStore, record: KnowledgeEdgeRecord): void {
  sqlite.run(`
    INSERT OR REPLACE INTO knowledge_edges (
      id, from_kind, from_id, to_kind, to_id, relation, weight, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [record.id, record.fromKind, record.fromId, record.toKind, record.toId, record.relation, record.weight,
    JSON.stringify(record.metadata), record.createdAt, record.updatedAt]);
}

const guardedSemanticStateInputs = new WeakMap<object, () => void>();
/** Process-local authority for derived enrichment bookkeeping. */
export function guardKnowledgeSemanticStateInput<T extends object>(input: T, assertCurrent: () => void): T {
  guardedSemanticStateInputs.set(input, assertCurrent); return input;
}

export function upsertKnowledgeSemanticEnrichmentState(
  sqlite: SQLiteStore,
  states: Map<string, KnowledgeSemanticEnrichmentStateRecord>,
  input: {
    readonly sourceId: string;
    readonly textHash?: string | undefined;
    readonly enrichedAt?: number | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  },
): KnowledgeSemanticEnrichmentStateRecord {
  guardedSemanticStateInputs.get(input)?.();
  const existing = states.get(input.sourceId);
  const now = nowMs();
  const record: KnowledgeSemanticEnrichmentStateRecord = {
    sourceId: input.sourceId,
    ...(input.textHash ? { textHash: input.textHash } : {}),
    ...(typeof input.enrichedAt === 'number' ? { enrichedAt: input.enrichedAt } : {}),
    metadata: input.metadata ?? {},
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  sqlite.run(`
    INSERT OR REPLACE INTO knowledge_semantic_enrichment_state (
      source_id, text_hash, enriched_at, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `, [
    record.sourceId,
    record.textHash ?? null,
    record.enrichedAt ?? null,
    JSON.stringify(record.metadata),
    record.createdAt,
    record.updatedAt,
  ]);
  states.set(record.sourceId, record);
  return record;
}
