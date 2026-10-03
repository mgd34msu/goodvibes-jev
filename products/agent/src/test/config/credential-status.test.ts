/**
 * The daemon-client credential STATUS read must degrade honestly and never
 * fabricate "configured" nor surface a secret byte. Hermetic, a fake fetch stands in for
 * the daemon (no real daemon, no ports); the pure deriver is exercised directly.
 */
import { describe, expect, test } from 'bun:test';
import {
  deriveCredentialAvailability,
  fetchDaemonCredentialAvailability,
} from '../../config/credential-status.ts';

const CONNECTION = { baseUrl: 'http://127.0.0.1:0', token: 'test-operator-token' } as const;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('deriveCredentialAvailability (honest degrade)', () => {
  test('a healthy credentials.get result yields status metadata, never bytes', () => {
    const out = deriveCredentialAvailability({
      ok: true,
      value: {
        available: true,
        credentials: [
          { key: 'SHARED_CHANNEL_TOKEN', configured: true, usable: true, source: 'store', secure: true },
          { key: 'BROKEN_REF', configured: true, usable: false, source: 'env-ref' },
        ],
      },
    });
    expect(out.available).toBe(true);
    if (out.available) {
      expect(out.credentials).toHaveLength(2);
      expect(out.credentials[0]).toEqual({ key: 'SHARED_CHANNEL_TOKEN', configured: true, usable: true, source: 'store', secure: true });
      // A configured-but-unresolvable ref is honestly usable:false, not dropped, not faked.
      expect(out.credentials[1]?.configured).toBe(true);
      expect(out.credentials[1]?.usable).toBe(false);
      // The status type carries no value/bytes field, assert dynamically too.
      for (const c of out.credentials) expect('value' in c).toBe(false);
    }
  });

  test('503 CREDENTIAL_STORE_UNAVAILABLE degrades honestly, never fabricated-configured', () => {
    const out = deriveCredentialAvailability({ ok: false, error: { code: 'CREDENTIAL_STORE_UNAVAILABLE', status: 503 } });
    expect(out.available).toBe(false);
    if (!out.available) expect(out.reason).toBe('The daemon has no shared credential store wired.');
  });

  test('METHOD_NOT_FOUND from an older daemon degrades with the not-served reason', () => {
    const out = deriveCredentialAvailability({ ok: false, error: { code: 'METHOD_NOT_FOUND', status: 404 } });
    expect(out.available).toBe(false);
    if (!out.available) expect(out.reason).toBe('This daemon does not serve credential status yet.');
  });

  test('a transport failure degrades generically; a malformed body degrades too', () => {
    const failed = deriveCredentialAvailability({ ok: false, error: new Error('fetch failed') });
    expect(failed.available).toBe(false);
    const malformed = deriveCredentialAvailability({ ok: true, value: { credentials: 'nope' } });
    expect(malformed.available).toBe(false);
  });
});

describe('fetchDaemonCredentialAvailability (client status read)', () => {
  test('a 200 status body maps to available credentials, never bytes', async () => {
    const fetchImpl = async () => jsonResponse(200, {
      available: true,
      credentials: [{ key: 'GOODVIBES_SURFACES_SLACK_BOT_TOKEN', configured: true, usable: true, source: 'store', scope: 'user', secure: true }],
    });
    const out = await fetchDaemonCredentialAvailability(CONNECTION, { fetchImpl });
    expect(out.available).toBe(true);
    if (out.available) {
      expect(out.credentials[0]?.key).toBe('GOODVIBES_SURFACES_SLACK_BOT_TOKEN');
      expect('value' in (out.credentials[0] ?? {})).toBe(false);
    }
  });

  test('a 503 with the store code degrades honestly, never configured', async () => {
    const fetchImpl = async () => jsonResponse(503, { code: 'CREDENTIAL_STORE_UNAVAILABLE', error: 'no shared store' });
    const out = await fetchDaemonCredentialAvailability(CONNECTION, { fetchImpl });
    expect(out.available).toBe(false);
    if (!out.available) expect(out.reason).toBe('The daemon has no shared credential store wired.');
  });

  test('an older daemon 404 (no code) is treated as method-not-found', async () => {
    const fetchImpl = async () => jsonResponse(404, { error: 'Unknown gateway method' });
    const out = await fetchDaemonCredentialAvailability(CONNECTION, { fetchImpl });
    expect(out.available).toBe(false);
    if (!out.available) expect(out.reason).toBe('This daemon does not serve credential status yet.');
  });

  test('a transport throw degrades generically, never fabricating configured', async () => {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    const out = await fetchDaemonCredentialAvailability(CONNECTION, { fetchImpl });
    expect(out.available).toBe(false);
  });

  test('an absent operator token is honest-unavailable, not a fabricated status', async () => {
    let called = false;
    const fetchImpl = async () => { called = true; return jsonResponse(200, { available: true, credentials: [] }); };
    const out = await fetchDaemonCredentialAvailability({ baseUrl: CONNECTION.baseUrl, token: null }, { fetchImpl });
    expect(out.available).toBe(false);
    expect(called).toBe(false); // no wire call without a token
  });
});
