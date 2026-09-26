import { APIConnectionError, APIError, APIUserAbortError, TypeSafeClient, TypeSafeError, type Fetch } from '@typesafe-ai/sdk';
import type { JudgmentConfig } from './config.ts';
import { JudgmentError } from './errors.ts';
import { recordingRequestIds } from './request-id.ts';

const RETRYABLE_STATUS = (status: number): boolean => status === 408 || status === 429 || status >= 500;

export function toJudgmentError(error: unknown): JudgmentError {
  if (error instanceof JudgmentError) return error;
  if (error instanceof APIUserAbortError) {
    return new JudgmentError('aborted', 'the judgment call was cancelled', { cause: error });
  }
  if (error instanceof APIError) {
    const { status, message, requestId } = error;
    const kind = RETRYABLE_STATUS(status) ? 'unavailable' : 'rejected';
    return new JudgmentError(kind, `System One answered HTTP ${status}: ${message}`, {
      cause: error,
      status,
      ...(requestId === undefined ? {} : { requestId }),
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

/** An SDK client for the configured endpoint, recording each response's request id. */
export function clientFor(config: JudgmentConfig): TypeSafeClient {
  const { endpoint, model, timeoutMs, retry } = config;
  const { apiKey, baseURL } = endpoint;
  const base: Fetch = config.fetch ?? ((input, init) => fetch(input, init));
  return new TypeSafeClient({ apiKey, baseURL, defaultModel: model, timeout: timeoutMs, retry, logLevel: 'off', fetch: recordingRequestIds(base) });
}

