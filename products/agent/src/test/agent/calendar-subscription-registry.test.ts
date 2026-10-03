/**
 * Calendar subscription registry tests.
 *
 * Exercises the agent-side registry that wraps the SDK's platform/calendar
 * SubscriptionStore: real JSON persistence to a tmp store, an in-memory secret
 * store for the feed URL, and a FAKE fetcher, no real network is ever touched.
 * Asserts the honest surface: subscribe caches events + stores the URL as a
 * secret (never in the JSON), refresh updates status, stale carries its age,
 * merged views are read-only + source-labeled, and unsubscribe clears the secret.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { FeedFetcher, FeedFetchResult } from '@goodvibes-jev/engine/sdk/platform/calendar';
import { CalendarSubscriptionRegistry, type SubscriptionSecretStore } from '../../agent/calendar-subscription-registry.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const ICS = [
  'BEGIN:VCALENDAR',
  'X-WR-CALNAME:Work Calendar',
  'BEGIN:VEVENT',
  'UID:e1@test',
  'SUMMARY:Standup',
  'DTSTART:20260706T090000Z',
  'DTEND:20260706T093000Z',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:e2@test',
  'SUMMARY:Weekly sync',
  'DTSTART;VALUE=DATE:20260707',
  'RRULE:FREQ=WEEKLY;BYMONTHDAY=3',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const dirs: string[] = [];
function tmpStore(): string {
  const dir = makeProjectTempDir(`gv-cal-sub-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  dirs.push(dir);
  return join(dir, 'subscriptions.json');
}
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

function memorySecrets(): { store: Map<string, string>; secrets: SubscriptionSecretStore } {
  const store = new Map<string, string>();
  return {
    store,
    secrets: {
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => { store.set(k, v); },
      delete: async (k) => { store.delete(k); },
    },
  };
}

function scriptedFetcher(responses: FeedFetchResult[]): FeedFetcher {
  let i = 0;
  return async () => responses[Math.min(i++, responses.length - 1)]!;
}

/**
 * A fetcher where one specific call (by 0-based call index across the
 * fetcher's whole lifetime) parks on a gate until `release()` is called; every
 * other call resolves immediately. Used to land a concurrent
 * subscribe/unsubscribe precisely while a refresh()'s network fetch for one
 * target is still in flight (F2).
 */
function gatedFetcher(responses: FeedFetchResult[], gatedCallIndex: number): { fetcher: FeedFetcher; release: () => void; calls: () => number } {
  let calls = 0;
  let releaseFn: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { releaseFn = resolve; });
  const fetcher: FeedFetcher = async () => {
    const idx = calls;
    calls += 1;
    if (idx === gatedCallIndex) await gate;
    return responses[Math.min(idx, responses.length - 1)]!;
  };
  return { fetcher, release: () => releaseFn?.(), calls: () => calls };
}

describe('CalendarSubscriptionRegistry', () => {
  test('subscribe caches events and stores the URL as a secret, never in the JSON', async () => {
    const storePath = tmpStore();
    const { store, secrets } = memorySecrets();
    const url = 'https://cal.example/secret/abc123.ics';
    const reg = new CalendarSubscriptionRegistry({ storePath, secrets, fetcher: scriptedFetcher([{ kind: 'ok', body: ICS, etag: 'W/"1"' }]), clock: () => 1000 });

    const res = await reg.subscribe(url);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.name).toBe('Work Calendar'); // derived from X-WR-CALNAME
    expect(res.eventCount).toBe(2);

    // URL is in the secret store, NOT in the on-disk JSON.
    expect([...store.values()]).toContain(url);
    const json = readFileSync(storePath, 'utf-8');
    expect(json).not.toContain(url);
    expect(json).not.toContain('abc123');
  });

  test('statuses masks the URL and reports ok right after subscribe', async () => {
    const { secrets } = memorySecrets();
    const reg = new CalendarSubscriptionRegistry({ storePath: tmpStore(), secrets, fetcher: scriptedFetcher([{ kind: 'ok', body: ICS }]), clock: () => 1000 });
    await reg.subscribe('https://cal.example/feed/xyz.ics');
    const [status] = await reg.statuses();
    expect(status?.health).toBe('ok');
    expect(status?.maskedUrl).not.toContain('xyz');
    expect(status?.eventCount).toBe(2);
  });

  test('seeds are read-only, source-labeled, and mark an unsupported recurrence', async () => {
    const { secrets } = memorySecrets();
    const reg = new CalendarSubscriptionRegistry({ storePath: tmpStore(), secrets, fetcher: scriptedFetcher([{ kind: 'ok', body: ICS }]), clock: () => 1000 });
    await reg.subscribe('https://cal.example/feed.ics');
    const seeds = reg.seeds();
    expect(seeds).toHaveLength(2);
    expect(seeds.every((s) => s.id.startsWith('sub:Work Calendar:'))).toBe(true);
    // The BYMONTHDAY rule is outside the supported subset -> marked, not expanded.
    const weekly = seeds.find((s) => s.title === 'Weekly sync');
    expect(weekly?.recurrenceNotFullyExpanded).toBe(true);
  });

  test('occurrencesInWindow clips to the window', async () => {
    const { secrets } = memorySecrets();
    const reg = new CalendarSubscriptionRegistry({ storePath: tmpStore(), secrets, fetcher: scriptedFetcher([{ kind: 'ok', body: ICS }]), clock: () => 1000 });
    await reg.subscribe('https://cal.example/feed.ics');
    const occ = reg.occurrencesInWindow('2026-07-06', '2026-07-06');
    // Only the 07-06 Standup falls in this one-day window (the weekly seed is 07-07).
    expect(occ.map((o) => o.title)).toEqual(['Standup']);
  });

  test('refresh reports not-modified on a 304 and keeps events', async () => {
    const { secrets } = memorySecrets();
    let now = 0;
    const reg = new CalendarSubscriptionRegistry({ storePath: tmpStore(), secrets, fetcher: scriptedFetcher([{ kind: 'ok', body: ICS, etag: 'W/"1"' }, { kind: 'not-modified', etag: 'W/"1"' }]), clock: () => now });
    await reg.subscribe('https://cal.example/feed.ics');
    now += 10_000;
    const [outcome] = await reg.refresh('Work Calendar', { force: true });
    expect(outcome?.outcome).toBe('not-modified');
    expect(reg.seeds()).toHaveLength(2); // kept
  });

  test('refresh reports unreachable honestly and keeps the last-good events', async () => {
    const { secrets } = memorySecrets();
    let now = 0;
    const reg = new CalendarSubscriptionRegistry({ storePath: tmpStore(), secrets, fetcher: scriptedFetcher([{ kind: 'ok', body: ICS }, { kind: 'error', status: 503, message: 'unavailable' }]), clock: () => now });
    await reg.subscribe('https://cal.example/feed.ics');
    now += 10_000;
    const [outcome] = await reg.refresh('Work Calendar', { force: true });
    expect(outcome?.outcome).toBe('unreachable');
    expect(outcome?.detail).toContain('503');
    expect(reg.seeds()).toHaveLength(2);
    const [status] = await reg.statuses();
    expect(status?.health).toBe('unreachable');
  });

  test('stale health carries its age once data ages past the window', async () => {
    const { secrets } = memorySecrets();
    let now = 0;
    const reg = new CalendarSubscriptionRegistry({ storePath: tmpStore(), secrets, fetcher: scriptedFetcher([{ kind: 'ok', body: ICS }]), clock: () => now, defaultRefreshIntervalMs: 60 * 60_000 });
    await reg.subscribe('https://cal.example/feed.ics');
    now += 60 * 60_000 * 2 + 1;
    const [status] = await reg.statuses();
    expect(status?.health).toBe('stale');
    expect(status?.detail).toContain('min ago');
  });

  test('unsubscribe removes the subscription and clears the stored secret', async () => {
    const { store, secrets } = memorySecrets();
    const reg = new CalendarSubscriptionRegistry({ storePath: tmpStore(), secrets, fetcher: scriptedFetcher([{ kind: 'ok', body: ICS }]), clock: () => 1000 });
    await reg.subscribe('https://cal.example/feed.ics');
    expect(store.size).toBe(1);
    expect(await reg.unsubscribe('Work Calendar')).toBe(true);
    expect(reg.hasAny()).toBe(false);
    expect(store.size).toBe(0); // secret cleaned up
  });

  test('subscribe refuses a non-calendar body naming the parse stage', async () => {
    const { secrets } = memorySecrets();
    const reg = new CalendarSubscriptionRegistry({ storePath: tmpStore(), secrets, fetcher: scriptedFetcher([{ kind: 'ok', body: '<html>no</html>' }]), clock: () => 1000 });
    const res = await reg.subscribe('https://cal.example/notacal');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.stage).toBe('parse');
  });
});

/**
 * F2: refresh() snapshots the store, awaits network for as long as the fetch
 * takes, then used to blind-write the whole file from that stale snapshot,
 * so a concurrent subscribe/unsubscribe landing during that window was
 * silently reverted. Fixed by serializing every mutation's WRITE through one
 * in-process queue and having refresh() re-read the store fresh and merge
 * per-record right before it writes. These tests park a refresh mid-fetch
 * (via gatedFetcher), land a concurrent mutation while it's parked, then
 * release the fetch and assert the concurrent mutation survived.
 */
describe('CalendarSubscriptionRegistry: concurrent-mutation safety (F2)', () => {
  test('a subscribe that lands while a refresh is mid-fetch survives the refresh\'s write', async () => {
    const { secrets } = memorySecrets();
    const storePath = tmpStore();
    // Fetcher call order is by ACTUAL invocation, not by which statement is
    // written first: refresh() awaits secrets.get() before it ever reaches
    // the fetcher, while subscribe()'s store.add() reaches the fetcher with
    // no intervening await. So the concurrent second subscribe's fetch
    // (call 1) actually lands before refresh's own fetch (call 2), call 0
    // is the initial (fully-awaited) subscribe that seeds the registry.
    const { fetcher, release } = gatedFetcher([{ kind: 'ok', body: ICS }, { kind: 'ok', body: ICS }, { kind: 'ok', body: ICS }], 2);
    const reg = new CalendarSubscriptionRegistry({ storePath, secrets, fetcher, clock: () => 1000, defaultRefreshIntervalMs: 60_000 });
    await reg.subscribe('https://cal.example/work.ics');
    expect(reg.names()).toEqual(['Work Calendar']);

    const refreshPromise = reg.refresh('Work Calendar', { force: true });
    // The refresh's fetch is now parked on the gate. Land a subscribe for a
    // second, differently-named feed while it's stuck there.
    const subscribeResult = await reg.subscribe('https://cal.example/second.ics', 'Second Feed');
    expect(subscribeResult.ok).toBe(true);
    expect([...reg.names()].sort()).toEqual(['Second Feed', 'Work Calendar']);

    release();
    const [outcome] = await refreshPromise;
    expect(outcome?.outcome).toBe('updated');

    // The subscribe that landed mid-refresh must still be there afterward,
    // the old bug reverted it via a blind full-file overwrite.
    expect([...reg.names()].sort()).toEqual(['Second Feed', 'Work Calendar']);
    const onDisk = JSON.parse(readFileSync(storePath, 'utf-8')) as { subscriptions: readonly { name: string }[] };
    expect(onDisk.subscriptions.map((s) => s.name).sort()).toEqual(['Second Feed', 'Work Calendar']);
  });

  test('an unsubscribe of the very subscription being refreshed stays removed after the refresh completes', async () => {
    const { secrets } = memorySecrets();
    const storePath = tmpStore();
    const { fetcher, release } = gatedFetcher([{ kind: 'ok', body: ICS }, { kind: 'ok', body: ICS }], 1);
    const reg = new CalendarSubscriptionRegistry({ storePath, secrets, fetcher, clock: () => 1000, defaultRefreshIntervalMs: 60_000 });
    await reg.subscribe('https://cal.example/work.ics');
    expect(reg.hasAny()).toBe(true);

    const refreshPromise = reg.refresh('Work Calendar', { force: true });
    // The refresh is parked mid-fetch for 'Work Calendar'. Unsubscribe it
    // right now, before the fetch (and the refresh's eventual write) lands.
    const unsubscribed = await reg.unsubscribe('Work Calendar');
    expect(unsubscribed).toBe(true);
    expect(reg.hasAny()).toBe(false);

    release();
    await refreshPromise;

    // The old bug: refresh's blind full-file write would resurrect the
    // subscription it had snapshotted before the unsubscribe landed.
    expect(reg.hasAny()).toBe(false);
    expect(reg.names()).toEqual([]);
    const onDisk = JSON.parse(readFileSync(storePath, 'utf-8')) as { subscriptions: readonly unknown[] };
    expect(onDisk.subscriptions).toEqual([]);
  });

  test('two concurrent refreshes of the same subscription do not double-write or corrupt the store', async () => {
    const { secrets } = memorySecrets();
    const storePath = tmpStore();
    const reg = new CalendarSubscriptionRegistry({ storePath, secrets, fetcher: scriptedFetcher([{ kind: 'ok', body: ICS }, { kind: 'ok', body: ICS }, { kind: 'ok', body: ICS }]), clock: () => 1000, defaultRefreshIntervalMs: 60_000 });
    await reg.subscribe('https://cal.example/work.ics');

    const [first, second] = await Promise.all([
      reg.refresh('Work Calendar', { force: true }),
      reg.refresh('Work Calendar', { force: true }),
    ]);
    expect(first[0]?.outcome).toBe('updated');
    expect(second[0]?.outcome).toBe('updated');

    // Exactly one subscription, not duplicated, and the on-disk file is valid JSON.
    expect(reg.names()).toEqual(['Work Calendar']);
    const onDisk = JSON.parse(readFileSync(storePath, 'utf-8')) as { subscriptions: readonly { name: string; eventCount: number }[] };
    expect(onDisk.subscriptions).toHaveLength(1);
    expect(onDisk.subscriptions[0]?.name).toBe('Work Calendar');
    expect(onDisk.subscriptions[0]?.eventCount).toBe(2);
  });
});

