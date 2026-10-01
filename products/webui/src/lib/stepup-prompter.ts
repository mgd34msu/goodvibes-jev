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
 * Ask the registered prompter for an assertion header value. Returns null, never throws,
 * when no prompter is registered or the ceremony fails/cancels, so the caller can surface the
 * original 401 honestly instead of a dead-end.
 */
export async function resolveStepUp(context: StepUpContext): Promise<string | null> {
  if (!prompter) return null;
  try {
    return await prompter(context);
  } catch {
    return null;
  }
}
