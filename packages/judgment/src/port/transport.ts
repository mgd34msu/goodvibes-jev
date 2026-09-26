import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  TypeSafeClient,
  TypeSafeError,
  type Questions,
} from '@typesafe-ai/sdk';
import { checkAnswers } from './answers.ts';
import type { JudgmentConfig } from './config.ts';
import { JudgmentError } from './errors.ts';
import { validateContextBudget, validateQuestions } from './limits.ts';
import type { JudgmentPort, JudgmentRequest, JudgmentResult } from './types.ts';

const RETRYABLE_STATUS = (status: number): boolean => status === 408 || status === 429 || status >= 500;

function toJudgmentError(error: unknown): JudgmentError {
  if (error instanceof JudgmentError) return error;
  if (error instanceof APIUserAbortError) {
    return new JudgmentError('aborted', 'the judgment call was cancelled', { cause: error });
  }
  if (error instanceof APIError) {
    const kind = RETRYABLE_STATUS(error.status) ? 'unavailable' : 'rejected';
    return new JudgmentError(kind, `System One answered HTTP ${error.status}: ${error.message}`, {
      cause: error,
      status: error.status,
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    });
  }
  if (error instanceof APIConnectionError) {
    return new JudgmentError('unavailable', `System One could not be reached: ${error.message}`, { cause: error });
  }
  if (error instanceof TypeSafeError) {
    return new JudgmentError('invalid-request', error.message, { cause: error });
  }
  return new JudgmentError('unavailable', error instanceof Error ? error.message : String(error), { cause: error });
}

/** A JudgmentPort that asks a System One endpoint (hosted Jev or a local model). */
export function createSystemOnePort(config: JudgmentConfig): JudgmentPort {
  const client = new TypeSafeClient({
    apiKey: config.endpoint.apiKey,
    baseURL: config.endpoint.baseURL,
    defaultModel: config.model,
    timeout: config.timeoutMs,
    retry: config.retry,
    logLevel: 'off',
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
  });

  return {
    async ask<const Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
      validateQuestions(request.questions);
      validateContextBudget(request.state, request.questions);
      const requestedModel = request.model ?? config.model;
      const started = performance.now();
      try {
        const { data, requestId } = await client
          .systemOne(
            { state: request.state, questions: request.questions, model: requestedModel },
            request.signal === undefined ? {} : { signal: request.signal },
          )
          .withResponse();
        checkAnswers(request.questions, data.answers, requestId);
        return {
          answers: data.answers,
          requestedModel,
          model: data.model,
          usage: { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens },
          latencyMs: performance.now() - started,
          requestId,
        };
      } catch (error) {
        throw toJudgmentError(error);
      }
    },
  };
}
