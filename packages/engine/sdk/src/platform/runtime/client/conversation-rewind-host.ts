/**
 * conversation-rewind-host.ts, a surface answering the daemon's questions
 * about a conversation only it is holding.
 *
 * ── What was broken ───────────────────────────────────────────────────────
 *
 * Files rewind works from anywhere, because the workspace checkpoint store is
 * the daemon's. The conversation half is answerable only by the process running
 * the loop, and once the surfaces became pure clients that process is not the
 * daemon. The daemon's in-process conversation registry, which nothing outside
 * the daemon could populate, answered "0 messages to drop" for every session
 * hosted elsewhere: a confident answer to a question it could not reach.
 *
 * This module is the other end of the fix. The surface OFFERS the conversation
 * it is running; the daemon then asks that surface when a rewind touches it.
 *
 * ── Why a poll, and why it is not a poll ──────────────────────────────────
 *
 * This is a reverse call: the daemon asking a connected client and awaiting an
 * answer while a `rewind.plan` call waits on it. The delivery is a `take` that
 * the surface holds open, a long poll, not a tight loop. With nothing waiting
 * the call parks for up to the daemon's own ceiling and returns empty; with
 * work waiting it returns immediately. So the steady state is one open request,
 * not repeated requests, and an answer starts moving the instant the question
 * is raised.
 *
 * The same call renews the lease. A surface that is polling is a surface that
 * is alive, so there is no separate keepalive to get out of step with it, and
 * a crashed surface simply stops being consulted when its lease lapses, with
 * nobody cleaning up after it.
 *
 * ── Answering honestly ────────────────────────────────────────────────────
 *
 * A question about a session this process is NOT holding is answered
 * `unavailable` with the reason, never zero. That distinction is the whole
 * point: a real zero and an unreachable conversation look identical as numbers,
 * and reporting the second as the first is what made the old behaviour a lie
 * rather than a gap.
 *
 * Every failure path resolves. A request that throws while being answered is
 * answered `unavailable` with the error text rather than left to time out, so
 * the waiting `rewind.plan` gets a reason instead of a stall.
 */
import { logger, summarizeError } from '../../utils/index.js';
import type { RewindAnchor, RewindConversationPort } from '../../rewind/types.js';
import type { DaemonVerbCaller } from './daemon-verbs.js';

/** How long a `take` is held open. Under the daemon's 25s ceiling by design. */
const DEFAULT_WAIT_MS = 20_000;
/** How long to wait before retrying after a transport failure. */
const RETRY_BACKOFF_MS = 3_000;

/** One question, as the wire delivers it. */
interface HostRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly kind: 'preview' | 'rewind';
  readonly expiresAt: number;
}

export interface ConversationRewindHostOptions {
  readonly verbs: DaemonVerbCaller;
  /** The port that answers, this process's own conversations, by session id. */
  readonly port: RewindConversationPort;
  /** Whether this process is actually holding that session's conversation. */
  readonly hosts: (sessionId: string) => boolean;
  /** How this surface names itself in the refusals a person reads. */
  readonly label?: string;
  readonly waitMs?: number;
  readonly retryBackoffMs?: number;
  readonly log?: Pick<typeof logger, 'debug' | 'info' | 'warn'>;
  /** Injectable sleep (tests). */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ConversationRewindHostClient {
  /**
   * Name the session whose conversation this surface is holding, without
   * starting the polling loop. The registration itself happens on the first
   * `pump`, so a caller that wants to drive the cycles deterministically, a
   * test, or a one-shot check, uses `offer` + `pump` and never has two takes
   * racing on one host id.
   */
  offer(sessionId: string): void;
  /** `offer`, plus the loop that keeps taking questions. Idempotent per session. */
  start(sessionId: string): void;
  /** Withdraw the offer and stop. Idempotent; safe to call with nothing running. */
  stop(): Promise<void>;
  /** The host id the daemon issued, once registered. Null before that. */
  hostId(): string | null;
  /** One take-and-answer cycle: register if needed, take, answer each question. */
  pump(): Promise<number>;
}

export function createConversationRewindHost(options: ConversationRewindHostOptions): ConversationRewindHostClient {
  const log = options.log ?? logger;
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const backoffMs = options.retryBackoffMs ?? RETRY_BACKOFF_MS;
  interface Offer {
    readonly sessionId: string;
    readonly predecessor: Promise<void> | undefined;
    readonly retired: Promise<void>;
    readonly retire: () => void;
    hostId: string | null;
    stopped: boolean;
    running: boolean;
    registration: Promise<string | null> | undefined;
    pump: Promise<number> | undefined;
    loop: Promise<void> | undefined;
    closing: Promise<void> | undefined;
    cancelBackoff: (() => void) | undefined;
  }

  let current: Offer | undefined;
  let lastClosing: Promise<void> | undefined;
  const idle = Promise.resolve();
  const isCurrent = (offer: Offer): boolean => current === offer && !offer.stopped;

  const register = (offer: Offer): Promise<string | null> => {
    if (offer.registration) return offer.registration;
    const pending = Promise.resolve().then(async () => {
      // A late old registration could otherwise claim the same session after
      // its successor. Release the predecessor before making the new claim.
      await offer.predecessor;
      if (!isCurrent(offer)) return null;
      try {
        const result = await options.verbs.invoke<{ host?: { hostId?: string } }>(
          'rewind.conversation.host.register',
          { sessionId: offer.sessionId, label: options.label ?? 'a connected surface' },
        );
        const hostId = result?.host?.hostId ?? null;
        // Keep the actual issued id even after retirement: close must release
        // that registration, but it must never become the successor's id.
        offer.hostId = hostId;
        if (hostId && isCurrent(offer)) {
          log.info(`[rewind] offered this session's conversation to the daemon (host ${hostId})`);
        }
        return hostId;
      } catch (error) {
        if (isCurrent(offer)) {
          log.debug('[rewind] offering this conversation to the daemon failed', { error: summarizeError(error) });
        }
        return null;
      }
    });
    offer.registration = pending;
    const clear = () => { if (offer.registration === pending) offer.registration = undefined; };
    void pending.then(clear, clear);
    return pending;
  };

  const answerFor = async (offer: Offer, request: HostRequest): Promise<Record<string, unknown> | undefined> => {
    if (!isCurrent(offer)) return undefined;
    const hosted = options.hosts(request.sessionId);
    if (!isCurrent(offer)) return undefined;
    if (!hosted) {
      return {
        unavailableReason: `this surface is no longer holding the conversation for session ${request.sessionId}`,
      };
    }
    const anchor: RewindAnchor = { sessionId: request.sessionId, turnId: request.turnId ?? undefined };
    if (request.kind === 'preview') {
      const preview = await options.port.preview(anchor);
      if (!isCurrent(offer)) return undefined;
      return { messagesToDrop: preview.messagesToDrop, messagesRemaining: preview.messagesRemaining };
    }
    const outcome = await options.port.rewind(anchor);
    if (!isCurrent(offer)) return undefined;
    return { droppedMessages: outcome.droppedMessages, undoSnapshotId: outcome.undoSnapshotId };
  };

  const answer = async (offer: Offer, hostId: string, request: HostRequest): Promise<void> => {
    let payload: Record<string, unknown> | undefined;
    try {
      payload = await answerFor(offer, request);
    } catch (error) {
      if (!isCurrent(offer)) return;
      payload = { unavailableReason: `the surface hosting this conversation could not answer: ${summarizeError(error)}` };
    }
    if (!isCurrent(offer) || !payload) return;
    try {
      await options.verbs.invoke('rewind.conversation.requests.answer', {
        hostId, requestId: request.requestId, ...payload,
      });
    } catch (error) {
      if (isCurrent(offer)) {
        log.debug('[rewind] the daemon would not accept this answer', {
          requestId: request.requestId, error: summarizeError(error),
        });
      }
    }
  };

  const pumpOffer = async (offer: Offer): Promise<number> => {
    if (!isCurrent(offer)) return 0;
    if (!offer.hostId) {
      await register(offer);
      if (!isCurrent(offer) || !offer.hostId) return 0;
    }
    const hostId = offer.hostId;
    let taken: { requests?: readonly HostRequest[] } | null = null;
    try {
      taken = await options.verbs.invoke<{ requests?: readonly HostRequest[] }>(
        'rewind.conversation.requests.take',
        { hostId, waitMs },
      );
    } catch (error) {
      // Releasing our own host wakes its pending take with host-unknown. That
      // retired cycle owes no retry or new semantic error/redaction reading.
      if (isCurrent(offer)) {
        offer.hostId = null;
        log.debug('[rewind] taking conversation-rewind questions failed; will re-offer', {
          error: summarizeError(error),
        });
      }
      return 0;
    }
    if (!isCurrent(offer)) return 0;
    const requests = taken?.requests ?? [];
    for (const request of requests) {
      if (!isCurrent(offer)) break;
      await answer(offer, hostId, request);
    }
    return isCurrent(offer) ? requests.length : 0;
  };

  const pump = (offer: Offer): Promise<number> => {
    if (offer.pump) return offer.pump;
    const pending = Promise.resolve().then(() => pumpOffer(offer));
    offer.pump = pending;
    const clear = () => { if (offer.pump === pending) offer.pump = undefined; };
    void pending.then(clear, clear);
    return pending;
  };

  const backoff = async (offer: Offer): Promise<void> => {
    if (!isCurrent(offer) || !offer.running) return;
    if (options.sleep) {
      await Promise.race([options.sleep(backoffMs), offer.retired]);
      return;
    }
    await new Promise<void>(resolve => {
      const finish = () => {
        clearTimeout(timer);
        if (offer.cancelBackoff === finish) offer.cancelBackoff = undefined;
        resolve();
      };
      const timer = setTimeout(finish, backoffMs);
      timer.unref?.();
      offer.cancelBackoff = finish;
    });
  };

  const run = async (offer: Offer): Promise<void> => {
    while (isCurrent(offer) && offer.running) {
      const handled = await pump(offer);
      if (!isCurrent(offer) || !offer.running) return;
      if (!offer.hostId || (handled === 0 && waitMs === 0)) await backoff(offer);
    }
  };

  const close = (offer: Offer): Promise<void> => {
    if (offer.closing) return offer.closing;
    offer.stopped = true;
    offer.running = false;
    if (current === offer) current = undefined;
    offer.retire();
    offer.cancelBackoff?.();
    // Retire synchronously; drain each promise captured by this exact offer.
    const pendingPump = offer.pump;
    const pendingLoop = offer.loop;
    offer.closing = Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      try {
        await offer.predecessor;
        await offer.registration;
        const hostId = offer.hostId;
        offer.hostId = null;
        if (hostId) {
          try {
            await options.verbs.invoke('rewind.conversation.host.release', { sessionId: offer.sessionId, hostId });
            log.info('[rewind] withdrew this session\'s conversation from the daemon');
          } catch {
            // Cleanup remains observable without reading retired private error
            // text. A lapsed registration already has the desired end state.
            log.debug('[rewind] releasing the conversation host was not acknowledged');
          }
        }
      } catch (error) { failures.push(error); }
      const outcomes = await Promise.allSettled([pendingPump, pendingLoop]);
      for (const outcome of outcomes) if (outcome.status === 'rejected') failures.push(outcome.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Conversation rewind host cleanup failed');
    });
    // Session changes initiate cleanup synchronously without an awaiting caller.
    // The original rejection remains observable through the retained close.
    void offer.closing.catch(() => {});
    lastClosing = offer.closing;
    return offer.closing;
  };

  const offer = (sessionId: string): Offer | undefined => {
    if (!sessionId) return undefined;
    if (current?.sessionId === sessionId) return current;
    if (current) close(current);
    let retire!: () => void;
    const retired = new Promise<void>(resolve => { retire = resolve; });
    current = {
      sessionId, predecessor: lastClosing, retired, retire,
      hostId: null, stopped: false, running: false,
      registration: undefined, pump: undefined, loop: undefined,
      closing: undefined, cancelBackoff: undefined,
    };
    return current;
  };

  return {
    offer(sessionId): void { offer(sessionId); },

    start(sessionId): void {
      const offered = offer(sessionId);
      if (!offered || offered.running) return;
      offered.running = true;
      offered.loop = run(offered).catch(error => {
        if (!isCurrent(offered)) return;
        offered.running = false;
        log.warn('[rewind] the conversation-host loop stopped', { error: summarizeError(error) });
      });
    },

    stop(): Promise<void> { return current ? close(current) : lastClosing ?? idle; },
    hostId: () => current?.hostId ?? null,
    pump: () => current ? pump(current) : Promise.resolve(0),
  };
}
