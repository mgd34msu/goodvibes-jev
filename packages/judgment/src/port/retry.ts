import { APIConnectionError, APIError, APITimeoutError, type RetryPolicy } from '@typesafe-ai/sdk';
import { JudgmentError } from './errors.ts';

/** Bounded defaults matching the SDK's retry policy; the transport owns retries. */
export function retryPolicy(overrides: Partial<RetryPolicy>): RetryPolicy {
  const policy: RetryPolicy = {
    maxRetries: 2, backoffInitialMs: 500, backoffMaxMs: 5_000, backoffJitter: 0.25,
    httpStatuses: new Set([408, 429, ...Array.from({ length: 100 }, (_, i) => 500 + i)]),
    respectRetryAfter: true, maxRetryAfterMs: 60_000, apiConnectionError: true, apiTimeoutError: true,
    ...overrides,
  };
  if (!Number.isInteger(policy.maxRetries) || policy.maxRetries < 0 || policy.maxRetries > 10
    || ![policy.backoffInitialMs, policy.backoffMaxMs, policy.maxRetryAfterMs].every((v) => Number.isFinite(v) && v >= 0 && v <= 60_000)
    || !Number.isFinite(policy.backoffJitter) || policy.backoffJitter < 0 || policy.backoffJitter > 1
    || ![policy.respectRetryAfter, policy.apiConnectionError, policy.apiTimeoutError].every((v) => typeof v === 'boolean')
    || !(policy.httpStatuses instanceof Set) || [...policy.httpStatuses].some((v) => !Number.isInteger(v) || !transientStatus(v))) {
    throw new JudgmentError('invalid-request', 'invalid bounded judgment retry policy');
  }
  return { ...policy, httpStatuses: new Set(policy.httpStatuses) };
}

export const transientStatus = (status: number): boolean => status === 408 || status === 429 || (status >= 500 && status <= 599);

export function retryable(error: unknown, policy: RetryPolicy): boolean {
  if (error instanceof APITimeoutError) return policy.apiTimeoutError;
  if (error instanceof APIConnectionError) return policy.apiConnectionError;
  return error instanceof APIError && policy.httpStatuses.has(error.status);
}

/** Server guidance is bounded by both this policy and the logical-call deadline. */
export function retryDelay(error: unknown, attempt: number, policy: RetryPolicy): number {
  if (error instanceof APIError && policy.respectRetryAfter) {
    const ms = error.headers.get('retry-after-ms');
    const raw = error.headers.get('retry-after');
    const delay = ms !== null ? Number(ms) : raw === null ? NaN : Number.isFinite(Number(raw)) ? Number(raw) * 1_000 : Date.parse(raw) - Date.now();
    if (Number.isFinite(delay) && delay >= 0 && delay <= policy.maxRetryAfterMs) return delay;
  }
  return Math.round(Math.min(policy.backoffInitialMs * 2 ** attempt, policy.backoffMaxMs) * (1 - Math.random() * policy.backoffJitter));
}

/** Race even an injected fetch that ignores AbortSignal, and always clean listeners. */
export async function interruptible<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  const pending = Promise.resolve(work);
  if (signal.aborted) {
    void pending.catch(() => {});
    throw signal.reason;
  }
  let abort: () => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([pending, interrupted]); }
  finally { signal.removeEventListener('abort', abort); }
}

export async function delay(ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await interruptible(new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }), signal); }
  finally { clearTimeout(timer); }
}
