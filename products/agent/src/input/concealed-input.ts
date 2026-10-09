/**
 * Composer concealed-input mode.
 *
 * One line of password-like entry through the MAIN composer: the typed text is
 * masked on screen AND never reaches input history or the transcript
 * plaintext. The plaintext is delivered exactly once, to the requester's
 * onSubmit callback, and the composer's own copy is cleared before that
 * callback runs.
 *
 * Ported from the TUI's src/input/concealed-input.ts deliberately unchanged in
 * shape and naming. `/payments card` exists on both surfaces and must behave
 * identically on both; a second, subtly different masking implementation here
 * is exactly how the two surfaces would drift into one of them echoing a card
 * number. Where the two apps genuinely differ is only in how the host wires
 * these helpers into its own InputHandler.
 *
 * The real value lives in the composer's normal prompt buffer, so all the
 * usual editing (backspace, cursor movement, paste) keeps working; only the
 * RENDER path is masked (see maskConcealedText) and the SUBMIT path is
 * diverted (see InputHandler.submitConcealedInput).
 */

/** A pending request for one line of concealed input from the composer. */
export interface ConcealedInputRequest {
  /**
   * Short label describing what is being asked for, e.g. 'CVV' or 'Card
   * number'. Surfaced by the CALLER (as a printed system line), the composer
   * itself only masks; it never prints the label, and it never prints the
   * value.
   */
  readonly label?: string;
  /** Receives the entered plaintext exactly once, when the user submits. */
  readonly onSubmit: ((value: string) => void) | ((value: string) => Promise<void>);
  /** Invoked if the user cancels (Escape) instead of submitting. */
  readonly onCancel?: () => void;
}

/**
 * Mask a composer buffer for display. Every UTF-16 code unit except a newline
 * becomes a bullet, so the masked string has the EXACT same length and line
 * structure as the plaintext, word-wrap and cursor-position math (which index
 * the string by code unit) stay correct while no plaintext character ever
 * reaches the screen buffer.
 */
export function maskConcealedText(text: string): string {
  return text.replace(/[^\n]/g, '•');
}

/**
 * Minimal composer surface the concealed-input helpers mutate. Kept structural
 * so this logic lives here rather than growing handler.ts, and so tests can
 * drive it against a plain object instead of a full InputHandler.
 */
export interface ConcealedInputHost {
  prompt: string;
  cursorPos: number;
  concealedInput: ConcealedInputRequest | null;
  requestRender: () => void;
}

/**
 * Begin one line of concealed input. The composer starts empty and masked; the
 * next submit delivers the plaintext to request.onSubmit and auto-clears
 * concealed mode. A second call replaces any in-flight request (its onCancel
 * fires so no requester is left dangling waiting for an answer that will never
 * come).
 */
export function beginConcealedInputFor(host: ConcealedInputHost, request: ConcealedInputRequest): void {
  if (host.concealedInput) host.concealedInput.onCancel?.();
  host.concealedInput = request;
  host.prompt = '';
  host.cursorPos = 0;
  host.requestRender();
}

const pendingSubmissions = new WeakMap<ConcealedInputHost, {
  readonly request: ConcealedInputRequest;
  readonly completion: Promise<void>;
}>();

/** Observe the actual submission, including a chained next prompt, without polling. */
export function waitForConcealedSubmission(host: ConcealedInputHost): Promise<void> {
  return pendingSubmissions.get(host)?.completion ?? Promise.resolve();
}

/**
 * Consume a submission synchronously so it cannot reach ordinary chat/history.
 * Clear plaintext before the callback; an asynchronous callback retains a
 * masked waiting slot until completion, cancellation, or a replacement prompt.
 * Repeated Enter while waiting is consumed without invoking the callback again.
 */
export function submitConcealedInputFor(host: ConcealedInputHost, value: string): boolean {
  const request = host.concealedInput;
  if (!request) return false;
  host.prompt = '';
  host.cursorPos = 0;
  // A second Enter while storage is pending must never escape to ordinary
  // chat/history, submit the first field twice, or unmask subsequent typing.
  if (pendingSubmissions.get(host)?.request === request) return true;
  host.concealedInput = null;
  const result = request.onSubmit(value);
  if (result && typeof result.then === 'function') {
    const pending: ConcealedInputRequest = {
      label: 'Saving concealed input',
      onSubmit: () => {},
      onCancel: () => request.onCancel?.(),
    };
    if (host.concealedInput === null) host.concealedInput = pending;
    const completion = Promise.resolve(result).catch(() => {
      // The owner reports storage failures; never echo a callback error that
      // may contain the submitted material. Stop a failed chain safely.
      if (host.concealedInput === pending) request.onCancel?.();
    }).finally(() => {
      if (host.concealedInput === pending) {
        host.concealedInput = null;
        host.prompt = '';
        host.cursorPos = 0;
      }
      if (pendingSubmissions.get(host)?.request === pending) pendingSubmissions.delete(host);
      host.requestRender();
    });
    pendingSubmissions.set(host, { request: pending, completion });
  }
  return true;
}

/** Cancel an active concealed-input request without submitting (Escape). */
export function cancelConcealedInputFor(host: ConcealedInputHost): boolean {
  const request = host.concealedInput;
  if (!request) return false;
  host.concealedInput = null;
  host.prompt = '';
  host.cursorPos = 0;
  request.onCancel?.();
  host.requestRender();
  return true;
}
