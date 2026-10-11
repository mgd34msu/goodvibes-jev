import { projectKnowledgeSourceReferences } from './source-structural-references.js';
import { createHash } from 'node:crypto';
import { assertJudgmentInput, captureOwnedJson } from '../gate/judgment-input.js';
import type { SQLiteStore } from '../state/sqlite-store.js';
import { mapExtractionRow, mapNodeRow } from './store-schema.js';
import { isKnowledgeClock, sameKnowledgeRecord } from './store-record-representation.js';
import type { KnowledgeStore } from './store.js';
import type { KnowledgeExtractionRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from './types.js';

type RecordKind = 'source' | 'node' | 'extraction';
type EvidenceRecord = KnowledgeSourceRecord | KnowledgeNodeRecord | KnowledgeExtractionRecord;
export interface KnowledgeRecordSnapshot {
  readonly record: KnowledgeNodeRecord | KnowledgeExtractionRecord | null;
  readonly raw: Readonly<Record<string, unknown>> | null;
  readonly generation: string | null;
}
export function readKnowledgeRecordSnapshot(sqlite: Pick<SQLiteStore, 'exec'>, kind: 'node' | 'extraction', id: string): KnowledgeRecordSnapshot {
  const table = kind === 'node' ? 'knowledge_nodes' : 'knowledge_extractions';
  const result = sqlite.exec(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`, [id])[0];
  const values = result?.values[0];
  if (!result || !values) return { record: null, raw: null, generation: null };
  const entries = result.columns.map((column, index) => [column, values[index]] as const).sort(([a], [b]) => a.localeCompare(b));
  return { raw: Object.fromEntries(entries), generation: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
    record: kind === 'node' ? mapNodeRow(result.columns, values) : mapExtractionRow(result.columns, values) };
}
export class KnowledgeRecordAdmissionHeldError extends Error {
  constructor(readonly reason: 'stale' | 'malformed') { super(`Knowledge record admission held: ${reason}`); }
}
interface AdmissionReceipt { readonly assertCurrent: () => void; }
const admittedRecords = new WeakMap<AdmissionReceipt, object>();

interface SourceReferences { readonly source: KnowledgeSourceRecord; readonly extraction: KnowledgeExtractionRecord | null; readonly proof: object | undefined; }
/** Complete raw rows are the admission source. An exact current numeric view can
 * select that row, but cannot rewrite it. A clone/extra/mutation receives ordinary
 * complete-input admission and never inherits a clock exception. */
export function prepareKnowledgeRecordAdmission(store: KnowledgeStore, kind: RecordKind, record: EvidenceRecord, references?: SourceReferences) {
  const original = captureOwnedJson(record);
  if (references && (kind === 'source' ? references.source !== record : kind === 'extraction' ? references.extraction !== record : true)) throw new KnowledgeRecordAdmissionHeldError('stale');
  const structural = references ? projectKnowledgeSourceReferences(references.source, references.extraction, references.proof) : undefined;
  const read = () => kind === 'source' ? (() => { const snapshot = store.getSourceSnapshot({ id: record.id }); return { ...snapshot, record: snapshot.source }; })()
    : store.getRecordSnapshot(kind, record.id);
  const current = () => kind === 'source' ? store.getSource(record.id) : kind === 'node' ? store.getNode(record.id) : store.getExtraction(record.id);
  const snapshot = read();
  if (current() !== record || !snapshot.raw || !snapshot.record || !sameKnowledgeRecord(original, snapshot.record)) {
    assertJudgmentInput(original);
    throw new KnowledgeRecordAdmissionHeldError('stale');
  }
  const originalRaw = captureOwnedJson(snapshot.raw) as Record<string, unknown>;
  const raw = { ...originalRaw };
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
  assertJudgmentInput(raw);
  assertJudgmentInput(decoded);
  for (const column of ['created_at', 'updated_at', ...(kind === 'source' && snapshot.raw.last_crawled_at !== null ? ['last_crawled_at'] : [])]) {
    if (!isKnowledgeClock(snapshot.raw[column])) throw new KnowledgeRecordAdmissionHeldError('malformed');
  }
  const receipt = Object.freeze({ assertCurrent: () => {
    const now = read();
    if (current() !== record || now.generation !== snapshot.generation || !sameKnowledgeRecord(original, record)
      || !sameKnowledgeRecord(now.raw, snapshot.raw)) throw new KnowledgeRecordAdmissionHeldError('stale');
  } });
  admittedRecords.set(receipt, record);
  return receipt;
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
