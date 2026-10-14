import { isDeepStrictEqual } from 'node:util';
import { captureStrictJudgmentJson } from '../gate/judgment-result.js';
import { knowledgeClockIso, sameKnowledgeRecord } from './store-record-representation.js';
import { captureNativeGeneratedFactPlanReferences } from './semantic/fact-support-write-plan.js';
import { semanticFactId } from './semantic/utils.js';
import { KnowledgeGeneratedFactSupportHeldError as Held, type GeneratedFactSupportPlan, type GeneratedFactSupportReceipt } from './semantic/verification/types.js';
import { hasKnowledgeNodePublication, knowledgeNodePublicationGeneration, type KnowledgeStore } from './store.js';
import type { KnowledgeNodeRecord } from './types.js';

const nativeApply = Reflect.apply;
const nativeWeakMapGet = WeakMap.prototype.get, nativeWeakMapSet = WeakMap.prototype.set;
function privateMapGet<K extends object, V>(map: WeakMap<K, V>, key: K): V | undefined {
  return nativeApply(nativeWeakMapGet, map, [key]);
}
function privateMapSet<K extends object, V>(map: WeakMap<K, V>, key: K, value: V): void {
  nativeApply(nativeWeakMapSet, map, [key, value]);
}

interface NativeFactReceipt {
  readonly value: GeneratedFactSupportReceipt;
  readonly assertCurrent: () => void;
}
interface NativeFactRecord {
  readonly store: KnowledgeStore;
  readonly original: KnowledgeNodeRecord;
  readonly generation: string | null;
  readonly receipts: readonly NativeFactReceipt[];
  readonly assertSourcesCurrent: () => void;
}
const records = new WeakMap<KnowledgeNodeRecord, NativeFactRecord>();
export interface GeneratedFactIdentity { readonly id: string; }
const identities = new WeakMap<GeneratedFactIdentity, { readonly store: KnowledgeStore; readonly id: string }>();

/** Invoke the existing native identity constructor; no supplied ID is admitted. */
export function prepareGeneratedFactIdentity(store: KnowledgeStore, input: Parameters<typeof semanticFactId>[0]): GeneratedFactIdentity {
  const id = semanticFactId(captureStrictJudgmentJson(input));
  const identity = Object.freeze({ id });
  privateMapSet(identities, identity, Object.freeze({ store, id }));
  return identity;
}

/** Called on the actual native publication result, before an observer receives it.
 * Only exact whole-pass support plans can supply structural claim references.
 * Receipt contents remain ordinary evidence. Their authentic claimId slot uses
 * the native identity reference; their owned extraction clock uses lossless ISO. */
export function retainGeneratedFactRecordReferences(store: KnowledgeStore, record: KnowledgeNodeRecord,
  plans: readonly GeneratedFactSupportPlan[], previous?: KnowledgeNodeRecord, identity?: GeneratedFactIdentity): void {
  if (plans.length === 0 || store.getNode(record.id) !== record || record.kind !== 'fact'
    || !hasKnowledgeNodePublication(store, record, previous)) throw new Held('stale');
  const native = plans.map(plan => captureNativeGeneratedFactPlanReferences(store, plan));
  if (native.some(plan => plan.claimId !== record.id)) throw new Held('stale');
  const prior = previous ? privateMapGet(records, previous) : undefined;
  if (prior && (prior.store !== store || previous?.id !== record.id || !sameKnowledgeRecord(prior.original, previous))) throw new Held('stale');
  const generated = identity ? privateMapGet(identities, identity) : undefined;
  if (identity && (!generated || generated.store !== store || generated.id !== record.id)) throw new Held('stale');
  if (!generated && !prior) throw new Held('stale');
  for (const plan of native) plan.assertCurrent();
  const generation = knowledgeNodePublicationGeneration(store, record, previous);
  if (generation === null) throw new Held('stale');
  const original = captureStrictJudgmentJson(record);
  const support = Object.getOwnPropertyDescriptor(original.metadata, 'generatedFactSupport')?.value as unknown;
  const storedReceipts = support && typeof support === 'object' && !Array.isArray(support)
    ? Object.getOwnPropertyDescriptor(support, 'receipts')?.value as unknown : undefined;
  if (!Array.isArray(storedReceipts)) throw new Held('malformed');
  const currentReceipts = native.flatMap(plan => plan.receipts.map(value => ({ value, assertCurrent: plan.assertCurrent })))
    .filter(receipt => storedReceipts.some(stored => isDeepStrictEqual(stored, receipt.value)));
  const priorReceipts = (prior?.receipts ?? []).filter(receipt => storedReceipts.some(stored => isDeepStrictEqual(stored, receipt.value))
    && !currentReceipts.some(current => isDeepStrictEqual(current.value, receipt.value)));
  // Keep only each surviving receipt's actual source dependency. A refreshed
  // source must not inherit a retired sibling through an old aggregate guard.
  const sourceChecks = [...new Set([...native.map(plan => plan.assertCurrent), ...priorReceipts.map(receipt => receipt.assertCurrent)])];
  const assertSourcesCurrent = () => { for (const check of sourceChecks) check(); };
  assertSourcesCurrent();
  const receipts = [...priorReceipts, ...currentReceipts].map(receipt => Object.freeze({
    value: captureStrictJudgmentJson(receipt.value), assertCurrent: receipt.assertCurrent,
  }));
  privateMapSet(records, record, Object.freeze({ store, original, generation, receipts: Object.freeze(receipts), assertSourcesCurrent }));
}

function assertNativeFactCurrent(store: KnowledgeStore, record: KnowledgeNodeRecord, known: NativeFactRecord): void {
  if (known.store !== store || store.getNode(record.id) !== record || !sameKnowledgeRecord(known.original, record)
    || store.getRecordGeneration('node', record.id) !== known.generation) throw new Held('stale');
  known.assertSourcesCurrent();
}

/** Discover only a current authentic predecessor before planning a native relink. */
export function hasGeneratedFactRecordReferences(store: KnowledgeStore, record: KnowledgeNodeRecord): boolean {
  const known = privateMapGet(records, record);
  if (!known) return false;
  assertNativeFactCurrent(store, record, known);
  return true;
}

/** A clone, reopened record, raw marker or replaced row inherits no exception. */
export function projectGeneratedFactRecordAdmission(store: KnowledgeStore, record: KnowledgeNodeRecord,
  originalRaw: Readonly<Record<string, unknown>>): { readonly raw: Record<string, unknown>; readonly assertCurrent: () => void } | undefined {
  const known = privateMapGet(records, record);
  if (!known) return undefined;
  const assertCurrent = () => assertNativeFactCurrent(store, record, known);
  assertCurrent();
  const snapshot = store.getRecordSnapshot('node', record.id);
  if (!snapshot.raw || !isDeepStrictEqual(snapshot.raw, originalRaw) || snapshot.generation !== known.generation) throw new Held('stale');
  const raw: Record<string, unknown> = { ...originalRaw, id: 'generated-claim-reference' };
  if (typeof raw.metadata !== 'string') throw new Held('malformed');
  let metadata: unknown;
  try { metadata = JSON.parse(raw.metadata); } catch { throw new Held('malformed'); }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Held('malformed');
  // Native rows use this exact serialization. Refuse alternative number spellings,
  // duplicate keys or escapes rather than normalize any unregistered raw bytes.
  if (JSON.stringify(metadata) !== raw.metadata) throw new Held('malformed');
  const support = Object.getOwnPropertyDescriptor(metadata, 'generatedFactSupport')?.value as unknown;
  if (support && typeof support === 'object' && !Array.isArray(support)) {
    const receipts = Object.getOwnPropertyDescriptor(support, 'receipts')?.value as unknown;
    if (Array.isArray(receipts)) {
      for (let index = 0; index < receipts.length; index++) {
        const receipt: unknown = receipts[index];
        if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) continue;
        for (let retainedIndex = 0; retainedIndex < known.receipts.length; retainedIndex++) {
          const retained = known.receipts[retainedIndex];
          if (!retained || !isDeepStrictEqual(retained.value, receipt)) continue;
          Object.defineProperty(receipt, 'claimId', { value: 'generated-claim-reference', enumerable: true, configurable: true, writable: true });
          // This exact whole native receipt retained the original extraction
          // owner. Present its clock losslessly; never infer a role from a key.
          Object.defineProperty(receipt, 'extractionUpdatedAt', { value: typeof retained.value.extractionUpdatedAt === 'number' ? knowledgeClockIso(retained.value.extractionUpdatedAt) : retained.value.extractionUpdatedAt,
            enumerable: true, configurable: true, writable: true });
          break;
        }
      }
    }
  }
  raw.metadata = JSON.stringify(metadata);
  assertCurrent();
  return Object.freeze({ raw, assertCurrent });
}
