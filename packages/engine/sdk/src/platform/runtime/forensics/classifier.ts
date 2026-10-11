/**
 * ForensicsClassifier, auto-classifies failures from event context.
 *
 * Maps combinations of stop reasons, error messages, event sequences,
 * and cascade presence to a FailureClass without requiring manual log
 * spelunking.
 *
 * The ladder's rungs are code except one: cancellation, stop-reason values
 * and the cascade, tool, permission and compaction flags are exact checks.
 * What the free-text error message says is read by Jev through the engine's
 * shared failure reading (readFailure in @goodvibes-jev/engine/errors). That
 * reading already asks what kind of failure an error's wording describes and
 * remembers each wording, so the retry and display paths and this classifier
 * read one error once instead of asking a second battery the same question.
 * Its category is 'unknown' unless the reading is confident enough to act on,
 * which is the coarsening this rung needs: an unsure reading falls through to
 * the stop-reason rungs below it, as unmatched wording always did.
 */
import { readFailure, captureJudgmentPort, type FailureCategory } from '@goodvibes-jev/engine/errors';
import type { OwnedJudgmentOptions } from '../owned-judgment-work.js';
import type { FailureClass } from './types.js';

/** Decision site for the error-message rung. */
export const FORENSICS_CLASSIFIER_SITE = 'runtime.forensics.classifier';

/**
 * The failure class each read category puts a failure in; categories not
 * listed say nothing about the LLM call or the turn deadline and fall through.
 * A timed-out request is a turn over its deadline; a spent account, a rate
 * limit, credentials the provider rejected, an overloaded or failing service,
 * a dropped connection or an unreadable response are the LLM call failing.
 */
const CLASS_FOR_CATEGORY: Partial<Readonly<Record<FailureCategory, FailureClass>>> = {
  timeout: 'turn_timeout',
  rate_limit: 'llm_error',
  billing: 'llm_error',
  authentication: 'llm_error',
  authorization: 'llm_error',
  service: 'llm_error',
  network: 'llm_error',
  protocol: 'llm_error',
};

/** Inputs available to the classifier at report generation time. */
interface ClassifierInput {
  /** Stop reason from the LLM provider (if any). */
  readonly stopReason?: string | undefined;
  /** Error message from the terminal event. */
  readonly errorMessage?: string | undefined;
  /** Whether this entity was explicitly cancelled by the operator. */
  readonly wasCancelled?: boolean | undefined;
  /** Whether any cascade events were present in the causal context. */
  readonly hasCascadeEvents?: boolean | undefined;
  /** Whether any tool calls failed in this turn/task. */
  readonly hasToolFailure?: boolean | undefined;
  /** Whether any permission check was denied. */
  readonly hasPermissionDenial?: boolean | undefined;
  /** Whether a compaction error was recorded. */
  readonly hasCompactionError?: boolean | undefined;
}

/**
 * Classify a failure based on available event context.
 * Rules are evaluated in priority order, first match wins.
 *
 * @returns The classified FailureClass.
 */
export async function classifyFailure(input: ClassifierInput, options?: OwnedJudgmentOptions): Promise<FailureClass> {
  options?.signal?.throwIfAborted();
  options?.assertCurrent?.();
  // Explicit cancellation takes precedence
  if (input.wasCancelled) {
    return 'cancelled';
  }

  // LLM stop reason: max_tokens
  if (
    input.stopReason === 'max_tokens'
    || input.stopReason === 'context_overflow'
  ) {
    return 'max_tokens';
  }

  // Compaction failure
  if (input.hasCompactionError) {
    return 'compaction_error';
  }

  // Permission denial
  if (input.hasPermissionDenial || input.stopReason === 'hook_denied') {
    return 'permission_denied';
  }

  // Tool failure
  if (input.hasToolFailure || input.stopReason === 'tool_loop_circuit_breaker') {
    return 'tool_failure';
  }

  // Cascade-induced failure
  if (input.hasCascadeEvents) {
    return 'cascade_failure';
  }

  // What the error message says: a turn deadline or a failed LLM call
  if (input.errorMessage) {
    const supplied = options?.port;
    const capture = options && !supplied ? captureJudgmentPort(FORENSICS_CLASSIFIER_SITE, options) : undefined;
    const port = supplied ?? capture?.port;
    const signal = options?.signal ?? capture?.signal;
    const { category } = await readFailure({ message: input.errorMessage }, FORENSICS_CLASSIFIER_SITE,
      port ? { port, ...(signal ? { signal } : {}) } : undefined);
    capture?.assertCurrent();
    options?.assertCurrent?.();
    options?.signal?.throwIfAborted();
    const read = CLASS_FOR_CATEGORY[category];
    if (read !== undefined) return read;
  }

  // LLM stop reason hinting at an error
  if (
    input.stopReason === 'provider_exhausted' ||
    input.stopReason === 'provider_error' ||
    input.stopReason === 'error' ||
    input.stopReason === 'stop_sequence' ||
    input.stopReason === 'content_filter'
  ) {
    return 'llm_error';
  }

  return 'unknown';
}

/**
 * Human-readable summary string for a classified failure.
 * Used as the FailureReport.summary.
 */
export function summariseFailure(
  classification: FailureClass,
  errorMessage?: string,
  stopReason?: string,
): string {
  switch (classification) {
    case 'llm_error':
      return errorMessage
        ? `LLM API error: ${errorMessage.slice(0, 120)}`
        : 'LLM API call failed';
    case 'tool_failure':
      return errorMessage
        ? `Tool execution failed: ${errorMessage.slice(0, 120)}`
        : 'Tool execution failed';
    case 'permission_denied':
      return 'Tool call denied by permission policy';
    case 'cascade_failure':
      return 'Failure propagated via health cascade';
    case 'turn_timeout':
      return 'Turn exceeded configured timeout';
    case 'cancelled':
      return 'Entity was explicitly cancelled';
    case 'max_tokens':
      return 'Model stopped due to token limit (max_tokens)';
    case 'compaction_error':
      return 'Context compaction failed';
    case 'unknown':
      return errorMessage
        ? `Failure (unclassified): ${errorMessage.slice(0, 120)}`
        : 'Failure (unclassified, inspect causal chain)';
  }
}
