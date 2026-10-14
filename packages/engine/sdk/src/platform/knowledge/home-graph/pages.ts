import { rankHomeGraphPageCandidates, HomeGraphPagePriorityHeldError } from './page-priority.js';
import type { ArtifactStore } from '../../artifacts/index.js';
import type { KnowledgeStore } from '../store.js';
import {
  listGeneratedKnowledgePages,
  type GeneratedKnowledgePageGraph,
} from '../generated-pages.js';
import type { KnowledgeEdgeRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import { isGeneratedPageSource, readRecord } from './helpers.js';
import type { HomeGraphPageGraphNode, HomeGraphPageListResult } from './types.js';

export async function listHomeGraphPages(input: {
  readonly artifactStore: ArtifactStore;
  readonly store?: KnowledgeStore;
  readonly spaceId: string;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly nodes: readonly KnowledgeNodeRecord[];
  readonly edges: readonly KnowledgeEdgeRecord[];
  readonly limit: number;
  readonly includeMarkdown: boolean;
  readonly signal?: AbortSignal;
  readonly assertCurrent?: () => void;
}): Promise<HomeGraphPageListResult> {
  const state = () => JSON.stringify({ sources: input.sources, nodes: input.nodes, edges: input.edges });
  const original = state();
  const assertCurrent = () => {
    input.assertCurrent?.();
    if (state() !== original) throw new HomeGraphPagePriorityHeldError('stale');
  };
  const result = await listGeneratedKnowledgePages<HomeGraphPageGraphNode>({
    artifactStore: input.artifactStore,
    spaceId: input.spaceId,
    sources: input.sources,
    nodes: input.nodes,
    edges: input.edges,
    limit: input.limit,
    includeMarkdown: input.includeMarkdown,
    isGeneratedSource: isGeneratedPageSource,
    isPageSubjectNode,
    resolvePageSubject,
    projectNode: pageGraphNode,
    rankGeneratedPages: (sources, graph) => rankHomeGraphPageCandidates({
      candidates: sources, store: input.store, purpose: 'Order useful generated home references for the owner',
      signal: input.signal, assertCurrent,
      content: source => {
        const target = graph.targetBySourceId.get(source.id);
        const subject = target ? resolvePageSubject(target, graph) : undefined;
        return { title: source.title, summary: source.summary, projectionKind: source.metadata.projectionKind,
          ...(target ? { target: prioritySubject(target) } : {}),
          ...(subject ? { subject: prioritySubject(subject) } : {}) };
      },
    }),
  });
  assertCurrent();
  return result;
}

function resolvePageSubject(target: KnowledgeNodeRecord, graph: GeneratedKnowledgePageGraph): KnowledgeNodeRecord | undefined {
  if (target.kind === 'ha_device_passport') {
    const deviceEdge = graph.edges.find((edge) => (
      edge.fromKind === 'node'
      && edge.fromId === target.id
      && edge.toKind === 'node'
      && edge.relation === 'source_for'
    ));
    return deviceEdge ? graph.nodesById.get(deviceEdge.toId) : undefined;
  }
  if (isPageSubjectNode(target)) return target;
  return undefined;
}

function isPageSubjectNode(node: KnowledgeNodeRecord): boolean {
  if (node.status === 'stale') return false;
  if (node.metadata.semanticKind) return false;
  return !['fact', 'knowledge_gap', 'wiki_page', 'ha_device_passport'].includes(node.kind);
}

function pageGraphNode(node: KnowledgeNodeRecord): HomeGraphPageGraphNode {
  const ha = readRecord(node.metadata.homeAssistant);
  return {
    id: node.id,
    kind: node.kind,
    title: node.title,
    ...(typeof ha.objectKind === 'string' ? { objectKind: ha.objectKind } : {}),
    ...(typeof ha.objectId === 'string' ? { objectId: ha.objectId } : {}),
    ...(typeof ha.entityId === 'string' ? { entityId: ha.entityId } : {}),
    ...(typeof ha.deviceId === 'string' ? { deviceId: ha.deviceId } : {}),
    ...(typeof ha.areaId === 'string' ? { areaId: ha.areaId } : {}),
    ...(typeof ha.integrationId === 'string' ? { integrationId: ha.integrationId } : {}),
  };
}

export function prioritySubject(node: KnowledgeNodeRecord) {
  const ha = readRecord(node.metadata.homeAssistant);
  return {
    kind: node.kind, title: node.title, summary: node.summary,
    manufacturer: node.metadata.manufacturer, model: node.metadata.model,
    objectKind: ha.objectKind, domain: ha.domain ?? node.metadata.domain,
  };
}
