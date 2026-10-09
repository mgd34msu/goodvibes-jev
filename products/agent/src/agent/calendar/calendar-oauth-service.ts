/**
 * calendar-oauth-service.ts, the agent's bridge to the SDK calendar OAuth connector.
 *
 * It wires the SDK CalendarConnector with the REAL runtime adapters the SDK module
 * deliberately leaves injected (so the SDK stays pure and testable): the runtime
 * fetch, and a loopback redirect listener built on the SDK's createOAuthLocalListener.
 * Tokens persist through the Agent secret manager. The OAuth app is the operator's
 * own, no client id ships with the product, so the client id is read from config
 * and the client secret from the secret store, under the keys the SDK profile names.
 * With none set, every connect returns an honest config-stage refusal naming the key.
 *
 * Every connect returns an honest STAGED result ({ ok, stage, error }), config,
 * authorize, or token, the same honesty shape the email connect wizard uses. The
 * connector is injectable so tests drive the whole flow against fakes with no real
 * network, port, or browser.
 */

import {
  CalendarConnector,
  fetchAdapter,
  providerProfile,
  resolveClientConfig,
  type CalendarProviderId,
  type CalendarRequestOptions,
  type ConnectedAccount,
  type ConnectionState,
  type DeviceCodeFlowStart,
  type EventWindow,
  type LoopbackListenerFactory,
  type MergedCalendarEvent,
  type OAuthClientOverrides,
  type ResolvedClientConfig,
} from '@goodvibes-jev/engine/sdk/platform/calendar';
import { createOAuthLocalListener } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ConfigKey } from '../../config/index.ts';
import type { SecretScope } from '../../config/secrets.ts';
import { resolveCredentialWriteScope } from '../../config/credential-scope.ts';

/** The config keys the connector reads. clientId is not a secret (RFC 8252); the
 *  secret ref is secret-backed and listed in SECRET_CONFIG_KEYS. */
export const CALENDAR_OAUTH_CLIENT_ID_KEYS: Record<CalendarProviderId, string> = {
  google: 'calendar.google.clientId',
  microsoft: 'calendar.microsoft.clientId',
};
export const CALENDAR_OAUTH_CLIENT_SECRET_KEYS: Record<CalendarProviderId, string> = {
  google: 'calendar.google.clientSecretRef',
  microsoft: 'calendar.microsoft.clientSecretRef',
};

/** The narrow config-manager slice this service reads. */
export interface CalendarConfigReader {
  get(key: string): unknown;
}

/**
 * The narrow secret slice used for token storage + reading a stored client secret.
 *
 * `set` takes the store's write options because the OAuth token set has to be
 * filed where the DAEMON can read it, see `daemonScopedSecrets` below. Tests
 * that pass a Map-backed fake can keep ignoring the second argument; the
 * parameter is optional so the fake's two-argument shape still satisfies this.
 */
export interface CalendarSecretSlice {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { readonly scope?: SecretScope }): Promise<void>;
  delete(key: string, options?: { readonly scope?: SecretScope }): Promise<void>;
}

/**
 * Wrap a secret slice so every WRITE it receives is filed at the tier the
 * credential's reader actually reads from.
 *
 * The SDK's `CalendarTokenStore` writes `GOODVIBES_CALENDAR_<PROVIDER>_TOKENS`,
 * `_ACCOUNT` and `_STATUS` through a two-argument `set(key, value)`, it has no
 * scope parameter to pass, and nothing in the chain from
 * `/calendar connect google` down to that call ever named one. The store's own
 * default for a name it does not recognize is the project tier, so an OAuth
 * REFRESH TOKEN for a calendar the daemon reads on a schedule ended up in a
 * silo the daemon never opens: the operator connects a calendar here, closes
 * the terminal, and the daemon reports no calendar account connected.
 *
 * Wrapping at this seam rather than changing the call is what makes it work
 * without an SDK change, the token store keeps its two-argument call and the
 * scope is decided by the name, one layer down, where the answer is known.
 * `resolveCredentialWriteScope` is what holds that answer, for these names and
 * for the SDK-derived ones alike.
 *
 * Reads and deletes pass straight through: `SecretsManager.get` already reads
 * across tiers, and a delete with no scope sweeps all of them, which is what a
 * disconnect wants when a token stored before this fix is still sitting in the
 * project tier.
 */
export function daemonScopedSecrets(secrets: CalendarSecretSlice): CalendarSecretSlice {
  return {
    get: (key) => secrets.get(key),
    set: (key, value, options) => secrets.set(key, value, {
      ...options,
      scope: resolveCredentialWriteScope(key, options?.scope),
    }),
    delete: (key, options) => secrets.delete(key, options),
  };
}

export type ConnectStage = 'config' | 'authorize' | 'token';

export interface ConnectResult {
  readonly ok: boolean;
  readonly stage?: ConnectStage;
  readonly error?: string;
  readonly account?: ConnectedAccount;
  readonly transport?: 'loopback' | 'device-code';
}

export interface AccountStatus {
  readonly account: ConnectedAccount;
  readonly state: ConnectionState;
}

/** The real loopback factory, binds 127.0.0.1 and waits for the browser callback. */
const realLoopbackFactory: LoopbackListenerFactory = async ({ expectedState, host, port, timeoutMs }) => {
  const listener = await createOAuthLocalListener({
    expectedState,
    ...(host ? { host } : {}),
    ...(typeof port === 'number' ? { port } : {}),
    ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
  });
  return {
    redirectUri: listener.redirectUri,
    async waitForCode() {
      const { code } = await listener.waitForCode();
      return { code, state: expectedState };
    },
    close() {
      listener.close();
    },
  };
};

export interface CalendarOAuthServiceOptions {
  readonly config: CalendarConfigReader;
  readonly secrets: CalendarSecretSlice;
  /** Injected for tests; production builds a real connector over runtime fetch + loopback. */
  readonly connector?: CalendarConnector;
  /** Injected fetch for tests; ignored when a connector is injected. */
  readonly fetchImpl?: Parameters<typeof fetchAdapter>[0];
  /** Injected loopback factory for tests; ignored when a connector is injected. */
  readonly listenerFactory?: LoopbackListenerFactory;
}

export class CalendarOAuthService {
  private readonly config: CalendarConfigReader;
  /**
   * The scope-pinned slice, and the exact object handed to the connector below.
   *
   * Readable so a test can write through the same object the SDK's token store
   * writes through and check where the value landed. That is the only way to
   * gate the wrapping from outside: the token store is built inside the
   * connector, and a service that stopped wrapping would keep every visible
   * behavior and quietly file the refresh token where the daemon cannot see it.
   */
  readonly secrets: CalendarSecretSlice;
  private readonly connector: CalendarConnector;

  constructor(options: CalendarOAuthServiceOptions) {
    this.config = options.config;
    // Every write this service makes, its own, and the token store's inside the
    // connector, goes through the scope-pinning wrapper, so the refresh token
    // lands where the daemon reads it. Wrapping here rather than at each call
    // means a future write added inside the SDK connector is covered too.
    this.secrets = daemonScopedSecrets(options.secrets);
    this.connector = options.connector ?? new CalendarConnector({
      secrets: this.secrets,
      fetchImpl: options.fetchImpl ? fetchAdapter(options.fetchImpl) : fetchAdapter(),
      listenerFactory: options.listenerFactory ?? realLoopbackFactory,
    });
  }

  /** Resolve the client config from the operator's configured OAuth app. */
  async resolveConfig(provider: CalendarProviderId): Promise<ResolvedClientConfig> {
    const overrides = await this.resolveOverrides(provider);
    return resolveClientConfig(providerProfile(provider), overrides);
  }

  /** Read the client id (config) and client secret (secret store), when set. */
  async resolveOverrides(provider: CalendarProviderId): Promise<OAuthClientOverrides> {
    const clientId = this.readString(CALENDAR_OAUTH_CLIENT_ID_KEYS[provider]);
    const clientSecret = await this.resolveSecretBacked(CALENDAR_OAUTH_CLIENT_SECRET_KEYS[provider]);
    const overrides: OAuthClientOverrides = {
      ...(clientId ? { clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
    };
    return overrides;
  }

  /** Connect via the loopback authorization-code flow. `openUrl` is best-effort. */
  async connectLoopback(
    provider: CalendarProviderId,
    hooks: { openUrl?: (url: string) => void } = {},
  ): Promise<ConnectResult> {
    const config = await this.resolveConfig(provider);
    const guard = this.guardConfigured(config);
    if (guard) return guard;
    let begun;
    try {
      begun = await this.connector.beginConnectAuthCode(config);
    } catch (error) {
      return { ok: false, stage: 'authorize', error: `Could not start the sign-in flow: ${describe(error)}` };
    }
    hooks.openUrl?.(begun.start.authorizationUrl);
    let code: string;
    try {
      code = (await begun.waiter.waitForCode()).code;
    } catch (error) {
      begun.waiter.close();
      return { ok: false, stage: 'authorize', error: `The browser sign-in did not complete: ${describe(error)}` };
    }
    try {
      const account = await this.connector.completeConnectAuthCode(config, {
        code,
        verifier: begun.start.verifier,
        redirectUri: begun.start.redirectUri,
      });
      return { ok: true, account, transport: 'loopback' };
    } catch (error) {
      return { ok: false, stage: 'token', error: `The provider rejected the sign-in: ${describe(error)}` };
    } finally {
      begun.waiter.close();
    }
  }

  /** Connect via the device-code flow (headless fallback). */
  async connectDeviceCode(
    provider: CalendarProviderId,
    hooks: { onDeviceCode?: (start: DeviceCodeFlowStart) => void } = {},
  ): Promise<ConnectResult> {
    const config = await this.resolveConfig(provider);
    const guard = this.guardConfigured(config);
    if (guard) return guard;
    let start: DeviceCodeFlowStart;
    try {
      start = await this.connector.beginConnectDeviceCode(config);
    } catch (error) {
      return { ok: false, stage: 'authorize', error: `Could not start device sign-in: ${describe(error)}` };
    }
    hooks.onDeviceCode?.(start);
    try {
      const account = await this.connector.completeConnectDeviceCode(config, start);
      return { ok: true, account, transport: 'device-code' };
    } catch (error) {
      return { ok: false, stage: 'token', error: `Device sign-in was not approved: ${describe(error)}` };
    }
  }

  /**
   * Auto-select: try the loopback flow; if the listener cannot bind (headless), fall
   * back to device-code. `--device` callers use connectDeviceCode directly.
   */
  async connectAuto(
    provider: CalendarProviderId,
    hooks: { openUrl?: (url: string) => void; onDeviceCode?: (start: DeviceCodeFlowStart) => void } = {},
  ): Promise<ConnectResult> {
    const config = await this.resolveConfig(provider);
    const guard = this.guardConfigured(config);
    if (guard) return guard;
    try {
      // Probe: beginning the loopback flow binds the port; a bind failure throws here.
      const begun = await this.connector.beginConnectAuthCode(config);
      hooks.openUrl?.(begun.start.authorizationUrl);
      let code: string;
      try {
        code = (await begun.waiter.waitForCode()).code;
      } catch (error) {
        begun.waiter.close();
        return { ok: false, stage: 'authorize', error: `The browser sign-in did not complete: ${describe(error)}` };
      }
      try {
        const account = await this.connector.completeConnectAuthCode(config, {
          code,
          verifier: begun.start.verifier,
          redirectUri: begun.start.redirectUri,
        });
        return { ok: true, account, transport: 'loopback' };
      } finally {
        begun.waiter.close();
      }
    } catch {
      // No loopback available, fall back to the headless device-code flow.
      return this.connectDeviceCode(provider, hooks);
    }
  }

  /** Disconnect a provider: revoke where possible + clear stored tokens. */
  async disconnect(provider: CalendarProviderId): Promise<{ readonly revokedRemotely: boolean }> {
    const overrides = await this.resolveOverrides(provider);
    return this.connector.disconnect(provider, overrides);
  }

  /** List connected accounts with their honest connection state. */
  async listAccounts(): Promise<AccountStatus[]> {
    const accounts = await this.connector.listAccounts();
    const out: AccountStatus[] = [];
    for (const account of accounts) {
      out.push({ account, state: await this.connector.connectionState(account.provider) });
    }
    return out;
  }

  /** Events for one already-resolved provider config over a window (source-labeled). */
  async listEventsForProvider(config: ResolvedClientConfig, window: EventWindow, options: CalendarRequestOptions = {}): Promise<MergedCalendarEvent[]> {
    return this.connector.listEvents(config, window, options);
  }

  /** Merged, source-labeled events across every connected provider in a window. */
  async listEvents(window: EventWindow, options: CalendarRequestOptions = {}): Promise<MergedCalendarEvent[]> {
    const accounts = await this.connector.listAccounts();
    const out: MergedCalendarEvent[] = [];
    for (const account of accounts) {
      const config = await this.resolveConfig(account.provider);
      const events = await this.connector.listEvents(config, window, options);
      out.push(...events);
    }
    return out;
  }

  // --- internals ------------------------------------------------------------

  private guardConfigured(config: ResolvedClientConfig): ConnectResult | null {
    if (config.isConfigured) return null;
    const label = config.provider === 'google' ? 'Google Calendar' : 'Microsoft Outlook';
    const cardLabel = config.provider === 'google' ? 'Connect Google Calendar' : 'Connect Microsoft Outlook';
    return {
      ok: false,
      stage: 'config',
      error:
        `No ${label} client id is configured. GoodVibes ships none of its own: register your own OAuth app ` +
        `with the provider and set ${config.clientIdConfigKey} to its client id. ` +
        `Run /calendar connect for the provider-console steps, or open "${cardLabel}" under /agent personal-ops and paste your client id in.`,
    };
  }

  private readString(key: string): string | undefined {
    // get() throws when the config section does not exist yet (nothing has seeded
    // 'calendar'). Treat that as "unset", an environment where nobody has registered
    // an OAuth app yet is a normal state that reads as not-configured, not a schema
    // error surfaced to the operator.
    let value: unknown;
    try {
      value = this.config.get(key);
    } catch {
      return undefined;
    }
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  }

  /** Read a secret-backed config value: resolve a goodvibes:// ref to its secret. */
  private async resolveSecretBacked(configKey: string): Promise<string | undefined> {
    const ref = this.readString(configKey);
    if (!ref) return undefined;
    const prefix = 'goodvibes://secrets/goodvibes/';
    if (!ref.startsWith(prefix)) return ref; // a literal value (unusual, but honored)
    const secretKey = decodeURIComponent(ref.slice(prefix.length));
    const value = await this.secrets.get(secretKey);
    return value ?? undefined;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
