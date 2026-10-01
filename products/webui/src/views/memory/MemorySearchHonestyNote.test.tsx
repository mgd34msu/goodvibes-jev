/**
 * MemorySearchHonestyNote, direct coverage for the `limit` prop's effect on the
 * `totalBeforeRecallFilter` label (cohesion review finding 3): the count is capped by
 * whatever `limit` the caller searched with, so it must never read as "every matching
 * record" when a limit was actually applied, and must fall back to an honest "total"
 * when the caller genuinely searched with no limit at all.
 *
 * Also covers the recall-floor label now that `recallFloor` travels on the wire
 * (memory-recall-contract.ts's `MIN_PROMPT_MEMORY_CONFIDENCE`, promoted onto
 * `HonestMemorySearchResult`): the label must state the exact wire value, not a
 * hardcoded percentage.
 */
import { expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { MemorySearchResult } from '../../lib/goodvibes';
import { MemorySearchHonestyNote } from './MemorySearchHonestyNote';

function baseResult(overrides: Partial<MemorySearchResult> = {}): MemorySearchResult {
  return {
    records: [],
    mode: 'literal',
    requestedSemantic: false,
    indexUnavailableReason: null,
    caveat: null,
    recallFiltered: true,
    excludedFlaggedCount: 2,
    excludedBelowFloorCount: 13,
    totalBeforeRecallFilter: 47,
    recallFloor: 60,
    ...overrides,
  };
}

function renderNote(result: MemorySearchResult, limit?: number) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(React.createElement(MemorySearchHonestyNote, { result, limit })));
  const text = container.textContent ?? '';
  flushSync(() => root.unmount());
  container.remove();
  return text;
}

test('a limited search states the limit next to the count; an unlimited one does not', () => {
  const limited = renderNote(baseResult(), 250);
  expect(limited).toContain('47');
  expect(limited).toContain('250');
  const unlimited = renderNote(baseResult(), undefined);
  expect(unlimited).toContain('47');
  expect(unlimited).not.toContain('250');
});

test('the recall-floor exclusion states the wire value, not a hardcoded percentage', () => {
  const at60 = renderNote(baseResult({ recallFloor: 60 }));
  expect(at60).toContain('13');
  expect(at60).toContain('60');
  const at75 = renderNote(baseResult({ recallFloor: 75 }));
  expect(at75).toContain('75');
  expect(at75).not.toContain('60');
});
