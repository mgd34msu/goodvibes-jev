/**
 * Conversation-first CONTINUATION gate, the follow-up half of the spawn gate.
 *
 * `surface-conversation-gate.ts` guards the first spawn of an inbound channel
 * message. It is not the only way an agent starts: a shared session also has a
 * continuation runner, which the broker calls when a queued follow-up input is
 * ready (SharedSessionBroker.runQueuedFollowUp). A spawn from that runner that
 * is not outside every contract starts a contract, so a message that the
 * ingress gate had correctly answered conversationally could still become
 * planned, checked contract work one hop later.
 *
 * This module owns the single rule both continuation runners now consult, and
 * it lives in the SDK rather than in one product because the daemon, the TUI
 * runtime, and goodvibes-agent each install their own continuation runner. A
 * copy that lives in one of them protects only that one.
 *
 * THE RULE, in order:
 *
 * 1. An explicit authorization marker on the input starts a contract. The marker
 *    is written by whatever already confirmed the work, an agreed work
 *    proposal, a schedule, a trigger, an on-exit chain of commands.
 * 2. A follow-up typed on a LOCAL surface (the terminal UI the operator is
 *    sitting in front of) starts a contract. That is the surface's whole point,
 *    and it is exactly the exemption the ingress gate makes.
 * 3. Everything else is conversation: the follow-up gets a real answer, outside
 *    every contract.
 *
 * Absent, malformed, or unrecognized authorization is NOT authorization. The
 * failure mode of this module is an answer where a workstream was wanted, which
 * the owner can correct with one more message; the opposite failure mode is
 * twenty notifications and a contract nobody asked for.
 */
import {
  CONVERSATION_GATE_DEFAULTS,
  isGatedSurface,
  readConversationGateConfig,
  type ConversationGateConfigReader,
} from './conversation-gate.js';

/**
 * Metadata key marking a session input as already-authorized work.
 *
 * Shared BY VALUE across surfaces (like a header name): it crosses process and
 * version boundaries on the session input's open metadata record, so a reader
 * on an older build simply does not find it and treats the input as
 * conversation. Changing this string is a wire-format change.
 */
export const WORK_AUTHORIZED_METADATA_KEY = 'goodvibes.workAuthorized';

/** Why a continuation was or was not allowed to start a contract. */
export type ContinuationEscalation =
  | { readonly startsContract: true; readonly reason: 'pre-authorized' | 'local-surface' }
  | { readonly startsContract: false; readonly reason: 'conversation-first' };

/**
 * The shape this module reads. Deliberately structural and fully optional so
 * both `SharedSessionInputRecord` and a bare `{ metadata }` bag satisfy it, and
 * so a caller on an older record shape cannot fail to compile.
 */
export interface ContinuationInputLike {
  readonly metadata?: Record<string, unknown> | undefined;
  readonly surfaceKind?: string | undefined;
  readonly body?: string | undefined;
}

export interface ContinuationEscalationOptions {
  /**
   * Reads `conversationGate.*`. Supplied by the daemon and the TUI runtime so
   * an operator who set `conversationGate.mode = 'off'` gets the legacy
   * behavior here too, and so a surface removed from `gatedSurfaces` is not
   * gated in one half of the platform and not the other.
   *
   * Absent = the defaults in conversation-gate.ts, which gate every channel
   * surface and exempt local ones.
   */
  readonly configReader?: ConversationGateConfigReader | undefined;
}

/** True when the input carries the explicit work-authorized marker. */
export function readWorkAuthorization(metadata: Record<string, unknown> | undefined): boolean {
  const marker = metadata?.[WORK_AUTHORIZED_METADATA_KEY];
  // Accept the boolean and the string: the marker crosses a JSON wire and some
  // surfaces stringify metadata values. Nothing else counts.
  return marker === true || marker === 'true';
}

/**
 * Decide whether a session continuation may start a contract.
 */
export function decideContinuationEscalation(
  input: ContinuationInputLike | undefined,
  options: ContinuationEscalationOptions = {},
): ContinuationEscalation {
  if (readWorkAuthorization(input?.metadata)) {
    return { startsContract: true, reason: 'pre-authorized' };
  }
  const config = options.configReader
    ? readConversationGateConfig(options.configReader)
    : CONVERSATION_GATE_DEFAULTS;
  // `isGatedSurface` is the same predicate the ingress gate uses, so the two
  // halves cannot disagree about what counts as a local surface, including
  // its deliberate choice to gate an UNKNOWN surface rather than wave it
  // through.
  return isGatedSurface(config, input?.surfaceKind)
    ? { startsContract: false, reason: 'conversation-first' }
    : { startsContract: true, reason: 'local-surface' };
}

/**
 * The spawn-input fragment implementing the decision. Spreading this into a
 * spawn call is the whole integration:
 *
 *   agentManager.spawn({ mode: 'spawn', task, ...continuationContractOptions(input) })
 */
export function continuationContractOptions(
  input: ContinuationInputLike | undefined,
  options: ContinuationEscalationOptions = {},
): { readonly outsideContract?: true; readonly replyStyle?: 'conversational' } {
  // `replyStyle` rides with the contract decision rather than being a second,
  // separately-derived judgement: a continuation that is conversation gets a
  // conversational REPLY, not a completion report addressed to nobody. The
  // ingress gate (daemon/surface-conversation-gate.ts) pairs the same two
  // fields for the first message of a conversation; this is the follow-up half.
  return decideContinuationEscalation(input, options).startsContract
    ? {}
    : { outsideContract: true, replyStyle: 'conversational' };
}

/**
 * Mark a metadata record as authorized work. Used by the paths that ALREADY
 * hold the owner's confirmation: an agreed work proposal, a schedule, a
 * trigger, an on-exit chain.
 */
export function markWorkAuthorized(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return { ...(metadata ?? {}), [WORK_AUTHORIZED_METADATA_KEY]: true };
}
