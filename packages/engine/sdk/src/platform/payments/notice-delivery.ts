/**
 * notice-delivery.ts, actually sending the notice, and reporting what happened.
 *
 * ══ The gap this closes ═══════════════════════════════════════════════════
 *
 * `message.ts` RENDERS a notice and returns a string. `windows.ts` CONSUMES a
 * delivery report, `{ channel, delivered }` per channel, and decides from it.
 * Between those two sits a send that nothing was performing: the capability
 * would render a notice into nothing, then evaluate a window against a report
 * nobody produced, and a purchase would proceed on a "silence" that was really
 * a message never sent.
 *
 * That is the difference between a policy engine and a capability, and it is
 * this module.
 *
 * ══ Delivered means the router said so ════════════════════════════════════
 *
 * `delivered` is set from the router's actual outcome per channel, never
 * assumed. A strategy that throws, a missing chat id, an expired token, a
 * surface with no binding, produces `delivered: false` for that channel and
 * the window then applies the owner's undeliverable ruling, which is opposite
 * on the two window kinds and is the entire reason this flag has to be true.
 *
 * The failure is recorded per channel rather than collapsed into one boolean,
 * because "Telegram worked and Slack did not" and "nothing worked" are
 * different facts and the second one is the one that changes an outcome.
 *
 * ══ secretsManager is required upstream ═══════════════════════════════════
 *
 * This module takes an already-constructed router. `ChannelDeliveryRouter`
 * throws without `secretsManager` when it builds the default strategies, and
 * that constructor check is load-bearing: every surface whose credential is a
 * `goodvibes://secrets/...` reference fails SILENTLY without it, which is the
 * exact shape of a purchase notice that never arrives while the window records
 * a clean silence. Nothing here weakens or works around that requirement.
 *
 * ══ Escaping ══════════════════════════════════════════════════════════════
 *
 * Every merchant-derived string in a notice has already been through
 * `sanitizeNoticeField`, whose trigger set removes backtick, asterisk,
 * underscore, tilde, pipe, angle brackets, ampersand, SQUARE BRACKETS and
 * PARENTHESES. The last two are what a Discord masked link `[text](url)` is
 * built from, and Discord renders those in bot and webhook messages, so they
 * are stripped at the point the field enters the notice rather than per
 * channel. A per-channel escaper applied afterwards would be a second place for
 * the rule to live and drift; the assertion instead is that nothing
 * markup-shaped survives into the rendered notice at all.
 */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { sanitizeNoticeField } from '../security/notice-text.js';
import { approvalReply, vetoReply } from './batteries/payment-reply.js';
import type { ChannelDelivery } from './windows.js';
import type { PaymentNotifier } from './checkout-flow.js';
import type { CommandAuthorityChannel } from './types.js';

/**
 * One place a payment notice can be sent, already resolved to a routable target.
 *
 * `backfillable` is a property of the CHANNEL, not of this send: it says whether
 * that channel's history can be re-read for a span the daemon was down.
 * `recoverInterruptedWindow` keys on it, so it travels with the delivery.
 */
export interface PaymentNoticeTarget {
  readonly channel: CommandAuthorityChannel;
  /** Whatever the router needs to address this surface. Opaque here. */
  readonly request: unknown;
  readonly backfillable: boolean;
}

/** The narrow slice of `ChannelDeliveryRouter` this needs. */
export interface PaymentNoticeRouter {
  deliver(request: never): Promise<string | undefined>;
}

/**
 * Where an answer comes back from.
 *
 * Separated from delivery because they are genuinely different directions and
 * different infrastructure: a send is a router call, an answer is an inbound
 * message arriving on a channel minutes later. A port keeps the window logic
 * testable without standing up an inbound pipeline.
 */
export interface PaymentReplySource {
  /**
   * Resolve with the first answer that arrives before the deadline, or null.
   *
   * Null must mean SILENCE and nothing else. An implementation that resolved
   * null on its own internal error would convert a failure into "the owner did not
   * object", which on the veto path buys something.
   *
   * `notice` is the message the owner was sent; a reply is read against it.
   */
  waitForAnswer(input: {
    readonly kind: 'approval' | 'veto';
    readonly deadlineMs: number;
    readonly channels: readonly CommandAuthorityChannel[];
    readonly notice: string;
  }): Promise<{
    readonly answer: 'approve' | 'deny' | 'acknowledge' | 'object';
    readonly channel: CommandAuthorityChannel;
  } | null>;
}

export interface ChannelPaymentNotifierDeps {
  readonly router: PaymentNoticeRouter;
  readonly targets: readonly PaymentNoticeTarget[];
  readonly replies: PaymentReplySource;
  /** Called with the reason a channel failed, for the operator log. Never the notice. */
  readonly onDeliveryFailure?: ((input: {
    readonly channel: CommandAuthorityChannel;
    readonly reason: string;
  }) => void) | undefined;
}

/** The decision site the reply readings are logged under. */
export const PAYMENT_REPLY_SITE = 'payments.reply';

export type PaymentAnswer = 'approve' | 'deny' | 'acknowledge' | 'object';

/**
 * Read an inbound reply as an answer to the notice it follows, or as nothing.
 *
 * Read by Jev, once per window kind (`engine.payments.approval-reply`,
 * `engine.payments.veto-reply`), because the same words settle the two
 * windows differently: "go" is an approval on one and an acknowledgement on
 * the other. An answer is taken only when the reading acts; `unclear`, and
 * any reading short of act, is no answer at all, which leaves the window's
 * own silence rule to decide, the rule the owner set.
 */
export async function readPaymentReply(
  reply: string,
  kind: 'approval' | 'veto',
  notice: string,
): Promise<PaymentAnswer | null> {
  if (reply.trim().length === 0) return null;
  const port = judgmentPort(PAYMENT_REPLY_SITE);
  if (kind === 'approval') {
    const read = await approvalReply.read(port, notice, reply, { site: PAYMENT_REPLY_SITE });
    const answer = read.reading.outcome === 'act' && read.reading.choice !== 'unclear' ? read.reading.choice : null;
    read.recordAction(answer ?? 'no answer');
    return answer;
  }
  const read = await vetoReply.read(port, notice, reply, { site: PAYMENT_REPLY_SITE });
  const answer = read.reading.outcome === 'act' && read.reading.choice !== 'unclear' ? read.reading.choice : null;
  read.recordAction(answer ?? 'no answer');
  return answer;
}

/**
 * A notifier that really sends, over the same router that carries every other
 * channel message.
 *
 * One send per configured channel, all of them for the same notice, and the
 * report says per channel what happened. There is no retry: a purchase notice
 * that failed to send is information the window needs NOW, and a retry loop
 * would push the decision past the point where the total is still valid.
 */
export function createChannelPaymentNotifier(deps: ChannelPaymentNotifierDeps): PaymentNotifier {
  // The last notice of each window kind, which a reply is read against.
  const notices: { approval: string; veto: string } = { approval: '', veto: '' };
  return {
    async deliver(input): Promise<readonly ChannelDelivery[]> {
      const current = () => { input.signal?.throwIfAborted(); input.assertCurrent?.(); };
      current();
      if (input.kind !== 'notice') notices[input.kind] = input.message;
      const deliveries: ChannelDelivery[] = [];
      for (const target of deps.targets) {
        current();
        let delivered = false;
        try {
          // The router's request shape belongs to the channels layer; this
          // module carries it through untouched rather than reconstructing it,
          // so a change there does not silently reshape a payment notice.
          const request = { ...(target.request as Record<string, unknown>), content: input.message, assertCurrent: input.assertCurrent, signal: input.signal };
          await deps.router.deliver(request as never);
          current();
          delivered = true;
        } catch (error) {
          current();
          // The notice itself never enters the log line. It contains the
          // merchant, the item and the total, and an operator log is a wider
          // read path than the channel the notice was meant for.
          deps.onDeliveryFailure?.({
            channel: target.channel,
            reason: input.assertCurrent || input.signal ? 'The guarded purchase notice could not be delivered.' : sanitizeNoticeField(error instanceof Error ? error.message : 'unknown error', 200),
          });
        }
        deliveries.push({
          channel: target.channel,
          delivered,
          backfillable: target.backfillable,
        });
      }
      current();
      return deliveries;
    },

    async awaitAnswer(input) {
      const channels = deps.targets.map((target) => target.channel);
      return deps.replies.waitForAnswer({
        kind: input.kind,
        deadlineMs: input.deadlineMs,
        channels,
        notice: notices[input.kind],
      });
    },
  };
}
