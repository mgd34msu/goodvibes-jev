import { captureKnowledgeStoreInput, copyKnowledgeRepresentation } from './store-record-representation.js';
import type { SQLiteStore } from '../state/sqlite-store.js';
import { activationSourceIds } from './activation/projection.js';
import { KnowledgeNodeActivationHeldError as Held, type KnowledgeNodeActivationOptions } from './activation/types.js';
import { supportHash } from './semantic/verification/projection.js';
import { findKnowledgeEdge, prepareKnowledgeEdgeRecord, writeKnowledgeEdgeRow } from './store-edge-writes.js';
import { prepareKnowledgeExtractionRecord, prepareKnowledgeSourceRecord, writeKnowledgeExtractionRow, writeKnowledgeSourceRow } from './store-evidence-writes.js';
import { assertPreparedNodeWrites, markPreparedNodeWritten, preparedNodeWrite, prepareNodeActivationPass, type NodeMutationDraft } from './store-node-activation.js';
import { recordKnowledgeNodeRevisions, writeKnowledgeNodeRow } from './store-node-history.js';
import { prepareKnowledgeIssueRecord, writeKnowledgeIssueRow } from './store-node-issue-writes.js';
import { retainKnowledgeNodeObservation } from './store-node-observation.js';
import type { KnowledgeStore } from './store.js';
import type { KnowledgeEdgeRecord, KnowledgeEdgeUpsertInput, KnowledgeExtractionRecord, KnowledgeExtractionUpsertInput,
  KnowledgeIssueRecord, KnowledgeIssueUpsertInput, KnowledgeNodeRecord, KnowledgeNodeRevisionRecord, KnowledgeNodeUpsertInput,
  KnowledgeSourceRecord, KnowledgeSourceUpsertInput } from './types.js';

/** Exact committed identities; immutable arrays contain the rows published before save yields. */
export interface KnowledgeImportReceipt {
  readonly nodes: readonly KnowledgeNodeRecord[];
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly edges: readonly KnowledgeEdgeRecord[];
}
export interface KnowledgeImportInput {
  readonly sources: readonly KnowledgeSourceUpsertInput[];
  readonly extractions: readonly KnowledgeExtractionUpsertInput[];
  readonly nodes: readonly KnowledgeNodeUpsertInput[];
  readonly edges: readonly KnowledgeEdgeUpsertInput[];
  readonly issues: readonly KnowledgeIssueUpsertInput[];
}
/** Internal producer preparation receives exact normalized, detached proposed evidence. */
export interface KnowledgeImportStage {
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly extractions: readonly KnowledgeExtractionRecord[];
  readonly assertCurrent: () => void;
}
export interface KnowledgeImportGraph {
  readonly nodes: readonly KnowledgeNodeUpsertInput[];
  readonly edges: readonly KnowledgeEdgeUpsertInput[];
  readonly issues: readonly KnowledgeIssueUpsertInput[];
  readonly assertCurrent?: (() => void) | undefined;
}
export type PrepareKnowledgeImportGraph = (stage: KnowledgeImportStage) => Promise<KnowledgeImportGraph>;
export interface KnowledgeImportView {
  readonly sqlite: SQLiteStore;
  readonly sources: Map<string, KnowledgeSourceRecord>;
  readonly extractions: Map<string, KnowledgeExtractionRecord>;
  readonly nodes: Map<string, KnowledgeNodeRecord>;
  readonly nodeRevisions: Map<string, KnowledgeNodeRevisionRecord[]>;
  readonly edges: Map<string, KnowledgeEdgeRecord>;
  readonly issues: Map<string, KnowledgeIssueRecord>;
}
function extractionFor(extractions: ReadonlyMap<string, KnowledgeExtractionRecord>, sourceId: string): KnowledgeExtractionRecord | null {
  return [...extractions.values()].find((record) => record.sourceId === sourceId) ?? null;
}

/** Stage complete ordinary records and judgments without changing the live store or SQL. */
export async function applyKnowledgeImport(store: KnowledgeStore, view: KnowledgeImportView, input: KnowledgeImportInput,
  prepareNode: (input: KnowledgeNodeUpsertInput, original: KnowledgeNodeUpsertInput) => NodeMutationDraft, floor: number | undefined, scope: object,
  options: KnowledgeNodeActivationOptions, prepareGraph?: PrepareKnowledgeImportGraph, onCommitted?: () => void): Promise<KnowledgeImportReceipt> {
  const checks: (() => void)[] = [];
  function watch(read: () => unknown): void {
    const expected = supportHash(read() ?? null);
    checks.push(() => { if (supportHash(read() ?? null) !== expected) throw new Held('stale'); });
  }
  function assertEvidenceCurrent(): void {
    if (options.signal?.aborted) throw new Held('aborted');
    for (const check of checks) check();
  }
  let graphCheck: (() => void) | undefined;
  function assertCurrent(): void { assertEvidenceCurrent(); graphCheck?.(); }
  const sources = new Map(view.sources), extractions = new Map(view.extractions), edges = new Map(view.edges), issues = new Map(view.issues);
  const sourceWrites: KnowledgeSourceRecord[] = [], extractionWrites: KnowledgeExtractionRecord[] = [];
  const edgeWrites: KnowledgeEdgeRecord[] = [], issueWrites: KnowledgeIssueRecord[] = [];
  const removedExtractions = new Set<string>();
  for (const source of input.sources) {
    watch(() => source.id ? view.sources.get(source.id) : source.canonicalUri ? store.getSourceByCanonicalUri(source.canonicalUri) : null);
    const existing = source.id ? sources.get(source.id) : source.canonicalUri ? [...sources.values()].find((record) => record.canonicalUri === source.canonicalUri) : undefined;
    const preparedSource = prepareKnowledgeSourceRecord(source, existing);
    const record = copyKnowledgeRepresentation(preparedSource, captureKnowledgeStoreInput(preparedSource));
    sources.set(record.id, record); sourceWrites.push(record);
  }
  for (const extraction of input.extractions) {
    watch(() => extraction.id ? view.extractions.get(extraction.id) : extractionFor(view.extractions, extraction.sourceId));
    watch(() => extractionFor(view.extractions, extraction.sourceId));
    const existing = extraction.id ? extractions.get(extraction.id) : extractionFor(extractions, extraction.sourceId);
    const preparedExtraction = prepareKnowledgeExtractionRecord(extraction, existing, sources.get(extraction.sourceId));
    const record = copyKnowledgeRepresentation(preparedExtraction, captureKnowledgeStoreInput(preparedExtraction));
    const displaced = extractionFor(extractions, record.sourceId);
    if (displaced && displaced.id !== record.id) { extractions.delete(displaced.id); removedExtractions.add(displaced.id); }
    extractions.set(record.id, record); extractionWrites.push(record);
  }
  const graph: KnowledgeImportGraph = prepareGraph ? await prepareGraph({ sources: Object.freeze([...sourceWrites]), extractions: Object.freeze([...extractionWrites]), assertCurrent: assertEvidenceCurrent }) : input;
  graphCheck = graph.assertCurrent;
  assertCurrent();
  const drafts = graph.nodes.map((node) => prepareNode(captureKnowledgeStoreInput(node), node));
  if (new Set(drafts.map(({ record }) => record.id)).size !== drafts.length) throw new Held('stale');
  for (const { record } of drafts) for (const id of activationSourceIds(record)) {
    watch(() => store.getSource(id)); watch(() => store.getExtractionBySourceId(id));
  }
  for (const edge of captureKnowledgeStoreInput(graph.edges)) {
    watch(() => findKnowledgeEdge(view.edges, edge));
    const record = captureKnowledgeStoreInput(prepareKnowledgeEdgeRecord(edge, findKnowledgeEdge(edges, edge)));
    edges.set(record.id, record); edgeWrites.push(record);
  }
  const nodeView = new Map(view.nodes);
  for (const { record } of drafts) nodeView.set(record.id, record);
  for (const issue of captureKnowledgeStoreInput(graph.issues)) {
    if (issue.id) watch(() => view.issues.get(issue.id!));
    const prepared = prepareKnowledgeIssueRecord({ issues, sources, nodes: nodeView }, issue);
    const record = captureKnowledgeStoreInput(prepared.record);
    issues.set(record.id, record);
    if (!prepared.preserve) issueWrites.push(record);
  }
  // A retained observation may close over a source absent from the node's source IDs.
  // Imported JSON cannot prove that hidden dependency survived changed evidence.
  const invalidatesRetainedObservations = sourceWrites.some((record) => supportHash(record) !== supportHash(view.sources.get(record.id) ?? null))
    || extractionWrites.some((record) => supportHash(record) !== supportHash(view.extractions.get(record.id) ?? null));
  const stage = { assertCurrent, invalidatesRetainedObservations, evidenceFor: (record: KnowledgeNodeRecord) => activationSourceIds(record).map((id) => ({ id,
    source: sources.get(id) ?? null, extraction: extractionFor(extractions, id) })) };
  const prepared = await prepareNodeActivationPass(store, drafts, options, floor, scope, stage);
  const nodes = drafts.map((_, index) => preparedNodeWrite(store, prepared, index, scope));
  const revisions = new Map<string, KnowledgeNodeRevisionRecord[]>();
  for (const { record } of nodes) revisions.set(record.id, [...(view.nodeRevisions.get(record.id) ?? [])]);
  // Last authority/read-set check. No await or user callback occurs through cache publication.
  assertPreparedNodeWrites(store, prepared, scope);
  view.sqlite.run('SAVEPOINT knowledge_import');
  try {
    for (const record of sourceWrites) writeKnowledgeSourceRow(view.sqlite, record);
    for (const record of extractionWrites) writeKnowledgeExtractionRow(view.sqlite, record);
    for (const { record, existing, now } of nodes) {
      if (record === existing) continue;
      writeKnowledgeNodeRow(view.sqlite, record);
      recordKnowledgeNodeRevisions(view.sqlite, revisions, record, existing, now);
    }
    for (const record of edgeWrites) writeKnowledgeEdgeRow(view.sqlite, record);
    for (const record of issueWrites) writeKnowledgeIssueRow(view.sqlite, record);
    view.sqlite.run('RELEASE SAVEPOINT knowledge_import');
  } catch (error) {
    view.sqlite.run('ROLLBACK TO SAVEPOINT knowledge_import');
    view.sqlite.run('RELEASE SAVEPOINT knowledge_import');
    throw error;
  }
  for (const record of sourceWrites) view.sources.set(record.id, record);
  for (const id of removedExtractions) view.extractions.delete(id);
  for (const record of extractionWrites) {
    // A later import row may have replaced this extraction's source-unique identity.
    if (extractions.get(record.id) === record) view.extractions.set(record.id, record);
  }
  for (const { record } of nodes) view.nodes.set(record.id, record);
  for (const [id, records] of revisions) view.nodeRevisions.set(id, records);
  for (const record of edgeWrites) view.edges.set(record.id, record);
  for (const record of issueWrites) view.issues.set(record.id, record);
  nodes.forEach(({ existing, record, observationEvidence, preserveObservation }, index) => {
    retainKnowledgeNodeObservation(preserveObservation ? existing : undefined, record, observationEvidence); markPreparedNodeWritten(prepared, index);
  });
  const receipt = Object.freeze({ nodes: Object.freeze(nodes.map(({ record }) => record)), sources: Object.freeze([...sourceWrites]), edges: Object.freeze([...edgeWrites]) });
  // The source/graph and caches are now committed; report before persistence yields.
  onCommitted?.();
  await view.sqlite.save();
  return receipt;
}
