import { createHash } from 'node:crypto';
import type { ArtifactRecord } from '../artifacts/types.js';
import { extractKnowledgeArtifact, type KnowledgeExtractionResult } from './extractors.js';
import { KnowledgeExtractionJudgmentHoldError } from './extraction-policy.js';
import type { KnowledgeIngestContext } from './ingest-context.js';

/** One-shot preparation, bound to one source and the exact retained artifact bytes. */
export interface PreparedKnowledgeExtraction {
  readonly sourceId: string;
  readonly artifactId: string;
  readonly contentHash: string;
}

interface PreparedContent {
  readonly record: ArtifactRecord;
  readonly extracted: KnowledgeExtractionResult;
}

// Callers cannot supply fabricated results or mutate the prepared extraction.
const prepared = new WeakMap<PreparedKnowledgeExtraction, PreparedContent>();

export async function prepareKnowledgeExtraction(
  context: KnowledgeIngestContext,
  sourceId: string,
  artifactId: string,
): Promise<PreparedKnowledgeExtraction> {
  const { record, buffer } = await context.artifactStore.readContent(artifactId);
  if (record.id !== artifactId || createHash('sha256').update(buffer).digest('hex') !== record.sha256) {
    throw new KnowledgeExtractionJudgmentHoldError();
  }
  const extracted = await extractKnowledgeArtifact(record, buffer);
  const token = Object.freeze({ sourceId, artifactId, contentHash: record.sha256 });
  prepared.set(token, { record, extracted });
  return token;
}

/** Consume once; changing the source, artifact, or artifact fingerprint holds. */
export function consumeKnowledgeExtraction(
  context: KnowledgeIngestContext,
  token: PreparedKnowledgeExtraction,
  sourceId: string,
  artifactId: string,
): PreparedContent {
  const value = prepared.get(token);
  const record = context.artifactStore.getRecord(artifactId);
  if (!value || token.sourceId !== sourceId || token.artifactId !== artifactId
    || !record || record.sha256 !== token.contentHash) {
    throw new KnowledgeExtractionJudgmentHoldError();
  }
  prepared.delete(token);
  return value;
}
