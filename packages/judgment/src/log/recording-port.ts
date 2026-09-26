import { JudgmentError } from '../port/errors.ts';
import type { JsonValue, JudgmentPort, JudgmentRequest, JudgmentResult, Questions } from '../port/types.ts';
import { hashState, type DecisionLog } from './types.ts';

function unrecorded(cause: unknown): JudgmentError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new JudgmentError('unrecorded', `the decision log could not record this judgment: ${message}`, { cause });
}

/**
 * Wraps a port so every call is recorded, answered or failed. When the log
 * cannot record a call, the call fails with `unrecorded`: no decision acts
 * on a reading the log does not hold.
 */
export function withDecisionLog(inner: JudgmentPort, log: DecisionLog, now: () => Date = () => new Date()): JudgmentPort {
  const guard = (write: () => void): void => {
    try {
      write();
    } catch (error) {
      throw unrecorded(error);
    }
  };
  return {
    model: inner.model,
    recorder: {
      recordReadings: (id, readings) => guard(() => log.recordReadings(id, readings as JsonValue)),
      recordAction: (id, action) => guard(() => log.recordAction(id, action)),
    },
    async ask<const Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
      const at = now().toISOString();
      const started = performance.now();
      const base = {
        at,
        context: request.context ?? {},
        stateHash: hashState(request.state),
        questions: request.questions as unknown as JsonValue,
      };
      let result: JudgmentResult<Q>;
      try {
        result = await inner.ask(request);
      } catch (error) {
        const failure =
          error instanceof JudgmentError ? error : new JudgmentError('unavailable', String(error), { cause: error });
        guard(() =>
          log.record({
            ...base,
            requestedModel: request.model ?? inner.model,
            model: undefined,
            answers: undefined,
            latencyMs: performance.now() - started,
            usage: undefined,
            requestId: failure.requestId,
            error: { kind: failure.kind, message: failure.message },
          }),
        );
        throw failure;
      }
      let decisionId = '';
      guard(() => {
        decisionId = log.record({
          ...base,
          requestedModel: result.requestedModel,
          model: result.model,
          answers: result.answers as unknown as JsonValue,
          latencyMs: result.latencyMs,
          usage: result.usage,
          requestId: result.requestId,
          error: undefined,
        });
      });
      return { ...result, decisionId };
    },
  };
}
