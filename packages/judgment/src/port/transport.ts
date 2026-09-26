import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  TypeSafeClient,
  TypeSafeError,
  type ModelCard,
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

function clientFor(config: JudgmentConfig): TypeSafeClient {
  return new TypeSafeClient({
    apiKey: config.endpoint.apiKey,
    baseURL: config.endpoint.baseURL,
    defaultModel: config.model,
    timeout: config.timeoutMs,
    retry: config.retry,
    logLevel: 'off',
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
  });
}

/** The model names the endpoint accepts, with descriptions and release dates (GET /v1/models). */
export async function listSystemOneModels(config: JudgmentConfig): Promise<readonly ModelCard[]> {
  try {
    return await clientFor(config).models.list();
  } catch (error) {
    throw toJudgmentError(error);
  }
}

type WireResult = Awaited<ReturnType<TypeSafeClient['systemOne']>>;

function toResult<Q extends Questions>(data: WireResult, requestedModel: string, requestId: string | undefined, started: number): JudgmentResult<Q> {
  const { answers, model, usage } = data;
  return {
    answers: answers as JudgmentResult<Q>['answers'],
    requestedModel,
    model,
    usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
    latencyMs: performance.now() - started,
    requestId,
  };
}

/** A JudgmentPort that asks a System One endpoint (hosted Jev or a local model). */
export function createSystemOnePort(config: JudgmentConfig): JudgmentPort {
  const client = clientFor(config);

  return {
    model: config.model,
    async ask<const Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
      validateQuestions(request.questions);
      validateContextBudget(request.state, request.questions);
      const requestedModel = request.model ?? config.model;
      const started = performance.now();
      const body = { state: request.state, questions: request.questions, model: requestedModel };
      const options = request.signal === undefined ? {} : { signal: request.signal };
      try {
        const { data, requestId } = await client.systemOne(body, options).withResponse();
        checkAnswers(request.questions, data.answers, requestId);
        return toResult<Q>(data, requestedModel, requestId, started);
      } catch (error) {
        throw toJudgmentError(error);
      }
    },
  };
}
