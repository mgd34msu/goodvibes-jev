import { registerGeneratedKnowledgeExtractionReferences } from '../source-structural-references.js';
import { JudgmentInputError } from '../../gate/judgment-input.js';
import { KnowledgeExtractionJudgmentHoldError } from '../extraction-policy.js';
import type { ArtifactStore } from '../../artifacts/index.js';
import type { ArtifactDescriptor } from '../../artifacts/types.js';
import { extractKnowledgeArtifact, type KnowledgeExtractionResult } from '../extractors.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeExtractionRecord, KnowledgeSourceRecord } from '../types.js';
import { autoLinkHomeGraphSources, type HomeGraphAutoLinkResult } from './auto-link.js';
import { buildHomeGraphMetadata } from './helpers.js';
import { readHomeGraphState } from './state.js';

interface HomeGraphExtractionContext {
  readonly store: KnowledgeStore;
  readonly artifactStore: ArtifactStore;
  readonly reportBackgroundError: (event: string, error: unknown, metadata: Record<string, unknown>) => void;
}

/** Read and judge before callers publish an indexed source or create graph links. */
export async function prepareHomeGraphArtifactExtraction(
  context: HomeGraphExtractionContext,
  sourceId: string,
  artifact: ArtifactDescriptor,
  spaceId: string,
): Promise<KnowledgeExtractionResult | undefined> {
  try {
    const record = context.artifactStore.getRecord(artifact.id);
    if (!record) return undefined;
    const { buffer } = await context.artifactStore.readContent(artifact.id);
    return await extractKnowledgeArtifact(record, buffer);
  } catch (error) {
    // Never turn a held judgment into a missing extraction and continue graph writes.
    if (error instanceof KnowledgeExtractionJudgmentHoldError || error instanceof JudgmentInputError) throw error;
    context.reportBackgroundError('homegraph-extract-artifact', error, { spaceId, sourceId, artifactId: artifact.id });
    return undefined;
  }
}

export async function storeHomeGraphArtifactExtraction(
  store: KnowledgeStore,
  source: KnowledgeSourceRecord,
  artifact: ArtifactDescriptor,
  spaceId: string,
  installationId: string,
  extracted: KnowledgeExtractionResult | undefined,
): Promise<KnowledgeExtractionRecord | undefined> {
  if (!extracted) return undefined;
  const existing = store.getExtractionBySourceId(source.id);
  const generatedId = `hg-extract-${source.id.replace(/^hg-src-/, '')}`;
  const record = await store.upsertExtraction({
    id: existing?.id ?? generatedId,
    sourceId: source.id,
    artifactId: artifact.id,
    extractorId: extracted.extractorId,
    format: extracted.format,
    title: extracted.title,
    summary: extracted.summary,
    excerpt: extracted.excerpt,
    sections: extracted.sections,
    links: extracted.links,
    estimatedTokens: extracted.estimatedTokens,
    structure: extracted.structure,
    metadata: buildHomeGraphMetadata(spaceId, installationId, extracted.metadata),
  });
  if (record.id === generatedId) registerGeneratedKnowledgeExtractionReferences(store, source, record, generatedId);
  return record;
}

export async function extractHomeGraphArtifact(
  context: HomeGraphExtractionContext,
  source: KnowledgeSourceRecord,
  artifact: ArtifactDescriptor,
  spaceId: string,
  installationId: string,
): Promise<KnowledgeExtractionRecord | undefined> {
  const extracted = await prepareHomeGraphArtifactExtraction(context, source.id, artifact, spaceId);
  return storeHomeGraphArtifactExtraction(context.store, source, artifact, spaceId, installationId, extracted);
}

export function autoLinkExistingHomeGraphSources(
  store: KnowledgeStore,
  spaceId: string,
  installationId: string,
  sourceIds?: readonly string[],
): Promise<readonly HomeGraphAutoLinkResult[]> {
  const state = readHomeGraphState(store, spaceId);
  const extractionBySourceId = new Map(state.extractions.map((extraction) => [extraction.sourceId, extraction]));
  const wanted = sourceIds && sourceIds.length > 0 ? new Set(sourceIds) : null;
  const sources = wanted ? state.sources.filter((source) => wanted.has(source.id)) : state.sources;
  return autoLinkHomeGraphSources({
    store,
    spaceId,
    installationId,
    sources,
    extractionBySourceId,
    state,
  });
}
