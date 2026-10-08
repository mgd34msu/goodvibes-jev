import { afterEach, expect, test } from 'bun:test';
import { makeProjectTempDir } from './_helpers/project-temp.js';
import { InboxCursorStore } from '../sdk/src/platform/intake/cursor-store.js';
import { InboundPoller } from '../sdk/src/platform/intake/poller.js';
import { aggregateInbox } from '../sdk/src/platform/intake/aggregator.js';
import type { ImapUidCheckpoint, ProviderPollResult } from '../sdk/src/platform/intake/provider-adapter.js';
import { CHANNEL_INBOX_PROVIDER_STATUS_SCHEMA } from '../sdk/src/platform/control-plane/operator-contract-schemas-channel-sync.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(history: ImapUidCheckpoint['history']) {
  const store = new InboxCursorStore(makeProjectTempDir('mailbox-disclosure'), undefined, { sweepIntervalMs: 0 });
  await store.init(); cleanups.push(() => store.close());
  const baseline: ImapUidCheckpoint = { kind: 'imap-uid', uidValidity: 7, lastTerminalUid: null, history };
  let response: ProviderPollResult = { items: [], state: 'unavailable', configured: true, error: 'Awaiting next poll', pendingMessages: 2,
    checkpointAdvance: { kind: 'imap-uid', transition: 'seed', previous: null, next: baseline, coveredUids: [], terminal: [] } };
  const poller = new InboundPoller({ store, adapters: new Map([['email', { id: 'email', pollIntervalMs: 60_000,
    checkpointKind: 'imap-uid' as const, assertCurrent() {}, async poll() { return response; } }]]), logger: { info() {}, warn() {}, error() {} } });
  cleanups.push(() => poller.stop());
  return { store, poller, baseline, set(value: ProviderPollResult) { response = value; },
    inbox: () => aggregateInbox({ store, poller }, { limit: 10 }) };
}

test('bounded history omissions remain distinct and visible after successful catch-up', async () => {
  const f = await fixture({ kind: 'bounded-seed', lowerBoundUid: 101, skippedOlderMessages: 100 });
  await f.poller.pollOnce();
  let inbox = await f.inbox(); expect(inbox.partial).toBe(true);
  expect(inbox.providers[0]).toMatchObject({ mailboxHistory: { uidValidity: 7, kind: 'bounded-seed', lowerBoundUid: 101, skippedOlderMessages: 100 },
    mailboxProgress: { uidValidity: 7, pendingMessages: 2 } });
  f.set({ items: [], state: 'empty', configured: true, pendingMessages: 0,
    checkpointAdvance: { kind: 'imap-uid', transition: 'advance', previous: f.baseline,
      next: { ...f.baseline, lastTerminalUid: 102 }, coveredUids: [101, 102], terminal: [{ uid: 101, disposition: 'suppressed' }, { uid: 102, disposition: 'suppressed' }] } });
  await f.poller.pollOnce(); inbox = await f.inbox();
  expect(inbox.providers[0]!.state).toBe('empty'); expect(inbox.providers[0]!.error).toBeUndefined();
  expect(inbox.providers[0]!.mailboxProgress).toEqual({ uidValidity: 7, pendingMessages: 0 });
  expect(inbox.partial).toBe(true); // historical omission is not an outage or consumed history
});

test('pending counts are generation-labelled observations and become unknown after interrupted polling', async () => {
  const f = await fixture({ kind: 'complete', lowerBoundUid: 1, skippedOlderMessages: 0 });
  await f.poller.pollOnce(); expect((await f.inbox()).partial).toBe(true);
  await f.poller.stopProvider('email');
  const interrupted = await f.inbox(); expect(interrupted.providers[0]!.mailboxProgress).toBeUndefined();
  expect(interrupted.providers[0]!.mailboxHistory?.uidValidity).toBe(7); expect(interrupted.partial).toBe(true);
});

test('canonical provider schema makes both additive mailbox records optional', () => {
  expect(CHANNEL_INBOX_PROVIDER_STATUS_SCHEMA.required).not.toContain('mailboxHistory');
  expect(CHANNEL_INBOX_PROVIDER_STATUS_SCHEMA.required).not.toContain('mailboxProgress');
  const properties = CHANNEL_INBOX_PROVIDER_STATUS_SCHEMA.properties as Record<string, unknown>;
  expect(properties.mailboxHistory).toMatchObject({ required: ['uidValidity', 'kind', 'lowerBoundUid', 'skippedOlderMessages'] });
  expect(properties.mailboxProgress).toMatchObject({ required: ['uidValidity', 'pendingMessages'] });
});
