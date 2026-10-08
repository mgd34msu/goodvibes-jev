import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { registerTriagedInbox, type InboxTriageAuthority } from '../sdk/src/platform/intake/triage/owned.js';
import { TRIAGE_MODEL } from '../sdk/src/platform/intake/triage/battery.js';
import { SqliteTriageStore } from '../sdk/src/platform/intake/triage/store.js';
import { createOwnedInboxSource, registerCompositeInboxSurface, type InboxPollingControl } from '../sdk/src/platform/intake/registration.js';
import type { InboxListOutput } from '../sdk/src/platform/intake/aggregator.js';
import type { InboundChannelItem } from '../sdk/src/platform/intake/provider-adapter.js';
import { makeProjectTempDir } from './_helpers/project-temp.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const row = (id = 'one'): InboundChannelItem => ({ id: `fixture:${id}`, provider: 'fixture', kind: 'dm',
  subjectPreview: 'Protected subject', bodyPreview: 'Protected body', fromDigest: '0123456789abcdef', unread: true, receivedAt: Date.now() });
const deferred = () => Promise.withResolvers<void>();
async function setup(options: { rows?: InboundChannelItem[]; directory?: string; scope?: string; port?: JudgmentPort; noAuthority?: boolean } = {}) {
  const directory = options.directory ?? makeProjectTempDir('triage-owned'), messages: unknown[] = [];
  const catalog = new GatewayMethodCatalog(), authority = new AbortController();
  let current = true, polls = 0, control!: InboxPollingControl, rows = options.rows ?? [row()];
  const fake = fakePort(name => noulAnswer(name.endsWith('spam') ? .01 : .99));
  const grant: InboxTriageAuthority = { accountScopeId: options.scope ?? 'account-a', providerId: 'fixture',
    destinationId: 'synthetic-only', retention: 'ephemeral-no-log', port: options.port ?? fake.port,
    signal: authority.signal, assertCurrent() { if (!current) throw new Error('private revocation'); } };
  const owned = await registerTriagedInbox({ catalog, workingDirectory: directory,
    logger: { info() {}, warn(message) { messages.push(message); }, error() {} } }, {
    providerId: 'fixture', accountScopeId: options.scope ?? 'account-a', ...(options.noAuthority ? {} : { authority: grant }),
    adapters: new Map([['fixture', { id: 'fixture', pollIntervalMs: 3_600_000, async poll() {
      polls++; return { items: rows, state: 'ready' as const, configured: true };
    } }]]),
    acquireReadLease: async () => Object.assign(async () => {}, { assertCurrent() { if (!current) throw new Error('private account'); } }),
    gatePolling(_id, offered) { control = offered; },
  });
  cleanups.push(() => owned.close()); await owned.ready; await control.start(); await control.stop();
  const read = (body: unknown = {}) => catalog.invoke('channels.inbox.list', { body, context: {} }) as Promise<InboxListOutput>;
  const path = () => {
    const base = join(directory, '.goodvibes', 'tui', 'operator');
    return readdirSync(base).filter(name => /^inbox-triage-.*\.sqlite$/.test(name)).map(name => join(base, name));
  };
  return { owned, read, fake, authority, grant, directory, messages, path, catalog,
    revoke() { current = false; }, polls: () => polls,
    async replace(value: InboundChannelItem[]) { rows = value; await control.start(); await control.stop(); } };
}

test('explicit scoring enriches current reads, preserves wire page and never runs on poll/list', async () => {
  const f = await setup(); const before = await f.read();
  expect(f.fake.requests).toHaveLength(0); expect(f.path()).toEqual([]); expect(f.polls()).toBe(1);
  const result = await f.owned.runInboxTriage(); expect(result).toMatchObject({ total: 1, hasMore: false, receipts: [{ status: 'settled', label: 'priority' }] });
  const after = await f.read();
  expect(after.items[0]).toMatchObject({ triageLabel: 'priority', triageScore: .99, triageTags: ['GoodVibes/Priority'] });
  const { triageLabel, triageScore, triageTags, ...plain } = after.items[0]!;
  expect(plain).toEqual(before.items[0]!); expect({ ...after, items: [] }).toEqual({ ...before, items: [] });
  expect(f.fake.requests).toHaveLength(1); expect(f.polls()).toBe(1);
  expect(f.catalog.hasHandler('inbox.triage.run')).toBe(false);
  const state = f.fake.requests[0]!.state as { items: unknown[] };
  expect(state.items).toEqual([{ id: 'fixture:one', surface: 'fixture', subject: 'Protected subject', snippet: 'Protected body', conversationKind: 'direct', unread: true }]);
  expect(JSON.stringify(state)).not.toContain('0123456789abcdef');
  await f.owned.close(); expect(f.catalog.hasHandler('channels.inbox.list')).toBe(false);
});

test('empty and dry runs never open triage storage; missing authority sends zero judgments', async () => {
  const empty = await setup({ rows: [] }); await empty.read(); expect(await empty.owned.runInboxTriage()).toMatchObject({ receipts: [], total: 0 });
  expect(empty.path()).toEqual([]); expect(empty.fake.requests).toHaveLength(0);
  const dry = await setup(); await dry.owned.runInboxTriage({}, { dryRun: true }); expect(dry.path()).toEqual([]);
  const missing = await setup({ noAuthority: true }); await missing.read();
  await expect(missing.owned.runInboxTriage()).rejects.toMatchObject({ code: 'INBOX_TRIAGE_AUTHORITY_UNAVAILABLE' });
  expect(missing.fake.requests).toHaveLength(0); expect(missing.path()).toEqual([]);
});

test('exact subject/snippet/kind/unread changes remove old labels with no inferred metadata', async () => {
  for (const change of [{ subjectPreview: 'Changed subject' }, { bodyPreview: 'Changed body' }, { kind: 'thread' as const }, { unread: false }]) {
    const f = await setup(); await f.owned.runInboxTriage(); await f.replace([{ ...row(), ...change }]);
    expect((await f.read()).items[0]?.triageLabel).toBeUndefined();
  }
});

test('held, unavailable and model-mismatched attempts suppress old settled labels', async () => {
  for (const mode of ['held', 'unavailable', 'wrong-model']) {
    let changed = false; const good = fakePort(name => noulAnswer(name.endsWith('spam') ? .01 : .99));
    const held = fakePort(() => noulAnswer(.5));
    const f = await setup({ port: { model: TRIAGE_MODEL, async ask(request) {
      if (!changed) return good.port.ask(request);
      if (mode === 'unavailable') throw new Error('private provider failure');
      if (mode === 'held') return held.port.ask(request);
      return { ...await good.port.ask(request), model: 'wrong' };
    } } });
    await f.owned.runInboxTriage(); changed = true; await f.owned.runInboxTriage();
    expect((await f.read()).items[0]?.triageLabel).toBeUndefined();
  }
});

test('corrupt and incompatible receipt stores are optional, fixed diagnostic, and never repaired', async () => {
  for (const corrupt of [true, false]) {
    const f = await setup(); await f.owned.runInboxTriage(); const file = f.path()[0]!;
    if (corrupt) writeFileSync(file, 'private corrupt data');
    else { const db = new Database(file); const latest = JSON.parse((db.query('SELECT latest FROM triage_receipts').get() as { latest: string }).latest); latest.model = 'wrong'; db.query('UPDATE triage_receipts SET latest = ?').run(JSON.stringify(latest)); db.close(); }
    const bytes = readFileSync(file); expect((await f.read()).items[0]?.triageLabel).toBeUndefined();
    expect(readFileSync(file)).toEqual(bytes); expect(f.messages).toEqual(['Inbox triage metadata unavailable']);
  }
});

test('successive accounts with identical provider item IDs cannot inherit receipts', async () => {
  const first = await setup(); await first.owned.runInboxTriage(); await first.owned.close();
  const second = await setup({ directory: first.directory, scope: 'account-b' });
  expect((await second.read()).items[0]?.triageLabel).toBeUndefined(); expect(second.path()).toHaveLength(1);
  await second.owned.runInboxTriage(); expect(second.path()).toHaveLength(2);
});

test('500-row read enriches every chunk without changing order, count or cursors', async () => {
  const rows = Array.from({ length: 501 }, (_, i) => ({ ...row(String(i).padStart(3, '0')), receivedAt: Date.now() - i }));
  const f = await setup({ rows }); const before = await f.read({ limit: 500 }); let cursor: string | undefined;
  do { const result = await f.owned.runInboxTriage({ limit: 100, ...(cursor ? { cursor } : {}) }); cursor = result.nextCursor; } while (cursor);
  const after = await f.read({ limit: 500 }); expect(after.items).toHaveLength(500);
  expect(after.items.every(item => item.triageLabel === 'priority')).toBe(true);
  expect(after.items.map(item => item.id)).toEqual(before.items.map(item => item.id));
  expect({ ...after, items: [] }).toEqual({ ...before, items: [] });
  expect(f.fake.requests).toHaveLength(6); await expect(f.owned.runInboxTriage({ limit: 500 })).rejects.toThrow('100');
});

test('revocation or changed mirror while judgment is held prevents publication', async () => {
  for (const action of ['account', 'semantic', 'row']) {
    const entered = deferred(), release = deferred(), good = fakePort(() => noulAnswer(.01));
    const f = await setup({ port: { model: TRIAGE_MODEL, async ask(request) { entered.resolve(); await release.promise; return good.port.ask(request); } } });
    const scoring = f.owned.runInboxTriage(); void scoring.catch(() => {}); await entered.promise;
    if (action === 'account') f.revoke(); else if (action === 'semantic') f.authority.abort();
    else await f.replace([{ ...row(), bodyPreview: 'Changed while held' }]);
    release.resolve(); await expect(scoring).rejects.toThrow(); expect(f.path()).toEqual([]);
  }
});

test('canonical commit rechecks synchronous account proof at publication and close drains held commits', async () => {
  for (const action of ['account', 'close']) {
    const entered = deferred(), release = deferred();
    const original = SqliteTriageStore.prototype.commit;
    const held = spyOn(SqliteTriageStore.prototype, 'commit').mockImplementation(async function (this: SqliteTriageStore, ...args) {
      entered.resolve(); await release.promise; return original.apply(this, args);
    });
    const f = await setup(); const scoring = f.owned.runInboxTriage(); void scoring.catch(() => {}); await entered.promise;
    let closed = false; const closing = action === 'close' ? f.owned.close().then(() => { closed = true; }) : undefined;
    if (action === 'account') f.revoke();
    await new Promise(resolve => setTimeout(resolve, 5)); expect(closed).toBe(false);
    release.resolve(); await expect(scoring).rejects.toThrow(); await closing; expect(f.path()).toEqual([]); held.mockRestore();
  }
});

test('enrichment remains inside account/privacy leases and close waits for its read', async () => {
  for (const action of ['account', 'semantic', 'close']) {
    const f = await setup(); await f.owned.runInboxTriage();
    const entered = deferred(), release = deferred(), original = SqliteTriageStore.prototype.readBatch;
    const held = spyOn(SqliteTriageStore.prototype, 'readBatch').mockImplementation(async function (this: SqliteTriageStore, ids) {
      entered.resolve(); await release.promise; return original.call(this, ids);
    });
    const reading = f.read(); void reading.catch(() => {}); await entered.promise;
    let closed = false; const closing = action === 'close' ? f.owned.close().then(() => { closed = true; }) : undefined;
    if (action === 'account') f.revoke(); else if (action === 'semantic') f.authority.abort();
    await new Promise(resolve => setTimeout(resolve, 5)); expect(closed).toBe(false);
    release.resolve(); await expect(reading).rejects.toThrow(); await closing; held.mockRestore();
  }
});

test('same-account lock refuses competing ownership and permits reacquisition only after drain', async () => {
  const first = await setup();
  await expect(setup({ directory: first.directory })).rejects.toThrow();
  await first.owned.close();
  const next = await setup({ directory: first.directory });
  expect((await next.read()).total).toBe(1);
});

test('close drains an uncooperative judgment and queued scoring cannot ask or write later', async () => {
  const entered = deferred(), release = deferred(), fake = fakePort(() => noulAnswer(.01)); let asks = 0;
  const f = await setup({ port: { model: TRIAGE_MODEL, async ask(request) { asks++; entered.resolve(); await release.promise; return fake.port.ask(request); } } });
  const first = f.owned.runInboxTriage(); void first.catch(() => {}); await entered.promise;
  const second = f.owned.runInboxTriage(); void second.catch(() => {});
  let closed = false; const closing = f.owned.close(); expect(f.owned.close()).toBe(closing);
  void closing.then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 5)); expect(closed).toBe(false);
  release.resolve(); await expect(first).rejects.toThrow(); await expect(second).rejects.toThrow(); await closing;
  expect(asks).toBe(1); expect(f.path()).toEqual([]);
  const next = await setup({ directory: f.directory }); expect((await next.read()).total).toBe(1);
});

test('later-owner async validation cannot publish earlier-owner enrichment after semantic revocation', async () => {
  const f = await setup(); await f.owned.runInboxTriage(); const entered = deferred(), release = deferred();
  const context = { catalog: new GatewayMethodCatalog(), workingDirectory: f.directory, logger: { info() {}, warn() {}, error() {} } };
  const other = createOwnedInboxSource(context, { adapters: new Map([['other', { id: 'other', pollIntervalMs: 3_600_000,
    poll: async () => ({ items: [], state: 'empty' as const, configured: true }) }]]), storeFileName: 'other.sqlite',
    acquireReadLease: async () => Object.assign(async () => { entered.resolve(); await release.promise; }, { assertCurrent() {} }),
  });
  cleanups.push(() => other.close());
  const binding = registerCompositeInboxSurface(context, [f.owned, other]); cleanups.push(() => binding.close());
  await binding.ready;
  const reading = context.catalog.invoke('channels.inbox.list', { body: {}, context: {} }); void reading.catch(() => {});
  await entered.promise; f.authority.abort(); release.resolve();
  await expect(reading).rejects.toMatchObject({ code: 'INBOX_TRIAGE_AUTHORITY_UNAVAILABLE' });
});

test('a selected first row overlays alongside unscored rows without adding gateway methods', async () => {
  const f = await setup({ rows: [{ ...row('a'), receivedAt: Date.now() }, { ...row('b'), receivedAt: Date.now() - 1 }] });
  const result = await f.owned.runInboxTriage({ limit: 1 }); expect(result).toMatchObject({ total: 2, hasMore: true }); expect(result.nextCursor).toBeDefined();
  const page = await f.read(); expect(page.items[0]?.triageLabel).toBe('priority'); expect(page.items[1]?.triageLabel).toBeUndefined();
  expect(f.catalog.hasHandler('channels.drafts.list')).toBe(false); expect(f.catalog.hasHandler('inbox.triage.tag')).toBe(false);
});

test('privacy rejection beyond normal preview lengths is not clipped or swallowed as an optional store error', async () => {
  const f = await setup({ rows: [{ ...row(), bodyPreview: 'x'.repeat(10000) + ' password=synthetic-do-not-send' }] });
  await expect(f.owned.runInboxTriage()).rejects.toThrow('Refused before judgment');
  await expect(f.read()).rejects.toThrow('Refused before judgment');
  expect(f.fake.requests).toHaveLength(0); expect(f.path()).toEqual([]); expect(f.messages).toEqual([]);
});

test('canonical publication rejects asynchronous final fences without replacing the existing image', async () => {
  const f = await setup(); const result = await f.owned.runInboxTriage(); const file = f.path()[0]!;
  const store = new SqliteTriageStore(f.directory, file.slice(file.lastIndexOf('/') + 1));
  const before = readFileSync(file);
  try {
    await expect(store.commit(result.receipts, undefined, (() => Promise.reject(new Error('private proof'))) as () => void)).rejects.toThrow('synchronous');
    expect(readFileSync(file)).toEqual(before);
  } finally { await store.close(); }
});
