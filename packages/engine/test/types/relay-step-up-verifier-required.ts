/**
 * Compile-time pin: the relay step-up gate always has a verifier.
 *
 * buildDaemonRelayReachability used to take the step-up verifier as an optional
 * last argument. Leaving it out compiled, and with relay.requireStepUpForMutations
 * on, every mutating relay call was then refused with a "no verifier is
 * configured" error even though the daemon ships a real WebAuthn verifier
 * (StepUpService.createVerifier). The policy input carried a matching `null`
 * state for "no verifier". Both are gone: the verifier is a required argument
 * and the policy reads only verified or not verified.
 *
 * Checked by `bun run types:check`.
 */
import type { StepUpEvaluationInput, buildDaemonRelayReachability } from '@goodvibes-jev/engine/sdk/platform/relay';

type BuildArgs = Parameters<typeof buildDaemonRelayReachability>;

// The verifier is the sixth argument and it is not optional.
// @ts-expect-error, a call that leaves out the verifier does not compile
const withoutVerifier: BuildArgs = [] as unknown as [BuildArgs[0], BuildArgs[1], BuildArgs[2], BuildArgs[3], BuildArgs[4]];

const noVerifierState: StepUpEvaluationInput = {
  viaRelay: true,
  mutating: true,
  requireStepUp: true,
  // @ts-expect-error, there is no "no verifier" state to report
  assertionVerified: null,
};

export { withoutVerifier, noVerifierState };
