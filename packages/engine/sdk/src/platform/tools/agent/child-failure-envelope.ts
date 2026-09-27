// Child-failure envelopes.
//
// STANDING RULE: a child agent that dies on an API error, watchdog kill, budget
// exhaustion, an exhausted turn/circuit-breaker loop, or a cancel/kill must
// deliver a structured {agentId, phase, reason, partialOutputs} envelope to its
// supervising parent as the RESULT of the parent's poll (status/get/wait/
// cohort-report), never a silent stall and never a bare status string. The
// envelope is assembled ENTIRELY from what the child's own record + transcript
// actually hold; partialOutputs is whatever the child genuinely produced (its
// last committed output and a transcript-tail summary), never fabricated.
import { readFailure } from '@goodvibes-jev/engine/errors';
import type { AgentRecord } from './manager.js';
import type { ConversationMessageSnapshot } from '../../core/conversation.js';

/** Structured reason code for why a child terminated abnormally. */
export type ChildFailureReasonCode =
  | 'max_turns'
  | 'circuit_breaker'
  | 'watchdog_timeout'
  | 'budget_exhausted'
  | 'claim_unverified'
  | 'api_error'
  | 'killed'
  | 'interrupted'
  | 'error';

export interface ChildFailureEnvelope {
  readonly agentId: string;
  /** The lifecycle phase the child was in when it terminated (best-effort, honest). */
  readonly phase: string;
  readonly reason: {
    readonly code: ChildFailureReasonCode;
    /** The child record's own error text, never invented. */
    readonly message: string;
  };
  readonly partialOutputs: {
    /** The child's last committed assistant output (record.fullOutput), if any. */
    readonly lastOutput?: string | undefined;
    /** A short, role-tagged summary of the last transcript messages, if available. */
    readonly transcriptTail?: readonly string[] | undefined;
    /** How many turns the child completed before terminating, when known. */
    readonly turnsCompleted?: number | undefined;
    /** Honest note, set when the child produced nothing before it died. */
    readonly note?: string | undefined;
  };
}

/** True when a record is in a terminal state that warrants a failure envelope. */
export function isChildFailureTerminal(record: Pick<AgentRecord, 'status'>): boolean {
  return record.status === 'failed' || record.status === 'cancelled';
}

/**
 * The reason codes code stamps on `record.failureReason` where it produces the
 * failure itself (the turn budget, the circuit breaker, a silence watchdog, a
 * budget ceiling, a claims check): a fixed format, read as code.
 */
const STAMPED_REASON_CODES: ReadonlySet<string> = new Set<ChildFailureReasonCode>([
  'max_turns',
  'circuit_breaker',
  'watchdog_timeout',
  'budget_exhausted',
  'claim_unverified',
]);

/**
 * Classify why a child terminated. Cancellation and a stamped
 * `failureReason` are structure and decide in code; only a free-text error
 * (a provider, transport or tool failure) is read, with the engine's failure
 * reading, and any failure it can place in a category is an API error.
 */
export async function classifyChildFailureReason(
  record: Pick<AgentRecord, 'status' | 'terminationKind' | 'error' | 'failureReason'>,
): Promise<ChildFailureReasonCode> {
  if (record.status === 'cancelled') {
    return record.terminationKind === 'interrupt' ? 'interrupted' : 'killed';
  }
  if (record.failureReason && STAMPED_REASON_CODES.has(record.failureReason)) {
    return record.failureReason as ChildFailureReasonCode;
  }
  const error = record.error?.trim() ?? '';
  if (error.length === 0) return 'error';
  const reading = await readFailure({ message: error }, 'tools.agent.child-failure-reason');
  return reading.category === 'unknown' ? 'error' : 'api_error';
}

/** Best-effort, honest lifecycle phase label from what the record records. */
export function describeChildPhase(
  record: Pick<AgentRecord, 'status' | 'progress' | 'contractRole'>,
): string {
  if (record.status === 'pending') return 'spawning';
  if (record.contractRole) return `contract:${record.contractRole}`;
  if (record.progress && record.progress.trim().length > 0) return record.progress;
  return record.status;
}

function previewContent(content: string | readonly unknown[], max = 160): string {
  const text = typeof content === 'string' ? content : `[${content.length} content part(s)]`;
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function summarizeTranscriptTail(
  snapshot: readonly ConversationMessageSnapshot[] | undefined,
  limit = 4,
): string[] | undefined {
  if (!snapshot || snapshot.length === 0) return undefined;
  return snapshot.slice(-limit).map((m) => {
    if (m.role === 'tool') return `tool(${m.toolName ?? m.callId}): ${previewContent(m.content)}`;
    return `${m.role}: ${previewContent(m.content)}`;
  });
}

/**
 * Assemble the failure envelope from the child's record plus (optionally) a
 * transcript-tail snapshot the caller fetched from the AgentManager. Everything
 * here is drawn from real recorded state, nothing is fabricated.
 */
export async function buildChildFailureEnvelope(
  record: AgentRecord,
  opts?: { readonly transcriptTail?: readonly ConversationMessageSnapshot[] | undefined },
): Promise<ChildFailureEnvelope> {
  const reasonCode = await classifyChildFailureReason(record);
  // A failed WRFC owner's fullOutput is set to the failure message itself
  // (completeOwnerAgent), which would merely echo reason.message, treat that as
  // "no genuine output" so partialOutputs stays honest rather than redundant.
  const lastOutput = record.fullOutput
    && record.fullOutput.trim().length > 0
    && record.fullOutput.trim() !== (record.error ?? '').trim()
    ? record.fullOutput
    : undefined;
  const transcriptTail = summarizeTranscriptTail(opts?.transcriptTail);
  const turnsCompleted = record.usage?.turnCount;
  const producedNothing = !lastOutput && (!transcriptTail || transcriptTail.length === 0);
  return {
    agentId: record.id,
    phase: describeChildPhase(record),
    reason: {
      code: reasonCode,
      message: record.error ?? (record.status === 'cancelled' ? 'Agent was cancelled.' : 'Agent failed without an error message.'),
    },
    partialOutputs: {
      ...(lastOutput ? { lastOutput } : {}),
      ...(transcriptTail ? { transcriptTail } : {}),
      ...(turnsCompleted !== undefined ? { turnsCompleted } : {}),
      ...(producedNothing ? { note: 'The child produced no committed output before terminating.' } : {}),
    },
  };
}
