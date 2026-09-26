import { JudgmentError } from '../port/errors.ts';
import { toJson, type JudgmentPort, type JudgmentRequest, type JudgmentResult, type Questions } from '../port/types.ts';
import { hashState, isoTime, type DecisionLog, type NewDecisionEntry } from './types.ts';

/** Runs a log write; a failure becomes an `unrecorded` judgment error. */
function recorded<T>(write: () => T): T {
  try {
    return write();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new JudgmentError('unrecorded', `the decision log could not record this judgment: ${message}`, { cause });
  }
}

const asFailure = (error: unknown): JudgmentError =>
  error instanceof JudgmentError ? error : new JudgmentError('unavailable', String(error), { cause: error });

/**
 * Wraps a port so every call is recorded, answered or failed. When the log
 * cannot record a call, the call fails with `unrecorded`: no decision acts
 * on a reading the log does not hold.
 */
export function withDecisionLog(inner: JudgmentPort, log: DecisionLog, now: () => Date = () => new Date()): JudgmentPort {
  return {
    model: inner.model,
    recorder: {
      recordReadings: (id, readings) => recorded(() => log.attach(id, { kind: 'readings', readings })),
      recordAction: (id, action) => recorded(() => log.attach(id, { kind: 'action', action })),
    },
    async ask<const Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
      const started = performance.now();
      const call = {
        at: isoTime(now()),
        context: request.context ?? {},
        stateHash: hashState(request.state),
        questions: toJson(request.questions),
      };
      let result: JudgmentResult<Q>;
      try {
        result = await inner.ask(request);
      } catch (error) {
        const failure = asFailure(error);
        const entry: NewDecisionEntry = {
          ...call,
          status: 'failed',
          requestedModel: request.model ?? inner.model,
          latencyMs: performance.now() - started,
          requestId: failure.requestId,
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
        }),
      );
      return { ...result, decisionId };
    },
  };
}
