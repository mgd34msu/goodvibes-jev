// ---------------------------------------------------------------------------
// Inbound provider poller.
//
// Runs one setInterval per provider at the provider's own cadence (Slack/
// Discord 30s, email 60s, others 120s). Each tick:
//   1. resolves the provider's persisted cursor (nextSince)
//   2. calls adapter.poll({ since, limit })
//   3. dedups + persists items into the cursor store (upsert)
//   4. advances the cursor monotonically to max(receivedAt)
//   5. records the last per-provider state for channels.inbox.list to report
//
// One bad provider can never crash the loop: adapter.poll() resolves with
// state:'unavailable' instead of rejecting, and any thrown error is caught and
// downgraded to an 'unavailable' status here.
// ---------------------------------------------------------------------------

import type { InboundProviderAdapter, ProviderState } from './provider-adapter.js';
import type { InboxCursorStore } from './cursor-store.js';
import type { IntakeLogger as HandlerLogger } from './context.js';
import { summarizeError } from '../utils/error-display.js';

export interface ProviderStatus {
  id: string;
  state: ProviderState;
  /** NEW items the last poll persisted. Not the provider's stored total. */
  itemCount: number;
  error?: string;
  lastPolledAt?: number;
  mailboxProgress?: { readonly uidValidity: number; readonly pendingMessages: number };
  /**
   * Whether the provider's credentials resolved on the last poll, as the
   * adapter reported it. Absent until a poll has happened (or when the
   * credential store itself failed and the adapter could not find out).
   */
  configured?: boolean;
  /**
   * True once this provider has completed at least one poll on this node.
   *
   * A never-polled provider and a polled-and-empty one both hold zero items,
   * and `channels.inbox.list` must not present the first as the second: on a
   * node that is not the elected fetcher for an account, "we have not looked"
   * is the whole truth and "there is nothing" would be a fabrication.
   */
  polled: boolean;
}

export interface PollerOptions {
  adapters: Map<string, InboundProviderAdapter>;
  store: InboxCursorStore;
  logger: HandlerLogger;
  /** Max items fetched per provider per tick. */
  perProviderLimit?: number;
  /** Inject a timer factory for tests (defaults to global setInterval). */
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
}

const DEFAULT_PER_PROVIDER_LIMIT = 50;

export class InboundPoller {
  private readonly adapters: Map<string, InboundProviderAdapter>;
  private readonly store: InboxCursorStore;
  private readonly logger: HandlerLogger;
  private readonly perProviderLimit: number;
  private readonly setIntervalImpl: typeof setInterval;
  private readonly clearIntervalImpl: typeof clearInterval;
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly statuses = new Map<string, ProviderStatus>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly generations = new Map<string, number>();
  private readonly paused = new Set<string>();
  private stopping: Promise<void> | null = null;
  private started = false;
  /**
   * Set by stop(), which the surface teardown calls and nothing else, unlike
   * stopProvider(), which a leadership handover uses and which must stay
   * resumable. Once the surface is released no interval may be armed again,
   * including by work that was already in flight: registerInboxMethods() starts
   * the store bootstrap without awaiting it, so a teardown during that window
   * would otherwise be followed by a start() that nothing is left to undo.
   */
  private released = false;

  constructor(options: PollerOptions) {
    this.adapters = new Map(options.adapters);
    this.store = options.store;
    this.logger = options.logger;
    this.perProviderLimit = options.perProviderLimit ?? DEFAULT_PER_PROVIDER_LIMIT;
    this.setIntervalImpl = options.setIntervalImpl ?? setInterval;
    this.clearIntervalImpl = options.clearIntervalImpl ?? clearInterval;
    for (const id of this.adapters.keys()) {
      // `polled: false` until a poll actually completes, see ProviderStatus.
      this.statuses.set(id, { id, state: 'empty', itemCount: 0, polled: false });
    }
  }

  /** Begin per-provider interval loops. Idempotent. Does NOT poll immediately. */
  start(): void {
    if (this.released || this.started) return;
    this.started = true;
    for (const id of this.adapters.keys()) this.startProvider(id);
  }

  /**
   * Begin ONE provider's interval loop. Idempotent.
   *
   * Each inbox account is its own surface in the LAN election, so the machine
   * that reads the work Slack account may not be the machine that reads the
   * mailbox. A blanket start/stop cannot express that: it would take every
   * account down to hand one of them over. Everything below is therefore
   * addressable per provider, and the blanket calls are fan-outs over it.
   */
  startProvider(id: string): void {
    if (this.released || this.timers.has(id)) return;
    const adapter = this.adapters.get(id);
    if (!adapter) return;
    this.paused.delete(id);
    const generation = this.generations.get(id) ?? 0;
    const handle = this.setIntervalImpl(() => {
      // A queued callback belongs to the interval that created it, even when
      // this provider has since been explicitly restarted.
      if ((this.generations.get(id) ?? 0) !== generation) return;
      void this.pollProvider(id, adapter);
    }, adapter.pollIntervalMs);
    // Do not keep the event loop alive solely for polling (Bun/Node unref).
    (handle as unknown as { unref?: () => void }).unref?.();
    this.timers.set(id, handle);
  }

  /**
   * Stop one provider generation and await its actual fetch/persistence work.
   * Leadership owners MUST await this before handing consumption to another
   * node. Abort is cooperative; adapters that ignore it are still drained.
   * startProvider may explicitly resume this provider after the stop.
   */
  stopProvider(id: string): Promise<void> {
    this.paused.add(id);
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    this.controllers.get(id)?.abort();
    if (this.adapters.get(id)?.checkpointKind === 'imap-uid') {
      const previous = this.statuses.get(id);
      if (previous) {
        const { mailboxProgress: _progress, ...status } = previous;
        this.statuses.set(id, { ...status, state: 'unavailable', error: 'Email inbox polling is paused; pending message count is unknown' });
      }
    }
    const handle = this.timers.get(id);
    if (handle !== undefined) {
      this.timers.delete(id);
      try { this.clearIntervalImpl(handle); }
      catch { this.warn('inbound poll timer cleanup failed', { provider: id }); }
    }
    if (this.timers.size === 0) this.started = false;
    return this.pending.get(id) ?? Promise.resolve();
  }

  /** True when this node is polling the given provider right now. */
  isProviderRunning(id: string): boolean {
    return this.timers.has(id);
  }

  /** Every provider this node has an adapter for. */
  providerIds(): string[] {
    return [...this.adapters.keys()];
  }

  /** Run a single poll across all providers now (used on register + tests). */
  async pollOnce(): Promise<void> {
    await Promise.all(
      [...this.adapters.entries()].map(([id, adapter]) => this.pollProvider(id, adapter)),
    );
  }

  /** Run a single poll for ONE provider now. Never throws. */
  async pollProviderOnce(id: string): Promise<void> {
    const adapter = this.adapters.get(id);
    if (!adapter) return;
    await this.pollProvider(id, adapter);
  }

  /** Poll once, sharing any active operation for this provider. Never throws. */
  pollProvider(id: string, adapter: InboundProviderAdapter): Promise<void> {
    if (this.released || this.paused.has(id)) return Promise.resolve();
    const existing = this.pending.get(id);
    if (existing) return existing;
    const controller = new AbortController();
    const generation = this.generations.get(id) ?? 0;
    const pending = Promise.resolve().then(() => this.performPoll(id, adapter, controller, generation));
    this.pending.set(id, pending);
    this.controllers.set(id, controller);
    const finish = () => {
      if (this.pending.get(id) === pending) {
        this.pending.delete(id);
        this.controllers.delete(id);
      }
    };
    void pending.then(finish, finish);
    return pending;
  }

  private async performPoll(id: string, adapter: InboundProviderAdapter, controller: AbortController, generation: number): Promise<void> {
    const current = () => !this.released && !this.paused.has(id)
      && !controller.signal.aborted && (this.generations.get(id) ?? 0) === generation;
    if (!current()) return;
    let configured: boolean | undefined;
    try {
      const usesImapCheckpoint = adapter.checkpointKind === 'imap-uid';
      const assertAdapterCurrent = adapter.assertCurrent;
      if (usesImapCheckpoint && typeof assertAdapterCurrent !== 'function') {
        throw new Error('IMAP inbox adapter requires a trusted synchronous currentness fence');
      }
      const assertCommitCurrent = (): void => {
        if (!current()) throw new Error('Inbound poll is no longer current');
        // HandlerSqliteStore rejects any non-void/async result from this fence.
        const result = assertAdapterCurrent!.call(adapter);
        if (!current()) throw new Error('Inbound poll is no longer current');
        return result;
      };
      const checkpoint = usesImapCheckpoint ? this.store.getImapCheckpoint(id) : null;
      const since = usesImapCheckpoint ? undefined : this.store.getCursor(id) || undefined;
      const result = await adapter.poll({ ...(since === undefined ? {} : { since }),
        ...(checkpoint === null ? {} : { checkpoint }), limit: this.perProviderLimit, signal: controller.signal });
      if (!current()) return;
      configured = result.configured;
      if (result.pendingMessages !== undefined && (!usesImapCheckpoint || !result.checkpointAdvance
        || !Number.isSafeInteger(result.pendingMessages) || result.pendingMessages < 0)) throw new Error('Invalid IMAP pending message count');
      const progress = result.pendingMessages === undefined ? {} : { mailboxProgress: {
        uidValidity: result.checkpointAdvance!.next.uidValidity, pendingMessages: result.pendingMessages } };
      if (result.checkpointAdvance && !usesImapCheckpoint) throw new Error('Timestamp adapter cannot propose UID progress');
      if (result.state === 'unavailable' || result.state === 'pending') {
        // Pin the first history window before attempting content on a later
        // cadence. Failed content never advances a terminal watermark.
        if (result.checkpointAdvance) {
          if (result.checkpointAdvance.transition === 'advance') throw new Error('Unavailable IMAP poll cannot advance UID progress');
          await this.store.commitImapPoll(id, result.items, result.checkpointAdvance, assertCommitCurrent);
          if (!current()) return;
        }
        this.setStatus(id, {
          id,
          state: result.state,
          ...progress,
          itemCount: 0,
          ...(result.state === 'unavailable' ? { error: result.error ?? 'provider unavailable' } : {}),
          lastPolledAt: Date.now(),
          ...(result.configured === undefined ? {} : { configured: result.configured }),
          polled: true,
        });
        return;
      }
      let newCount: number;
      if (usesImapCheckpoint) {
        if (!result.checkpointAdvance && result.items.length > 0) throw new Error('IMAP inbox rows require terminal UID coverage');
        newCount = result.checkpointAdvance
          ? await this.store.commitImapPoll(id, result.items, result.checkpointAdvance, assertCommitCurrent)
          : 0;
      } else {
        newCount = this.store.upsertItems(result.items);
        let maxReceived = since ?? 0;
        for (const item of result.items) {
          if (item.receivedAt > maxReceived) maxReceived = item.receivedAt;
        }
        if (maxReceived > 0) this.store.advanceCursor(id, maxReceived);
        await this.store.flush();
      }
      if (!current()) return;
      this.setStatus(id, {
        id,
        state: result.items.length > 0 ? 'ready' : 'empty',
        ...progress,
        itemCount: newCount,
        lastPolledAt: Date.now(),
        ...(result.configured === undefined ? {} : { configured: result.configured }),
        polled: true,
      });
    } catch (error) {
      if (!current()) return;
      let message = 'inbound provider poll failed';
      try { message = summarizeError(error); } catch {}
      this.warn('inbound poll failed', { provider: id, error: message });
      // Only the adapter can report whether credentials resolved. Calling it,
      // or seeing it throw, is not evidence of configuration. Preserve a known
      // result when persistence failed, otherwise leave configuration unknown.
      this.setStatus(id, {
        id,
        state: 'unavailable',
        itemCount: 0,
        error: message,
        lastPolledAt: Date.now(),
        ...(configured === undefined ? {} : { configured }),
        polled: true,
      });
    }
  }

  /** Snapshot of the last known status for each provider. */
  snapshotStatuses(providerIds?: readonly string[]): ProviderStatus[] {
    const ids = providerIds && providerIds.length > 0
      ? providerIds.filter((id) => this.statuses.has(id))
      : [...this.statuses.keys()];
    return ids.map((id) => {
      const status = this.statuses.get(id)!;
      return { ...status };
    });
  }

  /**
   * Release permanently. Synchronous callers stop admission immediately;
   * shutdown owners must await the result before closing the shared store.
   * Idempotent and non-rejecting, including ignored legacy sync calls.
   */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.released = true;
    this.stopping = Promise.resolve().then(async () => {
      await Promise.allSettled([...this.pending.values()]);
    });
    for (const id of new Set([...this.adapters.keys(), ...this.pending.keys(), ...this.timers.keys()])) void this.stopProvider(id);
    this.started = false;
    return this.stopping;
  }

  private warn(message: string, meta: unknown): void {
    try { this.logger.warn(message, meta); } catch {}
  }

  private setStatus(id: string, status: ProviderStatus): void {
    this.statuses.set(id, status);
  }
}
