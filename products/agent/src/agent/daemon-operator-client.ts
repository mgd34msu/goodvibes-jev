/**
 * daemon-operator-client.ts, calling an operator method on the connected host.
 *
 * The route comes from the contract (operator-contract-routes.ts); this module
 * is the wire: the bearer token, the verb, the body-or-query split, and an
 * honest classification of what came back.
 *
 * Every failure is a VALUE, never a throw. The callers are stores that must
 * keep working when the daemon is not reachable, a laptop away from the LAN, a
 * daemon mid-restart, a token that has not been minted yet, and a store that
 * threw on an unreachable peer would take the whole feature down with it. The
 * four kinds are the same ones the read-route helper and the operator-action
 * poster already report, so a caller that can render one can render all of them.
 *
 * The `fetch` implementation is injectable so tests drive the adopted path and
 * the unreachable path without a network, a port, or a live daemon.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectedHostBaseUrl } from '../config/connected-host-dial.ts';
import {
  READ_ONLY_HTTP_METHODS,
  operatorRequestPath,
  prepareOperatorRequest,
  type JsonRecord,
} from './operator-contract-routes.ts';

export type DaemonInvokeFailureKind =
  | 'auth_required'
  | 'connected_host_unavailable'
  | 'connected_host_route_unavailable'
  | 'connected_host_error';

export interface DaemonInvokeSuccess {
  readonly ok: true;
  readonly methodId: string;
  /** "POST /api/channels/routing", what was actually called. */
  readonly route: string;
  readonly body: unknown;
}

export interface DaemonInvokeFailure {
  readonly ok: false;
  readonly methodId: string;
  readonly route: string;
  readonly kind: DaemonInvokeFailureKind;
  readonly error: string;
}

export type DaemonInvokeResult = DaemonInvokeSuccess | DaemonInvokeFailure;

export interface DaemonInvokeOptions {
  /**
   * Whether a person asked for this, right now.
   *
   * The daemon's confirmation gate wants two things: `confirm: true` in the
   * body, saying the CALL was reviewed, and this, saying a person asked. It
   * travels as the `x-goodvibes-explicit-user-request` header. Set it only
   * where that is true, a store syncing itself in the background is honestly
   * not a user request and should not claim to be one.
   */
  readonly explicitUserRequest?: boolean;
}

/** The one call shape every daemon-backed store in this product depends on. */
export type DaemonOperatorInvoke = (
  methodId: string,
  input?: JsonRecord,
  options?: DaemonInvokeOptions,
) => Promise<DaemonInvokeResult>;

/** The header the daemon reads the explicit-user-request claim from. */
export const EXPLICIT_USER_REQUEST_HEADER = 'x-goodvibes-explicit-user-request';

export interface DaemonOperatorConnection {
  readonly baseUrl: string;
  readonly token: string | null;
  readonly tokenPath?: string;
}

export interface DaemonOperatorConfigReader {
  get(key: string): unknown;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function summarize(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Where the daemon is and what proves this process may talk to it.
 *
 * Same host/port config keys and same token file the read-route helper and the
 * schedule promoter already read, one daemon, one address, one token.
 */
export function resolveDaemonOperatorConnection(
  configManager: DaemonOperatorConfigReader,
  homeDirectory: string,
): DaemonOperatorConnection {
  const baseUrl = connectedHostBaseUrl(
    configManager.get('controlPlane.host'),
    configManager.get('controlPlane.port'),
  );
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

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function classifyStatus(status: number): DaemonInvokeFailureKind {
  if (status === 401 || status === 403) return 'auth_required';
  if (status === 404) return 'connected_host_route_unavailable';
  return 'connected_host_error';
}

/**
 * Build the invoke function for a connection.
 *
 * `resolveConnection` is called per invoke rather than once: the token file can
 * appear after this process started (a daemon minted it), and a client that
 * cached "no token" at construction would stay locked out until restart.
 */
export function createDaemonOperatorInvoke(
  resolveConnection: () => DaemonOperatorConnection,
  fetchImpl: FetchLike = fetch,
): DaemonOperatorInvoke {
  return async (methodId, input = {}, options = {}) => {
    let request: ReturnType<typeof prepareOperatorRequest>;
    try {
      request = prepareOperatorRequest(methodId, input);
    } catch (error) {
      return {
        ok: false,
        methodId,
        route: methodId,
        kind: 'connected_host_route_unavailable',
        error: summarize(error),
      };
    }
    const requestPath = operatorRequestPath(request);
    const route = `${request.httpMethod} ${requestPath}`;
    const connection = resolveConnection();
    if (!connection.token) {
      return {
        ok: false,
        methodId,
        route,
        kind: 'auth_required',
        error: connection.tokenPath
          ? `no connected-host operator token found at ${connection.tokenPath}`
          : 'no connected-host operator token found',
      };
    }
    const isRead = READ_ONLY_HTTP_METHODS.has(request.httpMethod);
    try {
      const response = await fetchImpl(`${connection.baseUrl}${requestPath}`, {
        method: request.httpMethod,
        headers: {
          authorization: `Bearer ${connection.token}`,
          ...(isRead ? {} : { 'content-type': 'application/json' }),
          ...(options.explicitUserRequest === undefined
            ? {}
            : { [EXPLICIT_USER_REQUEST_HEADER]: String(options.explicitUserRequest) }),
        },
        ...(isRead ? {} : { body: JSON.stringify(request.payload) }),
      });
      const body = await readResponseBody(response);
      if (!response.ok) {
        const detail = isRecord(body) && typeof body.error === 'string' ? body.error : '';
        return {
          ok: false,
          methodId,
          route,
          kind: classifyStatus(response.status),
          error: `HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
        };
      }
      return { ok: true, methodId, route, body };
    } catch (error) {
      return {
        ok: false,
        methodId,
        route,
        kind: 'connected_host_unavailable',
        error: summarize(error),
      };
    }
  };
}
