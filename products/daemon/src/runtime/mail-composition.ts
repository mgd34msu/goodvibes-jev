/**
 * mail-composition.ts
 *
 * The deps that let the platform register this daemon's `email.*` verbs.
 *
 * `calendar.*` and `email.*` are served by the platform now, not by handlers in
 * this repository, those were deleted when the platform gained an
 * implementation the daemon could call. What is left for a product to supply is
 * the wiring, and it is not optional: without `homeDirectory` the calendar
 * composition returns null, without these deps the mail one does, and either way
 * the verbs stay cataloged-but-unhandled while every surface reports the daemon
 * unreachable on a daemon that is working perfectly.
 *
 * Extracted from services.ts rather than living there, because that file sits at
 * the 800-line architecture cap and a composition step is exactly the kind of
 * thing the cap exists to push into a module of its own.
 */

import {
  withSurfaceEmailConfig,
  describeSurfaceEmailConfigProblem,
  describeSenderClaimNeutrally,
  EmailReplySubjectSourceOwner,
  type EmailServiceDeps,
  type SurfaceEmailConfigProblem,
} from '@goodvibes-jev/engine/sdk/platform/email';
import { nodeEmailTransport } from '@goodvibes-jev/engine/sdk/platform/email/node';

/** The narrow slices this composition needs; the real managers satisfy them. */
interface MailCompositionInput {
  readonly configManager: {
    get(key: string): unknown;
    onDidInvalidate?(listener: () => void): () => void;
  };
  readonly secretsManager: {
    get(key: string): Promise<string | null>;
    onDidChange?(listener: (key: string) => void): () => void;
  };
  /** Required to issue source snapshots, optional for existing narrow embedders. */
  readonly registerDispose?: ((dispose: () => void) => void) | undefined;
}

/**
 * Build the mail deps and the not-configured describer that go to
 * `registerGatewayVerbGroups`.
 *
 * The settings come from the daemon's own `surfaces.email.*` keys through
 * `withSurfaceEmailConfig`, so the keys an operator has already set, and that
 * the settings modal now shows, keep working unchanged, and a not-configured
 * answer names the keys THIS operator actually has rather than the ones the
 * service validates internally.
 */
export function composeMailDeps(input: MailCompositionInput): {
  readonly emailServiceDeps: EmailServiceDeps;
  readonly describeEmailConfigProblem: () => Promise<SurfaceEmailConfigProblem | null>;
} {
  const getConfig = (key: string): unknown => input.configManager.get(key);
  let replySubjectSourceOwner: EmailReplySubjectSourceOwner | undefined;
  if (input.configManager.onDidInvalidate && input.secretsManager.onDidChange && input.registerDispose) {
    const owner = new EmailReplySubjectSourceOwner();
    const stopConfig = input.configManager.onDidInvalidate(() => owner.invalidate());
    // Stored credentials can be references to other local secret keys. The
    // dependency chain is deliberately not read here; any secret mutation
    // conservatively retires this account's observed snapshots, including ABA.
    const stopSecrets = input.secretsManager.onDidChange(() => owner.invalidate());
    input.registerDispose(() => {
      owner.dispose();
      stopConfig();
      stopSecrets();
    });
    replySubjectSourceOwner = owner;
  }
  const emailServiceDeps = withSurfaceEmailConfig({
    replySubjectSourceOwner,
    getConfig,
    secretsManager: input.secretsManager,
    transport: nodeEmailTransport,
    // The daemon has no wording of its own for a sender line, so it takes the
    // platform's rather than growing a second implementation of a rule that is
    // security-relevant: a From: header is a claim, sender authentication
    // raises display confidence only, and commandAuthority is the literal
    // 'none'.
    describeSenderClaim: describeSenderClaimNeutrally,
  });
  return {
    emailServiceDeps,
    describeEmailConfigProblem: () =>
      describeSurfaceEmailConfigProblem(getConfig, input.secretsManager),
  };
}
