/**
 * notification-dispatch.ts, how this daemon dispatches notices without a screen.
 *
 * The SDK's NotificationRouter decides where a domain notification goes and
 * collapses bursts and batches. Its three targets, `conversation`,
 * `status_bar`, `panel_only`, are all SCREEN targets: an inline conversation
 * line, a status bar, a panel. There is no channel member in that type, and
 * there never was. Which means the router is a surface mechanism end to end,
 * and this process has no screen.
 *
 * This module used to wire the router to every curated domain anyway, writing
 * into a bounded ring whose `list()` had no caller anywhere in this repository.
 * Six domains of events, for the daemon's whole lifetime, into a buffer nobody
 * read, and the type declaring it still described the ring as "the panel's
 * live producer", for a product with no panels. That silent-success failure
 * class is exactly what this module removes: the producer goes.
 *
 * What a headless process CAN do with a notice is send it, and the daemon
 * already does that on the paths that are genuinely channel-shaped: automation
 * failure notices through the delivery manager, occasion nudges through the
 * channel delivery router, and the WebhookNotifier attached to the runtime bus
 * at boot for agent and workflow outcomes.
 *
 * One notice had no such path: memory pressure. The MemoryGovernor measures the
 * process it runs in, so the daemon's pressure is the daemon's own and no
 * surface can report it, and the daemon that ran out of memory is exactly the
 * one that cannot tell you afterwards. It now goes out over the operator's
 * configured notice destination (`notifications.webhookUrls`, the same list the
 * bus bridge uses), and says so at its own level in the activity log when no
 * destination is configured. Sent, or written down; never dropped.
 */

import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { RuntimeEventBus } from './index.js';
import { memoryPressureLine, memoryPressureLevel, type MemoryPressurePayload } from '@goodvibes-jev/engine/sdk/platform/runtime/memory';

/**
 * Where a channel-shaped notice leaves the daemon.
 *
 * The WebhookNotifier's own shape, narrowed to the two members this needs, so a
 * test can drive it without an HTTP client and so the composition can pass the
 * one instance the notification verbs and the bus bridge already share.
 */
export interface DaemonNoticeChannel {
  isConfigured(): boolean;
  send(text: string): Promise<unknown>;
}

/**
 * Send the daemon's own memory-pressure notice to the operator's configured
 * notice destination. Returns an unsubscribe function.
 *
 * The MemoryGovernor emits OPS_MEMORY_PRESSURE on the 'ops' domain when the
 * pressure tier changes or the leak tripwire fires. That domain also carries
 * high-churn audit and metric events, which is why this is a targeted bridge on
 * one event type rather than a subscription to the domain: the tier change is
 * the operator's business and the churn is not.
 *
 * Delivery failure is logged, never thrown, a webhook endpoint being down is
 * not a reason for the process reporting memory pressure to also crash.
 */
export function wireMemoryPressureChannelNotice(
  runtimeBus: RuntimeEventBus,
  channel: DaemonNoticeChannel,
): () => void {
  return runtimeBus.onDomain('ops', (envelope) => {
    if (envelope.type !== 'OPS_MEMORY_PRESSURE') return;
    const payload = envelope.payload as MemoryPressurePayload;
    const level = memoryPressureLevel(payload);
    const line = memoryPressureLine(payload);
    if (!channel.isConfigured()) {
      // No destination configured. The notice still exists, at its own
      // severity, where the operator looks when the daemon misbehaves.
      if (level === 'critical') logger.error(line);
      else if (level === 'warning') logger.warn(line);
      else logger.info(line);
      return;
    }
    void Promise.resolve(channel.send(line)).catch((error: unknown) => {
      logger.warn('Memory pressure notice could not be delivered', {
        error: error instanceof Error ? error.message : String(error),
        notice: line,
      });
    });
  });
}
