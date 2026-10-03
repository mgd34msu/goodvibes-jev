import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectedHostBaseUrl } from '../config/connected-host-dial.ts';
import type { CommandContext } from './command-registry.ts';

export interface ConnectedHostConnection {
  readonly baseUrl: string;
  readonly token: string | null;
  readonly tokenPath: string;
}

export interface ConnectedHostRouteSuccess {
  readonly ok: true;
  readonly route: string;
  readonly body: unknown;
}

export interface ConnectedHostRouteFailure {
  readonly ok: false;
  readonly route: string;
  readonly kind: 'auth_required' | 'connected_host_unavailable' | 'connected_host_route_unavailable' | 'connected_host_error';
  readonly baseUrl: string;
  readonly message: string;
}

export type ConnectedHostRouteResult = ConnectedHostRouteSuccess | ConnectedHostRouteFailure;

export const CONNECTED_HOST_FAILURE_LABELS: Record<ConnectedHostRouteFailure['kind'], string> = {
  auth_required: 'auth required',
  connected_host_unavailable: 'connected host unavailable',
  connected_host_route_unavailable: 'connected host route unavailable',
  connected_host_error: 'connected host error',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function resolveConnectedHostConnection(context: CommandContext): ConnectedHostConnection {
  const baseUrl = connectedHostBaseUrl(
    context.platform?.configManager?.get('controlPlane.host'),
    context.platform?.configManager?.get('controlPlane.port'),
  );
  const homeDirectory = context.workspace?.shellPaths?.homeDirectory ?? process.env.HOME ?? '';
  const tokenPath = join(homeDirectory, '.goodvibes', 'daemon', 'operator-tokens.json');
  if (!existsSync(tokenPath)) return { baseUrl, token: null, tokenPath };
  try {
    const parsed = JSON.parse(readFileSync(tokenPath, 'utf-8')) as unknown;
    const token = isRecord(parsed) && typeof parsed.token === 'string' ? parsed.token : null;
    return { baseUrl, token, tokenPath };
  } catch {
    return { baseUrl, token: null, tokenPath };
  }
}

export async function fetchConnectedHostReadOnlyRoute(
  context: CommandContext,
  route: string,
): Promise<ConnectedHostRouteResult> {
  const connection = resolveConnectedHostConnection(context);
  if (!connection.token) {
    return {
      ok: false,
      route,
      kind: 'auth_required',
      baseUrl: connection.baseUrl,
      message: `No connected-host operator token found at ${connection.tokenPath}`,
    };
  }

  try {
    const response = await fetch(`${connection.baseUrl}${route}`, {
      headers: { authorization: `Bearer ${connection.token}` },
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
    if (!response.ok) {
      const detail = isRecord(body) && typeof body.error === 'string' ? body.error : text;
      return {
        ok: false,
        route,
        kind: response.status === 401 || response.status === 403
          ? 'auth_required'
          : response.status === 404
            ? 'connected_host_route_unavailable'
            : 'connected_host_error',
        baseUrl: connection.baseUrl,
        message: `HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
      };
    }
    return { ok: true, route, body };
  } catch (error) {
    return {
      ok: false,
      route,
      kind: 'connected_host_unavailable',
      baseUrl: connection.baseUrl,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function formatConnectedHostRouteFailure(
  title: string,
  failure: ConnectedHostRouteFailure,
  policy = 'read-only; no mutation route was called',
): string {
  return [
    `${title}: unavailable`,
    `  status: ${CONNECTED_HOST_FAILURE_LABELS[failure.kind]}`,
    `  kind: ${failure.kind}`,
    `  connected host: ${failure.baseUrl}`,
    `  route: ${failure.route}`,
    `  error: ${failure.message}`,
    `  policy: ${policy}`,
  ].join('\n');
}
