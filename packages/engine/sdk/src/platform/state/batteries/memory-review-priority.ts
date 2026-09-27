/**
 * `engine.state.memory-review-priority`: how much one project-memory record
 * needs a person to check it, read by Jev in place of memory-store-helpers.ts
 * reviewQueueScore's hand-weighted total (fresh +40, stale +20, contradicted
 * +10, 100 minus confidence, 3 per tag up to 20, 4 per provenance link up to
 * 20). The review queue orders its candidates by this reading's probability.
 *
 * One request per queue candidate. State: `{ record }` with the record's
 * review state, confidence, stale reason, class, summary, detail and tags.
 *
 * Band: low stakes. The reading only orders the queue a person works through;
 * it changes no record.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';
import type { MemoryRecord } from '../memory-store.js';

/** What the reading sees of a record: its review status and its words, never its ids or timestamps. */
export function reviewPriorityState(record: MemoryRecord): { record: { [field: string]: string | number | string[] } } {
  return {
    record: {
      review_state: record.reviewState,
      confidence: record.confidence,
      ...(record.staleReason ? { stale_reason: record.staleReason } : {}),
      class: record.cls,
      summary: record.summary,
      ...(record.detail ? { detail: record.detail } : {}),
      tags: [...record.tags],
    },
  };
}

export const memoryReviewPriority = defineBattery({
  name: 'engine.state.memory-review-priority',
  version: 1,
  description: 'Whether a person should check one project-memory record before agents keep relying on it.',
  accuracyFloor: 0.9,
  items: {
    needs_review: yesNo(
      'Should a person check `record` before agents keep relying on it? `review_state` is fresh (never reviewed), reviewed, stale or contradicted, and `confidence` runs from 0 to 100.',
      STAKES_BANDS.low.yesNo,
      {
        true: 'The record is unreviewed or flagged, its confidence is low, or what it states may be wrong, vague or out of date.',
        false: 'The record has been reviewed, is trusted, and states something stable and specific.',
      },
    ),
  },
  fixtures: [
    {
      name: 'contradicted port facts',
      state: { record: { review_state: 'contradicted', confidence: 60, stale_reason: 'Records disagree about the same fact and neither is a clearly-newer verified winner.', class: 'fact', summary: 'The daemon listens on port 8080 by default', tags: ['daemon'] } },
      expect: { needs_review: 'yes' },
    },
    {
      name: 'unreviewed guess about a flaky test',
      state: { record: { review_state: 'fresh', confidence: 35, class: 'incident', summary: 'The CI timeout might be caused by the new cache layer', tags: ['ci'] } },
      expect: { needs_review: 'yes' },
    },
    {
      name: 'stale version requirement',
      state: { record: { review_state: 'stale', confidence: 70, stale_reason: 'Never referenced since injection and aged past 45d; archived by idle consolidation.', class: 'constraint', summary: 'Node 16 is the minimum supported runtime', tags: ['runtime'] } },
      expect: { needs_review: 'yes' },
    },
    {
      name: 'reviewed migration convention',
      state: { record: { review_state: 'reviewed', confidence: 92, class: 'pattern', summary: 'Database migrations are numbered SQL files under db/migrations; a shipped migration is never edited', tags: ['database'] } },
      expect: { needs_review: 'no' },
    },
    {
      name: 'reviewed logging constraint',
      state: { record: { review_state: 'reviewed', confidence: 88, class: 'constraint', summary: 'Never log request bodies in src/http/logger.ts; they can carry user passwords', tags: ['logging'] } },
      expect: { needs_review: 'no' },
    },
  ],
});
