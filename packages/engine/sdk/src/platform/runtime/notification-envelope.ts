import { readNotificationsMetadataOnly } from './notification-privacy.js';
import { notificationTool, notificationCategory, notificationSubject, notificationNumber } from './notification-metadata.js';
import {
  buildApprovalNotification, buildBudgetNotification, buildTurnNotification, formatWebhookText,
  type NotificationDelivery,
} from './turn-notification.js';

/** A live host preference. Only literal false authorizes content. */
export type NotificationPrivacyReader = () => unknown;

const GENERIC_NOTIFICATION = 'GoodVibes: notification available';
type OwnedDelivery = NotificationDelivery | { readonly kind: 'legacy'; readonly text?: string } | { readonly kind: 'probe' };

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
/** Explicitly copy only the typed fields; no caller-owned object is retained. */
function snapshot(delivery: NotificationDelivery, restricted: boolean): NotificationDelivery {
  try {
    switch (delivery.kind) {
      case 'turn': {
        const facts = delivery.facts;
        const outcome = facts.outcome;
        if (outcome !== 'completed' && outcome !== 'failed' && outcome !== 'cancelled') throw new TypeError();
        const reviewScore = facts.reviewScore;
        return Object.freeze({ kind: 'turn', facts: Object.freeze({
          outcome, elapsedMs: notificationNumber(facts.elapsedMs),
          toolCalls: count(facts.toolCalls), filesChanged: count(facts.filesChanged), agentsStarted: count(facts.agentsStarted),
          reviewScore: typeof reviewScore === 'number' && Number.isFinite(reviewScore) && reviewScore >= 0 && reviewScore <= 10 ? reviewScore : undefined,
          subject: restricted ? notificationSubject(facts.subject) : optionalString(facts.subject),
          ...(restricted ? {} : { name: optionalString(facts.name), reason: optionalString(facts.reason) }),
        }) });
      }
      case 'approval': {
        const facts = delivery.facts;
        const rawTool = facts.tool;
        const rawCategory = facts.category;
        if (typeof rawTool !== 'string' || typeof rawCategory !== 'string') throw new TypeError();
        // Rendering uses the closed tool/category vocabulary. Unknown identifiers
        // are content too, so restricted admission must erase them, not just hide them.
        const tool = notificationTool(rawTool) ?? '';
        const category = notificationCategory(rawCategory) ?? '';
        return Object.freeze({ kind: 'approval', facts: Object.freeze({
          tool: restricted ? tool : rawTool, category: restricted ? category : rawCategory,
          ...(restricted ? {} : { target: optionalString(facts.target), turnName: optionalString(facts.turnName) }),
        }) });
      }
      case 'budget': {
        const facts = delivery.facts;
        return Object.freeze({ kind: 'budget', facts: Object.freeze({
          sessionCostUsd: notificationNumber(facts.sessionCostUsd), budgetUsd: notificationNumber(facts.budgetUsd),
          // No generated-ID provenance is present in this contract. The builders
          // retain the source-compatible field but never disclose it.
          sessionId: '',
          ...(restricted ? {} : { turnName: optionalString(facts.turnName) }),
        }) });
      }
      default: throw new TypeError();
    }
  } catch {
    // Bad accessors and malformed facts must not echo their private values.
    throw new TypeError('Invalid notification facts');
  }
}

/**
 * Internal delivery owner. Facts are immutable snapshots; the only state
 * transition replaces them with a permanently restricted snapshot. Shared by
 * every recipient, retry and dead-letter replay of the admitted notification.
 * Private fields keep JSON/diagnostic inspection from exposing rich facts.
 */
export class NotificationEnvelope {
  #delivery: OwnedDelivery;
  #restricted: boolean;
  #revision = 0;
  readonly #privacy: NotificationPrivacyReader | undefined;

  private constructor(delivery: OwnedDelivery, restricted: boolean, privacy?: NotificationPrivacyReader) {
    this.#delivery = delivery;
    this.#restricted = restricted;
    this.#privacy = privacy;
  }

  static typed(delivery: NotificationDelivery, privacy?: NotificationPrivacyReader): NotificationEnvelope {
    const restricted = readNotificationsMetadataOnly(() => privacy?.());
    return new NotificationEnvelope(snapshot(delivery, restricted), restricted, privacy);
  }

  static legacy(textOrRead: string | (() => string), privacy?: NotificationPrivacyReader): NotificationEnvelope {
    const restricted = readNotificationsMetadataOnly(() => privacy?.());
    // A legacy event formatter runs synchronously only after admission permits
    // content. The formatter itself is never retained by a queue or recipient.
    let text: string | undefined;
    try { text = restricted ? undefined : typeof textOrRead === 'function' ? textOrRead() : textOrRead; }
    catch { throw new TypeError('Invalid notification text'); }
    if (!restricted && typeof text !== 'string') throw new TypeError('Invalid notification text');
    return new NotificationEnvelope(Object.freeze({ kind: 'legacy', ...(typeof text === 'string' ? { text } : {}) }), restricted, privacy);
  }

  /** A fixed, code-owned connectivity probe contains no caller data. */
  static probe(): NotificationEnvelope {
    return new NotificationEnvelope(Object.freeze({ kind: 'probe' }), true);
  }

  /** Old queue strings lack admission provenance; never reconstruct rich facts. */
  static restoredLegacy(): NotificationEnvelope {
    return new NotificationEnvelope(Object.freeze({ kind: 'legacy' }), true);
  }

  private refresh(): void {
    const nowRestricted = readNotificationsMetadataOnly(() => this.#privacy?.());
    if (!nowRestricted || this.#restricted) return;
    this.#delivery = this.#delivery.kind === 'legacy' ? Object.freeze({ kind: 'legacy' })
      : this.#delivery.kind === 'probe' ? this.#delivery : snapshot(this.#delivery, true);
    this.#restricted = true;
    this.#revision += 1;
  }

  /** Observe a stricter preference after an awaited transport, even on failure. */
  refreshPrivacy(): void { this.refresh(); }

  prepare(): { readonly text: string; readonly revision: number } {
    this.refresh();
    return { text: this.render(this.#restricted), revision: this.#revision };
  }

  /** Recheck after an awaited signing step, including another recipient's downgrade. */
  isCurrent(revision: number): boolean {
    this.refresh();
    return revision === this.#revision;
  }

  /** Diagnostics always use the restricted projection and do not change delivery state. */
  describe(): string { return this.render(true); }
  toJSON(): string { return this.describe(); }

  private render(metadataOnly: boolean): string {
    const value = this.#delivery;
    switch (value.kind) {
      case 'turn': return formatWebhookText(buildTurnNotification(value.facts, { metadataOnly }));
      case 'approval': return formatWebhookText(buildApprovalNotification(value.facts, { metadataOnly }));
      case 'budget': return formatWebhookText(buildBudgetNotification(value.facts, { metadataOnly }));
      case 'legacy': return metadataOnly ? GENERIC_NOTIFICATION : value.text ?? GENERIC_NOTIFICATION;
      case 'probe': return 'goodvibes-sdk: webhook test';
    }
  }
}
