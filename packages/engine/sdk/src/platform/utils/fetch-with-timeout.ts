import { logger } from './logger.js';

const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT']);

function diagnosticMethod(url: string | URL | Request, init?: RequestInit): string {
  try {
    const value = init?.method ?? (url instanceof Request ? url.method : 'GET');
    const method = typeof value === 'string' ? value.toUpperCase() : 'OTHER';
    return HTTP_METHODS.has(method) ? method : 'OTHER';
  } catch {
    return 'OTHER';
  }
}

/** Fixed provider protocol positions, not guesses about what arbitrary text means. */
function diagnosticPath(url: URL): string {
  const parts = url.pathname.split('/');
  if (url.hostname === 'api.telegram.org' && parts[1]?.startsWith('bot')) {
    parts[1] = 'bot[redacted]';
  }
  if (url.hostname === 'hooks.slack.com') return '/[redacted]';
  if ((url.hostname === 'discord.com' || url.hostname === 'discordapp.com') && parts[1] === 'api') {
    const resource = /^v\d+$/.test(parts[2] ?? '') ? 3 : 2;
    if ((parts[resource] === 'webhooks' || parts[resource] === 'interactions') && parts.length > resource + 2) {
      parts[resource + 2] = '[redacted]';
    }
  }
  return parts.join('/');
}

/**
 * Project HTTP URL diagnostics without userinfo, fragments or any query material.
 * Unknown parameter names do not authorize publishing their values. Owners of
 * opaque credential-bearing URLs must select instrumentedFetch's opaque mode.
 */
export function sanitizeUrlForLog(url: string | URL | Request): string {
  try {
    const raw = url instanceof Request ? url.url : String(url);
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '[non-http-url]';
    return `${parsed.origin}${diagnosticPath(parsed)}${parsed.search ? '?[redacted]' : ''}`;
  } catch {
    return '[unparseable-url]';
  }
}

/**
 * instrumentedFetch, wraps the global fetch with structured OUTBOUND_HTTP logging.
 *
 * Use this in place of bare `fetch()` for non-streaming outbound HTTP calls where
 * observability is required. For streaming calls (SSE/chat completions) where the
 * caller already manages an AbortController, use fetch() directly, those streams
 * manage their own lifecycle and do not benefit from this wrapper.
 *
 * @param url    - The URL or Request to fetch.
 * @param init   - Standard RequestInit (optional).
 * @param diagnosticMode - Opaque mode is selected by the credential-owning caller;
 * it withholds the entire diagnostic URL without changing the actual request.
 */
export async function instrumentedFetch(
  url: string | URL | Request,
  init?: RequestInit,
  diagnosticMode: 'default' | 'opaque-url' = 'default',
): Promise<Response> {
  const startMs = Date.now();
  const method = diagnosticMethod(url, init);
  const safeUrl = diagnosticMode === 'default' ? sanitizeUrlForLog(url) : '[redacted-url]';
  let status = -1;
  try {
    const res = await fetch(url, init);
    status = res.status;
    return res;
  } finally {
    try {
      logger.info('OUTBOUND_HTTP', {
        type: 'OUTBOUND_HTTP', method, url: safeUrl, status,
        latencyMs: Date.now() - startMs,
      });
    } catch { /* Diagnostics must not turn a completed request into another delivery attempt. */ }
  }
}

/**
 * createTimeoutController, creates an AbortController that fires after `timeoutMs`.
 *
 * When `parentSignal` is provided the returned signal is merged with it via
 * AbortSignal.any so whichever fires first wins.
 *
 * Uses the faster `AbortSignal.timeout` fast-path when available and no parent
 * signal needs to be merged.
 *
 * @param timeoutMs    - Milliseconds before aborting.
 * @param parentSignal - Optional caller signal to merge with the timeout.
 * @returns `{ signal, dispose }`, call `dispose()` in a `finally` block to
 *   clear the underlying timer and avoid keeping the event loop alive.
 */
export function createTimeoutController(
  timeoutMs: number,
  parentSignal?: AbortSignal,
): { readonly signal: AbortSignal; dispose(): void } {
  if (typeof AbortSignal.timeout === 'function' && !parentSignal) {
    return { signal: AbortSignal.timeout(timeoutMs), dispose: () => {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('Request timed out', 'TimeoutError')),
    timeoutMs,
  );
  timer.unref?.();
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;
  return { signal, dispose: () => clearTimeout(timer) };
}

/**
 * fetchWithTimeout, wraps a fetch implementation with an AbortController timeout.
 *
 * If the caller passes a signal that is already aborted, the request is
 * rejected immediately. When both a caller signal and the internal timeout
 * controller are present, they are merged via AbortSignal.any so that
 * whichever fires first wins.
 *
 * Streaming fetches (SSE, chat completions) where the caller already manages
 * an AbortController via ChatRequest.signal should NOT use this helper,
 * pass the signal directly to fetch() as they already do.
 *
 * @param url       - The URL or Request to fetch.
 * @param init      - Standard RequestInit (optional).
 * @param timeoutMs - Milliseconds before aborting. Default: 30 000.
 * @param fetchImpl - Fetch implementation to use. Defaults to global `fetch`.
 *   Pass `instrumentedFetch` to include OUTBOUND_HTTP logging.
 */
export async function fetchWithTimeout(
  url: string | URL | Request,
  init?: RequestInit,
  timeoutMs = 30_000,
  fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
): Promise<Response> {
  const callerSignal = init?.signal as AbortSignal | undefined;
  const { signal, dispose } = createTimeoutController(timeoutMs, callerSignal);
  try {
    return await fetchImpl(url, { ...init, signal });
  } finally {
    dispose();
  }
}
