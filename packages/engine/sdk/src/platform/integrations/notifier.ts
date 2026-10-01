import { NotificationEnvelope, type NotificationPrivacyReader } from '../runtime/notification-envelope.js';
import type { NotificationDelivery } from '../runtime/turn-notification.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { RuntimeEventBus, AgentEvent } from '../runtime/events/index.js';
import type { ContractEvent } from '../../events/contract.js';
import { workstreamLabel } from '../channels/workstream-labels.js';
import { SlackIntegration } from './slack.js';
import { DiscordIntegration } from './discord.js';
import { DeliveryError, DeliveryQueue } from './delivery.js';
import type { DeliveryQueueConfig, IntegrationQueueStatus } from './delivery.js';
import { snapshotQueueStatus } from './delivery.js';
import { ServiceRegistry } from '../config/service-registry.js';
import type { FeatureFlagManager } from '../runtime/feature-flags/index.js';

const NOTIFICATION_EVENT_IDS: ReadonlySet<string> = new Set([
  'AGENT_COMPLETED', 'CONTRACT_PASSED', 'CONTRACT_FAILED', 'CONTRACT_CANCELLED',
]);
function notificationTraceEvent(event: string): string {
  // Queue identifiers/diagnostics may outlive a privacy change. Preserve known
  // runtime event IDs, but do not retain arbitrary legacy event wording there.
  return NOTIFICATION_EVENT_IDS.has(event) ? event : 'notification';
}

// ---------------------------------------------------------------------------
// Notifier
// ---------------------------------------------------------------------------

/**
 * Notifier, unified notification dispatcher.
 *
 * Reads configuration from environment variables:
 *   SLACK_WEBHOOK_URL, SLACK_BOT_TOKEN
 *   DISCORD_WEBHOOK_URL, DISCORD_BOT_TOKEN
 *
 * Attach to the RuntimeEventBus to automatically post notifications for key events.
 */
export class Notifier {
  private slack?: SlackIntegration | undefined;
  private discord?: DiscordIntegration | undefined;
  private unsubscribers: Array<() => void> = [];
  private readonly _queue: DeliveryQueue<NotificationEnvelope | string>;
  private readonly metadataOnly: NotificationPrivacyReader | undefined;
  private _closed = false;
  private _closing: Promise<void> | undefined;
  private readonly _active = new Set<Promise<void>>();

  constructor(options?: {
    slack?: SlackIntegration | undefined;
    discord?: DiscordIntegration | undefined;
    delivery?: Partial<DeliveryQueueConfig> | undefined;
    featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null | undefined;
    metadataOnly?: NotificationPrivacyReader | undefined;
  }) {
    this.metadataOnly = options?.metadataOnly;
    this.slack = options?.slack;
    this.discord = options?.discord;
    this._queue = new DeliveryQueue<NotificationEnvelope | string>({
      ...(options?.delivery ?? {}),
      featureFlags: options?.featureFlags,
      diagnosticMode: 'structural',
    });
  }

  /**
   * Create a Notifier pre-wired from configured services and environment variables.
   */
  static async fromConfig(
    serviceRegistry: Pick<ServiceRegistry, 'resolveSecret'>,
    options: { featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null; metadataOnly?: NotificationPrivacyReader } = {},
  ): Promise<Notifier> {
    const [
      slackWebhookFromService,
      slackTokenFromService,
      discordWebhookFromService,
      discordTokenFromService,
    ] = await Promise.all([
      serviceRegistry.resolveSecret('slack', 'webhookUrl'),
      serviceRegistry.resolveSecret('slack', 'primary'),
      serviceRegistry.resolveSecret('discord', 'webhookUrl'),
      serviceRegistry.resolveSecret('discord', 'primary'),
    ]);

    const slackWebhook = slackWebhookFromService ?? process.env.SLACK_WEBHOOK_URL;
    const slackToken = slackTokenFromService ?? process.env.SLACK_BOT_TOKEN;
    const discordWebhook = discordWebhookFromService ?? process.env.DISCORD_WEBHOOK_URL;
    const discordToken = discordTokenFromService ?? process.env.DISCORD_BOT_TOKEN;

    const slack =
      slackWebhook || slackToken
        ? new SlackIntegration(slackWebhook, slackToken)
        : undefined;

    const discord =
      discordWebhook || discordToken
        ? new DiscordIntegration(discordWebhook, discordToken)
        : undefined;

    return new Notifier({ slack, discord, featureFlags: options.featureFlags, metadataOnly: options.metadataOnly });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Send a notification to all configured channels.
   *
   * @param event  - Human-readable event name (used as message text)
   * @param data   - Arbitrary key/value payload for formatting
   */
  notify(event: string, data: Record<string, unknown>): Promise<void> {
    return this.ownNotification(notificationTraceEvent(event), () => NotificationEnvelope.legacy(() => this.formatText(event, data), this.metadataOnly));
  }

  /** Send owned typed facts, with live privacy checks on every delivery attempt. */
  notifyNotification(delivery: NotificationDelivery): Promise<void> {
    return this.ownNotification('notification', () => NotificationEnvelope.typed(delivery, this.metadataOnly));
  }

  private ownNotification(event: string, create: () => NotificationEnvelope): Promise<void> {
    if (this._closed) return Promise.reject(new DeliveryError('Notifier is closed.', 'terminal'));
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const active = new Promise<void>((ok, no) => { resolve = ok; reject = no; });
    this._active.add(active);
    void active.then(() => this._active.delete(active), () => this._active.delete(active));
    // Capture the immutable snapshot before any asynchronous delivery begins.
    void (async () => { await this.deliverNotification(event, create()); })().then(resolve, reject);
    return active;
  }

  private async deliverNotification(event: string, envelope: NotificationEnvelope): Promise<void> {
    if (this.slack) {
      const slack = this.slack;
      await this._queue.enqueue('slack', event, envelope, () => this.postEnvelope(envelope, (text) => slack.postWebhook(text)));
    }
    if (this.discord) {
      const discord = this.discord;
      await this._queue.enqueue('discord', event, envelope, () => this.postEnvelope(envelope, (text) => discord.postWebhook(text)));
    }
  }

  /**
   * Get delivery queue status snapshots for all active channels.
   * Used by integration diagnostics to surface queue and DLQ state.
   */
  getQueueStatus(): IntegrationQueueStatus[] {
    const sloEnforced = this._queue.sloEnforced;
    const statuses: IntegrationQueueStatus[] = [];
    if (this.slack) {
      statuses.push(snapshotQueueStatus('slack', this._queue, sloEnforced, (payload) => this.queuedEnvelope(payload).describe()));
    }
    if (this.discord) {
      statuses.push(snapshotQueueStatus('discord', this._queue, sloEnforced, (payload) => this.queuedEnvelope(payload).describe()));
    }
    return statuses;
  }

  /**
   * Replay all dead-letter entries to their respective channels.
   * Re-attempts delivery for each DLQ entry; results are returned per-entry.
   */
  async replayDeadLetters(): Promise<Array<{ id: string; outcome: import('./delivery.js').DeliveryOutcome }>> {
    return this._queue.replay(async (dlqEntry) => {
      const envelope = this.queuedEnvelope(dlqEntry.payload);
      if (dlqEntry.channel === 'slack' && this.slack) {
        const slack = this.slack;
        await this.postEnvelope(envelope, (text) => slack.postWebhook(text));
      } else if (dlqEntry.channel === 'discord' && this.discord) {
        const discord = this.discord;
        await this.postEnvelope(envelope, (text) => discord.postWebhook(text));
      } else {
        throw new Error(`No active integration for channel: ${dlqEntry.channel}`);
      }
    });
  }

  private async postEnvelope(envelope: NotificationEnvelope, send: (text: string) => Promise<void>): Promise<void> {
    try { await send(envelope.prepare().text); }
    finally { envelope.refreshPrivacy(); }
  }

  private queuedEnvelope(payload: NotificationEnvelope | string): NotificationEnvelope {
    return payload instanceof NotificationEnvelope ? payload : NotificationEnvelope.restoredLegacy();
  }

  /** Stop subscriptions and admission immediately; use close() to drain deliveries. */
  dispose(): void {
    this._closed = true;
    this.detach();
    this._queue.dispose();
  }

  /** Await every admitted notification and its in-flight delivery before releasing dependencies. */
  close(): Promise<void> {
    this.dispose();
    return this._closing ??= Promise.allSettled([
      this._queue.close(), ...this._active,
    ]).then(() => {});
  }

  attachToRuntimeBus(bus: RuntimeEventBus): void {
    if (this._closed) throw new DeliveryError('Notifier is closed.', 'terminal');
    this.detach();

    this.unsubscribers.push(
      bus.on<Extract<AgentEvent, { type: 'AGENT_COMPLETED' }>>('AGENT_COMPLETED', ({ payload }) => {
        void this.notify('AGENT_COMPLETED', {
          event: 'AGENT_COMPLETED',
          agentId: payload.agentId,
          task: payload.output?.slice(0, 100) ?? payload.agentId,
          result: payload.output,
        }).catch((error: unknown) => {
          logger.warn('[notifier] AGENT_COMPLETED notification failed', { error: summarizeError(error) });
        });
      }),
    );

    this.unsubscribers.push(
      bus.on<Extract<ContractEvent, { type: 'CONTRACT_PASSED' }>>('CONTRACT_PASSED', ({ payload }) => {
        void this.notify('CONTRACT_PASSED', {
          event: 'CONTRACT_PASSED',
          contractId: payload.contractId,
          criteriaMet: payload.criteriaMet,
          criteriaJudged: payload.criteriaJudged,
        }).catch((error: unknown) => {
          logger.warn('[notifier] CONTRACT_PASSED notification failed', { error: summarizeError(error) });
        });
      }),
    );

    this.unsubscribers.push(
      bus.on<Extract<ContractEvent, { type: 'CONTRACT_FAILED' }>>('CONTRACT_FAILED', ({ payload }) => {
        void this.notify('CONTRACT_FAILED', {
          event: 'CONTRACT_FAILED',
          contractId: payload.contractId,
          reason: payload.reason,
        }).catch((error: unknown) => {
          logger.warn('[notifier] CONTRACT_FAILED notification failed', { error: summarizeError(error) });
        });
      }),
    );

    this.unsubscribers.push(
      bus.on<Extract<ContractEvent, { type: 'CONTRACT_CANCELLED' }>>('CONTRACT_CANCELLED', ({ payload }) => {
        void this.notify('CONTRACT_CANCELLED', {
          event: 'CONTRACT_CANCELLED',
          contractId: payload.contractId,
          reason: payload.reason,
        }).catch((error: unknown) => {
          logger.warn('[notifier] CONTRACT_CANCELLED notification failed', { error: summarizeError(error) });
        });
      }),
    );

    logger.info('Notifier: attached to RuntimeEventBus');
  }

  /** Remove all notification subscriptions. */
  detach(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private formatText(event: string, data: Record<string, unknown>): string {
    switch (event) {
      case 'AGENT_COMPLETED': {
        const task = typeof data.task === 'string' ? data.task : String(data.agentId ?? '');
        return `Agent completed: ${task}`;
      }
      // Named in plain words, never by the contract id: a notification is outward-facing text.
      case 'CONTRACT_PASSED': {
        const label = workstreamLabel(String(data.contractId ?? ''));
        const met = typeof data.criteriaMet === 'number' && typeof data.criteriaJudged === 'number'
          ? `: ${data.criteriaMet} of ${data.criteriaJudged} requirements met`
          : '';
        return `${label} is done${met}`;
      }
      case 'CONTRACT_FAILED': {
        const reason = typeof data.reason === 'string' ? data.reason : 'unknown reason';
        return `${workstreamLabel(String(data.contractId ?? ''))} could not be finished: ${reason}`;
      }
      case 'CONTRACT_CANCELLED': {
        const reason = typeof data.reason === 'string' ? data.reason : 'no reason given';
        return `${workstreamLabel(String(data.contractId ?? ''))} was cancelled: ${reason}`;
      }
      default: {
        const extras = Object.entries(data)
          .filter(([k]) => k !== 'event')
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(', ');
        return extras ? `${event}: ${extras}` : event;
      }
    }
  }
}
