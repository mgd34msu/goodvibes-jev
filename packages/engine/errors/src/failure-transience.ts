import {
  categoryForCode,
  readFailure,
  type FailureCategory,
  type FailureConclusions,
  type FailureEvidence,
  type FailureReadOptions,
} from './failure-reading.js';

/**
 * Whether a failure is worth another attempt: the one transience decision the
 * engine's retry, cooldown and dead-letter sites share (integration delivery,
 * automation runs, provider batches) and the client SDK's token refresh uses.
 * Structure decides first; only when structure is silent is the wording read
 * through the engine failure battery (`readFailure`).
 */
export type FailureClass = 'retryable' | 'terminal';

/**
 * What a transience decision rested on: an explicit classification the error
 * carries, a structured fact (a Retry-After, an HTTP status, an errno code, a
 * timeout error class), Jev's reading of the wording, or no wording at all.
 */
export type TransienceBasis = 'explicit' | 'retry-after' | 'status' | 'errno' | 'error-type' | 'reading' | 'no-wording';

/** Whether a failure is worth another attempt, and why. */
export interface FailureTransience {
  readonly failureClass: FailureClass;
  readonly basis: TransienceBasis;
  /** The fact or reading behind the decision, for logs and the decision trail. */
  readonly detail: string;
}

export interface TransienceOptions {
  /** Owned port, cancellation and current-source checks; bypasses shared wording memoization. */
  readonly reading?: FailureReadOptions;
  /**
   * The failure came from an LLM provider's API. Providers report a spent
   * account under a 429 (OpenAI `insufficient_quota`), which its status alone
   * calls retryable, so a provider's 429 is also read for billing.
   */
  readonly fromProvider?: boolean;
  /** Renders a failure that is neither an Error nor a string as text for the reading. */
  readonly describe?: (error: unknown) => string;
}

/** HTTP statuses a retry can clear: request timeout, rate limit, server failures. */
export const TRANSIENT_STATUS_CODES: readonly number[] = [408, 429, 500, 502, 503, 504];
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set(TRANSIENT_STATUS_CODES);

/** Error class names that only a timeout or an abort produces (AbortSignal.timeout, fetch aborts). */
const TIMEOUT_ERROR_NAMES: ReadonlySet<string> = new Set(['TimeoutError', 'AbortError']);

/**
 * The reading's categories, split by whether sending the same thing again
 * could succeed. The rest ('unknown') leave the wording unsettled.
 */
const TRANSIENT_CATEGORIES: ReadonlySet<FailureCategory> = new Set(['rate_limit', 'timeout', 'network', 'service', 'protocol']);
const PERMANENT_CATEGORIES: ReadonlySet<FailureCategory> = new Set(['authentication', 'authorization', 'billing', 'not_found', 'bad_request']);

function numberField(value: object, key: string): number | undefined {
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

/** The HTTP status an error carries as a field (`status`, or `statusCode` as AppError and DeliveryError name it). */
export function httpStatusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  for (const key of ['status', 'statusCode']) {
    const status = numberField(error, key);
    if (status !== undefined && status >= 100 && status <= 599) return status;
  }
  return undefined;
}

/**
 * The transience a failure's structure fixes on its own, or undefined when
 * only its wording can say. Order: an explicit Retry-After (a server naming
 * when to come back, which also covers a 403 secondary rate limit); the HTTP
 * status against the transient-status table; an errno code (on the error or
 * its cause) that names a connection fault or timeout; a timeout or abort
 * error class.
 */
export function structuredTransience(error: unknown): FailureTransience | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const retryAfterMs = numberField(error, 'retryAfterMs');
  if (retryAfterMs !== undefined && retryAfterMs >= 0) {
    return { failureClass: 'retryable', basis: 'retry-after', detail: `server asked for a retry after ${retryAfterMs}ms` };
  }
  const status = httpStatusOf(error);
  if (status !== undefined) {
    const failureClass = TRANSIENT_STATUSES.has(status) ? 'retryable' : 'terminal';
    return { failureClass, basis: 'status', detail: `HTTP ${status}` };
  }
  const cause = (error as { readonly cause?: unknown }).cause;
  for (const code of [stringField(error, 'code'), stringField(cause, 'code')]) {
    const category = categoryForCode(code);
    if (category !== undefined) return { failureClass: 'retryable', basis: 'errno', detail: `${code} (${category})` };
  }
  const name = stringField(error, 'name');
  if (name !== undefined && TIMEOUT_ERROR_NAMES.has(name)) {
    return { failureClass: 'retryable', basis: 'error-type', detail: name };
  }
  return undefined;
}

function describeFallback(error: unknown): string {
  const message = stringField(error, 'message');
  if (message !== undefined) return message;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** The wording a reading is given: the error's message, and its cause's when it has one. */
function failureWording(error: unknown, describe: (error: unknown) => string): FailureEvidence {
  if (error instanceof Error) {
    const causeMessage = error.cause instanceof Error ? error.cause.message : stringField(error.cause, 'message');
    const message = causeMessage !== undefined && causeMessage !== error.message
      ? `${error.message}\nCaused by: ${causeMessage}`
      : error.message;
    return { message, code: stringField(error, 'code') ?? stringField(error.cause, 'code'), errorName: error.name };
  }
  return { message: typeof error === 'string' ? error : describe(error) };
}

/**
 * Composes the failure reading into a transience decision. A spent account is
 * permanent even when it arrives as a rate limit; a transient network fault
 * is worth another attempt; otherwise the category decides. A reading that
 * settles nothing is retried: each caller's attempt budget bounds it and the
 * failure stays observable, where a give-up would drop it silently.
 */
export function transienceFromReading(failure: FailureConclusions): FailureTransience {
  const basis = 'reading';
  if (failure.billing) return { failureClass: 'terminal', basis, detail: 'the account cannot pay for the request' };
  if (failure.transientNetwork) return { failureClass: 'retryable', basis, detail: 'a transient network fault' };
  if (PERMANENT_CATEGORIES.has(failure.category)) return { failureClass: 'terminal', basis, detail: `read as ${failure.category}` };
  if (TRANSIENT_CATEGORIES.has(failure.category)) return { failureClass: 'retryable', basis, detail: `read as ${failure.category}` };
  if (failure.rateLimited) return { failureClass: 'retryable', basis, detail: 'a rate limit' };
  return { failureClass: 'retryable', basis, detail: 'the wording does not settle it' };
}

/**
 * Decides whether a failure is worth another attempt: structure first
 * ({@link structuredTransience}), then one Jev reading of the wording through
 * the engine failure battery (`readFailure`, memoized per wording). A
 * provider's 429 is also read for billing when `fromProvider` is set. A
 * failure with no wording at all is retried, as a reading that settles
 * nothing is. Throws when a reading is needed and none can be made; there is
 * no pattern-list fallback.
 */
export async function readFailureTransience(error: unknown, site: string, options: TransienceOptions = {}): Promise<FailureTransience> {
  const assertCurrent = () => {
    options.reading?.signal?.throwIfAborted();
    const checked: unknown = options.reading?.beforeAttempt?.();
    if (checked !== undefined) {
      void Promise.resolve(checked).catch(() => {});
      throw new Error('Failure reading authority checks must be synchronous');
    }
  };
  assertCurrent();
  const describe = options.describe ?? describeFallback;
  const structured = structuredTransience(error);
  if (structured !== undefined) {
    const status = httpStatusOf(error);
    if (options.fromProvider !== true || structured.basis !== 'status' || status !== 429) return structured;
    const evidence = { ...failureWording(error, describe), status };
    if (evidence.message.trim().length === 0) return structured;
    const failure = await readFailure(evidence, site, options.reading);
    assertCurrent();
    return failure.billing
      ? { failureClass: 'terminal', basis: 'reading', detail: 'HTTP 429 read as billing: the account cannot pay for the request' }
      : structured;
  }
  const evidence = failureWording(error, describe);
  if (evidence.message.trim().length === 0) {
    return { failureClass: 'retryable', basis: 'no-wording', detail: 'the failure carries no wording' };
  }
  const failure = await readFailure(evidence, site, options.reading);
  assertCurrent();
  return transienceFromReading(failure);
}
