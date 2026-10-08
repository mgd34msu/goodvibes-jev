import { describe, expect, test } from 'bun:test';
import { createServiceBackedGateway, instrumentEmailGateway } from '../sdk/src/platform/control-plane/routes/email-composition.js';
import { deferred, mailFixture, tick } from './_helpers/mail-subject-source.js';
import { hasVerifiedImapMessageIdentity, readMessageDetail } from '../sdk/src/platform/email/imap-message-read.js';
import type { ImapSession } from '../sdk/src/platform/email/imap-session.js';
import type { ImapFetchFrame } from '../sdk/src/platform/email/imap-fetch-response.js';

function required<T>(value: T | null | undefined): T {
  expect(value).toBeDefined(); expect(value).not.toBeNull();
  return value!;
}

describe('canonical mail reply subject source', () => {
  test('only an exact completed result maps to an immutable source, through both gateway wrappers', async () => {
    const { service } = mailFixture({ plans: [{ subject: 'untrusted exact subject' }, {}] });
    const message = required(await service.readMessage(42));
    const source = required(service.getReplySubjectSource(message));
    expect(source.subject).toBe('untrusted exact subject');
    expect(Object.isFrozen(source)).toBe(true);
    expect(() => source.assertCurrent()).not.toThrow();
    expect(service.getReplySubjectSource({ ...message })).toBeUndefined();
    expect(service.getReplySubjectSource(JSON.parse(JSON.stringify(message)))).toBeUndefined();
    const gateway = instrumentEmailGateway(createServiceBackedGateway(service), {});
    const mapped = required(await gateway.readMessage(43));
    expect(required(gateway.getReplySubjectSource?.(mapped)).subject).toBe(mapped.subject);
    expect(gateway.getReplySubjectSource?.({ ...mapped })).toBeUndefined();
    expect(Object.keys(mapped)).not.toContain('replySubjectSource');
    expect(JSON.stringify(mapped)).not.toContain('revision');
  });

  test.each([null, 0, -1, 4294967296, 9007199254740992])('missing/invalid UIDVALIDITY %s permits reads but no source', async uidValidity => {
    const { service } = mailFixture({ plans: [{ uidValidity }] });
    const message = required(await service.readMessage(42));
    expect(message.subject).toBe('Original subject');
    expect(service.getReplySubjectSource(message)).toBeUndefined();
  });

  test.each([null, 99])('missing/mismatched wire UID %s permits legacy reads without source provenance', async wireUid => {
    const { service } = mailFixture({ plans: [{ wireUid }] });
    const message = required(await service.readMessage(42));
    expect(message.subject).toBe('Original subject');
    expect(service.getReplySubjectSource(message)).toBeUndefined();
  });

  test.each(['<0>', '<1024>', '<0.4096>'])('partial HEADER response %s remains readable without complete-subject provenance', async headerPartial => {
    const { service } = mailFixture({ plans: [{ subject: 'Re: visible fragment', headerPartial }] });
    const message = required(await service.readMessage(42));
    expect(message.subject).toBe('Re: visible fragment');
    expect(service.getReplySubjectSource(message)).toBeUndefined();
  });

  test.each(['duplicate-section', 'non-body-section', 'duplicate-uid'] as const)('%s cannot establish canonical subject provenance', async kind => {
    const literal = 'From: synthetic@example.invalid\r\nSubject: Re: visible fragment\r\n\r\n';
    const headers: ImapFetchFrame[] = kind === 'duplicate-section'
      ? [{ syntax: '* 1 FETCH (UID 42 BODY[HEADER] ', literal }, { syntax: ' BODY[HEADER] ', literal }, { syntax: ')' }]
      : [{ syntax: `* 1 FETCH (UID 42 ${kind === 'duplicate-uid' ? 'UID 43 ' : ''}${kind === 'non-body-section' ? 'X' : 'BODY'}[HEADER] `, literal }, { syntax: ')' }];
    const session = { commandFrames: async (command: string) => command.includes('[HEADER]') ? headers : [] };
    const read = await readMessageDetail(session as unknown as ImapSession, 42, 'INBOX');
    expect(read.outcome).toBe('read');
    if (read.outcome !== 'read') throw new Error('Expected compatible readable message.');
    expect(read.detail.subject).toBe('Re: visible fragment');
    expect(hasVerifiedImapMessageIdentity(read.detail)).toBe(false);
  });

  test.each([
    ['long', 'x'.repeat(4097)],
    ['protected tail', `${'x'.repeat(4097)} sk-syntheticProtectedTail01234567890123456789`],
    ['folded long', `Visible prefix\r\n ${'x'.repeat(2100)} protected tail`],
    ['base64 encoded', '=?UTF-8?B?UmU6IFN5bnRoZXRpYw==?='],
    ['quoted-printable encoded', '=?UTF-8?Q?Re=3A_Synthetic?='],
    ['replacement decoding', 'Synthetic\ufffdsubject'],
    ['duplicate', 'First\r\nSubject: Conflicting duplicate'],
  ] as const)('%s subject remains display-only when complete identity is unproven', async (_label, subject) => {
    const { service } = mailFixture({ plans: [{ subject }] });
    const message = required(await service.readMessage(42));
    expect(service.getReplySubjectSource(message)).toBeUndefined();
  });

  test('complete Unicode and ordinarily folded subjects preserve their canonical identity', async () => {
    const { service } = mailFixture({ plans: [{ subject: 'Re: Überprüfung 你好' }, { subject: 'Re: one\r\n two' },
      { subject: 'Re: BODY[HEADER]<0> UID 99) is opaque subject text' }] });
    for (const uid of [42, 43, 44]) {
      const message = required(await service.readMessage(uid));
      expect(required(service.getReplySubjectSource(message)).subject).toBe(message.subject);
    }
  });

  test('a composition without lifecycle ownership preserves ordinary reads', async () => {
    const { service } = mailFixture({ owner: null });
    const message = required(await service.readMessage(42));
    expect(service.getReplySubjectSource(message)).toBeUndefined();
  });

  test('new same-UID read revokes immediately, including when the message is gone', async () => {
    const gate = deferred<string | null>();
    let reads = 0;
    const { service } = mailFixture({ plans: [{}, { gone: true }], overrides: {
      secretsManager: { get: async () => ++reads === 1 ? 'synthetic' : gate.promise },
    } });
    const first = required(await service.readMessage(42));
    const source = required(service.getReplySubjectSource(first));
    const next = service.readMessage(42);
    expect(source.signal.aborted).toBe(true);
    expect(() => source.assertCurrent()).toThrow('no longer current');
    gate.resolve('synthetic');
    expect(await next).toBeNull();
    expect(service.getReplySubjectSource(first)).toBeUndefined();
  });

  test('observing another UID in a replacement mailbox revokes every old generation', async () => {
    const { service } = mailFixture({ plans: [{ uidValidity: 7 }, { uidValidity: 8 }] });
    const first = required(await service.readMessage(42));
    const source = required(service.getReplySubjectSource(first));
    const next = required(await service.readMessage(43));
    expect(source.signal.aborted).toBe(true);
    expect(required(service.getReplySubjectSource(next)).signal.aborted).toBe(false);
  });

  test('a slow older DIFFERENT-UID read cannot restore old UIDVALIDITY after a new read', async () => {
    const gate = deferred<void>();
    const { service } = mailFixture({ plans: [{ uidValidity: 7, headerGate: gate.promise }, { uidValidity: 8 }] });
    const slow = service.readMessage(42);
    await tick(); await tick();
    const newer = required(await service.readMessage(43));
    const current = required(service.getReplySubjectSource(newer));
    gate.resolve();
    expect(service.getReplySubjectSource(required(await slow))).toBeUndefined();
    expect(current.signal.aborted).toBe(false);
    expect(() => current.assertCurrent()).not.toThrow();
  });

  test('a pre-credential-await ticket cannot mint after invalidation, even config ABA', async () => {
    const gate = deferred<string | null>();
    const { service, owner, config } = mailFixture({ overrides: { secretsManager: { get: () => gate.promise } } });
    const reading = service.readMessage(42);
    config['email.username'] = 'replacement@example.invalid'; owner!.invalidate();
    config['email.username'] = 'owner@example.invalid'; owner!.invalidate();
    gate.resolve('synthetic');
    expect(service.getReplySubjectSource(required(await reading))).toBeUndefined();
  });

  test('owner shutdown revokes completed sources and reads still awaiting logout', async () => {
    const gate = deferred<void>();
    const { service, owner } = mailFixture({ plans: [{}, { logoutGate: gate.promise }] });
    const source = required(service.getReplySubjectSource(required(await service.readMessage(42))));
    const slow = service.readMessage(43);
    await tick(); await tick();
    owner!.dispose(); gate.resolve();
    expect(source.signal.aborted).toBe(true);
    expect(service.getReplySubjectSource(required(await slow))).toBeUndefined();
  });

  test('source controllers are bounded and eviction revokes old snapshots', async () => {
    const { service } = mailFixture({ plans: Array.from({ length: 257 }, () => ({})) });
    const first = required(service.getReplySubjectSource(required(await service.readMessage(1))));
    for (let uid = 2; uid <= 257; uid += 1) {
      const current = required(service.getReplySubjectSource(required(await service.readMessage(uid))));
      expect(current.signal.aborted).toBe(false);
    }
    expect(first.signal.aborted).toBe(true);
    expect(() => first.assertCurrent()).toThrow('no longer current');
  });

  test('mailbox replacement seen by inbox listing revokes existing snapshots', async () => {
    const { service } = mailFixture({ plans: [{ uidValidity: 7 }, { uidValidity: 8 }] });
    const source = required(service.getReplySubjectSource(required(await service.readMessage(42))));
    await service.listInbox();
    expect(source.signal.aborted).toBe(true);
  });
});
