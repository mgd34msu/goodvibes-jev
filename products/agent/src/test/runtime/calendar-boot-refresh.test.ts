/**
 * Calendar subscription boot refresh tests.
 *
 * Uses the real CalendarSubscriptionRegistry over a tmp store with an injected
 * FAKE fetcher and fake clock, no real network. Proves the boot contract:
 * due feeds are fetched (conditional validators sent), not-due feeds are
 * skipped without network, failures produce ONE honest aggregate line while
 * the last-good events and per-feed health survive, an all-skipped or
 * no-subscriptions boot stays silent, and the scheduling call never blocks
 * on the network.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { FeedFetcher, FeedFetchResult } from '@goodvibes-jev/engine/sdk/platform/calendar';
import { CalendarSubscriptionRegistry, type SubscriptionSecretStore } from '../../agent/calendar-subscription-registry.ts';
import {
  formatCalendarBootRefreshLine,
  scheduleCalendarSubscriptionBootRefresh,
} from '../../runtime/calendar-boot-refresh.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const ICS = 'BEGIN:VCALENDAR\r\nX-WR-CALNAME:Boot Feed\r\nBEGIN:VEVENT\r\nUID:e1\r\nSUMMARY:Ev\r\nDTSTART:20260706T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR';
const URL = 'https://cal.example/feed.ics';
const HOUR = 60 * 60_000;

const dirs: string[] = [];
function tmpStorePath(): string {
  const dir = makeProjectTempDir(`gv-cal-boot-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  dirs.push(dir);
  return join(dir, 'subscriptions.json');
}
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

function memorySecrets(): SubscriptionSecretStore {
  const store = new Map<string, string>();
  return { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); } };
}

function countingFetcher(responses: FeedFetchResult[]): { fetcher: FeedFetcher; calls: () => number } {
  let i = 0;
  let calls = 0;
  return {
    fetcher: async () => { calls += 1; return responses[Math.min(i++, responses.length - 1)]!; },
    calls: () => calls,
  };
}

interface Harness {
  registry: CalendarSubscriptionRegistry;
  lines: string[];
  renders: () => number;
  run: () => Promise<void>;
  calls: () => number;
  advance: (ms: number) => void;
}

/** Subscribe once at t=0 with the first response, then hand back a boot harness. */
async function makeHarness(responses: FeedFetchResult[]): Promise<Harness> {
  let now = 0;
  const { fetcher, calls } = countingFetcher(responses);
  const registry = new CalendarSubscriptionRegistry({
    storePath: tmpStorePath(),
    secrets: memorySecrets(),
    fetcher,
    clock: () => now,
    defaultRefreshIntervalMs: HOUR,
  });
  const sub = await registry.subscribe(URL);
  expect(sub.ok).toBe(true);

  const lines: string[] = [];
  let renders = 0;
  const run = () => scheduleCalendarSubscriptionBootRefresh({
    shellPaths: { resolveUserPath: () => '/unused' },
    secretsManager: memorySecrets(),
    systemMessageRouter: { low: (m: string) => { lines.push(m); } },
    requestRender: () => { renders += 1; },
    buildRegistry: () => registry,
  });
  return { registry, lines, renders: () => renders, run, calls, advance: (ms) => { now += ms; } };
}

describe('formatCalendarBootRefreshLine', () => {
  test('all skipped -> null (silent boot)', () => {
    expect(formatCalendarBootRefreshLine([{ name: 'a', outcome: 'skipped' }])).toBeNull();
    expect(formatCalendarBootRefreshLine([])).toBeNull();
  });

  test('checked + failure compose one honest line, only the genuinely-updated one counted as updated', () => {
    const line = formatCalendarBootRefreshLine([
      { name: 'a', outcome: 'updated', eventCount: 3 },
      { name: 'b', outcome: 'not-modified' },
      { name: 'work', outcome: 'unreachable', detail: 'HTTP 503' },
    ]);
    expect(line).toBe("[Calendar] checked 2 subscriptions (1 updated); 'work' unreachable, will retry next refresh");
  });

  test('parse error is named as such', () => {
    const line = formatCalendarBootRefreshLine([{ name: 'bad', outcome: 'parse-error' }]);
    expect(line).toBe("[Calendar] 'bad' parse error, will retry next refresh");
  });

  test('F6: an all-304 (not-modified) batch is checked but never claims an update', () => {
    const line = formatCalendarBootRefreshLine([
      { name: 'a', outcome: 'not-modified' },
      { name: 'b', outcome: 'not-modified' },
    ]);
    expect(line).toBe('[Calendar] checked 2 subscriptions (0 updated)');
  });
});

describe('scheduleCalendarSubscriptionBootRefresh', () => {
  test('due feed is fetched and reported in one aggregate line', async () => {
    const h = await makeHarness([{ kind: 'ok', body: ICS }, { kind: 'ok', body: ICS }]);
    const before = h.calls();
    h.advance(HOUR + 1); // past the interval -> due
    await h.run();
    expect(h.calls()).toBe(before + 1); // exactly one fetch
    expect(h.lines).toEqual(['[Calendar] checked 1 subscription (1 updated)']);
    expect(h.renders()).toBe(1);
  });

  test('not-due feed is skipped without network and without a line', async () => {
    const h = await makeHarness([{ kind: 'ok', body: ICS }]);
    const before = h.calls();
    h.advance(HOUR / 2); // still inside the interval
    await h.run();
    expect(h.calls()).toBe(before); // no fetch happened
    expect(h.lines).toEqual([]); // silent
    expect(h.renders()).toBe(0);
  });

  test('unreachable feed: honest line, last-good events kept, health reads unreachable', async () => {
    const h = await makeHarness([{ kind: 'ok', body: ICS }, { kind: 'error', status: 503, message: 'unavailable' }]);
    h.advance(HOUR + 1);
    await h.run();
    expect(h.lines).toEqual(["[Calendar] 'Boot Feed' unreachable, will retry next refresh"]);
    expect(h.registry.seeds()).toHaveLength(1); // cached events survive
    const [status] = await h.registry.statuses();
    expect(status?.health).toBe('unreachable');
  });

  test('no subscriptions: no network, no line', async () => {
    const { fetcher, calls } = countingFetcher([{ kind: 'ok', body: ICS }]);
    const registry = new CalendarSubscriptionRegistry({ storePath: tmpStorePath(), secrets: memorySecrets(), fetcher, clock: () => 0 });
    const lines: string[] = [];
    await scheduleCalendarSubscriptionBootRefresh({
      shellPaths: { resolveUserPath: () => '/unused' },
      secretsManager: memorySecrets(),
      systemMessageRouter: { low: (m: string) => { lines.push(m); } },
      requestRender: () => {},
      buildRegistry: () => registry,
    });
    expect(calls()).toBe(0);
    expect(lines).toEqual([]);
  });

  test('boot never blocks on the network: the call returns while the fetch is still pending', async () => {
    let releaseFetch: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseFetch = resolve; });
    let now = 0;
    let fetches = 0;
    const slowFetcher: FeedFetcher = async () => {
      fetches += 1;
      if (fetches > 1) { await gate; } // first fetch (subscribe) is instant; boot fetch hangs until released
      return { kind: 'ok', body: ICS };
    };
    const registry = new CalendarSubscriptionRegistry({ storePath: tmpStorePath(), secrets: memorySecrets(), fetcher: slowFetcher, clock: () => now, defaultRefreshIntervalMs: HOUR });
    await registry.subscribe(URL);
    now += HOUR + 1;

    const lines: string[] = [];
    const pending = scheduleCalendarSubscriptionBootRefresh({
      shellPaths: { resolveUserPath: () => '/unused' },
      secretsManager: memorySecrets(),
      systemMessageRouter: { low: (m: string) => { lines.push(m); } },
      requestRender: () => {},
      buildRegistry: () => registry,
    });
    // The scheduling call has already returned control here, boot is not
    // blocked, while the refresh has not completed or reported anything.
    expect(lines).toEqual([]);
    // Drain microtasks: the background pass reaches the fetcher and parks on
    // the gate (started but blocked), still without reporting.
    await new Promise((r) => { setTimeout(r, 0); });
    expect(fetches).toBe(2); // boot fetch started...
    expect(lines).toEqual([]); // ...but is parked, not completed
    releaseFetch?.();
    await pending;
    expect(lines).toEqual(['[Calendar] checked 1 subscription (1 updated)']);
  });
});
