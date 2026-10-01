/**
 * approval-refresh.test.ts: after a decision, the list the query holds reflects
 * the decision even when the decision landed while the first list load was
 * still in flight (the push hand-off's case).
 */
import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { refetchAfterDecision } from './approval-refresh';

const KEY = ['approvals'] as const;

/** Let the event loop turn until `predicate` holds (bounded, then fail). */
async function until(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200 && !predicate(); turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(predicate()).toBe(true);
}

describe('refetchAfterDecision', () => {
  test('a decision made during the first, still-running list load is what the list ends up showing', async () => {
    let status = 'pending';
    const releases: (() => void)[] = [];
    let fetches = 0;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // The list read answers with the status as of when the request was SENT,
    // and only once the test releases it, like a slow network.
    const observer = new QueryObserver(client, {
      queryKey: KEY,
      queryFn: () => {
        fetches += 1;
        const snapshot = status;
        return new Promise<string>((resolve) => releases.push(() => resolve(snapshot)));
      },
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      // The first load is in flight, with no data yet, when the decision lands.
      expect(fetches).toBe(1);
      status = 'denied';
      const refreshed = refetchAfterDecision(client, KEY);
      // The pre-decision request answers late; it must not be what sticks.
      releases[0]?.();
      // A fresh read, sent after the decision.
      await until(() => fetches === 2);
      releases[1]?.();
      await refreshed;
      expect(client.getQueryData<string>(KEY)).toBe('denied');
    } finally {
      unsubscribe();
      client.clear();
    }
  });

  test('with data already loaded, the refetch after a decision reads the new status', async () => {
    let status = 'pending';
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const observer = new QueryObserver(client, { queryKey: KEY, queryFn: () => Promise.resolve(status) });
    const unsubscribe = observer.subscribe(() => {});
    try {
      await client.fetchQuery({ queryKey: KEY, queryFn: () => Promise.resolve(status) });
      expect(client.getQueryData<string>(KEY)).toBe('pending');
      status = 'approved';
      await refetchAfterDecision(client, KEY);
      expect(client.getQueryData<string>(KEY)).toBe('approved');
    } finally {
      unsubscribe();
      client.clear();
    }
  });
});
