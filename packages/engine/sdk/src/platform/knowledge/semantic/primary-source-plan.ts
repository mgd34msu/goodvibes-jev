import { KnowledgeRecordAdmissionHeldError } from '../store-record-snapshot.js';
import { projectSemanticPrimaryClaim } from './primary-claim-projection.js';
import { assertJudgmentInput, JudgmentInputError } from '../../gate/judgment-input.js';
import { retainStrictJudgmentJson, type RetainedStrictJudgmentJson } from '../../gate/judgment-result.js';
import { sourceRankingContent } from './answer-source-ranking.js';
import { getKnowledgeSpaceId } from '../spaces.js';
import { createKnowledgePageSourceReader, KnowledgeSourceQualityHeldError } from '../source-quality.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeExtractionRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';

const originalJson = JSON;
const originalStringify = JSON.stringify;
const ownDescriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const prototype = Object.getPrototypeOf;
const originalObjectPrototype = Object.prototype;
const originalArrayPrototype = Array.prototype;
function originalRecordSerializer(): boolean {
  const descriptor = ownDescriptor(JSON, 'stringify');
  return JSON === originalJson && descriptor?.value === originalStringify && !descriptor.get && !descriptor.set
    && Object.prototype === originalObjectPrototype && Array.prototype === originalArrayPrototype
    && prototype(originalObjectPrototype) === null && prototype(originalArrayPrototype) === originalObjectPrototype
    && !hasOwn(originalObjectPrototype, 'toJSON') && !hasOwn(originalArrayPrototype, 'toJSON');
}

/** A cooperative lifecycle stop never authorizes a fallback or late write. */
export function assertSemanticWriteAllowed(signal?: AbortSignal, shouldStop?: () => boolean): void {
  if (signal?.aborted || shouldStop?.()) throw new KnowledgeSourceQualityHeldError('aborted');
}

/** Optimistic read-set for one persistence pass, including absent/excluded records. */
export function createSemanticWriteGuard(store: KnowledgeStore, signal?: AbortSignal, shouldStop?: () => boolean) {
  const checks = new Map<string, () => void>();
  function watch<T>(key: string, read: () => T, expected: T = read()): T {
    const version = JSON.stringify(expected);
    const check = () => {
      if (JSON.stringify(read()) !== version) throw new KnowledgeSourceQualityHeldError('stale');
    };
    // A second observation may not silently replace the original version.
    checks.get(key)?.();
    if (!checks.has(key)) checks.set(key, check);
    check();
    return expected;
  }
  function watchRecord<T extends KnowledgeSourceRecord | KnowledgeNodeRecord | KnowledgeExtractionRecord | null>(
    key: string, read: () => T, expected: T, captureRecord?: (value: T) => T,
  ): T {
    const snapshot = captureRecord ? captureRecord(expected) : expected;
    const version = JSON.stringify(snapshot);
    let original: { readonly value: T; readonly slots: RetainedStrictJudgmentJson<T> } | undefined;
    let first = true;
    const check = () => {
      const firstRead = first;
      first = false;
      const current = read();
      if (original && current === original.value && originalRecordSerializer()) {
        try { original.slots.assertCurrent(); return; } catch { /* Compare the original complete value below. */ }
      }
      if (JSON.stringify(captureRecord ? captureRecord(current) : current) !== version) throw new KnowledgeSourceQualityHeldError('stale');
      if (firstRead) {
        // Adopt only the actual first getter result after full original equality.
        // A later equal replacement never becomes a new retained baseline.
        if (originalRecordSerializer()) {
          try {
            const slots = retainStrictJudgmentJson(current);
            if (originalRecordSerializer() && originalStringify(slots.snapshot) === version) {
              slots.assertCurrent(); original = { value: current, slots };
            }
          } catch { /* Unsupported original shapes keep the full comparison. */ }
        }
      }
    };
    checks.get(key)?.();
    if (!checks.has(key)) checks.set(key, check);
    check();
    return snapshot;
  }
  return {
    watch,
    watchRecord,
    source(id: string, expected = store.getSource(id)) { return watchRecord(`source:${id}`, () => store.getSource(id), expected); },
    node(id: string, expected = store.getNode(id)) { return watchRecord(`node:${id}`, () => store.getNode(id), expected); },
    extraction(id: string, expected = store.getExtractionBySourceId(id)) { return watchRecord(`extraction:${id}`, () => store.getExtractionBySourceId(id), expected); },
    assertCurrent() {
      try { store.assertRecordSnapshotFrame(() => {
        assertSemanticWriteAllowed(signal, shouldStop);
        for (const check of checks.values()) check();
      }); } catch (error) {
        if (error instanceof KnowledgeRecordAdmissionHeldError) throw new KnowledgeSourceQualityHeldError('stale');
        throw error;
      }
    },
  };
}
export type SemanticWriteGuard = ReturnType<typeof createSemanticWriteGuard>;
export interface SemanticPrimaryClaim {
  readonly kind: string;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly value?: unknown;
  readonly evidence?: unknown;
  readonly targetHints?: unknown;
  readonly subject?: unknown;
  readonly subjects: readonly Pick<KnowledgeNodeRecord, 'id' | 'title' | 'kind'>[];
}

/** Claim-specific, bounded decisions. No winner is shared between different claims. */
export function createSemanticPrimarySourcePlanner(store: KnowledgeStore, guard: SemanticWriteGuard, signal?: AbortSignal) {
  const decisions = new Map<string, Promise<string>>();
  let requests = 0;
  function prepare(spaceId: string, claim: SemanticPrimaryClaim, sourceIds: readonly string[]): () => Promise<string> {
    const projectedClaim = projectSemanticPrimaryClaim(claim);
    const candidates = [...new Set(sourceIds)].map((id) => guard.source(id))
      .filter((source): source is KnowledgeSourceRecord => Boolean(source
        && getKnowledgeSpaceId(source) === spaceId
        && (source.status === 'indexed' || source.status === 'pending')))
      .sort((a, b) => a.id.localeCompare(b.id));
    // All supplied IDs were snapshotted before filtering, including missing records.
    // Refuse oversized sets rather than choosing a winner from a hidden truncation.
    if (candidates.length > 50) throw new JudgmentInputError('unsupported-input');
    const purpose = `Choose a useful, credible primary reference supporting this exact claim and subject: ${JSON.stringify(projectedClaim)}`;
    // All prepares run before any resolver. Refuse a protected later claim or
    // support set before an earlier request can leave this persistence pass.
    if (candidates.length > 1) assertJudgmentInput(candidates.map((source) => ({
      purpose, candidate: sourceRankingContent(source), effectiveStatus: source.status,
    })));
    const key = JSON.stringify({ spaceId, claim: projectedClaim, sources: candidates });
    return async () => {
      guard.assertCurrent();
      if (candidates.length === 0) throw new KnowledgeSourceQualityHeldError('no-match');
      // One known in-space source is provenance bookkeeping, not a preference.
      if (candidates.length === 1) return candidates[0]!.id;
      let decision = decisions.get(key);
      if (!decision) {
        if (decisions.size >= 400 || requests + candidates.length > 4_000) {
          throw new JudgmentInputError('unsupported-input');
        }
        requests += candidates.length;
        const reader = createKnowledgePageSourceReader({ purpose, signal });
        decision = reader.rank(candidates).then((ranked) => {
          reader.assertCurrent((id) => store.getSource(id));
          if (!ranked[0]) throw new KnowledgeSourceQualityHeldError('no-match');
          return ranked[0].source.id;
        });
        decisions.set(key, decision);
      }
      return decision;
    };
  }
  return { prepare };
}
export type SemanticPrimarySourcePlanner = ReturnType<typeof createSemanticPrimarySourcePlanner>;
