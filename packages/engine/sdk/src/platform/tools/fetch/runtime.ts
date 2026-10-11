import { currentExternalOperationSource } from '../../permissions/external-operation-scope.js';
import type { LocalhostFetchApproval, LocalhostFetchPermit } from '../../runtime/permissions/localhost-fetch-approval.js';
import { logger } from '../../utils/logger.js';
import type { Tool, ToolDefinition } from '../../types/tools.js';
import { FETCH_TOOL_SCHEMA } from './schema.js';
import type { FetchInput, FetchUrlInput, FetchAuthInput, FetchExtractMode, FetchVerbosity, FetchSanitizeMode } from './schema.js';
import type { FetchOutput, FetchUrlResult } from './types.js';
import type { ServiceRegistry } from '../../config/service-registry.js';
import { applySanitizer, resolveSanitizeMode } from './sanitizer.js';
import {
  classifyHostTrustTier,
  emitSsrfDeny,
  emitHostTrustTier,
  extractHostname,
  type TrustTierConfig,
} from './trust-tiers.js';
import { applyExtract, sniffContentType } from './extract.js';
import { headersForOtherOrigin } from './redirect-headers.js';
import { pinnedFetch, resolveCheckedAddresses, type HostResolver } from './pinned-request.js';
import type { FeatureFlagManager } from '../../runtime/feature-flags/index.js';
import { summarizeError } from '../../utils/error-display.js';
import { createTimeoutController } from '../../utils/fetch-with-timeout.js';
import { recordFetchedPagesAsUntrusted } from './untrusted-ingest.js';
import { toRecord } from '../../utils/record-coerce.js';
import { mapWithConcurrency, sleep } from '../../utils/concurrency.js';

export interface FetchRuntimeDeps {
  readonly serviceRegistry?: Pick<ServiceRegistry, 'resolveAuth'> | null | undefined;
  readonly featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null | undefined;
  /**
   * Default sanitize mode applied when a fetch call omits sanitize_mode.
   * Sourced from config (fetch.sanitizeMode) by SDK runtime services; a per-call
   * sanitize_mode still overrides. Absent → the built-in 'safe-text' default.
   */
  readonly defaultSanitizeMode?: FetchSanitizeMode | undefined;
  /**
   * Default trusted hosts (from config fetch.trustedHosts). Merged with, never
   * replaced by, per-call trusted_hosts.
   */
  readonly defaultTrustedHosts?: readonly string[] | undefined;
  /**
   * Default blocked hosts (from config fetch.blockedHosts). Merged with per-call
   * blocked_hosts.
   */
  readonly defaultBlockedHosts?: readonly string[] | undefined;
  /**
   * Cooperative cancellation: an externally-supplied signal,
   * combined with each request's own per-URL timeout signal via
   * `AbortSignal.any`. Optional and additive, omitted, behavior is
   * unchanged from before this field existed.
   */
  readonly signal?: AbortSignal | undefined;
  /**
   * Resolves a host to every A and AAAA answer before each request hop; each
   * answer is checked against the refused address ranges and the request is
   * pinned to the checked address (pinned-request.ts). Absent: the system
   * resolver.
   */
  readonly resolveHost?: HostResolver | undefined;
  /**
   * Interactive-only read of the per-project approval (fetch.allowLocalhost).
   * Autonomous operations always require fresh exact-hop admission.
   */
  readonly isLocalhostAllowed?: (() => boolean) | undefined;
  /**
   * The runtime composition returns a live exact-hop permit for autonomous
   * operations, or a legacy interactive boolean grant. A boolean can never
   * authorize an autonomous socket. Missing admission fails closed.
   */
  readonly approveLocalhostFetch?: LocalhostFetchApproval | undefined;
}

interface CacheEntry {
  data: FetchUrlResult;
  timestamp: number;
  ttl: number;
}

const MAX_CACHE_SIZE = 500;
const MAX_FETCH_URLS = 20;
const MAX_PARALLEL_FETCHES = 5;
const MAX_REDIRECTS = 10;

const DEFAULT_TIMEOUT_MS = 30_000;

export class FetchRuntimeService {
  private readonly responseCache = new Map<string, CacheEntry>();
  private cacheWriteCount = 0;

  getCached(key: string, cacheTtlSeconds: number): FetchUrlResult | null {
    const entry = this.responseCache.get(key);
    if (!entry) return null;
    if ((Date.now() - entry.timestamp) / 1000 >= cacheTtlSeconds) return null;
    return { ...entry.data, from_cache: true };
  }

  cacheSet(key: string, entry: CacheEntry): void {
    this.cacheWriteCount++;
    if (this.cacheWriteCount % 50 === 0) {
      const now = Date.now();
      for (const [cachedKey, cachedValue] of this.responseCache) {
        if (now - cachedValue.timestamp > cachedValue.ttl * 1000) {
          this.responseCache.delete(cachedKey);
        }
      }
    }
    if (this.responseCache.size >= MAX_CACHE_SIZE) {
      const oldest = this.responseCache.keys().next().value;
      if (oldest !== undefined) this.responseCache.delete(oldest);
    }
    this.responseCache.set(key, entry);
  }

  async execute(input: FetchInput, deps: FetchRuntimeDeps = {}): Promise<FetchOutput> {
    const globalExtract: FetchExtractMode = input.extract ?? 'raw';
    const parallel: boolean = input.parallel !== false;
    const verbosity: FetchVerbosity = input.verbosity ?? 'standard';
    const cacheTtlSeconds = input.cache_ttl_seconds ?? 0;
    const rateLimitMs = input.rate_limit_ms ?? 0;
    const maxContentLength = input.max_content_length;

    if (input.urls.length > MAX_FETCH_URLS) {
      return {
        success: false,
        summary: {
          total: input.urls.length,
          succeeded: 0,
          failed: input.urls.length,
          total_ms: 0,
        },
        results: [{
          url: input.urls[0]?.url ?? '',
          error: `Too many URLs: maximum ${MAX_FETCH_URLS} per fetch call`,
        }],
      };
    }

    const sanitizeMode = resolveSanitizeMode(input.sanitize_mode ?? deps.defaultSanitizeMode);
    const trustTierConfig: TrustTierConfig = {
      trustedHosts: mergeHostLists(deps.defaultTrustedHosts, input.trusted_hosts),
      blockedHosts: mergeHostLists(deps.defaultBlockedHosts, input.blocked_hosts),
    };

    const fetchOpts: FetchOneOptions = {
      globalExtract,
      verbosity,
      cacheTtlSeconds,
      maxContentLength,
      sanitizeMode,
      trustTierConfig,
      deps,
    };

    const wallStart = performance.now();
    let results: FetchUrlResult[];

    if (parallel) {
      if (rateLimitMs > 0) {
        logger.debug('fetch tool: rate_limit_ms is ignored in parallel mode; set parallel: false to enforce rate limiting');
      }
      results = await mapWithConcurrency(
        input.urls,
        MAX_PARALLEL_FETCHES,
        (urlInput) => fetchOne(urlInput, fetchOpts, this),
      );
    } else {
      results = [];
      for (let i = 0; i < input.urls.length; i++) {
        if (i > 0 && rateLimitMs > 0) {
          await sleep(rateLimitMs);
        }
        results.push(await fetchOne(input.urls[i]!, fetchOpts, this));
      }
    }

    // Page text entered the conversation here, so the ledger is told, with the
    // text, not merely the fact. This tool recorded nothing at all before; see
    // ./untrusted-ingest.ts for the gap that left and why the text is the part
    // that keeps this from refusing everything.
    recordFetchedPagesAsUntrusted(results);

    const totalMs = Math.round(performance.now() - wallStart);
    const succeeded = results.filter((result) => result.error === undefined).length;
    const failed = results.filter((result) => result.error !== undefined).length;

    const output: FetchOutput = {
      success: true,
      summary: {
        total: results.length,
        succeeded,
        failed,
        total_ms: totalMs,
      },
    };

    if (verbosity !== 'count_only') {
      output.results = results;
    }

    return output;
  }
}

export async function executeFetchInput(input: FetchInput, deps: FetchRuntimeDeps = {}): Promise<FetchOutput> {
  return new FetchRuntimeService().execute(input, deps);
}

function buildUrl(base: string, params?: Record<string, string>): string {
  if (!params || Object.keys(params).length === 0) return base;
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    throw new Error(`Invalid URL: ${base}`);
  }
  for (const [k, v] of Object.entries(params)) {
    u.searchParams.set(k, v);
  }
  return u.toString();
}

function cacheKey(
  url: string,
  params: Record<string, string> | undefined,
  extract: FetchExtractMode,
  verbosity: FetchVerbosity,
): string {
  const base = params && Object.keys(params).length > 0
    ? `${url}?${new URLSearchParams(params).toString()}`
    : url;
  return `${base}|${extract}|${verbosity}`;
}



interface FetchOneOptions {
  globalExtract: FetchExtractMode;
  verbosity: FetchVerbosity;
  cacheTtlSeconds: number;
  maxContentLength?: number | undefined;
  sanitizeMode: FetchSanitizeMode;
  trustTierConfig: TrustTierConfig;
  deps: FetchRuntimeDeps;
}

interface PreparedFetchRequest {
  headers: Record<string, string>;
  /** Lower-cased names of the headers the tool set from `auth` or `service`. */
  credentialHeaders: Set<string>;
  body?: string | FormData | undefined;
}

function applyAuthHeaders(headers: Record<string, string>, auth: FetchAuthInput): void {
  switch (auth.type) {
    case 'bearer':
      if (auth.token) {
        headers['Authorization'] = `Bearer ${auth.token}`;
      }
      break;
    case 'basic': {
      const user = auth.username ?? '';
      const pass = auth.password ?? '';
      const encoded = Buffer.from(`${user}:${pass}`).toString('base64');
      headers['Authorization'] = `Basic ${encoded}`;
      break;
    }
    case 'api-key': {
      const headerName = auth.header ?? 'X-API-Key';
      if (auth.key) {
        headers[headerName] = auth.key;
      }
      break;
    }
  }
}

function encodeFormBodyData(bodyData: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(bodyData)) {
    params.append(key, value);
  }
  return params.toString();
}

async function fetchOneRaw(
  urlInput: FetchUrlInput,
  headers: Record<string, string>,
  method: string,
  body: string | FormData | undefined,
  effectiveUrl: string,
  trustTierConfig: TrustTierConfig,
  localhostApproved: boolean,
  credentialHeaders: ReadonlySet<string>,
  externalSignal: AbortSignal | undefined,
  resolveHost: HostResolver | undefined,
  deps: FetchRuntimeDeps,
  permits: LocalhostFetchPermit[],
): Promise<Response> {
  const { signal: timeoutSignal, dispose } = createTimeoutController(urlInput.timeout_ms ?? DEFAULT_TIMEOUT_MS);
  const signal = externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal;
  try {
    // Redirect chains are ALWAYS validated hop-by-hop, host blocking is
    // absolute and does not depend on the sanitization mode or kill switch.
    return await fetchWithValidatedRedirects({
      url: effectiveUrl,
      method,
      headers,
      body,
      signal,
      trustTierConfig,
      localhostApproved,
      credentialHeaders,
      resolveHost,
      deps,
      permits,
      originalRequest: urlInput,
    });
  } finally {
    dispose();
  }
}

async function fetchWithValidatedRedirects(input: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | FormData | undefined;
  signal: AbortSignal;
  trustTierConfig: TrustTierConfig;
  localhostApproved: boolean;
  deps: FetchRuntimeDeps;
  permits: LocalhostFetchPermit[];
  originalRequest: FetchUrlInput;
  credentialHeaders: ReadonlySet<string>;
  resolveHost?: HostResolver | undefined;
}): Promise<Response> {
  let currentUrl = input.url;
  let currentMethod = input.method;
  let currentBody = input.body;
  let currentHeaders = { ...input.headers };
  const autonomousLocalhostStart = currentExternalOperationSource() !== undefined
    && classifyHostTrustTier(extractHostname(input.url) ?? '', input.trustTierConfig).tier === 'localhost';

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const operation = currentExternalOperationSource();
    const priorPermits = [...input.permits];
    const assertCurrent = () => {
      input.signal.throwIfAborted(); operation?.signal?.throwIfAborted(); operation?.assertCurrent();
      for (const prior of priorPermits) prior.assertCurrent();
    };
    assertCurrent();
    const host = extractHostname(currentUrl);
    const local = host !== null && classifyHostTrustTier(host, input.trustTierConfig).tier === 'localhost';
    let permit: LocalhostFetchPermit | undefined;
    let localhostApproved = input.localhostApproved;
    if (local && operation) {
      const request: FetchUrlInput = {
        url: currentUrl, method: currentMethod as FetchUrlInput['method'], headers: { ...currentHeaders },
        ...(typeof currentBody === 'string' ? { body: currentBody } : {}),
        ...(currentBody instanceof FormData ? { body_type: 'multipart' as const,
          body_data: Object.fromEntries([...currentBody.entries()].map(([key, value]) => [key, String(value)])) } : {}),
      };
      const approved = await input.deps.approveLocalhostFetch?.({ url: currentUrl, host: host!, request,
        originalRequest: input.originalRequest, credentialHeaders: [...input.credentialHeaders] }, { signal: input.signal, assertCurrent });
      if (!approved || typeof approved === 'boolean') throw new Error('Request blocked: autonomous localhost fetch requires exact-hop admission');
      permit = approved;
      input.permits.push(permit);
      assertCurrent();
      permit.assertCurrent();
      localhostApproved = true;
    }
    // Final claim follows checked DNS. The live guard also protects every address retry.
    const addresses = await resolveCheckedAddresses(currentUrl, { trustTierConfig: input.trustTierConfig, localhostApproved, resolveHost: input.resolveHost });
    assertCurrent();
    permit?.assertCurrent();
    permit?.claim();
    const guard = () => { assertCurrent(); permit?.assertCurrent(); };
    const response = await pinnedFetch(currentUrl, {
      method: currentMethod,
      ...(Object.keys(currentHeaders).length > 0 ? { headers: currentHeaders as HeadersInit } : {}),
      ...(currentBody !== undefined ? { body: currentBody } : {}),
      signal: AbortSignal.any([input.signal, ...input.permits.map(owned => owned.signal)]),
      redirect: 'manual',
    } as RequestInit, addresses, 'default', guard);
    guard();

    if (!isRedirectStatus(response.status)) return response;

    const location = response.headers.get('location');
    if (!location) return response;
    if (redirectCount === MAX_REDIRECTS) {
      throw new Error(`Too many redirects after ${MAX_REDIRECTS} hops`);
    }

    const nextUrl = new URL(location, currentUrl).toString();
    const nextHost = extractHostname(nextUrl);
    if (nextHost !== null) {
      const trustResult = classifyHostTrustTier(nextHost, input.trustTierConfig);
      emitHostTrustTier(nextHost, nextUrl, trustResult);
      if (trustResult.tier === 'blocked') {
        if (trustResult.isSsrf) emitSsrfDeny(nextHost, nextUrl, trustResult.reason);
        throw new Error(`Redirect blocked: ${trustResult.reason}`);
      }
      if (trustResult.tier === 'localhost' && !input.localhostApproved && !autonomousLocalhostStart) {
        // A public origin redirecting into loopback is an SSRF vector; only an
        // approved-for-this-project localhost target may be followed.
        emitSsrfDeny(nextHost, nextUrl, trustResult.reason);
        throw new Error(`Redirect blocked: ${trustResult.reason}`);
      }
    }

    if (shouldRewriteRedirectToGet(response.status, currentMethod)) {
      currentMethod = 'GET';
      currentBody = undefined;
      currentHeaders = removeContentHeaders(currentHeaders);
    }
    if (new URL(nextUrl).origin !== new URL(currentUrl).origin) {
      currentHeaders = await headersForOtherOrigin(currentHeaders, input.credentialHeaders);
    }
    currentUrl = nextUrl;
  }

  throw new Error(`Too many redirects after ${MAX_REDIRECTS} hops`);
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function shouldRewriteRedirectToGet(status: number, method: string): boolean {
  const upper = method.toUpperCase();
  return status === 303 || ((status === 301 || status === 302) && upper === 'POST');
}

function removeContentHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => {
      const normalized = key.toLowerCase();
      return normalized !== 'content-type' && normalized !== 'content-length';
    }),
  );
}

async function prepareFetchRequest(
  urlInput: FetchUrlInput,
  extractMode: FetchExtractMode,
  deps: FetchRuntimeDeps,
): Promise<PreparedFetchRequest> {
  // The credentials the tool adds itself, kept apart so a cross-origin
  // redirect drops them by where they came from (redirect-headers.ts).
  const toolHeaders: Record<string, string> = {};
  if (urlInput.auth) {
    applyAuthHeaders(toolHeaders, urlInput.auth);
  } else if (urlInput.service) {
    Object.assign(toolHeaders, await deps.serviceRegistry?.resolveAuth(urlInput.service) ?? {});
  }
  const headers: Record<string, string> = { ...(urlInput.headers ?? {}), ...toolHeaders };
  const credentialHeaders = new Set(Object.keys(toolHeaders).map((name) => name.toLowerCase()));

  // The caller's `extract: 'json'` states it wants JSON; Accept is how HTTP
  // asks the server for it (RFC 9110 §12.5.1). A caller's own Accept wins.
  if (extractMode === 'json' && !Object.keys(headers).some((h) => h.toLowerCase() === 'accept')) {
    headers['Accept'] = 'application/json';
  }

  const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
  let body: string | FormData | undefined;

  if (urlInput.body_type === 'multipart' && urlInput.body_data) {
    const form = new FormData();
    for (const [k, v] of Object.entries(urlInput.body_data)) {
      form.append(k, v);
    }
    body = form;
  } else if (urlInput.body_type === 'form' && urlInput.body_data) {
    body = encodeFormBodyData(urlInput.body_data);
    if (!hasContentType) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  } else if (urlInput.body_base64 !== undefined) {
    body = Buffer.from(urlInput.body_base64, 'base64').toString();
    if (!hasContentType) {
      headers['Content-Type'] = urlInput.body_type === 'form'
        ? 'application/x-www-form-urlencoded'
        : 'application/json';
    }
  } else if (urlInput.body !== undefined) {
    body = urlInput.body;
    if (!hasContentType) {
      headers['Content-Type'] = urlInput.body_type === 'form'
        ? 'application/x-www-form-urlencoded'
        : 'application/json';
    }
  }

  return { headers, credentialHeaders, body };
}

function buildFetchResultBase(
  urlInput: FetchUrlInput,
  response: Response,
  durationMs: number,
): FetchUrlResult {
  return {
    url: urlInput.url,
    status: response.status,
    statusText: response.statusText,
    duration_ms: durationMs,
  };
}

async function fetchOne(
  urlInput: FetchUrlInput,
  opts: FetchOneOptions,
  runtime: FetchRuntimeService,
): Promise<FetchUrlResult> {
  const { globalExtract, verbosity, cacheTtlSeconds, maxContentLength, sanitizeMode, trustTierConfig, deps } = opts;
  const extractMode: FetchExtractMode = urlInput.extract ?? globalExtract;
  const method = urlInput.method ?? 'GET';
  const effectiveMaxContent = urlInput.max_content_length ?? maxContentLength;

  const effectiveUrl = buildUrl(urlInput.url, urlInput.params);
  // Content sanitization respects the kill switch; host blocking does not.
  const sanitizationEnabled = deps.featureFlags?.isEnabled('fetch-sanitization') ?? true;
  const effectiveSanitizeModeForBlocked = sanitizationEnabled ? sanitizeMode : 'none';

  const hostname = extractHostname(urlInput.url);
  let initialTrustResult: ReturnType<typeof classifyHostTrustTier> | null = null;
  let localhostApproved = false;
  if (hostname !== null) {
    initialTrustResult = classifyHostTrustTier(hostname, trustTierConfig);
    emitHostTrustTier(hostname, urlInput.url, initialTrustResult);

    // Private-IP / metadata-endpoint blocking is absolute: no configuration,
    // approval, or kill switch relaxes it. The tool result carries the honest
    // reason; nothing else is surfaced.
    if (initialTrustResult.tier === 'blocked') {
      if (initialTrustResult.isSsrf) {
        emitSsrfDeny(hostname, urlInput.url, initialTrustResult.reason);
      }
      return {
        url: urlInput.url,
        error: `Request blocked: ${initialTrustResult.reason}`,
        host_trust_tier: 'blocked',
        sanitization_tier: effectiveSanitizeModeForBlocked,
      };
    }

    // Loopback dev servers: allowed for this project, or a one-tap ask that
    // persists the approval; otherwise refused with the setting named.
    if (initialTrustResult.tier === 'localhost' && !currentExternalOperationSource()) {
      localhostApproved = deps.isLocalhostAllowed?.() ?? false;
      if (!localhostApproved && deps.approveLocalhostFetch) {
        try {
          localhostApproved = await deps.approveLocalhostFetch({ url: effectiveUrl, host: hostname, originalRequest: urlInput }) === true;
        } catch {
          localhostApproved = false;
        }
      }
      if (!localhostApproved) {
        return {
          url: urlInput.url,
          error: `Request blocked: localhost fetch to "${hostname}" is not approved for this project. `
            + 'Approve the localhost fetch ask (allow for this project) or set fetch.allowLocalhost to true.',
          host_trust_tier: 'localhost',
          sanitization_tier: effectiveSanitizeModeForBlocked,
        };
      }
    }
  }

  if (!currentExternalOperationSource() && cacheTtlSeconds > 0 && method === 'GET') {
    const key = cacheKey(urlInput.url, urlInput.params, extractMode, verbosity);
    const cached = runtime.getCached(key, cacheTtlSeconds);
    if (cached) {
      return cached;
    }
  }

  const { headers, credentialHeaders, body: requestBody } = await prepareFetchRequest(urlInput, extractMode, deps);
  const startTime = performance.now();
  const permits: LocalhostFetchPermit[] = [];

  try {
    let response = await fetchOneRaw(
      urlInput,
      headers,
      method,
      requestBody,
      effectiveUrl,
      trustTierConfig,
      localhostApproved,
      credentialHeaders,
      deps.signal,
      deps.resolveHost,
      deps,
      permits,
    );

    for (const permit of permits) permit.assertCurrent();
    const retryOnAuth = urlInput.retry_on_auth ?? (urlInput.service !== undefined);
    if (response.status === 401 && retryOnAuth && urlInput.service && !(requestBody instanceof FormData)) {
      const refreshedHeaders = await deps.serviceRegistry?.resolveAuth(urlInput.service);
      if (refreshedHeaders) {
        const retryHeaders = { ...headers };
        Object.assign(retryHeaders, refreshedHeaders);
        const retryCredentialHeaders = new Set([...credentialHeaders, ...Object.keys(refreshedHeaders).map((name) => name.toLowerCase())]);
        response = await fetchOneRaw(
          urlInput,
          retryHeaders,
          method,
          requestBody,
          effectiveUrl,
          trustTierConfig,
          localhostApproved,
          retryCredentialHeaders,
          deps.signal,
          deps.resolveHost,
          deps,
          permits,
        );
      }
    }

    const durationMs = Math.round(performance.now() - startTime);
    let contentType = response.headers.get('content-type') ?? '';
    const bodyResult = await readResponseText(response, effectiveMaxContent);
    for (const permit of permits) permit.assertCurrent();
    let rawBody = bodyResult.text;
    contentType = sniffContentType(contentType, rawBody);

    const truncated = bodyResult.truncated;

    const byteSize = Buffer.byteLength(rawBody, 'utf-8');
    const result: FetchUrlResult = buildFetchResultBase(urlInput, response, durationMs);

    if (verbosity === 'count_only') {
      cacheSuccessfulGet(runtime, cacheTtlSeconds, method, cacheKey(urlInput.url, urlInput.params, extractMode, verbosity), result);
      return result;
    }

    result.contentType = contentType;
    result.byteSize = byteSize;
    if (truncated) result.truncated = true;
    result.redirected = response.redirected;
    result.final_url = response.url !== effectiveUrl ? response.url : undefined;

    let effectiveSanitizeMode = sanitizationEnabled ? sanitizeMode : 'none' as const;
    if (sanitizationEnabled && hostname !== null) {
      const hostTrustResult = initialTrustResult ?? classifyHostTrustTier(hostname, trustTierConfig);
      result.host_trust_tier = hostTrustResult.tier;
      if (hostTrustResult.tier === 'unknown' && effectiveSanitizeMode === 'none') {
        effectiveSanitizeMode = 'safe-text';
      }
    } else if (hostname !== null && initialTrustResult !== null) {
      result.host_trust_tier = initialTrustResult.tier;
    }

    if (verbosity === 'minimal') {
      result.sanitization_tier = 'skipped';
    } else {
      result.sanitization_tier = effectiveSanitizeMode;
    }

    if (verbosity !== 'minimal') {
      const extracted = await applyExtract(rawBody, contentType, extractMode, { selectors: urlInput.selectors });
      const sanitized = applySanitizer(extracted, effectiveSanitizeMode);
      logger.debug('SANITIZE_MODE_APPLIED', {
        event: 'SANITIZE_MODE_APPLIED',
        url: urlInput.url,
        mode: effectiveSanitizeMode,
        modified: sanitized.modified,
      });
      result.content = sanitized.content;
      result.tokens_used = Math.ceil(sanitized.content.length / 4);
    }

    if (verbosity === 'verbose') {
      const respHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        respHeaders[key] = value;
      });
      result.metadata = {
        headers: respHeaders,
        redirected: response.redirected,
        finalUrl: response.url,
      };
    }

    cacheSuccessfulGet(runtime, cacheTtlSeconds, method, cacheKey(urlInput.url, urlInput.params, extractMode, verbosity), result);
    return result;
  } catch (err) {
    const durationMs = Math.round(performance.now() - startTime);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    const message = isTimeout
      ? `Timeout after ${urlInput.timeout_ms ?? DEFAULT_TIMEOUT_MS}ms`
      : err instanceof Error
        ? err.message
        : summarizeError(err);
    logger.warn('fetch tool: request failed', { url: urlInput.url, error: message });
    return { url: urlInput.url, error: message, duration_ms: durationMs,
      ...(initialTrustResult?.tier === 'localhost' ? { host_trust_tier: 'localhost' as const } : {}) };
  } finally {
    for (const permit of permits) permit.close();
  }
}

async function readResponseText(
  response: Response,
  maxBytes: number | undefined,
): Promise<{ text: string; truncated: boolean }> {
  if (maxBytes === undefined || maxBytes <= 0 || !response.body) {
    return { text: await response.text(), truncated: false };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      if (remaining <= 0) {
        truncated = true;
        await cancelResponseReader(reader, 'Response body limit reached');
        break;
      }
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      text += decoder.decode(chunk, { stream: true });
      total += chunk.byteLength;
      if (value.byteLength > remaining) {
        truncated = true;
        await cancelResponseReader(reader, 'Response body limit reached');
        break;
      }
    }
    text += decoder.decode();
    return { text, truncated };
  } finally {
    reader.releaseLock();
  }
}

async function cancelResponseReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: string,
): Promise<void> {
  try {
    await reader.cancel(reason);
  } catch (error) {
    logger.warn('Fetch response reader cancel failed', {
      reason,
      error: summarizeError(error),
    });
  }
}

function cacheSuccessfulGet(
  runtime: FetchRuntimeService,
  cacheTtlSeconds: number,
  method: string,
  key: string,
  result: FetchUrlResult,
): void {
  if (cacheTtlSeconds > 0 && method === 'GET') {
    runtime.cacheSet(key, { data: result, timestamp: Date.now(), ttl: cacheTtlSeconds });
  }
}

/**
 * Union of a config-supplied default host list with the per-call host list.
 * Per-call hosts are ADDED to (never replace) the config defaults; duplicates are
 * removed. Returns undefined when the union is empty so TrustTierConfig keeps its
 * "no list supplied" semantics unchanged.
 */
function mergeHostLists(
  defaults: readonly string[] | undefined,
  perCall: readonly string[] | undefined,
): string[] | undefined {
  const merged = [...(defaults ?? []), ...(perCall ?? [])]
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  if (merged.length === 0) return undefined;
  return [...new Set(merged)];
}

export function createFetchTool(
  deps: FetchRuntimeDeps = {},
  runtime = new FetchRuntimeService(),
): Tool {
  return {
    definition: {
      name: 'fetch',
      description:
        'Fetch one or more URLs via HTTP. Supports batch parallel/sequential requests,'
        + ' per-URL method/headers/body/params, extraction modes (raw, text, json, markdown,'
        + ' readable, code_blocks, links, metadata, structured, tables, pdf, summary),'
        + ' per-URL timeouts, caching, rate limiting, auth refresh, content-length limits,'
        + ' redirect tracking, timing metrics, token estimation, and verbosity control.',
      parameters: toRecord(FETCH_TOOL_SCHEMA),
      sideEffects: ['network'],
      concurrency: 'parallel',
      supportsProgress: true,
      supportsStreamingOutput: true,
    },

    async execute(
      args: Record<string, unknown>,
      opts?: { readonly signal?: AbortSignal | undefined },
    ): Promise<{ success: boolean; output?: string; error?: string }> {
      if (!Array.isArray(args.urls) || args.urls.length === 0) {
        return { success: false, error: 'Missing or empty "urls" array' };
      }

      try {
        const input = { ...args, urls: args.urls } as unknown as FetchInput;
        const effectiveDeps = opts?.signal ? { ...deps, signal: opts.signal } : deps;
        const output = await runtime.execute(input, effectiveDeps);
        return { success: true, output: JSON.stringify(output) };
      } catch (err) {
        const message = summarizeError(err);
        logger.error('fetch tool: unexpected error', { error: message });
        return { success: false, error: `Unexpected error: ${message}` };
      }
    },
  };
}
