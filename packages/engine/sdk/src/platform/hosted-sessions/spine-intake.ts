import { captureJudgmentFailure } from '../gate/failure-input.js';
import { judgmentPort, readFailureTransience, type FailureReadOptions } from '@goodvibes-jev/engine/errors';
/**
 * spine-intake.ts, how a hosted session reaches the SHARED session spine, and
 * how a steer reaches a hosted turn.
 *
 * Two jobs, together because they are the same relationship seen from both
 * ends.
 *
 * REGISTRATION puts a hosted session in `sessions.list` beside every other
 * kind, so a client that lists sessions sees the ones the daemon is running
 * rather than only the ones its own process started.
 *
 * INTAKE is what makes `sessions.steer` and `sessions.followUp` actually drive
 * a hosted turn without a parallel verb family. The broker routes a steer at a
 * session with a live SURFACE participant to that surface to collect; for a
 * hosted session, this engine is the surface. So it collects the queued inputs
 * and hands each to the loop, the same contract `createWireSessionDispatch`
 * implements for a client across the wire, with the one difference that this
 * one shares a process with the broker.
 *
 * The heartbeat is not decoration. A steer goes to a live surface participant
 * when there is one and spawns a background AGENT when there is not, so a
 * hosted session whose participant went stale would quietly stop receiving its
 * own steers and start getting agents instead, the conversation would keep
 * answering, from the wrong thing.
 */

import { hostedLifecycleCallbacks } from './lifecycle-callbacks.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { HostedSessionRecord } from './types.js';

/**
 * The narrow view of the shared session broker hosted sessions use.
 *
 * Registration is what puts a hosted session in `sessions.list` beside every
 * other kind. The input methods are what make `sessions.steer` and
 * `sessions.followUp` DRIVE one: a steer at a session with a live surface
 * participant is queued FOR that surface to collect, and for a hosted session
 * this engine is the surface. Collecting and delivering those queued inputs is
 * the same contract `createWireSessionDispatch` implements for a client on the
 * other side of the wire, the difference is only that this one is in the same
 * process as the broker.
 */
export interface HostedSessionSpine {
  register(input: {
    readonly sessionId: string;
    readonly kind: 'hosted';
    readonly project?: string | undefined;
    readonly title?: string | undefined;
    readonly participant: {
      readonly surfaceKind: 'service';
      readonly surfaceId: string;
      readonly lastSeenAt: number;
    };
  }): Promise<unknown>;
  closeSession(sessionId: string): Promise<unknown>;
  /** Inputs waiting for this surface to collect. */
  getInputsSince(
    sessionId: string,
    options: { readonly state?: 'queued' | undefined },
  ): readonly { readonly id: string; readonly body: string; readonly state?: string | undefined; readonly metadata?: Record<string, unknown> | undefined; readonly correlationId?: string | undefined }[];
  /** Report one collected (`consumed:false`) or finished (`consumed:true`). */
  markInputDelivered(
    sessionId: string,
    inputId: string,
    options?: { readonly consumed?: boolean | undefined },
  ): Promise<unknown>;
  /**
   * Report one this surface collected and could not act on, with the reason.
   *
   * Optional so a stand-in spine in a test need not implement it; a spine
   * without it leaves the record collected-but-unfinished, which is still
   * honest, what must never happen is marking it consumed.
   */
  failInput?(sessionId: string, inputId: string, error: string): Promise<unknown>;
}

/** What the intake needs from the engine that owns the sessions. */
export interface HostedSessionSpineIntakeOptions {
  readonly spine?: HostedSessionSpine | undefined;
  /** Captured composition owner for failure readings; no ambient port changes during retry. */
  readonly failureReading?: FailureReadOptions | undefined;
  /** Non-terminated hosted sessions, read fresh on every tick. */
  readonly liveSessions: () => readonly HostedSessionRecord[];
  /** Attribute awaited registration/close callbacks to their session owner. */
  readonly withLifecycle?: <T>(sessionId: string, callback: () => Promise<T>) => Promise<T>;
  /** Hand one collected input to its session's loop. */
  readonly deliver: (sessionId: string, text: string, correlationId?: string | undefined) => Promise<void>;
  readonly now: () => number;
  /** Tick interval. Default 750ms, the order every inbound-dispatch client here uses. */
  readonly intervalMs?: number | undefined;
  /** Delivery attempts one collected input gets before it is failed. Default 3. */
  readonly maxDeliveryAttempts?: number | undefined;
  /**
   * Put one line in front of the owner over a channel that still works.
   * Omitted ⇒ an undeliverable message is logged and recorded on the spine but
   * nobody is told, which is the state a survive-detach session must not be in.
   */
  readonly alertOwner?: ((text: string) => void) | undefined;
}

const DEFAULT_INTAKE_INTERVAL_MS = 750;
const HOSTED_PARTICIPANT_SURFACE_ID = 'daemon:hosted-sessions';

/**
 * How many ticks one collected input is given before it is failed.
 *
 * Small on purpose. The failures worth retrying here are the transient ones,
 * a restored session's loop still being composed, a floor lease still being
 * acquired, and those clear within a tick or two. Anything that survives
 * the bounded attempt ceiling is failed observably rather than kept in limbo.
 * The shared failure reader, not this count, determines retry eligibility.
 */
const DEFAULT_MAX_DELIVERY_ATTEMPTS = 3;

/** One collected input still owed to a session's loop. */
interface PendingDelivery {
  readonly sessionId: string;
  readonly inputId: string;
  readonly body: string;
  /** The broker's input identity, retained through queued delivery and retry. */
  readonly correlationId?: string | undefined;
  readonly attempts: number;
  readonly failure?: { readonly error: unknown; readonly detail: string; readonly blocked?: boolean; readonly reading?: FailureReadOptions } | undefined;
}

/**
 * One session's deliveries, in order, and the task draining them.
 *
 * A lane per session keeps ordering where ordering is owed, a session's own
 * steer and the follow-up meant to come after it stay serial, while leaving
 * every OTHER session's lane free to run at the same time. Delivery is the
 * whole turn; a lane that waits for one must not be allowed to hold the intake
 * pass, and with it every other session's heartbeat.
 */
interface SessionDeliveryLane {
  readonly queue: PendingDelivery[];
  worker: Promise<void> | null;
}

function pendingKey(sessionId: string, inputId: string): string {
  return `${sessionId}\u0000${inputId}`;
}

export class HostedSessionSpineIntake {
  private timer: ReturnType<typeof setInterval> | null = null;
  private scheduling = false;
  private stopped = false;
  private readonly lifetime = new AbortController();
  private readonly sessionLifetimes = new Map<string, AbortController>();
  private readonly fenced = new Set<string>();
  private readonly callbackOwners = new Map<string, object>();
  private readonly registrations = new Map<string, Set<Promise<void>>>();
  /** Collected inputs whose delivery has not succeeded yet, by session+input. */
  private readonly pending = new Map<string, PendingDelivery>();
  /** In-flight or queued deliveries, by session+input, so a tick never schedules one twice. */
  private readonly inFlight = new Set<string>();
  /** One delivery lane per session with work outstanding. */
  private readonly lanes = new Map<string, SessionDeliveryLane>();

  private readonly failureReading: FailureReadOptions | undefined;
  constructor(private readonly options: HostedSessionSpineIntakeOptions) {
    this.failureReading = options.failureReading ? { ...options.failureReading } : undefined;
  }

  /** Begin collecting and heartbeating. A no-op without a spine. */
  start(): void {
    if (this.timer || !this.options.spine || this.stopped) return;
    const interval = this.options.intervalMs ?? DEFAULT_INTAKE_INTERVAL_MS;
    this.timer = setInterval(() => { void this.tick(); }, interval);
    // Never hold the process open on account of an idle intake tick.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    this.stopped = true;
    this.lifetime.abort();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Permanently stop registration admission for a terminated session. */
  fence(sessionId: string): void {
    this.fenced.add(sessionId);
    this.sessionLifetimes.get(sessionId)?.abort();
  }

  /** Put (or refresh) this session on the shared spine. Never throws. */
  async register(record: HostedSessionRecord): Promise<void> {
    if (!this.options.spine || this.stopped || this.fenced.has(record.id)) return;
    const registrations = this.registrations.get(record.id) ?? new Set<Promise<void>>();
    // Publish ownership before a registration callback can request termination.
    const registration = Promise.resolve().then(() => this.withLifecycle(record.id, () => this.registerSession(record)));
    registrations.add(registration);
    this.registrations.set(record.id, registrations);
    try {
      await registration;
    } finally {
      registrations.delete(registration);
      if (registrations.size === 0) this.registrations.delete(record.id);
    }
  }

  private callbackOwner(sessionId: string): object {
    let owner = this.callbackOwners.get(sessionId);
    if (!owner) { owner = {}; this.callbackOwners.set(sessionId, owner); }
    return owner;
  }

  private withLifecycle<T>(sessionId: string, callback: () => Promise<T>): Promise<T> {
    return hostedLifecycleCallbacks.run(this.callbackOwner(sessionId), () => this.options.withLifecycle?.(sessionId, callback) ?? callback());
  }

  /** An owning shutdown must not inherit a callback's self-drain restriction. */
  outsideCallbacks<T>(callback: () => T): T {
    return hostedLifecycleCallbacks.outsideMany(this.callbackOwners.values(), callback);
  }

  private assertOutsideCallback(sessionId: string): void {
    if (hostedLifecycleCallbacks.active(this.callbackOwner(sessionId))) {
      throw new Error(`Hosted session ${sessionId} lifecycle callback cannot await its own spine drain`);
    }
  }

  private async registerSession(record: HostedSessionRecord): Promise<void> {
    if (!this.options.spine) return;
    try {
      await this.options.spine.register({
        sessionId: record.id,
        kind: 'hosted',
        project: record.workspaceRoot,
        title: record.title,
        participant: {
          surfaceKind: 'service',
          surfaceId: HOSTED_PARTICIPANT_SURFACE_ID,
          lastSeenAt: this.options.now(),
        },
      });
    } catch (error) {
      logger.warn('[hosted-sessions] registering a hosted session on the shared spine failed; it runs but is not in the union list', {
        sessionId: record.id,
        error: summarizeError(error),
      });
    }
  }

  async drainRegistrations(sessionId: string): Promise<void> {
    this.assertOutsideCallback(sessionId);
    await Promise.allSettled(this.registrations.get(sessionId) ?? []);
  }

  /** Drain and close the spine record. Refuse recursive self-drains; log broker failures. */
  async close(sessionId: string): Promise<void> {
    this.assertOutsideCallback(sessionId);
    this.fence(sessionId);
    await this.drainRegistrations(sessionId);
    if (!this.options.spine) return;
    try {
      await this.withLifecycle(sessionId, () => this.options.spine!.closeSession(sessionId));
    } catch (error) {
      logger.debug('[hosted-sessions] closing a hosted session on the shared spine failed', {
        sessionId,
        error: summarizeError(error),
      });
    }
  }

  /**
   * One pass: heartbeat every live session, then collect its queued inputs and
   * hand them to that session's delivery lane.
   *
   * What this method must NOT do is wait for a delivery. `deliver` runs the
   * whole turn, minutes, on a real one, and this used to be awaited inside
   * the re-entrancy guard, so for as long as any ONE hosted session was
   * answering, no other session was heartbeated. A hosted session whose
   * participant goes stale stops receiving its own steers and starts getting
   * background agents instead: the conversation keeps answering, from the wrong
   * thing. The stale clocks also read as idle to the session reaper, which is
   * how a session with a turn plainly still running was closed "idle-reaped".
   *
   * So the guard now covers SCHEDULING only. Delivery is detached into a
   * per-session lane, ordering within a session is the lane's job, and errors
   * out of a detached delivery are reported exactly where a thrown delivery
   * used to be reported from here.
   */
  async tick(): Promise<void> {
    const spine = this.options.spine;
    if (!spine || this.stopped || this.scheduling) return;
    this.scheduling = true;
    try {
      // Retries first: a message that has already waited a tick outranks one
      // still queued, and delivering out of order is how a steer arrives after
      // the follow-up that was meant to come after it.
      for (const pending of [...this.pending.values()]) {
        this.enqueueDelivery(spine, pending);
      }
      for (const record of this.options.liveSessions()) {
        await this.register(record);
        if (this.stopped || this.fenced.has(record.id)) continue;
        for (const input of spine.getInputsSince(record.id, { state: 'queued' })) {
          if (!input.body.trim()) continue;
          const delivery: PendingDelivery = {
            sessionId: record.id,
            inputId: input.id,
            body: input.body,
            correlationId: input.correlationId,
            attempts: 0,
          };
          await spine.markInputDelivered(record.id, delivery.inputId).catch(() => undefined);
          this.enqueueDelivery(spine, delivery);
        }
      }
    } catch (error) {
      // The tick runs on an interval with nobody awaiting it, so a throw out of
      // liveSessions() or getInputsSince() was an unhandled rejection, which,
      // on a process that treats those as fatal, took the daemon down over a
      // read that will very likely succeed on the next tick.
      logger.warn('[hosted-sessions] an intake pass failed; the next tick retries', {
        error: summarizeError(error),
      });
    } finally {
      this.scheduling = false;
    }
  }

  /**
   * Wait for every delivery now in flight.
   *
   * The tick no longer waits for delivery, so a caller that needs the OUTCOME
   *, a test asserting what the spine recorded, a shutdown that would rather
   * not abandon a message mid-flight, asks for it explicitly instead of
   * relying on tick() to have finished the work.
   */
  async drainDeliveries(): Promise<void> {
    for (;;) {
      const workers = [...this.lanes.values()]
        .map((lane) => lane.worker)
        .filter((worker): worker is Promise<void> => worker !== null);
      if (workers.length === 0) return;
      await Promise.all(workers);
    }
  }

  /** Put one delivery in its session's lane and make sure the lane is draining. */
  private enqueueDelivery(spine: HostedSessionSpine, pending: PendingDelivery): void {
    const key = pendingKey(pending.sessionId, pending.inputId);
    // Already queued or already being delivered: a tick that fires while a slow
    // turn is in flight must not hand the same message over a second time.
    if (this.stopped || this.fenced.has(pending.sessionId) || this.inFlight.has(key)) return;
    this.inFlight.add(key);
    const lane = this.lanes.get(pending.sessionId) ?? { queue: [], worker: null };
    this.lanes.set(pending.sessionId, lane);
    lane.queue.push(pending);
    this.startLane(spine, pending.sessionId, lane);
  }

  /**
   * Drain one session's lane, serially, detached from the tick that filled it.
   *
   * The lane's task never rejects: a delivery that fails is handled by
   * attemptDelivery, and anything that escapes it is reported where tick()
   * used to report it. Nobody awaits this task in normal operation, so a
   * rejection here would be an unhandled one, the failure mode this whole
   * class already exists to keep off a daemon that treats those as fatal.
   */
  private startLane(spine: HostedSessionSpine, sessionId: string, lane: SessionDeliveryLane): void {
    if (lane.worker) return;
    lane.worker = (async (): Promise<void> => {
      try {
        for (;;) {
          const next = lane.queue.shift();
          if (next === undefined) return;
          const key = pendingKey(next.sessionId, next.inputId);
          try {
            await this.attemptDelivery(spine, next);
          } catch {
            // A reader/provider exception is untrusted too. Retain the input
            // without echoing potentially credential-bearing exception text.
            logger.warn('[hosted-sessions] delivery classification unavailable; input remains collected', {
              sessionId: next.sessionId, inputId: next.inputId,
            });
          } finally {
            this.inFlight.delete(key);
          }
        }
      } finally {
        lane.worker = null;
        if (lane.queue.length > 0) {
          // Something arrived while the last delivery was settling.
          this.startLane(spine, sessionId, lane);
        } else if (this.lanes.get(sessionId) === lane) {
          this.lanes.delete(sessionId);
        }
      }
    })();
  }

  /**
   * Hand one collected input to its session's loop.
   *
   * Delivery failing is NOT the same as delivery happening: marking the input
   * consumed either way is a record saying the owner's message was answered
   * when nothing received it, and on a survive-detach session with nobody
   * attached the only trace was a warn line in the daemon log. So a failure
   * keeps the input, retries it on the next tick, and, once the attempts are
   * spent, fails it on the spine and puts the incident in front of the owner.
   */
  private async attemptDelivery(spine: HostedSessionSpine, pending: PendingDelivery): Promise<void> {
    const key = pendingKey(pending.sessionId, pending.inputId);
    const assertCurrent = () => {
      this.lifetime.signal.throwIfAborted();
      if (this.fenced.has(pending.sessionId)) throw new Error('Hosted delivery owner closed');
    };
    assertCurrent();
    // A failed reading may be retried, but never by resending the input before
    // its actual delivery failure has been classified.
    if (pending.failure) {
      await this.resolveFailure(spine, pending, assertCurrent);
      return;
    }
    try {
      await this.options.deliver(pending.sessionId, pending.body, pending.correlationId);
      this.pending.delete(key);
      // A successfully completed turn stays delivered during shutdown drain.
      await spine.markInputDelivered(pending.sessionId, pending.inputId, { consumed: true }).catch(() => undefined);
    } catch (error) {
      // Keep the input collected even if the evidence is unsafe to read. It must
      // never be retried merely because privacy admission failed.
      const blocked: PendingDelivery = { ...pending, attempts: pending.attempts + 1,
        failure: { error: undefined, blocked: true, detail: 'Delivery failed; failure evidence has not been admitted.' } };
      this.pending.set(key, blocked);
      const captured = captureJudgmentFailure(error);
      const failed: PendingDelivery = { ...blocked,
        failure: { error: captured, detail: summarizeError(captured), ...(this.failureReading ? { reading: this.failureReading } : {}) } };
      this.pending.set(key, failed);
      await this.resolveFailure(spine, failed, assertCurrent);
    }
  }

  private async resolveFailure(spine: HostedSessionSpine, pending: PendingDelivery, assertCurrent: () => void): Promise<void> {
    assertCurrent();
    const failure = pending.failure!;
    if (failure.blocked) throw new Error('Hosted delivery failure evidence could not be admitted');
    let owner = this.sessionLifetimes.get(pending.sessionId);
    if (!owner) { owner = new AbortController(); this.sessionLifetimes.set(pending.sessionId, owner); }
    const captured = failure.reading ?? { port: judgmentPort('engine.hosted-session.spine-delivery') };
    const signal = AbortSignal.any([this.lifetime.signal, owner.signal, ...(captured.signal ? [captured.signal] : [])]);
    const reading = { ...captured, signal, beforeAttempt: () => { assertCurrent(); const result = captured.beforeAttempt?.(); if (result !== undefined) return result; signal.throwIfAborted(); } };
    // Retain the exact owner if a reader failure needs a later reading attempt.
    this.pending.set(pendingKey(pending.sessionId, pending.inputId), { ...pending, failure: { ...failure, reading: captured } });
    const transience = await readFailureTransience(failure.error, 'engine.hosted-session.spine-delivery', { reading });
    assertCurrent(); signal.throwIfAborted();
    const key = pendingKey(pending.sessionId, pending.inputId);
    const cap = this.options.maxDeliveryAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS;
    // A-F1540: the count is only the mechanical ceiling AFTER eligibility.
    if (transience.failureClass === 'retryable' && pending.attempts < cap) {
      this.pending.set(key, { ...pending, failure: undefined });
      logger.warn('[hosted-sessions] a collected input could not be delivered; it stays queued for the next tick', {
        sessionId: pending.sessionId, inputId: pending.inputId, attempts: pending.attempts, error: failure.detail,
      });
      return;
    }
    this.pending.delete(key);
    logger.error('[hosted-sessions] a collected input could not be delivered and is now marked failed', {
      sessionId: pending.sessionId, inputId: pending.inputId, attempts: pending.attempts, error: failure.detail,
    });
    assertCurrent(); signal.throwIfAborted();
    await spine.failInput?.(pending.sessionId, pending.inputId, failure.detail).catch(() => undefined);
    assertCurrent(); signal.throwIfAborted();
    this.alertOwner(pending, pending.attempts, failure.detail);
  }

  /** Say it on a channel that still works. Never throws into the tick. */
  private alertOwner(pending: PendingDelivery, attempts: number, detail: string): void {
    try {
      this.options.alertOwner?.(
        `A message for hosted session ${pending.sessionId} could not be delivered after ${attempts} attempts `
        + `and has been marked failed: ${detail}`,
      );
    } catch (error) {
      logger.error('[hosted-sessions] the owner could not be told about an undelivered message', {
        sessionId: pending.sessionId,
        inputId: pending.inputId,
        error: summarizeError(error),
      });
    }
  }
}
