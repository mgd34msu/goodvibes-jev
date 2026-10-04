import { APIConnectionError, APIError, APIUserAbortError, TypeSafeClient, TypeSafeError, type Fetch } from '@typesafe-ai/sdk';
import type { JudgmentConfig } from './config.ts';
import { JudgmentError } from './errors.ts';
import { recordingRequestIds } from './request-id.ts';
import { interruptible, transientStatus } from './retry.ts';

export function toJudgmentError(error: unknown): JudgmentError {
  if (error instanceof JudgmentError) return error;
  if (error instanceof APIUserAbortError) {
    return new JudgmentError('aborted', 'the judgment call was cancelled');
  }
  if (error instanceof APIError) {
    const { status, requestId } = error;
    const kind = transientStatus(status) ? 'unavailable' : 'rejected';
    return new JudgmentError(kind, `System One answered HTTP ${status}`, {
      status,
      ...(requestId === undefined ? {} : { requestId }),
    });
  }
  if (error instanceof APIConnectionError) {
    return new JudgmentError('unavailable', 'System One could not be reached');
  }
  if (error instanceof TypeSafeError) {
    return new JudgmentError('invalid-request', 'System One rejected the client request configuration');
  }
  return new JudgmentError('invalid-response', 'System One did not return a usable response');
}

/** An SDK client for the configured endpoint, recording each response's request id. */
export function clientFor(config: JudgmentConfig, singleAttempt = false): TypeSafeClient {
  const { endpoint, model, timeoutMs, retry } = config;
  const { apiKey, baseURL } = endpoint;
  const base: Fetch = config.fetch ?? ((input, init) => fetch(input, init));
  return new TypeSafeClient({ apiKey, baseURL, defaultModel: model, timeout: timeoutMs, retry: { ...retry, ...(singleAttempt ? { maxRetries: 0 } : {}) }, logLevel: 'off', fetch: recordingRequestIds((input, init) => {
    const pending = base(input, { ...init, redirect: 'error' });
    // Unwind SDK timers/listeners even when a custom fetch ignores cancellation.
    return init?.signal ? interruptible(pending, init.signal) : pending;
  }) });
}

