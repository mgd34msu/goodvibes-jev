import {
  categoryDependsOnWording,
  categoryForCode,
  categoryForStatus,
  DaemonErrorCategory,
  type DaemonErrorSource,
  type FailureConclusions,
  GoodVibesSdkError,
  isStructuredDaemonErrorBody,
  readFailure,
  settleCategory,
  type StructuredDaemonErrorBody,
} from '@goodvibes-jev/engine/errors';

/** Options for `jsonErrorResponse` and `buildErrorResponseBody`. */
export interface JsonErrorResponseOptions {
  /** HTTP status code for the response (defaults to `500` or the error's own status). */
  readonly status?: number | undefined;
  /** Human-readable message to use when the error object carries no message. */
  readonly fallbackMessage?: string | undefined;
  /** Override or supply the `source` field on the structured error body. */
  readonly source?: DaemonErrorSource | undefined;
  /**
   * when false (default), internal pipeline fields (`provider`,
   * `operation`, `phase`, `providerCode`, `providerType`) are stripped from
   * the wire body to prevent information disclosure to unprivileged clients.
   * Pass `true` only for admin/operator-authenticated callers.
   */
  readonly isPrivileged?: boolean | undefined;
  /**
   * What Jev read in the error's wording. Without it the category comes from
   * structure alone; {@link readErrorResponseBody} supplies it.
   */
  readonly failure?: FailureConclusions | undefined;
}

interface StructuredErrorLike {
  readonly message: string;
  readonly code?: string | undefined;
  readonly recoverable?: boolean | undefined;
  readonly status?: number | undefined;
  readonly statusCode?: number | undefined;
  readonly hint?: string | undefined;
  readonly guidance?: string | undefined;
  readonly source?: string | undefined;
  readonly category?: string | undefined;
  readonly provider?: string | undefined;
  readonly operation?: string | undefined;
  readonly phase?: string | undefined;
  readonly requestId?: string | undefined;
  readonly providerCode?: string | undefined;
  readonly providerType?: string | undefined;
  readonly retryAfterMs?: number | undefined;
}

interface ErrorPropertyLike {
  readonly error: string;
  readonly code?: string | undefined;
  readonly recoverable?: boolean | undefined;
  readonly status?: number | undefined;
  readonly statusCode?: number | undefined;
  readonly hint?: string | undefined;
  readonly guidance?: string | undefined;
  readonly source?: string | undefined;
  readonly category?: string | undefined;
  readonly provider?: string | undefined;
  readonly operation?: string | undefined;
  readonly phase?: string | undefined;
  readonly requestId?: string | undefined;
  readonly providerCode?: string | undefined;
  readonly providerType?: string | undefined;
  readonly retryAfterMs?: number | undefined;
}

const NETWORK_ERROR_PATTERNS: Array<{ pattern: RegExp; category: DaemonErrorCategory; message: (provider?: string) => string }> = [
  {
    pattern: /ECONNREFUSED/i,
    category: DaemonErrorCategory.NETWORK,
    message: (provider) => `Cannot connect to ${provider ?? 'the provider'}. Check whether the service is reachable.`,
  },
  {
    pattern: /ETIMEDOUT|ECONNABORTED/i,
    category: DaemonErrorCategory.TIMEOUT,
    message: () => 'Connection timed out before the request completed.',
  },
  {
    pattern: /ENOTFOUND|EAI_AGAIN/i,
    category: DaemonErrorCategory.NETWORK,
    message: (provider) => `DNS lookup failed for ${provider ?? 'the provider'}. Check the base URL and network.`,
  },
];

function normalizeCategory(value: string | undefined): DaemonErrorCategory | undefined {
  return value === 'authentication'
    || value === 'authorization'
    || value === 'billing'
    || value === 'rate_limit'
    || value === 'timeout'
    || value === 'network'
    || value === 'bad_request'
    || value === 'not_found'
    || value === 'permission'
    || value === 'tool'
    || value === 'config'
    || value === 'protocol'
    || value === 'service'
    || value === 'internal'
    || value === 'unknown'
    ? value
    : undefined;
}

function normalizeSource(value: string | undefined): DaemonErrorSource | undefined {
  return value === 'provider'
    || value === 'tool'
    || value === 'transport'
    || value === 'config'
    || value === 'permission'
    || value === 'runtime'
    || value === 'render'
    || value === 'acp'
    || value === 'unknown'
    ? value
    : undefined;
}

function readMessage(error: unknown, fallbackMessage?: string): string {
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (error && typeof error === 'object' && typeof (error as { error?: unknown }).error === 'string') {
    return ((error as { error: string }).error).trim();
  }
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return ((error as { message: string }).message).trim();
  }
  return fallbackMessage ?? 'Unexpected error';
}

/**
 * The category structure fixes: an explicit category, an errno code in the
 * message, the HTTP status, a structured errno code, or a message that is
 * exactly an errno code. 400 and 429 stay provisional: providers report a
 * spent account under both, and `rate_limit` reads as retryable, so a caller
 * would wait out a condition that never clears. Whether one is really billing
 * is read from the wording (see settleCategory in the errors package).
 */
function fixedCategory(
  explicit: DaemonErrorCategory | undefined,
  network: { readonly category: DaemonErrorCategory } | undefined,
  status: number | undefined,
  code: string | undefined,
  message: string,
): DaemonErrorCategory | undefined {
  return explicit ?? network?.category ?? categoryForStatus(status) ?? categoryForCode(code) ?? categoryForCode(message);
}

/**
 * Whether an inferred hint may talk about model ids and tool schemas.
 *
 * The `bad_request` and `not_found` hints below describe an LLM request and
 * nothing else. They used to be attached to every 400/404 that reached this
 * module, so a calendar verb refusing a malformed range told the caller to
 * "check model id, parameters, message format, and tool schema". Hints for
 * those two categories are now only inferred when the error itself says it
 * came from a provider; other errors keep their own message (which for
 * gateway verbs already carries the problem and the fix) and get no
 * borrowed hint.
 */
function isProviderAttributed(fields: {
  readonly source?: string | undefined;
  readonly provider?: string | undefined;
  readonly providerCode?: string | undefined;
  readonly providerType?: string | undefined;
}): boolean {
  return fields.source === 'provider'
    || fields.provider !== undefined
    || fields.providerCode !== undefined
    || fields.providerType !== undefined;
}

function inferHint(
  category: DaemonErrorCategory,
  status: number | undefined,
  providerAttributed: boolean,
): string | undefined {
  if (!providerAttributed && (category === 'bad_request' || category === 'not_found')) {
    return undefined;
  }
  switch (category) {
    case 'rate_limit':
      return 'The caller may retry automatically. If this persists, wait, lower request volume, or switch models/providers.';
    case 'authentication':
      return 'The provider rejected authentication. Possible causes include invalid or expired credentials, missing account/session state, account restrictions, or the wrong provider/endpoint receiving the request.';
    case 'authorization':
      return 'Possible causes include missing model access, account permissions, safety/policy restrictions, or provider routing to a service that does not expose this model.';
    case 'billing':
      return 'Check credits, subscription status, usage limits, or account entitlements.';
    case 'timeout':
      return 'Check network stability, provider latency, and request size.';
    case 'network':
      return 'Check connectivity, DNS, TLS certificates, base URL, or any local proxy/tunnel.';
    case 'bad_request':
      return 'Check model id, parameters, message format, and tool schema.';
    case 'not_found':
      return 'Check model id, provider selection, and API path.';
    case 'protocol':
      return 'Check upstream protocol support, streaming mode, and transport stability.';
    case 'service':
      return status === 503
        ? 'The provider is temporarily unavailable. Retry shortly or switch providers if the issue persists.'
        : 'The provider returned a server-side failure. Retry shortly or switch providers if the issue persists.';
    default:
      return undefined;
  }
}

function buildSummary(
  message: string,
  metadata: {
    readonly requestId?: string | undefined;
    readonly providerCode?: string | undefined;
    readonly phase?: string | undefined;
  },
): string {
  const tags: string[] = [];
  if (metadata.phase && !message.toLowerCase().includes(metadata.phase.toLowerCase())) tags.push(`phase=${metadata.phase}`);
  if (metadata.providerCode && !message.includes(metadata.providerCode)) tags.push(`code=${metadata.providerCode}`);
  if (metadata.requestId && !message.includes(metadata.requestId)) tags.push(`request_id=${metadata.requestId}`);
  return tags.length > 0 ? `${message} (${tags.join(', ')})` : message;
}

function getNetworkErrorMessage(message: string, provider?: string): { category: DaemonErrorCategory; summary: string } | undefined {
  for (const entry of NETWORK_ERROR_PATTERNS) {
    if (entry.pattern.test(message)) {
      return {
        category: entry.category,
        summary: entry.message(provider),
      };
    }
  }
  return undefined;
}

function isStructuredErrorLike(error: unknown): error is StructuredErrorLike {
  return Boolean(
    error
    && typeof error === 'object'
    && typeof (error as { message?: unknown }).message === 'string'
    && (
      typeof (error as { code?: unknown }).code === 'string'
      || typeof (error as { status?: unknown }).status === 'number'
      || typeof (error as { statusCode?: unknown }).statusCode === 'number'
      || typeof (error as { guidance?: unknown }).guidance === 'string'
      || typeof (error as { hint?: unknown }).hint === 'string'
      || typeof (error as { provider?: unknown }).provider === 'string'
      || typeof (error as { source?: unknown }).source === 'string'
      || typeof (error as { category?: unknown }).category === 'string'
    )
  );
}

function isErrorPropertyLike(error: unknown): error is ErrorPropertyLike {
  return Boolean(
    error
    && typeof error === 'object'
    && typeof (error as { error?: unknown }).error === 'string'
  );
}

function readNumberProperty(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readStringProperty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readBooleanProperty(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Normalize any thrown value into a `StructuredDaemonErrorBody`.
 *
 * Handles `GoodVibesSdkError`, structured error-like objects, plain error-property
 * objects, and raw strings or `Error` instances. Internal pipeline fields
 * (`provider`, `operation`, `phase`, `providerCode`, `providerType`) are stripped
 * from the response unless `options.isPrivileged` is `true`.
 *
 * @param error - The caught value (any type).
 * @param options - Status code, fallback message, source override, and privilege flag.
 * @returns A normalized `StructuredDaemonErrorBody` ready for JSON serialization.
 */
export function buildErrorResponseBody(
  error: unknown,
  options: JsonErrorResponseOptions = {},
): StructuredDaemonErrorBody {
  // only expose internal pipeline fields to privileged callers.
  const isPrivileged = options.isPrivileged === true;
  if (isStructuredDaemonErrorBody(error)) {
    if (isPrivileged) return error;
    // strip pipeline-internal fields before returning to unprivileged callers.
    const safe: StructuredDaemonErrorBody = {
      error: error.error,
      ...(error.hint !== undefined ? { hint: error.hint } : {}),
      ...(error.code !== undefined ? { code: error.code } : {}),
      ...(error.category !== undefined ? { category: error.category } : {}),
      ...(error.source !== undefined ? { source: error.source } : {}),
      ...(error.recoverable !== undefined ? { recoverable: error.recoverable } : {}),
      ...(error.status !== undefined ? { status: error.status } : {}),
    };
    return safe;
  }
  if (error instanceof GoodVibesSdkError || isStructuredErrorLike(error)) {
    const status = error instanceof GoodVibesSdkError
      ? error.status
      : error.status ?? error.statusCode;
    const provider = error.provider;
    const message = error.message;
    const providerCode = error.providerCode;
    const phase = error.phase;
    const requestId = error.requestId;
    const network = getNetworkErrorMessage(message, provider);
    const fixed = fixedCategory(normalizeCategory(error.category), network, status, error.code ?? providerCode, message);
    const providerAttributed = isProviderAttributed({
      source: normalizeSource(error.source) ?? options.source,
      provider,
      providerCode,
      providerType: error.providerType,
    });
    const category = settleCategory(fixed, status, providerAttributed, options.failure);
    // A reading that turned a provisional category into billing replaces the
    // hint the error carried for that provisional category.
    const ownHint = category === fixed ? (error instanceof GoodVibesSdkError ? error.hint : error.hint ?? error.guidance) : undefined;
    const hint = ownHint ?? inferHint(category, status, providerAttributed);
    const summary = buildSummary(network?.summary ?? message, {
      requestId,
      providerCode,
      phase,
    });
    return {
      error: summary,
      ...(hint ? { hint } : {}),
      ...(error.code ? { code: error.code } : {}),
      category,
      ...(normalizeSource(error.source) ? { source: normalizeSource(error.source) } : {}),
      ...(error.recoverable !== undefined ? { recoverable: error.recoverable } : {}),
      ...(status !== undefined ? { status } : {}),
      // strip pipeline-internal fields for unprivileged callers.
      ...(isPrivileged && provider ? { provider } : {}),
      ...(isPrivileged && error.operation ? { operation: error.operation } : {}),
      ...(isPrivileged && phase ? { phase } : {}),
      ...(requestId ? { requestId } : {}),
      ...(isPrivileged && providerCode ? { providerCode } : {}),
      ...(isPrivileged && error.providerType ? { providerType: error.providerType } : {}),
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    };
  }
  if (isErrorPropertyLike(error)) {
    const rawStatus = readNumberProperty(error.status) ?? readNumberProperty(error.statusCode);
    const status = rawStatus !== undefined
      ? (rawStatus >= 100 && rawStatus <= 599 ? rawStatus : options.status)
      : options.status;
    const code = readStringProperty(error.code);
    const provider = readStringProperty(error.provider);
    const providerCode = readStringProperty(error.providerCode);
    const phase = readStringProperty(error.phase);
    const requestId = readStringProperty(error.requestId);
    const source = normalizeSource(readStringProperty(error.source));
    const recoverable = readBooleanProperty(error.recoverable);
    const operation = readStringProperty(error.operation);
    const providerType = readStringProperty(error.providerType);
    const retryAfterMs = readNumberProperty(error.retryAfterMs);
    const message = error.error.trim() || options.fallbackMessage || 'Unexpected error';
    const network = getNetworkErrorMessage(message, provider);
    const fixed = fixedCategory(normalizeCategory(readStringProperty(error.category)), network, status, code ?? providerCode, message);
    const providerAttributed = isProviderAttributed({ source: source ?? options.source, provider, providerCode, providerType });
    const category = settleCategory(fixed, status, providerAttributed, options.failure);
    const ownHint = category === fixed ? readStringProperty(error.hint) ?? readStringProperty(error.guidance) : undefined;
    const hint = ownHint ?? inferHint(category, status, providerAttributed);
    return {
      error: buildSummary(network?.summary ?? message, { requestId, providerCode, phase }),
      ...(hint ? { hint } : {}),
      ...(code ? { code } : {}),
      category,
      ...(source ? { source } : {}),
      ...(recoverable !== undefined ? { recoverable } : {}),
      ...(status !== undefined ? { status } : {}),
      // strip pipeline-internal fields for unprivileged callers.
      ...(isPrivileged && provider ? { provider } : {}),
      ...(isPrivileged && operation ? { operation } : {}),
      ...(isPrivileged && phase ? { phase } : {}),
      ...(requestId ? { requestId } : {}),
      ...(isPrivileged && providerCode ? { providerCode } : {}),
      ...(isPrivileged && providerType ? { providerType } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  }
  const message = readMessage(error, options.fallbackMessage);
  const network = getNetworkErrorMessage(message);
  const category = settleCategory(fixedCategory(undefined, network, options.status, undefined, message), options.status, options.source === 'provider', options.failure);
  const hint = inferHint(category, options.status, options.source === 'provider');
  return {
    error: network?.summary ?? message,
    ...(hint ? { hint } : {}),
    category,
    ...(options.source ? { source: options.source } : {}),
    ...(options.status !== undefined ? { status: options.status } : {}),
  };
}

/** What a reading of the error would be about, and whether structure leaves the category open. */
interface Wording {
  readonly message: string;
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly errorName: string | undefined;
  readonly open: boolean;
}

function wordingOf(error: unknown, options: JsonErrorResponseOptions): Wording | undefined {
  if (isStructuredDaemonErrorBody(error)) return undefined;
  if (error instanceof GoodVibesSdkError || isStructuredErrorLike(error)) {
    const status = error instanceof GoodVibesSdkError ? error.status : error.status ?? error.statusCode;
    const code = error.code ?? error.providerCode;
    const fixed = fixedCategory(normalizeCategory(error.category), getNetworkErrorMessage(error.message, error.provider), status, code, error.message);
    const fromProvider = isProviderAttributed({
      source: normalizeSource(error.source) ?? options.source,
      provider: error.provider,
      providerCode: error.providerCode,
      providerType: error.providerType,
    });
    return { message: error.message, status, code, errorName: error instanceof Error ? error.name : undefined, open: categoryDependsOnWording(fixed, status, fromProvider) };
  }
  if (isErrorPropertyLike(error)) {
    const rawStatus = readNumberProperty(error.status) ?? readNumberProperty(error.statusCode);
    const status = rawStatus !== undefined && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : options.status;
    const code = readStringProperty(error.code) ?? readStringProperty(error.providerCode);
    const message = error.error.trim() || options.fallbackMessage || 'Unexpected error';
    const provider = readStringProperty(error.provider);
    const fixed = fixedCategory(normalizeCategory(readStringProperty(error.category)), getNetworkErrorMessage(message, provider), status, code, message);
    const fromProvider = isProviderAttributed({
      source: normalizeSource(readStringProperty(error.source)) ?? options.source,
      provider,
      providerCode: readStringProperty(error.providerCode),
      providerType: readStringProperty(error.providerType),
    });
    return { message, status, code, errorName: undefined, open: categoryDependsOnWording(fixed, status, fromProvider) };
  }
  const message = readMessage(error, options.fallbackMessage);
  const fixed = fixedCategory(undefined, getNetworkErrorMessage(message), options.status, undefined, message);
  return {
    message,
    status: options.status,
    code: undefined,
    errorName: error instanceof Error ? error.name : undefined,
    open: categoryDependsOnWording(fixed, options.status, options.source === 'provider'),
  };
}

/**
 * {@link buildErrorResponseBody} with the error's wording read by Jev when
 * structure leaves the category open (no category from status, code or the
 * error itself, or a 400 or 429 that may be a spent account). Otherwise no
 * request is made.
 */
export async function readErrorResponseBody(
  error: unknown,
  options: JsonErrorResponseOptions & { readonly site?: string | undefined } = {},
): Promise<StructuredDaemonErrorBody> {
  const wording = wordingOf(error, options);
  if (wording === undefined || !wording.open) return buildErrorResponseBody(error, options);
  const failure = await readFailure(
    { message: wording.message, status: wording.status, code: wording.code, errorName: wording.errorName },
    options.site ?? 'daemon.error-response',
  );
  return buildErrorResponseBody(error, { ...options, failure });
}

/**
 * Produce a JSON `Response` from any thrown value, normalizing to a
 * `StructuredDaemonErrorBody` before writing the wire response. The category
 * comes from structure (the error's own category, status, errno code); a
 * caught error whose category depends on its wording goes through
 * {@link readJsonErrorResponse} instead.
 *
 * @param error - The caught value (any type).
 * @param options - Optional status, fallback message, source, and privilege flag.
 * @returns A `Response` with `Content-Type: application/json` and the resolved status.
 */
export function jsonErrorResponse(error: unknown, options: JsonErrorResponseOptions = {}): Response {
  return responseFor(buildErrorResponseBody(error, options), options);
}

/**
 * {@link jsonErrorResponse} for a caught error: when structure leaves the
 * category open, Jev reads the wording first (see {@link readErrorResponseBody}).
 */
export async function readJsonErrorResponse(
  error: unknown,
  options: JsonErrorResponseOptions & { readonly site?: string | undefined } = {},
): Promise<Response> {
  return responseFor(await readErrorResponseBody(error, options), options);
}

function responseFor(body: StructuredDaemonErrorBody, options: JsonErrorResponseOptions): Response {
  const status = options.status ?? body.status ?? 500;
  return Response.json(
    { ...body, status },
    { status },
  );
}

/**
 * Extract the human-readable error string from any thrown value, using the same
 * normalization logic as `buildErrorResponseBody`.
 *
 * @param error - The caught value (any type).
 * @param options - Optional fallback message and status for category inference.
 * @returns The normalized error message string.
 */
export function summarizeErrorForRecord(error: unknown, options: JsonErrorResponseOptions = {}): string {
  return buildErrorResponseBody(error, options).error;
}
