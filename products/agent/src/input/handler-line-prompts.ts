/**
 * handler-line-prompts.ts, the composer's two line-prompt slots, wired.
 *
 * The InputHandler owns two mutually exclusive slots for "ask one line and
 * hand it to a callback":
 *
 *   concealedInput , masked, for card material   (concealed-input.ts)
 *   plainLineInput , echoed, for addresses       (plain-line-input.ts)
 *
 * Those two modules hold the state transitions so they can be driven against a
 * plain object in tests. This file holds the part that needs the handler: the
 * mutual exclusion between the slots, the precedence rule on submit, and the
 * feed-context resync each transition requires. It follows the same
 * `*ForHandler` shape as handler-interactions.ts so handler.ts keeps only
 * one-line delegating methods.
 */

import {
  beginConcealedInputFor,
  submitConcealedInputFor,
  cancelConcealedInputFor,
  type ConcealedInputRequest,
} from './concealed-input.ts';
import {
  beginPlainLineInputFor,
  submitPlainLineInputFor,
  cancelPlainLineInputFor,
  type PlainLineInputRequest,
} from './plain-line-input.ts';

/**
 * The handler surface these need. Structural rather than the InputHandler class
 * itself, to keep this file independent of the 800-line handler module.
 */
export interface LinePromptHandler {
  prompt: string;
  cursorPos: number;
  concealedInput: ConcealedInputRequest | null;
  plainLineInput: PlainLineInputRequest | null;
  requestRender: () => void;
  syncFeedContextMutableFields: () => void;
}

/**
 * Begin one line of MASKED entry, cancelling any pending plain prompt first.
 *
 * At most one slot is ever live. Without that, submitLinePromptForHandler would
 * have to guess which requester an Enter belongs to, and the wrong guess routes
 * a card number to the echoed path.
 */
export function beginConcealedInputForHandler(handler: LinePromptHandler, request: ConcealedInputRequest): void {
  cancelPlainLineInputFor(handler);
  beginConcealedInputFor(handler, request);
  handler.syncFeedContextMutableFields();
}

/** Begin one line of ORDINARY, echoed entry, cancelling any pending masked prompt first. */
export function beginPlainInputForHandler(handler: LinePromptHandler, request: PlainLineInputRequest): void {
  cancelConcealedInputFor(handler);
  beginPlainLineInputFor(handler, request);
  handler.syncFeedContextMutableFields();
}

/**
 * Deliver a submission to whichever slot is active. True means it was consumed
 * and the caller must NOT run the normal submit path (which adds to input
 * history).
 *
 * The concealed slot is tried FIRST. If both were somehow live, the masked
 * consumer has to win: handing a card number to the plain path would put it in
 * input history, and an internal inconsistency must fail on the safe side of
 * that.
 */
export function submitLinePromptForHandler(handler: LinePromptHandler, value: string): boolean {
  if (submitConcealedInputFor(handler, value)) {
    handler.syncFeedContextMutableFields();
    return true;
  }
  if (submitPlainLineInputFor(handler, value)) {
    handler.syncFeedContextMutableFields();
    return true;
  }
  return false;
}

/**
 * Cancel a pending line prompt of either kind (Escape). False means there was
 * none, so Escape falls through to the normal modal-stack handling.
 *
 * Cancelling matters beyond tidiness: a dangling request never fires its
 * onCancel, so a chained flow neither resumes nor stops, and the composer stays
 * silently in masked mode with no way out.
 */
export function cancelLinePromptForHandler(handler: LinePromptHandler): boolean {
  const cancelled = cancelConcealedInputFor(handler) || cancelPlainLineInputFor(handler);
  if (cancelled) handler.syncFeedContextMutableFields();
  return cancelled;
}
