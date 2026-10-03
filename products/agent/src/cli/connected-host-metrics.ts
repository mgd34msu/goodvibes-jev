import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { readConnectedHostOperatorToken } from '../runtime/connected-host-auth.ts';
import { connectedHostBaseUrl } from '../config/connected-host-dial.ts';

/**
 * Reads the connected daemon host's process-wide runtime metrics snapshot via
 * the operator gateway's `runtime.metrics.get` verb (REST binding
 * GET /api/runtime/metrics, scope read:telemetry) so `goodvibes-agent status`
 * can show live host counters/gauges alongside the rest of the connected-host
 * posture.
 *
 * Honesty is the whole point of the classification below: the metrics route
 * requires the read:telemetry scope, and a token without it is answered 403 by
 * the gateway. That case is reported as `scope_missing` and rendered as a plain
 * "not permitted" line, never as a screen of zeros that would misrepresent an
 * unauthorized token as a healthy-but-idle host. Missing token, an unreachable
 * host, and an incompatible/absent route are each surfaced as their own honest
 * state too.
 */

export type CliConnectedHostMetricsStatus =
  | 'ok'
  | 'auth_required'
  | 'scope_missing'
  | 'route_unavailable'
  | 'unavailable'
  | 'error';

/** The compact, already-narrowed set of host metrics this surface renders. */
export interface CliConnectedHostMetrics {
  readonly httpRequestsTotal: number;
  readonly llmRequestsTotal: number;
  readonly authSuccessTotal: number;
  readonly authFailureTotal: number;
  readonly transportRetriesTotal: number;
  readonly sessionsActive: number;
  readonly sseSubscribers: number;
  readonly telemetryBufferFill: number;
}

export interface CliConnectedHostMetricsSnapshot {
  readonly route: '/api/runtime/metrics';
  readonly methodId: 'runtime.metrics.get';
  readonly requiredScope: 'read:telemetry';
  readonly status: CliConnectedHostMetricsStatus;
  readonly statusCode: number | null;
  readonly metrics: CliConnectedHostMetrics | null;
  readonly error: string | null;
}

export interface CliConnectedHostMetricsInspectionOptions {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly homeDirectory: string;
  readonly timeoutMs?: number;
}

// Same base-url resolution the connected-host status probe uses
// (cli/external-runtime.ts): controlPlane.host/port, defaulting to the local
// daemon. Kept in step with that module so both probes target one host.
function resolveBaseUrl(configManager: Pick<ConfigManager, 'get'>): string {
  return connectedHostBaseUrl(
    configManager.get('controlPlane.host'),
    configManager.get('controlPlane.port'),
  );
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Sum a counter bucket (label -> count), tolerating a missing/!object bucket. */
function sumBucket(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  let total = 0;
  for (const entry of Object.values(value as Record<string, unknown>)) total += readNumber(entry);
  return total;
}

function narrowMetrics(body: unknown): CliConnectedHostMetrics | null {
  if (!body || typeof body !== 'object') return null;
  const root = body as Record<string, unknown>;
  const counters = (root.counters ?? {}) as Record<string, unknown>;
  const gauges = (root.gauges ?? {}) as Record<string, unknown>;
  const http = (counters.http ?? {}) as Record<string, unknown>;
  const llm = (counters.llm ?? {}) as Record<string, unknown>;
  const auth = (counters.auth ?? {}) as Record<string, unknown>;
  const transport = (counters.transport ?? {}) as Record<string, unknown>;
  const sessions = (gauges.sessions ?? {}) as Record<string, unknown>;
  const sse = (gauges.sse ?? {}) as Record<string, unknown>;
  const telemetry = (gauges.telemetry ?? {}) as Record<string, unknown>;
  const httpRequests = (http.requests ?? {}) as Record<string, unknown>;
  const llmRequests = (llm.requests ?? {}) as Record<string, unknown>;
  const authSuccess = (auth.success ?? {}) as Record<string, unknown>;
  const authFailure = (auth.failure ?? {}) as Record<string, unknown>;
  const telemetryBuffer = (telemetry.buffer ?? {}) as Record<string, unknown>;
  return {
    httpRequestsTotal: sumBucket(httpRequests.total),
    llmRequestsTotal: sumBucket(llmRequests.total),
    authSuccessTotal: readNumber(authSuccess.total),
    authFailureTotal: readNumber(authFailure.total),
    transportRetriesTotal: readNumber(transport.retries_total),
    sessionsActive: readNumber(sessions.active),
    sseSubscribers: readNumber(sse.subscribers),
    telemetryBufferFill: readNumber(telemetryBuffer.fill),
  };
}

export async function inspectConnectedHostMetrics(
  options: CliConnectedHostMetricsInspectionOptions,
): Promise<CliConnectedHostMetricsSnapshot> {
  const route = '/api/runtime/metrics' as const;
  const base = {
    route,
    methodId: 'runtime.metrics.get' as const,
    requiredScope: 'read:telemetry' as const,
  };
  const baseUrl = resolveBaseUrl(options.configManager);
  const token = readConnectedHostOperatorToken(options.homeDirectory);
  if (!token.token) {
    return { ...base, status: 'auth_required', statusCode: null, metrics: null, error: `No connected-host operator token found at ${token.path}` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 1500);
  try {
    const response = await fetch(`${baseUrl}${route}`, {
      headers: { authorization: `Bearer ${token.token}` },
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown = text;
    if (text.trim().length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }

    if (response.ok) {
      const metrics = narrowMetrics(body);
      return metrics
        ? { ...base, status: 'ok', statusCode: response.status, metrics, error: null }
        : { ...base, status: 'error', statusCode: response.status, metrics: null, error: 'Connected host returned a runtime metrics body Agent could not read.' };
    }
    // 403 is the token-lacks-read:telemetry case: report it plainly rather than
    // rendering zeros. 401 is unauthenticated; 404 means the route/verb is not
    // present on this host (older or incompatible daemon).
    const status: CliConnectedHostMetricsStatus =
      response.status === 403 ? 'scope_missing'
        : response.status === 401 ? 'auth_required'
          : response.status === 404 ? 'route_unavailable'
            : 'error';
    return {
      ...base,
      status,
      statusCode: response.status,
      metrics: null,
      error: typeof body === 'string' && body.trim() ? body : `HTTP ${response.status}`,
    };
  } catch (error) {
    return { ...base, status: 'unavailable', statusCode: null, metrics: null, error: summarizeError(error) };
  } finally {
    clearTimeout(timer);
  }
}
