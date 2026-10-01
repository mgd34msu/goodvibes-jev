import { expect, test } from 'bun:test';
import type { AtRestCipher } from '../sdk/src/platform/config/daemon-credential-store.js';
import { DraftSyncStore, sha256First } from '../sdk/src/platform/channels/host-drafts/draft-store.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function makeStore(cipher: AtRestCipher) {
  return new DraftSyncStore({ workingDirectory: makeProjectTempDir('draft-lifetime'), cipher });
}
const cipher: AtRestCipher = { async encrypt(text) { return `fixture:${Buffer.from(text).toString('base64')}`; }, async decrypt() { throw new Error('Reads must never decrypt body material'); } };

test('close waits for accepted encryption before releasing its database', async () => {
  const entered = deferred(); const release = deferred();
  const store = makeStore({ ...cipher, async encrypt(text) { entered.resolve(); await release.promise; return cipher.encrypt(text); } });
  await store.init();
  const writing = store.upsert({ id: 'one', message: 'fixture body' });
  const observed = writing.then((value) => ({ value }), (error: unknown) => ({ error }));
  try {
    await entered.promise;
    let closed = false;
    const closing = Promise.resolve(store.close()).then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release.resolve();
    expect(await observed).toMatchObject({ value: { draft: { id: 'one' } } });
    await closing;
    expect(closed).toBe(true);
    expect(() => store.get('one')).toThrow();
    await expect(store.init()).rejects.toThrow();
  } finally { release.resolve(); await observed; await store.close(); }
});

test('close during initialization cannot reopen the store when initialization finishes', async () => {
  const store = makeStore(cipher);
  const starting = store.init();
  const closing = store.close();
  try {
    await starting;
    await closing;
    expect(() => store.list()).toThrow();
    await expect(store.init()).rejects.toThrow();
  } finally { await starting.catch(() => {}); await store.close(); }
});

test('an admitted save owns one snapshot before awaiting encryption', async () => {
  const entered = deferred(); const release = deferred();
  const store = makeStore({ ...cipher, async encrypt(text) { entered.resolve(); await release.promise; return cipher.encrypt(text); } });
  await store.init();
  const input = { id: 'one', message: 'original fixture body', title: 'Original', tags: ['original'] };
  const writing = store.upsert(input);
  try {
    await entered.promise;
    input.message = 'changed body'; input.title = 'Changed'; input.tags[0] = 'changed';
    release.resolve();
    const { draft } = await writing;
    expect(draft.message).toBe(sha256First('original fixture body', 12));
    expect(draft.title).toBe('Original');
    expect(draft.tags).toEqual(['original']);
  } finally { release.resolve(); await writing; await store.close(); }
});

test('concurrent same-id snapshots retain call order and the first creation metadata', async () => {
  const entered = deferred(); const release = deferred();
  const store = makeStore({ ...cipher, async encrypt(text) { if (text === 'first') { entered.resolve(); await release.promise; } return cipher.encrypt(text); } });
  await store.init();
  const first = store.upsert({ id: 'same', message: 'first', createdAt: '2026-01-01T00:00:00.000Z' });
  await entered.promise;
  const second = store.upsert({ id: 'same', message: 'second', createdAt: '2026-02-01T00:00:00.000Z' });
  try {
    release.resolve();
    const [one, two] = await Promise.all([first, second]);
    expect(one.created).toBe(true);
    expect(two.created).toBe(false);
    expect(two.draft.createdAt).toBe(one.draft.createdAt);
    expect(store.get('same')?.message).toBe(sha256First('second', 12));
  } finally { release.resolve(); await Promise.allSettled([first, second]); await store.close(); }
});

test('an encryption failure does not poison a later admitted snapshot', async () => {
  const store = makeStore({ ...cipher, async encrypt(text) { if (text === 'fail') throw new Error('fixture cipher failed'); return cipher.encrypt(text); } });
  await store.init();
  try {
    const first = store.upsert({ id: 'same', message: 'fail' });
    const second = store.upsert({ id: 'same', message: 'works' });
    await expect(first).rejects.toThrow('fixture cipher failed');
    expect((await second).draft.message).toBe(sha256First('works', 12));
  } finally { await store.close(); }
});
