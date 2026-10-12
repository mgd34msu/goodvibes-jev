import { isGeneratedKnowledgeSource } from '../generated-projections.js';
import type { KnowledgeObjectProfilePolicy } from '../extensions.js';
import type {
  KnowledgeEdgeRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import {
  readString,
  readStringArray,
  uniqueStrings,
} from './utils.js';


export const BASE_OBJECT_PROFILES: readonly KnowledgeObjectProfilePolicy[] = [
  {
    id: 'base-knowledge-service',
    subjectKinds: ['service', 'provider', 'capability'],
    intrinsicFactKinds: ['identity', 'capability', 'configuration', 'troubleshooting'],
    searchHints: ['official documentation capabilities setup'],
  },
];

export function linkedObjectsForSource(
  sourceId: string,
  edges: readonly KnowledgeEdgeRecord[],
  nodesById: ReadonlyMap<string, KnowledgeNodeRecord>,
): KnowledgeNodeRecord[] {
  return uniqueById(edges
    .filter((edge) => edge.fromKind === 'source' && edge.fromId === sourceId && edge.toKind === 'node')
    .map((edge) => nodesById.get(edge.toId))
    .filter((node): node is KnowledgeNodeRecord => Boolean(node))
    .filter((node) => node.status !== 'stale')
    .filter((node) => node.metadata.semanticKind !== 'fact' && node.metadata.semanticKind !== 'gap' && node.kind !== 'wiki_page'));
}

export function factsForSource(
  sourceId: string,
  edges: readonly KnowledgeEdgeRecord[],
  nodesById: ReadonlyMap<string, KnowledgeNodeRecord>,
): KnowledgeNodeRecord[] {
  return uniqueById(edges
    .filter((edge) => edge.fromKind === 'source' && edge.fromId === sourceId && edge.toKind === 'node')
    .map((edge) => nodesById.get(edge.toId))
    .filter((node): node is KnowledgeNodeRecord => Boolean(node))
    .filter((node) => node.kind === 'fact' && node.status !== 'stale'));
}

export function sourcesForObject(
  objectId: string,
  edges: readonly KnowledgeEdgeRecord[],
  sourcesById: ReadonlyMap<string, KnowledgeSourceRecord>,
): KnowledgeSourceRecord[] {
  return uniqueById(edges
    .filter((edge) => edge.fromKind === 'source' && edge.toKind === 'node' && edge.toId === objectId)
    .map((edge) => sourcesById.get(edge.fromId))
    .filter((source): source is KnowledgeSourceRecord => Boolean(source))
    .filter((source) => source.status === 'indexed' && !isGeneratedKnowledgeSource(source)));
}

export function factsForObject(
  objectId: string,
  edges: readonly KnowledgeEdgeRecord[],
  nodesById: ReadonlyMap<string, KnowledgeNodeRecord>,
): KnowledgeNodeRecord[] {
  const directlyDescribing = edges
    .filter((edge) => edge.fromKind === 'node' && edge.toKind === 'node' && edge.toId === objectId && edge.relation === 'describes')
    .map((edge) => nodesById.get(edge.fromId));
  return uniqueById(directlyDescribing
    .filter((node): node is KnowledgeNodeRecord => Boolean(node))
    .filter((node) => node.kind === 'fact' && node.status !== 'stale'));
}

export function matchingObjectProfiles(
  nodes: readonly KnowledgeNodeRecord[],
  objectProfiles: readonly KnowledgeObjectProfilePolicy[],
): readonly KnowledgeObjectProfilePolicy[] {
  const kinds = new Set(nodes.map((node) => node.kind));
  return objectProfiles.filter((profile) => profile.subjectKinds.some((kind) => kinds.has(kind)));
}

/** Structural candidate selection; callers must consume a prepared usefulness plan. */
export function isSelfImprovementFactCandidate(fact: KnowledgeNodeRecord, subjectIds: ReadonlySet<string> = new Set()): boolean {
  if (fact.status !== 'active') return false;
  if (fact.metadata.semanticKind !== 'fact') return false;
  const kind = readString(fact.metadata.factKind);
  if (!['feature', 'capability', 'specification', 'compatibility', 'configuration', 'identity'].includes(kind ?? '')) return false;
  if (subjectIds.size === 0) return true;
  const linkedIds = uniqueStrings([
    ...readStringArray(fact.metadata.linkedObjectIds),
    ...readStringArray(fact.metadata.subjectIds),
  ]);
  return linkedIds.length > 0 && linkedIds.some((id) => subjectIds.has(id));
}

export function subjectTitle(subject: KnowledgeNodeRecord): string {
  return uniqueStrings([
    readString(subject.metadata.manufacturer),
    readString(subject.metadata.model),
    subject.title,
  ]).join(' ');
}

export function uniqueById<T extends { readonly id: string }>(items: readonly (T | undefined)[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}
