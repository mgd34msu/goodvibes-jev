import { assertJudgmentInput, JudgmentInputError } from '../../gate/judgment-input.js';
import { sourceRankingContent } from './answer-source-ranking.js';
import { getKnowledgeSpaceId } from '../spaces.js';
import { createKnowledgePageSourceReader, KnowledgeSourceQualityHeldError } from '../source-quality.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';

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
  return {
    watch,
    source(id: string) { return watch(`source:${id}`, () => store.getSource(id)); },
    node(id: string) { return watch(`node:${id}`, () => store.getNode(id)); },
    extraction(id: string) { return watch(`extraction:${id}`, () => store.getExtractionBySourceId(id)); },
    assertCurrent() {
      assertSemanticWriteAllowed(signal, shouldStop);
      for (const check of checks.values()) check();
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
    const candidates = [...new Set(sourceIds)].map((id) => guard.source(id))
      .filter((source): source is KnowledgeSourceRecord => Boolean(source
        && getKnowledgeSpaceId(source) === spaceId
        && (source.status === 'indexed' || source.status === 'pending')))
      .sort((a, b) => a.id.localeCompare(b.id));
    // All supplied IDs were snapshotted before filtering, including missing records.
    // Refuse oversized sets rather than choosing a winner from a hidden truncation.
    if (candidates.length > 50) throw new JudgmentInputError('unsupported-input');
    const purpose = `Choose a useful, credible primary reference supporting this exact claim and subject: ${JSON.stringify(claim)}`;
    // All prepares run before any resolver. Refuse a protected later claim or
    // support set before an earlier request can leave this persistence pass.
    if (candidates.length > 1) assertJudgmentInput(candidates.map((source) => ({
      purpose, candidate: sourceRankingContent(source), effectiveStatus: source.status,
    })));
    const key = JSON.stringify({ spaceId, claim, sources: candidates });
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
