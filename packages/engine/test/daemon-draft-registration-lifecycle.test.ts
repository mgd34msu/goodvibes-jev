import { expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { DraftSyncStore, registerDraftMethods, type DraftHostContext } from '../sdk/src/platform/channels/host-drafts/index.js';
import type { AtRestCipher } from '../sdk/src/platform/config/daemon-credential-store.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const cipher: AtRestCipher = { async encrypt(text) { return `fixture:${Buffer.from(text).toString('base64')}`; }, async decrypt() { throw new Error('Read paths must not decrypt'); } };
const ids = ['channels.drafts.list', 'channels.drafts.get', 'channels.drafts.save', 'channels.drafts.delete'];
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { resolve, promise }; }
function fixture() {
  const values = new Map<string, string>();
  const warnings: unknown[] = [];
  const ctx: DraftHostContext = {
    catalog: new GatewayMethodCatalog(), workingDirectory: makeProjectTempDir('draft-registration'),
    credentials: {
      async resolveRef(key) { return values.get(key) ?? null; }, async resolveConfigSecret() { return null; },
      async put(key, value) { values.set(key, value); }, async has(key) { return values.has(key); },
    },
    logger: { info() {}, error() {}, warn(...args) { warnings.push(args); } },
  };
  return { ctx, warnings };
}
function invoke(ctx: DraftHostContext, id: string, body: unknown = {}) {
  return ctx.catalog.invoke(id, { body, context: { principalId: 'fixture-owner', metadata: { explicitUserRequest: true } } });
}

test('registration close drains an accepted save and its persistence before owned store teardown', async () => {
  const { ctx } = fixture();
  const entered = deferred(); const release = deferred();
  const original = DraftSyncStore.prototype.upsert;
  const delayed = spyOn(DraftSyncStore.prototype, 'upsert').mockImplementation(async function (this: DraftSyncStore, input) {
    entered.resolve(); await release.promise; return original.call(this, input);
  });
  const registration = registerDraftMethods(ctx);
  const saving = invoke(ctx, 'channels.drafts.save', { id: 'fixture', message: 'fixture body held during shutdown', confirm: true });
  void saving.catch(() => {});
  try {
    await entered.promise;
    let closed = false;
    const close = registration.close();
    expect(registration.close()).toBe(close);
    void close.then(() => { closed = true; });
    for (const id of ids) expect(ctx.catalog.hasHandler(id)).toBe(false);
    await Promise.resolve(); expect(closed).toBe(false);
    release.resolve();
    expect(await saving).toMatchObject({ draft: { id: 'fixture' }, created: true });
    await close;
    const reopened = new DraftSyncStore({ workingDirectory: ctx.workingDirectory, cipher });
    await reopened.init();
    try {
      expect(reopened.get('fixture')?.message).toHaveLength(12);
      expect(readFileSync(reopened.dbPath).includes(Buffer.from('fixture body held during shutdown'))).toBe(false);
    } finally { await reopened.close(); }
  } finally { release.resolve(); await Promise.allSettled([saving, registration.close()]); delayed.mockRestore(); }
});

test('a borrowed store remains open after its surface closes', async () => {
  const { ctx } = fixture();
  const store = new DraftSyncStore({ workingDirectory: ctx.workingDirectory, cipher });
  await store.init();
  const registration = registerDraftMethods(ctx, { store });
  try {
    await registration.close();
    expect((await store.upsert({ id: 'owner', message: 'still owned by caller' })).created).toBe(true);
    expect(store.count()).toBe(1);
  } finally { await store.close(); }
});

test('awaited shutdown restores descriptors and old teardown cannot erase replacement handlers', async () => {
  const { ctx } = fixture();
  const first = registerDraftMethods(ctx);
  await first.close();
  const next = registerDraftMethods(ctx);
  try {
    first(); await first.close();
    for (const id of ids) expect(ctx.catalog.hasHandler(id)).toBe(true);
    expect(await invoke(ctx, 'channels.drafts.list')).toEqual({ drafts: [], total: 0 });
  } finally { await next.close(); }
});

test('initialization failure is retryable on the same registration', async () => {
  const { ctx } = fixture();
  const store = new DraftSyncStore({ workingDirectory: ctx.workingDirectory, cipher });
  const original = store.init.bind(store);
  let calls = 0;
  const init = spyOn(store, 'init').mockImplementation(() => ++calls === 1 ? Promise.reject(new Error('fixture first init failed')) : original());
  const registration = registerDraftMethods(ctx, { store });
  try {
    await expect(invoke(ctx, 'channels.drafts.list')).rejects.toThrow('fixture first init failed');
    expect(await invoke(ctx, 'channels.drafts.list')).toEqual({ drafts: [], total: 0 });
    expect(calls).toBe(2);
  } finally { await registration.close(); init.mockRestore(); await store.close(); }
});

test('a later delete cannot be undone by an earlier save still awaiting encryption', async () => {
  const { ctx } = fixture();
  const entered = deferred(); const release = deferred();
  const store = new DraftSyncStore({ workingDirectory: ctx.workingDirectory, cipher: { ...cipher, async encrypt(text) { entered.resolve(); await release.promise; return cipher.encrypt(text); } } });
  await store.init();
  const registration = registerDraftMethods(ctx, { store });
  const saving = invoke(ctx, 'channels.drafts.save', { id: 'same', message: 'queued body', confirm: true });
  await entered.promise;
  const deleting = invoke(ctx, 'channels.drafts.delete', { draftId: 'same', confirm: true });
  try {
    release.resolve();
    await saving;
    expect(await deleting).toEqual({ deleted: true, draftId: 'same' });
    expect(store.get('same')).toBeNull();
  } finally { release.resolve(); await Promise.allSettled([saving, deleting]); await registration.close(); await store.close(); }
});

test('legacy synchronous teardown reports value-free cleanup failure and awaiting close still rejects', async () => {
  const { ctx, warnings } = fixture();
  const close = spyOn(DraftSyncStore.prototype, 'close').mockRejectedValue(new Error('fixture-sensitive-detail'));
  const registration = registerDraftMethods(ctx);
  try {
    registration();
    await expect(registration.close()).rejects.toBeInstanceOf(AggregateError);
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).not.toContain('fixture-sensitive-detail');
    for (const id of ids) expect(ctx.catalog.hasHandler(id)).toBe(false);
  } finally { close.mockRestore(); }
});
