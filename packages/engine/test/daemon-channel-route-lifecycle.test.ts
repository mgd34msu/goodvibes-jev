import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { RouteStore } from '../sdk/src/platform/channels/host-routing/route-store.ts';
import { HandlerSqliteStore } from '../sdk/src/platform/state/daemon-handler-sqlite-store.ts';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture() {
  const workingDirectory = makeProjectTempDir('channel-route-lifecycle');
  const store = new RouteStore({ workingDirectory });
  await store.init();
  cleanups.push(async () => { await store.close(); });
  return { store, workingDirectory };
}
function holdFirstSave() {
  const written = deferred<void>();
  const release = deferred<void>();
  const original = HandlerSqliteStore.prototype.save;
  let calls = 0;
  const save = spyOn(HandlerSqliteStore.prototype, 'save').mockImplementation(async function(this: HandlerSqliteStore) {
    const number = ++calls;
    await original.call(this);
    if (number === 1) { written.resolve(); await release.promise; }
  });
  cleanups.push(() => save.mockRestore());
  return { written: written.promise, release: () => release.resolve() };
}

describe('channel route receipt and lifecycle ownership', () => {
  test('overlapping updates each return their own assignment receipt', async () => {
    const { store } = await fixture();
    const hold = holdFirstSave();
    const first = store.upsert({ channelId: 'fixture:one', profileId: 'first' });
    await hold.written;
    const second = await store.upsert({ channelId: 'fixture:one', profileId: 'second' });
    hold.release();
    const firstReceipt = await first;
    expect(firstReceipt.route.profileId).toBe('first');
    expect(second.route.profileId).toBe('second');
    expect(firstReceipt.route.assignmentId).toBe(second.route.assignmentId);
    expect(store.findByChannelId('fixture:one')?.profileId).toBe('second');
  });

  test('a later deletion does not turn an already-persisted upsert into a readback error', async () => {
    const { store } = await fixture();
    const hold = holdFirstSave();
    const first = store.upsert({ channelId: 'fixture:one', profileId: 'first' }).catch((error: unknown) => error);
    await hold.written;
    const row = store.findByChannelId('fixture:one')!;
    expect(await store.delete(row.assignmentId)).toBe(true);
    hold.release();
    expect(await first).toMatchObject({ created: true, route: { assignmentId: row.assignmentId, profileId: 'first' } });
    expect(store.findByChannelId('fixture:one')).toBeNull();
  });

  test('close drains accepted mutation persistence and does not break its receipt', async () => {
    const { store, workingDirectory } = await fixture();
    const hold = holdFirstSave();
    const first = store.upsert({ channelId: 'fixture:one', profileId: 'first' }).catch((error: unknown) => error);
    await hold.written;
    let closed = false;
    const closing = Promise.resolve(store.close()).then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const closedBeforePersistence = closed;
    hold.release();
    await closing;
    expect(closedBeforePersistence).toBe(false);
    expect(await first).toMatchObject({ route: { profileId: 'first' } });
    const reopened = new RouteStore({ workingDirectory });
    cleanups.push(async () => { await reopened.close(); });
    await reopened.init();
    expect(reopened.findByChannelId('fixture:one')?.profileId).toBe('first');
  });

  test('late initialization cannot reopen a released store', async () => {
    const release = deferred<void>();
    const original = HandlerSqliteStore.prototype.init;
    const init = spyOn(HandlerSqliteStore.prototype, 'init').mockImplementation(async function(this: HandlerSqliteStore) {
      await release.promise;
      await original.call(this);
    });
    cleanups.push(() => init.mockRestore());
    const store = new RouteStore({ workingDirectory: makeProjectTempDir('channel-route-init-close') });
    cleanups.push(async () => { await store.close(); });
    const opening = store.init();
    const closing = store.close();
    release.resolve();
    await Promise.all([opening, closing]);
    expect(() => store.listAll()).toThrow();
  });

  test('failed initialization can retry before release', async () => {
    const init = spyOn(HandlerSqliteStore.prototype, 'init').mockRejectedValueOnce(new Error('fixture init failed'));
    cleanups.push(() => init.mockRestore());
    const store = new RouteStore({ workingDirectory: makeProjectTempDir('channel-route-retry') });
    cleanups.push(async () => { await store.close(); });
    await expect(store.init()).rejects.toThrow('fixture init failed');
    await store.init();
    expect(store.listAll()).toEqual([]);
  });

  test('mutations after release refuse before changing the persisted route set', async () => {
    const { store } = await fixture();
    await store.close();
    await expect(store.upsert({ channelId: 'fixture', profileId: 'late' })).rejects.toMatchObject({ code: 'ROUTING_STORE_UNINITIALIZED' });
    await expect(store.delete('missing')).rejects.toMatchObject({ code: 'ROUTING_STORE_UNINITIALIZED' });
  });
});
