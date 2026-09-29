import {
  categoryForStatus,
  GoodVibesSdkError,
  HttpStatusError,
  readFailure,
  RETRYABLE_STATUS_CODES,
  type FailureConclusions,
  type FailureEvidence,
} from '@goodvibes-jev/engine/errors';
import { readRetryWaitMs } from './batteries/retry-wait.js';

/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

export { RETRYABLE_STATUS_CODES };

export type PlatformErrorCategory =
  | 'authentication'
  | 'authorization'
  | 'billing'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'bad_request'
  | 'not_found'
  | 'permission'
  | 'tool'
  | 'config'
  | 'protocol'
  | 'service'
  | 'internal'
  | 'unknown';

export type PlatformErrorSource =
  | 'provider'
  | 'tool'
  | 'transport'
  | 'config'
  | 'permission'
  | 'runtime'
  | 'render'
  | 'acp'
  | 'unknown';

export interface AppErrorOptions {
  readonly statusCode?: number | undefined;
  readonly category?: PlatformErrorCategory | undefined;
  readonly guidance?: string | undefined;
  readonly detail?: string | undefined;
  readonly source?: PlatformErrorSource | undefined;
  readonly provider?: string | undefined;
  readonly operation?: string | undefined;
  readonly phase?: string | undefined;
  readonly requestId?: string | undefined;
  readonly providerCode?: string | undefined;
  readonly providerType?: string | undefined;
  readonly retryAfterMs?: number | undefined;
  readonly rawMessage?: string | undefined;
  readonly cause?: unknown | undefined;
}

export interface ProviderErrorOptions extends AppErrorOptions {
  readonly statusCode?: number | undefined;
}

function inferProviderGuidance(category: PlatformErrorCategory, statusCode?: number): string | undefined {
  switch (category) {
    case 'rate_limit':
      return 'The provider rate limited this request. GoodVibes will retry automatically when the caller supports retries. If this keeps happening, wait, reduce request volume, or switch models/providers.';
    case 'authentication':
      return 'The provider rejected authentication. Possible causes include invalid or expired credentials, missing account/session state, account restrictions, or the wrong provider/endpoint receiving the request.';
    case 'authorization':
      return 'The provider rejected the request after authentication. Possible causes include missing model access, account permissions, policy restrictions, or provider routing to a service that does not expose this model.';
    case 'billing':
      return 'The provider reported a billing or quota problem. Check credits, subscription status, usage limits, or account entitlements.';
    case 'timeout':
      return 'The request timed out before the provider finished responding. Check network stability, provider latency, and request size.';
    case 'network':
      return 'The request did not complete over the network. Check connectivity, DNS, TLS certificates, base URL, or any local proxy/tunnel.';
    case 'bad_request':
      return 'The provider rejected the request shape. Check model id, parameters, message format, and tool schema.';
    case 'not_found':
      return 'The requested model or endpoint was not found. Check model id, provider selection, and API path.';
    case 'protocol':
      return 'The provider response was incomplete or malformed. Check upstream protocol support, streaming mode, and transport stability.';
    case 'service':
      return statusCode === 503
        ? 'The provider is temporarily unavailable. Retry shortly or switch providers if the issue persists.'
        : 'The provider returned a server-side failure. Retry shortly or switch providers if the issue persists.';
    default:
      return undefined;
  }
}

/** Base class for all application errors. Provides a machine-readable code and recoverability hint. */
export class AppError extends GoodVibesSdkError {
  /** HTTP status code associated with the failure. */
  public readonly statusCode?: number | undefined;
  /** Human-readable recovery guidance. */
  public readonly guidance?: string | undefined;
  /** Additional detail string not present on GoodVibesSdkError. */
  public readonly detail?: string | undefined;
  /** Raw provider message before normalisation. */
  public readonly rawMessage?: string | undefined;

  constructor(
    message: string,
    public override readonly code: string,
    public override readonly recoverable: boolean,
    options: AppErrorOptions = {},
  ) {
    super(message, {
      code,
      recoverable,
      category: options.category,
      source: options.source,
      status: options.statusCode,
      hint: options.guidance,
      provider: options.provider,
      operation: options.operation,
      phase: options.phase,
      requestId: options.requestId,
      providerCode: options.providerCode,
      providerType: options.providerType,
      retryAfterMs: options.retryAfterMs,
      cause: options.cause,
    });
    this.name = this.constructor.name;
    this.statusCode = options.statusCode;
    this.guidance = options.guidance;
    this.detail = options.detail;
    this.rawMessage = options.rawMessage;
  }
}

/** Thrown when configuration is invalid or cannot be loaded. Non-recoverable. */
export class ConfigError extends AppError {
  declare readonly code: 'CONFIG_ERROR';
  constructor(message: string) {
    super(message, 'CONFIG_ERROR', false, {
      category: 'config',
      source: 'config',
    });
  }
}

/** Thrown when an LLM provider API call fails. Recoverable when statusCode is in RETRYABLE_STATUS_CODES. */
export class ProviderError extends AppError {
  declare readonly code: 'PROVIDER_ERROR';
  constructor(message: string, statusCode?: number);
  constructor(message: string, options?: ProviderErrorOptions);
  constructor(message: string, statusCodeOrOptions?: number | ProviderErrorOptions, maybeOptions: ProviderErrorOptions = {}) {
    const options = typeof statusCodeOrOptions === 'number'
      ? { ...maybeOptions, statusCode: statusCodeOrOptions }
      : (statusCodeOrOptions ?? {});
    const statusCode = options.statusCode;
    // The status fixes a provisional category; whether a 400 or 429 is really a
    // spent account is read from the wording where it matters (readProviderFailure).
    const category = options.category ?? categoryForStatus(statusCode) ?? 'unknown';
    const guidance = options.guidance ?? inferProviderGuidance(category, statusCode);

    super(message, 'PROVIDER_ERROR', statusCode !== undefined && RETRYABLE_STATUS_CODES.includes(statusCode), {
      // retryAfterMs passes through as given: only the explicit value (a
      // Retry-After header or a structured field). A wait the message states
      // in words is read by Jev through readRetryWait.
      ...options,
      statusCode,
      category,
      guidance,
      source: options.source ?? 'provider',
      rawMessage: options.rawMessage ?? message,
    });
  }
}

/** Thrown when a tool execution fails. Recoverable by default. */
export class ToolError extends AppError {
  declare readonly code: 'TOOL_ERROR';
  constructor(message: string, public readonly toolName: string, options: Pick<AppErrorOptions, 'cause'> = {}) {
    super(message, 'TOOL_ERROR', true, {
      category: 'tool',
      source: 'tool',
      cause: options.cause,
    });
  }
}

/** Thrown for ACP (Agent Control Protocol) errors. Recoverable by default. */
export class AcpError extends AppError {
  declare readonly code: 'ACP_ERROR';
  constructor(message: string) {
    super(message, 'ACP_ERROR', true, {
      source: 'acp',
    });
  }
}

/** Thrown when an operation is denied due to insufficient permissions. Non-recoverable. */
export class PermissionError extends AppError {
  declare readonly code: 'PERMISSION_DENIED';
  constructor(message: string) {
    super(message, 'PERMISSION_DENIED', false, {
      category: 'permission',
      source: 'permission',
    });
  }
}

/** Thrown when the renderer encounters a failure. Recoverable by default. */
export class RenderError extends AppError {
  declare readonly code: 'RENDER_ERROR';
  constructor(message: string) {
    super(message, 'RENDER_ERROR', true, {
      source: 'render',
    });
  }
}

/** The evidence a failure reading is about: the message and the fixed fields around it. */
export function failureEvidence(err: Error): FailureEvidence {
  const structuredCode = (err as { readonly code?: unknown }).code;
  const code = err instanceof AppError
    ? err.providerCode
    : typeof structuredCode === 'string' ? structuredCode : undefined;
  return {
    message: err.message,
    status: err instanceof AppError ? err.statusCode : undefined,
    code,
    errorName: err.name,
  };
}

/** Reads what an error's wording says about the failure (one Jev request per distinct wording). */
export function readErrorFailure(err: Error, site: string): Promise<FailureConclusions> {
  return readFailure(failureEvidence(err), site);
}

/**
 * How long to wait before retrying, in milliseconds: the explicit value the
 * error carries (a Retry-After header or a structured field) when there is
 * one, otherwise the wait the message states, read by Jev
 * (`engine.provider.retry-wait`). Undefined when neither gives one.
 */
export async function readRetryWait(err: unknown, site = 'types.errors.retry-wait'): Promise<number | undefined> {
  if (err instanceof AppError && err.retryAfterMs !== undefined) return err.retryAfterMs;
  if (!(err instanceof Error)) return undefined;
  return readRetryWaitMs({ message: err.message, status: err instanceof AppError ? err.statusCode : undefined }, site);
}

/**
 * Whether the provider rejected the call because the account cannot pay for
 * it: credits exhausted, balance too low, plan quota spent.
 *
 * This is NOT a rate limit and must never be retried on one. An Anthropic 400
 * carrying "Your credit balance is too low" was being reported as
 * "rate limited on turn 1, retrying in 60s" and retried three times.
 *
 * Structure decides first (an explicit `billing` category, a 402); otherwise
 * Jev reads the wording.
 */
export async function isBillingOrCreditError(err: unknown, site = 'types.errors.billing'): Promise<boolean> {
  if (err instanceof AppError && (err.category === 'billing' || err.statusCode === 402)) return true;
  if (!(err instanceof Error)) return false;
  return (await readErrorFailure(err, site)).billing;
}

/**
 * Whether the error is a rate limit or an exhausted quota. Used by
 * SyntheticProvider and AgentOrchestrator to decide whether to back off and
 * retry or escalate.
 *
 * Callers that decide whether to WAIT AND RETRY the same endpoint must check
 * {@link isBillingOrCreditError} first: a spent account is a quota failure,
 * and waiting does not fix it. Callers that ROTATE to another backend
 * (SyntheticProvider) are right to treat both the same way, since a
 * different account may well have credit.
 */
export async function isRateLimitOrQuotaError(err: unknown, site = 'types.errors.rate-limit'): Promise<boolean> {
  if (err instanceof ProviderError && (err.statusCode === 429 || err.statusCode === 402)) return true;
  if (!(err instanceof Error)) return false;
  return (await readErrorFailure(err, site)).rateLimited;
}

/** Whether the error says the model's context window was exceeded. */
export async function isContextSizeExceededError(err: unknown, site = 'types.errors.context-exceeded'): Promise<boolean> {
  if (!(err instanceof Error)) return false;
  return (await readErrorFailure(err, site)).contextExceeded;
}

/**
 * Whether the error is a transient network or transport failure (as opposed
 * to a programmer error or a permanent provider rejection).
 *
 * An `HttpStatusError` (e.g. from `createNetworkTransportError` in the HTTP
 * transport) is trusted on its structured `category`/`recoverable` fields,
 * which already account for TypeErrors, POSIX errno codes and undici
 * `UND_ERR_*` codes. The `instanceof` check is branded (see HttpStatusError's
 * Symbol.hasInstance), so a plain object carrying those properties is not
 * mistaken for one. Other errors are read by Jev.
 */
export async function isNetworkTransportError(err: unknown, site = 'types.errors.network-transport'): Promise<boolean> {
  if (err instanceof HttpStatusError) {
    return err.category === 'network' && err.recoverable === true;
  }
  if (!(err instanceof Error)) return false;
  return (await readErrorFailure(err, site)).transientNetwork;
}

/**
 * Whether the provider cannot serve requests as configured (credentials
 * rejected, no credit, access denied, or unreachable), as opposed to a
 * transient failure. 500 and 503 are not non-transient: server errors are
 * eligible for retry. Used to trigger graceful degradation and alternative
 * model suggestions.
 */
export async function isNonTransientProviderFailure(err: unknown, site = 'types.errors.non-transient'): Promise<boolean> {
  if (!(err instanceof Error)) return false;
  if (err instanceof ProviderError && err.statusCode !== undefined && NON_TRANSIENT_STATUS.has(err.statusCode)) return true;
  return (await readErrorFailure(err, site)).providerUnusable;
}

const NON_TRANSIENT_STATUS: ReadonlySet<number> = new Set([401, 402, 403]);
