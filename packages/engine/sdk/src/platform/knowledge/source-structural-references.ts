import { createHash } from 'node:crypto';
import type { KnowledgeStore } from './store.js';
import type { KnowledgeExtractionRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from './types.js';
import { KnowledgeGeneratedFactSupportHeldError } from './semantic/verification/types.js';
import { captureOwnedJson } from '../gate/judgment-input.js';
import { captureStrictJudgmentJson } from '../gate/judgment-result.js';
import { knowledgeJudgmentRepresentation, knowledgeRecordVersion, sameKnowledgeRecord } from './store-record-representation.js';

// Native registry lookups cannot be replaced by a later prototype override.
const weakMapGet = WeakMap.prototype.get, weakMapSet = WeakMap.prototype.set, applyWeakMap = Reflect.apply;
function readNativeReference<K extends object, V>(map: WeakMap<K, V>, key: K): V | undefined {
  return applyWeakMap(weakMapGet, map, [key]) as V | undefined;
}
function writeNativeReference<K extends object, V>(map: WeakMap<K, V>, key: K, value: V): void {
  applyWeakMap(weakMapSet, map, [key, value]);
}

interface SourceIdentity { readonly id: string; readonly canonicalUri: string; readonly sourceUri?: string | undefined; }
interface ExtractionIdentity { readonly id: string; readonly sourceId: string; }
const sourceIdentities = new WeakMap<KnowledgeSourceRecord, SourceIdentity & { readonly store: KnowledgeStore; readonly hash: string }>();
const answerAliases = new WeakMap<KnowledgeSourceRecord, { readonly original: KnowledgeSourceRecord; readonly hash: string }>();
const extractionIdentities = new WeakMap<KnowledgeExtractionRecord, ExtractionIdentity & { readonly store: KnowledgeStore; readonly hash: string }>();
const activationReferences = new WeakMap<KnowledgeNodeRecord, { readonly store: KnowledgeStore; readonly original: unknown;
  readonly evidence: readonly { readonly source: KnowledgeSourceRecord | null; readonly extraction: KnowledgeExtractionRecord | null; readonly proof: object | undefined }[] }>();
const projections = new WeakMap<object, { readonly store: KnowledgeStore; readonly source: SourceIdentity;
  readonly sourceRecord: KnowledgeSourceRecord; readonly sourceHash: string; readonly extractionRecord: KnowledgeExtractionRecord | null;
  readonly extractionHash: string; readonly extraction?: ExtractionIdentity | undefined }>();
function fingerprint(value: unknown): string {
  try { return createHash('sha256').update(knowledgeRecordVersion(captureStrictJudgmentJson(value))).digest('hex'); }
  catch { throw new KnowledgeGeneratedFactSupportHeldError('malformed'); }
}

/** Only a producer that just generated these exact local references may register them. No prefix/metadata inference. */
export function registerGeneratedKnowledgeSourceReferences(store: KnowledgeStore, source: KnowledgeSourceRecord, generated: SourceIdentity): void {
  if (store.getSource(source.id) !== source || source.id !== generated.id || source.canonicalUri !== generated.canonicalUri
    || (generated.sourceUri !== undefined && source.sourceUri !== generated.sourceUri)) throw new KnowledgeGeneratedFactSupportHeldError('stale');
  writeNativeReference(sourceIdentities, source, Object.freeze({ ...generated, store, hash: fingerprint(source) }));
}

/** Retain native reference facts through the producer's own record update.
 * The original observation retires; the updated row still gets full preflight. */
export function captureGeneratedKnowledgeSourceUpdate(store: KnowledgeStore, source: KnowledgeSourceRecord): ((updated: KnowledgeSourceRecord) => void) | undefined {
  const known = currentSourceIdentity(source);
  if (!known || known.store !== store) return undefined;
  let published = false;
  return updated => {
    if (published || fingerprint(source) !== known.hash) throw new KnowledgeGeneratedFactSupportHeldError('stale');
    published = true;
    registerGeneratedKnowledgeSourceReferences(store, updated, known);
  };
}
/** A derived extraction ID is registered only against an already known generated source identity. */
export function registerGeneratedKnowledgeExtractionReferences(store: KnowledgeStore, source: KnowledgeSourceRecord, extraction: KnowledgeExtractionRecord, generatedId: string): void {
  if (currentSourceIdentity(source)?.store !== store) return;
  if (store.getSource(source.id) !== source || store.getExtractionBySourceId(source.id) !== extraction || extraction.id !== generatedId || extraction.sourceId !== source.id) throw new KnowledgeGeneratedFactSupportHeldError('stale');
  writeNativeReference(extractionIdentities, extraction, Object.freeze({ id: generatedId, sourceId: source.id, store, hash: fingerprint(extraction) }));
}
function currentSourceIdentity(source: KnowledgeSourceRecord) {
  const identity = readNativeReference(sourceIdentities, source);
  if (identity && (identity.store.getSource(source.id) !== source || fingerprint(source) !== identity.hash)) throw new KnowledgeGeneratedFactSupportHeldError('stale');
  return identity;
}

/** Issued by the native activation writer for its actual generated receipt. */
export function retainKnowledgeNodeActivationReferences(store: KnowledgeStore, record: KnowledgeNodeRecord,
  evidence: readonly { readonly source: KnowledgeSourceRecord | null; readonly extraction: KnowledgeExtractionRecord | null }[],
  proofs: readonly (object | undefined)[]): void {
  writeNativeReference(activationReferences, record, { store, original: captureOwnedJson(record),
    evidence: evidence.map((entry, index) => ({ ...entry, proof: proofs[index] })) });
}

export function projectKnowledgeNodeActivationMetadata(store: KnowledgeStore, node: KnowledgeNodeRecord, metadata: unknown): unknown {
  const known = readNativeReference(activationReferences, node);
  if (!known) return metadata;
  if (known.store !== store || store.getNode(node.id) !== node || !sameKnowledgeRecord(known.original, node)) throw new KnowledgeGeneratedFactSupportHeldError('stale');
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return metadata;
  const activation: unknown = Object.getOwnPropertyDescriptor(metadata, 'nodeActivation')?.value;
  if (!activation || typeof activation !== 'object' || Array.isArray(activation)) return metadata;
  const projected: Record<string, unknown> = { ...activation, candidateHash: 'activation-candidate-reference', evidenceHash: 'activation-evidence-reference' };
  const evidence: unknown = Object.getOwnPropertyDescriptor(activation, 'evidence')?.value;
  if (Array.isArray(evidence)) projected.evidence = evidence.map((entry: unknown, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const native = known.evidence[index];
    const references = native?.source ? projectKnowledgeSourceReferences(native.source, native.extraction, native.proof) : undefined;
    return { ...entry, sourceHash: 'activation-source-content-reference', extractionHash: 'activation-extraction-content-reference',
      ...(references ? { sourceId: references.sourceId, ...(references.extractionId ? { extractionId: references.extractionId } : {}) } : {}) };
  });
  const subjects: unknown = Object.getOwnPropertyDescriptor(activation, 'subjects')?.value;
  if (Array.isArray(subjects)) projected.subjects = subjects.map((entry: unknown) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? { ...entry, nodeHash: 'activation-subject-content-reference' } : entry);
  return { ...metadata, nodeActivation: projected };
}

/** Page ranking may omit only references backed by the exact current native
 * source and store. All other fields, including metadata, retain full preflight. */
export function knowledgePageCandidateRepresentation(store: KnowledgeStore | undefined, candidate: unknown): unknown {
  captureOwnedJson(candidate);
  const raw = captureOwnedJson(knowledgeJudgmentRepresentation(candidate));
  if (!store || !raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const slots = Object.getOwnPropertyDescriptors(raw);
  const id: unknown = slots.id?.value;
  if (typeof id !== 'string') return raw;
  const replacements = new Map<string, unknown>();
  const source = store.getSource(id);
  if (source && source === candidate) {
    const identity = currentSourceIdentity(source);
    if (identity?.store !== store) return raw;
    replacements.set('id', 'source-reference');
    replacements.set('canonicalUri', undefined);
    if (identity.sourceUri !== undefined) replacements.set('sourceUri', undefined);
  } else {
    const node = store.getNode(id);
    if (!node || node !== candidate) return raw;
    // Persisted native rows have plain JSON slots. A newly attached hidden
    // subtree cannot inherit their stored representation or reference proof.
    try { captureStrictJudgmentJson(node); } catch { throw new KnowledgeGeneratedFactSupportHeldError('malformed'); }
    replacements.set('metadata', projectKnowledgeNodeActivationMetadata(store, node, slots.metadata?.value));
    const sourceId: unknown = slots.sourceId?.value;
    if (typeof sourceId === 'string') {
      const origin = store.getSource(sourceId);
      if (origin && currentSourceIdentity(origin)?.store === store) replacements.set('sourceId', 'source-reference');
    }
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(slots)) {
    Object.defineProperty(result, key, { ...descriptor, value: replacements.has(key) ? replacements.get(key) : descriptor.value });
  }
  return captureOwnedJson(result);
}
/** Minimize only exact currently stored producer-minted URI fields. Copies retain ordinary preflight. */
export function knowledgeSourceJudgmentUris(source: KnowledgeSourceRecord) {
  const identity = currentSourceIdentity(source);
  return { url: source.url, sourceUri: identity?.sourceUri === undefined ? source.sourceUri : undefined,
    canonicalUri: identity ? undefined : source.canonicalUri };
}
/** Only this owned projection may recover a producer-minted source for local bookkeeping.
 * A JSON copy, caller-created alias, changed projection, or reopened store cannot inherit it.
 * The consumer still reads the full original content through ordinary judgment preflight.
 */
export function withKnowledgeSourceAnswerAliases(source: KnowledgeSourceRecord): KnowledgeSourceRecord {
  const identity = currentSourceIdentity(source);
  const result = { ...source, sourceId: source.id, url: source.sourceUri ?? source.canonicalUri };
  if (identity) writeNativeReference(answerAliases, result, { original: source, hash: fingerprint(result) });
  return result;
}
export function restoreKnowledgeSourceAnswerAliases(store: KnowledgeStore, source: KnowledgeSourceRecord): KnowledgeSourceRecord {
  const known = readNativeReference(answerAliases, source);
  if (!known) return source;
  const identity = currentSourceIdentity(known.original);
  if (!identity || identity.store !== store || fingerprint(source) !== known.hash) {
    throw new KnowledgeGeneratedFactSupportHeldError('stale');
  }
  return known.original;
}
/** Capture from actual current store records. The opaque proof is never serialized or recovered from JSON. */
export function captureKnowledgeSourceReferences(store: KnowledgeStore, source: KnowledgeSourceRecord | null, extraction: KnowledgeExtractionRecord | null): object | undefined {
  if (!source) return undefined;
  const identity = readNativeReference(sourceIdentities, source);
  if (!identity || identity.store !== store || store.getSource(source.id) !== source
    || store.getExtractionBySourceId(source.id) !== extraction) return undefined;
  currentSourceIdentity(source);
  if (extraction && extraction.sourceId !== source.id) throw new KnowledgeGeneratedFactSupportHeldError('stale');
  const proof = Object.freeze({});
  const extractionIdentity = extraction ? readNativeReference(extractionIdentities, extraction) : undefined;
  if (extractionIdentity && (extractionIdentity.store !== store || fingerprint(extraction) !== extractionIdentity.hash)) throw new KnowledgeGeneratedFactSupportHeldError('stale');
  writeNativeReference(projections, proof, { store, source: identity, sourceRecord: source, sourceHash: fingerprint(source),
    extractionRecord: extraction, extractionHash: fingerprint(extraction),
    extraction: extractionIdentity?.store === store ? extractionIdentity : undefined });
  return proof;
}
/** Read-set guards still bind full records; this proof concerns structural reference fields only. */
export function projectKnowledgeSourceReferences(source: KnowledgeSourceRecord, extraction: KnowledgeExtractionRecord | null | undefined, proof: object | undefined) {
  const known = proof ? readNativeReference(projections, proof) : undefined;
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
