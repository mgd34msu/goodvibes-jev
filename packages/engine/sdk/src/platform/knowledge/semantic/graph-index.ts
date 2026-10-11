import type { KnowledgeStore } from '../store.js';
import type { KnowledgeEdgeRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import { isActiveKnowledgeEdge } from '../projection-utils.js';
import { prepareKnowledgeScopeSelection, type KnowledgeScopeSelectionOptions } from '../scope-selection.js';

export interface KnowledgeSemanticGraphIndex {
  readonly edges: readonly KnowledgeEdgeRecord[];
  readonly nodesById: ReadonlyMap<string, KnowledgeNodeRecord>;
  readonly sourcesById: ReadonlyMap<string, KnowledgeSourceRecord>;
  readonly assertCurrent: () => void;
}

export async function buildKnowledgeSemanticGraphIndex(
  store: KnowledgeStore,
  spaceId: string,
  options: KnowledgeScopeSelectionOptions = {},
): Promise<KnowledgeSemanticGraphIndex> {
  await store.init();
  const selection = await prepareKnowledgeScopeSelection(store, { knowledgeSpaceId: spaceId }, {
    ...options, kinds: ['source', 'node'],
    sourceIds: store.listSourcesInSpace(spaceId).filter(source => source.status !== 'stale' && (!options.sourceIds || options.sourceIds.includes(source.id))).map(source => source.id),
    nodeIds: store.listNodesInSpace(spaceId).filter(node => node.status === 'active' && (!options.nodeIds || options.nodeIds.includes(node.id))).map(node => node.id),
  });
  const sources = selection.sources;
  const nodes = selection.nodes;
  const nodeIds = new Set(nodes.map(node => node.id));
  const sourceIds = new Set(sources.map(source => source.id));
  const includesEdge = (edge: KnowledgeEdgeRecord) => isActiveKnowledgeEdge(edge) && (
    (edge.fromKind !== 'node' || nodeIds.has(edge.fromId))
    && (edge.toKind !== 'node' || nodeIds.has(edge.toId))
    && (edge.fromKind !== 'source' || sourceIds.has(edge.fromId))
    && (edge.toKind !== 'source' || sourceIds.has(edge.toId))
  );
  const edges = selection.edges.filter(includesEdge);
  const assertEdgesCurrent = selection.retainEdges(edges, { sourceIds: [...sourceIds], nodeIds: [...nodeIds] });
  const assertCurrent = () => {
    store.assertRecordSnapshotFrame(() => {
      selection.assertCurrent();
      assertEdgesCurrent();
    });
  };
  assertCurrent();
  return { edges, nodesById: new Map(nodes.map(node => [node.id, node])),
    sourcesById: new Map(sources.map(source => [source.id, source])), assertCurrent };
}
