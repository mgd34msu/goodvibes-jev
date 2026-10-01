/**
 * relay-connection.ts, the active-route store and routedFetch's routing decisions.
 *
 * Deliberately does NOT exercise a real relay handshake (createRelayClient talks real
 * WebSocket/E2E crypto), that belongs to an integration test against a real or stubbed
 * relay server. These cases cover what is unit-testable without one: the route store's
 * pub/sub, routedFetch falling through to the plain fetch on the direct route (the
 * common, unchanged case), and that a stream request over relay is NO LONGER rejected,
 * the relay tunnel now carries event streams, so a stream request routes like any other
 * (falling through to the plain fetch when no pairing is stored). A real tunnelled stream
 * belongs to an integration test against a real or stubbed relay server.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  getActiveRoute,
  routedFetch,
  setActiveRoute,
  subscribeActiveRoute,
} from './relay-connection';
import { RELAY_PAIRING_STORAGE_KEY } from './relay-pairing';

/** A minimal, correctly-typed fetch stub (see relay-connection.ts's own note on why
 * `typeof fetch` needs a `preconnect` static in this project's bun-typed globals). */
function stubFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return Object.assign(handler, {
    preconnect: () => {},
  }) as typeof fetch;
}

afterEach(() => {
  setActiveRoute('direct');
  window.localStorage.removeItem(RELAY_PAIRING_STORAGE_KEY);
});

describe('active route store', () => {
  test('defaults to direct', () => {
    expect(getActiveRoute()).toBe('direct');
  });

  test('setActiveRoute updates the snapshot', () => {
    setActiveRoute('relay');
    expect(getActiveRoute()).toBe('relay');
  });

  test('subscribeActiveRoute notifies listeners only on an actual change', () => {
    let calls = 0;
    const unsubscribe = subscribeActiveRoute(() => { calls += 1; });
    setActiveRoute('direct'); // already direct, no-op, no notify
    expect(calls).toBe(0);
    setActiveRoute('relay');
    expect(calls).toBe(1);
    setActiveRoute('relay'); // unchanged, no notify
    expect(calls).toBe(1);
    unsubscribe();
    setActiveRoute('direct');
    expect(calls).toBe(1); // unsubscribed, no further notifications
  });
});

describe('routedFetch', () => {
  test('delegates to the global fetch on the direct route (unchanged default behavior)', async () => {
    setActiveRoute('direct');
    let sawUrl: unknown;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubFetch((input) => {
      sawUrl = input;
      return Promise.resolve(new Response('ok'));
    });
    try {
      const res = await routedFetch('https://daemon.example/api/x');
      expect(sawUrl).toBe('https://daemon.example/api/x');
      expect(await res.text()).toBe('ok');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('no longer rejects an event-stream request over relay; it routes like any other call', async () => {
    // The relay tunnel now carries event streams, so the old immediate rejection is gone.
    // With no pairing stored there is no relay client, so the request falls through to the
    // global fetch (proving it is NOT special-cased into a rejection anymore).
    setActiveRoute('relay');
    let sawUrl: unknown;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubFetch((input) => {
      sawUrl = input;
      return Promise.resolve(new Response('event: ping\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    });
    try {
      const res = await routedFetch('https://daemon.example/api/control-plane/events', {
        headers: { Accept: 'text/event-stream' },
      });
      expect(sawUrl).toBe('https://daemon.example/api/control-plane/events');
      expect(res.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('an event-stream request built as a Headers instance also routes through (no rejection)', async () => {
    setActiveRoute('relay');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubFetch(() => Promise.resolve(new Response('ok')));
    try {
      const res = await routedFetch('https://daemon.example/api/control-plane/events', {
        headers: new Headers({ Accept: 'text/event-stream' }),
      });
      expect(res.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('falls back to the global fetch on relay route with no pairing stored (no client to route through)', async () => {
    setActiveRoute('relay');
    let sawUrl: unknown;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubFetch((input) => {
      sawUrl = input;
      return Promise.resolve(new Response('ok'));
    });
    try {
      const res = await routedFetch('https://daemon.example/api/x');
      expect(sawUrl).toBe('https://daemon.example/api/x');
      expect(res.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
