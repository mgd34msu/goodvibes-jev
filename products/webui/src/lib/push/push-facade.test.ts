/**
 * Pins the sdk.operator.push facade group to the generic invoke-by-id wire
 * shape (the push verbs are ws-only with no REST binding, exactly like the
 * fleet and checkpoints verbs), mirroring the fleet/checkpoints tests in
 * goodvibes.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { sdk } from '../goodvibes';

describe('sdk.operator.push: generic invoke-by-id', () => {
  const originalFetch = globalThis.fetch;
  let calls: { url: string; method: string; body: unknown }[];

  function stubFetch(responseBody: unknown, status = 200): void {
    calls = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return new Response(JSON.stringify(responseBody), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('vapidKey POSTs push.vapid.get with an empty body envelope', async () => {
    stubFetch({ publicKey: 'BExampleKey' });
    const result = await sdk.operator.push.vapidKey();
    expect(calls[0].url).toContain('/api/control-plane/methods/push.vapid.get/invoke');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ body: {} });
    expect(result.publicKey).toBe('BExampleKey');
  });

  test('subscribe forwards endpoint + keys inside the body envelope', async () => {
    stubFetch({ subscription: { id: 'sub-1', principalId: 'operator', endpointOrigin: 'https://push.example', endpointHash: 'abc123', createdAt: 1 } });
    const payload = { endpoint: 'https://push.example/xyz', keys: { p256dh: 'p', auth: 'a' } };
    const result = await sdk.operator.push.subscribe(payload);
    expect(calls[0].url).toContain('/api/control-plane/methods/push.subscriptions.create/invoke');
    expect(calls[0].body).toEqual({ body: payload });
    expect(result.subscription.id).toBe('sub-1');
    // The redacted view carries no capability URL or key material.
    expect(result.subscription).not.toHaveProperty('endpoint');
    expect(result.subscription).not.toHaveProperty('keys');
  });

  test('list POSTs push.subscriptions.list with an empty body envelope', async () => {
    stubFetch({ subscriptions: [] });
    await sdk.operator.push.list();
    expect(calls[0].url).toContain('/api/control-plane/methods/push.subscriptions.list/invoke');
    expect(calls[0].body).toEqual({ body: {} });
  });

  test('unsubscribe forwards the subscriptionId', async () => {
    stubFetch({ subscriptionId: 'sub-1', deleted: true });
    const result = await sdk.operator.push.unsubscribe('sub-1');
    expect(calls[0].url).toContain('/api/control-plane/methods/push.subscriptions.delete/invoke');
    expect(calls[0].body).toEqual({ body: { subscriptionId: 'sub-1' } });
    expect(result.deleted).toBe(true);
  });

  test('verify forwards the subscriptionId and returns the honest receipt', async () => {
    stubFetch({ receipt: { subscriptionId: 'sub-1', endpointOrigin: 'https://push.example', outcome: 'delivered' } });
    const result = await sdk.operator.push.verify('sub-1');
    expect(calls[0].url).toContain('/api/control-plane/methods/push.subscriptions.verify/invoke');
    expect(calls[0].body).toEqual({ body: { subscriptionId: 'sub-1' } });
    expect(result.receipt.outcome).toBe('delivered');
  });

  test('an unknown subscription id surfaces the daemon 404, never a silent success', async () => {
    stubFetch({ error: 'Subscription not found', code: 'SUBSCRIPTION_NOT_FOUND' }, 404);
    let caught: unknown;
    try {
      await sdk.operator.push.verify('ghost');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { status?: number }).status).toBe(404);
  });
});
