import type { MemoryRecordWire } from './mock-daemon';

/** Synthetic engine.state.memory-review-priority needs_review readings, never inferred from confidence. */
export const MEMORY_REVIEW_PROBABILITIES: Readonly<Record<string, number>> = Object.freeze({
  'mem-review-1': 0.98,
  'mem-fact-1': 0.72,
  'mem-persona-1': 0.04,
});

/** Same ordering/tie policy as canonical rankReviewQueue; every candidate remains eligible. */
export function rankFixtureMemoryReview(records: readonly MemoryRecordWire[], probabilities: ReadonlyMap<string, number>, limit: number): MemoryRecordWire[] | undefined {
  if (records.some(record => {
    const value = probabilities.get(record.id);
    return value === undefined || !Number.isFinite(value) || value < 0 || value > 1;
  })) return undefined;
  return [...records].sort((a, b) => probabilities.get(b.id)! - probabilities.get(a.id)!
    || b.updatedAt - a.updatedAt || b.createdAt - a.createdAt).slice(0, Math.max(0, limit));
}
