/**
 * calendar-api-shared.ts, the bearer-auth HTTP helper and honest degraded-state
 * mapping shared by the Google Calendar and Microsoft Graph clients. Every failed
 * response is turned into a named ApiDegradedState once its meaning is settled.
 * An unresolved 403 reading remains an explicit operational failure. A 401 is
 * `reconnect-needed`, a 403 that names a missing scope is `insufficient-scope` naming
 * that scope, a 429 is `rate-limited` carrying the honored Retry-After, everything
 * else is `provider-error` with the status.
 */

import { CalendarScopeReadingError, readMissingPermission } from './batteries/missing-permission.js';
import type { ApiDegradedState, CalendarProviderId, CalendarRequestOptions, HttpFetch, HttpResponse } from './oauth-types.js';

/** A named, honest API failure. */
export class CalendarApiError extends Error {
  readonly degraded: ApiDegradedState;
  constructor(degraded: ApiDegradedState) {
    super(degraded.detail);
    this.name = 'CalendarApiError';
    this.degraded = degraded;
  }
}

function retryAfterMs(res: HttpResponse): number {
  const header = res.header('retry-after');
  if (!header) return 1000;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(header);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : 1000;
}

/** Map a non-OK response; unresolved 403 meaning throws an operational reading error. */
export async function errorFromResponse(res: HttpResponse, provider: CalendarProviderId, options: CalendarRequestOptions = {}): Promise<CalendarApiError> {
  const bodyText = await res.text().catch(() => {
    if (res.status === 403) throw new CalendarScopeReadingError('unreadable-response');
    return '';
  });
  if (res.status === 401) {
    return new CalendarApiError({
      kind: 'reconnect-needed',
      detail: `${provider} rejected the access token (401). Reconnect the account.`,
    });
  }
  if (res.status === 403) {
    const missingScope = await readMissingPermission(provider, bodyText, res.header('www-authenticate') ?? '', options);
    if (missingScope === undefined) return new CalendarApiError({
      kind: 'provider-error', status: 403,
      detail: `${provider} refused the request (403); the response identifies no specific missing permission.`,
    });
    return new CalendarApiError({
      kind: 'insufficient-scope',
      missingScope,
      detail: `${provider} refused the request for lack of a granted scope (403).`,
    });
  }
  if (res.status === 429) {
    return new CalendarApiError({
      kind: 'rate-limited',
      retryAfterMs: retryAfterMs(res),
      detail: `${provider} rate-limited the request (429).`,
    });
  }
  return new CalendarApiError({
    kind: 'provider-error',
    status: res.status,
    detail: `${provider} returned ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}.`,
  });
}

/** Issue a bearer-authorized request, throwing a CalendarApiError on failure. */
export async function authedRequest(
  fetchImpl: HttpFetch,
  provider: CalendarProviderId,
  input: {
    readonly url: string;
    readonly method: 'GET' | 'POST';
    readonly token: string;
    readonly body?: unknown;
    readonly extraHeaders?: Readonly<Record<string, string>>;
  },
  options: CalendarRequestOptions = {},
): Promise<unknown> {
  options.signal?.throwIfAborted();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.token}`,
    Accept: 'application/json',
    ...input.extraHeaders,
  };
  if (input.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: HttpResponse;
  try {
    res = await fetchImpl({
      url: input.url,
      method: input.method,
      headers,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    });
  } catch (error) {
    options.signal?.throwIfAborted();
    throw new CalendarApiError({
      kind: 'network-error',
      detail: `Reaching ${provider} failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  options.signal?.throwIfAborted();
  if (!res.ok) throw await errorFromResponse(res, provider, options);
  return res.json();
}
