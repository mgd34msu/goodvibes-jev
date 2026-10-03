/**
 * outward-approvals.ts, the agent's answer to "what actually clears this?"
 *
 * The refusal the owner met named a remedy that did not exist: reply "send it
 * now". He replied. It refused again, in the same words. Nothing in the whole
 * product had ever minted an `OwnerApproval`, the factory had test callers
 * only, so the advice was fiction, and the retry could not have worked.
 *
 * The tempting repair is to make the phrase work. That would be worse than the
 * bug. A boundary cleared by a sentence in the conversation is cleared by
 * anything that can put that sentence in the conversation, and steering a
 * conversation toward producing a particular sentence is what the content this
 * boundary exists to stop is good at. The remedy has to be something content
 * cannot produce, and a phrase never is.
 *
 * ── What clears it here ───────────────────────────────────────────────────
 *
 * The owner typing `/google approve` at his own prompt. Two properties make
 * that a gesture rather than text:
 *
 *  - It is handled by the surface's input layer, not by the model. The words
 *    never become tokens the model chooses to emit; they are keystrokes the
 *    process read off its own input widget.
 *  - The one path by which a model CAN reach a slash command,
 *    `agent_harness mode:"run_command"`, marks its context `invokedByModel`,
 *    and the approval route refuses on that flag. Without this the fix would
 *    have been theatre: injected text steers the model, the model runs the
 *    command, the approval appears, and the send goes.
 *
 * The approval that results is bound to the exact message it was shown, single
 * use, and expires in minutes, see the SDK's security/owner-approval.ts for
 * why an approval naming only an action id is a standing permit rather than an
 * approval of the deed.
 */

import { OwnerApprovalStore } from '@goodvibes-jev/engine/sdk/platform/security';

/**
 * One store per process, shared by the tool that asks and the command that
 * answers. They are different call stacks in the same process and must be
 * looking at the same pending approvals or the gesture clears nothing.
 */
let store: OwnerApprovalStore | null = null;
let pending: PendingOutwardAction | null = null;

export function getOutwardApprovalStore(): OwnerApprovalStore {
  store ??= new OwnerApprovalStore();
  return store;
}

export function resetOutwardApprovalStoreForTests(): void {
  store = null;
  pending = null;
}

/** The gesture, in the owner's words. Named once so the refusal cannot drift from it. */
export const OUTWARD_APPROVAL_GESTURE =
  'type /google approve at the prompt yourself, then re-issue the send. '
  + 'It is a keystroke rather than a phrase on purpose: anything you could be talked into typing, '
  + 'content that was just read could talk the agent into producing.';

/** What the last refused outward action was, so the gesture has something to approve. */
export interface PendingOutwardAction {
  readonly action: string;
  readonly description: string;
  readonly content: Readonly<Record<string, string | undefined>>;
  readonly at: number;
}

/**
 * Remember what was just refused.
 *
 * The owner approves an action he has been SHOWN, so the thing he approves has
 * to be recorded at the moment of refusal, otherwise `/google approve` would
 * be approving whatever came next, which is a blank cheque.
 */
export function rememberRefusedOutwardAction(input: Omit<PendingOutwardAction, 'at'>): void {
  pending = { ...input, at: Date.now() };
}

/** How long a refused action stays approvable, matching the approval's own window. */
const PENDING_TTL_MS = 5 * 60 * 1000;

export function takeRefusedOutwardAction(): PendingOutwardAction | null {
  if (pending === null) return null;
  if (Date.now() - pending.at > PENDING_TTL_MS) {
    pending = null;
    return null;
  }
  const held = pending;
  pending = null;
  return held;
}

export function peekRefusedOutwardAction(): PendingOutwardAction | null {
  if (pending === null) return null;
  if (Date.now() - pending.at > PENDING_TTL_MS) {
    pending = null;
    return null;
  }
  return pending;
}
