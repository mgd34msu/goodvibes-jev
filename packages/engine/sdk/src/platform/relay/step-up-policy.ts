// relay/step-up-policy.ts
//
// A policy hook for requiring a recent WebAuthn (passkey) step-up assertion on
// MUTATING operator calls that arrive over the relay. Reaching the daemon from
// outside the LAN is a higher-risk path than a call on the trusted LAN, so an
// operator can require that state-changing calls carry fresh proof of presence.
//
// This module holds the POLICY and the verb-metadata signal (mutating vs read).
// The WebAuthn verification itself lives in relay/step-up-service.ts (the
// credential and challenge stores) and relay/step-up-webauthn.ts (the signature
// check); relay/daemon-wiring.ts always installs that verifier in front of the
// relay dispatch. A mutating relay call is allowed only when the verifier
// genuinely confirmed a fresh assertion.

/** Header carrying an opaque WebAuthn step-up assertion on a tunneled request. */
export const STEP_UP_ASSERTION_HEADER = 'x-goodvibes-stepup-assertion';

/**
 * Verifies a step-up assertion. Returns true only on genuine verification
 * (StepUpService.createVerifier is the daemon's implementation). `context`
 * carries the request essentials a verifier binds against.
 */
export type StepUpAssertionVerifier = (
  assertion: string,
  context: { readonly method: string; readonly path: string },
) => Promise<boolean>;

/** The outcome of a step-up policy evaluation. */
export type StepUpDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly code: 'step-up-required'; readonly message: string };

/** Inputs to a step-up evaluation, all already-resolved facts, so this is pure. */
export interface StepUpEvaluationInput {
  /** Did the request arrive over the relay (vs the trusted LAN)? */
  readonly viaRelay: boolean;
  /** Is the call state-changing (mutating verb)? */
  readonly mutating: boolean;
  /** Is the step-up requirement switched on? */
  readonly requireStepUp: boolean;
  /** Verification result: true = genuinely verified, false = present-but-invalid or absent. */
  readonly assertionVerified: boolean;
}

/** HTTP methods that do not change state. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Whether an HTTP method is mutating. This mirrors the operator catalog, where
 * read-only methods carry `read:<domain>` scope and a GET binding while mutating
 * methods carry `write:<domain>` and a POST/PUT/PATCH/DELETE binding.
 */
export function isMutatingMethod(method: string): boolean {
  return !READ_METHODS.has(method.toUpperCase());
}

/**
 * Decide whether a request may proceed. The control only bites on mutating
 * relay calls when the requirement is enabled; every other request is allowed
 * unchanged. When it does bite, it fails closed unless a verifier genuinely
 * confirmed a fresh assertion.
 */
export function evaluateStepUp(input: StepUpEvaluationInput): StepUpDecision {
  if (!input.viaRelay || !input.mutating || !input.requireStepUp) {
    return { allow: true };
  }
  if (input.assertionVerified === true) {
    return { allow: true };
  }
  return {
    allow: false,
    code: 'step-up-required',
    message: 'This mutating call arrived over the relay and requires a recent WebAuthn step-up assertion.',
  };
}
