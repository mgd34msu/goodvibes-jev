/**
 * Why a judgment call failed. Every decision site treats a failure as a
 * failure: there is no heuristic path to fall back to. What a site does when
 * Jev cannot answer is not yet decided; the error reaches the caller.
 */
export type JudgmentErrorKind =
  /** The request broke a documented limit and was never sent. */
  | 'invalid-request'
  /** The endpoint rejected the request (4xx other than rate limiting). */
  | 'rejected'
  /** The endpoint could not answer: rate limit, overload, 5xx, timeout or network failure after retries. */
  | 'unavailable'
  /** The caller cancelled the call. */
  | 'aborted'
  /** The endpoint answered with a body that does not match the questions asked. */
  | 'invalid-response'
  /** The decision log could not record the call, so its answer must not be used. */
  | 'unrecorded';

export class JudgmentError extends Error {
  override readonly name = 'JudgmentError';
  readonly kind: JudgmentErrorKind;
  /** HTTP status when the endpoint answered with one. */
  readonly status: number | undefined;
  /** The endpoint's request id, when it sent one. */
  readonly requestId: string | undefined;

  constructor(
    kind: JudgmentErrorKind,
    message: string,
    options: { cause?: unknown; status?: number; requestId?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.kind = kind;
    this.status = options.status;
    this.requestId = options.requestId;
  }
}
