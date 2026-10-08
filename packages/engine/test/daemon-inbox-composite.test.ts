import { afterEach, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { InboxCursorStore } from '../sdk/src/platform/intake/cursor-store.js';
import {
  createOwnedInboxSource, registerCompositeInboxSurface, INBOX_LIST_METHOD_ID,
  type InboxSurfaceContext, type OwnedInboxSource, type RegisterInboxSurfaceOptions,
} from '../sdk/src/platform/intake/registration.js';
import { aggregateInbox, type InboxListOutput } from '../sdk/src/platform/intake/aggregator.js';
import { composeInboxReads } from '../sdk/src/platform/intake/composite.js';
import type { InboundChannelItem, InboundProviderAdapter, ProviderPollResult } from '../sdk/src/platform/intake/provider-adapter.js';
import { makeProjectTempDir } from './_helpers/project-temp.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const logger = { info() {}, warn() {}, error() {} };
function context(): InboxSurfaceContext {
  return { catalog: new GatewayMethodCatalog(), workingDirectory: makeProjectTempDir('composite-inbox'), logger };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }
function row(provider: string, suffix: string, receivedAt: number): InboundChannelItem {
  return { provider, id: `${provider}:${suffix}`, receivedAt, kind: 'dm', fromDigest: '0123456789abcdef',
    subjectPreview: 'Protected subject', bodyPreview: 'Protected preview', routeId: `route-${provider}`, unread: true };
}
async function source(ctx: InboxSurfaceContext, provider: string, items: InboundChannelItem[] = [], options: Partial<RegisterInboxSurfaceOptions> = {}) {
  let result: ProviderPollResult = { items, state: items.length ? 'ready' : 'empty', configured: true };
  const adapter: InboundProviderAdapter = { id: provider, pollIntervalMs: 3_600_000, poll: async () => result };
  const file = `${provider}.sqlite`;
  const owned = createOwnedInboxSource(ctx, { adapters: new Map([[provider, adapter]]), storeFileName: file, ...options });
  cleanups.push(() => owned.close()); await owned.ready;
  return { owned, file, set(value: ProviderPollResult) { result = value; } };
}
async function bind(ctx: InboxSurfaceContext, sources: readonly OwnedInboxSource[]) {
  const binding = registerCompositeInboxSurface(ctx, sources); cleanups.push(() => binding.close()); await binding.ready; return binding;
}
async function read(ctx: InboxSurfaceContext, body: unknown = {}, query?: Record<string, string>): Promise<InboxListOutput> {
  return await ctx.catalog.invoke(INBOX_LIST_METHOD_ID, { body, query, context: {} }) as InboxListOutput;
}

test('three independent real mirrors yield one interleaved timeline, exact full final page and no loss or repeats', async () => {
  const ctx = context(), now = Date.now();
  const a = await source(ctx, 'slack', [row('slack', 'one', now), row('slack', 'two', now - 2)]);
  const b = await source(ctx, 'email', [row('email', 'one', now), row('email', 'two', now - 1)]);
  const c = await source(ctx, 'fixture', [row('fixture', 'one', now), row('fixture', 'two', now - 3)]);
  expect(ctx.catalog.hasHandler(INBOX_LIST_METHOD_ID)).toBe(false);
  await bind(ctx, [a.owned, b.owned, c.owned]);
  const ids: string[] = []; let cursor: string | undefined;
  for (let index = 0; index < 3; index++) {
    const page = await read(ctx, { limit: 2, ...(cursor ? { cursor } : {}) });
    ids.push(...page.items.map(item => item.id)); cursor = page.nextCursor;
    expect(page.total).toBe(6); expect(page.cursor).toBe(String(now));
    expect(page.hasMore).toBe(index < 2); expect(page.truncated).toBe(page.hasMore);
    expect(page.providers.reduce((sum, status) => sum + status.itemCount, 0)).toBe(2);
    expect(page.providers.map(status => status.storedCount)).toEqual([2, 2, 2]);
    expect(page.items[0]).toMatchObject({ from: '0123456789abcdef', bodyPreview: 'Protected preview' });
    expect(page.items.every(item => item.routeId === `route-${item.provider}`)).toBe(true);
  }
  expect(ids).toEqual(['email:one', 'fixture:one', 'slack:one', 'email:two', 'slack:two', 'fixture:two']);
  expect(new Set(ids).size).toBe(6); expect(cursor).toBeUndefined();
  const filtered = await read(ctx, {}, { provider: 'email', limit: '1', since: String(now - 2) });
  expect(filtered.total).toBe(2); expect(filtered.providers).toHaveLength(1); expect(filtered.providers[0]?.itemCount).toBe(1);
  const older = await read(ctx, { provider: 'email', limit: 1, since: now - 2, cursor: filtered.nextCursor });
  expect(older.total).toBe(2); expect(older.hasMore).toBe(false); expect(older.items[0]?.id).toBe('email:two');
  const unknown = await read(ctx, { provider: 'missing' });
  expect(unknown).toMatchObject({ items: [], total: 0, partial: false, providers: [{ provider: 'missing', state: 'unconfigured', configured: false }] });
});

test('merge uses SQLite BINARY UTF-8 ordering rather than JavaScript locale or UTF-16 ordering', async () => {
  const ctx = context(), now = Date.now();
  const a = await source(ctx, '\uE000', [row('\uE000', 'x', now)]);
  const b = await source(ctx, '\u{10000}', [row('\u{10000}', 'x', now)]);
  await bind(ctx, [b.owned, a.owned]);
  const first = await read(ctx, { limit: 1 });
  expect(first.items[0]?.provider).toBe('\uE000');
  const last = await read(ctx, { limit: 1, cursor: first.nextCursor });
  expect(last.items[0]?.provider).toBe('\u{10000}'); expect(last.hasMore).toBe(false);
});

test('explicit unavailable membership distinguishes configuration from outages and keeps cached rows', async () => {
  const ctx = context(), now = Date.now(); let repoll!: import('../sdk/src/platform/intake/registration.js').InboxPollingControl;
  const a = await source(ctx, 'slack', [row('slack', 'cached', now)], { gatePolling(_id, control) { repoll = control; } });
  await repoll.start(); await repoll.stop(); a.set({ items: [], state: 'unavailable', configured: true, error: 'Bounded outage' }); await repoll.start();
  const b = await source(ctx, 'fixture', [], { adapters: new Map([['fixture', { id: 'fixture', pollIntervalMs: 3_600_000,
    poll: async () => ({ items: [], state: 'unavailable', configured: false, error: 'Missing credential' }) }]]) });
  await bind(ctx, [a.owned, b.owned]);
  expect(await read(ctx)).toMatchObject({ total: 1, partial: true, items: [{ id: 'slack:cached' }], providers: [
    { provider: 'slack', state: 'error', itemCount: 1, storedCount: 1, error: 'Bounded outage' },
    { provider: 'fixture', state: 'unconfigured', itemCount: 0, storedCount: 0, configured: false },
  ] });
  expect((await read(ctx, { provider: 'fixture' })).partial).toBe(false);
});

test('duplicate provider membership and ambiguous namespace are rejected without replacing an existing binding', async () => {
  const ctx = context(); const a = await source(ctx, 'slack');
  expect(() => registerCompositeInboxSurface(ctx, [a.owned, a.owned])).toThrow('exactly one owner');
  const malformed = await source(ctx, 'slack:nested');
  expect(() => registerCompositeInboxSurface(ctx, [a.owned, malformed.owned])).toThrow('nonempty namespaces');
  await bind(ctx, [a.owned]);
  expect(() => registerCompositeInboxSurface(ctx, [])).toThrow('already has an owner');
  expect(await read(ctx)).toMatchObject({ total: 0 });
});

test('malformed cross-owner IDs beyond lookahead refuse the projection instead of silently disappearing on later pages', async () => {
  const ctx = context(), now = Date.now();
  const a = await source(ctx, 'slack', [row('slack', 'one', now), row('slack', 'two', now - 1), row('slack', 'three', now - 2),
    { ...row('slack', 'old', now - 3), id: 'email:collision' }]);
  const b = await source(ctx, 'email', [row('email', 'collision', now - 3)]);
  await bind(ctx, [a.owned, b.owned]);
  await expect(read(ctx, { limit: 1 })).rejects.toMatchObject({ code: 'INBOX_ITEM_NAMESPACE_INVALID' });
  // A disjoint account remains independently readable; no stale owner proof is used.
  expect((await read(ctx, { provider: 'email', limit: 1 })).items[0]?.id).toBe('email:collision');
});

test('revoking an earlier owner while a later async validation is held refuses the whole detached page', async () => {
  const ctx = context(), entered = deferred(), resume = deferred(); let epoch = 0;
  const a = await source(ctx, 'slack', [row('slack', 'one', Date.now())], { acquireReadLease: async () => {
    const captured = epoch; return Object.assign(async () => {}, { assertCurrent() { if (epoch !== captured) throw new Error('Sensitive revocation'); } });
  } });
  const b = await source(ctx, 'email', [row('email', 'one', Date.now())], { acquireReadLease: async () =>
    Object.assign(async () => { entered.resolve(); await resume.promise; }, { assertCurrent() {} }) });
  await bind(ctx, [a.owned, b.owned]); const reading = read(ctx); void reading.catch(() => {});
  try {
    await entered.promise; epoch++; resume.resolve();
    await expect(reading).rejects.toMatchObject({ code: 'INBOX_SCOPE_UNAVAILABLE', message: 'Inbox account scope is unavailable' });
  } finally { resume.resolve(); await Promise.allSettled([reading]); }
});

test('failed validator waits for every admitted validation before owner storage can retire', async () => {
  const ctx = context(), entered = deferred(), resume = deferred();
  const a = await source(ctx, 'slack', [], { acquireReadLease: async () => Object.assign(async () => { throw new Error('refused'); }, { assertCurrent() {} }) });
  const b = await source(ctx, 'email', [], { acquireReadLease: async () => Object.assign(async () => { entered.resolve(); await resume.promise; }, { assertCurrent() {} }) });
  await bind(ctx, [a.owned, b.owned]); const reading = read(ctx); void reading.catch(() => {});
  try {
    await entered.promise; let closed = false; const closing = b.owned.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false); resume.resolve();
    await expect(reading).rejects.toMatchObject({ code: 'INBOX_SCOPE_UNAVAILABLE' }); await closing;
    expect(ctx.catalog.hasHandler(INBOX_LIST_METHOD_ID)).toBe(true);
  } finally { resume.resolve(); await Promise.allSettled([reading]); }
});

test('partial lease acquisition releases earlier owners; source shutdown never unregisters another owner', async () => {
  const ctx = context();
  const a = await source(ctx, 'slack');
  const b = await source(ctx, 'email', [], { acquireReadLease: async () => { throw new Error('private'); } });
  await bind(ctx, [a.owned, b.owned]);
  await expect(read(ctx)).rejects.toMatchObject({ code: 'INBOX_SCOPE_UNAVAILABLE' });
  await b.owned.close();
  expect(ctx.catalog.hasHandler(INBOX_LIST_METHOD_ID)).toBe(true);
  expect(await read(ctx, { provider: 'slack' })).toMatchObject({ total: 0, providers: [{ provider: 'slack' }] });
  await a.owned.close();
});

test('composed protected sources refuse legacy asynchronous-only guards while standalone remains compatible', async () => {
  const ctx = context(); const a = await source(ctx, 'slack', [], { assertReadCurrent() {} });
  await bind(ctx, [a.owned]); await expect(read(ctx)).rejects.toMatchObject({ code: 'INBOX_SCOPE_UNAVAILABLE' });
});

test('IMAP generation history and progress remain attached only to the owning provider', async () => {
  const ctx = context();
  const checkpoint = { kind: 'imap-uid' as const, uidValidity: 7, lastTerminalUid: null,
    history: { kind: 'bounded-seed' as const, lowerBoundUid: 101, skippedOlderMessages: 100 } };
  const email = await source(ctx, 'email', [], { adapters: new Map([['email', { id: 'email', pollIntervalMs: 3_600_000,
    checkpointKind: 'imap-uid', assertCurrent() {}, async poll() { return { items: [], state: 'empty' as const, configured: true, pendingMessages: 2,
      checkpointAdvance: { kind: 'imap-uid' as const, transition: 'seed' as const, previous: null, next: checkpoint, coveredUids: [], terminal: [] } }; } }]]) });
  const slack = await source(ctx, 'slack'); await bind(ctx, [slack.owned, email.owned]);
  const page = await read(ctx); expect(page.partial).toBe(true);
  expect(page.providers[0]?.mailboxHistory).toBeUndefined();
  expect(page.providers[1]).toMatchObject({ mailboxHistory: { uidValidity: 7, skippedOlderMessages: 100 }, mailboxProgress: { uidValidity: 7, pendingMessages: 2 } });
  expect(email.owned.getImapCheckpoint?.('email')).toEqual(checkpoint);
  await email.owned.close();
  const reopened = new InboxCursorStore(ctx.workingDirectory, email.file);
  try { await reopened.init(); expect(reopened.getImapCheckpoint('email')).toEqual(checkpoint); } finally { await reopened.close(); }
});

test('direct source shutdown accepts synchronous void gate retirement', async () => {
  const ctx = context(); let retired = 0;
  const owned = await source(ctx, 'slack', [], { gatePolling() { return () => { retired++; }; } });
  await owned.owned.close(); expect(retired).toBe(1);
  expect(ctx.catalog.hasHandler(INBOX_LIST_METHOD_ID)).toBe(false);
});

test('async final fences are refused without leaking rejected promises', async () => {
  const ctx = context(); const a = await source(ctx, 'slack', [], { acquireReadLease: async () => Object.assign(async () => {}, {
    assertCurrent: async () => { throw new Error('Asynchronous guard must not be accepted'); },
  }) });
  await bind(ctx, [a.owned]);
  await expect(read(ctx)).rejects.toMatchObject({ code: 'INBOX_SCOPE_UNAVAILABLE' });
});

test('revocation during later lease acquisition is fenced before any mirror is projected', async () => {
  const ctx = context(); let live = true;
  const a = await source(ctx, 'slack', [], { acquireReadLease: async () => Object.assign(async () => {}, { assertCurrent() { if (!live) throw new Error('revoked'); } }) });
  const b = await source(ctx, 'email', [], { acquireReadLease: async () => {
    live = false; return Object.assign(async () => {}, { assertCurrent() {} });
  } });
  await bind(ctx, [a.owned, b.owned]);
  await expect(read(ctx)).rejects.toMatchObject({ code: 'INBOX_SCOPE_UNAVAILABLE' });
});


test('structural composition snapshots membership and preserves explicit provider status order', async () => {
  const ctx = context();
  const slack = await source(ctx, 'slack', [row('slack', 'one', Date.now())]);
  const email = await source(ctx, 'email', [row('email', 'one', Date.now())]);
  const reads = [await slack.owned.acquireRead(true), await email.owned.acquireRead(true)];
  try {
    const offered = [...reads]; const composed = composeInboxReads(offered); offered.length = 0;
    const page = aggregateInbox(composed, { limit: 10, providers: ['email', 'slack'] });
    expect(page.total).toBe(2); expect(page.providers.map(status => status.provider)).toEqual(['email', 'slack']);
  } finally { for (const read of reads) read.release(); }
});
