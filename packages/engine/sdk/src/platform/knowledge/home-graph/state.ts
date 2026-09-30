import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeEdgeRecord,
  KnowledgeExtractionRecord,
  KnowledgeIssueRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
  KnowledgeSourceType,
} from '../types.js';
import { belongsToSpace, edgeIsActive, readRecord, readStringArray } from './helpers.js';
import type { HomeGraphRenderState } from './rendering.js';
import { readHomeGraphQuality, HomeGraphQualityHeldError, type HomeGraphQualityQuestion } from './quality/reader.js';
import { projectHomeGraphQualityInput, readHomeGraphDeclaredBoolean } from './quality/projection.js';

export interface HomeGraphState extends Omit<HomeGraphRenderState, 'title'> {
  readonly extractions: readonly KnowledgeExtractionRecord[];
}

export function readHomeGraphState(store: KnowledgeStore, spaceId: string): HomeGraphState {
  const sources = store.listSourcesInSpace(spaceId).filter((source) => source.status !== 'stale');
  const nodes = store.listNodesInSpace(spaceId).filter((node) => node.status !== 'stale');
  const sourceIds = new Set(sources.map((source) => source.id));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = store.listEdges().filter((edge) => (
    edgeIsActive(edge)
    && belongsToSpace(edge, spaceId)
    && (edge.fromKind !== 'source' || sourceIds.has(edge.fromId))
    && (edge.toKind !== 'source' || sourceIds.has(edge.toId))
    && (edge.fromKind !== 'node' || nodeIds.has(edge.fromId))
    && (edge.toKind !== 'node' || nodeIds.has(edge.toId))
  ));
  const issues = store.listIssuesInSpace(spaceId).filter((issue) => (
    (!issue.sourceId || sourceIds.has(issue.sourceId))
    && (!issue.nodeId || nodeIds.has(issue.nodeId))
  ));
  const extractions = store.listExtractionsForSources(sourceIds);
  return { spaceId, sources, nodes, edges, issues, extractions };
}

/** Serving projections exclude pending review nodes while administrative state retains them. */
export function readHomeGraphServingState(store: KnowledgeStore, spaceId: string): HomeGraphState {
  const state = readHomeGraphState(store, spaceId);
  const nodes = state.nodes.filter((node) => node.status === 'active');
  const ids = new Set(nodes.map((node) => node.id));
  return { ...state, nodes, edges: state.edges.filter((edge) =>
    (edge.fromKind !== 'node' || ids.has(edge.fromId)) && (edge.toKind !== 'node' || ids.has(edge.toId))),
    issues: state.issues.filter((issue) => !issue.nodeId || ids.has(issue.nodeId)) };
}

export function renderHomeGraphState(store: KnowledgeStore, spaceId: string, title: string): HomeGraphRenderState {
  const state = readHomeGraphState(store, spaceId);
  return {
    spaceId,
    title,
    sources: state.sources,
    nodes: state.nodes,
    edges: state.edges,
    issues: state.issues,
  };
}

export function sourcesLinkedToNode(nodeId: string, state: HomeGraphState): KnowledgeSourceRecord[] {
  const sourceIds = sourceIdsLinkedToNodeThroughFacts(nodeId, state.edges);
  return state.sources.filter((source) => sourceIds.has(source.id));
}

export function collectLinkedObjects(
  results: readonly { readonly source?: KnowledgeSourceRecord | undefined; readonly node?: KnowledgeNodeRecord | undefined }[],
  state: {
    readonly edges: readonly KnowledgeEdgeRecord[];
    readonly nodes: readonly KnowledgeNodeRecord[];
  },
): KnowledgeNodeRecord[] {
  const nodeIds = new Set<string>();
  const factDescribes = factDescribesIndex(state.edges);
  for (const result of results) {
    if (result.node) nodeIds.add(result.node.id);
    if (result.source) {
      for (const edge of state.edges) {
        if (!edgeIsActive(edge)) continue;
        if (edge.fromKind === 'source' && edge.fromId === result.source.id && edge.toKind === 'node') {
          nodeIds.add(edge.toId);
          for (const describedNodeId of factDescribes.get(edge.toId) ?? []) nodeIds.add(describedNodeId);
        }
      }
      for (const id of sourceLinkedObjectIds(result.source)) {
        nodeIds.add(id);
      }
    }
  }
  return state.nodes.filter((node) => nodeIds.has(node.id));
}

function factDescribesIndex(edges: readonly KnowledgeEdgeRecord[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!edgeIsActive(edge)
      || edge.fromKind !== 'node'
      || edge.toKind !== 'node'
      || edge.relation !== 'describes') continue;
    const current = index.get(edge.fromId) ?? new Set<string>();
    current.add(edge.toId);
    index.set(edge.fromId, current);
  }
  return index;
}

function sourceIdsLinkedToNodeThroughFacts(nodeId: string, edges: readonly KnowledgeEdgeRecord[]): Set<string> {
  const sourceIds = new Set<string>();
  const factIds = new Set<string>();
  for (const edge of edges) {
    if (!edgeIsActive(edge)) continue;
    if (edge.fromKind === 'source' && edge.toKind === 'node' && edge.toId === nodeId) sourceIds.add(edge.fromId);
    if (edge.fromKind === 'node' && edge.toKind === 'source' && edge.fromId === nodeId) sourceIds.add(edge.toId);
    if (edge.fromKind === 'node' && edge.toKind === 'node' && edge.toId === nodeId && edge.relation === 'describes') {
      factIds.add(edge.fromId);
    }
  }
  for (const edge of edges) {
    if (!edgeIsActive(edge)) continue;
    if (edge.fromKind === 'source' && edge.toKind === 'node' && factIds.has(edge.toId) && edge.relation === 'supports_fact') {
      sourceIds.add(edge.fromId);
    }
  }
  return sourceIds;
}

function sourceLinkedObjectIds(source: KnowledgeSourceRecord): string[] {
  const metadata = source.metadata ?? {};
  const discovery = readRecord(metadata.sourceDiscovery);
  return [
    ...readStringArray(metadata.linkedObjectIds),
    ...readStringArray(discovery.linkedObjectIds),
  ];
}

/** An uncertain completeness reading holds the caller before any generated-page write. */
export async function missingDevicePassportFields(
  device: KnowledgeNodeRecord,
  sources: readonly KnowledgeSourceRecord[],
  facts: readonly KnowledgeNodeRecord[] = [],
  options: { readonly entities?: readonly KnowledgeNodeRecord[] | undefined; readonly signal?: AbortSignal | undefined; readonly timeoutMs?: number | undefined } = {},
): Promise<string[]> {
  const manufacturer = typeof device.metadata.manufacturer === 'string';
  const model = typeof device.metadata.model === 'string';
  const batteryType = typeof device.metadata.batteryType === 'string' && device.metadata.batteryType.trim().length > 0;
  const battery = batteryType ? false : readHomeGraphDeclaredBoolean(device.metadata.batteryPowered);
  const questions: HomeGraphQualityQuestion[] = [];
  if (!manufacturer && facts.length) questions.push('manufacturerPresent');
  if (!model && facts.length) questions.push('modelPresent');
  if (battery === undefined) questions.push('batteryApplicable');
  if (battery !== false && facts.length) questions.push('batteryTypePresent');
  if (options.signal?.aborted) throw new HomeGraphQualityHeldError('aborted');
  if (!questions.length) return [manufacturer ? '' : 'manufacturer', model ? '' : 'model', battery ? 'battery type' : '', sources.length ? '' : 'manual/source'].filter(Boolean);
  const input = projectHomeGraphQualityInput('device-1', device, options.entities ?? [], facts, questions);
  const [reading] = await readHomeGraphQuality([input], options);
  return [
    manufacturer || reading!.answers.manufacturerPresent ? '' : 'manufacturer',
    model || reading!.answers.modelPresent ? '' : 'model',
    (battery ?? reading!.answers.batteryApplicable) && !reading!.answers.batteryTypePresent ? 'battery type' : '',
    sources.length > 0 ? '' : 'manual/source',
  ].filter(Boolean);
}

export function findHomeAssistantNode(
  nodes: readonly KnowledgeNodeRecord[],
  kind: string,
  id: string,
): KnowledgeNodeRecord | undefined {
  return nodes.find((node) => node.kind === kind && (
    node.id === id
    || readHomeAssistantString(node, 'objectId') === id
    || readHomeAssistantString(node, 'deviceId') === id
    || readHomeAssistantString(node, 'areaId') === id
  ));
}

export function inferHomeGraphSourceType(
  tags: readonly string[] | undefined,
  fallback: KnowledgeSourceType,
): KnowledgeSourceType {
  const normalized = new Set((tags ?? []).map((tag) => tag.toLowerCase()));
  if (normalized.has('manual')) return 'manual';
  if (normalized.has('receipt') || normalized.has('warranty')) return 'document';
  if (normalized.has('photo') || normalized.has('image')) return 'image';
  return fallback;
}

export function safeHomeGraphFilename(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'home-graph';
}

export function renderAskAnswer(
  query: string,
  results: readonly { readonly title: string; readonly summary?: string | undefined; readonly excerpt?: string | undefined; readonly source?: KnowledgeSourceRecord | undefined; readonly node?: KnowledgeNodeRecord | undefined }[],
  mode: 'concise' | 'standard' | 'detailed',
): string {
  if (results.length === 0) {
    return `No Home Graph knowledge matched "${query}".`;
  }
  const lines = results.slice(0, mode === 'detailed' ? 5 : mode === 'concise' ? 1 : 3).map((result) => {
    const detail = result.excerpt ?? result.summary ?? result.source?.description ?? result.source?.sourceUri ?? '';
    return detail ? `${result.title}: ${detail}` : result.title;
  });
  return mode === 'concise' ? lines[0]! : lines.map((line) => `- ${line}`).join('\n');
}

export function edgeConnectsNode(edge: KnowledgeEdgeRecord, nodeId: string, relation: string, toId: string): boolean {
  return edgeIsActive(edge)
    && edge.fromKind === 'node'
    && edge.fromId === nodeId
    && edge.toKind === 'node'
    && edge.toId === toId
    && edge.relation === relation;
}

function readHomeAssistantString(node: KnowledgeNodeRecord, key: string): string | undefined {
  const homeAssistant = readRecord(node.metadata.homeAssistant);
  const value = homeAssistant[key]!;
  return typeof value === 'string' ? value : undefined;
}
