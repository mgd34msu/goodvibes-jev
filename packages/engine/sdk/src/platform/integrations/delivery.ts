import { logger } from '../utils/logger.js';
import { randomInt, randomUUID } from 'node:crypto';
import {
  categoryForCode,
  GoodVibesSdkError,
  readFailure,
  RETRYABLE_STATUS_CODES,
  type FailureCategory,
  type FailureConclusions,
  type FailureEvidence,
} from '@goodvibes-jev/engine/errors';
import type { FeatureFlagManager } from '../runtime/feature-flags/index.js';
import type { ConfigManager } from '../config/manager.js';

import { summarizeError } from '../utils/error-display.js';

// ---------------------------------------------------------------------------
// Delivery outcome taxonomy
// ---------------------------------------------------------------------------

/**
 * The three possible outcomes for a single integration delivery attempt.
 *
 * - `delivered`  , message reached the destination successfully
 * - `retrying`   , delivery failed with a retryable error; queued for retry
 * - `dead_letter`, all retry attempts exhausted or terminal failure; moved to DLQ
 */
export type DeliveryOutcome = 'delivered' | 'retrying' | 'dead_letter';

/**
 * Classification of a delivery failure.
 *
 * - `retryable`, transient error; should be retried with backoff
 *   (network timeout, HTTP 429, HTTP 5xx)
 * - `terminal` , permanent error; should not be retried
 *   (HTTP 400/401/403/404, invalid URL, message too large)
 */
export type DeliveryFailureClass = 'retryable' | 'terminal';

// ---------------------------------------------------------------------------
// Failure transience
// ---------------------------------------------------------------------------

/** HTTP status codes that indicate a retryable transient failure. */
const DELIVERY_RETRYABLE_STATUSES: ReadonlySet<number> = new Set(RETRYABLE_STATUS_CODES);

/** Error class names that only a timeout or an abort produces (AbortSignal.timeout, fetch aborts). */
const TIMEOUT_ERROR_NAMES: ReadonlySet<string> = new Set(['TimeoutError', 'AbortError']);

/**
 * What a transience decision rested on: an explicit classification the error
 * carries, a structured fact (a Retry-After, an HTTP status, an errno code, a
 * timeout error class), Jev's reading of the wording, or no wording at all.
 */
export type TransienceBasis = 'explicit' | 'retry-after' | 'status' | 'errno' | 'error-type' | 'reading' | 'no-wording';

/** Whether a failure is worth another attempt, and why. */
export interface FailureTransience {
  readonly failureClass: DeliveryFailureClass;
  readonly basis: TransienceBasis;
  /** The fact or reading behind the decision, for logs and the decision trail. */
  readonly detail: string;
}

/**
 * The reading's categories, split by whether sending the same thing again
 * could succeed. The rest ('unknown') leave the wording unsettled.
 */
const TRANSIENT_CATEGORIES: ReadonlySet<FailureCategory> = new Set(['rate_limit', 'timeout', 'network', 'service', 'protocol']);
const PERMANENT_CATEGORIES: ReadonlySet<FailureCategory> = new Set(['authentication', 'authorization', 'billing', 'not_found', 'bad_request']);

function numberField(value: object, key: string): number | undefined {
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

/** The HTTP status an error carries as a field (`status`, or `statusCode` as AppError and DeliveryError name it). */
function httpStatusOf(error: object): number | undefined {
  for (const key of ['status', 'statusCode']) {
    const status = numberField(error, key);
    if (status !== undefined && status >= 100 && status <= 599) return status;
  }
  return undefined;
}

/**
 * The transience a failure's structure fixes on its own, or undefined when
 * only its wording can say. Order: an explicit DeliveryError class; an
 * explicit Retry-After (a server naming when to come back, which also covers
 * a 403 secondary rate limit); the HTTP status against the retryable-status
 * table; an errno code (on the error or its cause) that names a connection
 * fault or timeout; a timeout or abort error class.
 */
export function structuredTransience(error: unknown): FailureTransience | undefined {
  if (error instanceof DeliveryError) {
    return { failureClass: error.failureClass, basis: 'explicit', detail: `DeliveryError marked ${error.failureClass}` };
  }
  if (!error || typeof error !== 'object') return undefined;
  const retryAfterMs = numberField(error, 'retryAfterMs');
  if (retryAfterMs !== undefined && retryAfterMs >= 0) {
    return { failureClass: 'retryable', basis: 'retry-after', detail: `server asked for a retry after ${retryAfterMs}ms` };
  }
  const status = httpStatusOf(error);
  if (status !== undefined) {
    const failureClass = DELIVERY_RETRYABLE_STATUSES.has(status) ? 'retryable' : 'terminal';
    return { failureClass, basis: 'status', detail: `HTTP ${status}` };
  }
  const cause = (error as { readonly cause?: unknown }).cause;
  for (const code of [stringField(error, 'code'), stringField(cause, 'code')]) {
    const category = categoryForCode(code);
    if (category !== undefined) return { failureClass: 'retryable', basis: 'errno', detail: `${code} (${category})` };
  }
  const name = stringField(error, 'name');
  if (name !== undefined && TIMEOUT_ERROR_NAMES.has(name)) {
    return { failureClass: 'retryable', basis: 'error-type', detail: name };
  }
  return undefined;
}

/** The wording a reading is given: the error's message, and its cause's when it has one. */
function failureWording(error: unknown): FailureEvidence {
  if (error instanceof Error) {
    const causeMessage = error.cause instanceof Error ? error.cause.message : stringField(error.cause, 'message');
    const message = causeMessage !== undefined && causeMessage !== error.message
      ? `${error.message}\nCaused by: ${causeMessage}`
      : error.message;
    return { message, code: stringField(error, 'code') ?? stringField(error.cause, 'code'), errorName: error.name };
  }
  return { message: typeof error === 'string' ? error : summarizeError(error) };
}

/**
 * Composes the failure reading into a transience decision. A spent account is
 * permanent even when it arrives as a rate limit; a transient network fault
 * is worth another attempt; otherwise the category decides. A reading that
 * settles nothing is retried: the attempt budget bounds it and the failure
 * stays observable, where a dead-letter would drop it silently.
 */
export function transienceFromReading(failure: FailureConclusions): FailureTransience {
  const basis = 'reading';
  if (failure.billing) return { failureClass: 'terminal', basis, detail: 'the account cannot pay for the request' };
  if (failure.transientNetwork) return { failureClass: 'retryable', basis, detail: 'a transient network fault' };
  if (PERMANENT_CATEGORIES.has(failure.category)) return { failureClass: 'terminal', basis, detail: `read as ${failure.category}` };
  if (TRANSIENT_CATEGORIES.has(failure.category)) return { failureClass: 'retryable', basis, detail: `read as ${failure.category}` };
  if (failure.rateLimited) return { failureClass: 'retryable', basis, detail: 'a rate limit' };
  return { failureClass: 'retryable', basis, detail: 'the wording does not settle it' };
}

/**
 * Decides whether a failure is worth another attempt: structure first
 * ({@link structuredTransience}), then one Jev reading of the wording through
 * the engine failure battery (`readFailure`, memoized per wording). Used
 * before every retry, cooldown or dead-letter in the integration delivery
 * queue and in automation. A failure with no wording at all is retried, as a
 * reading that settles nothing is. Throws when a reading is needed and none
 * can be made; there is no pattern-list fallback.
 */
export async function readFailureTransience(error: unknown, site: string): Promise<FailureTransience> {
  const structured = structuredTransience(error);
  if (structured !== undefined) return structured;
  const evidence = failureWording(error);
  if (evidence.message.trim().length === 0) {
    return { failureClass: 'retryable', basis: 'no-wording', detail: 'the failure carries no wording' };
  }
  return transienceFromReading(await readFailure(evidence, site));
}

/** Classifies a delivery error as retryable or terminal (see {@link readFailureTransience}). */
export async function classifyDeliveryError(error: unknown, site = 'integrations.delivery.transience'): Promise<DeliveryFailureClass> {
  return (await readFailureTransience(error, site)).failureClass;
}

// ---------------------------------------------------------------------------
// DeliveryError, typed error with explicit classification
// ---------------------------------------------------------------------------

/** Typed delivery error that carries an explicit failure classification. */
export class DeliveryError extends GoodVibesSdkError {
  declare readonly code: 'DELIVERY_ERROR';
  constructor(
    message: string,
    public readonly failureClass: DeliveryFailureClass,
    public readonly statusCode?: number,
  ) {
    super(message, { code: 'DELIVERY_ERROR', category: 'internal', source: 'runtime', recoverable: false });
    this.name = 'DeliveryError';
  }
}

// ---------------------------------------------------------------------------
// Dead-letter entry
// ---------------------------------------------------------------------------

/**
 * A single entry in the dead-letter queue.
 * Immutable snapshot of a delivery that exhausted all retry attempts.
 */
export interface DeadLetterEntry {
  /** Unique entry identifier. */
  readonly id: string;
  /** Integration channel (e.g. "slack", "discord", "webhook"). */
  readonly channel: string;
  /** Event name that triggered the delivery. */
  readonly event: string;
  /** Message payload that failed to deliver. */
  readonly payload: string;
  /** Epoch ms when the entry was created (first attempt). */
  readonly createdAt: number;
  /** Epoch ms when the entry moved to the DLQ. */
  readonly deadAt: number;
  /** Number of delivery attempts made. */
  readonly attempts: number;
  /** Final error message. */
  readonly finalError: string;
  /** Failure class of the final error. */
  readonly failureClass: DeliveryFailureClass;
}

// ---------------------------------------------------------------------------
// Delivery metrics
// ---------------------------------------------------------------------------

/** Counters for delivery SLO tracking. */
export interface DeliveryMetrics {
  /** Total delivery attempts (all channels combined). */
  readonly totalAttempts: number;
  /** Successfully delivered messages. */
  readonly delivered: number;
  /** Messages currently queued for retry. */
  readonly retrying: number;
  /** Messages moved to the dead-letter queue. */
  readonly deadLettered: number;
  /** Total entries in the DLQ (including previously replayed). */
  readonly dlqSize: number;
}

// ---------------------------------------------------------------------------
// Queue configuration
// ---------------------------------------------------------------------------

/** Configuration for the DeliveryQueue. */
export interface DeliveryQueueConfig {
  /**
   * Maximum retry attempts after the initial delivery attempt.
   * E.g., maxRetries: 3 means 4 total attempts (1 initial + 3 retries).
   */
  maxRetries: number;
  /** Initial backoff delay in ms (default: 1000). */
  initialDelayMs: number;
  /** Maximum backoff delay in ms (default: 30_000). */
  maxDelayMs: number;
  /** Maximum dead-letter queue size; oldest entries evicted when exceeded (default: 500). */
  maxDlqSize: number;
  /**
   * When true, SLO enforcement is active: dead-letter events are logged at
   * error level and metrics are updated. When false, failures are logged at
   * warn level only.
   *
   * Controlled by the integrations.delivery.sloEnforced setting (the `integration-delivery-slo` gate).
   */
  sloEnforced: boolean;
}

export interface DeliveryQueueOptions extends Partial<DeliveryQueueConfig> {
  readonly featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null | undefined;
  /**
   * Optional config source. When supplied, retry/backoff/DLQ/SLO defaults are read
   * from integrations.delivery.*, explicit option fields still override, and the
   * gate remains the fallback source for sloEnforced.
   */
  readonly configManager?: Pick<ConfigManager, 'get'> | null | undefined;
}

const DEFAULT_CONFIG: DeliveryQueueConfig = {
  maxRetries: 3,
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxDlqSize: 500,
  sloEnforced: false,
};

/** Read integration delivery defaults from config, or {} when no config source. */
function readDeliveryConfig(
  configManager?: Pick<ConfigManager, 'get'> | null | undefined,
): Partial<DeliveryQueueConfig> {
  if (!configManager) return {};
  return {
    maxRetries: configManager.get('integrations.delivery.maxRetries'),
    initialDelayMs: configManager.get('integrations.delivery.initialDelayMs'),
    maxDelayMs: configManager.get('integrations.delivery.maxDelayMs'),
    maxDlqSize: configManager.get('integrations.delivery.maxDlqSize'),
    sloEnforced: configManager.get('integrations.delivery.sloEnforced'),
  };
}

interface PendingEntry {
  id: string;
  channel: string;
  event: string;
  payload: string;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  deliver: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// DeliveryQueue
// ---------------------------------------------------------------------------

/**
 * Delivery queue with retry/backoff and dead-letter storage.
 *
 * Wrap any integration send operation with `enqueue()`. The queue:
 *  1. Attempts delivery immediately.
 *  2. On failure, decides whether it is transient ({@link readFailureTransience}:
 *     structured facts first, then Jev's reading of the wording).
 *  3. On retryable failure: schedules retry with exponential backoff + jitter.
 *  4. On terminal failure or exhausted retries: moves entry to DLQ.
 *  5. Emits `delivery:dead_letter` events to registered listeners.
 *
 * Dead-letter entries can be replayed via `replay()` or cleared with `clearDlq()`.
 *
 * Enable SLO enforcement via the integrations.delivery.sloEnforced setting to
 * surface dead-letter failures as error-level log entries and expose them in
 * integration diagnostics.
 */
export class DeliveryQueue {
  private readonly _config: DeliveryQueueConfig;
  private readonly _dlq: DeadLetterEntry[] = [];
  private readonly _pending = new Map<string, PendingEntry>();
  private readonly _timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly _listeners = new Set<(entry: DeadLetterEntry) => void>();

  // Metrics counters
  private _totalAttempts = 0;
  private _delivered = 0;
  private _retrying = 0;
  private _deadLettered = 0;

  constructor(config: DeliveryQueueOptions = {}) {
    const { featureFlags, configManager, ...queueConfig } = config;
    const fromConfig = readDeliveryConfig(configManager);
    this._config = {
      ...DEFAULT_CONFIG,
      ...fromConfig,
      ...queueConfig,
      sloEnforced: queueConfig.sloEnforced
        ?? fromConfig.sloEnforced
        ?? featureFlags?.isEnabled('integration-delivery-slo')
        ?? DEFAULT_CONFIG.sloEnforced,
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Enqueue a delivery attempt.
   *
   * @param channel - Integration channel identifier (e.g. "slack").
   * @param event   - Event name for tracing.
   * @param payload - Message text to deliver.
   * @param deliver - Async function that performs the actual delivery.
   * @returns The delivery outcome for the immediate attempt.
   */
  async enqueue(
    channel: string,
    event: string,
    payload: string,
    deliver: () => Promise<void>,
  ): Promise<DeliveryOutcome> {
    const id = `${channel}:${event}:${Date.now()}:${randomUUID().slice(0, 8)}`;
    const entry: PendingEntry = {
      id,
      channel,
      event,
      payload,
      createdAt: Date.now(),
      attempts: 0,
      nextAttemptAt: 0,
      deliver,
    };
    this._pending.set(id, entry);
    return this._attempt(entry);
  }

  /**
   * Replay all dead-letter entries.
   *
   * Each entry is re-enqueued with a fresh retry budget. The DLQ is cleared
   * on a per-entry basis as each replayed entry resolves.
   *
   * @param deliver - Optional delivery function override. When omitted,
   *   the original delivery function is not available (DLQ is persistent
   *   storage), so a no-op is used and the caller must provide one.
   *
   * @returns Array of per-entry replay results.
   */
  async replay(
    deliver: (entry: DeadLetterEntry) => Promise<void>,
  ): Promise<Array<{ id: string; outcome: DeliveryOutcome }>> {
    const entries = [...this._dlq];
    const results: Array<{ id: string; outcome: DeliveryOutcome }> = [];

    for (const dlqEntry of entries) {
      // Remove from DLQ before replaying
      const idx = this._dlq.findIndex((e) => e.id === dlqEntry.id);
      if (idx !== -1) this._dlq.splice(idx, 1);
      this._deadLettered = Math.max(0, this._deadLettered - 1);

      const outcome = await this.enqueue(
        dlqEntry.channel,
        dlqEntry.event,
        dlqEntry.payload,
        () => deliver(dlqEntry),
      );
      results.push({ id: dlqEntry.id, outcome });
    }

    return results;
  }

  /**
   * Register a listener invoked whenever an entry moves to the DLQ.
   * Returns an unsubscribe function.
   */
  onDeadLetter(listener: (entry: DeadLetterEntry) => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /** Get current dead-letter queue contents (snapshot). */
  getDlq(): readonly DeadLetterEntry[] {
    return [...this._dlq];
  }

  /** Clear all dead-letter entries. */
  clearDlq(): number {
    const count = this._dlq.length;
    this._dlq.length = 0;
    return count;
  }

  /** Whether SLO enforcement is active for this queue. */
  get sloEnforced(): boolean { return this._config.sloEnforced; }

  /** Current delivery metrics snapshot. */
  getMetrics(): DeliveryMetrics {
    return {
      totalAttempts: this._totalAttempts,
      delivered: this._delivered,
      retrying: this._retrying,
      deadLettered: this._deadLettered,
      dlqSize: this._dlq.length,
    };
  }

  /**
   * Cancel all pending retry timers and clear internal state.
   * Call on shutdown to prevent timer leaks.
   */
  dispose(): void {
    for (const timer of this._timers.values()) {
      clearTimeout(timer);
    }
    this._timers.clear();
    this._pending.clear();
  }

  private async _attempt(entry: PendingEntry): Promise<DeliveryOutcome> {
    entry.attempts += 1;
    this._totalAttempts += 1;

    try {
      await entry.deliver();
      this._delivered += 1;
      this._pending.delete(entry.id);
      logger.debug('DeliveryQueue: delivered', {
        channel: entry.channel,
        event: entry.event,
        attempts: entry.attempts,
      });
      return 'delivered';
    } catch (err: unknown) {
      const errorMsg = summarizeError(err);
      let transience: FailureTransience;
      try {
        transience = await readFailureTransience(err, 'integrations.delivery.queue');
      } catch (readError: unknown) {
        this._pending.delete(entry.id);
        throw new AggregateError(
          [err, readError],
          `DeliveryQueue: ${entry.channel} delivery failed and whether to retry it could not be read (${summarizeError(readError)})`,
        );
      }
      const { failureClass } = transience;

      if (failureClass === 'terminal' || entry.attempts > this._config.maxRetries) {
        return this._moveToDlq(entry, errorMsg, transience);
      }

      // Schedule retry
      const delayMs = this._computeDelay(entry.attempts);
      entry.nextAttemptAt = Date.now() + delayMs;
      this._retrying += 1;

      logger.warn('DeliveryQueue: retrying', {
        channel: entry.channel,
        event: entry.event,
        attempt: entry.attempts,
        maxRetries: this._config.maxRetries,
        delayMs,
        error: errorMsg,
        failureClass,
        basis: transience.basis,
        reason: transience.detail,
      });

      const timer = setTimeout(() => {
        this._timers.delete(entry.id);
        this._retrying = Math.max(0, this._retrying - 1);
        void this._attempt(entry).catch((error: unknown) => {
          logger.warn('DeliveryQueue: retry attempt could not be settled', {
            channel: entry.channel,
            event: entry.event,
            error: summarizeError(error),
          });
        });
      }, delayMs);
      timer.unref?.();
      this._timers.set(entry.id, timer);

      return 'retrying';
    }
  }

  private _moveToDlq(
    entry: PendingEntry,
    finalError: string,
    transience: FailureTransience,
  ): DeliveryOutcome {
    const { failureClass } = transience;
    const dlqEntry: DeadLetterEntry = {
      id: entry.id,
      channel: entry.channel,
      event: entry.event,
      payload: entry.payload,
      createdAt: entry.createdAt,
      deadAt: Date.now(),
      attempts: entry.attempts,
      finalError,
      failureClass,
    };

    // Bounded DLQ: evict oldest entry when limit exceeded
    if (this._dlq.length >= this._config.maxDlqSize) {
      this._dlq.shift();
      this._deadLettered = Math.max(0, this._deadLettered - 1);
    }

    this._dlq.push(dlqEntry);
    this._deadLettered += 1;
    this._pending.delete(entry.id);

    if (this._config.sloEnforced) {
      logger.error('DeliveryQueue: dead-lettered (SLO violated)', {
        id: dlqEntry.id,
        channel: dlqEntry.channel,
        event: dlqEntry.event,
        attempts: dlqEntry.attempts,
        finalError: dlqEntry.finalError,
        failureClass: dlqEntry.failureClass,
        basis: transience.basis,
        reason: transience.detail,
      });
    } else {
      logger.warn('DeliveryQueue: dead-lettered', {
        id: dlqEntry.id,
        channel: dlqEntry.channel,
        event: dlqEntry.event,
        attempts: dlqEntry.attempts,
        finalError: dlqEntry.finalError,
        failureClass: dlqEntry.failureClass,
        basis: transience.basis,
        reason: transience.detail,
      });
    }

    for (const listener of this._listeners) {
      try {
        listener(dlqEntry);
      } catch (err) {
        logger.warn('[delivery] listener error:', {
          error: summarizeError(err),
          entryId: dlqEntry.id,
        });
      }
    }

    return 'dead_letter';
  }

  private _computeDelay(attempt: number): number {
    const exponential = this._config.initialDelayMs * Math.pow(2, attempt - 1);
    const jitter = randomInt(0, Math.max(1, Math.floor(this._config.initialDelayMs * 0.5) + 1));
    return Math.min(exponential + jitter, this._config.maxDelayMs);
  }
}

// ---------------------------------------------------------------------------
// Integration diagnostics queue status
// ---------------------------------------------------------------------------

/**
 * Snapshot of a DeliveryQueue for display in integration diagnostics.
 */
export interface IntegrationQueueStatus {
  /** Integration channel identifier. */
  readonly channel: string;
  /** Current delivery metrics. */
  readonly metrics: DeliveryMetrics;
  /** Dead-letter entries (most recent first, capped at 50 for display). */
  readonly dlqEntries: readonly DeadLetterEntry[];
  /** Whether SLO enforcement is active. */
  readonly sloEnforced: boolean;
  /** Epoch ms of this snapshot. */
  readonly capturedAt: number;
}

/**
 * Produce a diagnostics snapshot for a channel's DeliveryQueue.
 */
export function snapshotQueueStatus(
  channel: string,
  queue: DeliveryQueue,
  sloEnforced: boolean,
): IntegrationQueueStatus {
  const dlq = queue.getDlq();
  return {
    channel,
    metrics: queue.getMetrics(),
    dlqEntries: [...dlq].reverse().slice(0, 50),
    sloEnforced,
    capturedAt: Date.now(),
  };
}
