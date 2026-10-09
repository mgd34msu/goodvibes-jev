/**
 * platform-calendar-oauth.test.ts
 *
 * Authenticated calendar provider connectivity (Google
 * Calendar API v3 + Microsoft Graph over OAuth 2.0). The ENTIRE flow is proven
 * against in-memory fake servers behind the connector's injected HttpFetch, there
 * is NO real network, no real port, and no real keychain anywhere in this file.
 *
 * Covered:
 *  - authorization-code + PKCE: the fake token endpoint verifies the code_verifier
 *    hashes (S256) to the challenge that beginAuthCodeFlow put in the authorize URL;
 *    a wrong verifier is rejected.
 *  - device-code (RFC 8628): authorization_pending -> slow_down -> success, with a
 *    fake clock + fake sleep; expiry is honest.
 *  - bundled-default vs user-override client resolution; placeholder -> a flow
 *    refuses with client-not-configured (never a fake success).
 *  - token refresh on expiry; a refresh FAILURE flips the durable state to
 *    reconnect-needed and refuses to hand back a stale token.
 *  - revoke/disconnect: Google revocation endpoint hit + keys cleared; Microsoft
 *    (no revocation endpoint) clears keys locally and reports revokedRemotely:false.
 *  - Google + Graph list-calendars, paginated list-events, and create-event, all
 *    normalized + source-labeled into the merged model.
 *  - honest degraded states: 403 names the missing scope; 429 carries Retry-After;
 *    401 -> reconnect-needed.
 *  - tokens live only in the secret store, never echoed into account/state.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { createSystemOnePort, PINNED_MODEL, type EntryType, type Question, type JudgmentConfig } from '@goodvibes-jev/judgment';
import { missingPermission } from '../sdk/src/platform/calendar/batteries/missing-permission.ts';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { createSha256Hash } from '../sdk/src/platform/runtime/auth/crypto-adapter.ts';
import {
  CalendarApiError,
  errorFromResponse,
  CalendarConnector,
  CalendarTokenStore,
  OAuthFlowError,
  TokenRefreshError,
  parseTokenResponse,
  providerProfile,
  resolveClientConfig,
  type CalendarProviderId,
  type HttpFetch,
  type HttpRequest,
  type HttpResponse,
  type LoopbackListenerFactory,
  type ResolvedClientConfig,
  type SecretStoreSlice,
} from '../sdk/src/platform/calendar/index.ts';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeSecrets(): SecretStoreSlice & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    async get(key) {
      return map.get(key) ?? null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    status,
    ok: status >= 200 && status < 300,
    header: (name) => lower[name.toLowerCase()] ?? null,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

interface ServerState {
  /** code -> the PKCE challenge captured from the authorize URL. */
  readonly pkceByCode: Map<string, string>;
  /** valid refresh tokens; refreshing an absent one 400s. */
  readonly refreshTokens: Set<string>;
  /** device_code -> polls remaining before it flips to approved. */
  readonly devicePollsLeft: Map<string, number>;
  readonly revoked: Set<string>;
  nextAccess: number;
  /** toggles for degraded-state tests. */
  eventsErrorBody?: unknown;
  eventsStatus: number; // 200 normal, 401/403/429 to force a degraded state
  /** account email surfaced by the primary calendar. */
  googleEmail: string;
}

function freshState(): ServerState {
  return {
    pkceByCode: new Map(),
    refreshTokens: new Set(),
    devicePollsLeft: new Map(),
    revoked: new Set(),
    nextAccess: 1,
    eventsStatus: 200,
    googleEmail: 'user@gmail.com',
  };
}

function form(body: string | undefined): URLSearchParams {
  return new URLSearchParams(body ?? '');
}

/**
 * One fake fetch that stands in for Google's OAuth + Calendar API and Microsoft's
 * OAuth + Graph API, routing by the real provider URLs the connector calls.
 */
function makeFakeFetch(state: ServerState): HttpFetch {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const url = new URL(req.url);
    const path = url.pathname;

    // --- OAuth token endpoints (Google + Microsoft) ---
    if (path === '/token' || path === '/common/oauth2/v2.0/token' || path.endsWith('/oauth2/v2.0/token')) {
      const body = form(req.body);
      const grant = body.get('grant_type');
      if (grant === 'authorization_code') {
        const code = body.get('code') ?? '';
        const verifier = body.get('code_verifier') ?? '';
        const expected = state.pkceByCode.get(code);
        if (!expected) return jsonResponse(400, { error: 'invalid_grant' });
        const actual = await createSha256Hash(verifier);
        if (actual !== expected) return jsonResponse(400, { error: 'invalid_grant', error_description: 'PKCE mismatch' });
        const refresh = `refresh-${state.nextAccess}`;
        state.refreshTokens.add(refresh);
        return jsonResponse(200, {
          access_token: `access-${state.nextAccess++}`,
          refresh_token: refresh,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: body.get('scope') ?? 'calendar',
        });
      }
      if (grant === 'refresh_token') {
        const rt = body.get('refresh_token') ?? '';
        if (!state.refreshTokens.has(rt)) return jsonResponse(400, { error: 'invalid_grant' });
        return jsonResponse(200, { access_token: `access-${state.nextAccess++}`, token_type: 'Bearer', expires_in: 3600 });
      }
      if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
        const dc = body.get('device_code') ?? '';
        const left = state.devicePollsLeft.get(dc) ?? 0;
        if (left > 1) {
          state.devicePollsLeft.set(dc, left - 1);
          return jsonResponse(400, { error: 'authorization_pending' });
        }
        if (left === 1) {
          state.devicePollsLeft.set(dc, 0);
          return jsonResponse(400, { error: 'slow_down' });
        }
        const refresh = `refresh-${state.nextAccess}`;
        state.refreshTokens.add(refresh);
        return jsonResponse(200, {
          access_token: `access-${state.nextAccess++}`,
          refresh_token: refresh,
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }
      return jsonResponse(400, { error: 'unsupported_grant_type' });
    }

    // --- Device authorization endpoints ---
    if (path.endsWith('/device/code') || path.endsWith('/devicecode')) {
      const dc = `device-${state.nextAccess}`;
      state.devicePollsLeft.set(dc, 2); // pending, then slow_down, then success
      return jsonResponse(200, {
        device_code: dc,
        user_code: 'WXYZ-1234',
        verification_uri: 'https://example.test/device',
        verification_uri_complete: 'https://example.test/device?code=WXYZ-1234',
        expires_in: 900,
        interval: 5,
      });
    }

    // --- Revocation (Google only) ---
    if (path === '/revoke') {
      const token = form(req.body).get('token') ?? '';
      state.revoked.add(token);
      return jsonResponse(200, {});
    }

    // --- Google Calendar API v3 ---
    if (url.host === 'www.googleapis.com') {
      if (path === '/calendar/v3/users/me/calendarList') {
        return jsonResponse(200, {
          items: [
            { id: state.googleEmail, summary: 'Primary', primary: true, accessRole: 'owner' },
            { id: 'team@group.calendar.google.com', summary: 'Team', accessRole: 'reader' },
          ],
        });
      }
      if (path.startsWith('/calendar/v3/calendars/') && path.endsWith('/events') && req.method === 'GET') {
        if (state.eventsStatus === 403) {
          return jsonResponse(403, state.eventsErrorBody ?? { error: { message: 'insufficient scope: calendar.readonly' } });
        }
        if (state.eventsStatus === 429) {
          return jsonResponse(429, { error: { message: 'rate limit' } }, { 'Retry-After': '30' });
        }
        if (state.eventsStatus === 401) return jsonResponse(401, { error: { message: 'invalid credentials' } });
        const pageToken = url.searchParams.get('pageToken');
        if (!pageToken) {
          return jsonResponse(200, {
            nextPageToken: 'page2',
            items: [
              { id: 'g1', iCalUID: 'g1@google', summary: 'Timed', start: { dateTime: '2026-07-06T09:00:00-07:00' }, end: { dateTime: '2026-07-06T10:00:00-07:00' } },
            ],
          });
        }
        return jsonResponse(200, {
          items: [
            { id: 'g2', summary: 'All day', start: { date: '2026-07-07' }, end: { date: '2026-07-08' } },
            { id: 'g3', status: 'cancelled', start: { date: '2026-07-09' } },
          ],
        });
      }
      if (path.startsWith('/calendar/v3/calendars/') && path.endsWith('/events') && req.method === 'POST') {
        const created = JSON.parse(req.body ?? '{}') as Record<string, unknown>;
        return jsonResponse(200, { id: 'g-created', iCalUID: 'g-created@google', ...created });
      }
    }

    // --- Microsoft Graph ---
    if (url.host === 'graph.microsoft.com') {
      if (path === '/v1.0/me/calendars') {
        return jsonResponse(200, {
          value: [
            { id: 'cal-primary', name: 'Calendar', canEdit: true, isDefaultCalendar: true },
            { id: 'cal-2', name: 'Work', canEdit: false },
          ],
        });
      }
      if (path.includes('/calendarView')) {
        if (state.eventsStatus === 403) return jsonResponse(403, state.eventsErrorBody ?? { error: { message: 'Access denied: Calendars.Read' } });
        const skip = url.searchParams.get('$skiptoken');
        if (!skip) {
          return jsonResponse(200, {
            '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendars/cal-primary/calendarView?$skiptoken=p2',
            value: [
              { id: 'm1', iCalUId: 'm1@ms', subject: 'Sync', start: { dateTime: '2026-07-06T15:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-07-06T15:30:00.0000000', timeZone: 'UTC' }, isAllDay: false },
            ],
          });
        }
        return jsonResponse(200, {
          value: [
            { id: 'm2', subject: 'Holiday', start: { dateTime: '2026-07-07T00:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-07-08T00:00:00.0000000', timeZone: 'UTC' }, isAllDay: true },
          ],
        });
      }
      if (path.endsWith('/events') && req.method === 'POST') {
        const created = JSON.parse(req.body ?? '{}') as Record<string, unknown>;
        return jsonResponse(201, { id: 'm-created', iCalUId: 'm-created@ms', ...created });
      }
    }

    return jsonResponse(404, { error: `unhandled ${req.method} ${req.url}` });
  };
}

/** A fake loopback that captures the authorize URL's challenge/state and hands back
 *  a canned code, wiring PKCE end-to-end without a port. */
function makeLoopback(state: ServerState, code = 'auth-code-1'): {
  readonly factory: LoopbackListenerFactory;
  arm(authorizationUrl: string): void;
} {
  let pending: { code: string; state: string } | null = null;
  const factory: LoopbackListenerFactory = async ({ expectedState }) => ({
    redirectUri: 'http://127.0.0.1:52111/callback',
    async waitForCode() {
      if (!pending) throw new Error('loopback not armed');
      return pending;
    },
    close() {},
  });
  return {
    factory,
    arm(authorizationUrl: string) {
      const u = new URL(authorizationUrl);
      const challenge = u.searchParams.get('code_challenge')!;
      const st = u.searchParams.get('state')!;
      state.pkceByCode.set(code, challenge);
      pending = { code, state: st };
    },
  };
}

/** A resolved config for a provider whose operator registered a real OAuth app. */
function realConfig(provider: 'google' | 'microsoft'): ResolvedClientConfig {
  return resolveClientConfig(providerProfile(provider), { clientId: `real-${provider}-client-id` });
}

const noSleep = async () => {};

// ---------------------------------------------------------------------------
// Client-config resolution
// ---------------------------------------------------------------------------

describe('client-config resolution', () => {
  // Bring your own OAuth app: nothing ships with the product, so an environment
  // where nobody has registered one resolves to "not configured" and every flow
  // refuses before touching the network.
  test('no configured client id resolves isConfigured:false and refuses a flow', async () => {
    const config = resolveClientConfig(providerProfile('google'));
    expect(config.isConfigured).toBe(false);
    expect(config.clientId).toBe('');

    const connector = new CalendarConnector({ secrets: makeSecrets(), fetchImpl: makeFakeFetch(freshState()), listenerFactory: makeLoopback(freshState()).factory });
    await expect(connector.beginConnectAuthCode(config)).rejects.toMatchObject({ reason: 'client-not-configured' });
  });

  test('the refusal names the exact config keys to set', async () => {
    const connector = new CalendarConnector({ secrets: makeSecrets(), fetchImpl: makeFakeFetch(freshState()), listenerFactory: makeLoopback(freshState()).factory });

    for (const provider of ['google', 'microsoft'] as const) {
      const config = resolveClientConfig(providerProfile(provider));
      // Both connect entry points refuse, not just the loopback one.
      const failures = [
        await connector.beginConnectAuthCode(config).then(() => null, (err: Error) => err),
        await connector.beginConnectDeviceCode(config).then(() => null, (err: Error) => err),
      ];
      for (const failure of failures) {
        expect(failure).toBeInstanceOf(Error);
        expect(failure!.message).toContain(`calendar.${provider}.clientId`);
        expect(failure!.message).toContain(`calendar.${provider}.clientSecretRef`);
        // Honest about whose app it is, never "this build ships no default yet".
        expect(failure!.message).toContain('register your own OAuth app');
      }
    }
  });

  test('no provider profile carries a client id of its own', () => {
    for (const provider of ['google', 'microsoft'] as const) {
      const profile = providerProfile(provider);
      expect(profile.clientIdConfigKey).toBe(`calendar.${provider}.clientId`);
      expect(profile.clientSecretRefConfigKey).toBe(`calendar.${provider}.clientSecretRef`);
      // The whole profile, serialized, must not contain anything shaped like a
      // baked credential, this is what stops one being reintroduced quietly.
      expect(JSON.stringify(profile)).not.toContain('apps.googleusercontent.com');
      expect(JSON.stringify(profile)).not.toContain('REPLACE_WITH');
    }
  });

  test("the operator's own client id and secret resolve into the flow config", () => {
    const config = resolveClientConfig(providerProfile('google'), { clientId: 'my-own-id', clientSecret: 's3cret' });
    expect(config.isConfigured).toBe(true);
    expect(config.clientId).toBe('my-own-id');
    expect(config.clientSecret).toBe('s3cret');
  });

  test('a blank or whitespace-only client id counts as unconfigured', () => {
    for (const clientId of ['', '   ']) {
      const config = resolveClientConfig(providerProfile('microsoft'), { clientId });
      expect(config.isConfigured).toBe(false);
      expect(config.clientId).toBe('');
    }
  });

  test('a configured client id is trimmed: a pasted id with stray whitespace still works', () => {
    const config = resolveClientConfig(providerProfile('microsoft'), { clientId: '  pasted-id\n' });
    expect(config.isConfigured).toBe(true);
    expect(config.clientId).toBe('pasted-id');
  });
});

// ---------------------------------------------------------------------------
// Reading the operator's registered app out of config
// ---------------------------------------------------------------------------

describe('client credentials from settings', () => {
  function connector(): CalendarConnector {
    return new CalendarConnector({ secrets: makeSecrets(), fetchImpl: makeFakeFetch(freshState()), listenerFactory: makeLoopback(freshState()).factory });
  }

  test('a configured client id makes the flow proceed with the operator id', async () => {
    const values: Record<string, unknown> = { 'calendar.google.clientId': 'operator-registered-id' };
    const resolved = await connector().resolveConfigFromSettings('google', {
      config: { get: (key) => values[key] },
    });
    expect(resolved.isConfigured).toBe(true);
    expect(resolved.clientId).toBe('operator-registered-id');

    // And it actually reaches the provider request rather than just resolving.
    const state = freshState();
    const loopback = makeLoopback(state);
    const live = new CalendarConnector({ secrets: makeSecrets(), fetchImpl: makeFakeFetch(state), listenerFactory: loopback.factory });
    const { start, waiter } = await live.beginConnectAuthCode(resolved);
    expect(start.authorizationUrl).toContain('client_id=operator-registered-id');
    waiter.close();
  });

  test('an empty settings store leaves it unconfigured and the flow refuses by name', async () => {
    const resolved = await connector().resolveConfigFromSettings('google', { config: { get: () => undefined } });
    expect(resolved.isConfigured).toBe(false);
    await expect(connector().beginConnectAuthCode(resolved)).rejects.toMatchObject({ reason: 'client-not-configured' });
  });

  test('a config section that does not exist reads as unset rather than throwing', async () => {
    // `calendar.*` is app-layer, and ConfigManager throws `Invalid config path`
    // for a section absent from the live config object. On a machine where
    // nobody ran setup that is the normal state, not a broken status read.
    const resolved = await connector().resolveConfigFromSettings('microsoft', {
      config: { get: () => { throw new Error("Invalid config path: section 'calendar' does not exist"); } },
    });
    expect(resolved.isConfigured).toBe(false);
  });

  test('the client secret comes from the secret store under the derived name, never from config', async () => {
    const values: Record<string, unknown> = {
      'calendar.google.clientId': 'operator-registered-id',
      'calendar.google.clientSecretRef': 'goodvibes://secrets/goodvibes/GOODVIBES_CALENDAR_GOOGLE_CLIENT_SECRET_REF',
    };
    const asked: string[] = [];
    const resolved = await connector().resolveConfigFromSettings('google', {
      config: { get: (key) => values[key] },
      secretGet: async (key) => { asked.push(key); return 'stored-secret'; },
    });
    expect(asked).toEqual(['GOODVIBES_CALENDAR_GOOGLE_CLIENT_SECRET_REF']);
    expect(resolved.clientSecret).toBe('stored-secret');
  });

  test('a public-client registration with no secret reference reads no secret at all', async () => {
    const values: Record<string, unknown> = { 'calendar.microsoft.clientId': 'public-client-id' };
    let secretReads = 0;
    const resolved = await connector().resolveConfigFromSettings('microsoft', {
      config: { get: (key) => values[key] },
      secretGet: async () => { secretReads += 1; return 'unused'; },
    });
    expect(secretReads).toBe(0);
    expect(resolved.clientSecret).toBeUndefined();
    expect(resolved.isConfigured).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Authorization-code + PKCE
// ---------------------------------------------------------------------------

describe('authorization-code flow with PKCE', () => {
  test('connects Google end to end; tokens land only in the secret store', async () => {
    const state = freshState();
    const secrets = makeSecrets();
    const loopback = makeLoopback(state);
    const connector = new CalendarConnector({ secrets, fetchImpl: makeFakeFetch(state), listenerFactory: loopback.factory });
    const config = realConfig('google');

    const { start, waiter } = await connector.beginConnectAuthCode(config);
    expect(start.authorizationUrl).toContain('code_challenge=');
    expect(start.authorizationUrl).toContain('code_challenge_method=S256');
    expect(start.authorizationUrl).toContain('access_type=offline');
    loopback.arm(start.authorizationUrl);

    const { code } = await waiter.waitForCode();
    const account = await connector.completeConnectAuthCode(config, { code, verifier: start.verifier, redirectUri: start.redirectUri });

    expect(account.provider).toBe('google');
    expect(account.label).toBe('user@gmail.com'); // derived from the primary calendar id
    // the access/refresh tokens live in the secret store, never on the account object
    const stored = JSON.parse(secrets.map.get('GOODVIBES_CALENDAR_GOOGLE_TOKENS')!) as { accessToken: string; refreshToken: string };
    expect(stored.accessToken).toMatch(/^access-/);
    expect(stored.refreshToken).toMatch(/^refresh-/);
    expect(JSON.stringify(account)).not.toContain(stored.accessToken);
    expect(JSON.stringify(account)).not.toContain(stored.refreshToken);
    expect(await connector.connectionState('google')).toBe('connected');
  });

  test('a wrong PKCE verifier is rejected by the token endpoint', async () => {
    const state = freshState();
    const loopback = makeLoopback(state);
    const connector = new CalendarConnector({ secrets: makeSecrets(), fetchImpl: makeFakeFetch(state), listenerFactory: loopback.factory });
    const config = realConfig('google');
    const { start } = await connector.beginConnectAuthCode(config);
    loopback.arm(start.authorizationUrl);
    await expect(
      connector.completeConnectAuthCode(config, { code: 'auth-code-1', verifier: 'not-the-verifier', redirectUri: start.redirectUri }),
    ).rejects.toMatchObject({ reason: 'token-request-rejected' });
  });
});

// ---------------------------------------------------------------------------
// Device-code flow
// ---------------------------------------------------------------------------

describe('device-code flow', () => {
  test('shows a user code, tolerates authorization_pending + slow_down, then connects', async () => {
    const state = freshState();
    const secrets = makeSecrets();
    const connector = new CalendarConnector({ secrets, fetchImpl: makeFakeFetch(state), sleep: noSleep, clock: () => 1_000 });
    const config = realConfig('microsoft');

    const start = await connector.beginConnectDeviceCode(config);
    expect(start.userCode).toBe('WXYZ-1234');
    expect(start.verificationUri).toBe('https://example.test/device');

    const account = await connector.completeConnectDeviceCode(config, start);
    expect(account.provider).toBe('microsoft');
    expect(secrets.map.has('GOODVIBES_CALENDAR_MICROSOFT_TOKENS')).toBe(true);
  });

  test('an expired device code fails honestly', async () => {
    const state = freshState();
    let now = 1_000;
    const connector = new CalendarConnector({ secrets: makeSecrets(), fetchImpl: makeFakeFetch(state), sleep: async () => { now += 10_000_000; }, clock: () => now });
    const config = realConfig('microsoft');
    const start = await connector.beginConnectDeviceCode(config);
    await expect(connector.completeConnectDeviceCode(config, start)).rejects.toMatchObject({ reason: 'device-code-expired' });
  });
});

// ---------------------------------------------------------------------------
// F3: expires_in coercion, never silently "never expires"
// ---------------------------------------------------------------------------

describe('parseTokenResponse: expires_in coercion', () => {
  test('a numeric expires_in sets expiresAt normally', () => {
    const tokens = parseTokenResponse({ access_token: 'a', expires_in: 3600 }, 1_000_000);
    expect(tokens.expiresAt).toBe(1_000_000 + 3_600_000);
  });

  test('a numeric-STRING expires_in ("3600") is coerced, not ignored', () => {
    const tokens = parseTokenResponse({ access_token: 'a', expires_in: '3600' }, 1_000_000);
    expect(tokens.expiresAt).toBe(1_000_000 + 3_600_000);
  });

  test('an absent expires_in gets the conservative default, never "no expiry"', () => {
    const tokens = parseTokenResponse({ access_token: 'a' }, 1_000_000);
    expect(tokens.expiresAt).toBe(1_000_000 + 3_600_000);
  });

  test('a non-numeric expires_in ("soon") gets the conservative default', () => {
    const tokens = parseTokenResponse({ access_token: 'a', expires_in: 'soon' }, 1_000_000);
    expect(tokens.expiresAt).toBe(1_000_000 + 3_600_000);
  });

  test('a zero/negative expires_in gets the conservative default rather than an already-expired or nonsensical token', () => {
    expect(parseTokenResponse({ access_token: 'a', expires_in: 0 }, 1_000_000).expiresAt).toBe(1_000_000 + 3_600_000);
    expect(parseTokenResponse({ access_token: 'a', expires_in: -5 }, 1_000_000).expiresAt).toBe(1_000_000 + 3_600_000);
  });
});

// ---------------------------------------------------------------------------
// Token refresh + honest reconnect-needed
// ---------------------------------------------------------------------------

describe('token refresh lifecycle', () => {
  test('refreshes a due token and keeps serving', async () => {
    const state = freshState();
    const secrets = makeSecrets();
    let now = 10_000;
    const store = new CalendarTokenStore({ secrets, clock: () => now });
    state.refreshTokens.add('rt-1');
    await store.save('google', { accessToken: 'old', refreshToken: 'rt-1', tokenType: 'Bearer', expiresAt: 100_000, obtainedAt: 10_000 }, {
      provider: 'google', accountId: 'google', label: 'user@gmail.com', scopes: [], connectedAt: 10_000,
    });
    expect(await store.connectionState('google')).toBe('connected');
    now = 200_000; // past expiry (beyond the 60s refresh leeway)
    expect(await store.connectionState('google')).toBe('refresh-due');
    const token = await store.getFreshAccessToken('google', realConfig('google'), makeFakeFetch(state));
    expect(token).toMatch(/^access-/);
    expect(await store.connectionState('google')).toBe('connected');
  });

  test('a failed refresh flips to reconnect-needed and refuses a stale token', async () => {
    const state = freshState();
    const secrets = makeSecrets();
    let now = 10_000;
    const store = new CalendarTokenStore({ secrets, clock: () => now });
    // rt-missing is NOT registered on the server, so refresh 400s
    await store.save('google', { accessToken: 'old', refreshToken: 'rt-missing', tokenType: 'Bearer', expiresAt: 20_000, obtainedAt: 10_000 }, {
      provider: 'google', accountId: 'google', label: 'user@gmail.com', scopes: [], connectedAt: 10_000,
    });
    now = 25_000;
    await expect(store.getFreshAccessToken('google', realConfig('google'), makeFakeFetch(state))).rejects.toBeInstanceOf(TokenRefreshError);
    expect(await store.connectionState('google')).toBe('reconnect-needed');
  });

  // F2: Microsoft rotates refresh tokens on every use, so two concurrent
  // getFreshAccessToken calls sharing one stored (soon-to-be-invalidated) refresh
  // token must not both hit the provider, the loser would get invalid_grant on an
  // otherwise perfectly working account.
  test('two concurrent getFreshAccessToken calls single-flight to exactly one refresh request', async () => {
    const state = freshState();
    const secrets = makeSecrets();
    let now = 10_000;
    const store = new CalendarTokenStore({ secrets, clock: () => now });
    state.refreshTokens.add('rt-1');
    await store.save('google', { accessToken: 'old', refreshToken: 'rt-1', tokenType: 'Bearer', expiresAt: 100_000, obtainedAt: 10_000 }, {
      provider: 'google', accountId: 'google', label: 'user@gmail.com', scopes: [], connectedAt: 10_000,
    });
    now = 200_000; // past expiry (beyond the 60s refresh leeway)

    let refreshRequests = 0;
    const base = makeFakeFetch(state);
    const countingFetch: HttpFetch = async (req) => {
      const url = new URL(req.url);
      if (url.pathname === '/token' && form(req.body).get('grant_type') === 'refresh_token') refreshRequests++;
      return base(req);
    };

    const [a, b] = await Promise.all([
      store.getFreshAccessToken('google', realConfig('google'), countingFetch),
      store.getFreshAccessToken('google', realConfig('google'), countingFetch),
    ]);
    expect(refreshRequests).toBe(1);
    expect(a).toBe(b);
    expect(a).toMatch(/^access-/);
    expect(await store.connectionState('google')).toBe('connected');
  });

  // F2: a genuinely-dead refresh token (not merely lost a single-flight race) must
  // still produce an honest reconnect-needed, the fix to (b) below must not make
  // real failures silently invisible.
  test('a genuinely-dead refresh token still produces reconnect-needed', async () => {
    const state = freshState();
    const secrets = makeSecrets();
    let now = 10_000;
    const store = new CalendarTokenStore({ secrets, clock: () => now });
    await store.save('google', { accessToken: 'old', refreshToken: 'rt-dead', tokenType: 'Bearer', expiresAt: 20_000, obtainedAt: 10_000 }, {
      provider: 'google', accountId: 'google', label: 'user@gmail.com', scopes: [], connectedAt: 10_000,
    });
    now = 25_000; // rt-dead was never registered on the server -> refresh 400s
    await expect(store.getFreshAccessToken('google', realConfig('google'), makeFakeFetch(state))).rejects.toBeInstanceOf(TokenRefreshError);
    expect(await store.connectionState('google')).toBe('reconnect-needed');
  });

  // F2(b): markReconnectNeeded must re-read state before writing the marker. If a
  // concurrent process/instance already stored a fresh, valid token set for the
  // same provider (sharing the same secret store) between this refresh's failure
  // and the marker write, the marker must NOT stamp over that working account.
  test('a refresh failure does not stamp reconnect-needed over a token another process already refreshed', async () => {
    const state = freshState();
    const secrets = makeSecrets();
    let now = 10_000;
    const store = new CalendarTokenStore({ secrets, clock: () => now });
    state.refreshTokens.add('rt-1');
    await store.save('google', { accessToken: 'old', refreshToken: 'rt-1', tokenType: 'Bearer', expiresAt: 100_000, obtainedAt: 10_000 }, {
      provider: 'google', accountId: 'google', label: 'user@gmail.com', scopes: [], connectedAt: 10_000,
    });
    now = 200_000;
    const racyFetch: HttpFetch = async () => {
      // Simulate another process/instance winning the race: it refreshes and saves
      // a fresh, valid token set into the SAME shared secret store before this
      // call's own (losing) refresh attempt is handled as a failure.
      await secrets.set('GOODVIBES_CALENDAR_GOOGLE_TOKENS', JSON.stringify({
        accessToken: 'access-from-other-process',
        refreshToken: 'rt-2',
        tokenType: 'Bearer',
        expiresAt: now + 3_600_000,
        obtainedAt: now,
      }));
      return jsonResponse(400, { error: 'invalid_grant' });
    };
    await expect(store.getFreshAccessToken('google', realConfig('google'), racyFetch)).rejects.toBeInstanceOf(TokenRefreshError);
    // The marker must NOT have been stamped over the now-valid token.
    expect(await store.connectionState('google')).toBe('connected');
  });
});

// ---------------------------------------------------------------------------
// Disconnect / revoke
// ---------------------------------------------------------------------------

describe('disconnect', () => {
  test('Google disconnect revokes remotely and clears keys', async () => {
    const state = freshState();
    const secrets = makeSecrets();
    const store = new CalendarTokenStore({ secrets });
    state.refreshTokens.add('rt-x');
    await store.save('google', { accessToken: 'a', refreshToken: 'rt-x', tokenType: 'Bearer', obtainedAt: 1 }, {
      provider: 'google', accountId: 'google', label: 'e', scopes: [], connectedAt: 1,
    });
    const result = await store.disconnect('google', realConfig('google'), makeFakeFetch(state));
    expect(result.revokedRemotely).toBe(true);
    expect(state.revoked.has('rt-x')).toBe(true);
    expect(secrets.map.has('GOODVIBES_CALENDAR_GOOGLE_TOKENS')).toBe(false);
    expect(await store.connectionState('google')).toBe('disconnected');
  });

  test('Microsoft disconnect clears keys locally and reports no remote revocation', async () => {
    const state = freshState();
    const secrets = makeSecrets();
    const store = new CalendarTokenStore({ secrets });
    await store.save('microsoft', { accessToken: 'a', tokenType: 'Bearer', obtainedAt: 1 }, {
      provider: 'microsoft', accountId: 'microsoft', label: 'e', scopes: [], connectedAt: 1,
    });
    const result = await store.disconnect('microsoft', realConfig('microsoft'), makeFakeFetch(state));
    expect(result.revokedRemotely).toBe(false);
    expect(secrets.map.has('GOODVIBES_CALENDAR_MICROSOFT_TOKENS')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reading calendars + events, normalized + paginated
// ---------------------------------------------------------------------------

async function connectedGoogle(): Promise<{ connector: CalendarConnector; state: ServerState }> {
  const state = freshState();
  const secrets = makeSecrets();
  const loopback = makeLoopback(state);
  const connector = new CalendarConnector({ secrets, fetchImpl: makeFakeFetch(state), listenerFactory: loopback.factory });
  const config = realConfig('google');
  const { start, waiter } = await connector.beginConnectAuthCode(config);
  loopback.arm(start.authorizationUrl);
  const { code } = await waiter.waitForCode();
  await connector.completeConnectAuthCode(config, { code, verifier: start.verifier, redirectUri: start.redirectUri });
  return { connector, state };
}

describe('Google Calendar API', () => {
  test('lists calendars with honest write access', async () => {
    const { connector } = await connectedGoogle();
    const calendars = await connector.listCalendars(realConfig('google'));
    expect(calendars).toHaveLength(2);
    expect(calendars.find((c) => c.primary)?.canWrite).toBe(true);
    expect(calendars.find((c) => c.name === 'Team')?.canWrite).toBe(false);
  });

  test('lists events across pages and calendars, normalized + source-labeled', async () => {
    const { connector } = await connectedGoogle();
    const events = await connector.listEvents(realConfig('google'), { timeMin: '2026-07-01T00:00:00Z', timeMax: '2026-07-31T00:00:00Z' });
    // 2 calendars x (page1: 1 event + page2: 1 usable + 1 cancelled skipped) = 4 usable
    expect(events.filter((e) => e.source === 'google-api')).toHaveLength(events.length);
    const timed = events.find((e) => e.uid === 'g1@google')!;
    expect(timed.start.zone).toBe('utc'); // -07:00 offset normalized to a real UTC instant
    expect(timed.start.value).toBe('2026-07-06T16:00:00Z');
    const allDay = events.find((e) => e.summary === 'All day')!;
    expect(allDay.start.kind).toBe('date');
    expect(allDay.start.zone).toBe('floating');
    expect(events.some((e) => (e as { start: { value: string } }).start.value === '2026-07-09')).toBe(false); // cancelled dropped
  });

  test('creates an event and returns it normalized', async () => {
    const { connector } = await connectedGoogle();
    const created = await connector.createEvent(realConfig('google'), 'user@gmail.com', 'Primary', {
      summary: 'New meeting',
      start: { value: '2026-07-10T14:00:00Z', kind: 'date-time', zone: 'utc' },
      end: { value: '2026-07-10T15:00:00Z', kind: 'date-time', zone: 'utc' },
    });
    expect(created.source).toBe('google-api');
    expect(created.summary).toBe('New meeting');
    expect(created.sourceEventId).toBe('g-created');
  });

  test('a 403 names the missing scope; a 429 carries Retry-After; a 401 reconnect', async () => {
    const { connector, state } = await connectedGoogle();
    state.eventsStatus = 403;
    await connector.listEvents(realConfig('google'), { timeMin: 'a', timeMax: 'b' }).then(
      () => { throw new Error('expected 403'); },
      (err: unknown) => {
        expect(err).toBeInstanceOf(CalendarApiError);
        const degraded = (err as CalendarApiError).degraded;
        expect(degraded.kind).toBe('insufficient-scope');
        if (degraded.kind === 'insufficient-scope') expect(degraded.missingScope).toContain('calendar.readonly');
      },
    );
    state.eventsStatus = 429;
    await connector.listEvents(realConfig('google'), { timeMin: 'a', timeMax: 'b' }).then(
      () => { throw new Error('expected 429'); },
      (err: unknown) => {
        const degraded = (err as CalendarApiError).degraded;
        expect(degraded.kind).toBe('rate-limited');
        if (degraded.kind === 'rate-limited') expect(degraded.retryAfterMs).toBe(30_000);
      },
    );
    state.eventsStatus = 401;
    await connector.listEvents(realConfig('google'), { timeMin: 'a', timeMax: 'b' }).then(
      () => { throw new Error('expected 401'); },
      (err: unknown) => expect((err as CalendarApiError).degraded.kind).toBe('reconnect-needed'),
    );
  });
});

describe('Microsoft Graph API', () => {
  async function connectedGraph(): Promise<{ connector: CalendarConnector; state: ServerState }> {
    const state = freshState();
    const connector = new CalendarConnector({ secrets: makeSecrets(), fetchImpl: makeFakeFetch(state), sleep: noSleep, clock: () => 1_000 });
    const config = realConfig('microsoft');
    const start = await connector.beginConnectDeviceCode(config);
    await connector.completeConnectDeviceCode(config, start);
    return { connector, state };
  }

  test('lists calendars, paginated events, and creates an event', async () => {
    const { connector } = await connectedGraph();
    const calendars = await connector.listCalendars(realConfig('microsoft'));
    expect(calendars.find((c) => c.primary)?.canWrite).toBe(true);

    const events = await connector.listEvents(realConfig('microsoft'), { timeMin: '2026-07-01T00:00:00Z', timeMax: '2026-07-31T00:00:00Z' });
    expect(events.every((e) => e.source === 'microsoft-graph')).toBe(true);
    const sync = events.find((e) => e.uid === 'm1@ms')!;
    expect(sync.start.zone).toBe('utc');
    expect(sync.start.value).toBe('2026-07-06T15:00:00Z');
    const holiday = events.find((e) => e.summary === 'Holiday')!;
    expect(holiday.start.kind).toBe('date');

    const created = await connector.createEvent(realConfig('microsoft'), 'cal-primary', 'Calendar', {
      summary: 'Graph event',
      start: { value: '2026-07-11T09:00:00Z', kind: 'date-time', zone: 'utc' },
      end: { value: '2026-07-11T10:00:00Z', kind: 'date-time', zone: 'utc' },
    });
    expect(created.source).toBe('microsoft-graph');
    expect(created.sourceEventId).toBe('m-created');
  });
});

// A semantic fixture answer is injected at the canonical port; production still
// traverses token store → CalendarConnector → provider client → HTTP failure.
function scopePort(selected: string | null, confidence = 0.97) {
  return fakePort((name, question, state) => {
    const tokens = (state as { tokens: { id: string; text: string }[] }).tokens;
    const chosen = selected === null ? 'none' : selected === 'unresolved' ? 'unresolved'
      : tokens.find((token) => token.text === selected)?.id;
    if (!chosen) throw new Error(`Fixture cannot find selected source token: ${selected}`);
    if (name === 'pick') return choiceAnswer(question, chosen, confidence);
    return noulAnswer(name === `fits_${chosen}` ? 0.98 : 0.02);
  });
}
let previousScopePort: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previousScopePort = installJudgmentPort(scopePort('calendar.readonly').port); });
afterEach(() => { installJudgmentPort(previousScopePort); });

async function scopeFailure(body: unknown, selected: string | null, confidence = 0.97) {
  const fake = scopePort(selected, confidence);
  installJudgmentPort(fake.port);
  const { connector, state } = await connectedGoogle();
  state.eventsStatus = 403;
  state.eventsErrorBody = body;
  let error: unknown;
  try { await connector.listEvents(realConfig('google'), { timeMin: '2026-07-01T00:00:00Z', timeMax: '2026-08-01T00:00:00Z' }); }
  catch (caught) { error = caught; }
  return { error, requests: fake.requests };
}

describe('calendar missing-permission judgment through the connector', () => {
  test('names the missing permission without a scope keyword', async () => {
    const { error, requests } = await scopeFailure({ error: { message: 'The application lacks calendar.events.readonly for this operation.' } }, 'calendar.events.readonly');
    expect(error).toBeInstanceOf(CalendarApiError);
    expect((error as CalendarApiError).degraded).toMatchObject({ kind: 'insufficient-scope', missingScope: 'calendar.events.readonly' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.context?.battery).toBe('engine.calendar.missing-permission');
  });
  test('does not take already-granted or incidental scopes before the actual missing permission', async () => {
    const body = { error: { message: 'Granted scopes: calendar.readonly. Documentation mentions calendar.events. This request requires calendar.events.owned, which is absent.' } };
    const { error } = await scopeFailure(body, 'calendar.events.owned');
    expect((error as CalendarApiError).degraded).toMatchObject({ kind: 'insufficient-scope', missingScope: 'calendar.events.owned' });
  });
  test('settled none preserves forbidden without inventing an insufficient scope', async () => {
    const { error, requests } = await scopeFailure({ error: { message: 'The account has calendar.readonly. Access is denied by an organization policy.' } }, null);
    expect((error as CalendarApiError).degraded).toMatchObject({ kind: 'provider-error', status: 403 });
    expect(requests).toHaveLength(1);
  });
  test('keeps complete evidence, including the missing permission after a long introduction', async () => {
    const body = { error: { message: 'No changes. '.repeat(250) + 'The application lacks calendar.events.owned for this request.' } };
    const { error, requests } = await scopeFailure(body, 'calendar.events.owned');
    expect((error as CalendarApiError).degraded).toMatchObject({ kind: 'insufficient-scope', missingScope: 'calendar.events.owned' });
    expect(JSON.stringify(requests[0]?.state)).toContain(body.error.message);
  });
  test.each([0.6, 0.2])('uncertain reading at %s remains an explicit operational failure', async (confidence) => {
    const { error } = await scopeFailure({ error: { message: 'Missing scope: calendar.readonly' } }, 'calendar.readonly', confidence);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('CalendarScopeReadingError');
    expect(error).not.toBeInstanceOf(CalendarApiError);
  });
  test('explicit unresolved is not settled none', async () => {
    const { error } = await scopeFailure({ error: { message: 'A permission may or may not be absent.' } }, 'unresolved');
    expect((error as Error).name).toBe('CalendarScopeReadingError');
  });
  test('unconfigured port never falls back to a regex answer', async () => {
    const { connector, state } = await connectedGoogle();
    state.eventsStatus = 403;
    installJudgmentPort(undefined);
    await expect(connector.listEvents(realConfig('google'), { timeMin: '2026-07-01T00:00:00Z', timeMax: '2026-08-01T00:00:00Z' })).rejects.toMatchObject({ name: 'JudgmentPortMissingError' });
  });
});

async function seededConnector(provider: CalendarProviderId, response: HttpResponse) {
  const secrets = makeSecrets();
  await new CalendarTokenStore({ secrets }).save(provider, {
    accessToken: 'synthetic-private-calendar-token', tokenType: 'Bearer', expiresAt: Date.now() + 3_600_000, obtainedAt: Date.now(),
  }, { provider, accountId: provider, label: 'Fixture account', scopes: [], connectedAt: Date.now() });
  const requests: HttpRequest[] = [];
  const connector = new CalendarConnector({ secrets, fetchImpl: async (request) => { requests.push(request); return response; } });
  return { connector, requests };
}
const WINDOW = { timeMin: '2026-07-01T00:00:00Z', timeMax: '2026-08-01T00:00:00Z' };

describe('calendar permission provenance and complete evidence', () => {
  test.each(['google', 'microsoft'] as const)('%s uses a single RFC6750 required scope without a judgment call', async (provider) => {
    installJudgmentPort(undefined);
    const { connector } = await seededConnector(provider, jsonResponse(403, { error: 'Forbidden' }, {
      'WWW-Authenticate': 'Bearer realm="calendar", error="insufficient_scope", scope="Calendars.ReadWrite"',
    }));
    await expect(connector.listCalendars(realConfig(provider))).rejects.toMatchObject({ degraded: { kind: 'insufficient-scope', missingScope: 'Calendars.ReadWrite' } });
  });
  test.each([
    'Bearer scope="Calendars.Read", error="invalid_token"',
    'Bearer error="insufficient_scope", scope="Calendars.Read Calendars.ReadWrite"',
    'Bearer error="insufficient_scope", scope="Calendars.Read", scope="Calendars.Write"',
    'Bearer error="insufficient_scope", scope="Calendars.Read", Basic realm="other"',
  ])('an ambiguous or differently purposed challenge needs semantic evidence: %s', async (challenge) => {
    const fake = scopePort(null); installJudgmentPort(fake.port);
    const error = await errorFromResponse(jsonResponse(403, { error: { message: 'No particular permission is established as missing.' } }, { 'WWW-Authenticate': challenge }), 'microsoft');
    expect(error.degraded.kind).toBe('provider-error');
    expect(fake.requests).toHaveLength(1);
    expect((fake.requests[0]?.state as { authenticationChallenge: string }).authenticationChallenge).toBe(challenge);
  });
  test('Microsoft selects the exact absent permission after a granted permission and incidental example', async () => {
    const fake = scopePort('Calendars.ReadWrite'); installJudgmentPort(fake.port);
    const { connector } = await seededConnector('microsoft', jsonResponse(403, { error: { code: 'ErrorAccessDenied',
      message: 'Calendars.Read has been granted; examples use Calendars.Read.Shared. Calendars.ReadWrite is missing for this request.' } }));
    await expect(connector.listCalendars(realConfig('microsoft'))).rejects.toMatchObject({ degraded: { kind: 'insufficient-scope', missingScope: 'Calendars.ReadWrite' } });
    expect(JSON.stringify(fake.requests[0]?.state)).not.toContain('synthetic-private-calendar-token');
  });
  test('arbitrary JSON scope field is evidence, not an authoritative missing permission', async () => {
    const fake = scopePort(null); installJudgmentPort(fake.port);
    const error = await errorFromResponse(jsonResponse(403, { error: { code: 'accessDenied', scope: 'Calendars.Read', message: 'This is the granted scope. The account license is missing.' } }), 'microsoft');
    expect(error.degraded).toMatchObject({ kind: 'provider-error', status: 403 });
    expect(fake.requests).toHaveLength(1);
  });
  test('preserves raw evidence and decoded identifier spelling', async () => {
    const fake = scopePort('Calendars.ReadWrite'); installJudgmentPort(fake.port);
    const raw = '{"error":{"message":"Missing Calendars\\u002eReadWrite"}}';
    const error = await errorFromResponse(jsonResponse(403, raw), 'microsoft');
    expect(error.degraded).toMatchObject({ missingScope: 'Calendars.ReadWrite' });
    expect((fake.requests[0]?.state as { rawResponseBody: string }).rawResponseBody).toBe(raw);
  });
  test.each([
    '{"error":{"access_token":"synthetic-protected-value","access_token":"","message":"Account disabled"}}',
    '{"error":{"\\u0061ccess_token":"synthetic-protected-value","access_token":"","message":"Account disabled"}}',
    JSON.stringify({ error: { message: '{"access_token":"synthetic-protected-value","access_token":""}' } }),
    '{"error":{"\\u0061ccess_token":"synthetic-protected-value",broken',
  ])('ambiguous or malformed encoded evidence cannot hide declared credentials', async (body) => {
    const fake = scopePort(null); installJudgmentPort(fake.port);
    await expect(errorFromResponse(jsonResponse(403, body), 'google')).rejects.toBeInstanceOf(Error);
    expect(fake.requests).toHaveLength(0);
  });
  test('direct registered battery entry also refuses overwritten protected raw fields', async () => {
    const fake = scopePort(null);
    const rawResponseBody = '{"error":{"\\u0061ccess_token":"synthetic-protected-value","access_token":"","message":"Account disabled"}}';
    await expect(missingPermission.read(fake.port, { provider: 'google', rawResponseBody,
      responseBody: JSON.parse(rawResponseBody), authenticationChallenge: '' })).rejects.toBeInstanceOf(Error);
    expect(fake.requests).toHaveLength(0);
  });
  test('candidate overflow is refused rather than dropping later evidence', async () => {
    const fake = scopePort(null); installJudgmentPort(fake.port);
    await expect(errorFromResponse(jsonResponse(403, Array.from({ length: 260 }, (_, index) => `word${index}`).join(' ') + ' Missing Calendars.Read.'), 'microsoft'))
      .rejects.toMatchObject({ name: 'CalendarScopeReadingError', reason: 'evidence-limit' });
    expect(fake.requests).toHaveLength(0);
  });
  test('context overflow is refused without clipping even with few repeated tokens', async () => {
    const fake = scopePort(null); installJudgmentPort(fake.port);
    await expect(errorFromResponse(jsonResponse(403, 'word '.repeat(20_000)), 'google'))
      .rejects.toMatchObject({ name: 'CalendarScopeReadingError', reason: 'evidence-limit' });
    expect(fake.requests).toHaveLength(0);
  });
  test.each([
    JSON.stringify({ error: { message: 'intro '.repeat(1_000), access_token: 'synthetic-protected-value' } }),
    '{"error":{"message":"denied","\\u0061ccess_token":"synthetic-protected-value"}}',
  ])('complete protected evidence is checked before projection or port use', async (body) => {
    const fake = scopePort(null); installJudgmentPort(fake.port);
    await expect(errorFromResponse(jsonResponse(403, body), 'google')).rejects.toMatchObject({ name: 'JudgmentInputError' });
    expect(fake.requests).toHaveLength(0);
  });
  test.each([
    'Bearer error="insufficient_scope", scope="access_token=synthetic-protected-value"',
    '{"access_token":"synthetic-protected-value","access_token":""}',
    'Bearer error_description=' + JSON.stringify('{"\\u0061ccess_token":"synthetic-protected-value","access_token":""}'),
  ])('authentication challenge credential material never reaches the port', async (challenge) => {
    const fake = scopePort(null); installJudgmentPort(fake.port);
    await expect(errorFromResponse(jsonResponse(403, 'Denied', { 'WWW-Authenticate': challenge }), 'google')).rejects.toBeInstanceOf(Error);
    expect(fake.requests).toHaveLength(0);
  });
  test('an unreadable response is not a settled none', async () => {
    const fake = scopePort(null); installJudgmentPort(fake.port);
    const response = { ...jsonResponse(403, ''), text: async () => { throw new Error('synthetic body read failure'); } };
    await expect(errorFromResponse(response, 'google')).rejects.toMatchObject({ name: 'CalendarScopeReadingError', reason: 'unreadable-response' });
    expect(fake.requests).toHaveLength(0);
  });
  test.each(['outside-candidates', 'missing-answer', 'invalid-fit', 'missing-probabilities'])('rejects malformed injected %s answers', async (failure) => {
    const valid = scopePort('Calendars.Read');
    installJudgmentPort({ model: valid.port.model, async ask(request) {
      const result = await valid.port.ask(request);
      const answers = result.answers as unknown as Record<string, unknown>;
      if (failure === 'outside-candidates') answers.pick = { type: 'choice', choice: 'invented', confidence: 0.99, probabilities: { invented: 1 } };
      if (failure === 'missing-answer') delete answers.pick;
      if (failure === 'missing-probabilities') answers.pick = { type: 'choice', choice: 'none', confidence: 0.99 };
      if (failure === 'invalid-fit') answers[Object.keys(answers).find((key) => key.startsWith('fits_'))!] = { type: 'noul', noul: NaN };
      return result;
    } });
    await expect(errorFromResponse(jsonResponse(403, 'Missing Calendars.Read'), 'microsoft')).rejects.toMatchObject({ name: 'CalendarScopeReadingError', reason: 'malformed' });
  });
  test('a none choice contradicted by a positive fit stays unresolved', async () => {
    const fake = fakePort((_name, question) => question.type === 'choice' ? choiceAnswer(question, 'none', 0.99) : noulAnswer(0.99));
    installJudgmentPort(fake.port);
    await expect(errorFromResponse(jsonResponse(403, 'Missing Calendars.Read'), 'microsoft')).rejects.toMatchObject({ name: 'CalendarScopeReadingError', reason: 'unresolved' });
  });
  test.each([401, 429])('%s remains mechanical even with no port and credential-like error text', async (status) => {
    installJudgmentPort(undefined);
    const error = await errorFromResponse(jsonResponse(status, 'access_token=synthetic', { 'Retry-After': '3' }), 'google');
    expect(error.degraded).toMatchObject(status === 401 ? { kind: 'reconnect-needed' } : { kind: 'rate-limited', retryAfterMs: 3_000 });
  });
  test.each([['', 1_000], ['nonsense', 1_000], ['-1', 0], ['1.5', 1_500]] as const)('Retry-After %j keeps its mechanical value', async (header, expected) => {
    installJudgmentPort(undefined);
    const error = await errorFromResponse(jsonResponse(429, '', { 'Retry-After': header }), 'microsoft');
    expect(error.degraded).toMatchObject({ kind: 'rate-limited', retryAfterMs: expected });
  });
  test('HTTP-date Retry-After remains honored without Jev', async () => {
    installJudgmentPort(undefined);
    const error = await errorFromResponse(jsonResponse(429, '', { 'Retry-After': new Date(Date.now() + 60_000).toUTCString() }), 'google');
    expect(error.degraded.kind).toBe('rate-limited');
    if (error.degraded.kind === 'rate-limited') expect(error.degraded.retryAfterMs).toBeGreaterThan(58_000);
  });
  test('registered battery fixtures exercise scope, none, and unresolved', async () => {
    const expectations: Record<string, string | null> = {
      'google without scope keyword': 'https://www.googleapis.com/auth/calendar.events.readonly',
      'graph granted before missing': 'Calendars.ReadWrite',
      'incidental permission and policy denial': null,
      'google structured rate denial is not scope': null,
      'negated permission absence': null,
      'ambiguous permission': 'unresolved',
    };
    const fake = scopePort(null);
    const results = await missingPermission.checkFixtures({ model: fake.port.model, async ask(request) {
      return scopePort(expectations[request.context?.fixture ?? ''] ?? null).port.ask(request);
    } });
    expect(results).toHaveLength(6);
    expect(results.every((result) => result.correct)).toBe(true);
  });
});

function transportConfig(fetchImpl: NonNullable<JudgmentConfig['fetch']>): JudgmentConfig {
  return { endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic-judgment-key' },
    model: PINNED_MODEL, timeoutMs: 1_000, retry: { backoffInitialMs: 1, backoffMaxMs: 1, backoffJitter: 0 }, fetch: fetchImpl };
}
function permissionWireResponse(body: string): Response {
  const { state, questions } = JSON.parse(body) as { state: EntryType; questions: Record<string, Question> };
  const token = (state as { tokens: { id: string; text: string }[] }).tokens.find((candidate) => candidate.text === 'Calendars.ReadWrite')!;
  const answers = Object.fromEntries(Object.entries(questions).map(([name, question]) => [name,
    name === 'pick' ? choiceAnswer(question, token.id, 0.98) : noulAnswer(name === `fits_${token.id}` ? 0.98 : 0.02)]));
  return Response.json({ model: PINNED_MODEL, answers, usage: { input_tokens: 1, output_tokens: 1 } });
}

describe('calendar connector uses the shared judgment retry and cancellation lifecycle', () => {
  test('transient Jev outage recovers without repeating a failed calendar write', async () => {
    let attempts = 0;
    installJudgmentPort(createSystemOnePort(transportConfig(async (_url, init) => {
      if (++attempts < 3) return Response.json({}, { status: 503 });
      return permissionWireResponse(String(init?.body));
    })));
    const { connector, requests } = await seededConnector('microsoft', jsonResponse(403, 'Missing Calendars.ReadWrite'));
    await expect(connector.createEvent(realConfig('microsoft'), 'calendar-id', 'Private calendar', {
      summary: 'Never send this event to Jev', start: { value: '2026-07-06', kind: 'date', zone: 'floating' },
    })).rejects.toMatchObject({ degraded: { kind: 'insufficient-scope', missingScope: 'Calendars.ReadWrite' } });
    expect(attempts).toBe(3);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
  });
  test.each(['google', 'microsoft'] as const)('%s cancellation interrupts shared outage wait without a fabricated scope or repeated provider call', async (provider) => {
    const controller = new AbortController();
    let began!: () => void;
    const entered = new Promise<void>((resolve) => { began = resolve; });
    let attempts = 0;
    installJudgmentPort(createSystemOnePort(transportConfig(async () => { attempts++; began(); return Response.json({}, { status: 503 }); })));
    const { connector, requests } = await seededConnector(provider, jsonResponse(403, 'Missing Calendars.ReadWrite'));
    const pending = connector.listEvents(realConfig(provider), WINDOW, { signal: controller.signal });
    await entered;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
    const stoppedAt = attempts;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(attempts).toBe(stoppedAt);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.signal).toBe(controller.signal);
  });
  test('a permanent Jev failure is explicit and does not retry or relabel as none', async () => {
    let attempts = 0;
    installJudgmentPort(createSystemOnePort(transportConfig(async () => { attempts++; return Response.json({}, { status: 401 }); })));
    const { connector, requests } = await seededConnector('google', jsonResponse(403, 'Missing Calendars.ReadWrite'));
    await expect(connector.listCalendars(realConfig('google'))).rejects.toMatchObject({ kind: 'rejected' });
    expect(attempts).toBe(1);
    expect(requests).toHaveLength(1);
  });
});
