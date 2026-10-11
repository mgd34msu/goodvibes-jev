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
import { captureJudgmentPort, judgmentPort } from '@goodvibes-jev/engine/errors';
import { assertProjectionCurrent } from '../input-projection.js';
import { childFailureReason, childFailureView } from '../batteries/child-failure-reason.js';
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

const CHILD_FAILURE_SITE = 'tools.agent.child-failure-reason';

interface ChildFailureReadingOptions {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}

function assertChildFailureCurrent(options: ChildFailureReadingOptions | undefined): void {
  options?.signal?.throwIfAborted();
  assertProjectionCurrent(options?.assertCurrent);
  options?.signal?.throwIfAborted();
}

/**
 * Classify why a child terminated. Cancellation and a stamped
 * `failureReason` are structure and decide in code; a free-text error is
 * read by `engine.tools.child-failure-reason` over the envelope's closed set
 * of codes. A reading that does not act is reported as `error`, the code for
 * a failure the envelope does not place.
 */
export async function classifyChildFailureReason(
  record: Pick<AgentRecord, 'status' | 'terminationKind' | 'error' | 'failureReason'>,
  options?: ChildFailureReadingOptions,
): Promise<ChildFailureReasonCode> {
  assertChildFailureCurrent(options);
  if (record.status === 'cancelled') {
    const code = record.terminationKind === 'interrupt' ? 'interrupted' : 'killed';
    assertChildFailureCurrent(options);
    return code;
  }
  if (record.failureReason && STAMPED_REASON_CODES.has(record.failureReason)) {
    const code = record.failureReason as ChildFailureReasonCode;
    assertChildFailureCurrent(options);
    return code;
  }
  const error = record.error?.trim() ?? '';
  if (error.length === 0) { assertChildFailureCurrent(options); return 'error'; }
  const authority = options?.signal === undefined && options?.assertCurrent === undefined
    ? undefined : captureJudgmentPort(CHILD_FAILURE_SITE, options);
  const port = authority?.port ?? judgmentPort(CHILD_FAILURE_SITE);
  const state = childFailureView(error);
  assertChildFailureCurrent(options);
  const run = await childFailureReason.run(port, state, {
    site: CHILD_FAILURE_SITE,
    ...(authority ? { signal: authority.signal } : {}),
  });
  authority?.assertCurrent();
  const reading = run.readings.reason;
  const code: ChildFailureReasonCode = reading.outcome === 'act' ? reading.choice : 'error';
  authority?.assertCurrent();
  run.recordAction(`reported ${code}`);
  authority?.assertCurrent();
  return code;
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
  opts?: ChildFailureReadingOptions & { readonly transcriptTail?: readonly ConversationMessageSnapshot[] | undefined },
): Promise<ChildFailureEnvelope> {
  const reasonCode = await classifyChildFailureReason(record, opts);
  // A failed record whose fullOutput is the failure message itself would merely
  // echo reason.message; treat that as "no genuine output" so partialOutputs
  // stays honest rather than redundant.
  const lastOutput = record.fullOutput
    && record.fullOutput.trim().length > 0
    && record.fullOutput.trim() !== (record.error ?? '').trim()
    ? record.fullOutput
    : undefined;
  const transcriptTail = summarizeTranscriptTail(opts?.transcriptTail);
  const turnsCompleted = record.usage?.turnCount;
  const producedNothing = !lastOutput && (!transcriptTail || transcriptTail.length === 0);
  const envelope: ChildFailureEnvelope = {
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
  assertChildFailureCurrent(opts);
  return envelope;
}
