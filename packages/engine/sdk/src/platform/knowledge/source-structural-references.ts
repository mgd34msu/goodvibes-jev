import { createHash } from 'node:crypto';
import type { KnowledgeStore } from './store.js';
import type { KnowledgeExtractionRecord, KnowledgeSourceRecord } from './types.js';
import { KnowledgeGeneratedFactSupportHeldError } from './semantic/verification/types.js';

interface SourceIdentity { readonly id: string; readonly canonicalUri: string; readonly sourceUri?: string | undefined; }
interface ExtractionIdentity { readonly id: string; readonly sourceId: string; }
const sourceIdentities = new WeakMap<KnowledgeSourceRecord, SourceIdentity & { readonly store: KnowledgeStore; readonly hash: string }>();
const extractionIdentities = new WeakMap<KnowledgeExtractionRecord, ExtractionIdentity & { readonly store: KnowledgeStore; readonly hash: string }>();
const projections = new WeakMap<object, { readonly store: KnowledgeStore; readonly source: SourceIdentity;
  readonly sourceRecord: KnowledgeSourceRecord; readonly sourceHash: string; readonly extractionRecord: KnowledgeExtractionRecord | null;
  readonly extractionHash: string; readonly extraction?: ExtractionIdentity | undefined }>();
function fingerprint(value: unknown): string {
  let count = 0; const ancestors = new Set<object>();
  function check(item: unknown, depth: number): void {
    if (++count > 20_000 || depth > 64) throw new KnowledgeGeneratedFactSupportHeldError('malformed');
    if (item === null || item === undefined || typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return;
    if (typeof item !== 'object' || ancestors.has(item) || Object.getOwnPropertySymbols(item).length) throw new KnowledgeGeneratedFactSupportHeldError('malformed');
    const proto = Object.getPrototypeOf(item);
    if (Array.isArray(item) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new KnowledgeGeneratedFactSupportHeldError('malformed');
    ancestors.add(item);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(item))) {
      if (descriptor.get || descriptor.set) throw new KnowledgeGeneratedFactSupportHeldError('malformed');
      if (descriptor.enumerable) check(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  }
  check(value, 0); return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

/** Only a producer that just generated these exact local references may register them. No prefix/metadata inference. */
export function registerGeneratedKnowledgeSourceReferences(store: KnowledgeStore, source: KnowledgeSourceRecord, generated: SourceIdentity): void {
  if (store.getSource(source.id) !== source || source.id !== generated.id || source.canonicalUri !== generated.canonicalUri
    || (generated.sourceUri !== undefined && source.sourceUri !== generated.sourceUri)) throw new KnowledgeGeneratedFactSupportHeldError('stale');
  sourceIdentities.set(source, Object.freeze({ ...generated, store, hash: fingerprint(source) }));
}
/** A derived extraction ID is registered only against an already known generated source identity. */
export function registerGeneratedKnowledgeExtractionReferences(store: KnowledgeStore, source: KnowledgeSourceRecord, extraction: KnowledgeExtractionRecord, generatedId: string): void {
  if (currentSourceIdentity(source)?.store !== store) return;
  if (store.getSource(source.id) !== source || store.getExtractionBySourceId(source.id) !== extraction || extraction.id !== generatedId || extraction.sourceId !== source.id) throw new KnowledgeGeneratedFactSupportHeldError('stale');
  extractionIdentities.set(extraction, Object.freeze({ id: generatedId, sourceId: source.id, store, hash: fingerprint(extraction) }));
}
function currentSourceIdentity(source: KnowledgeSourceRecord) {
  const identity = sourceIdentities.get(source);
  if (identity && (identity.store.getSource(source.id) !== source || fingerprint(source) !== identity.hash)) throw new KnowledgeGeneratedFactSupportHeldError('stale');
  return identity;
}
/** Minimize only exact currently stored producer-minted URI fields. Copies retain ordinary preflight. */
export function knowledgeSourceJudgmentUris(source: KnowledgeSourceRecord) {
  const identity = currentSourceIdentity(source);
  return { url: source.url, sourceUri: identity?.sourceUri === undefined ? source.sourceUri : undefined,
    canonicalUri: identity ? undefined : source.canonicalUri };
}
/** Capture from actual current store records. The opaque proof is never serialized or recovered from JSON. */
export function captureKnowledgeSourceReferences(store: KnowledgeStore, source: KnowledgeSourceRecord | null, extraction: KnowledgeExtractionRecord | null): object | undefined {
  if (!source) return undefined;
  const identity = sourceIdentities.get(source);
  if (!identity || identity.store !== store || store.getSource(source.id) !== source
    || store.getExtractionBySourceId(source.id) !== extraction) return undefined;
  currentSourceIdentity(source);
  if (extraction && extraction.sourceId !== source.id) throw new KnowledgeGeneratedFactSupportHeldError('stale');
  const proof = Object.freeze({});
  const extractionIdentity = extraction ? extractionIdentities.get(extraction) : undefined;
  if (extractionIdentity && (extractionIdentity.store !== store || fingerprint(extraction) !== extractionIdentity.hash)) throw new KnowledgeGeneratedFactSupportHeldError('stale');
  projections.set(proof, { store, source: identity, sourceRecord: source, sourceHash: fingerprint(source),
    extractionRecord: extraction, extractionHash: fingerprint(extraction),
    extraction: extractionIdentity?.store === store ? extractionIdentity : undefined });
  return proof;
}
/** Read-set guards still bind full records; this proof concerns structural reference fields only. */
export function projectKnowledgeSourceReferences(source: KnowledgeSourceRecord, extraction: KnowledgeExtractionRecord | null | undefined, proof: object | undefined) {
  const known = proof ? projections.get(proof) : undefined;
  if (!known) return undefined;
  if (known.store.getSource(known.source.id) !== known.sourceRecord
    || known.store.getExtractionBySourceId(known.source.id) !== known.extractionRecord
    || fingerprint(source) !== known.sourceHash || fingerprint(extraction) !== known.extractionHash
    || fingerprint(known.sourceRecord) !== known.sourceHash || fingerprint(known.extractionRecord) !== known.extractionHash
    || source.id !== known.source.id || source.canonicalUri !== known.source.canonicalUri
    || (known.source.sourceUri !== undefined && source.sourceUri !== known.source.sourceUri)
    || (known.extraction && (extraction?.id !== known.extraction.id || extraction.sourceId !== known.extraction.sourceId))) {
    throw new KnowledgeGeneratedFactSupportHeldError('stale');
  }
  return { sourceId: 'source-reference', extractionId: known.extraction ? 'extraction-reference' : undefined,
    omitCanonicalUri: true, omitSourceUri: known.source.sourceUri !== undefined };
}
