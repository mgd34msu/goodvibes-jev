import { afterEach, describe, expect, test } from 'bun:test';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { InboxCursorStore } from '../sdk/src/platform/intake/cursor-store.ts';
import { InboundPoller } from '../sdk/src/platform/intake/poller.ts';
import type { InboundChannelItem, InboundProviderAdapter, ProviderPollResult } from '../sdk/src/platform/intake/provider-adapter.ts';
import { aggregateInbox, decodePageCursor, encodePageCursor, normalizeInboxQuery, toWireItem, DEFAULT_LIMIT, MAX_LIMIT } from '../sdk/src/platform/intake/aggregator.ts';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function item(provider: string, id: string, receivedAt: number): InboundChannelItem {
  return { id, provider, receivedAt, kind: 'dm', fromDigest: '0123456789abcdef', subjectPreview: 'Fixture subject', bodyPreview: 'Fixture body', unread: true };
}
async function fixture(providers: Record<string, () => Promise<ProviderPollResult>>, poll = true) {
  const directory = makeProjectTempDir('inbox-aggregation');
  const store = new InboxCursorStore(directory, undefined, { sweepIntervalMs: 0 });
  await store.init();
  cleanups.push(() => store.close());
  const adapters = new Map<string, InboundProviderAdapter>(Object.entries(providers).map(([id, read]) => [id, { id, pollIntervalMs: 30_000, poll: read }]));
  const poller = new InboundPoller({ store, adapters, logger: { info() {}, warn() {}, error() {} } });
  cleanups.push(() => poller.stop());
  if (poll) await poller.pollOnce();
  return { store, poller, directory };
}
const healthy = (items: InboundChannelItem[]) => async (): Promise<ProviderPollResult> => ({ state: 'ready', items, configured: true });

describe('inbox mirror aggregation', () => {
  test('merges providers into one attributed timeline without fetching on read', async () => {
    let polls = 0;
    const sources = await fixture({ a: async () => { polls += 1; return { state: 'ready', configured: true, items: [item('a', 'a1', 1), item('a', 'a3', 3)] }; }, b: healthy([item('b', 'b2', 2)]) });
    const out = aggregateInbox(sources, normalizeInboxQuery({}));
    expect(out.items.map((row) => row.id)).toEqual(['a3', 'b2', 'a1']);
    expect(out.items.map((row) => row.provider)).toEqual(['a', 'b', 'a']);
    expect(out).toMatchObject({ total: 3, hasMore: false, truncated: false, partial: false });
    expect(out.providers).toEqual([
      expect.objectContaining({ provider: 'a', state: 'ready', storedCount: 2, itemCount: 2, configured: true }),
      expect.objectContaining({ provider: 'b', state: 'ready', storedCount: 1, itemCount: 1, configured: true }),
    ]);
    aggregateInbox(sources, normalizeInboxQuery({}));
    expect(polls).toBe(1);
  });

  test('concurrent provider snapshots and watermarks survive a restart', async () => {
    const now = Date.now();
    const sources = await fixture({ a: healthy([item('a', 'a1', now - 1)]), b: healthy([item('b', 'b1', now)]) });
    await sources.poller.stop();
    await sources.store.close();
    const reopened = new InboxCursorStore(sources.directory, undefined, { sweepIntervalMs: 0 });
    cleanups.push(() => reopened.close());
    await reopened.init();
    expect(reopened.listItems({ limit: 10 }).map((row) => row.id)).toEqual(['b1', 'a1']);
    expect(reopened.getCursor('a')).toBe(now - 1);
    expect(reopened.getCursor('b')).toBe(now);
  });

  test('walks tied timestamps once without offsets or duplicate pages', async () => {
    const sources = await fixture({ a: healthy(['a', 'b', 'c'].map((id) => item('a', id, 100))) });
    const first = aggregateInbox(sources, normalizeInboxQuery({ limit: 2 }));
    expect(first.items.map((row) => row.id)).toEqual(['a', 'b']);
    expect(first.nextCursor).toBeDefined();
    const second = aggregateInbox(sources, normalizeInboxQuery({ limit: 2, cursor: first.nextCursor }));
    expect(second.items.map((row) => row.id)).toEqual(['c']);
    expect(second.hasMore).toBe(false);
    expect(second.total).toBe(3);
  });

  test('keeps freshness watermark distinct from paging position and filters totals consistently', async () => {
    const sources = await fixture({ a: healthy([item('a', 'a1', 100), item('a', 'a2', 200)]), b: healthy([item('b', 'b1', 300)]) });
    const first = aggregateInbox(sources, normalizeInboxQuery({}, { provider: 'a', limit: '1' }));
    expect(first.cursor).toBe('200');
    expect(first.nextCursor).not.toBe(first.cursor);
    expect(first.providers.map((status) => status.provider)).toEqual(['a']);
    const fresh = aggregateInbox(sources, normalizeInboxQuery({}, { provider: 'a', since: first.cursor! }));
    expect(fresh.items).toEqual([]);
    expect(fresh.total).toBe(0);
    expect(fresh.providers[0]).toMatchObject({ state: 'empty', storedCount: 0 });
  });

  test('reports unavailable providers with an explicit partial answer', async () => {
    const sources = await fixture({ a: healthy([item('a', 'a1', 1)]), b: async () => ({ state: 'unavailable', items: [], configured: true, error: 'fixture refused' }) });
    const out = aggregateInbox(sources, normalizeInboxQuery({}));
    expect(out.items).toHaveLength(1);
    expect(out.partial).toBe(true);
    expect(out.providers[1]).toMatchObject({ state: 'error', configured: true, error: 'fixture refused', storedCount: 0 });
  });

  test('retains existing mirror history when a later attempt fails', async () => {
    let fail = false;
    const sources = await fixture({ a: async () => fail ? { state: 'unavailable', items: [], configured: true, error: 'fixture outage' } : { state: 'ready', configured: true, items: [item('a', 'history', 100)] } });
    fail = true;
    await sources.poller.pollOnce();
    const out = aggregateInbox(sources, normalizeInboxQuery({}));
    expect(out.items.map((row) => row.id)).toEqual(['history']);
    expect(out.partial).toBe(true);
    expect(out.providers[0]).toMatchObject({ state: 'error', storedCount: 1, itemCount: 1 });
  });

  test('an adapter exception keeps configuration unknown but reports an error', async () => {
    const sources = await fixture({ a: async () => { throw new Error('fixture credential store failed'); } });
    const out = aggregateInbox(sources, normalizeInboxQuery({}));
    expect(out.providers[0]?.configured).toBeUndefined();
    expect(out.providers[0]?.state).toBe('error');
    expect(out.partial).toBe(true);
  });

  test('unconfigured and unknown requested providers are named without inventing an outage', async () => {
    const sources = await fixture({ a: async () => ({ state: 'unavailable', items: [], configured: false, error: 'fixture no credential' }) });
    const out = aggregateInbox(sources, normalizeInboxQuery({}));
    expect(out).toMatchObject({ items: [], total: 0, partial: false });
    expect(out.providers[0]).toMatchObject({ state: 'unconfigured', configured: false });
    expect(out.providers[0]?.error).toBeUndefined();
    const unknown = aggregateInbox(sources, normalizeInboxQuery({ provider: 'unknown' }));
    expect(unknown.providers[0]).toMatchObject({ provider: 'unknown', state: 'unconfigured', configured: false, syncing: false });
  });

  test('a standby reports pending and never starts provider polling to answer a read', async () => {
    let calls = 0;
    const sources = await fixture({ a: async () => { calls += 1; return { state: 'empty', configured: true, items: [] }; } }, false);
    sources.store.upsertItems([item('a', 'existing', 100)]);
    const out = aggregateInbox(sources, normalizeInboxQuery({}));
    expect(out.items).toHaveLength(1);
    expect(out.providers[0]).toMatchObject({ state: 'pending', syncing: false, storedCount: 1 });
    expect(out.providers[0]?.lastSyncAt).toBeUndefined();
    expect(out.providers[0]?.configured).toBeUndefined();
    expect(calls).toBe(0);
  });

  test('an empty registry has a complete empty result', async () => {
    const sources = await fixture({});
    expect(aggregateInbox(sources, normalizeInboxQuery({}))).toEqual({ items: [], total: 0, hasMore: false, truncated: false, providers: [], partial: false });
  });
});

describe('inbox query and wire contracts', () => {
  test('query strings take precedence, finite numeric bounds remain stable', () => {
    expect(normalizeInboxQuery({ provider: 'body', limit: 5, since: 1 }, { provider: 'query', limit: '2', since: '12' })).toEqual({ providers: ['query'], limit: 2, since: 12 });
    expect(normalizeInboxQuery({})).toEqual({ limit: DEFAULT_LIMIT });
    expect(normalizeInboxQuery({}, { limit: '100000' }).limit).toBe(MAX_LIMIT);
    expect(normalizeInboxQuery({}, { limit: '0' }).limit).toBe(1);
    expect(normalizeInboxQuery({}, { limit: 'banana', since: '-1' })).toEqual({ limit: DEFAULT_LIMIT });
  });

  test('page cursors round trip IDs with delimiters and reject malformed values', () => {
    const position = { receivedAt: 123, id: 'provider:message:1' };
    expect(decodePageCursor(encodePageCursor(position))).toEqual(position);
    for (const value of ['not-a-cursor-this-issued', Buffer.from('-1:id').toString('base64url'), Buffer.from('100:').toString('base64url')]) {
      expect(() => decodePageCursor(value)).toThrow('cursor');
      try { decodePageCursor(value); } catch (error) { expect(error).toMatchObject({ code: 'INVALID_ARGUMENT', status: 400 }); }
    }
  });

  test('wire mapping exposes only redacted sender and declared optional fields', () => {
    const source = item('fixture', 'id', 100);
    const wire = toWireItem({ ...source, routeId: 'route', triageScore: 0.8, triageTags: ['fixture'] });
    expect(wire).toEqual({ id: 'id', provider: 'fixture', kind: 'dm', from: source.fromDigest, subject: 'Fixture subject', bodyPreview: 'Fixture body', receivedAt: 100, unread: true, routeId: 'route' });
    expect(toWireItem({ ...source, subjectPreview: '' }).subject).toBeUndefined();
  });
});

test('proven absent admission is unconfigured without inventing a poll, while unknown and configured states retain pending/error', () => {
  const statuses = [
    { id: 'absent', state: 'unavailable' as const, configured: false, polled: false, itemCount: 0 },
    { id: 'unknown', state: 'unavailable' as const, polled: false, itemCount: 0, error: 'credential lookup failed' },
    { id: 'configured', state: 'unavailable' as const, configured: true, polled: false, itemCount: 0 },
    { id: 'outage', state: 'unavailable' as const, configured: true, polled: true, itemCount: 0, error: 'transient provider failure' },
  ];
  const out = aggregateInbox({
    store: { listItems: () => [], countItems: () => 0, countItemsByProvider: () => new Map(),
      maxReceivedAt: () => 0, getImapCheckpoint: () => null },
    poller: { snapshotStatuses: () => statuses, isProviderRunning: () => false },
  }, normalizeInboxQuery({}));
  expect(out.providers.map(row => row.state)).toEqual(['unconfigured', 'pending', 'pending', 'error']);
  expect(out.providers.every(row => row.lastSyncAt === undefined)).toBe(true);
  expect(out.cursor).toBeUndefined(); expect(out.partial).toBe(true);
});
