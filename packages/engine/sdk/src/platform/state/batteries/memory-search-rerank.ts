/**
 * `engine.state.memory-search`: orders project-memory search results against
 * the search query, read by Jev in place of the hand-tuned point totals
 * memory-store-helpers.ts scoreRecord added up (confidence, +30 summary
 * substring, +20 detail substring, +15 semantic, tag bonus, -20 flagged) and
 * the similarity*100 + lexical*0.25 fusion memory-store.ts searchSemantic used.
 *
 * The re-ranking cookbook: retrieval (the SQL filter and the vector index)
 * builds a shortlist, then one yes/no per query-record pair, each in its own
 * request, orders it by probability.
 *
 * Band: low stakes. The order only decides which records a reader sees first;
 * nothing is changed or injected on the strength of it.
 */
import { defineRerank, STAKES_BANDS } from '@goodvibes-jev/judgment';
import type { MemoryRecord } from '../memory-store.js';

/** Most records one search sends to the rerank; retrieval order decides which. */
export const MAX_RERANK_SHORTLIST = 50;

/**
 * How many retrieved records a search reranks: four per requested result, at
 * least 12, never more than MAX_RERANK_SHORTLIST. The same breadth
 * knowledge-injection.ts has always asked the vector index for.
 */
export function rerankShortlistSize(limit: number | undefined): number {
  if (limit === undefined) return MAX_RERANK_SHORTLIST;
  return Math.min(MAX_RERANK_SHORTLIST, Math.max(limit * 4, 12));
}

/** What the rerank sees of a record: its words, never its ids, scores or timestamps. */
export function rerankContent(record: Pick<MemoryRecord, 'cls' | 'summary' | 'detail' | 'tags'>): { [field: string]: string | string[] } {
  return {
    class: record.cls,
    summary: record.summary,
    ...(record.detail ? { detail: record.detail } : {}),
    tags: [...record.tags],
  };
}

const TEST_RUNNER = { id: 'test-runner', content: { class: 'fact', summary: 'The engine test suite runs with bun test; vitest is not installed', tags: ['testing'] } };
const TEST_FLAKE = {
  id: 'test-flake',
  content: { class: 'incident', summary: 'orchestration-engine.test.ts timed out on CI twice in March', detail: 'Cause was a leaked timer in the scheduler; fixed by unref().', tags: ['ci', 'testing'] },
};
const PORT_CONFLICT = {
  id: 'port-conflict',
  content: { class: 'incident', summary: 'Daemon failed to start: port 3421 already in use by a stale process', detail: 'Kill the stale daemon or set daemon.port in settings.json.', tags: ['daemon'] },
};
const PORT_SETTING = { id: 'port-setting', content: { class: 'fact', summary: 'daemon.port in settings.json sets the port the daemon listens on (default 3421)', tags: ['daemon', 'config'] } };
const RELEASE = { id: 'release', content: { class: 'runbook', summary: 'Release: bump package.json, run bun run build, tag vX.Y.Z and push the tag', tags: ['release'] } };
const KEY_ROTATION = {
  id: 'key-rotation',
  content: { class: 'decision', summary: 'Session signing keys rotate on the first of each month', detail: 'The rotation job lives in ops/rotate-keys.ts.', tags: ['auth'] },
};

export const memorySearchRerank = defineRerank({
  name: 'engine.state.memory-search',
  version: 1,
  description: 'Orders project-memory records by whether each one is what someone searching project memory for the query wants to find.',
  accuracyFloor: 0.9,
  instructions: 'Someone searched their project memory for `query`. Is `candidate` a record they are looking for?',
  criteria: {
    true: 'The record is about what the query asks about and gives the searcher the information they want.',
    false: 'The record only shares a word or a loose topic with the query, or is about something else.',
  },
  band: STAKES_BANDS.low.yesNo,
  fixtures: [
    { name: 'which test runner', query: 'test runner', candidates: [TEST_FLAKE, RELEASE, TEST_RUNNER], expect: { top: 'test-runner' } },
    { name: 'flaky test on CI', query: 'why did the tests time out on CI', candidates: [TEST_RUNNER, TEST_FLAKE, PORT_CONFLICT], expect: { top: 'test-flake' } },
    { name: 'daemon will not start', query: 'daemon port already in use', candidates: [PORT_SETTING, RELEASE, PORT_CONFLICT], expect: { top: 'port-conflict' } },
    { name: 'change the daemon port', query: 'how do I change the daemon port', candidates: [PORT_CONFLICT, TEST_RUNNER, PORT_SETTING], expect: { top: 'port-setting' } },
    { name: 'key rotation schedule', query: 'when do signing keys rotate', candidates: [RELEASE, KEY_ROTATION, TEST_FLAKE], expect: { top: 'key-rotation' } },
    { name: 'nothing stored about it', query: 'kubernetes ingress annotations', candidates: [TEST_RUNNER, RELEASE, KEY_ROTATION], expect: { top: 'none' } },
  ],
});
