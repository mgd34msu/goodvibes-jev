import type { KnowledgeStore } from '../store.js';
import type { KnowledgeEdgeRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import { knowledgeRecordVersion, sameKnowledgeRecord } from '../store-record-representation.js';
import { KnowledgeRecordAdmissionHeldError } from '../store-record-snapshot.js';
import { KnowledgeSourceQualityHeldError } from '../source-quality.js';

/** Retain actual page inputs before any semantic reading can yield. */
export function retainHomeGraphPageInputs(store: KnowledgeStore, input: {
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly nodes: readonly KnowledgeNodeRecord[];
  readonly edges: readonly KnowledgeEdgeRecord[];
}): () => void {
  const checks: (() => void)[] = [];
  const edgeVersions = new Map<string, { readonly version: string; readonly generation: string | null }>();
  const keys = [...new Set([
    ...input.sources.map(source => `source:${source.id}`),
    ...input.nodes.map(node => `node:${node.id}`),
    ...input.edges.flatMap(edge => [`${edge.fromKind}:${edge.fromId}`, `${edge.toKind}:${edge.toId}`]),
  ])];
  const stale = () => { throw new KnowledgeSourceQualityHeldError('stale'); };
  const frame = (read: () => undefined) => {
    try { store.assertRecordSnapshotFrame(read); }
    catch (error) {
      if (error instanceof KnowledgeRecordAdmissionHeldError) stale();
      throw error;
    }
  };
  frame(() => {
    const window = store.getEdgeWindowGeneration(keys);
    checks.push(() => { if (store.getEdgeWindowGeneration(keys) !== window) stale(); });
    for (const source of input.sources) {
      const { id } = source;
      const snapshot = store.getSourceSnapshot({ id });
      if (!snapshot.source || !sameKnowledgeRecord(source, snapshot.source)) stale();
      const version = knowledgeRecordVersion(source), generation = snapshot.generation;
      checks.push(() => {
        if (knowledgeRecordVersion(store.getSource(id)) !== version || store.getSourceGeneration(id) !== generation) stale();
      });
      const extraction = store.getExtractionBySourceId(id);
      if (!extraction) continue;
      const extractionId = extraction.id, extractionSnapshot = store.getRecordSnapshot('extraction', extractionId);
      if (!extractionSnapshot.record || !sameKnowledgeRecord(extraction, extractionSnapshot.record)) stale();
      const extractionVersion = knowledgeRecordVersion(extraction), extractionGeneration = extractionSnapshot.generation;
      checks.push(() => {
        if (knowledgeRecordVersion(store.getExtractionBySourceId(id)) !== extractionVersion
          || store.getRecordGeneration('extraction', extractionId) !== extractionGeneration) stale();
      });
    }
    for (const node of input.nodes) {
      const { id } = node;
      const snapshot = store.getRecordSnapshot('node', id);
      if (!snapshot.record || !sameKnowledgeRecord(node, snapshot.record)) stale();
      const version = knowledgeRecordVersion(node), generation = snapshot.generation;
      checks.push(() => {
        if (knowledgeRecordVersion(store.getNode(id)) !== version || store.getRecordGeneration('node', id) !== generation) stale();
      });
    }
    for (const edge of input.edges) {
      const { id } = edge;
      const snapshot = store.getEdgeSnapshot(id);
      if (!snapshot.record || !sameKnowledgeRecord(edge, snapshot.record)) stale();
      edgeVersions.set(id, { version: knowledgeRecordVersion(edge), generation: snapshot.generation });
    }
  });
  return () => { frame(() => {
    for (const check of checks) check();
    const edges = new Map(store.listEdges().map(edge => [edge.id, edge]));
    for (const [id, { version, generation }] of edgeVersions) {
      if (knowledgeRecordVersion(edges.get(id)) !== version || store.getEdgeSnapshot(id).generation !== generation) stale();
    }
  }); };
}
