/**
 * race-deadline-timer-teardown.test.ts
 *
 * A deadline timer that was created and then forgotten.
 *
 * The losing side of a `Promise.race` is never settled, so a `setTimeout` used
 * as a deadline keeps its handle, and the closure it holds, until the delay
 * finally elapses, even though the result was decided long before. Measured
 * across a full suite run: 65 uncleared 15s lock deadlines. They do not pin the
 * event loop, they are unref'd, but they retain their closures and still fire.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';

import { cancelActiveTurn, type ActiveCompanionTurn } from '../sdk/src/platform/companion/companion-chat-turn-control.ts';

/** The delay the subject uses, so an assertion names the timer it means. */
const CANCEL_SETTLE_TIMEOUT_MS = 3_000;

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
/** Delay -> count of handles created at that delay and not yet cleared or fired. */
let pending: Map<number, number>;

beforeEach(() => {
  pending = new Map<number, number>();
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const delay = ms ?? 0;
    let handle: unknown;
    const wrapped = (...a: unknown[]): void => {
      pending.set(delay, (pending.get(delay) ?? 1) - 1);
      (fn as (...x: unknown[]) => void)(...a);
    };
    handle = realSetTimeout(wrapped as never, ms as never, ...(rest as never[]));
    pending.set(delay, (pending.get(delay) ?? 0) + 1);
    (handle as { __delay?: number }).__delay = delay;
    return handle as ReturnType<typeof globalThis.setTimeout>;
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((handle: { __delay?: number }) => {
    if (handle?.__delay !== undefined) {
      pending.set(handle.__delay, (pending.get(handle.__delay) ?? 1) - 1);
    }
    return realClearTimeout(handle as never);
  }) as typeof globalThis.clearTimeout;
});

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
});

test('cancelActiveTurn clears its settle deadline when the turn settles first', async () => {
  const turn: ActiveCompanionTurn = {
    turnId: 'turn-1',
    controller: new AbortController(),
    cancelRequested: false,
    // Already settled: the deadline loses the race immediately, which is the
    // ordinary case and the one that used to strand a 3s handle every time.
    settled: Promise.resolve({ partialPersisted: true }),
  };

  const result = await cancelActiveTurn('session-1', turn, {});

  expect(result.cancelled).toBe(true);
  expect(result.partialPersisted).toBe(true);
  expect(pending.get(CANCEL_SETTLE_TIMEOUT_MS) ?? 0).toBe(0);
});
