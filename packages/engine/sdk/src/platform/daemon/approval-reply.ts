/** Channel-owner replies to permission asks, through the shared ApprovalBroker. */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { LIMITS, toJson, type Selection } from '@goodvibes-jev/judgment';
import type { ChannelIngressPolicyInput, ChannelPolicyDecision, RouteBindingManager } from '../channels/index.js';
import type { ApprovalBroker, SharedApprovalRecord } from '../control-plane/approval-broker.js';
import { logger } from '../utils/logger.js';
import { assertJudgmentInput } from '../gate/judgment-input.js';
import { channelApprovalReply, channelApprovalTarget } from './batteries/approval-reply.js';

export type ApprovalReplyBroker = Pick<ApprovalBroker, 'listApprovals' | 'resolveApproval'>;

const SITE = 'daemon.approval-reply';
const isPending = (record: SharedApprovalRecord): boolean => record.status === 'pending' || record.status === 'claimed';
function proposalFor(record: SharedApprovalRecord) {
  const proposal = {
    approvalId: record.id,
    tool: record.request.tool,
    summary: record.request.analysis.summary,
    arguments: record.request.args,
  };
  // Direct or restored broker asks can predate the tool gate's input check.
  // Inspect raw data before JSON serialization can invoke accessors/toJSON.
  assertJudgmentInput(proposal, record.request.tool);
  return toJson(proposal);
}

/** Only routing/source identity, not mutable last-seen timestamps or audit metadata. */
function sourceKey(record: SharedApprovalRecord, routes: Pick<RouteBindingManager, 'getBinding'>): string {
  const binding = record.routeId ? routes.getBinding(record.routeId) : undefined;
  return JSON.stringify([
    record.callId, record.request.callId, record.sessionId, record.routeId,
    binding?.id, binding?.surfaceKind, binding?.surfaceId, binding?.externalId,
    binding?.channelId, binding?.threadId, binding?.sessionId,
  ]);
}

/**
 * Only an authorized owner can answer. Surface-bound asks remain preferred;
 * without one, only the single platform-wide ask is eligible. These are
 * structural boundaries, not judgments. With several eligible asks the
 * selector must identify exactly one before the reply is read against it.
 * Unclear or unsettled readings consume nothing; unavailable judgment throws
 * and leaves every ask waiting. There is no heuristic fallback.
 */
export async function tryResolveApprovalReplyFromChannel(
  input: ChannelIngressPolicyInput,
  decision: ChannelPolicyDecision,
  deps: {
    readonly approvalBroker?: ApprovalReplyBroker | undefined;
    readonly routeBindings: Pick<RouteBindingManager, 'getBinding'>;
  },
): Promise<boolean> {
  const broker = deps.approvalBroker;
  const { userId, surface, text } = input;
  if (!broker || !decision.allowed || !userId || !text?.trim()) return false;
  const owners = decision.matchedGroupPolicy?.allowlistUserIds ?? decision.policy.allowlistUserIds;
  if (owners.length === 0 || !owners.includes(userId)) return false;

  // Inspect all pending records: truncating newest-first can hide ambiguity.
  const pending = broker.listApprovals(Number.MAX_SAFE_INTEGER).filter(isPending);
  const surfaceBound = pending.filter((record) => {
    if (!record.routeId) return false;
    return deps.routeBindings.getBinding(record.routeId)?.surfaceKind === surface;
  });
  const candidates = surfaceBound.length > 0 ? surfaceBound : pending.length === 1 ? pending : [];
  // A selector has one additional option for none. Never truncate candidates.
  if (candidates.length === 0 || candidates.length >= LIMITS.maxChoiceOptions) return false;

  // Validate every candidate and the full reply before any request starts.
  // Keep this safe snapshot across the asynchronous selection/reply steps.
  assertJudgmentInput(text);
  const offers = candidates.map((record) => ({
    id: record.id, content: proposalFor(record), source: sourceKey(record, deps.routeBindings),
  }));
  const port = judgmentPort(SITE);
  let target = offers[0]!;
  let selection: Selection | undefined;
  if (candidates.length > 1) {
    selection = await channelApprovalTarget.select(port, { reply: text }, offers, { site: SITE });
    const chosen = offers.find((offer) => offer.id === selection?.chosen);
    // All fits must be settled and exactly one must fit. Conflicting fits are
    // ambiguity even when the relative pick itself looks confident.
    const fits = Object.values(selection.fits);
    if (!chosen || selection.outcome !== 'act' || fits.some((fit) => fit.outcome !== 'act')
      || fits.filter((fit) => fit.verdict === 'yes').length !== 1) {
      selection.recordAction('no resolution: target unclear or unsettled');
      return false;
    }
    target = chosen;
    selection.recordAction(`selected approval ${target.id}; awaiting reply reading`);
  }

  const reply = await channelApprovalReply.read(port, target.content, text, { site: SITE });
  if (reply.reading.outcome !== 'act' || reply.reading.choice === 'unclear') {
    const action = `no resolution: reply ${reply.reading.choice} (${reply.reading.outcome})`;
    reply.recordAction(action);
    selection?.recordAction(action);
    return false;
  }
  // Re-check the exact proposal and its source after the asynchronous readings.
  const current = broker.listApprovals(Number.MAX_SAFE_INTEGER).find((record) => record.id === target.id);
  if (!current || !isPending(current)) {
    reply.recordAction(`no resolution: approval ${target.id} is no longer pending`);
    selection?.recordAction(`no resolution: approval ${target.id} is no longer pending`);
    return false;
  }

  if (sourceKey(current, deps.routeBindings) !== target.source
    || JSON.stringify(proposalFor(current)) !== JSON.stringify(target.content)) {
    const action = `no resolution: approval ${target.id} proposal or route changed`;
    reply.recordAction(action);
    selection?.recordAction(action);
    return false;
  }

  const approved = reply.reading.choice === 'approve';
  // Record the decision before its side effect. A recording failure cannot
  // authorize an action without the underlying reading in the decision log.
  const action = `resolve approval ${target.id}: ${reply.reading.choice}`;
  reply.recordAction(action);
  selection?.recordAction(action);
  await broker.resolveApproval(target.id, {
    approved,
    actor: userId,
    actorSurface: surface,
    // Preserve ALL owner guidance without guessing where a verb ends. Amend
    // declines the original arguments and returns the requested change to the
    // waiting model; it never executes an unchanged conditional approval.
    note: text.trim(),
    reason: text.trim(),
  });
  logger.info('Pending approval resolved from a channel reply', {
    surface,
    userId,
    approvalId: target.id,
    approved,
    reading: reply.reading.choice,
    replyDecisionId: reply.decisionId,
    targetDecisionId: selection?.decisionId,
  });
  return true;
}
