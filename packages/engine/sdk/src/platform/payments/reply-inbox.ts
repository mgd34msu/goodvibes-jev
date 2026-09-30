/**
 * reply-inbox.ts, where the owner's answer to a purchase notice arrives.
 *
 * The notifier sends an approval or veto notice over the owner's command
 * channels and then waits (`PaymentReplySource.waitForAnswer`). The daemon's
 * shared channel ingress hook offers every inbound owner message on a
 * command-authority channel to this inbox (daemon/payment-reply.ts), and the
 * inbox reads it against the notice it follows (`readPaymentReply`, a Jev
 * reply reading). A reply that answers settles the wait and is consumed; a
 * reply that does not answer is left to flow on as ordinary conversation.
 *
 * Matching is deliberately narrow, as for work proposals and permission
 * asks: only a window waiting on the channel the message arrived on, and only
 * when exactly one is. With two purchases waiting on one channel a bare "yes"
 * could settle either, so it settles neither; each window then falls to its
 * own silence rule, which is the owner's rule for no answer.
 *
 * The wait resolves null at the deadline, and only then. Null means silence
 * and nothing else (payment-ports.ts): a reading that fails throws to the
 * ingress hook that offered the message, and the wait stays open.
 */
import type { PaymentReplySource, PaymentAnswer } from './notice-delivery.js';
import { readPaymentReply } from './notice-delivery.js';
import type { CommandAuthorityChannel } from './types.js';

interface Waiter {
  readonly kind: 'approval' | 'veto';
  readonly channels: readonly CommandAuthorityChannel[];
  readonly notice: string;
  settle(answer: { readonly answer: PaymentAnswer; readonly channel: CommandAuthorityChannel } | null): void;
  cancel(error: Error): void;
}

/** Shutdown is a failed wait, never the silence that can permit a veto purchase. */
export class PaymentReplyInboxClosedError extends Error {
  readonly code = 'PAYMENT_REPLY_INBOX_CLOSED';
  constructor() {
    super('The payment reply inbox was closed before the window could finish.');
    this.name = 'PaymentReplyInboxClosedError';
  }
}

export type PaymentReplyOffer =
  | { readonly consumed: false; readonly reason: 'no-window' | 'several-windows' | 'not-an-answer' }
  | { readonly consumed: true; readonly answer: PaymentAnswer };

export class PaymentReplyInbox implements PaymentReplySource {
  readonly #waiting = new Set<Waiter>();
  readonly #now: () => number;
  readonly #offers = new Set<Promise<PaymentReplyOffer>>();
  #closed = false;
  #closing: Promise<void> | null = null;

  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  waitForAnswer(input: Parameters<PaymentReplySource['waitForAnswer']>[0]): ReturnType<PaymentReplySource['waitForAnswer']> {
    const waiting = new Promise<Awaited<ReturnType<PaymentReplySource['waitForAnswer']>>>((resolve, reject) => {
      if (this.#closed) { reject(new PaymentReplyInboxClosedError()); return; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: Waiter = {
        kind: input.kind,
        channels: input.channels,
        notice: input.notice,
        settle: (answer) => {
          if (!this.#waiting.delete(waiter)) return;
          if (timer !== undefined) clearTimeout(timer);
          resolve(answer);
        },
        cancel: (error) => {
          if (!this.#waiting.delete(waiter)) return;
          if (timer !== undefined) clearTimeout(timer);
          reject(error);
        },
      };
      this.#waiting.add(waiter);
      timer = setTimeout(() => waiter.settle(null), Math.max(0, input.deadlineMs - this.#now()));
    });
    // A host may tear down while a legacy caller has not attached its handler
    // yet. Observe rejection without changing what an awaiting caller receives.
    void waiting.catch(() => {});
    return waiting;
  }

  /**
   * Stop admission, reject waiting windows and drain reply readings already
   * accepted. The owner must await this before releasing its graph. No pending
   * window resolves null here; only its actual deadline can establish silence.
   */
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const error = new PaymentReplyInboxClosedError();
    for (const waiter of this.#waiting) waiter.cancel(error);
    this.#closing = Promise.allSettled(this.#offers).then(() => {});
    return this.#closing;
  }

  /** How many windows are waiting for an answer. */
  get pending(): number {
    return this.#waiting.size;
  }

  /**
   * Offer an inbound owner message that arrived on `channel`. The caller has
   * already established that the sender is the owner.
   */
  offer(channel: CommandAuthorityChannel, text: string): Promise<PaymentReplyOffer> {
    if (this.#closed) return Promise.resolve({ consumed: false, reason: 'no-window' });
    // Track admission before the judgment port can synchronously request close.
    const work = Promise.resolve().then(() => this.readOffer(channel, text));
    this.#offers.add(work);
    void work.then(() => this.#offers.delete(work), () => this.#offers.delete(work));
    return work;
  }

  private async readOffer(channel: CommandAuthorityChannel, text: string): Promise<PaymentReplyOffer> {
    const waiting = [...this.#waiting].filter((waiter) => waiter.channels.includes(channel));
    if (waiting.length === 0) return { consumed: false, reason: 'no-window' };
    if (waiting.length > 1) return { consumed: false, reason: 'several-windows' };
    const [waiter] = waiting as [Waiter];
    const answer = await readPaymentReply(text, waiter.kind, waiter.notice);
    if (answer === null) return { consumed: false, reason: 'not-an-answer' };
    // The window may have reached its deadline while the reply was read.
    if (!this.#waiting.has(waiter)) return { consumed: false, reason: 'no-window' };
    waiter.settle({ answer, channel });
    return { consumed: true, answer };
  }
}
