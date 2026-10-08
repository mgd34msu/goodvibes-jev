import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { InboxCursorStore } from '../sdk/src/platform/intake/cursor-store.ts';
import { InboundPoller, type PollerOptions } from '../sdk/src/platform/intake/poller.ts';
import type { InboundChannelItem, InboundProviderAdapter, ProviderPollOptions, ProviderPollResult } from '../sdk/src/platform/intake/provider-adapter.ts';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const empty: ProviderPollResult = { state: 'empty', items: [], configured: true };
const item = (id: string): InboundChannelItem => ({ id, provider: 'fixture', kind: 'dm', fromDigest: '0123456789abcdef', subjectPreview: 'Fixture', bodyPreview: 'Fixture', receivedAt: Date.now(), unread: true });
async function fixture(poll: (options: ProviderPollOptions) => Promise<ProviderPollResult>, options: Partial<PollerOptions> = {}) {
  const store = new InboxCursorStore(makeProjectTempDir('inbox-poller-lifecycle'), undefined, { sweepIntervalMs: 0 });
  await store.init();
  cleanups.push(() => store.close());
  const ticks = new Map<number, () => void>();
  let timer = 0;
  const adapter: InboundProviderAdapter = { id: 'fixture', pollIntervalMs: 1000, poll };
  const poller = new InboundPoller({ store, adapters: new Map([[adapter.id, adapter]]), logger: { info() {}, warn() {}, error() {} },
    setIntervalImpl: ((callback: () => void) => { ticks.set(++timer, callback); return timer; }) as unknown as typeof setInterval,
    clearIntervalImpl: ((id: number) => { ticks.delete(id); }) as unknown as typeof clearInterval,
    ...options,
  });
  cleanups.push(async () => { await poller.stop(); });
  return { store, poller, ticks };
}

describe('inbound poller owned generations', () => {
  test('provider stop aborts, waits for actual completion and discards a late result', async () => {
    const started = deferred<ProviderPollOptions>();
    const result = deferred<ProviderPollResult>();
    const { store, poller } = await fixture(async (options) => { started.resolve(options); return result.promise; });
    poller.startProvider('fixture');
    const polling = poller.pollProviderOnce('fixture');
    const options = await started.promise;
    let stopped = false;
    const stopping = Promise.resolve(poller.stopProvider('fixture')).then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stoppedBeforeResult = stopped;
    result.resolve({ state: 'ready', configured: true, items: [item('late')] });
    await Promise.all([polling, stopping]);
    expect(stoppedBeforeResult).toBe(false);
    expect(options.signal?.aborted).toBe(true);
    expect(store.countItems()).toBe(0);
    expect(store.getCursor('fixture')).toBe(0);
    expect(poller.snapshotStatuses()[0]?.polled).toBe(false);
  });

  test('stop waits for a persistence operation already accepted before handoff', async () => {
    const { store, poller } = await fixture(async () => ({ state: 'ready', configured: true, items: [item('accepted')] }));
    const writing = deferred<void>();
    const release = deferred<void>();
    const original = store.commitTimestampPoll.bind(store);
    const flush = spyOn(store, 'commitTimestampPoll').mockImplementation(async (...args) => { const count = await original(...args); writing.resolve(); await release.promise; return count; });
    cleanups.push(() => flush.mockRestore());
    const polling = poller.pollOnce();
    await writing.promise;
    let stopped = false;
    const stopping = Promise.resolve(poller.stop()).then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stoppedBeforeWrite = stopped;
    release.resolve();
    await Promise.all([polling, stopping]);
    expect(stoppedBeforeWrite).toBe(false);
    expect(store.countItems()).toBe(1);
  });

  test('permanent stop prevents manual polling and late interval callbacks', async () => {
    let calls = 0;
    const { poller, ticks } = await fixture(async () => { calls += 1; return empty; });
    poller.start();
    const staleTick = [...ticks.values()][0]!;
    await poller.stop();
    staleTick();
    await poller.pollOnce();
    await poller.pollProviderOnce('fixture');
    poller.start();
    poller.startProvider('fixture');
    expect(calls).toBe(0);
    expect(ticks.size).toBe(0);
  });

  test('explicit restart permits a new generation but never adopts the old result', async () => {
    const started = deferred<void>();
    const old = deferred<ProviderPollResult>();
    let calls = 0;
    const { poller, store } = await fixture(async () => {
      calls += 1;
      if (calls === 1) { started.resolve(); return old.promise; }
      return { state: 'ready', configured: true, items: [item('fresh')] };
    });
    poller.startProvider('fixture');
    const first = poller.pollOnce();
    await started.promise;
    const stopping = poller.stopProvider('fixture');
    poller.startProvider('fixture');
    old.resolve({ state: 'ready', configured: true, items: [item('old')] });
    await Promise.all([first, stopping]);
    await poller.pollProviderOnce('fixture');
    expect(store.listItems({ limit: 10 }).map((row) => row.id)).toEqual(['fresh']);
  });

  test('a queued timer from a retired generation cannot poll after restart', async () => {
    let calls = 0;
    const { poller, ticks } = await fixture(async () => { calls += 1; return empty; });
    poller.startProvider('fixture');
    const oldTick = [...ticks.values()][0]!;
    await poller.stopProvider('fixture');
    poller.startProvider('fixture');
    oldTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(0);
    const newTick = [...ticks.values()][0]!;
    newTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
  });

  test('handoff of one provider leaves the other provider running', async () => {
    let firstCalls = 0; let secondCalls = 0;
    const adapters = new Map<string, InboundProviderAdapter>([
      ['first', { id: 'first', pollIntervalMs: 1000, async poll() { firstCalls += 1; return empty; } }],
      ['second', { id: 'second', pollIntervalMs: 1000, async poll() { secondCalls += 1; return empty; } }],
    ]);
    const { poller } = await fixture(async () => empty, { adapters });
    poller.start();
    await poller.stopProvider('first');
    await poller.pollOnce();
    expect(firstCalls).toBe(0);
    expect(secondCalls).toBe(1);
    expect(poller.isProviderRunning('first')).toBe(false);
    expect(poller.isProviderRunning('second')).toBe(true);
    poller.startProvider('first');
    await poller.pollOnce();
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(2);
  });

  test('a failing cursor read does not strand admission or escape the poll loop', async () => {
    let calls = 0;
    const { poller, store } = await fixture(async () => { calls += 1; return empty; });
    const cursor = spyOn(store, 'getCursor').mockImplementationOnce(() => { throw new Error('fixture cursor unavailable'); });
    cleanups.push(() => cursor.mockRestore());
    await expect(poller.pollOnce()).resolves.toBeUndefined();
    await poller.pollOnce();
    expect(calls).toBe(1);
    expect(poller.snapshotStatuses()[0]?.state).toBe('empty');
  });

  test('adapter rejection does not invent successful credential resolution', async () => {
    const { poller } = await fixture(async () => { throw new Error('fixture reader failed'); });
    await poller.pollOnce();
    expect(poller.snapshotStatuses()[0]).toMatchObject({ state: 'unavailable', polled: true });
    expect(poller.snapshotStatuses()[0]?.configured).toBeUndefined();
  });

  test('storage failure preserves explicit adapter-reported configuration', async () => {
    const { poller, store } = await fixture(async () => empty);
    const flush = spyOn(store, 'commitTimestampPoll').mockRejectedValueOnce(new Error('fixture persistence failed'));
    cleanups.push(() => flush.mockRestore());
    await poller.pollOnce();
    expect(poller.snapshotStatuses()[0]).toMatchObject({ state: 'unavailable', configured: true });
  });

  test('logger failure cannot reject a floating interval operation', async () => {
    const { poller } = await fixture(async () => { throw new Error('fixture fetch failed'); }, {
      logger: { info() {}, error() {}, warn() { throw new Error('fixture logger failed'); } },
    });
    await expect(poller.pollOnce()).resolves.toBeUndefined();
    expect(poller.snapshotStatuses()[0]?.state).toBe('unavailable');
  });

  test('overlapping manual polls await the same operation without duplicate fetching', async () => {
    const started = deferred<void>();
    const result = deferred<ProviderPollResult>();
    let calls = 0;
    const { poller } = await fixture(async () => { calls += 1; started.resolve(); return result.promise; });
    const first = poller.pollOnce();
    await started.promise;
    let secondFinished = false;
    const second = poller.pollOnce().then(() => { secondFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const returnedBeforeResult = secondFinished;
    result.resolve(empty);
    await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(returnedBeforeResult).toBe(false);
  });

  test('legacy synchronous stop calls stay observed when timer cleanup or logging throws', async () => {
    const { poller } = await fixture(async () => empty, {
      clearIntervalImpl: (() => { throw new Error('fixture timer failed'); }) as unknown as typeof clearInterval,
      logger: { info() {}, error() {}, warn() { throw new Error('fixture logger failed'); } },
    });
    poller.start();
    expect(() => { void poller.stop(); }).not.toThrow();
    expect(poller.stop()).toBe(poller.stop());
    await expect(poller.stop()).resolves.toBeUndefined();
  });
});
