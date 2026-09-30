import type { KnowledgeStore } from '../store.js';
import { getKnowledgeSpaceId } from '../spaces.js';
import type { KnowledgeEdgeRecord, KnowledgeNodeRecord } from '../types.js';
import { isActiveKnowledgeEdge } from '../projection-utils.js';
import { readString, readStringArray, semanticMetadata, uniqueStrings } from './utils.js';
import type { SemanticPrimarySourcePlanner, SemanticWriteGuard } from './primary-source-plan.js';

/** Capture supersession from the original graph, before any entity/fact writes. */
export function prepareSemanticSupersession(
  store: KnowledgeStore, sourceId: string, spaceId: string, activeIds: ReadonlySet<string>,
  guard: SemanticWriteGuard, planner: SemanticPrimarySourcePlanner,
) {
  const readSuperseded = () => store.listNodesInSpace(spaceId).filter((node) => (
    semanticNodeReferencesSource(node, sourceId) && typeof node.metadata.semanticKind === 'string'
    && node.status !== 'stale' && !activeIds.has(node.id)
  ));
  const nodes = guard.watch('supersession-nodes', readSuperseded);
  const drafts = nodes.map((node) => {
    guard.node(node.id);
    const supportingSourceIds = node.metadata.semanticKind === 'fact'
      ? activeSemanticFactSupportSourceIds(store, node, sourceId, spaceId, guard) : [];
    const subjectIds = uniqueStrings([...readStringArray(node.metadata.subjectIds), ...readStringArray(node.metadata.linkedObjectIds)]);
    const subjects = subjectIds.map((id) => guard.node(id)).filter((subject): subject is KnowledgeNodeRecord => Boolean(subject));
    return { node, supportingSourceIds, resolve: supportingSourceIds.length === 0 ? undefined : planner.prepare(spaceId, {
      kind: readString(node.metadata.factKind) ?? node.kind, title: node.title, summary: node.summary,
      value: node.metadata.value, evidence: node.metadata.evidence, subject: node.metadata.subject, targetHints: node.metadata.targetHints,
      subjects: subjects.map(({ id, title, kind }) => ({ id, title, kind })),
    }, supportingSourceIds) };
  });
  const factIds = new Set(nodes.map((node) => node.id));
  guard.watch('supersession-supports', () => store.listEdges().filter((edge) => edge.toKind === 'node' && factIds.has(edge.toId)));
  return async () => {
    const plans: Array<{ node: KnowledgeNodeRecord; supportingSourceIds: string[]; primarySourceId: string | undefined }> = [];
    for (const draft of drafts) plans.push({ ...draft, primarySourceId: await draft.resolve?.() });
    return async () => {
      const supersededAt = Date.now();
      for (const { node, supportingSourceIds, primarySourceId } of plans) {
        if (primarySourceId) {
          await deactivateSemanticFactSupport(store, sourceId, node.id, spaceId, supersededAt);
          await store.upsertNode({ ...node, sourceId: primarySourceId, metadata: semanticMetadata(spaceId, {
            ...node.metadata, sourceId: primarySourceId, sourceIds: supportingSourceIds,
            detachedSourceIds: uniqueStrings([...readStringArray(node.metadata.detachedSourceIds), sourceId]), sourceDetachedAt: supersededAt,
          }) });
        } else {
          await store.upsertNode({ ...node, status: 'stale', metadata: {
            ...node.metadata, supersededAt, supersededInSpaceId: spaceId,
          } });
        }
      }
    };
  };
}

function semanticNodeReferencesSource(node: KnowledgeNodeRecord, sourceId: string): boolean {
  if (node.sourceId === sourceId) return true;
  if (readString(node.metadata.sourceId) === sourceId) return true;
  return node.metadata.semanticKind === 'fact' && readStringArray(node.metadata.sourceIds).includes(sourceId);
}

function activeSemanticFactSupportSourceIds(
  store: KnowledgeStore,
  fact: KnowledgeNodeRecord,
  supersededSourceId: string,
  spaceId: string,
  guard: SemanticWriteGuard,
): string[] {
  return uniqueStrings([
    ...readStringArray(fact.metadata.sourceIds),
    readString(fact.metadata.sourceId),
    fact.sourceId,
    ...store.listEdges()
      .filter((edge) => edgeSupportsFact(edge, fact.id, spaceId))
      .map((edge) => edge.fromId),
  ])
    .filter((sourceId) => sourceId !== supersededSourceId)
    .filter((sourceId) => {
      const source = guard.source(sourceId);
      return Boolean(source && source.status === 'indexed' && getKnowledgeSpaceId(source) === spaceId);
    });
}

async function deactivateSemanticFactSupport(
  store: KnowledgeStore,
  sourceId: string,
  factId: string,
  spaceId: string,
  supersededAt: number,
): Promise<void> {
  const edges = store.listEdges().filter((edge) => (
    edge.fromKind === 'source'
    && edge.fromId === sourceId
    && edge.toKind === 'node'
    && edge.toId === factId
    && edge.relation === 'supports_fact'
    && isActiveKnowledgeEdge(edge)
  ));
  for (const edge of edges) {
    await store.upsertEdge({
      fromKind: edge.fromKind,
      fromId: edge.fromId,
      toKind: edge.toKind,
      toId: edge.toId,
      relation: edge.relation,
      weight: 0,
      metadata: semanticMetadata(spaceId, {
        ...edge.metadata,
        deleted: true,
        supersededAt,
      }),
    });
  }
}

function edgeSupportsFact(edge: KnowledgeEdgeRecord, factId: string, spaceId: string): boolean {
  return isActiveKnowledgeEdge(edge)
    && edge.fromKind === 'source'
    && edge.toKind === 'node'
    && edge.toId === factId
    && edge.relation === 'supports_fact'
    && getKnowledgeSpaceId(edge) === spaceId;
}
