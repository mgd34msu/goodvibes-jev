import { createKnowledgeExtractionOwner } from './extraction-ownership.js';
import type { KnowledgeIngestOwnership } from './ingest-context.js';
import { createHash } from 'node:crypto';
import { snapshotNodeInput } from './activation/projection.js';
import { supportHash } from './semantic/verification/projection.js';
import { canonicalizeUri } from './shared.js';
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
  readonly assertCurrent: () => void;
}

// Callers cannot supply fabricated results or mutate the prepared extraction.
const prepared = new WeakMap<PreparedKnowledgeExtraction, PreparedContent>();

export async function prepareKnowledgeExtraction(
  context: KnowledgeIngestContext,
  sourceId: string,
  artifactId: string,
  ownership: KnowledgeIngestOwnership = {},
): Promise<PreparedKnowledgeExtraction> {
  const owner = createKnowledgeExtractionOwner(ownership);
  owner.assertCurrent();
  await context.store.init();
  owner.assertCurrent();
  const readRetained = () => ({ source: context.store.getSource(sourceId), extraction: context.store.getExtractionBySourceId(sourceId) });
  const retainedHash = supportHash(readRetained());
  const content = await context.artifactStore.readContent(artifactId);
  owner.assertCurrent();
  const record = snapshotNodeInput(content.record);
  const { buffer } = content;
  if (record.id !== artifactId || createHash('sha256').update(buffer).digest('hex') !== record.sha256) {
    throw new KnowledgeExtractionJudgmentHoldError();
  }
  const canonicalUri = canonicalizeUri(record.sourceUri ?? '');
  const canonicalSource = canonicalUri ? context.store.getSourceByCanonicalUri(canonicalUri)?.id : undefined;
  const recordHash = supportHash(record);
  const assertCurrent = () => {
    owner.assertCurrent();
    if (supportHash(readRetained()) !== retainedHash || supportHash(context.artifactStore.getRecord(artifactId)) !== recordHash
      || (canonicalUri ? context.store.getSourceByCanonicalUri(canonicalUri)?.id : undefined) !== canonicalSource) {
      throw new KnowledgeExtractionJudgmentHoldError();
    }
  };
  const extracted = snapshotNodeInput(await extractKnowledgeArtifact(record, buffer, owner));
  assertCurrent();
  const token = Object.freeze({ sourceId, artifactId, contentHash: record.sha256 });
  prepared.set(token, { record, extracted, assertCurrent });
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
  value.assertCurrent();
  prepared.delete(token);
  return value;
}
