import type { Questions } from '@typesafe-ai/sdk';
import { checkAnswers } from './answers.ts';
import { clientFor, toJudgmentError } from './client.ts';
import type { JudgmentConfig } from './config.ts';
import { validateContextBudget, validateQuestions } from './limits.ts';
import { withRequestId } from './request-id.ts';
import type { JudgmentPort, JudgmentRequest, JudgmentResult } from './types.ts';

/** A JudgmentPort that asks a System One endpoint (hosted Jev or a local model). */
export function createSystemOnePort(config: JudgmentConfig): JudgmentPort {
  const client = clientFor(config);

  return {
    model: config.model,
    async ask<const Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
      const { state, questions, signal } = request;
      validateQuestions(questions);
      validateContextBudget(state, questions);
      const requestedModel = request.model ?? config.model;
      const body = { state, questions, model: requestedModel };
      const started = performance.now();
      try {
        const { result, requestId } = await withRequestId(() => client.systemOne(body, signal === undefined ? {} : { signal }));
        const { answers, model, usage } = result;
        checkAnswers(questions, answers, requestId);
        const latencyMs = performance.now() - started;
        return { answers, requestedModel, model, usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }, latencyMs, requestId };
      } catch (error) {
        throw toJudgmentError(error);
      }
    },
  };
}
