/**
 * memory-search-ranking.ts, the ranking half of memory search. Retrieval (the
 * SQL filter and the vector index in memory-store.ts) builds a shortlist; the
 * `engine.state.memory-search` rerank orders it here.
 */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { mapLimit } from '@goodvibes-jev/judgment';
import { memoryReviewPriority, reviewPriorityState } from './batteries/memory-review-priority.js';
import { memorySearchRerank, rerankContent, rerankShortlistSize } from './batteries/memory-search-rerank.js';
import type { MemoryRecord, MemorySearchFilter, MemorySemanticSearchResult } from './memory-store.js';

const SEARCH_SITE = 'state.memory-search';
const REVIEW_SITE = 'state.memory-review-queue';

/** Readings in flight at once for one review queue. */
const REVIEW_CONCURRENCY = 8;

/** The rerank's probability for each record against the query, by record id. */
export async function rerankProbabilities(query: string, records: readonly MemoryRecord[]): Promise<Map<string, number>> {
  if (records.length === 0) return new Map();
  const { ranked } = await memorySearchRerank.rerank(
    judgmentPort(SEARCH_SITE),
    query,
    records.map((record) => ({ id: record.id, content: rerankContent(record) })),
    { site: SEARCH_SITE },
  );
  return new Map(ranked.map((entry) => [entry.id, entry.probability]));
}

/**
 * Reranks the first rerankShortlistSize(limit) retrieved records against the
 * query and puts them first, best first; records past the shortlist follow in
 * retrieval order with no probability.
 */
export async function rerankRetrieved(
  query: string,
  retrieved: readonly MemoryRecord[],
  limit: number | undefined,
): Promise<Array<{ readonly record: MemoryRecord; readonly probability: number | undefined }>> {
  const size = rerankShortlistSize(limit);
  const shortlist = retrieved.slice(0, size);
  const probabilities = await rerankProbabilities(query, shortlist);
  const ranked = shortlist
    .map((record) => ({ record, probability: probabilities.get(record.id) }))
    .sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0));
  return [...ranked, ...retrieved.slice(size).map((record) => ({ record, probability: undefined }))];
}

/** The two retrieval paths a semantic search ranks over; MemoryStore provides both. */
export interface SemanticRetrieval {
  retrieve(filter: MemorySearchFilter): MemoryRecord[];
  semanticCandidates(filter: MemorySearchFilter): MemorySemanticSearchResult[];
}

/**
 * Semantic search: the vector index builds the shortlist, the
 * `engine.state.memory-search` rerank orders it. `score` is the rerank's
 * probability on a 0 to 100 scale (the old field mixed similarity*100 with a
 * quarter of the lexical points, so it ran roughly 0 to 125).
 *
 * With no query there is nothing to rank against: records come back in
 * retrieval order with `score` = the record's confidence. When the index
 * returns nothing the literal search runs instead, reranked, with similarity
 * 0; records past its shortlist carry no reading and score 0.
 */
export async function rankSemanticSearch(store: SemanticRetrieval, filter: MemorySearchFilter): Promise<MemorySemanticSearchResult[]> {
  const query = filter.query?.trim();
  if (!query) {
    return store.retrieve({ ...filter, semantic: false }).map((record) => ({
      record,
      distance: Number.POSITIVE_INFINITY,
      similarity: 0,
      score: record.confidence,
    }));
  }

  const candidates = store.semanticCandidates(filter);
  if (candidates.length === 0) {
    const ranked = await rerankRetrieved(query, store.retrieve({ ...filter, semantic: false, limit: undefined }), filter.limit);
    const results = ranked.map(({ record, probability }) => ({
      record,
      distance: Number.POSITIVE_INFINITY,
      similarity: 0,
      score: (probability ?? 0) * 100,
    }));
    return filter.limit !== undefined ? results.slice(0, filter.limit) : results;
  }

  const requestedLimit = Math.max(1, filter.limit ?? 10);
  const shortlist = candidates.slice(0, rerankShortlistSize(requestedLimit));
  const probabilities = await rerankProbabilities(query, shortlist.map((entry) => entry.record));
  return shortlist
    .map((entry) => ({ ...entry, score: (probabilities.get(entry.record.id) ?? 0) * 100 }))
    .sort((a, b) => b.score - a.score || a.distance - b.distance || b.record.updatedAt - a.record.updatedAt)
    .slice(0, requestedLimit);
}

/**
 * The review queue's order: the first rerankShortlistSize(limit) candidates
 * (in the order given) are read by memory-review-priority and put first, most
 * in need of a person first, ties to the most recently updated; the rest
 * follow in the order given. Returns at most `limit` records.
 */
export async function rankReviewQueue(candidates: readonly MemoryRecord[], limit: number): Promise<MemoryRecord[]> {
  const size = rerankShortlistSize(limit);
  const shortlist = candidates.slice(0, size);
  if (shortlist.length === 0) return [];
  const port = judgmentPort(REVIEW_SITE);
  const read = await mapLimit(shortlist, REVIEW_CONCURRENCY, async (record) => {
    const run = await memoryReviewPriority.run(port, reviewPriorityState(record), { site: REVIEW_SITE });
    run.recordAction('queued');
    return { record, probability: run.readings.needs_review.probability };
  });
  const ranked = read
    .sort((a, b) => b.probability - a.probability || b.record.updatedAt - a.record.updatedAt || b.record.createdAt - a.record.createdAt)
    .map((entry) => entry.record);
  return [...ranked, ...candidates.slice(size)].slice(0, limit);
}
