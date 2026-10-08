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

export interface EmailReplySubjectRead {
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
  #uidValidity: number | undefined;
  readonly #controllers = new Map<number, AbortController>();

  /** Invalidate even an ABA change: equality with the old config is insufficient. */
  invalidate(): void {
    this.#epoch += 1;
    this.#account = undefined;
    this.#uidValidity = undefined;
    this.#revokeAll();
  }

  dispose(): void {
    this.#closed = true;
    this.invalidate();
  }

  /** Must run before the first credential or transport await. */
  beginRead(config: EmailConfig, uid?: number): EmailReplySubjectRead {
    const account = JSON.stringify(config);
    if (account !== this.#account) {
      this.invalidate();
      this.#account = account;
    }
    const epoch = this.#epoch;
    // Mailbox-wide ordering prevents an old DIFFERENT-UID read from restoring
    // an obsolete UIDVALIDITY after a newer connection observed replacement.
    const ticket = ++this.#latestRead;
    const expectedMailbox = config.mailbox.trim() || 'INBOX';
    if (uid !== undefined) {
      this.#controllers.get(uid)?.abort();
      this.#controllers.delete(uid);
    }
    let observedValidity: number | undefined;
    const current = (): boolean => !this.#closed
      && epoch === this.#epoch && ticket === this.#latestRead;
    return {
      observeMailbox: (mailbox, uidValidity): void => {
        if (!current()) return;
        if (mailbox !== expectedMailbox || !Number.isSafeInteger(uidValidity)
          || uidValidity === null || uidValidity <= 0 || uidValidity > 0xffffffff) {
          this.#uidValidity = undefined;
          this.#revokeAll();
          return;
        }
        if (this.#uidValidity !== uidValidity) this.#revokeAll();
        this.#uidValidity = uidValidity;
        observedValidity = uidValidity;
      },
      complete: (readUid, mailbox, subject): EmailReplySubjectSource | undefined => {
        if (!current() || observedValidity === undefined
          || observedValidity !== this.#uidValidity || mailbox !== expectedMailbox
          || uid === undefined || readUid !== uid || !Number.isSafeInteger(uid) || uid <= 0 || uid > 0xffffffff) return undefined;
        const controller = new AbortController();
        this.#controllers.get(uid)?.abort();
        this.#controllers.delete(uid);
        this.#controllers.set(uid, controller);
        if (this.#controllers.size > MAX_CURRENT_SOURCES) {
          const oldest = this.#controllers.entries().next().value;
          if (oldest) {
            oldest[1].abort();
            this.#controllers.delete(oldest[0]);
          }
        }
        return Object.freeze({
          revision: randomUUID(),
          subject,
          signal: controller.signal,
          assertCurrent: (): void => {
            if (controller.signal.aborted) throw new Error('Mail subject source is no longer current.');
          },
        });
      },
    };
  }

  #revokeAll(): void {
    const controllers = [...this.#controllers.values()];
    this.#controllers.clear();
    for (const controller of controllers) controller.abort();
  }
}
