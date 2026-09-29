/**
 * A calendar write with credentials from the encrypted secret store is gated
 * on the scopes Google grants on the token refresh. The store records no
 * scope list, so gating on the stored list refused every write, whatever the
 * account had actually granted.
 */
import { describe, expect, test } from 'bun:test';
import { createGoogleCalendarGatewayService } from '../sdk/src/platform/google/gateway-calendar-service.ts';
import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS } from '../sdk/src/platform/google/setup-plan.ts';
import { isGatewayVerbError } from '../sdk/src/platform/control-plane/routes/gateway-verb-error.ts';
import type { GoogleConnectionSources } from '../sdk/src/platform/google/connection.ts';

const TOKEN_ENDPOINT = 'oauth2.googleapis.com/token';

function storeSources(): GoogleConnectionSources {
  return {
    files: { exists: () => false, readText: () => null },
    homeDirectory: '/home/tester',
    configGet: (key: string) => (key === GOOGLE_CONFIG_KEYS.oauthClientId ? 'client-123' : undefined),
    secretGet: async (key: string) => {
      if (key === GOOGLE_SECRET_KEYS.oauthClientSecret) return 'client-secret';
      if (key === GOOGLE_SECRET_KEYS.oauthRefreshToken) return 'refresh-live';
      return null;
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function service(grantedScope: string, created: string[]) {
  return createGoogleCalendarGatewayService({
    sources: storeSources(),
    fetch: {
      fetch: async (url: string, init?: RequestInit): Promise<Response> => {
        if (url.includes(TOKEN_ENDPOINT)) return json({ access_token: 'live', expires_in: 3600, scope: grantedScope, token_type: 'Bearer' });
        if ((init?.method ?? 'GET') === 'POST') {
          created.push(url);
          return json({ id: 'evt-1', summary: 'Dentist' });
        }
        return json({ items: [] });
      },
    },
  });
}

const input = { title: 'Dentist', start: '2026-10-01T09:00:00Z', end: '2026-10-01T10:00:00Z' };

describe('calendar write with a store credential', () => {
  test('a grant that includes calendar.events writes the event', async () => {
    const created: string[] = [];
    const result = await service('https://www.googleapis.com/auth/calendar.events openid', created).createEvent(input);
    expect(result.eventId).toBe('evt-1');
    expect(created).toHaveLength(1);
  });

  test('a read-only grant is refused before anything is written', async () => {
    const created: string[] = [];
    let error: unknown;
    try {
      await service('https://www.googleapis.com/auth/calendar.readonly', created).createEvent(input);
    } catch (caught) {
      error = caught;
    }
    expect(isGatewayVerbError(error) && error.code).toBe('PERMISSION_DENIED');
    expect(created).toHaveLength(0);
  });
});
