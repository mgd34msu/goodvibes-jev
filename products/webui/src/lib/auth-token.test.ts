/**
 * setExplicitAuthToken, clear-on-failure contract (login-gate honesty).
 *
 * Uses the REAL wrapper (no module mock of './goodvibes') and stubs global fetch so
 * auth.current() sees a daemon that answers but rejects the token (401), instead of
 * hitting a real socket with nothing listening. The token must be stored, then
 * auto-cleared when validation fails, so a bad paste never leaves a lingering
 * credential that makes the shell look signed-in.
 *
 * Why a fetch stub and not a real refused connection: this file used to rely on
 * GOODVIBES_BASE_URL (http://127.0.0.1:3421 outside a browser) having nothing
 * listening, so `sdk.auth.current()`'s real `fetch()` call rejected with
 * ECONNREFUSED and that rejection was what setExplicitAuthToken's catch saw. That
 * real TCP connection attempt raced the test's own lifetime: the fetch promise our
 * code awaits resolves/rejects on the turn we expect, but the underlying socket
 * teardown can surface a SECOND, independent rejection later in the runtime's own
 * internals, observed landing during this test's run and, on a slower CI runner,
 * up to ~24 seconds later while an unrelated suite was executing. That stray
 * rejection is not something this file's own promises hold a handle to, so nothing
 * in application code can await or abort it, the only fix at the source is to never
 * open the real socket in the first place. Stubbing fetch to answer synchronously
 * (in-process, no I/O) removes the race entirely rather than papering over its timing.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { setExplicitAuthToken, tokenStore, hasStoredTokenSync } from './goodvibes';

const realFetch = globalThis.fetch;

/**
 * Stand-in for the daemon's control-plane/auth endpoint: always answers (no socket,
 * no async gap) with a 401 so `sdk.auth.current()` rejects the same way a real daemon
 * would for a token it does not recognize. Carries `preconnect` so the stub still
 * structurally matches `typeof fetch` (the SDK's fetch option type requires it).
 */
function createRejectingFetchStub(): typeof fetch {
  const impl = async (): Promise<Response> =>
    new Response(JSON.stringify({ authenticated: false, authMode: 'invalid' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  return Object.assign(impl, { preconnect: realFetch.preconnect }) as unknown as typeof fetch;
}

beforeEach(async () => {
  await tokenStore.clearToken();
  globalThis.fetch = createRejectingFetchStub();
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await tokenStore.clearToken();
});

describe('setExplicitAuthToken', () => {
  test('CLEARS the token when validation fails (daemon rejects the token with 401)', async () => {
    // auth.current() cannot succeed against a token the daemon rejects; whatever the
    // failure, the pasted token must not survive it. (Handle the rejection directly to
    // keep the run quiet.)
    let threw = false;
    try {
      await setExplicitAuthToken('an-invalid-token');
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // The invalid token must not linger after failed validation.
    expect(await tokenStore.getToken()).toBeFalsy();
    expect(hasStoredTokenSync()).toBe(false);
  });

  test('an empty token is rejected before any network call', async () => {
    let threw = false;
    try {
      await setExplicitAuthToken('   ');
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // Nothing was stored.
    expect(hasStoredTokenSync()).toBe(false);
  });
});
