/**
 * notifier.ts, sending a purchase notice over the daemon's channels and
 * hearing the owner's answer.
 *
 * `createChannelPaymentNotifier` (payments/notice-delivery.ts) wants a router,
 * a target per configured channel, and a `PaymentReplySource`.
 * `payments.notifyChannels` names which `CommandAuthorityChannel`s to notify,
 * and delivery goes out over the daemon's own `ChannelDeliveryRouter`, the
 * same router every other channel send uses.
 *
 * The reply source is the daemon's `PaymentReplyInbox`
 * (payments/reply-inbox.ts), which the shared channel ingress hook feeds with
 * the owner's inbound messages (daemon/payment-reply.ts). A reply is read by
 * Jev against the notice it follows; an answer settles the window before its
 * deadline, and anything else leaves the window to its own silence rule
 * (payments/windows.ts): an approval window's silence denies and a veto
 * window's silence proceeds.
 */
import type { ChannelDeliveryRouter, ChannelDeliveryTarget } from '../../channels/index.js';
import { createChannelPaymentNotifier } from '../notice-delivery.js';
import type { PaymentNoticeRouter, PaymentNoticeTarget, PaymentReplySource } from '../notice-delivery.js';
import type { PaymentNotifier } from '../payment-ports.js';
import { readNotifyChannels, type PaymentsConfigReader } from '../payments-config.js';
import { parseCommandAuthorityChannel } from '../types.js';
import { logger } from '../../utils/logger.js';

const PAYMENTS_NOTICE_JOB_ID = 'payments-notice';

/**
 * The channel name (`payments.notifyChannels` entry) turned into the router's
 * own addressing shape. This mirrors `parseChannelDeliveryTarget`'s `surface`
 * construction for the plain channel names `readNotifyChannels` produces (no
 * `kind:address` suffix, `CommandAuthorityChannel` carries none).
 */
function surfaceTarget(surfaceKind: string): ChannelDeliveryTarget {
  return { kind: 'surface', surfaceKind: surfaceKind as ChannelDeliveryTarget['surfaceKind'] };
}

/** Adapts the daemon's router to the notifier's narrow, opaque-`request` shape. */
function daemonNoticeRouter(router: Pick<ChannelDeliveryRouter, 'deliver'>): PaymentNoticeRouter {
  return {
    deliver: async (request) => {
      const merged = request as unknown as Record<string, unknown> & { readonly content: string };
      return router.deliver({
        target: merged['target'] as ChannelDeliveryTarget,
        body: merged.content,
        title: 'Purchase',
        jobId: PAYMENTS_NOTICE_JOB_ID,
        runId: `${PAYMENTS_NOTICE_JOB_ID}-${String(Date.now())}`,
        includeLinks: false,
        assertCurrent: merged['assertCurrent'] as (() => void) | undefined,
        signal: merged['signal'] as AbortSignal | undefined,
      });
    },
  };
}

export function channelBackedPaymentNotifier(
  config: PaymentsConfigReader,
  router: Pick<ChannelDeliveryRouter, 'deliver'>,
  replies: PaymentReplySource,
): PaymentNotifier {
  const targets: PaymentNoticeTarget[] = [];
  for (const name of readNotifyChannels(config)) {
    const channel = parseCommandAuthorityChannel(name);
    if (channel === null) {
      logger.warn('payments.notifyChannels names a channel this daemon does not recognise; it will not be notified', { channel: name });
      continue;
    }
    targets.push({
      channel,
      request: { target: surfaceTarget(name) },
      // No backfill path exists: a notice missed while the daemon was down
      // cannot be recovered by re-reading history this router never kept.
      backfillable: false,
    });
  }

  return createChannelPaymentNotifier({
    router: daemonNoticeRouter(router),
    targets,
    replies,
    onDeliveryFailure: ({ channel, reason }) => {
      logger.warn('A payments notice could not be delivered on a configured channel', { channel, reason });
    },
  });
}
