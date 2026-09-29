import {
  categoryDependsOnWording,
  categoryForCode,
  categoryForStatus,
  connectionSummary,
  judgmentPort,
  readFailure,
  settleCategory,
  summaryDependsOnWording,
  type FailureConclusions,
} from '@goodvibes-jev/engine/errors';
import { AppError, ProviderError, type PlatformErrorCategory, type PlatformErrorSource, type ProviderErrorOptions } from '../types/errors.js';
import type { StructuredDaemonErrorBody } from '../types/daemon-error-contract.js';
import { redactSensitiveData } from './redaction.js';
import { displayPayload, MAX_DISPLAY_MESSAGE_CHARS, payloadSpans } from './batteries/display-payload.js';

const MAX_ERROR_LENGTH = 240;

// NOTE: Category rules (status and errno tables, the billing override, the Jev
// failure reading and its connection-failure summaries) live once in the errors
// package and are shared with daemon-sdk/src/error-response.ts. The hint and
// summary-tag helpers below (inferHint, buildSummary) are still duplicated there
// because the two copies format different error hierarchies (platform
// AppError/NormalizedError vs daemon GoodVibesSdkError); keep them in sync.

export interface NormalizedError {
  readonly name: string;
  readonly message: string;
  readonly summary: string;
  readonly hint?: string | undefined;
  readonly code?: string | undefined;
  readonly category: PlatformErrorCategory;
  readonly source: PlatformErrorSource;
  readonly recoverable: boolean;
  readonly statusCode?: number | undefined;
  readonly provider?: string | undefined;
  readonly operation?: string | undefined;
  readonly phase?: string | undefined;
  readonly requestId?: string | undefined;
  readonly providerCode?: string | undefined;
  readonly providerType?: string | undefined;
  readonly retryAfterMs?: number | undefined;
}

export interface ErrorNormalizationOptions {
  readonly provider?: string | undefined;
  readonly fallbackMessage?: string | undefined;
  readonly source?: PlatformErrorSource | undefined;
  /**
   * What Jev read in the error's wording. Without it, category, source and
   * summary come from structure and the error's own message alone;
   * {@link readNormalizedError} supplies it.
   */
  readonly failure?: FailureConclusions | undefined;
}

export interface ProviderErrorNormalizationOptions extends ProviderErrorOptions {
  readonly fallbackMessage?: string | undefined;
}

function truncateMessage(msg: string): string {
  if (msg.length <= MAX_ERROR_LENGTH) return msg;
  return msg.slice(0, MAX_ERROR_LENGTH) + '\u2026';
}

function extractStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]!;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function extractStructuredMessage(msg: string): string | undefined {
  const trimmed = msg.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const record = parsed as Record<string, unknown>;
    const nestedError = record.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : undefined;
    const parts = [
      extractStringField(record, 'message'),
      nestedError ? extractStringField(nestedError, 'message') : undefined,
      nestedError ? extractStringField(nestedError, 'code') : undefined,
      nestedError ? extractStringField(nestedError, 'type') : undefined,
      extractStringField(record, 'code'),
      extractStringField(record, 'type'),
    ].filter((value): value is string => Boolean(value));
    return parts.length > 0 ? parts.join(', ') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The message to show. `display` is the message with its machine payload
 * removed, which only {@link readNormalizedError} reads; without it the
 * message is shown as the error carries it. A message that is all payload
 * falls back to the message itself rather than to nothing.
 */
function cleanMessage(msg: string, fallbackMessage?: string, display?: string): string {
  const structured = extractStructuredMessage(msg);
  if (structured) return truncateMessage(structured);
  if (display !== undefined && display.length > 0) return truncateMessage(display);
  if (msg.trim().length > 0) return truncateMessage(msg.trim());
  return fallbackMessage ?? 'Unexpected error';
}

function inferHint(category: PlatformErrorCategory, statusCode?: number): string | undefined {
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
      return statusCode === 503
        ? 'The provider is temporarily unavailable. Retry shortly or switch providers if the issue persists.'
        : 'The provider returned a server-side failure. Retry shortly or switch providers if the issue persists.';
    default:
      return undefined;
  }
}

/** Whether the source is still open once structure has spoken: only a TypeError with no stated source. */
function sourceDependsOnWording(error: unknown, override?: PlatformErrorSource): boolean {
  if (override || (error instanceof AppError && error.source)) return false;
  return error instanceof Error && error.name === 'TypeError';
}

function inferSource(error: unknown, override: PlatformErrorSource | undefined, failure: FailureConclusions | undefined): PlatformErrorSource {
  if (override) return override;
  if (error instanceof AppError && error.source) return error.source as PlatformErrorSource;
  // A TypeError that failed before any response came back is the fetch transport failing.
  if (error instanceof Error && error.name === 'TypeError' && failure?.beforeResponse === true) return 'transport';
  return 'unknown';
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

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const message = extractStringField(error as Record<string, unknown>, 'message');
    if (message) return message;
  }
  return String(error);
}

/**
 * redactedErrorMessage, extracts and redacts a human-readable message from any thrown value.
 *
 * Use for user-facing error output where the raw message should never leak
 * bearer tokens, API keys, or other sensitive data. Do NOT use for logger
 * fields, structured result/error fields, or diagnostic context, use
 * `summarizeError` or the structured `normalizeError` for those.
 */
export function redactedErrorMessage(error: unknown): string {
  return redactSensitiveData(extractErrorMessage(error));
}

interface ErrorStructure {
  readonly rawMessage: string;
  readonly statusCode: number | undefined;
  readonly provider: string | undefined;
  /** A structured code the error carries: an errno name on `code`, or a provider's error code. */
  readonly code: string | undefined;
  /** The category structure fixes: the error's own, the status, or an errno on the structured code. */
  readonly fixed: PlatformErrorCategory | undefined;
  /** Whether a provider produced the error; only a provider's 400 or 429 can turn out to be billing. */
  readonly fromProvider: boolean;
}

function structureOf(error: unknown, options: ErrorNormalizationOptions): ErrorStructure {
  // Redact Bearer tokens and API keys before any further processing.
  const rawMessage = redactSensitiveData(extractErrorMessage(error));
  const statusCode = error instanceof AppError
    ? error.statusCode
    : error && typeof error === 'object' && 'statusCode' in error && typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : error && typeof error === 'object' && 'status' in error && typeof (error as { status?: unknown }).status === 'number'
        ? (error as { status: number }).status
        : undefined;
  const provider = options.provider ?? (error instanceof AppError ? error.provider : undefined);
  const code = structuredCode(error);
  const own = error instanceof AppError && error.category ? error.category as PlatformErrorCategory : undefined;
  const fixed = own && own !== 'unknown'
    ? own
    : (categoryForStatus(statusCode) ?? categoryForCode(code)) as PlatformErrorCategory | undefined;
  const fromProvider = error instanceof ProviderError
    || options.source === 'provider'
    || (error instanceof AppError && error.source === 'provider')
    || provider !== undefined;
  return { rawMessage, statusCode, provider, code, fixed, fromProvider };
}

/** An AppError's provider code; any other error's string `code` (a Node errno such as ECONNREFUSED). */
function structuredCode(error: unknown): string | undefined {
  if (error instanceof AppError) return error.providerCode;
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && code.trim().length > 0 ? code : undefined;
}

export function normalizeError(error: unknown, options: ErrorNormalizationOptions = {}): NormalizedError {
  return normalizeWith(error, options, undefined);
}

function normalizeWith(error: unknown, options: ErrorNormalizationOptions, display: string | undefined): NormalizedError {
  const { rawMessage, statusCode, provider, fixed, fromProvider } = structureOf(error, options);
  const cleanedMessage = cleanMessage(rawMessage, options.fallbackMessage, display);
  const category = settleCategory(fixed, statusCode, fromProvider, options.failure) as PlatformErrorCategory;
  const source = inferSource(error, options.source, options.failure);
  const summary = buildSummary(connectionSummary(options.failure?.connection, provider) ?? cleanedMessage, {
    requestId: error instanceof AppError ? error.requestId : undefined,
    providerCode: error instanceof AppError ? error.providerCode : undefined,
    phase: error instanceof AppError ? error.phase : undefined,
  });
  // A reading that turned a provisional category into billing also replaces
  // the guidance the error was built with for that provisional category.
  const hint = error instanceof AppError && error.guidance && category === fixed
    ? error.guidance
    : inferHint(category, statusCode);

  return {
    name: error instanceof Error ? error.name : 'Error',
    message: cleanedMessage,
    summary,
    ...(hint ? { hint } : {}),
    ...(error instanceof AppError ? { code: error.code } : {}),
    category,
    source,
    recoverable: error instanceof AppError ? error.recoverable : false,
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(provider ? { provider } : {}),
    ...(error instanceof AppError && error.operation ? { operation: error.operation } : {}),
    ...(error instanceof AppError && error.phase ? { phase: error.phase } : {}),
    ...(error instanceof AppError && error.requestId ? { requestId: error.requestId } : {}),
    ...(error instanceof AppError && error.providerCode ? { providerCode: error.providerCode } : {}),
    ...(error instanceof AppError && error.providerType ? { providerType: error.providerType } : {}),
    ...(error instanceof AppError && error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
  };
}

/**
 * {@link normalizeError} with the error's wording read by Jev where it can
 * change what is shown: the category or source when structure leaves them
 * open, the connection-failure summary when no HTTP response came back, and
 * which bracketed parts of the message are machine payload to leave out of
 * the displayed message. When structure settles all of these, no request is
 * made.
 */
export async function readNormalizedError(
  error: unknown,
  options: ErrorNormalizationOptions & { readonly site: string },
): Promise<NormalizedError> {
  const { rawMessage, statusCode, code, fixed, fromProvider } = structureOf(error, options);
  if (rawMessage.trim().length === 0) return normalizeError(error, options);
  const wordingMatters = categoryDependsOnWording(fixed, statusCode, fromProvider)
    || sourceDependsOnWording(error, options.source)
    || summaryDependsOnWording(statusCode);
  const [failure, display] = await Promise.all([
    wordingMatters
      ? readFailure({
        message: rawMessage,
        status: statusCode,
        code,
        errorName: error instanceof Error ? error.name : undefined,
      }, options.site)
      : Promise.resolve(options.failure),
    extractStructuredMessage(rawMessage) === undefined ? readDisplayMessage(rawMessage, options.site) : Promise.resolve(undefined),
  ]);
  return normalizeWith(error, { ...options, failure }, display);
}

/**
 * The message with the bracketed parts Jev reads as machine payload removed
 * (`engine.errors.display-payload`), spaces collapsed. Only a confident yes
 * removes a part. A message longer than the display ever shows is read from
 * its opening.
 */
async function readDisplayMessage(rawMessage: string, site: string): Promise<string> {
  const message = rawMessage.slice(0, MAX_DISPLAY_MESSAGE_CHARS);
  const spans = payloadSpans(message);
  if (spans.length === 0) return message.trim();
  const run = await displayPayload.read(judgmentPort(site), message, spans, { site });
  const removed = spans.filter((span) => {
    const reading = run.readings.get(span.number);
    return reading?.verdict === 'yes' && reading.outcome === 'act';
  });
  let shown = '';
  let at = 0;
  for (const span of removed) {
    shown += `${message.slice(at, span.start)} `;
    at = span.end;
  }
  shown += message.slice(at);
  run.recordAction(`removed ${removed.length} of ${spans.length} bracketed parts from the displayed message`);
  return shown.replace(/ {2,}/g, ' ').trim();
}

export function summarizeError(error: unknown, options: ErrorNormalizationOptions = {}): string {
  return normalizeError(error, options).summary;
}

export function formatError(error: unknown, options: ErrorNormalizationOptions = {}): string {
  return formatNormalized(normalizeError(error, options));
}

/** {@link formatError} with the wording read by Jev where it matters (see {@link readNormalizedError}). */
export async function readFormattedError(
  error: unknown,
  options: ErrorNormalizationOptions & { readonly site: string },
): Promise<string> {
  return formatNormalized(await readNormalizedError(error, options));
}

function formatNormalized(normalized: NormalizedError): string {
  const lines = [normalized.summary];
  if (normalized.hint) {
    lines.push(`  Hint: ${normalized.hint}`);
  }
  if (normalized.retryAfterMs !== undefined) {
    lines.push(`  Retry in ${Math.ceil(normalized.retryAfterMs / 1000)}s`);
  }
  return lines.join('\n');
}

export function buildErrorResponseBody(error: unknown, options: ErrorNormalizationOptions = {}): StructuredDaemonErrorBody {
  const normalized = normalizeError(error, options);
  return {
    error: normalized.summary,
    ...(normalized.hint ? { hint: normalized.hint } : {}),
    ...(normalized.code ? { code: normalized.code } : {}),
    category: normalized.category,
    source: normalized.source,
    recoverable: normalized.recoverable,
    ...(normalized.statusCode !== undefined ? { status: normalized.statusCode } : {}),
    ...(normalized.provider ? { provider: normalized.provider } : {}),
    ...(normalized.operation ? { operation: normalized.operation } : {}),
    ...(normalized.phase ? { phase: normalized.phase } : {}),
    ...(normalized.requestId ? { requestId: normalized.requestId } : {}),
    ...(normalized.providerCode ? { providerCode: normalized.providerCode } : {}),
    ...(normalized.providerType ? { providerType: normalized.providerType } : {}),
    ...(normalized.retryAfterMs !== undefined ? { retryAfterMs: normalized.retryAfterMs } : {}),
  };
}

export function toProviderError(error: unknown, options: ProviderErrorNormalizationOptions = {}): ProviderError {
  if (error instanceof ProviderError) {
    return new ProviderError(error.message, {
      statusCode: error.statusCode ?? options.statusCode,
      category: (error.category ?? options.category) as PlatformErrorCategory | undefined,
      guidance: error.guidance ?? options.guidance,
      detail: error.detail ?? options.detail,
      source: 'provider',
      provider: error.provider ?? options.provider,
      operation: error.operation ?? options.operation,
      phase: error.phase ?? options.phase,
      requestId: error.requestId ?? options.requestId,
      providerCode: error.providerCode ?? options.providerCode,
      providerType: error.providerType ?? options.providerType,
      retryAfterMs: error.retryAfterMs ?? options.retryAfterMs,
      rawMessage: error.rawMessage ?? options.rawMessage ?? error.message,
    });
  }

  const normalized = normalizeError(error, {
    provider: options.provider,
    fallbackMessage: options.fallbackMessage,
    source: 'provider',
  });

  return new ProviderError(normalized.message, {
    ...(options.statusCode !== undefined || normalized.statusCode !== undefined
      ? { statusCode: options.statusCode ?? normalized.statusCode }
      : {}),
    ...(options.category
      ? { category: options.category }
      : normalized.category !== 'unknown'
        ? { category: normalized.category }
        : {}),
    ...(options.guidance
      ? { guidance: options.guidance }
      : normalized.hint
        ? { guidance: normalized.hint }
        : {}),
    ...(options.detail ? { detail: options.detail } : {}),
    source: 'provider',
    ...(options.provider ?? normalized.provider ? { provider: options.provider ?? normalized.provider } : {}),
    ...(options.operation ? { operation: options.operation } : {}),
    ...(options.phase ? { phase: options.phase } : {}),
    ...(options.requestId ?? normalized.requestId ? { requestId: options.requestId ?? normalized.requestId } : {}),
    ...(options.providerCode ?? normalized.providerCode ? { providerCode: options.providerCode ?? normalized.providerCode } : {}),
    ...(options.providerType ?? normalized.providerType ? { providerType: options.providerType ?? normalized.providerType } : {}),
    ...((options.retryAfterMs ?? normalized.retryAfterMs) !== undefined
      ? { retryAfterMs: options.retryAfterMs ?? normalized.retryAfterMs }
      : {}),
    ...(options.rawMessage
      ? { rawMessage: options.rawMessage }
      : typeof error === 'string'
        ? { rawMessage: error }
        : error instanceof Error
          ? { rawMessage: error.message }
          : {}),
  });
}

export function formatProviderError(error: ProviderError, provider?: string): string {
  return formatError(error, { provider, source: 'provider' });
}
