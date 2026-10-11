/**
 * stepup-prompter.ts, the seam between the transport layer and the step-up ceremony UI.
 *
 * routedFetch (relay-connection.ts) is plain, non-React transport code: when a mutating
 * relay call comes back `401 step-up-required`, it cannot itself open a modal or touch a
 * passkey. Instead it asks the registered prompter to produce a fresh assertion header, then
 * retries the original call with it attached.
 *
 * The React host (StepUpHost) registers the real prompter on mount; it runs the inline
 * ceremony (mint a challenge, navigator.credentials.get, encode the header) and resolves the
 * header value, or null if the operator cancels or the ceremony cannot run. When no prompter
 * is registered (e.g. in a headless context), resolveStepUp returns null and the original 401
 * surfaces honestly rather than hanging.
 */

export interface StepUpContext {
  /** The HTTP method of the gated call. */
  readonly method: string;
  /** The request path (no host) of the gated call. */
  readonly path: string;
  /** Cancellation of this exact gated caller, independent of an explicit UI Cancel. */
  readonly signal?: AbortSignal;
}

/** Produce a step-up assertion header value for a gated call, or null to give up honestly. */
export type StepUpPrompter = (context: StepUpContext) => Promise<string | null>;

let prompter: StepUpPrompter | null = null;

/** Register (or clear, with null) the UI-backed step-up prompter. */
export function registerStepUpPrompter(next: StepUpPrompter | null): void {
  prompter = next;
}

/** True when a UI prompter is available to run the ceremony. */
export function hasStepUpPrompter(): boolean {
  return prompter !== null;
}

/**
 * Ask the registered prompter for an assertion header value. Missing UI or an explicit UI
 * cancellation returns null so the original 401 surfaces. Caller cancellation preserves its
 * native abort reason and cannot leave this transport waiting on an abandoned ceremony.
 */
export async function resolveStepUp(context: StepUpContext): Promise<string | null> {
  const signal = context.signal;
  signal?.throwIfAborted();
  const currentPrompter = prompter;
  if (!currentPrompter) return null;
  let onAbort: (() => void) | undefined;
  const interrupted = signal === undefined ? undefined : new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    // Attach the race before invoking borrowed UI code, including synchronous failures.
    const pending = Promise.resolve().then(() => {
      signal?.throwIfAborted();
      return currentPrompter(context);
    });
    const assertion = await (interrupted ? Promise.race([pending, interrupted]) : pending);
    signal?.throwIfAborted();
    return assertion;
  } catch {
    signal?.throwIfAborted();
    return null;
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}
