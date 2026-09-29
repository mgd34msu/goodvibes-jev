/**
 * payments-reply-inbox.test.ts, the owner's answer to a purchase notice
 * arriving over a channel.
 *
 * The notifier waits on the inbox; the daemon's shared ingress hook offers the
 * owner's inbound messages to it; the inbox reads each against the notice it
 * follows. These pin who may answer (the channel policy's owner allowlist, a
 * command-authority channel), what settles a window (a reply the reading
 * takes as an answer), what does not (an unclear reply, several windows on
 * one channel), and that the wait ends as silence at the deadline and only
 * then.
 */
import { describe, expect, test } from 'bun:test';
import { PaymentReplyInbox } from '../sdk/src/platform/payments/reply-inbox.js';
import { tryResolvePaymentReplyFromChannel } from '../sdk/src/platform/daemon/payment-reply.js';
import { DaemonSurfaceActionHelper } from '../sdk/src/platform/daemon/surface-actions.ts';
import type { ChannelPolicyDecision } from '../sdk/src/platform/channels/index.js';
import { usePaymentsReadings } from './helpers/payments-readings.ts';

const readings = usePaymentsReadings();

const VETO_NOTICE = 'Buying in 10 minutes unless you say stop: mouse from microcenter.com.';
const APPROVAL_NOTICE = 'Purchase needs your OK: hub from bestbuy.com. Reply to approve or deny.';
const OWNER = 'owner-1';

function decision(owners: readonly string[] = [OWNER]): ChannelPolicyDecision {
  return { allowed: true, reason: 'ok', policy: { allowlistUserIds: [...owners] } } as unknown as ChannelPolicyDecision;
}

function soon(ms = 60_000): number {
  return Date.now() + ms;
}

describe('the inbox settles a waiting window from a reply', () => {
  test('an answer settles the wait with the channel it came from', async () => {
    const inbox = new PaymentReplyInbox();
    const wait = inbox.waitForAnswer({ kind: 'veto', deadlineMs: soon(), channels: ['telegram'], notice: VETO_NOTICE });
    const offer = await inbox.offer('telegram', 'stop');
    expect(offer).toEqual({ consumed: true, answer: 'object' });
    expect(await wait).toEqual({ answer: 'object', channel: 'telegram' });
    expect(inbox.pending).toBe(0);
  });

  test('the reply is read against the waiting notice, by the window\'s own reading', async () => {
    const inbox = new PaymentReplyInbox();
    void inbox.waitForAnswer({ kind: 'approval', deadlineMs: soon(), channels: ['telegram'], notice: APPROVAL_NOTICE });
    await inbox.offer('telegram', 'yes');
    const asked = readings.requests.find((request) => request.context?.battery === 'engine.payments.approval-reply');
    expect(asked?.state).toEqual({ proposal: APPROVAL_NOTICE, reply: 'yes' });
  });

  test('an unclear reply is not consumed and the window keeps waiting', async () => {
    const inbox = new PaymentReplyInbox();
    void inbox.waitForAnswer({ kind: 'veto', deadlineMs: soon(), channels: ['telegram'], notice: VETO_NOTICE });
    const offer = await inbox.offer('telegram', 'how much was shipping?');
    expect(offer).toEqual({ consumed: false, reason: 'not-an-answer' });
    expect(inbox.pending).toBe(1);
  });

  test('a message on a channel no window waits on is not read at all', async () => {
    const inbox = new PaymentReplyInbox();
    void inbox.waitForAnswer({ kind: 'veto', deadlineMs: soon(), channels: ['tui'], notice: VETO_NOTICE });
    expect(await inbox.offer('telegram', 'stop')).toEqual({ consumed: false, reason: 'no-window' });
    expect(readings.requests).toHaveLength(0);
  });

  test('two windows on one channel: a reply settles neither, and is not read', async () => {
    const inbox = new PaymentReplyInbox();
    void inbox.waitForAnswer({ kind: 'veto', deadlineMs: soon(), channels: ['telegram'], notice: VETO_NOTICE });
    void inbox.waitForAnswer({ kind: 'approval', deadlineMs: soon(), channels: ['telegram'], notice: APPROVAL_NOTICE });
    expect(await inbox.offer('telegram', 'yes')).toEqual({ consumed: false, reason: 'several-windows' });
    expect(inbox.pending).toBe(2);
    expect(readings.requests).toHaveLength(0);
  });

  test('the wait resolves null at the deadline, which is silence', async () => {
    const inbox = new PaymentReplyInbox();
    const answer = await inbox.waitForAnswer({ kind: 'approval', deadlineMs: Date.now() + 5, channels: ['telegram'], notice: APPROVAL_NOTICE });
    expect(answer).toBeNull();
    expect(inbox.pending).toBe(0);
  });

  test('a reading that fails leaves the window open and reaches the caller', async () => {
    const inbox = new PaymentReplyInbox();
    void inbox.waitForAnswer({ kind: 'veto', deadlineMs: soon(), channels: ['telegram'], notice: VETO_NOTICE });
    const { installJudgmentPort } = await import('@goodvibes-jev/engine/errors');
    const previous = installJudgmentPort({ model: 'jev-1.13.0', ask: async () => { throw new Error('judgment endpoint unreachable'); } });
    try {
      await expect(inbox.offer('telegram', 'stop')).rejects.toThrow('judgment endpoint unreachable');
    } finally {
      installJudgmentPort(previous);
    }
    expect(inbox.pending).toBe(1);
  });
});

describe('who may answer over a channel', () => {
  test('the owner on a command-authority channel answers', async () => {
    const inbox = new PaymentReplyInbox();
    const wait = inbox.waitForAnswer({ kind: 'veto', deadlineMs: soon(), channels: ['telegram'], notice: VETO_NOTICE });
    const offer = await tryResolvePaymentReplyFromChannel({ surface: 'telegram', userId: OWNER, text: 'stop' }, decision(), inbox);
    expect(offer.consumed).toBe(true);
    expect((await wait)?.answer).toBe('object');
  });

  test('someone not on the owner allowlist is never read', async () => {
    const inbox = new PaymentReplyInbox();
    void inbox.waitForAnswer({ kind: 'veto', deadlineMs: soon(), channels: ['telegram'], notice: VETO_NOTICE });
    const offer = await tryResolvePaymentReplyFromChannel({ surface: 'telegram', userId: 'stranger', text: 'go ahead' }, decision(), inbox);
    expect(offer.consumed).toBe(false);
    expect(inbox.pending).toBe(1);
    expect(readings.requests).toHaveLength(0);
  });

  test('a channel with no command authority is never read', async () => {
    const inbox = new PaymentReplyInbox();
    void inbox.waitForAnswer({ kind: 'veto', deadlineMs: soon(), channels: ['telegram'], notice: VETO_NOTICE });
    const offer = await tryResolvePaymentReplyFromChannel({ surface: 'slack', userId: OWNER, text: 'go ahead' }, decision(), inbox);
    expect(offer.consumed).toBe(false);
    expect(readings.requests).toHaveLength(0);
  });

  test('the shared ingress hook consumes an answer so it never becomes a chat turn', async () => {
    const inbox = new PaymentReplyInbox();
    const wait = inbox.waitForAnswer({ kind: 'approval', deadlineMs: soon(), channels: ['telegram'], notice: APPROVAL_NOTICE });
    const helper = new DaemonSurfaceActionHelper({
      channelPolicy: { evaluateIngress: async () => decision() },
      configManager: { get: () => undefined, getCategory: () => undefined },
      routeBindings: { getBinding: () => undefined },
      paymentReplies: inbox,
    } as unknown as ConstructorParameters<typeof DaemonSurfaceActionHelper>[0]);
    const result = await helper.authorizeSurfaceIngress({ surface: 'telegram', userId: OWNER, text: 'approve' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('payment-reply-approve');
    expect((await wait)?.answer).toBe('approve');
  });
});
