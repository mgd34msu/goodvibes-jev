/**
 * session-spine-rest-transport.ts
 *
 * The REST transport, probe, and receipt consumer live in the SDK itself
 * (`@goodvibes-jev/engine/sdk/platform/runtime/session-spine`,
 * `rest-transport.ts`, adopted from this agent's own implementation
 * verbatim, per that module's "Hoist provenance" doc comment). Callers import
 * `createSessionSpineRestTransport` / `createSessionSpineRestProbe` /
 * `createSessionSpineReceiptConsumer` / `extractSessionSpineReceipts`
 * directly from there now.
 *
 * What stays here, per the SDK module's own explicit carve-out ("Kept out of
 * this hoist: the agent's `createSpineConnectionResolver`... a consumer
 * trust-boundary concern the SDK core deliberately never reaches into"):
 * building the daemon base URL from ConfigManager and reading the
 * connected-host operator token off THIS home directory's
 * operator-tokens.json. That is agent-local trust-boundary wiring, not
 * transport logic, and it is exactly what every SDK rest-transport factory's
 * `resolveConnection` option expects a consumer to supply.
 */

import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { readConnectedHostOperatorToken } from './connected-host-auth.ts';
import { connectedHostBaseUrl } from '../config/connected-host-dial.ts';

export interface SessionRegistrationConnection {
  readonly baseUrl: string;
  readonly token: string | null;
  readonly tokenPath?: string;
}

/**
 * Builds a per-op connection resolver from the config manager (host/port,
 * default 127.0.0.1:3421) and the connected-host operator token (env
 * overrides + the canonical operator-tokens.json). Re-read every op so a
 * token that appears after boot is picked up.
 */
export function createSpineConnectionResolver(
  configManager: Pick<ConfigManager, 'get'>,
  homeDirectory: string,
): () => SessionRegistrationConnection {
  return () => {
    const baseUrl = connectedHostBaseUrl(
      configManager.get('controlPlane.host'),
      configManager.get('controlPlane.port'),
    );
    const token = readConnectedHostOperatorToken(homeDirectory);
    return { baseUrl, token: token.token, tokenPath: token.path };
  };
}
