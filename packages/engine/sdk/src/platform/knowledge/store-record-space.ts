import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from './types.js';
import { DEFAULT_KNOWLEDGE_SPACE_ID, getExplicitKnowledgeSpaceId } from './spaces.js';

export function inferRecordReferenceSpaceId(input: {
  readonly sourceId?: string | null | undefined;
  readonly nodeId?: string | null | undefined;
  readonly metadata: Record<string, unknown>;
  readonly sources: ReadonlyMap<string, KnowledgeSourceRecord>;
  readonly nodes: ReadonlyMap<string, KnowledgeNodeRecord>;
}): string | null {
  const spaceIds = new Set<string>();
  for (const sourceId of uniqueReferenceIds([
    input.sourceId ?? undefined,
    readMetadataString(input.metadata.sourceId),
    ...readMetadataStringArray(input.metadata.sourceIds),
  ])) {
    const spaceId = getExplicitKnowledgeSpaceId(input.sources.get(sourceId));
    if (spaceId) spaceIds.add(spaceId);
  }
  for (const nodeId of uniqueReferenceIds([
    input.nodeId ?? undefined,
    readMetadataString(input.metadata.nodeId),
    ...readMetadataStringArray(input.metadata.linkedObjectIds),
    ...readMetadataStringArray(input.metadata.subjectIds),
  ])) {
    const spaceId = getExplicitKnowledgeSpaceId(input.nodes.get(nodeId));
    if (spaceId) spaceIds.add(spaceId);
  }
  return [...spaceIds].find((spaceId) => spaceId !== DEFAULT_KNOWLEDGE_SPACE_ID) ?? [...spaceIds][0] ?? null;
}

export function preferRelatedNonDefaultSpace(explicitSpaceId: string | null, relatedSpaceId: string | null): string | null {
  if (relatedSpaceId && relatedSpaceId !== DEFAULT_KNOWLEDGE_SPACE_ID && explicitSpaceId === DEFAULT_KNOWLEDGE_SPACE_ID) {
    return relatedSpaceId;
  }
  return explicitSpaceId ?? relatedSpaceId;
}

function readMetadataString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readMetadataStringArray(value: unknown): readonly string[] {
  if (typeof value === 'string' && value.trim().length > 0) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => readMetadataStringArray(entry));
}

function uniqueReferenceIds(values: readonly (string | undefined)[]): readonly string[] {
  return [...new Set(values.filter((entry): entry is string => Boolean(entry && entry.trim().length > 0)))];
}
