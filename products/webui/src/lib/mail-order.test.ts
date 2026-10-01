/**
 * mail-order.test, the sender-controlled-`date` regression this whole module exists
 * to prevent: an attacker sends a message with a far-future `Date:` header, and the
 * inbox must not let that pin it to the top. Ordering must instead follow `uid`, the
 * value the account's own IMAP server assigns on arrival.
 */
import { describe, expect, test } from 'bun:test';
import { sortInboxMessagesByUidDescending } from './mail-order';

interface FakeMessage {
  readonly uid: number;
  readonly date: string;
  readonly label: string;
}

function msg(uid: number, date: string, label: string): FakeMessage {
  return { uid, date, label };
}

describe('sortInboxMessagesByUidDescending', () => {
  test('a far-future Date: header does not win first place when its uid is lowest', () => {
    const attacker = msg(1, '2099-01-01T00:00:00Z', 'attacker (uid 1, spoofed far-future date)');
    const real1 = msg(2, '2026-01-01T09:00:00Z', 'real message (uid 2)');
    const real2 = msg(3, '2026-01-02T09:00:00Z', 'real message (uid 3)');

    const sorted = sortInboxMessagesByUidDescending([attacker, real1, real2]);

    expect(sorted[0].label).not.toBe(attacker.label);
    expect(sorted.map((m) => m.uid)).toEqual([3, 2, 1]);
  });

  test('orders newest-first by uid', () => {
    const messages = [msg(5, '2026-01-01T00:00:00Z', 'a'), msg(1, '2026-01-05T00:00:00Z', 'b'), msg(9, '2026-01-03T00:00:00Z', 'c')];
    const sorted = sortInboxMessagesByUidDescending(messages);
    expect(sorted.map((m) => m.uid)).toEqual([9, 5, 1]);
  });

  test('is stable and correct when two messages carry identical date values', () => {
    const sameDate = '2026-01-01T00:00:00Z';
    const messages = [msg(10, sameDate, 'ten'), msg(30, sameDate, 'thirty'), msg(20, sameDate, 'twenty')];
    const sorted = sortInboxMessagesByUidDescending(messages);
    expect(sorted.map((m) => m.uid)).toEqual([30, 20, 10]);
  });

  test('does not mutate the input array', () => {
    const messages = [msg(1, '2026-01-01T00:00:00Z', 'a'), msg(2, '2026-01-02T00:00:00Z', 'b')];
    const original = [...messages];
    sortInboxMessagesByUidDescending(messages);
    expect(messages).toEqual(original);
  });
});
