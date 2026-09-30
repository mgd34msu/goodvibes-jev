import { activationSourceIds, activationSubjectIds, projectNodeActivation, snapshotNodeInput } from '../activation/projection.js';
import { NODE_ACTIVATION_LIMITS, KnowledgeNodeActivationHeldError } from '../activation/types.js';
import type { KnowledgeStore } from '../store.js';
import { buildHomeGraphMetadata } from './helpers.js';
import { readHomeGraphState } from './state.js';
import type { HomeGraphExport } from './types.js';

export function exportHomeGraphSpace(
  store: KnowledgeStore,
  input: { readonly spaceId: string; readonly installationId: string },
): HomeGraphExport {
  const state = readHomeGraphState(store, input.spaceId);
  return {
    version: 1,
    exportedAt: Date.now(),
    spaceId: input.spaceId,
    installationId: input.installationId,
    sources: state.sources,
    nodes: state.nodes,
    edges: state.edges,
    issues: state.issues,
    extractions: state.extractions,
  };
}

export async function importHomeGraphSpace(
  store: KnowledgeStore,
  input: { readonly spaceId: string; readonly installationId: string; readonly data: HomeGraphExport },
): Promise<{
  readonly ok: true;
  readonly spaceId: string;
  readonly imported: { readonly sources: number; readonly nodes: number; readonly edges: number; readonly issues: number; readonly extractions: number };
}> {
  input = snapshotNodeInput(input);
  const sourceInputs = (input.data.sources ?? []).map((source) => ({ ...source, metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, source.metadata) }));
  const extractionInputs = (input.data.extractions ?? []).map((extraction) => ({ ...extraction, metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, extraction.metadata) }));
  const nodeInputs = (input.data.nodes ?? []).map((node) => ({ ...node, metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, node.metadata) }));
  if (nodeInputs.length > NODE_ACTIVATION_LIMITS.nodes) throw new KnowledgeNodeActivationHeldError('budget');
  await store.init();
  const sourceById = new Map(sourceInputs.map((source) => [source.id, source]));
  const extractionBySourceId = new Map(extractionInputs.map((extraction) => [extraction.sourceId, extraction]));
  const nodesById = new Map(nodeInputs.map((node) => [node.id, node]));
  // Preflight the complete selected import before its first source, extraction or node write.
  // Imported records are untrusted data; no observation or operator capability is minted.
  for (const node of nodeInputs) {
    projectNodeActivation(node, activationSourceIds(node).map((id) => ({ id,
      source: sourceById.get(id) ?? store.getSource(id), extraction: extractionBySourceId.get(id) ?? store.getExtractionBySourceId(id) })),
    activationSubjectIds(node).map((id) => ({ id, node: nodesById.get(id) ?? store.getNode(id) })));
    await store.assertNodeMutation(node);
  }
  let sources = 0;
  let nodes = 0;
  let edges = 0;
  let issues = 0;
  let extractions = 0;
  await store.batch(async () => {
    for (const source of sourceInputs) {
      await store.upsertSource(source);
      sources += 1;
    }
    for (const extraction of extractionInputs) {
      await store.upsertExtraction(extraction);
      extractions += 1;
    }
    const activation = await store.prepareNodeWrites(nodeInputs);
    store.assertPreparedNodeWrites(activation);
    for (let index = 0; index < nodeInputs.length; index++) {
      await store.upsertPreparedNode(activation, index);
      nodes += 1;
    }
    for (const edge of input.data.edges ?? []) {
      await store.upsertEdge({ ...edge, metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, edge.metadata) });
      edges += 1;
    }
    for (const issue of input.data.issues ?? []) {
      await store.upsertIssue({ ...issue, metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, issue.metadata) });
      issues += 1;
    }
  });
  return { ok: true, spaceId: input.spaceId, imported: { sources, nodes, edges, issues, extractions } };
}
