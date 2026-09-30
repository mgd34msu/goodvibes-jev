/**
 * surface-card-gate.ts, refuse card-shaped and protected credential content
 * arriving on a remote messaging channel before judgment or persistence
 * (docs/inbound-email.md §11.0).
 *
 * **Provenance, stated plainly: §11.0 is a coordinator ruling, not an owner
 * quote.** Design rule it enforces: card details are entered only at a local
 * terminal or in the webui, never over a remote messaging channel. This is the
 * daemon-side enforcement of that.
 *
 * ## The distinction that must not be collapsed
 *
 * Approvals and vetoes for purchases **do** work over remote channels. That is
 * the owner's explicit ruling and it stays. Remote surfaces have authority to
 * **say yes or no about a purchase**; they have **no path for entering the
 * instrument**. Authority over a decision is not a channel for a secret. A
 * later reader will be tempted to unify the two, "if the owner can approve a
 * payment from Telegram, why not enter the card there", and must not.
 *
 * This is also why the refusal reply is delivered rather than dropped silently:
 * the message being refused may itself have BEEN a veto, and an unheard
 * objection inside a veto window elapses into a completed purchase. Silence is
 * the one response here that can cost money.
 *
 * ## Why this lives on the shared ingress hook and not in the adapters
 *
 * `authorizeSurfaceIngress` is the single hook all nineteen remote adapter call
 * sites already pass through, the same reason work-proposal and approval-reply
 * consumption live there. The payments round learned the alternative firsthand:
 * a fix applied per-adapter leaves the other seventeen open.
 *
 * ## Why it runs FIRST
 *
 * Before `evaluateIngress`, before proposal-reply resolution, before
 * approval-reply resolution. This is not stylistic. `evaluateIngress` writes
 * `input.text.slice(0, 200)` into the channel policy audit trail and schedules
 * that trail to disk; running the gate second would persist the digits it
 * exists to keep off disk. Everything downstream may store, log or transcribe,
 * so the check must precede all of it.
 */
import type { ChannelIngressPolicyInput, ChannelPolicyDecision, ChannelPolicyManager } from '../channels/index.js';
import { logger } from '../utils/logger.js';
import { JudgmentInputError, judgmentInputProblem, type JudgmentInputProblem } from '../gate/judgment-input.js';
import { cardShapeKinds, detectCardShapes, findCardNumberShapes, renderCardShapeRefusal } from '../security/card-shapes.js';
import {
  deliverProposalNotice,
  resolveOriginBinding,
  type ConversationGateDeps,
} from './surface-conversation-gate.js';

export interface SurfaceCardGateDeps
  extends Pick<ConversationGateDeps, 'routeBindings' | 'sessionBroker' | 'deliverSurfaceNotice'> {
  /** Read-only. The gate needs a policy record for the decision it returns and must NOT evaluate ingress to get one. */
  readonly channelPolicy: Pick<ChannelPolicyManager, 'getPolicy'>;
}

/** Decision reason prefix. The suffix names the matched shape KINDS, never the digits. */
export const CARD_SHAPES_REFUSED_REASON = 'card-shapes-refused';
export const JUDGMENT_INPUT_REFUSED_REASON = 'judgment-input-refused';

/** Report a protected-input refusal without an audit write, model call or raw value. */
async function refuseProtectedInput(
  deps: SurfaceCardGateDeps,
  input: ChannelIngressPolicyInput,
  problem: JudgmentInputProblem,
): Promise<ChannelPolicyDecision> {
  const binding = resolveOriginBinding(deps, {
    surface: input.surface,
    ...(input.userId !== undefined ? { userId: input.userId } : {}),
    ...(input.channelId !== undefined ? { channelId: input.channelId } : {}),
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
  });
  const outcome = await deliverProposalNotice(deps, binding,
    `${new JudgmentInputError(problem).message} Approving or vetoing an action still works here; resend your answer without protected values.`);
  logger.warn('Refused protected input on a remote channel before judgment', {
    surface: input.surface, problem, refusalDelivered: outcome.delivered,
  });
  return {
    allowed: false,
    reason: `${JUDGMENT_INPUT_REFUSED_REASON}:${problem}`,
    policy: deps.channelPolicy.getPolicy(input.surface),
  };
}

/**
 * Inspect one inbound message for card shapes and protected judgment input.
 *
 * Returns `null` when there is nothing to refuse, which is the overwhelming
 * majority of messages and the only path that continues to policy evaluation.
 * Returns a not-allowed `ChannelPolicyDecision` when card shapes are present,
 * having first put a refusal on the same channel the message arrived on.
 *
 * No raw values from `input.text` reach logs, reasons, notices or stores:
 * outward strings name only fixed card-shape or judgment-input problem kinds.
 */
export async function refuseCardShapedIngress(
  deps: SurfaceCardGateDeps,
  input: ChannelIngressPolicyInput,
): Promise<ChannelPolicyDecision | null> {
  const text = input.text;
  if (typeof text !== 'string' || text.length === 0) return null;

  // A definite PAN already refuses the message. Do not send accompanying
  // prose (which may contain other credentials) to the optional card-talk
  // reading just to decide whether more card shapes should be named.
  const pans = findCardNumberShapes(text);
  const problem = pans.length === 0 ? judgmentInputProblem(text) : undefined;
  if (problem !== undefined) return refuseProtectedInput(deps, input, problem);
  const findings = pans.length > 0 ? pans : await detectCardShapes(text);
  if (findings.length === 0) return null;

  const kinds = cardShapeKinds(findings);

  // The policy record comes from a plain read, deliberately: evaluateIngress
  // would have produced one too, and would have written the message text to the
  // audit trail on the way. getPolicy touches nothing.
  const decision: ChannelPolicyDecision = {
    allowed: false,
    reason: `${CARD_SHAPES_REFUSED_REASON}:${kinds.join(',')}`,
    policy: deps.channelPolicy.getPolicy(input.surface),
  };

  // Tell the owner, on the channel they sent from, through the same delivery path
  // the conversation gate uses for its proposals. They can resend without the digits
  //, including resending a veto, which is the case that makes silence costly.
  const binding = resolveOriginBinding(deps, {
    surface: input.surface,
    ...(input.userId !== undefined ? { userId: input.userId } : {}),
    ...(input.channelId !== undefined ? { channelId: input.channelId } : {}),
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    // No `text`, the origin this gate builds must not carry the refused message.
  });
  const outcome = await deliverProposalNotice(deps, binding, renderCardShapeRefusal(findings));

  logger.warn('Refused a message carrying card-shaped content on a remote channel', {
    surface: input.surface,
    kinds,
    findingCount: findings.length,
    refusalDelivered: outcome.delivered,
    ...(outcome.delivered ? {} : { refusalUndeliverableReason: outcome.reason }),
  });

  return decision;
}
