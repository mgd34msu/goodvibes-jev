import { snapshotNodeInput } from './activation/projection.js';
import { KnowledgeEntityAliasHoldError } from './entity-aliases.js';
import type { KnowledgeIngestContext } from './ingest-context.js';
import { supportHash } from './semantic/verification/projection.js';
import { prepareKnowledgeSourceRecord } from './store-evidence-writes.js';
import type { KnowledgeSourceRecord, KnowledgeSourceUpsertInput } from './types.js';

/** Pending is a local draft until every required ingest reading has settled. */
export function stageKnowledgePendingSource(context: KnowledgeIngestContext,
  input: KnowledgeSourceUpsertInput & { readonly id: string }): KnowledgeSourceRecord {
  return snapshotNodeInput(prepareKnowledgeSourceRecord(input, context.store.getSource(input.id)));
}

/** Bind asynchronous preparation to retained state, including a newly reserved URI. */
export function knowledgeIngestGuard(context: KnowledgeIngestContext, sourceId: string,
  canonicalUri?: string, signal?: AbortSignal): () => void {
  const read = () => ({ source: context.store.getSource(sourceId), extraction: context.store.getExtractionBySourceId(sourceId),
    canonicalSource: canonicalUri ? context.store.getSourceByCanonicalUri(canonicalUri)?.id : undefined });
  const expected = supportHash(read());
  return () => {
    if (signal?.aborted || supportHash(read()) !== expected) throw new KnowledgeEntityAliasHoldError();
  };
}
