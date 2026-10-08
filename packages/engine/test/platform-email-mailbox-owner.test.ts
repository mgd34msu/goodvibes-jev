import { expect, test } from 'bun:test';
import { readEmailConfig } from '../sdk/src/platform/email/email-config.js';
import type { EmailReplySubjectSource } from '../sdk/src/platform/email/reply-subject-source.js';
import { snapshotFixture } from './_helpers/mail-inbox-snapshot.js';

function fixture() {
  const f = snapshotFixture(); const owner = f.owner!;
  const config = readEmailConfig(key => f.config[key]);
  const read = (uid = 42, validity = 7) => {
    const ticket = owner.beginRead(config, uid); ticket.observeMailbox('INBOX', validity); return ticket;
  };
  return { ...f, owner, config, read };
}

test('mailbox validity publishes before revocation callbacks can start a newer generation', () => {
  const f = fixture(); const old = f.read().complete(42, 'INBOX', 'Old')!;
  let nested: EmailReplySubjectSource | undefined;
  old.signal.addEventListener('abort', () => { nested = f.read(43, 7).complete(43, 'INBOX', 'Nested'); }, { once: true });
  const outer = f.owner.beginRead(f.config, 44); outer.observeMailbox('INBOX', 9);
  expect(nested).toBeDefined(); expect(outer.complete(44, 'INBOX', 'Stale')).toBeUndefined();
  expect(nested!.signal.aborted).toBe(false);
  f.read(45, 9);
  expect(nested!.signal.aborted).toBe(true);
  expect(() => nested!.assertCurrent()).toThrow();
});

test('invalidation detaches old state before callbacks and does not clobber newer read', () => {
  const f = fixture(); const old = f.read().complete(42, 'INBOX', 'Old')!;
  let nested: EmailReplySubjectSource | undefined;
  old.signal.addEventListener('abort', () => { nested = f.read(43, 7).complete(43, 'INBOX', 'Nested'); }, { once: true });
  f.owner.invalidate();
  expect(nested).toBeDefined(); expect(nested!.signal.aborted).toBe(false);
  expect(() => nested!.assertCurrent()).not.toThrow();
  f.read(44, 8); expect(nested!.signal.aborted).toBe(true);
});

test('same-UID reentrancy never deletes a newer source after its abort callback', () => {
  const f = fixture(); const old = f.read().complete(42, 'INBOX', 'Old')!;
  let nested: EmailReplySubjectSource | undefined;
  old.signal.addEventListener('abort', () => { nested = f.read().complete(42, 'INBOX', 'Nested'); }, { once: true });
  const outer = f.owner.beginRead(f.config, 42); outer.observeMailbox('INBOX', 7);
  expect(outer.complete(42, 'INBOX', 'Stale')).toBeUndefined(); expect(nested).toBeDefined();
  f.read(); expect(nested!.signal.aborted).toBe(true);
});

test('observation eviction is bounded and stale callbacks cannot issue a replacement receipt', () => {
  const f = fixture(); const oldest = f.read().completeMailboxObservation()!;
  oldest.signal.addEventListener('abort', () => { f.owner.invalidate(); }, { once: true });
  for (let n = 1; n < 256; n++) expect(f.read().completeMailboxObservation()).toBeDefined();
  expect(f.read().completeMailboxObservation()).toBeUndefined(); expect(oldest.signal.aborted).toBe(true);
});

test('dispose refuses a reentrant source read from an abort listener', () => {
  const f = fixture(); const old = f.read().completeMailboxObservation()!;
  let nested: ReturnType<typeof old.assertCurrent> | undefined;
  old.signal.addEventListener('abort', () => {
    const next = f.read(); expect(next.completeMailboxObservation()).toBeUndefined();
    expect(next.complete(42, 'INBOX', 'No authority')).toBeUndefined();
    nested = undefined;
  }, { once: true });
  f.owner.dispose(); expect(old.signal.aborted).toBe(true); expect(nested).toBeUndefined();
});
