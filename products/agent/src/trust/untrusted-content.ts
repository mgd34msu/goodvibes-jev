/**
 * The untrusted-content contract, as this surface reaches it.
 *
 * The agent can read the open web and act in the real world in the same turn.
 * That puts both halves of a prompt-injection chain inside one process: it
 * reads text written by whoever controls a page or a mailbox, and it holds the
 * ability to send, submit, buy, and change settings. The boundary that answers
 * it, content labelled where it enters, instructions inside it never followed,
 * those surfaces carrying no command authority, and outward effects
 * unavailable rather than discouraged once untrusted content is in the turn,
 * used to be defined here.
 *
 * It is defined in the SDK now (`platform/security/untrusted-content.ts`), and
 * this module is the re-export.
 *
 * That was the right move for the same reason the definition was right to live
 * here originally: the wording and the ledger belong wherever the composition
 * happens, and while the agent was the only runtime that could both read a page
 * and send a message, that was here. It is not any more. The daemon serves
 * `browser.*` and `email.*` on its own, with no surface attached, and a
 * scheduled job that reads a page and then mails someone is exactly the
 * composition rule 4 exists for. A second copy of the refusal wording inside
 * the daemon would have drifted from this one inside a release, and a boundary
 * that says one thing in the agent and another in the daemon is not one
 * boundary.
 *
 * Every name below keeps its meaning and its signature, so no caller changed.
 * The one thing worth knowing: `getSessionUntrustedContentLedger` now returns
 * the SDK's PROCESS ledger. For this binary that is the same instance it always
 * was, one per agent process, shared by the browser tool and the mail surface.
 * For a build that embeds a daemon in this process, it is also the daemon's,
 * which is the correct answer rather than a coincidence: two ledgers in one
 * process would each see one half of a composition.
 */

export {
  UNTRUSTED_CONTENT_RULE,
  UntrustedContentLedger,
  evaluateOutwardEffect,
  getProcessUntrustedContentLedger as getSessionUntrustedContentLedger,
  grantOwnerApproval,
  labelUntrustedContent,
  originOf,
  resetProcessUntrustedContentLedgerForTests as resetSessionUntrustedContentLedgerForTests,
  surfaceHasCommandAuthority,
} from '@goodvibes-jev/engine/sdk/platform/security';

export type {
  AuthoritySurface,
  OutwardEffectDecision,
  OutwardEffectRequest,
  OwnerApproval,
  UntrustedContentEnvelope,
  UntrustedIngest,
  UntrustedSurface,
} from '@goodvibes-jev/engine/sdk/platform/security';
