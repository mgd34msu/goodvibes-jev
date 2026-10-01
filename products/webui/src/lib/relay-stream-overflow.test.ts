/**
 * relay-stream-overflow.ts, the honest accounting store for live events dropped over the relay.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  acknowledgeRelayOverflow,
  getRelayOverflowSnapshot,
  noteRelayOverflow,
  readDroppedCount,
  subscribeRelayOverflow,
} from './relay-stream-overflow';

afterEach(() => {
  acknowledgeRelayOverflow();
});

describe('readDroppedCount', () => {
  test('reads a numeric dropped field', () => {
    expect(readDroppedCount({ dropped: 12 })).toBe(12);
  });
  test('coerces a numeric string', () => {
    expect(readDroppedCount({ dropped: '5' })).toBe(5);
  });
  test('returns 0 for shapes without a usable count', () => {
    expect(readDroppedCount(null)).toBe(0);
    expect(readDroppedCount({})).toBe(0);
    expect(readDroppedCount({ dropped: 'nope' })).toBe(0);
  });
});

describe('overflow store', () => {
  test('accumulates dropped counts and clears on acknowledge', () => {
    expect(getRelayOverflowSnapshot().totalDropped).toBe(0);
    noteRelayOverflow(3);
    noteRelayOverflow(4);
    expect(getRelayOverflowSnapshot().totalDropped).toBe(7);
    expect(getRelayOverflowSnapshot().lastAt).toBeGreaterThan(0);
    acknowledgeRelayOverflow();
    expect(getRelayOverflowSnapshot().totalDropped).toBe(0);
    expect(getRelayOverflowSnapshot().lastAt).toBe(0);
  });

  test('a non-positive count still records an outstanding notice (events were dropped)', () => {
    noteRelayOverflow(0);
    const snapshot = getRelayOverflowSnapshot();
    expect(snapshot.totalDropped).toBe(0);
    expect(snapshot.lastAt).toBeGreaterThan(0); // the notice IS outstanding
  });

  test('notifies subscribers on change and stops after unsubscribe', () => {
    let calls = 0;
    const unsubscribe = subscribeRelayOverflow(() => { calls += 1; });
    noteRelayOverflow(1);
    expect(calls).toBe(1);
    unsubscribe();
    noteRelayOverflow(1);
    expect(calls).toBe(1);
  });
});
