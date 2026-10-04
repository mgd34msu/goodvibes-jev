import { APIConnectionError, APIError, APITimeoutError } from '@typesafe-ai/sdk';
import { JudgmentError } from './errors.ts';

/** Timing only: temporary unavailability never exhausts an attempt budget. */
export interface JudgmentRetryPolicy {
  readonly backoffInitialMs: number;
  readonly backoffMaxMs: number;
  readonly backoffJitter: number;
}

export function retryPolicy(overrides: Partial<JudgmentRetryPolicy>): JudgmentRetryPolicy {
  const policy = { backoffInitialMs: 500, backoffMaxMs: 5_000, backoffJitter: 0.25, ...overrides };
  if (!overrides || typeof overrides !== 'object' || Object.keys(overrides).some((key) => !['backoffInitialMs', 'backoffMaxMs', 'backoffJitter'].includes(key))
    || ![policy.backoffInitialMs, policy.backoffMaxMs].every((v) => Number.isFinite(v) && v >= 1 && v <= 60_000)
    || policy.backoffInitialMs > policy.backoffMaxMs
    || !Number.isFinite(policy.backoffJitter) || policy.backoffJitter < 0 || policy.backoffJitter > 1) {
    throw new JudgmentError('invalid-request', 'judgment retries accept only positive bounded backoff timing and jitter; attempt and total-time limits are not supported');
  }
  return policy;
}

export const transientStatus = (status: number): boolean => status === 408 || status === 429 || (status >= 500 && status <= 599);

export function retryable(error: unknown): boolean {
  return error instanceof APITimeoutError || error instanceof APIConnectionError
    || (error instanceof APIError && transientStatus(error.status));
}

/** Provider rate guidance is a minimum, never shortened by local backoff caps. */
export function retryDelay(error: unknown, attempt: number, policy: JudgmentRetryPolicy): number {
  // Clamp the exponent before multiplication: arbitrarily long outages must not overflow.
  const backoff = Math.max(1, Math.round(Math.min(policy.backoffInitialMs * 2 ** Math.min(attempt, 30), policy.backoffMaxMs)
    * (1 - Math.random() * policy.backoffJitter)));
  if (!(error instanceof APIError)) return backoff;
  const ms = error.headers.get('retry-after-ms');
  const raw = error.headers.get('retry-after');
  const delays = [
    ms !== null && ms.trim() ? Number(ms) : NaN,
    raw !== null && raw.trim() ? (Number.isFinite(Number(raw)) ? Number(raw) * 1_000 : Date.parse(raw) - Date.now()) : NaN,
  ];
  const guidance = delays.find((value) => Number.isFinite(value) && value >= 0);
  return guidance === undefined ? backoff : Math.max(backoff, Math.min(guidance, Number.MAX_SAFE_INTEGER));
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

/** Chunk long server-directed waits so setTimeout cannot overflow into a hot loop. */
export async function delay(ms: number, signal: AbortSignal): Promise<void> {
  let remaining = ms;
  while (remaining > 0) {
    const chunk = Math.min(remaining, 2_147_483_647);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await interruptible(new Promise<void>((resolve) => { timer = setTimeout(resolve, chunk); }), signal); }
    finally { clearTimeout(timer); }
    remaining -= chunk;
  }
}
