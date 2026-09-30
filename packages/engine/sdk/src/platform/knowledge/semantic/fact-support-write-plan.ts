import { withEngineGeneratedSupportReferences, type EngineGeneratedSupportReferences } from './verification/structural-references.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeExtractionRecord, KnowledgeNodeRecord } from '../types.js';
import { getKnowledgeSpaceId } from '../spaces.js';
import type { SemanticWriteGuard } from './primary-source-plan.js';
import { semanticHash } from './utils.js';
import { prepareGeneratedFactSupport } from './verification/generated-fact-support.js';
import {
  KnowledgeGeneratedFactSupportHeldError,
  type GeneratedFactSupportClaim,
  type GeneratedFactSupportInput,
  type GeneratedFactSupportOptions,
  type GeneratedFactSupportPlan,
  type GeneratedFactSupportReceipt,
} from './verification/types.js';

/** Exact identifiers are not case-folded natural-language labels. */
export function exactKnowledgeIds(values: readonly (string | undefined | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))];
}

/** Gather one entire persistence pass before the first support request is sent. */
export function createGeneratedFactWritePlanner(
  store: KnowledgeStore, guard: SemanticWriteGuard, options: GeneratedFactSupportOptions = {},
) {
  const requests: GeneratedFactSupportInput[] = [];
  const slots = new Map<string, number[]>();
  let settled: readonly GeneratedFactSupportPlan[] | undefined;
  let started = false;
  function add(
    spaceId: string, claim: GeneratedFactSupportClaim, sourceIds: readonly string[],
    subjects: readonly KnowledgeNodeRecord[],
    originalExtractions: ReadonlyMap<string, KnowledgeExtractionRecord | null> = new Map(),
    proposedSubjectIds: ReadonlySet<string> = new Set(),
    generatedReferences?: EngineGeneratedSupportReferences,
  ): string {
    if (started) throw new KnowledgeGeneratedFactSupportHeldError('malformed');
    for (const subject of subjects) {
      if (getKnowledgeSpaceId(subject) !== spaceId) throw new KnowledgeGeneratedFactSupportHeldError('foreign-space');
      // Proposed entities are verified as proposals, while their prior stored
      // records (including absence/operator state) remain in the write read-set.
      if (proposedSubjectIds.has(subject.id)) guard.node(subject.id);
      else guard.watch(`node:${subject.id}`, () => store.getNode(subject.id), subject);
    }
    const sources = exactKnowledgeIds(sourceIds).map((id) => {
      const source = guard.source(id);
      if (!source || (source.status !== 'indexed' && source.status !== 'pending')) throw new KnowledgeGeneratedFactSupportHeldError('missing-evidence');
      if (getKnowledgeSpaceId(source) !== spaceId) throw new KnowledgeGeneratedFactSupportHeldError('foreign-space');
      const extraction = originalExtractions.has(id)
        ? guard.watch(`extraction:${id}`, () => store.getExtractionBySourceId(id), originalExtractions.get(id)!)
        : guard.extraction(id);
      return { source, extraction };
    });
    if (sources.length === 0) throw new KnowledgeGeneratedFactSupportHeldError('missing-evidence');
    const key = semanticHash(JSON.stringify({ spaceId, claim, sources, subjects }));
    if (!slots.has(key)) slots.set(key, sources.map(({ source, extraction }) => {
      const index = requests.length;
      const input = { spaceId, claim, source, extraction, subjects };
      requests.push(generatedReferences ? withEngineGeneratedSupportReferences(input, generatedReferences) : input);
      return index;
    }));
    return key;
  }
  return {
    add,
    async readAll(): Promise<void> {
      if (started) throw new KnowledgeGeneratedFactSupportHeldError('malformed');
      started = true;
      guard.assertCurrent();
      settled = await prepareGeneratedFactSupport(requests, options);
      guard.assertCurrent();
      if (settled.length !== requests.length) throw new KnowledgeGeneratedFactSupportHeldError('malformed');
    },
    plans(key: string): readonly GeneratedFactSupportPlan[] {
      if (!settled || !slots.has(key)) throw new KnowledgeGeneratedFactSupportHeldError('malformed');
      return slots.get(key)!.map((index) => settled![index]!);
    },
  };
}
export type GeneratedFactWritePlanner = ReturnType<typeof createGeneratedFactWritePlanner>;

/** Keep receipts per claim/source; a last writer must not erase earlier provenance. */
export function generatedFactSupportMetadata(
  plans: readonly GeneratedFactSupportPlan[], existing: unknown,
): { readonly version: 1; readonly claimHashes: readonly string[]; readonly receipts: readonly unknown[] } {
  const previous = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? existing as { readonly receipts?: unknown } : {};
  const receipts = new Map<string, unknown>();
  if (Array.isArray(previous.receipts)) for (const value of previous.receipts) {
    if (value && typeof value === 'object' && typeof value.receiptId === 'string') receipts.set(supportReceiptKey(value), value);
  }
  for (const receipt of generatedFactSupportReceipts(plans)) receipts.set(supportReceiptKey(receipt), receipt);
  return { version: 1, claimHashes: [...new Set(plans.map((plan) => plan.claimHash))], receipts: [...receipts.values()] };
}
export function generatedFactSupportReceipts(plans: readonly GeneratedFactSupportPlan[]): readonly GeneratedFactSupportReceipt[] {
  return plans.flatMap((plan) => plan.receipts);
}

/** Keep the latest attestation per source/field/subject, not one copy per reread. */
function supportReceiptKey(value: { readonly receiptId: string; readonly [key: string]: unknown } | GeneratedFactSupportReceipt): string {
  if (typeof value.sourceId !== 'string' || typeof value.field !== 'string' || typeof value.battery !== 'string') return value.receiptId;
  return JSON.stringify([value.sourceId, value.field, value.subjectId ?? null, value.battery, value.batteryVersion]);
}
