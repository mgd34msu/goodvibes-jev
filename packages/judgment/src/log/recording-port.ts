import { checkAnswers, projectAnswers } from '../port/answers.ts';
import { JudgmentError, type JudgmentErrorKind } from '../port/errors.ts';
import {
  toJson, type JudgmentAttempt, type JudgmentLineage, type JudgmentPort, type JudgmentRequest,
  type JudgmentResult, type Questions,
} from '../port/types.ts';
import { hashState, isoTime, type DecisionLog, type NewDecisionEntry } from './types.ts';

const FAILURE_MESSAGES: Readonly<Record<JudgmentErrorKind, string>> = {
  'invalid-request': 'the judgment request was invalid',
  rejected: 'the judgment request was rejected',
  unavailable: 'the judgment provider could not answer',
  aborted: 'the judgment call was cancelled',
  'invalid-response': 'the judgment provider returned an invalid response',
  unrecorded: 'the decision log could not record this judgment',
};
const failureKind = (value: unknown): value is JudgmentErrorKind =>
  typeof value === 'string' && Object.hasOwn(FAILURE_MESSAGES, value);
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const statusCode = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Enforce bounded wire identifier syntax, without guessing which words are secrets.
 * Only the configured transport knows the real keys; valid-looking unknown secrets
 * in documented metadata cannot be classified by a borrowed-port wrapper.
 */
function identifier(value: unknown, model = false): string | undefined {
  const syntax = model ? /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/ : /^[A-Za-z0-9._:-]+$/;
  if (typeof value !== 'string' || value.length > 256 || !syntax.test(value) || value.includes('://')) return undefined;
  return value;
}

const invalidResponse = (): JudgmentError => new JudgmentError('invalid-response', FAILURE_MESSAGES['invalid-response']);

/** Only documented, validated attempt evidence may cross the log boundary. */
function projectLineage(value: unknown): JudgmentLineage | undefined {
  if (value === undefined) return undefined;
  if (!object(value)) throw invalidResponse();
  const rawAttempts = value.attempts;
  if (!Array.isArray(rawAttempts)) throw invalidResponse();
  const logicalRequestId = identifier(value.logicalRequestId);
  if (logicalRequestId === undefined) throw invalidResponse();
  const attempts: JudgmentAttempt[] = [];
  for (let index = 0; index < rawAttempts.length; index += 1) {
    const item: unknown = rawAttempts[index];
    if (!object(item)) throw invalidResponse();
    const { attempt, endpointIndex, endpointKind, latencyMs, outcome, status } = item;
    const requestedModel = identifier(item.requestedModel, true);
    if (!nonnegative(attempt) || !Number.isInteger(attempt) || attempt < 1
      || !nonnegative(endpointIndex) || !Number.isInteger(endpointIndex)
      || (endpointKind !== 'hosted' && endpointKind !== 'local') || requestedModel === undefined
      || !nonnegative(latencyMs) || (outcome !== 'answered' && !failureKind(outcome))
      || (status !== undefined && !statusCode(status))) throw invalidResponse();
    const requestId = identifier(item.requestId);
    attempts.push({
      attempt, endpointIndex, endpointKind, requestedModel, latencyMs, outcome,
      ...(requestId === undefined ? {} : { requestId }),
      ...(statusCode(status) ? { status } : {}),
    });
  }
  return { logicalRequestId, attempts };
}

/** Never retain upstream exception text, stack, cause, arbitrary properties or malformed metadata. */
function asFailure(error: unknown): JudgmentError {
  let kind: JudgmentErrorKind = 'unavailable';
  let status: number | undefined;
  let requestId: string | undefined;
  let lineage: JudgmentLineage | undefined;
  try {
    if (error instanceof JudgmentError) {
      const { kind: rawKind, status: rawStatus, requestId: rawRequestId, lineage: rawLineage } = error;
      if (failureKind(rawKind)) kind = rawKind;
      if (statusCode(rawStatus)) status = rawStatus;
      requestId = identifier(rawRequestId);
      lineage = projectLineage(rawLineage);
    }
  } catch { /* Borrowed ports may supply malformed metadata or throwing getters. */ }
  return new JudgmentError(kind, FAILURE_MESSAGES[kind], {
    ...(status === undefined ? {} : { status }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(lineage === undefined ? {} : { lineage }),
  });
}

/** Runs a log write; a failure becomes a value-free `unrecorded` judgment error. */
function recorded<T>(write: () => T): T {
  try { return write(); }
  catch { throw new JudgmentError('unrecorded', FAILURE_MESSAGES.unrecorded); }
}

/** A borrowed port is as untrusted as a wire response; normalize before writing or returning it. */
function projectResult<Q extends Questions>(questions: Q, result: JudgmentResult<Q>): JudgmentResult<Q> {
  let requestId: string | undefined;
  let lineage: JudgmentLineage | undefined;
  try {
    requestId = identifier(result.requestId);
    lineage = projectLineage(result.lineage);
    const { requestedModel: rawRequestedModel, model: rawModel, usage, latencyMs, answers } = result;
    const { inputTokens, outputTokens } = usage;
    const requestedModel = identifier(rawRequestedModel, true);
    const model = identifier(rawModel, true);
    if (requestedModel === undefined || model === undefined
      || !nonnegative(inputTokens) || !nonnegative(outputTokens) || !nonnegative(latencyMs)) throw invalidResponse();
    checkAnswers(questions, answers);
    const normalizedAnswers = projectAnswers(questions, answers);
    // Check the projected values too: a borrowed object can have changing getters.
    checkAnswers(questions, normalizedAnswers);
    return {
      answers: normalizedAnswers, requestedModel, model,
      usage: { inputTokens, outputTokens },
      latencyMs, requestId,
      ...(lineage === undefined ? {} : { lineage }),
    };
  } catch {
    throw new JudgmentError('invalid-response', FAILURE_MESSAGES['invalid-response'], {
      ...(requestId === undefined ? {} : { requestId }),
      ...(lineage === undefined ? {} : { lineage }),
    });
  }
}

/**
 * Wraps a port so every call is recorded, answered or failed. When the log
 * cannot record a call, the call fails with `unrecorded`: no decision acts
 * on a reading the log does not hold.
 */
export function withDecisionLog(inner: JudgmentPort, log: DecisionLog, now: () => Date = () => new Date()): JudgmentPort {
  return {
    get model() { return inner.model; },
    ...(inner.health ? { health: () => inner.health!() } : {}),
    recorder: {
      recordReadings: (id, readings) => recorded(() => log.attach(id, { kind: 'readings', readings })),
      recordAction: (id, action) => recorded(() => log.attach(id, { kind: 'action', action })),
    },
    async ask<const Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
      const started = performance.now();
      let requestedModel: string | undefined;
      // Snapshot caller-owned inputs before a borrowed port can mutate them.
      const questions = toJson(request.questions);
      const call = {
        at: isoTime(now()),
        context: { ...request.context },
        stateHash: hashState(request.state),
        questions,
      };
      let result: JudgmentResult<Q>;
      try {
        requestedModel = identifier(request.model ?? inner.model, true);
        if (requestedModel === undefined) throw new JudgmentError('invalid-request', FAILURE_MESSAGES['invalid-request']);
        result = projectResult(questions as Q, await inner.ask(request));
      } catch (error) {
        const failure = asFailure(error);
        const entry: NewDecisionEntry = {
          ...call,
          status: 'failed',
          // An unsafe configured model has no identifier that can be persisted.
          requestedModel: requestedModel ?? '',
          latencyMs: performance.now() - started,
          requestId: failure.requestId,
          lineage: failure.lineage ?? { logicalRequestId: crypto.randomUUID(), attempts: [] },
          error: { kind: failure.kind, message: failure.message },
        };
        recorded(() => log.record(entry));
        throw failure;
      }
      const decisionId = recorded(() =>
        log.record({
          ...call,
          status: 'answered',
          requestedModel: result.requestedModel,
          model: result.model,
          answers: toJson(result.answers),
          latencyMs: result.latencyMs,
          usage: result.usage,
          requestId: result.requestId,
          lineage: result.lineage ?? { logicalRequestId: crypto.randomUUID(), attempts: [] },
        }),
      );
      return { ...result, decisionId };
    },
  };
}
