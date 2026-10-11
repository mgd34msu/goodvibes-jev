import { KnowledgeSourceQualityHeldError } from './source-quality.js';
import { createHash } from 'node:crypto';
import type { ArtifactDescriptor } from '../artifacts/types.js';
import type { ArtifactStore } from '../artifacts/index.js';
import type { KnowledgeStore } from './store.js';
import type {
  KnowledgeEdgeRecord,
  KnowledgeSourceRecord,
  KnowledgeSourceType,
} from './types.js';
import { logger } from '../utils/logger.js';

export type GeneratedKnowledgeProjectionTargetKind = 'source' | 'node' | 'artifact';

export interface GeneratedKnowledgeProjectionInput {
  readonly store: KnowledgeStore;
  readonly artifactStore: ArtifactStore;
  readonly connectorId: string;
  readonly sourceId: string;
  readonly sourceType?: KnowledgeSourceType | undefined;
  readonly canonicalUri: string;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly filename: string;
  readonly markdown: string;
  readonly projectionKind: string;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly sourceMetadata?: Record<string, unknown> | undefined;
  readonly artifactMetadata?: Record<string, unknown> | undefined;
  readonly edgeMetadata?: Record<string, unknown> | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
  readonly target?: {
    readonly kind: GeneratedKnowledgeProjectionTargetKind;
    readonly id: string;
    readonly relation?: string | undefined;
  };
}

export interface GeneratedKnowledgeProjectionResult {
  readonly artifact: ArtifactDescriptor;
  readonly source: KnowledgeSourceRecord;
  readonly linked?: KnowledgeEdgeRecord | undefined;
  readonly artifactCreated: boolean;
}

export function generatedKnowledgeSourceId(kind: string, value: string): string {
  return `kg-gen-${stableHash(`${kind}:${value}`)}`;
}

export function generatedKnowledgeCanonicalUri(kind: string, value: string): string {
  return `knowledge://generated/${encodeURIComponent(kind)}/${stableHash(value, 20)}`;
}

export function isGeneratedKnowledgeSource(source: KnowledgeSourceRecord): boolean {
  return source.metadata.generatedKnowledgePage === true
    || source.metadata.generatedProjection === true;
}

export async function materializeGeneratedKnowledgeProjection(
  input: GeneratedKnowledgeProjectionInput,
): Promise<GeneratedKnowledgeProjectionResult> {
  const store = input.store, artifactStore = input.artifactStore;
  const authority = input.assertCurrent;
  const signal = input.signal;
  const existing = input.store.getSource(input.sourceId);
  const originalSourceVersion = JSON.stringify(existing);
  const target = input.target;
  const readTarget = () => !target ? null : target.kind === 'node' ? input.store.getNode(target.id)
    : target.kind === 'source' ? input.store.getSource(target.id) : input.artifactStore.getRecord(target.id);
  const originalTarget = readTarget(), targetVersion = JSON.stringify(originalTarget);
  const readLinked = () => !target ? undefined : input.store.edgesFor('source', input.sourceId).find((edge) =>
    edge.toKind === target.kind && edge.toId === target.id && edge.relation === (target.relation ?? 'source_for'));
  const originalLinked = readLinked(), linkedVersion = JSON.stringify(originalLinked);
  const outputState = () => JSON.stringify({ sourceId: input.sourceId, sourceType: input.sourceType, connectorId: input.connectorId,
    canonicalUri: input.canonicalUri, title: input.title, summary: input.summary, tags: input.tags, filename: input.filename,
    markdown: input.markdown, projectionKind: input.projectionKind, metadata: input.metadata, sourceMetadata: input.sourceMetadata,
    artifactMetadata: input.artifactMetadata, edgeMetadata: input.edgeMetadata, target: input.target });
  const outputVersion = outputState();
  const stale = () => { throw new KnowledgeSourceQualityHeldError('stale'); };
  const checkOwner = () => {
    throwIfAborted(signal); authority?.();
    if (authority && (input.store !== store || input.artifactStore !== artifactStore || input.assertCurrent !== authority || input.signal !== signal || outputState() !== outputVersion
      || readTarget() !== originalTarget || JSON.stringify(readTarget()) !== targetVersion)) stale();
  };
  const check = () => {
    checkOwner();
    if (authority && (input.store.getSource(input.sourceId) !== existing || JSON.stringify(input.store.getSource(input.sourceId)) !== originalSourceVersion
      || readLinked() !== originalLinked || JSON.stringify(readLinked()) !== linkedVersion)) stale();
  };
  check();
  const contentHash = stableHash(input.markdown, 40);
  const existingMetadata = readRecord(existing?.metadata);
  const existingGeneratedAt = typeof existingMetadata.generatedAt === 'number' ? existingMetadata.generatedAt : undefined;
  const contentUnchanged = existingMetadata.generatedContentHash === contentHash;
  const generatedAt = contentUnchanged && existingGeneratedAt !== undefined ? existingGeneratedAt : Date.now();
  const projectionMetadata = {
    ...(input.metadata ?? {}),
    generatedKnowledgePage: true,
    generatedProjection: true,
    projectionKind: input.projectionKind,
    generatedAt,
    generatedContentHash: contentHash,
    pageEditable: true,
  };
  if (input.target) {
    assertGeneratedProjectionTarget(input.artifactStore, input.store, {
      toKind: input.target.kind,
      toId: input.target.id,
    });
  }
  check();
  const reusedArtifact = await findReusableGeneratedArtifact(input.artifactStore, existing, input.markdown);
  check();
  const artifact = reusedArtifact ?? await input.artifactStore.create({
    kind: 'document',
    mimeType: 'text/markdown',
    filename: input.filename,
    text: input.markdown,
    retentionMs: 0,
    metadata: {
      ...projectionMetadata,
      ...(input.artifactMetadata ?? {}),
      generatedAt,
      generatedContentHash: contentHash,
    },
  });
  const sourceInput = {
    id: input.sourceId,
    connectorId: input.connectorId,
    sourceType: input.sourceType ?? 'document',
    title: input.title,
    sourceUri: input.canonicalUri,
    canonicalUri: input.canonicalUri,
    ...(input.summary ? { summary: input.summary } : {}),
    tags: uniqueStrings(input.tags ?? []),
    status: 'indexed' as const,
    artifactId: artifact.id,
    lastCrawledAt: contentUnchanged && typeof existing?.lastCrawledAt === 'number'
      ? existing.lastCrawledAt
      : generatedAt,
    metadata: {
      ...projectionMetadata,
      artifactId: artifact.id,
      filename: artifact.filename,
      ...(input.sourceMetadata ?? {}),
      generatedAt,
      generatedContentHash: contentHash,
    },
  };
  const edgeInput = input.target
    ? {
        fromKind: 'source' as const,
        fromId: input.sourceId,
        toKind: input.target.kind,
        toId: input.target.id,
        relation: input.target.relation ?? 'source_for',
        metadata: {
          generatedKnowledgePage: true,
          generatedProjection: true,
          projectionKind: input.projectionKind,
          ...(input.edgeMetadata ?? {}),
        },
      }
    : undefined;
  const existingLinked = edgeInput
    ? input.store.edgesFor(edgeInput.fromKind, edgeInput.fromId).find((edge) => (
        edge.toKind === edgeInput.toKind
        && edge.toId === edgeInput.toId
        && edge.relation === edgeInput.relation
      ))
    : undefined;
  let source: KnowledgeSourceRecord | undefined;
  let linked: KnowledgeEdgeRecord | undefined;
  try {
    check();
    if (authority) {
      const receipt = await input.store.applyPreparedIngest({ sources: [sourceInput], extractions: [], nodes: [], edges: [], issues: [] }, async () => ({
        nodes: [], edges: edgeInput ? [edgeInput] : [], issues: [], assertCurrent: check,
      }), { signal });
      checkOwner();
      source = receipt.sources.find((record) => record.id === input.sourceId);
      linked = edgeInput ? receipt.edges.find((record) => record.fromId === input.sourceId && record.toKind === edgeInput.toKind
        && record.toId === edgeInput.toId && record.relation === edgeInput.relation) : undefined;
      if (!source || input.store.getSource(input.sourceId) !== source || source.artifactId !== artifact.id
        || (edgeInput && (!linked || readLinked() !== linked))) stale();
    } else {
      source = await input.store.upsertSource(sourceInput);
      check();
      linked = edgeInput ? await input.store.upsertEdge(edgeInput) : undefined;
      check();
    }
  } catch (error) {
    if (authority) {
      // The guarded ingest either committed atomically under the original owner,
      // or made no mutation. Never overwrite a concurrent writer or compensate
      // an already valid commit after a later owner retirement.
      if (!reusedArtifact && !store.listSources().some((record) => record.artifactId === artifact.id)) artifactStore.delete(artifact.id);
      throw error;
    }
    if (!reusedArtifact) input.artifactStore.delete(artifact.id);
    const currentLinked = edgeInput
      ? input.store.edgesFor(edgeInput.fromKind, edgeInput.fromId).find((edge) => (
          edge.toKind === edgeInput.toKind
          && edge.toId === edgeInput.toId
          && edge.relation === edgeInput.relation
        ))
      : undefined;
    if (currentLinked && edgeInput) {
      if (existingLinked) {
        await input.store.replaceEdgeRecord(existingLinked);
      } else {
        await input.store.deleteEdge(currentLinked.id);
      }
    }
    const persistedSource = input.store.getSource(input.sourceId);
    if (!existing && persistedSource) {
      await input.store.deleteSource(persistedSource.id);
    } else if (existing && persistedSource) {
      await input.store.replaceSourceRecord(existing);
    }
    throw error;
  }
  if (!source) throw new Error(`Generated projection '${input.sourceId}' did not persist a source record.`);
  if (!reusedArtifact && existing?.artifactId && existing.artifactId !== artifact.id) {
    const existingArtifact = input.artifactStore.get(existing.artifactId);
    if (existingArtifact && readRecord(existingArtifact.metadata).generatedKnowledgePage === true
      && !input.store.listSources().some((record) => record.artifactId === existing.artifactId)) {
      input.artifactStore.delete(existing.artifactId);
    }
  }
  return {
    artifact,
    source,
    ...(linked ? { linked } : {}),
    artifactCreated: !reusedArtifact,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new Error('Generated knowledge projection was cancelled.');
}

function assertGeneratedProjectionTarget(
  artifactStore: ArtifactStore,
  store: KnowledgeStore,
  edge: {
    readonly toKind: string;
    readonly toId: string;
  },
): void {
  switch (edge.toKind) {
    case 'node':
      if (!store.getNode(edge.toId)) throw new Error(`Generated projection target node does not exist: ${edge.toId}`);
      return;
    case 'source':
      if (!store.getSource(edge.toId)) throw new Error(`Generated projection target source does not exist: ${edge.toId}`);
      return;
    case 'artifact':
      if (!artifactStore.get(edge.toId)) throw new Error(`Generated projection target artifact does not exist: ${edge.toId}`);
      return;
    default:
      throw new Error(`Generated projection target kind is not supported: ${edge.toKind}`);
  }
}

async function findReusableGeneratedArtifact(
  artifactStore: ArtifactStore,
  source: KnowledgeSourceRecord | null,
  markdown: string,
): Promise<ArtifactDescriptor | undefined> {
  if (!source?.artifactId) return undefined;
  const artifact = artifactStore.get(source.artifactId);
  if (!artifact) return undefined;
  try {
    const { buffer } = await artifactStore.readContent(artifact.id);
    return buffer.toString('utf-8') === markdown ? artifact : undefined;
  } catch (error) {
    logger.warn('Generated knowledge projection artifact reuse failed', {
      sourceId: source.id,
      artifactId: artifact.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function stableHash(value: string, length = 24): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function readRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function uniqueStrings(values: Iterable<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}
