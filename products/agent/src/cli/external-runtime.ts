import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { readConnectedHostOperatorToken } from '../runtime/connected-host-auth.ts';
import { connectedHostBaseUrl } from '../config/connected-host-dial.ts';

export interface CliExternalRuntimeInspectionOptions {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly homeDirectory: string;
  readonly timeoutMs?: number;
}

export interface CliExternalRuntimeSnapshot {
  readonly baseUrl: string;
  readonly statusCode: number | null;
  readonly reachable: boolean;
  readonly compatible: boolean;
  readonly operatorToken: {
    readonly present: boolean;
    readonly path: string;
  };
  readonly agentKnowledge: {
    readonly route: '/api/goodvibes-agent/knowledge/status';
    readonly ready: boolean;
    readonly kind: 'ok' | 'auth_required' | 'connected_host_unavailable' | 'connected_host_incompatible' | 'connected_host_route_unavailable' | 'connected_host_error';
    readonly statusCode: number | null;
  };
  readonly error: string | null;
}

function resolveBaseUrl(configManager: Pick<ConfigManager, 'get'>): string {
  // `doctor` prints this string. It used to echo the bind host verbatim, so a
  // daemon bound to 0.0.0.0 reported `baseUrl: http://0.0.0.0:3421`, an
  // address the probe below then failed to reach.
  return connectedHostBaseUrl(
    configManager.get('controlPlane.host'),
    configManager.get('controlPlane.port'),
  );
}

async function fetchJson(
  url: string,
  token: string | null,
  timeoutMs: number,
): Promise<{ readonly ok: boolean; readonly status: number; readonly body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
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
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export async function inspectCliExternalRuntime(
  options: CliExternalRuntimeInspectionOptions,
): Promise<CliExternalRuntimeSnapshot> {
  const baseUrl = resolveBaseUrl(options.configManager);
  const token = readConnectedHostOperatorToken(options.homeDirectory, baseUrl);
  const timeoutMs = options.timeoutMs ?? 1500;
  const route = '/api/goodvibes-agent/knowledge/status' as const;

  try {
    const status = await fetchJson(`${baseUrl}/status`, token.token, timeoutMs);

    if (!status.ok) {
      return {
        baseUrl,
        statusCode: status.status,
        reachable: false,
        compatible: false,
        operatorToken: { present: Boolean(token.token), path: token.path },
        agentKnowledge: {
          route,
          ready: false,
          kind: status.status === 401 ? 'auth_required' : 'connected_host_unavailable',
          statusCode: status.status,
        },
        error: typeof status.body === 'string' ? status.body : `HTTP ${status.status}`,
      };
    }

    if (!token.token) {
      return {
        baseUrl,
        statusCode: status.status,
        reachable: true,
        compatible: false,
        operatorToken: { present: false, path: token.path },
        agentKnowledge: {
          route,
          ready: false,
          kind: 'auth_required',
          statusCode: null,
        },
        error: null,
      };
    }

    const knowledge = await fetchJson(`${baseUrl}${route}`, token.token, timeoutMs);
    const compatible = knowledge.ok;
    return {
      baseUrl,
      statusCode: status.status,
      reachable: true,
      compatible,
      operatorToken: { present: true, path: token.path },
      agentKnowledge: {
        route,
        ready: knowledge.ok,
        kind: knowledge.ok
          ? 'ok'
          : knowledge.status === 401
            ? 'auth_required'
            : knowledge.status === 404
              ? 'connected_host_route_unavailable'
              : 'connected_host_error',
        statusCode: knowledge.status,
      },
      error: knowledge.ok ? null : typeof knowledge.body === 'string' ? knowledge.body : `HTTP ${knowledge.status}`,
    };
  } catch (error) {
    return {
      baseUrl,
      statusCode: null,
      reachable: false,
      compatible: false,
      operatorToken: { present: Boolean(token.token), path: token.path },
      agentKnowledge: {
        route,
        ready: false,
        kind: 'connected_host_unavailable',
        statusCode: null,
      },
      error: summarizeError(error),
    };
  }
}
