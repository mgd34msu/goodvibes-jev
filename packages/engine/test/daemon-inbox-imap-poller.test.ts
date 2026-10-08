import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { InboxCursorStore } from '../sdk/src/platform/intake/cursor-store.ts';
import { InboundPoller } from '../sdk/src/platform/intake/poller.ts';
import type { ImapUidCheckpoint, ImapUidCheckpointAdvance, InboundProviderAdapter, ProviderPollOptions, ProviderPollResult } from '../sdk/src/platform/intake/provider-adapter.ts';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const baseline: ImapUidCheckpoint = { kind: 'imap-uid', uidValidity: 7, lastTerminalUid: null,
  history: { kind: 'bounded-seed', lowerBoundUid: 101, skippedOlderMessages: 100 } };
const seed: ImapUidCheckpointAdvance = { kind: 'imap-uid', transition: 'seed', previous: null, next: baseline, coveredUids: [], terminal: [] };
const row = { id: 'email:7:101', provider: 'email', kind: 'dm' as const, fromDigest: '0123456789abcdef',
  subjectPreview: 'Redacted subject', bodyPreview: 'Redacted body', receivedAt: 1, unread: true };
const advance: ImapUidCheckpointAdvance = { kind: 'imap-uid', transition: 'advance', previous: baseline,
  next: { ...baseline, lastTerminalUid: 101 }, coveredUids: [101], terminal: [{ uid: 101, disposition: 'published', itemId: row.id }] };
const pending: ProviderPollResult = { items: [], state: 'unavailable', configured: true, error: 'Initial history seed recorded; content pending next cadence', checkpointAdvance: seed };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function fixture(poll: InboundProviderAdapter['poll'], options: Partial<InboundProviderAdapter> = {}) {
  const dir = makeProjectTempDir('inbox-imap-poller');
  const store = new InboxCursorStore(dir, undefined, { sweepIntervalMs: 0, now: () => 0 });
  await store.init(); cleanups.push(() => store.close());
  const adapter: InboundProviderAdapter = { id: 'email', pollIntervalMs: 60_000, checkpointKind: 'imap-uid', assertCurrent() {}, poll, ...options };
  const poller = new InboundPoller({ store, adapters: new Map([['email', adapter]]), logger: { info() {}, warn() {}, error() {} } });
  cleanups.push(() => poller.stop());
  return { dir, store, poller, adapter };
}

describe('canonical IMAP checkpoint poller', () => {
  test('initial seed is durable but remains visibly pending; next ordinary poll uses its baseline', async () => {
    const calls: ProviderPollOptions[] = [];
    const { store, poller } = await fixture(async options => {
      calls.push(options);
      return calls.length === 1 ? pending : { state: 'ready', configured: true, items: [row], checkpointAdvance: advance };
    });
    store.advanceCursor('email', 999_999); // never passed as an IMAP Date watermark
    await poller.pollOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.since).toBeUndefined();
    expect(calls[0]?.checkpoint).toBeUndefined();
    expect(store.getImapCheckpoint('email')).toEqual(baseline);
    expect(poller.snapshotStatuses()[0]).toMatchObject({ state: 'unavailable', itemCount: 0, configured: true, error: pending.error });
    await poller.pollOnce();
    expect(calls[1]?.checkpoint).toEqual(baseline);
    expect(store.getImapCheckpoint('email')?.lastTerminalUid).toBe(101);
    expect(store.getCursor('email')).toBe(999_999);
    expect(store.countItems()).toBe(1);
  });

  test('incomplete results cannot consume terminal UIDs or rows', async () => {
    let calls = 0;
    const { store, poller } = await fixture(async () => ++calls === 1 ? pending : {
      state: 'unavailable', items: [row], configured: true, error: 'incomplete protected disposition', checkpointAdvance: advance,
    });
    await poller.pollOnce(); await poller.pollOnce();
    expect(store.getImapCheckpoint('email')).toEqual(baseline);
    expect(store.countItems()).toBe(0);
    expect(poller.snapshotStatuses()[0]?.state).toBe('unavailable');
  });

  test('aborted in-flight source results leave the durable seed pending', async () => {
    let calls = 0; const started = deferred<ProviderPollOptions>(); const result = deferred<ProviderPollResult>();
    const { store, poller } = await fixture(async options => {
      if (++calls === 1) return pending;
      started.resolve(options); return result.promise;
    });
    await poller.pollOnce(); const polling = poller.pollOnce(); const options = await started.promise;
    const stopped = poller.stopProvider('email');
    result.resolve({ state: 'ready', items: [row], checkpointAdvance: advance });
    await Promise.all([polling, stopped]);
    expect(options.signal?.aborted).toBe(true);
    expect(store.getImapCheckpoint('email')).toEqual(baseline);
    expect(store.countItems()).toBe(0);
  });

  test('leadership loss at the final persistence fence prevents rows and progress together', async () => {
    let calls = 0; let fenceCalls = 0; let stopping: Promise<void> | undefined;
    const { store, poller } = await fixture(async () => ++calls === 1 ? pending : { state: 'ready', items: [row], checkpointAdvance: advance }, {
      assertCurrent() { if (++fenceCalls === 4) stopping = poller.stopProvider('email'); },
    });
    await poller.pollOnce(); await poller.pollOnce(); await stopping;
    expect(store.getImapCheckpoint('email')).toEqual(baseline);
    expect(store.countItems()).toBe(0);
  });

  test('persistence failure remains pending and the next poll receives exactly the same checkpoint', async () => {
    let calls = 0; const seen: Array<ImapUidCheckpoint | undefined> = [];
    const { store, poller } = await fixture(async options => {
      seen.push(options.checkpoint); return ++calls === 1 ? pending : { state: 'ready', configured: true, items: [row], checkpointAdvance: advance };
    });
    await poller.pollOnce();
    const commit = spyOn(store, 'commitImapPoll').mockRejectedValueOnce(new Error('synthetic persistence failure'));
    cleanups.push(() => commit.mockRestore());
    await poller.pollOnce(); await poller.pollOnce();
    expect(seen[1]).toEqual(baseline); expect(seen[2]).toEqual(baseline);
    expect(store.countItems()).toBe(1);
    expect(store.getImapCheckpoint('email')?.lastTerminalUid).toBe(101);
  });

  test('UID proposal cannot invent a timestamp adapter capability or currentness authority', async () => {
    const { store, poller } = await fixture(async () => pending, { checkpointKind: undefined } as unknown as Partial<InboundProviderAdapter>);
    await poller.pollOnce();
    expect(store.getImapCheckpoint('email')).toBeNull();
    expect(poller.snapshotStatuses()[0]?.state).toBe('unavailable');
  });

  test('UID adapters without a synchronous fence fail closed before reading', async () => {
    let calls = 0;
    const { store, poller } = await fixture(async () => { calls += 1; return pending; }, { assertCurrent: undefined } as unknown as Partial<InboundProviderAdapter>);
    await poller.pollOnce();
    expect(calls).toBe(0);
    expect(store.getImapCheckpoint('email')).toBeNull();
  });

  test('uncovered rows and async fences cannot consume progress', async () => {
    const first = await fixture(async () => ({ state: 'ready', items: [row] }));
    await first.poller.pollOnce(); expect(first.store.countItems()).toBe(0);
    const second = await fixture(async () => pending, { assertCurrent: (async () => {}) as () => void });
    await second.poller.pollOnce(); expect(second.store.getImapCheckpoint('email')).toBeNull();
  });
});
