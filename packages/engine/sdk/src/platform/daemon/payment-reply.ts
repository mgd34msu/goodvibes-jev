/**
 * Channel-reply resolution of pending purchase windows.
 *
 * A purchase notice goes out over the owner's command channels
 * (`payments.notifyChannels`), and the owner answers it on the same channel.
 * This hangs off the shared ingress hook (`authorizeSurfaceIngress`) beside
 * the work-proposal and permission-ask replies, so every surface adapter gets
 * it without per-adapter wiring.
 *
 * Who may answer is decided in code, before anything is read: the sender must
 * be on the channel policy's owner allowlist, as for permission asks, and the
 * surface must be a command-authority channel (types.ts). What the reply
 * says is the payment reply inbox's Jev reading (payments/reply-inbox.ts).
 */
import type { ChannelIngressPolicyInput, ChannelPolicyDecision } from '../channels/index.js';
import type { PaymentReplyInbox, PaymentReplyOffer } from '../payments/reply-inbox.js';
import { parseCommandAuthorityChannel } from '../payments/types.js';
import { logger } from '../utils/logger.js';

/**
 * Offer an inbound message to the purchase windows waiting on its channel.
 * Returns the offer's outcome; `consumed: true` means the message answered a
 * window and must not become a chat turn.
 */
export async function tryResolvePaymentReplyFromChannel(
  input: ChannelIngressPolicyInput,
  decision: ChannelPolicyDecision,
  inbox: PaymentReplyInbox | undefined,
): Promise<PaymentReplyOffer> {
  if (inbox === undefined || inbox.pending === 0 || !input.userId || !input.text) return { consumed: false, reason: 'no-window' };
  const owners = decision.matchedGroupPolicy?.allowlistUserIds ?? decision.policy.allowlistUserIds;
  if (owners.length === 0 || !owners.includes(input.userId)) return { consumed: false, reason: 'no-window' };
  const channel = parseCommandAuthorityChannel(input.surface);
  if (channel === null) return { consumed: false, reason: 'no-window' };
  const offer = await inbox.offer(channel, input.text);
  if (offer.consumed) {
    logger.info('Purchase window answered from a channel reply', { surface: input.surface, answer: offer.answer });
  } else if (offer.reason === 'several-windows') {
    logger.info('Channel reply not read as a purchase answer: several purchase windows wait on this channel', { surface: input.surface });
  }
  return offer;
}
