import { expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { PaymentReplyInbox, PaymentReplyInboxClosedError } from '../sdk/src/platform/payments/reply-inbox.js';
import { createChannelPaymentNotifier } from '../sdk/src/platform/payments/notice-delivery.js';
import { paymentsPort } from './helpers/payments-readings.ts';

const input = { kind: 'veto' as const, channels: ['telegram' as const], notice: 'Fixture purchase notice', deadlineMs: Date.now() + 60_000 };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('closing rejects every active window and never reports deadline silence', async () => {
  const inbox = new PaymentReplyInbox();
  const veto = inbox.waitForAnswer(input);
  const approval = inbox.waitForAnswer({ ...input, kind: 'approval' });
  expect(inbox.pending).toBe(2);
  const close = inbox.close();
  expect(inbox.close()).toBe(close);
  await expect(veto).rejects.toBeInstanceOf(PaymentReplyInboxClosedError);
  await expect(approval).rejects.toBeInstanceOf(PaymentReplyInboxClosedError);
  await close;
  expect(inbox.pending).toBe(0);
  await expect(inbox.waitForAnswer(input)).rejects.toBeInstanceOf(PaymentReplyInboxClosedError);
  expect(await inbox.offer('telegram', 'yes')).toEqual({ consumed: false, reason: 'no-window' });
});

test('an actual elapsed deadline remains silence, including after later close', async () => {
  const inbox = new PaymentReplyInbox();
  const answer = await inbox.waitForAnswer({ ...input, deadlineMs: Date.now() - 1 });
  expect(answer).toBeNull();
  await inbox.close();
  expect(answer).toBeNull();
});

test('close drains an accepted reading and a late answer cannot revive its window', async () => {
  const entered = deferred();
  const release = deferred();
  const fake = paymentsPort();
  const previous = installJudgmentPort({
    model: fake.port.model,
    async ask(request) {
      entered.resolve();
      await release.promise;
      return fake.port.ask(request);
    },
  });
  const inbox = new PaymentReplyInbox();
  try {
    const waiting = inbox.waitForAnswer(input);
    const offering = inbox.offer('telegram', 'stop');
    await entered.promise;
    const closing = inbox.close();
    let closed = false;
    void closing.then(() => { closed = true; });
    await expect(waiting).rejects.toBeInstanceOf(PaymentReplyInboxClosedError);
    expect(closed).toBe(false);
    expect(await inbox.offer('telegram', 'yes')).toEqual({ consumed: false, reason: 'no-window' });
    release.resolve();
    expect(await offering).toEqual({ consumed: false, reason: 'no-window' });
    await closing;
    expect(closed).toBe(true);
    expect(fake.requests).toHaveLength(1);
  } finally {
    release.resolve();
    await inbox.close();
    installJudgmentPort(previous);
  }
});

test('failed accepted reading stays observable while close still drains it', async () => {
  const entered = deferred();
  const release = deferred();
  const previous = installJudgmentPort({
    model: 'jev-1.13.0',
    async ask() { entered.resolve(); await release.promise; throw new Error('fixture reading failed'); },
  });
  const inbox = new PaymentReplyInbox();
  try {
    const waiting = inbox.waitForAnswer(input);
    const offering = inbox.offer('telegram', 'stop');
    await entered.promise;
    const closing = inbox.close();
    await expect(waiting).rejects.toBeInstanceOf(PaymentReplyInboxClosedError);
    release.resolve();
    await expect(offering).rejects.toThrow('fixture reading failed');
    await closing;
  } finally {
    release.resolve();
    await inbox.close();
    installJudgmentPort(previous);
  }
});

test('legacy ignored waits and synchronous close calls do not emit unhandled rejection', async () => {
  const errors: unknown[] = [];
  const observer = (error: unknown) => { errors.push(error); };
  process.on('unhandledRejection', observer);
  try {
    const inbox = new PaymentReplyInbox();
    void inbox.waitForAnswer(input);
    void inbox.close();
    void inbox.waitForAnswer(input);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(errors).toEqual([]);
  } finally {
    process.off('unhandledRejection', observer);
  }
});

test('the real notifier preserves shutdown rejection on a delivered veto notice', async () => {
  const inbox = new PaymentReplyInbox();
  const notices: unknown[] = [];
  const notifier = createChannelPaymentNotifier({
    router: { async deliver(request) { notices.push(request); return 'fixture-message'; } },
    targets: [{ channel: 'telegram', request: {}, backfillable: true }],
    replies: inbox,
  });
  expect(await notifier.deliver({ kind: 'veto', message: input.notice })).toEqual([
    { channel: 'telegram', delivered: true, backfillable: true },
  ]);
  const waiting = notifier.awaitAnswer({ kind: 'veto', deadlineMs: input.deadlineMs });
  await inbox.close();
  await expect(waiting).rejects.toBeInstanceOf(PaymentReplyInboxClosedError);
  expect(notices).toHaveLength(1);
});

test('a judgment port reentering close cannot escape the accepted-work drain', async () => {
  const release = deferred();
  const entered = deferred();
  const inbox = new PaymentReplyInbox();
  let closed = false;
  const fake = paymentsPort();
  const previous = installJudgmentPort({
    model: fake.port.model,
    async ask(request) {
      void inbox.close().then(() => { closed = true; });
      entered.resolve();
      await release.promise;
      return fake.port.ask(request);
    },
  });
  try {
    const waiting = inbox.waitForAnswer(input);
    const offering = inbox.offer('telegram', 'stop');
    await entered.promise;
    await expect(waiting).rejects.toBeInstanceOf(PaymentReplyInboxClosedError);
    await Promise.resolve();
    expect(closed).toBe(false);
    release.resolve();
    expect(await offering).toEqual({ consumed: false, reason: 'no-window' });
    await inbox.close();
    expect(closed).toBe(true);
  } finally {
    release.resolve();
    await inbox.close();
    installJudgmentPort(previous);
  }
});
