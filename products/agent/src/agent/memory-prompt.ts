import type { MemoryRecord, MemoryRegistry, MemoryVectorStats } from '@goodvibes-jev/engine/sdk/platform/state';
// The recall-honesty floor + eligibility receipt now live in the SDK as
// the ONE cross-surface contract (memory-recall-contract.ts) instead of being defined
// per surface. This file re-exports them unchanged so every existing agent consumer
// keeps importing from './memory-prompt.ts', while the SDK is the single source of the
// floor (60, the store's own baseline), the flagged-record exclusion, and the honest
// degraded-state distinction. The per-turn ranking below stays agent-local, it is
// injection wiring on top of the contract, not the contract itself.
import {
  MIN_PROMPT_MEMORY_CONFIDENCE,
  describeMemoryPromptEligibility,
  isPromptActiveMemory,
} from '@goodvibes-jev/engine/sdk/platform/state';
import type { MemoryPromptEligibility } from '@goodvibes-jev/engine/sdk/platform/state';

export { MIN_PROMPT_MEMORY_CONFIDENCE, describeMemoryPromptEligibility, isPromptActiveMemory };
export type { MemoryPromptEligibility };

const DEFAULT_LIMIT = 10;

function sortMemoryForPrompt(left: MemoryRecord, right: MemoryRecord): number {
  if (right.confidence !== left.confidence) return right.confidence - left.confidence;
  return right.updatedAt - left.updatedAt;
}

function formatMemoryLine(record: MemoryRecord): string {
  const tags = record.tags.length > 0 ? ` tags=${record.tags.join(',')}` : '';
  const provenance = record.provenance.length > 0
    ? ` source=${record.provenance.slice(0, 2).map((entry) => `${entry.kind}:${entry.ref}`).join(',')}`
    : '';
  return `- [${record.scope}/${record.cls} ${record.confidence}%${tags}${provenance}] ${record.summary}`;
}

/**
 * Per-turn semantic ranking of an already-eligible memory set.
 *
 * Eligibility (confidence + reviewState + provenance) shipped as the hard trust
 * gate but had no per-turn query to rank WITHIN that eligible set, records were only
 * ever ordered by stored confidence/recency, regardless of whether they had anything to
 * do with what the user actually just asked. `rankMemoryForTurn` never touches the gate
 * itself: it only reorders the records that already cleared describeMemoryPromptEligibility,
 * so a budget-limited cut (the top-N prompt slice) drops the least relevant record to
 * THIS turn instead of an arbitrary one.
 *
 * Degrades honestly and says why whenever it can't score: no turn text supplied, the
 * semantic index disabled/unavailable/empty, or a real query that the index has zero
 * vector matches for. In every degraded case the eligible set still gets the prior
 * confidence/recency order, never silently dropped, never silently reordered on data
 * that isn't there.
 */
export interface MemoryTurnRankingResult {
  /** The eligible records, ranked, by relevance when `scored` is true, else by the prior confidence/recency order. */
  readonly records: readonly MemoryRecord[];
  /** Relevance percent (0-100) per record id. Only populated when `scored` is true. */
  readonly relevanceById: ReadonlyMap<string, number>;
  /** True when semantic relevance to the current turn actually drove the ranking above. */
  readonly scored: boolean;
  /** Honest reason for the degrade when `scored` is false; null when scoring succeeded or there was nothing to rank. */
  readonly degradedReason: string | null;
}

function describeTurnRelevanceIndexUnavailable(stats: MemoryVectorStats): string | null {
  if (!stats.enabled) return 'the semantic memory index is disabled for this store';
  if (!stats.available) return `the semantic memory index is unavailable${stats.error ? `: ${stats.error}` : ''}`;
  if (stats.indexedRecords === 0) return 'the semantic memory index has no indexed records yet';
  return null;
}

/**
 * Qualitative band for a 0-100 relevance-to-turn percent (F7a).
 *
 * A raw cosine-similarity percent like "28%" reads as misleadingly low out of
 * context, it can still be the single best match among the eligible set, or
 * a genuinely useful match on an absolute basis, but a bare number invites
 * "only 28%? that's barely relevant." Choice made here: add a qualitative
 * band NEXT TO the raw percent rather than normalizing against the turn's
 * top score. Normalizing would make every record but the single best one
 * read as comparatively weak even when several are strong matches in
 * absolute terms, and would make a genuinely weak top match look like a
 * confident 100%. A fixed absolute band keeps the number honest while
 * making it readable at a glance.
 */
export function relevanceBand(percent: number): 'high match' | 'moderate match' | 'low match' {
  if (percent >= 60) return 'high match';
  if (percent >= 35) return 'moderate match';
  return 'low match';
}

export async function rankMemoryForTurn(
  memoryRegistry: MemoryRegistry,
  eligible: readonly MemoryRecord[],
  turnText: string | null | undefined,
): Promise<MemoryTurnRankingResult> {
  const fallbackOrder = (): readonly MemoryRecord[] => [...eligible].sort(sortMemoryForPrompt);
  if (eligible.length === 0) {
    return { records: [], relevanceById: new Map(), scored: false, degradedReason: null };
  }
  const trimmedTurnText = turnText?.trim() ?? '';
  if (!trimmedTurnText) {
    return {
      records: fallbackOrder(),
      relevanceById: new Map(),
      scored: false,
      degradedReason: 'no current-turn text available for this composition, using stored confidence/recency order',
    };
  }
  const stats = memoryRegistry.vectorStats();
  const indexUnavailable = describeTurnRelevanceIndexUnavailable(stats);
  if (indexUnavailable) {
    return {
      records: fallbackOrder(),
      relevanceById: new Map(),
      scored: false,
      degradedReason: `semantic index unavailable (${indexUnavailable}), using stored confidence/recency order`,
    };
  }
  // Request enough candidates back that every eligible record has a real chance to
  // appear with its similarity score (searchSemantic slices its return to this limit
  // after scoring, not before), the SDK's vector store caps the underlying KNN search
  // at 500 candidates regardless, so there is no point asking for more than that.
  const requestLimit = Math.min(500, Math.max(eligible.length, 50));
  const results = await memoryRegistry.searchSemantic({ query: trimmedTurnText, limit: requestLimit });
  const consultedSemanticIndex = results.some((entry) => entry.similarity > 0);
  if (!consultedSemanticIndex) {
    return {
      records: fallbackOrder(),
      relevanceById: new Map(),
      scored: false,
      degradedReason: "no semantic match for this turn's text, using stored confidence/recency order",
    };
  }
  const eligibleIds = new Set(eligible.map((record) => record.id));
  const relevanceById = new Map<string, number>();
  for (const entry of results) {
    if (!eligibleIds.has(entry.record.id)) continue;
    relevanceById.set(entry.record.id, Math.round(Math.max(0, Math.min(1, entry.similarity)) * 100));
  }
  const ranked = [...eligible].sort((left, right) => {
    const rightScore = relevanceById.get(right.id) ?? 0;
    const leftScore = relevanceById.get(left.id) ?? 0;
    if (rightScore !== leftScore) return rightScore - leftScore;
    return sortMemoryForPrompt(left, right);
  });
  return { records: ranked, relevanceById, scored: true, degradedReason: null };
}

export interface BuildReviewedMemoryPromptOptions {
  readonly limit?: number;
  /** The current turn's raw text (the seam this comes from: TURN_SUBMITTED's `prompt`).
   *  Used only to RANK the already-eligible set, never to admit an otherwise-ineligible record. */
  readonly turnText?: string | null;
  /**
   * Pre-fetched record set to use instead of `memoryRegistry.getAll()`, e.g. a
   * memory-spine recall snapshot's records (SDK 1.2.0 sync-recall seam; see
   * prompt-context-receipts.ts's `resolveMemoryRecords`). `memoryRegistry` is still
   * used for the per-turn semantic ranking query (`rankMemoryForTurn`'s
   * `vectorStats`/`searchSemantic` calls stay local-direct regardless of where the
   * record set came from), only the raw eligible set that ranking runs OVER is
   * swappable, so the injected prompt text and any receipt describing it are always
   * derived from the exact same record set instead of two independent reads.
   */
  readonly records?: readonly MemoryRecord[];
}

export async function buildReviewedMemoryPrompt(memoryRegistry: MemoryRegistry, options: BuildReviewedMemoryPromptOptions = {}): Promise<string | null> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  // Bound to one arg, see prompt-context-receipts.ts's resolveMemoryRecords
  // filter for why a bare `.filter(isPromptActiveMemory)` is unsafe here.
  const eligible = (options.records ?? memoryRegistry.getAll()).filter((record) => isPromptActiveMemory(record));
  const ranking = await rankMemoryForTurn(memoryRegistry, eligible, options.turnText);
  return renderReviewedMemoryPrompt(ranking, limit);
}

export function renderReviewedMemoryPrompt(ranking: MemoryTurnRankingResult, limit = DEFAULT_LIMIT): string | null {
  const records = ranking.records.slice(0, Math.max(0, limit));

  if (records.length === 0) return null;
  return [
    '## Reviewed GoodVibes Agent Memory',
    `Use these local, reviewed, non-secret memory records with confidence >= ${MIN_PROMPT_MEMORY_CONFIDENCE}% to avoid asking repeat questions and to preserve durable user preferences, constraints, and operating facts.`,
    ...records.map(formatMemoryLine),
  ].join('\n');
}
