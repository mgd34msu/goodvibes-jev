import { projectGeneratedFactRecordAdmission } from './generated-fact-record-references.js';
import { captureKnowledgeSourceReferences, projectKnowledgeSourceReferences, projectKnowledgeNodeActivationMetadata } from './source-structural-references.js';
import { createHash } from 'node:crypto';
import { assertJudgmentInput, captureOwnedJson } from '../gate/judgment-input.js';
import type { PersistedKnowledgeRecordSelector, SQLiteStore } from '../state/sqlite-store.js';
import { mapEdgeRow, mapExtractionRow, mapNodeRow } from './store-schema.js';
import { isKnowledgeClock, sameKnowledgeRecord } from './store-record-representation.js';
import type { KnowledgeStore } from './store.js';
import type { KnowledgeEdgeRecord, KnowledgeExtractionRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from './types.js';

type RecordKind = 'source' | 'node' | 'extraction';
type EvidenceRecord = KnowledgeSourceRecord | KnowledgeNodeRecord | KnowledgeExtractionRecord;
export interface KnowledgeRecordSnapshot<T = KnowledgeNodeRecord | KnowledgeExtractionRecord> {
  readonly record: T | null;
  readonly raw: Readonly<Record<string, unknown>> | null;
  readonly generation: string | null;
}
export function readKnowledgeRecordSnapshot(sqlite: Pick<SQLiteStore, 'exec'>, kind: 'node' | 'extraction', id: string): KnowledgeRecordSnapshot {
  const table = kind === 'node' ? 'knowledge_nodes' : 'knowledge_extractions';
  return knowledgeRecordSnapshotFromRows(kind, sqlite.exec(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`, [id]));
}

/** Preserve every serialized field and generation byte for both read paths. */
export function knowledgeRecordSnapshotFromRows(kind: 'node' | 'extraction', rows: ReturnType<SQLiteStore['exec']>): KnowledgeRecordSnapshot {
  return recordSnapshotFromRows<KnowledgeNodeRecord | KnowledgeExtractionRecord>(rows, kind === 'node' ? mapNodeRow : mapExtractionRow);
}
export function knowledgeEdgeSnapshotFromRows(rows: ReturnType<SQLiteStore['exec']>): KnowledgeRecordSnapshot<KnowledgeEdgeRecord> {
  return recordSnapshotFromRows(rows, mapEdgeRow);
}
/** Complete persisted fields, without rehydrating a view during guard checks. */
export function knowledgeRecordGenerationFromRows(rows: ReturnType<SQLiteStore['exec']>): string | null {
  const result = rows[0], values = result?.values[0];
  if (!result || !values) return null;
  const entries = result.columns.map((column, index) => [column, values[index]] as const).sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
function recordSnapshotFromRows<T>(rows: ReturnType<SQLiteStore['exec']>, mapRow: (columns: string[], values: unknown[]) => T): KnowledgeRecordSnapshot<T> {
  const result = rows[0];
  const values = result?.values[0];
  if (!result || !values) return { record: null, raw: null, generation: null };
  const entries = result.columns.map((column, index) => [column, values[index]] as const).sort(([a], [b]) => a.localeCompare(b));
  return { raw: Object.fromEntries(entries), generation: knowledgeRecordGenerationFromRows(rows),
    record: mapRow(result.columns, values) };
}
export class KnowledgeRecordAdmissionHeldError extends Error {
  constructor(readonly reason: 'stale' | 'malformed') { super(`Knowledge record admission held: ${reason}`); }
}
interface AdmissionReceipt { readonly assertCurrent: () => void; }
const admittedRecords = new WeakMap<AdmissionReceipt, object>();
interface AdmissionState {
  readonly store: KnowledgeStore;
  readonly selector: PersistedKnowledgeRecordSelector;
  readonly assertGeneration: (generation: string | null) => void;
}
const admissionStates = new WeakMap<object, AdmissionState>();

interface SourceReferences { readonly source: KnowledgeSourceRecord; readonly extraction: KnowledgeExtractionRecord | null; readonly proof: object | undefined; }
/** Complete raw rows are the admission source. An exact current numeric view can
 * select that row, but cannot rewrite it. A clone/extra/mutation receives ordinary
 * complete-input admission and never inherits a clock exception. */
export function prepareKnowledgeRecordAdmission(store: KnowledgeStore, kind: RecordKind, record: EvidenceRecord, references?: SourceReferences,
  captureMetadata?: (metadata: unknown) => void) {
  const original = captureOwnedJson(record);
  const selector = Object.freeze({ kind, id: record.id });
  if (references && (kind === 'source' ? references.source !== record : kind === 'extraction' ? references.extraction !== record : true)) throw new KnowledgeRecordAdmissionHeldError('stale');
  const structural = references ? projectKnowledgeSourceReferences(references.source, references.extraction, references.proof) : undefined;
  const read = () => kind === 'source' ? (() => { const snapshot = store.getSourceSnapshot({ id: selector.id }); return { ...snapshot, record: snapshot.source }; })()
    : store.getRecordSnapshot(kind, selector.id);
  const current = () => kind === 'source' ? store.getSource(selector.id) : kind === 'node' ? store.getNode(selector.id) : store.getExtraction(selector.id);
  const snapshot = read();
  if (current() !== record || !snapshot.raw || !snapshot.record || !sameKnowledgeRecord(original, snapshot.record)) {
    assertJudgmentInput(original);
    throw new KnowledgeRecordAdmissionHeldError('stale');
  }
  const originalRaw = captureOwnedJson(snapshot.raw) as Record<string, unknown>;
  const generated = kind === 'node' ? projectGeneratedFactRecordAdmission(store, record as KnowledgeNodeRecord, originalRaw) : undefined;
  const raw = generated?.raw ?? { ...originalRaw };
  // A node's foreign key may contain card-shaped digits in a generated digest.
  // Only the existing producer proof for the exact live source can represent it.
  const nodeSource = kind === 'node' && 'sourceId' in record && record.sourceId ? store.getSource(record.sourceId) : null;
  const nodeExtraction = nodeSource ? store.getExtractionBySourceId(nodeSource.id) : null;
  const nodeSourceProof = nodeSource ? captureKnowledgeSourceReferences(store, nodeSource, nodeExtraction) : undefined;
  const nodeSourceReference = nodeSource ? projectKnowledgeSourceReferences(nodeSource, nodeExtraction, nodeSourceProof) : undefined;
  if (nodeSourceReference && raw.source_id === nodeSource?.id) raw.source_id = nodeSourceReference.sourceId;
  // Reuse only the existing in-process producer proof for structural references.
  if (structural && kind === 'source') {
    raw.id = structural.sourceId;
    if (structural.omitSourceUri) raw.source_uri = undefined;
    if (structural.omitCanonicalUri) raw.canonical_uri = undefined;
  }
  if (structural && kind === 'extraction') { raw.id = structural.extractionId ?? raw.id; raw.source_id = structural.sourceId; }
  const decoded: Record<string, unknown> = {};
  for (const column of ['metadata', 'tags', 'aliases', 'sections', 'links', 'structure']) {
    if (typeof raw[column] !== 'string') continue;
    try { decoded[column] = JSON.parse(raw[column] as string); } catch { throw new KnowledgeRecordAdmissionHeldError('malformed'); }
  }
  // Native activation receipts can also contain generated source and hash
  // references. Reuse the same exact-record proof that page ranking consumes.
  const activationMetadata = kind === 'node'
    ? projectKnowledgeNodeActivationMetadata(store, record as KnowledgeNodeRecord, decoded.metadata) : decoded.metadata;
  if (activationMetadata !== decoded.metadata) {
    decoded.metadata = activationMetadata;
    raw.metadata = JSON.stringify(activationMetadata);
  }
  assertJudgmentInput(raw);
  assertJudgmentInput(decoded);
  for (const column of ['created_at', 'updated_at', ...(kind === 'source' && snapshot.raw.last_crawled_at !== null ? ['last_crawled_at'] : [])]) {
    if (!isKnowledgeClock(snapshot.raw[column])) throw new KnowledgeRecordAdmissionHeldError('malformed');
  }
  const assertGeneration = (generation: string | null) => {
    generated?.assertCurrent();
    if (kind === 'node') projectKnowledgeNodeActivationMetadata(store, record as KnowledgeNodeRecord, decoded.metadata);
    if (nodeSourceReference && nodeSource) projectKnowledgeSourceReferences(nodeSource, nodeExtraction, nodeSourceProof);
    if (generation !== snapshot.generation || !sameKnowledgeRecord(original, record) || current() !== record) throw new KnowledgeRecordAdmissionHeldError('stale');
  };
  if (captureMetadata) {
    assertGeneration(kind === 'source' ? store.getSourceGeneration(selector.id) : store.getRecordGeneration(kind, selector.id));
    try {
      const result: unknown = captureMetadata(decoded.metadata);
      if (result !== undefined) {
        try { void Promise.resolve(result).catch(() => {}); } catch { /* Async callbacks cannot supply native metadata. */ }
        throw new KnowledgeRecordAdmissionHeldError('stale');
      }
    } finally {
      assertGeneration(kind === 'source' ? store.getSourceGeneration(selector.id) : store.getRecordGeneration(kind, selector.id));
    }
  }
  const receipt = Object.freeze({ assertCurrent: () => {
    assertGeneration(kind === 'source' ? store.getSourceGeneration(selector.id) : store.getRecordGeneration(kind, selector.id));
  } });
  admittedRecords.set(receipt, record);
  admissionStates.set(receipt, Object.freeze({ store, selector, assertGeneration }));
  return receipt;
}

/** Only authentic original receipts can select this complete private readset. */
export function assertKnowledgeRecordAdmissions(store: KnowledgeStore, receipts: readonly AdmissionReceipt[]): void {
  if (!Array.isArray(receipts) || Object.getPrototypeOf(receipts) !== Array.prototype) throw new KnowledgeRecordAdmissionHeldError('malformed');
  const array: object = receipts, descriptors = Object.getOwnPropertyDescriptors(array);
  const length: unknown = descriptors.length?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || Reflect.ownKeys(descriptors).length !== length + 1) {
    throw new KnowledgeRecordAdmissionHeldError('malformed');
  }
  const states: AdmissionState[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !('value' in descriptor)) throw new KnowledgeRecordAdmissionHeldError('malformed');
    const receipt: unknown = descriptor.value;
    const state = receipt && typeof receipt === 'object' ? admissionStates.get(receipt) : undefined;
    if (!state || state.store !== store) throw new KnowledgeRecordAdmissionHeldError('stale');
    states.push(state);
  }
  store.assertRecordSnapshotFrame(() => {
    const generations = store.getRecordGenerations(states.map(state => state.selector));
    for (const [index, state] of states.entries()) {
      const generation = generations[index];
      if (generation === undefined) throw new KnowledgeRecordAdmissionHeldError('malformed');
      state.assertGeneration(generation);
    }
  });
}

/** Preserve complete caller containers, including named array properties and
 * wrapper extras. Only exact objects already admitted through raw SQL may be
 * represented by local references; receipts cannot be forged by JSON callers. */
export function assertKnowledgeRecordContainers(value: unknown, receipts: readonly AdmissionReceipt[]): void {
  captureOwnedJson(value);
  const records = new Set(receipts.map(receipt => {
    const record = admittedRecords.get(receipt);
    if (!record) throw new KnowledgeRecordAdmissionHeldError('stale');
    return record;
  }));
  const project = (item: unknown): unknown => {
    if (!item || typeof item !== 'object') return item;
    if (records.has(item)) return 'admitted-record';
    const array = Array.isArray(item), descriptors = Object.getOwnPropertyDescriptors(item);
    const output: object = array ? new Array(descriptors.length!.value as number) : Object.create(null);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array ? key === 'length' : !descriptor.enumerable) continue;
      Object.defineProperty(output, key, { value: project(descriptor.value), enumerable: true });
    }
    return output;
  };
  assertJudgmentInput(project(value));
}
/** Sequence contents have separate declared candidate handling. Every other
 * own array property is original caller data and receives complete admission. */
export function assertKnowledgeArrayExtras(value: readonly unknown[]): void {
  captureOwnedJson(value);
  const extras: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    const index = Number(key);
    if (key === 'length' || (Number.isInteger(index) && index >= 0 && index < value.length && String(index) === key)) continue;
    Object.defineProperty(extras, key, { value: descriptor.value, enumerable: true });
  }
  assertJudgmentInput(extras);
}
