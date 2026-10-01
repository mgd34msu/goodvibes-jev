/**
 * reconcilePushSubscriptionOnOpen, the client half of push-subscription
 * self-heal (Step 2 of the SDK 1.8.0 pairing/push round).
 *
 * Exercises the real function against a stubbed PushManager/serviceWorker and
 * a stubbed fetch answering push.subscriptions.list/reconcile, the same
 * "stub fetch, call the real facade" discipline push-facade.test.ts uses, plus
 * the PushManager stand-in e2e/pwa.e2e.ts's mockPushApis uses for the browser
 * side. Proves: no daemon record + a live subscription reconciles; a served
 * record whose hash already matches the live endpoint reconciles NOTHING
 * (heal-in-place must not become a write on every open); a served record with
 * a genuinely different endpoint (drift) reconciles; no live subscription at
 * all is an honest no-op, not an error.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PUSH_DEVICE_ID_STORAGE_KEY, computeEndpointHash, reconcilePushSubscriptionOnOpen } from './push-client';

const LIVE_ENDPOINT = 'https://push.example.test/live-endpoint';
const STALE_ENDPOINT = 'https://push.example.test/stale-endpoint';
const KNOWN_DEVICE_ID = 'device-e2e-fixed';

let originalFetch: typeof fetch;
let calls: { methodId: string; body: unknown }[];

function stubFetch(responses: Record<string, unknown>): void {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const match = /\/api\/control-plane\/methods\/([^/]+)\/invoke$/.exec(url);
    const methodId = match ? match[1] : 'unknown';
    const body = init?.body ? (JSON.parse(init.body as string) as { body?: unknown }).body : undefined;
    calls.push({ methodId, body });
    const responseBody = responses[methodId] ?? {};
    return new Response(JSON.stringify(responseBody), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

function installPushGlobals(subscription: { endpoint: string } | null): void {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  (window as unknown as { PushManager: unknown }).PushManager = function pushManagerStub() {
    /* presence-only stand-in */
  };
  (window as unknown as { Notification: unknown }).Notification = Object.assign(
    function notificationStub() {
      /* presence-only stand-in */
    },
    { permission: 'granted' },
  );
  const registration = {
    pushManager: {
      async getSubscription() {
        if (!subscription) return null;
        return {
          endpoint: subscription.endpoint,
          toJSON: () => ({ endpoint: subscription.endpoint, keys: { p256dh: 'p256dh-key', auth: 'auth-key' } }),
        };
      },
    },
  };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { ready: Promise.resolve(registration) },
  });
}

function uninstallPushGlobals(): void {
  delete (window as unknown as { PushManager?: unknown }).PushManager;
  delete (window as unknown as { Notification?: unknown }).Notification;
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: undefined });
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: undefined });
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  window.localStorage.setItem(PUSH_DEVICE_ID_STORAGE_KEY, KNOWN_DEVICE_ID);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  uninstallPushGlobals();
  window.localStorage.removeItem(PUSH_DEVICE_ID_STORAGE_KEY);
});

describe('reconcilePushSubscriptionOnOpen', () => {
  test('no live subscription is an honest no-op, not an error', async () => {
    installPushGlobals(null);
    stubFetch({});
    const outcome = await reconcilePushSubscriptionOnOpen();
    expect(outcome.drift).toBe('not-subscribed');
    expect(outcome.subscription).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test('no served record for this device reconciles (creates)', async () => {
    installPushGlobals({ endpoint: LIVE_ENDPOINT });
    stubFetch({
      'push.subscriptions.list': { subscriptions: [] },
      'push.subscriptions.reconcile': {
        subscription: { id: 'sub-1', principalId: 'operator', deviceId: KNOWN_DEVICE_ID, endpointOrigin: 'https://push.example.test', endpointHash: 'hash-live', createdAt: 1 },
        drift: 'created',
      },
    });
    const outcome = await reconcilePushSubscriptionOnOpen();
    expect(outcome.drift).toBe('created');
    expect(outcome.subscription?.id).toBe('sub-1');
    expect(calls.map((c) => c.methodId)).toEqual(['push.subscriptions.list', 'push.subscriptions.reconcile']);
    expect(calls[1].body).toEqual({ deviceId: KNOWN_DEVICE_ID, endpoint: LIVE_ENDPOINT, keys: { p256dh: 'p256dh-key', auth: 'auth-key' } });
  });

  test('a served record whose hash already matches the live endpoint reconciles NOTHING', async () => {
    installPushGlobals({ endpoint: LIVE_ENDPOINT });
    const matchingHash = await computeEndpointHash(LIVE_ENDPOINT);
    stubFetch({
      'push.subscriptions.list': {
        subscriptions: [
          { id: 'sub-1', principalId: 'operator', deviceId: KNOWN_DEVICE_ID, endpointOrigin: 'https://push.example.test', endpointHash: matchingHash, createdAt: 1 },
        ],
      },
    });
    const outcome = await reconcilePushSubscriptionOnOpen();
    expect(outcome.drift).toBe('unchanged');
    expect(outcome.subscription?.id).toBe('sub-1');
    // The read happened, but no reconcile write, a healthy device costs nothing.
    expect(calls.map((c) => c.methodId)).toEqual(['push.subscriptions.list']);
  });

  test('a served record with a genuinely different endpoint hash (drift) reconciles', async () => {
    installPushGlobals({ endpoint: LIVE_ENDPOINT });
    const staleHash = await computeEndpointHash(STALE_ENDPOINT);
    stubFetch({
      'push.subscriptions.list': {
        subscriptions: [
          { id: 'sub-1', principalId: 'operator', deviceId: KNOWN_DEVICE_ID, endpointOrigin: 'https://push.example.test', endpointHash: staleHash, createdAt: 1 },
        ],
      },
      'push.subscriptions.reconcile': {
        subscription: { id: 'sub-1', principalId: 'operator', deviceId: KNOWN_DEVICE_ID, endpointOrigin: 'https://push.example.test', endpointHash: 'hash-healed', createdAt: 1 },
        drift: 'endpoint-updated',
      },
    });
    const outcome = await reconcilePushSubscriptionOnOpen();
    expect(outcome.drift).toBe('endpoint-updated');
    expect(calls.map((c) => c.methodId)).toEqual(['push.subscriptions.list', 'push.subscriptions.reconcile']);
  });

  test('a device with no server record for its id but OTHER devices present still reconciles (does not confuse another device for itself)', async () => {
    installPushGlobals({ endpoint: LIVE_ENDPOINT });
    stubFetch({
      'push.subscriptions.list': {
        subscriptions: [
          { id: 'sub-other', principalId: 'operator', deviceId: 'some-other-device', endpointOrigin: 'https://push.example.test', endpointHash: 'irrelevant', createdAt: 1 },
        ],
      },
      'push.subscriptions.reconcile': {
        subscription: { id: 'sub-new', principalId: 'operator', deviceId: KNOWN_DEVICE_ID, endpointOrigin: 'https://push.example.test', endpointHash: 'hash-new', createdAt: 2 },
        drift: 'created',
      },
    });
    const outcome = await reconcilePushSubscriptionOnOpen();
    expect(outcome.drift).toBe('created');
    expect(outcome.subscription?.id).toBe('sub-new');
  });
});
