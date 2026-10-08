/**
 * Revocable evidence of one completed canonical mail read. This is an observed
 * subject snapshot, never send authority or a claim of live remote existence.
 * Owners retain bounded metadata/controllers only; the result's WeakMap owns
 * the subject text. An embedding without a lifecycle owner gets no evidence.
 */
import { randomUUID } from 'node:crypto';
import type { EmailConfig } from './email-service.js';

export interface EmailReplySubjectSource {
  readonly revision: string;
  readonly subject: string;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
}

/** Mailbox/account observation only; not message-content or transmission authority. */
export interface EmailMailboxObservation {
  readonly revision: string;
  readonly accountRevision: string;
  readonly mailbox: string;
  readonly uidValidity: number;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
}

export interface EmailReplySubjectRead {
  /** The actual read lifetime, revoked by newer reads, account changes or disposal. */
  readonly signal: AbortSignal;
  assertCurrent(): void;
  /** Only the service calls this after successful read and transport retirement. */
  completeMailboxObservation(): EmailMailboxObservation | undefined;
  /** Called after EXAMINE, before fetching the message. */
  observeMailbox(mailbox: string, uidValidity: number | null): void;
  /** Called only for the exact canonical result after a successful read. */
  complete(uid: number, mailbox: string, subject: string): EmailReplySubjectSource | undefined;
}

const MAX_CURRENT_SOURCES = 256;

/** Owned by one mail composition, with synchronous config/credential invalidation. */
export class EmailReplySubjectSourceOwner {
  #closed = false;
  #epoch = 0;
  #latestRead = 0;
  #account: string | undefined;
  #accountRevision = randomUUID();
  #readController: AbortController | undefined;
  #uidValidity: number | undefined;
  readonly #controllers = new Map<number, AbortController>();
  readonly #observations = new Set<AbortController>();

  /** Invalidate even an ABA change: equality with the old config is insufficient. */
  invalidate(): void {
    const retired = this.#detachSources();
    if (this.#readController) retired.push(this.#readController);
    this.#readController = undefined;
    this.#epoch += 1;
    this.#accountRevision = randomUUID();
    this.#account = undefined;
    this.#uidValidity = undefined;
    // Publish ALL state before notifying arbitrary synchronous abort listeners.
    this.#retire(retired);
  }

  dispose(): void {
    this.#closed = true;
    this.invalidate();
  }

  /** Must run before the first credential or transport await. */
  beginRead(config: EmailConfig, uid?: number): EmailReplySubjectRead {
    const account = JSON.stringify(config);
    const retired: AbortController[] = [];
    if (account !== this.#account) {
      this.#epoch += 1;
      this.#accountRevision = randomUUID();
      this.#account = account;
      this.#uidValidity = undefined;
      retired.push(...this.#detachSources());
    }
    const epoch = this.#epoch;
    const accountRevision = this.#accountRevision;
    const ticket = ++this.#latestRead;
    if (this.#readController) retired.push(this.#readController);
    const controller = new AbortController();
    this.#readController = controller;
    if (this.#closed) retired.push(controller);
    if (uid !== undefined) {
      const previous = this.#controllers.get(uid);
      if (previous) retired.push(previous);
      this.#controllers.delete(uid);
    }
    const expectedMailbox = config.mailbox.trim() || 'INBOX';
    let observedValidity: number | undefined;
    const current = (): boolean => !this.#closed
      && epoch === this.#epoch && ticket === this.#latestRead && !controller.signal.aborted;
    const assertCurrent = (): void => {
      if (!current()) throw new Error('Mail read is no longer current.');
    };
    this.#retire(retired);
    return {
      signal: controller.signal,
      assertCurrent,
      completeMailboxObservation: (): EmailMailboxObservation | undefined => {
        if (!current() || observedValidity === undefined || observedValidity !== this.#uidValidity) return undefined;
        const observationController = new AbortController();
        this.#observations.add(observationController);
        if (this.#observations.size > MAX_CURRENT_SOURCES) {
          const oldest = this.#observations.values().next().value;
          if (oldest) { this.#observations.delete(oldest); oldest.abort(); }
        }
        if (!current() || observationController.signal.aborted) {
          this.#observations.delete(observationController); observationController.abort(); return undefined;
        }
        const uidValidity = observedValidity;
        return Object.freeze({ revision: randomUUID(), accountRevision, mailbox: expectedMailbox,
          uidValidity, signal: observationController.signal,
          assertCurrent: (): void => {
            if (observationController.signal.aborted || this.#closed || epoch !== this.#epoch
              || uidValidity !== this.#uidValidity) throw new Error('Mailbox observation is no longer current.');
          } });
      },
      observeMailbox: (mailbox, uidValidity): void => {
        if (!current()) return;
        if (mailbox !== expectedMailbox || !Number.isSafeInteger(uidValidity)
          || uidValidity === null || uidValidity <= 0 || uidValidity > 0xffffffff) {
          this.#uidValidity = undefined;
          observedValidity = undefined;
          this.#retire(this.#detachSources());
          return;
        }
        const changed = this.#uidValidity !== uidValidity;
        this.#uidValidity = uidValidity;
        observedValidity = uidValidity;
        if (changed) this.#retire(this.#detachSources());
      },
      complete: (readUid, mailbox, subject): EmailReplySubjectSource | undefined => {
        if (!current() || observedValidity === undefined
          || observedValidity !== this.#uidValidity || mailbox !== expectedMailbox
          || uid === undefined || readUid !== uid || !Number.isSafeInteger(uid) || uid <= 0 || uid > 0xffffffff) return undefined;
        const sourceController = new AbortController();
        const previous = this.#controllers.get(uid);
        this.#controllers.delete(uid);
        this.#controllers.set(uid, sourceController);
        const evicted: AbortController[] = previous ? [previous] : [];
        if (this.#controllers.size > MAX_CURRENT_SOURCES) {
          const oldest = this.#controllers.entries().next().value;
          if (oldest) { this.#controllers.delete(oldest[0]); evicted.push(oldest[1]); }
        }
        this.#retire(evicted);
        if (!current() || sourceController.signal.aborted || this.#controllers.get(uid) !== sourceController) {
          if (this.#controllers.get(uid) === sourceController) this.#controllers.delete(uid);
          sourceController.abort(); return undefined;
        }
        const uidValidity = observedValidity;
        return Object.freeze({ revision: randomUUID(), subject, signal: sourceController.signal,
          assertCurrent: (): void => {
            if (sourceController.signal.aborted || this.#closed || epoch !== this.#epoch
              || uidValidity !== this.#uidValidity) throw new Error('Mail subject source is no longer current.');
          } });
      },
    };
  }

  #detachSources(): AbortController[] {
    const controllers = [...this.#controllers.values(), ...this.#observations];
    this.#controllers.clear();
    this.#observations.clear();
    return controllers;
  }

  #retire(controllers: readonly AbortController[]): void {
    for (const controller of controllers) controller.abort();
  }
}
