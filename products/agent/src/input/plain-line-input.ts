/**
 * Composer plain-line prompt, the unmasked sibling of concealed-input.ts.
 *
 * Same chaining shape (ask, receive one line, ask the next), but the typed
 * text is echoed normally and reaches input history normally, because what it
 * collects is ordinary config: the seven billing / shipping address fields
 * behind `/payments address`.
 *
 * ── Why this is a separate slot rather than a flag ──────────────────────
 *
 * The obvious design is one request type with `conceal: boolean`. It is
 * rejected deliberately. A boolean that controls whether a card number is
 * echoed is one wrong default, one refactor, or one copied call site away from
 * rendering a PAN on screen, and whoever makes that change will not have read
 * concealed-input.ts's header first.
 *
 * So the masked request type carries no masking flag at all, it is masked by
 * its type, and this file is what a caller reaches for when it wants the
 * ordinary behavior. The two cannot be confused at a call site, and no default
 * exists to get wrong.
 *
 * The InputHandler owns the invariant that at most ONE of the two slots is
 * active: beginning either cancels the other (see handler.ts). Both slots
 * live there, so that is the only place able to enforce it.
 */

/** A pending request for one line of ordinary (echoed) input from the composer. */
export interface PlainLineInputRequest {
  /** Short label describing what is being asked for, e.g. 'City'. */
  readonly label?: string;
  /** Receives the entered text exactly once, when the user submits. */
  readonly onSubmit: (value: string) => void;
  /** Invoked if the user cancels (Escape) instead of submitting. */
  readonly onCancel?: () => void;
}

/** Minimal composer surface these helpers mutate. Structural, so tests can drive a plain object. */
export interface PlainLineInputHost {
  prompt: string;
  cursorPos: number;
  plainLineInput: PlainLineInputRequest | null;
  requestRender: () => void;
}

/**
 * Begin one line of plain input. The composer starts empty; the next submit
 * delivers the text to request.onSubmit and clears the mode. A second call
 * replaces any in-flight request (its onCancel fires so no requester is left
 * waiting for an answer that will never arrive).
 */
export function beginPlainLineInputFor(host: PlainLineInputHost, request: PlainLineInputRequest): void {
  if (host.plainLineInput) host.plainLineInput.onCancel?.();
  host.plainLineInput = request;
  host.prompt = '';
  host.cursorPos = 0;
  host.requestRender();
}

/**
 * Deliver a plain-line submission. Returns true when this mode was active and
 * consumed the value; false when it was not (the caller then uses the normal
 * chat/command submit path).
 */
export function submitPlainLineInputFor(host: PlainLineInputHost, value: string): boolean {
  const request = host.plainLineInput;
  if (!request) return false;
  host.plainLineInput = null;
  host.prompt = '';
  host.cursorPos = 0;
  request.onSubmit(value);
  return true;
}

/** Cancel an active plain-line request without submitting (Escape). */
export function cancelPlainLineInputFor(host: PlainLineInputHost): boolean {
  const request = host.plainLineInput;
  if (!request) return false;
  host.plainLineInput = null;
  host.prompt = '';
  host.cursorPos = 0;
  request.onCancel?.();
  host.requestRender();
  return true;
}
