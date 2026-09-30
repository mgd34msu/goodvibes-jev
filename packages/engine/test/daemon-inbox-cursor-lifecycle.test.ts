import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { InboxCursorStore } from '../sdk/src/platform/intake/cursor-store.ts';
import type { InboundChannelItem } from '../sdk/src/platform/intake/provider-adapter.ts';
import { HandlerSqliteStore } from '../sdk/src/platform/state/daemon-handler-sqlite-store.ts';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function track(store: InboxCursorStore) { cleanups.push(() => store.close()); return store; }
function item(id: string, receivedAt = Date.now()): InboundChannelItem {
  return { id, provider: 'fixture', kind: 'dm', fromDigest: '0123456789abcdef', subjectPreview: 'Fixture', bodyPreview: 'Fixture', receivedAt, unread: true };
}
function directory() { return makeProjectTempDir('inbox-cursor-lifecycle'); }

describe('inbox cursor store lifecycle', () => {
  test('a completed older flush cannot clear a newer unsaved item', async () => {
    const dir = directory();
    const store = track(new InboxCursorStore(dir, undefined, { sweepIntervalMs: 0 }));
    await store.init();
    store.upsertItems([item('first')]);
    const saved = deferred<void>();
    const release = deferred<void>();
    const original = HandlerSqliteStore.prototype.save;
    let calls = 0;
    const save = spyOn(HandlerSqliteStore.prototype, 'save').mockImplementation(async function(this: HandlerSqliteStore) {
      calls += 1;
      await original.call(this);
      if (calls === 1) { saved.resolve(); await release.promise; }
    });
    cleanups.push(() => save.mockRestore());
    const first = store.flush();
    await saved.promise;
    store.upsertItems([item('second')]);
    release.resolve();
    await first;
    await store.flush();
    await store.close();
    const reopened = track(new InboxCursorStore(dir, undefined, { sweepIntervalMs: 0 }));
    await reopened.init();
    expect(reopened.listItems({ limit: 10 }).map((row) => row.id).sort()).toEqual(['first', 'second']);
  });

  test('close waits for already-running flushes, not just its own snapshot', async () => {
    const store = track(new InboxCursorStore(directory(), undefined, { sweepIntervalMs: 0 }));
    await store.init();
    store.upsertItems([item('first')]);
    const saved = deferred<void>();
    const release = deferred<void>();
    const original = HandlerSqliteStore.prototype.save;
    let calls = 0;
    const save = spyOn(HandlerSqliteStore.prototype, 'save').mockImplementation(async function(this: HandlerSqliteStore) {
      calls += 1;
      await original.call(this);
      if (calls === 1) { saved.resolve(); await release.promise; }
    });
    cleanups.push(() => save.mockRestore());
    const flushing = store.flush();
    await saved.promise;
    let closed = false;
    const closing = store.close().then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const closedBeforeRelease = closed;
    release.resolve();
    await Promise.all([flushing, closing]);
    expect(closedBeforeRelease).toBe(false);
  });

  test('close during initialization leaves no reopened database or retention timer', async () => {
    const opened = deferred<void>();
    const release = deferred<void>();
    const original = HandlerSqliteStore.prototype.init;
    const init = spyOn(HandlerSqliteStore.prototype, 'init').mockImplementation(async function(this: HandlerSqliteStore) {
      await release.promise;
      await original.call(this);
      opened.resolve();
    });
    cleanups.push(() => init.mockRestore());
    let armed = 0;
    const store = track(new InboxCursorStore(directory(), undefined, {
      setIntervalImpl: (() => { armed += 1; return 0; }) as unknown as typeof setInterval,
      clearIntervalImpl: (() => {}) as unknown as typeof clearInterval,
    }));
    const booting = store.init();
    const closing = store.close();
    release.resolve();
    await Promise.all([booting, closing, opened.promise]);
    expect(armed).toBe(0);
    expect(() => store.countItems()).toThrow();
    await expect(store.init()).rejects.toThrow('closed');
  });

  test('repeated close returns one promise and waits for actual persistence', async () => {
    const store = track(new InboxCursorStore(directory(), undefined, { sweepIntervalMs: 0 }));
    await store.init();
    store.upsertItems([item('first')]);
    const saved = deferred<void>();
    const release = deferred<void>();
    const original = HandlerSqliteStore.prototype.save;
    const save = spyOn(HandlerSqliteStore.prototype, 'save').mockImplementation(async function(this: HandlerSqliteStore) {
      await original.call(this); saved.resolve(); await release.promise;
    });
    cleanups.push(() => save.mockRestore());
    const first = store.close();
    await saved.promise;
    const second = store.close();
    const shared = first === second;
    let returned = false;
    void second.then(() => { returned = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const returnedBeforePersistence = returned;
    release.resolve();
    await Promise.all([first, second]);
    expect(shared).toBe(true);
    expect(returnedBeforePersistence).toBe(false);
  });

  test('a queued retention callback after close does not query or disclose errors', async () => {
    let tick!: () => void;
    const errors: string[] = [];
    const store = track(new InboxCursorStore(directory(), undefined, {
      setIntervalImpl: ((callback: () => void) => { tick = callback; return 0; }) as unknown as typeof setInterval,
      clearIntervalImpl: (() => {}) as unknown as typeof clearInterval,
      onSweepError: (error) => errors.push(error),
    }));
    await store.init();
    await store.close();
    tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toEqual([]);
  });

  test('concurrent init calls await the same persisted recovery sweep', async () => {
    const dir = directory();
    const seed = track(new InboxCursorStore(dir, undefined, { now: () => 0, sweepIntervalMs: 0 }));
    await seed.init();
    seed.upsertItems([item('expired', 1)]);
    await seed.close();
    const saved = deferred<void>();
    const release = deferred<void>();
    const original = HandlerSqliteStore.prototype.save;
    const save = spyOn(HandlerSqliteStore.prototype, 'save').mockImplementation(async function(this: HandlerSqliteStore) {
      await original.call(this); saved.resolve(); await release.promise;
    });
    cleanups.push(() => save.mockRestore());
    let armed = 0;
    const store = track(new InboxCursorStore(dir, undefined, {
      setIntervalImpl: (() => { armed += 1; return 0; }) as unknown as typeof setInterval,
      clearIntervalImpl: (() => {}) as unknown as typeof clearInterval,
    }));
    const first = store.init();
    await saved.promise;
    const second = store.init();
    let secondFinished = false;
    void second.then(() => { secondFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const finishedBeforeSweep = secondFinished;
    release.resolve();
    await Promise.all([first, second]);
    expect(finishedBeforeSweep).toBe(false);
    expect(first).toBe(second);
    expect(armed).toBe(1);
  });

  test('failed initialization can retry while the store is still open', async () => {
    const init = spyOn(HandlerSqliteStore.prototype, 'init').mockRejectedValueOnce(new Error('fixture init failed'));
    cleanups.push(() => init.mockRestore());
    const store = track(new InboxCursorStore(directory(), undefined, { sweepIntervalMs: 0 }));
    await expect(store.init()).rejects.toThrow('fixture init failed');
    await store.init();
    expect(store.countItems()).toBe(0);
  });

  test('throwing retention observers cannot leave unhandled timer work', async () => {
    let tick!: () => void;
    const reported = deferred<void>();
    const store = track(new InboxCursorStore(directory(), undefined, {
      itemCap: 1,
      setIntervalImpl: ((callback: () => void) => { tick = callback; return 0; }) as unknown as typeof setInterval,
      clearIntervalImpl: (() => {}) as unknown as typeof clearInterval,
      onSweep: () => { throw new Error('fixture observer failed'); },
      onSweepError: () => { reported.resolve(); throw new Error('fixture error observer failed'); },
    }));
    await store.init();
    store.upsertItems([item('a'), item('b')]);
    tick();
    await reported.promise;
    await store.close();
  });

  test('failed save stays dirty and is retried without dropping items', async () => {
    const dir = directory();
    const store = track(new InboxCursorStore(dir, undefined, { sweepIntervalMs: 0 }));
    await store.init();
    store.upsertItems([item('first')]);
    const save = spyOn(HandlerSqliteStore.prototype, 'save').mockRejectedValueOnce(new Error('fixture write failed'));
    cleanups.push(() => save.mockRestore());
    await expect(store.flush()).rejects.toThrow('fixture write failed');
    await store.flush();
    await store.close();
    const reopened = track(new InboxCursorStore(dir, undefined, { sweepIntervalMs: 0 }));
    await reopened.init();
    expect(reopened.countItems()).toBe(1);
  });

  test('keyset pagination preserves tied timestamps when newer items arrive', async () => {
    const store = track(new InboxCursorStore(directory(), undefined, { sweepIntervalMs: 0 }));
    await store.init();
    const now = Date.now();
    store.upsertItems([item('a', now), item('b', now), item('c', now - 1)]);
    const first = store.listItems({ limit: 1 });
    store.upsertItems([item('new', now + 1)]);
    expect(store.listItems({ limit: 10, after: { receivedAt: first[0]!.receivedAt, id: first[0]!.id } }).map((row) => row.id)).toEqual(['b', 'c']);
  });
});
