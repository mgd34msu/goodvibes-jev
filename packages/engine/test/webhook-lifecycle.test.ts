/** Deterministic close/drain ownership regressions for WebhookNotifier (THE-92). */
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { createHmac } from 'node:crypto';
import { WebhookNotifier, type WebhookNotifierOptions } from '../sdk/src/platform/integrations/webhooks.ts';
import * as http from '../sdk/src/platform/utils/fetch-with-timeout.ts';
import { logger } from '../sdk/src/platform/utils/logger.ts';
import { RuntimeEventBus, createEventEnvelope } from '../sdk/src/platform/runtime/events/index.ts';
import type { NotificationDelivery } from '../sdk/src/platform/runtime/turn-notification.ts';
import { withTestTimeout } from './_helpers/test-timeout.ts';

const URLS = ['https://example.com/close-a', 'https://example.com/close-b', 'https://example.com/close-c'];
const CLOSED = 'WebhookNotifier: closed';
const PRIVATE = 'synthetic-private-lifecycle-marker';
const turn = (): NotificationDelivery => ({ kind: 'turn', facts: {
  outcome: 'failed', elapsedMs: 1000, name: PRIVATE, reason: PRIVATE,
} });

let fetchSpy: Mock<typeof http.instrumentedFetch>;
let notifiers: WebhookNotifier[];
let releases: Array<() => void>;
let restorers: Array<() => void>;

function gate<T = void>(cleanupValue: T = undefined as T) {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((ok) => { resolve = ok; });
  releases.push(() => resolve(cleanupValue));
  return { promise, resolve };
}
function notifier(urls = URLS, options: WebhookNotifierOptions = {}) {
  const value = new WebhookNotifier(urls, { force: true, metadataOnly: () => false, ...options });
  notifiers.push(value);
  return value;
}
function observe<T>(promise: Promise<T>) {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  return () => settled;
}
function flush(): Promise<void> { return new Promise((resolve) => setImmediate(resolve)); }
function bodyResponse(status: number, cancel: () => Promise<void>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: { cancel },
    text: () => { throw new Error('Response text must never be read'); },
  } as unknown as Response;
}
function closedResults(urls = URLS) { return urls.map((url) => ({ url, ok: false, error: CLOSED })); }

/** Keep callbacks after unsubscription to model callbacks already snapshotted by a bus. */
function capturedBus(onRegister?: (index: number) => void, onUnsubscribe?: (index: number) => void) {
  type Callback = (event: { readonly payload: unknown }) => void;
  const callbacks = new Map<string, Callback>();
  const active = new Set<string>();
  const removed: number[] = [];
  let registrations = 0;
  const bus = {
    on(type: string, callback: Callback) {
      const index = ++registrations;
      callbacks.set(type, callback);
      active.add(type);
      onRegister?.(index);
      return () => { removed.push(index); active.delete(type); onUnsubscribe?.(index); };
    },
  } as unknown as RuntimeEventBus;
  return { bus, callbacks, active, removed, registrations: () => registrations };
}

beforeEach(() => {
  notifiers = [];
  releases = [];
  restorers = [];
  fetchSpy = spyOn(http, 'instrumentedFetch').mockImplementation(async () => new Response('ok'));
});
afterEach(async () => {
  for (const release of releases) release();
  try {
    await withTestTimeout(Promise.all(notifiers.map((value) => value.close())), 5000, 'Lifecycle test cleanup did not drain');
  } finally {
    for (const restore of restorers.reverse()) restore();
    fetchSpy.mockRestore();
  }
});

describe('WebhookNotifier close and admission', () => {
  test('close returns the same promise before and after settlement and async disposal delegates', async () => {
    const value = notifier([]);
    const closing = value.close();
    expect(value.close()).toBe(closing);
    expect(value[Symbol.asyncDispose]()).toBe(closing);
    await closing;
    expect(value.close()).toBe(closing);
    expect(value[Symbol.asyncDispose]()).toBe(closing);
  });

  test('closed send, typed send and connectivity probe return every failed receipt without reading content', async () => {
    let privacyReads = 0;
    let factReads = 0;
    const value = notifier(URLS, { metadataOnly: () => { privacyReads++; return false; } });
    const closing = value.close();
    const hostile = new Proxy({}, { get() { factReads++; throw new Error(PRIVATE); } }) as NotificationDelivery;
    const expected = { attempted: URLS.length, delivered: 0, failed: URLS.length, results: closedResults() };
    expect(await value.send(PRIVATE)).toEqual(expected);
    expect(await value.sendNotification(hostile)).toEqual(expected);
    expect(await value.test()).toEqual(closedResults());
    expect(privacyReads).toBe(0);
    expect(factReads).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    await closing;
  });

  test('close synchronously removes listeners and fences retained callbacks and later attachment', async () => {
    let payloadReads = 0;
    let privacyReads = 0;
    const value = notifier(URLS, { metadataOnly: () => { privacyReads++; return false; } });
    const captured = capturedBus();
    value.attachToRuntimeBus(captured.bus);
    expect(captured.active.size).toBe(5);
    const closing = value.close();
    expect(captured.active.size).toBe(0);
    const event = { get payload() { payloadReads++; throw new Error(PRIVATE); } };
    for (const callback of captured.callbacks.values()) callback(event);
    const later = capturedBus();
    value.attachToRuntimeBus(later.bus);
    expect(later.registrations()).toBe(0);
    await closing;
    await flush();
    expect(payloadReads).toBe(0);
    expect(privacyReads).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(captured.removed).toHaveLength(5);
  });

  test('a close reentered by the privacy reader still owns the admitted send', async () => {
    let closing: Promise<void> | undefined;
    const value = notifier(URLS, { metadataOnly: () => {
      closing ??= value.close();
      return false;
    } });
    const sending = value.send('hello');
    expect(closing).toBe(value.close());
    const sendSettled = observe(sending);
    await withTestTimeout(closing!, 5000, 'Reentrant privacy-reader close did not drain');
    expect(sendSettled()).toBe(true);
    expect(await sending).toEqual({ attempted: URLS.length, delivered: 0, failed: URLS.length, results: closedResults() });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  for (const closingRead of [2, 3]) {
    test(`close from privacy read ${closingRead} fences the prepare/current boundary`, async () => {
      let reads = 0;
      let closing: Promise<void> | undefined;
      const value = notifier(URLS, { maxConcurrent: 1, metadataOnly: () => {
        reads++;
        if (reads === closingRead) closing = value.close();
        return false;
      } });
      const sending = value.send('hello');
      expect(closing).toBe(value.close());
      await withTestTimeout(closing!, 5000, 'Preparation-boundary close did not drain');
      expect(await sending).toEqual({ attempted: URLS.length, delivered: 0, failed: URLS.length, results: closedResults() });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  test('a real bus callback queued before close cannot admit content after close', async () => {
    let payloadReads = 0;
    const value = notifier([URLS[0]!]);
    const bus = new RuntimeEventBus();
    value.attachToRuntimeBus(bus);
    const event = createEventEnvelope('AGENT_FAILED', {
      type: 'AGENT_FAILED' as const, agentId: 'fixture-agent', error: PRIVATE, durationMs: 10,
    }, { sessionId: 'fixture-session', source: 'webhook-lifecycle-test' });
    bus.emit('agents', { ...event, get payload() { payloadReads++; return event.payload; } });
    await value.close();
    await flush();
    expect(payloadReads).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('a rejecting runtime formatter is owned through its sanitized dispatch diagnostic', async () => {
    let closing: Promise<void> | undefined;
    const diagnostics: unknown[] = [];
    const logSpy = spyOn(logger, 'warn').mockImplementation((message, detail) => {
      if (message === 'WebhookNotifier: runtime event notification dispatch failed') diagnostics.push(detail);
    });
    restorers.push(() => logSpy.mockRestore());
    const value = notifier([URLS[0]!]);
    const captured = capturedBus();
    value.attachToRuntimeBus(captured.bus);
    captured.callbacks.get('AGENT_FAILED')!({ get payload() {
      closing = value.close();
      throw new Error(PRIVATE);
    } });
    expect(closing).toBe(value.close());
    await withTestTimeout(closing!, 5000, 'Runtime formatter rejection did not drain');
    expect(diagnostics).toEqual([{ error: 'Delivery failed' }]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('detach only removes subscriptions: it neither aborts an admitted send nor closes future sends', async () => {
    const response = gate<Response>(new Response('cleanup'));
    const started = gate();
    let signal: AbortSignal | null | undefined;
    fetchSpy.mockImplementationOnce(async (_url, init) => { signal = init?.signal; started.resolve(); return response.promise; });
    const value = notifier([URLS[0]!]);
    const captured = capturedBus();
    value.attachToRuntimeBus(captured.bus);
    const sending = value.send('first');
    await started.promise;
    value.detach();
    expect(captured.active.size).toBe(0);
    expect(signal?.aborted).toBe(false);
    response.resolve(new Response('ok'));
    expect((await sending).delivered).toBe(1);
    expect((await value.send('second')).delivered).toBe(1);
    const later = capturedBus();
    value.attachToRuntimeBus(later.bus);
    expect(later.active.size).toBe(5);
  });
});

describe('WebhookNotifier admitted work ownership', () => {
  test('close aborts in-flight fetch, skips queued recipients and settles the complete fanout receipt', async () => {
    const started = gate();
    let signal: AbortSignal | null | undefined;
    fetchSpy.mockImplementation((_url, init) => new Promise<Response>((_resolve, reject) => {
      signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal?.reason), { once: true });
      started.resolve();
    }));
    const value = notifier(URLS, { maxConcurrent: 1 });
    const sending = value.send(PRIVATE);
    await started.promise;
    const closing = value.close();
    expect(signal?.aborted).toBe(true);
    const receipt = await withTestTimeout(sending, 5000, 'Aborted fanout did not settle');
    await closing;
    expect(receipt.attempted).toBe(URLS.length);
    expect(receipt.delivered).toBe(0);
    expect(receipt.failed).toBe(URLS.length);
    expect(receipt.results.slice(1)).toEqual(closedResults(URLS.slice(1)));
    expect(JSON.stringify(receipt)).not.toContain(PRIVATE);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('close waits honestly for a fetch that ignores its already-aborted signal', async () => {
    const response = gate<Response>(new Response('cleanup'));
    const started = gate();
    let signal: AbortSignal | null | undefined;
    fetchSpy.mockImplementation(async (_url, init) => { signal = init?.signal; started.resolve(); return response.promise; });
    const value = notifier([URLS[0]!]);
    const sending = value.send(PRIVATE);
    await started.promise;
    const closing = value.close();
    const sendSettled = observe(sending);
    const closeSettled = observe(closing);
    await flush();
    expect(signal?.aborted).toBe(true);
    expect(sendSettled()).toBe(false);
    expect(closeSettled()).toBe(false);
    response.resolve(new Response('ok'));
    await withTestTimeout(closing, 5000, 'Ignoring-abort fetch was not drained');
    expect(sendSettled()).toBe(true);
    expect((await sending).attempted).toBe(1);
  });

  test('two concurrent sends remain owned until both fetches have settled', async () => {
    const responses = [gate<Response>(new Response('cleanup')), gate<Response>(new Response('cleanup'))];
    const started = gate();
    const signals: AbortSignal[] = [];
    fetchSpy.mockImplementation(async (_url, init) => {
      const index = signals.length;
      signals.push(init!.signal!);
      if (signals.length === 2) started.resolve();
      return responses[index]!.promise;
    });
    const value = notifier([URLS[0]!]);
    const first = value.send('first');
    const second = value.sendNotification(turn());
    await started.promise;
    const closing = value.close();
    const closeSettled = observe(closing);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    responses[0]!.resolve(new Response('ok'));
    await first;
    await flush();
    expect(closeSettled()).toBe(false);
    responses[1]!.resolve(new Response('ok'));
    await withTestTimeout(closing, 5000, 'Second concurrent send was not drained');
    expect((await second).attempted).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  for (const kind of ['send', 'typed', 'probe', 'runtime'] as const) {
    for (const status of [200, 503]) {
      test(`${kind} drains a ${status} response's body cancellation before close resolves`, async () => {
        const response = gate<Response>(new Response('cleanup'));
        const started = gate();
        const cancelling = gate();
        const cancellation = gate();
        let cancelled = 0;
        fetchSpy.mockImplementation(async () => { started.resolve(); return response.promise; });
        const value = notifier([URLS[0]!]);
        let sending: Promise<unknown> | undefined;
        if (kind === 'send') sending = value.send(PRIVATE);
        else if (kind === 'typed') sending = value.sendNotification(turn());
        else if (kind === 'probe') sending = value.test();
        else {
          const captured = capturedBus();
          value.attachToRuntimeBus(captured.bus);
          captured.callbacks.get('AGENT_FAILED')!({ payload: { agentId: 'fixture-agent', error: PRIVATE } });
        }
        await started.promise;
        const closing = value.close();
        const closeSettled = observe(closing);
        response.resolve(bodyResponse(status, async () => { cancelled++; cancelling.resolve(); await cancellation.promise; }));
        await withTestTimeout(cancelling.promise, 5000, 'Response body was not cancelled');
        await flush();
        expect(cancelled).toBe(1);
        expect(closeSettled()).toBe(false);
        cancellation.resolve();
        await withTestTimeout(closing, 5000, 'Response body cancellation was not drained');
        if (sending) {
          const receipt = await sending;
          expect(JSON.stringify(receipt)).not.toContain(PRIVATE);
          if (status === 503) expect(JSON.stringify(receipt)).toContain('503');
        }
      });
    }
  }

  test('reentrant close during body.cancel returns the already-published shared promise', async () => {
    const started = gate();
    const response = gate<Response>(new Response('cleanup'));
    let innerClose: Promise<void> | undefined;
    const value = notifier([URLS[0]!]);
    fetchSpy.mockImplementation(async () => { started.resolve(); return response.promise; });
    const sending = value.send('hello');
    await started.promise;
    const closing = value.close();
    response.resolve(bodyResponse(200, async () => { innerClose = value.close(); }));
    await withTestTimeout(closing, 5000, 'Reentrant close did not drain');
    await sending;
    expect(innerClose).toBe(closing);
  });

  test('body cancellation that initiates close is itself included in the drain', async () => {
    const cancellation = gate();
    const cancelling = gate();
    let closing: Promise<void> | undefined;
    const value = notifier([URLS[0]!]);
    fetchSpy.mockImplementation(async () => bodyResponse(200, async () => {
      closing = value.close();
      cancelling.resolve();
      await cancellation.promise;
    }));
    const sending = value.send('hello');
    await withTestTimeout(cancelling.promise, 5000, 'Response cancellation never started');
    expect(closing).toBe(value.close());
    const closeSettled = observe(closing!);
    await flush();
    expect(closeSettled()).toBe(false);
    cancellation.resolve();
    await withTestTimeout(closing!, 5000, 'Reentrant initiating close did not drain');
    await sending;
  });

  test('a rejecting success-body cancellation is observed without leaking or rejecting close', async () => {
    let cancelled = 0;
    const started = gate();
    fetchSpy.mockImplementation(async () => {
      started.resolve();
      return bodyResponse(200, async () => { cancelled++; throw new Error(PRIVATE); });
    });
    const value = notifier([URLS[0]!]);
    const sending = value.send('hello');
    await started.promise;
    await value.close();
    const receipt = await sending;
    expect(cancelled).toBe(1);
    expect(JSON.stringify(receipt)).not.toContain(PRIVATE);
  });

  test('close during held signing drains the signer and forbids all later fetch starts', async () => {
    const started = gate();
    const held = gate();
    const realSign = globalThis.crypto.subtle.sign.bind(globalThis.crypto.subtle);
    const signSpy = spyOn(globalThis.crypto.subtle, 'sign').mockImplementation(async (...args) => {
      started.resolve();
      await held.promise;
      return realSign(...args);
    });
    restorers.push(() => signSpy.mockRestore());
    const value = notifier(URLS, { signingSecret: 'test-lifecycle-secret', maxConcurrent: 1 });
    const sending = value.sendNotification(turn());
    await withTestTimeout(started.promise, 5000, 'Signing did not start');
    const closing = value.close();
    const closeSettled = observe(closing);
    await flush();
    expect(closeSettled()).toBe(false);
    held.resolve();
    await withTestTimeout(closing, 5000, 'Held signer did not drain');
    expect(await sending).toEqual({ attempted: URLS.length, delivered: 0, failed: URLS.length, results: closedResults() });
    expect(signSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('timeout during held signing forbids a late fetch after the signer settles', async () => {
    const started = gate();
    const held = gate();
    const timeoutMs = 43_210;
    let expire: (() => void) | undefined;
    const realSetTimeout = globalThis.setTimeout;
    const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay === timeoutMs && typeof handler === 'function') expire = () => handler(...args);
      return realSetTimeout(handler, delay, ...args);
    }) as typeof setTimeout);
    const realSign = globalThis.crypto.subtle.sign.bind(globalThis.crypto.subtle);
    const signSpy = spyOn(globalThis.crypto.subtle, 'sign').mockImplementation(async (...args) => {
      started.resolve(); await held.promise; return realSign(...args);
    });
    restorers.push(() => { timerSpy.mockRestore(); signSpy.mockRestore(); });
    const value = notifier([URLS[0]!], { signingSecret: 'test-lifecycle-secret', timeoutMs });
    const sending = value.send('hello');
    await withTestTimeout(started.promise, 5000, 'Signing did not start');
    expect(expire).toBeDefined();
    expire!();
    const sendSettled = observe(sending);
    await flush();
    expect(sendSettled()).toBe(false);
    held.resolve();
    const receipt = await withTestTimeout(sending, 5000, 'Timed-out signer did not settle');
    expect(receipt.attempted).toBe(1);
    expect(receipt.failed).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    await value.close();
  });

  test('owned typed facts and HMAC stay immutable while signing is suspended', async () => {
    const started = gate();
    const held = gate();
    const secret = 'test-lifecycle-secret';
    const realSign = globalThis.crypto.subtle.sign.bind(globalThis.crypto.subtle);
    const signSpy = spyOn(globalThis.crypto.subtle, 'sign').mockImplementation(async (...args) => {
      started.resolve(); await held.promise; return realSign(...args);
    });
    restorers.push(() => signSpy.mockRestore());
    const facts = { outcome: 'failed' as const, elapsedMs: 1000, name: 'Original task', reason: 'Original reason' };
    const value = notifier([URLS[0]!], { signingSecret: secret });
    const sending = value.sendNotification({ kind: 'turn', facts });
    await withTestTimeout(started.promise, 5000, 'Signing did not start');
    facts.name = PRIVATE;
    facts.reason = PRIVATE;
    held.resolve();
    expect((await sending).delivered).toBe(1);
    const init = fetchSpy.mock.calls[0]?.[1];
    const body = String(init?.body);
    const headers = new Headers(init?.headers);
    expect(body).toContain('Original task');
    expect(body).toContain('Original reason');
    expect(body).not.toContain(PRIVATE);
    const timestamp = headers.get('X-GoodVibes-Webhook-Timestamp');
    expect(headers.get('X-GoodVibes-Webhook-Signature')).toBe(`v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`);
  });
});

describe('WebhookNotifier subscription and transport cleanup', () => {
  test('partial runtime registration rolls back every subscription already acquired', () => {
    const value = notifier();
    // The third registration throws before acquiring a subscription.
    const acquired: number[] = [];
    const removed: number[] = [];
    let registrations = 0;
    const bus = { on() {
      const index = ++registrations;
      if (index === 3) throw new Error('registration failed');
      acquired.push(index);
      return () => { removed.push(index); };
    } } as unknown as RuntimeEventBus;
    expect(() => value.attachToRuntimeBus(bus)).toThrow('registration failed');
    expect(acquired).toEqual([1, 2]);
    expect(removed.toSorted()).toEqual([1, 2]);
    value.detach();
    expect(removed).toHaveLength(2);
  });

  test('close called reentrantly by registration removes the just-returned subscription', async () => {
    const value = notifier();
    let innerClose: Promise<void> | undefined;
    const captured = capturedBus((index) => { if (index === 1) innerClose = value.close(); });
    value.attachToRuntimeBus(captured.bus);
    expect(captured.active.size).toBe(0);
    expect(captured.registrations()).toBe(1);
    expect(innerClose).toBe(value.close());
    await innerClose;
  });

  test('detach reentered during registration releases the returned listener and stops attachment', () => {
    const value = notifier();
    const captured = capturedBus((index) => { if (index === 1) value.detach(); });
    value.attachToRuntimeBus(captured.bus);
    expect(captured.active.size).toBe(0);
    expect(captured.registrations()).toBe(1);
  });

  test('a nested attachment during registration keeps only the latest bus subscriptions', () => {
    const value = notifier();
    const latest = capturedBus();
    const previous = capturedBus((index) => { if (index === 1) value.attachToRuntimeBus(latest.bus); });
    value.attachToRuntimeBus(previous.bus);
    expect(previous.active.size).toBe(0);
    expect(previous.registrations()).toBe(1);
    expect(latest.active.size).toBe(5);
    value.detach();
    expect(latest.active.size).toBe(0);
  });

  test('a nested attachment during old-bus cleanup supersedes the interrupted attachment', () => {
    const value = notifier();
    const latest = capturedBus();
    const original = capturedBus(undefined, (index) => {
      if (index === 1) value.attachToRuntimeBus(latest.bus);
    });
    const interrupted = capturedBus();
    value.attachToRuntimeBus(original.bus);
    value.attachToRuntimeBus(interrupted.bus);
    expect(original.active.size).toBe(0);
    expect(latest.active.size).toBe(5);
    expect(interrupted.registrations()).toBe(0);
    value.detach();
    expect(latest.active.size).toBe(0);
  });

  test('a throwing unsubscriber cannot prevent close from releasing remaining listeners', async () => {
    const value = notifier();
    let innerClose: Promise<void> | undefined;
    const captured = capturedBus(undefined, (index) => {
      if (index === 1) { innerClose = value.close(); throw new Error(PRIVATE); }
    });
    value.attachToRuntimeBus(captured.bus);
    const closing = value.close();
    expect(innerClose).toBe(closing);
    expect(captured.active.size).toBe(0);
    expect(captured.removed).toHaveLength(5);
    await closing;
    value.detach();
    expect(captured.removed).toHaveLength(5);
  });

  test('each request clears its owned timeout by terminal cleanup', async () => {
    const response = gate<Response>(new Response('cleanup'));
    const started = gate();
    const cancelling = gate();
    const cancellation = gate();
    const timeoutMs = 54_321;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const cleared: Array<ReturnType<typeof setTimeout>> = [];
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      const handle = realSetTimeout(handler, delay, ...args);
      if (delay === timeoutMs) timers.push(handle);
      return handle;
    }) as typeof setTimeout);
    const clearSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(((handle: ReturnType<typeof setTimeout>) => {
      if (timers.includes(handle)) cleared.push(handle);
      realClearTimeout(handle);
    }) as typeof clearTimeout);
    restorers.push(() => { timerSpy.mockRestore(); clearSpy.mockRestore(); });
    let signal: AbortSignal | null | undefined;
    fetchSpy.mockImplementation(async (_url, init) => { signal = init?.signal; started.resolve(); return response.promise; });
    const value = notifier([URLS[0]!], { timeoutMs });
    const sending = value.send('hello');
    await started.promise;
    const closing = value.close();
    expect(timers).toHaveLength(1);
    expect(signal?.aborted).toBe(true);
    response.resolve(bodyResponse(200, async () => { cancelling.resolve(); await cancellation.promise; }));
    await withTestTimeout(cancelling.promise, 5000, 'Response body cancellation did not start');
    cancellation.resolve();
    await closing;
    await sending;
    expect([...new Set(cleared)]).toEqual(timers);
    expect(value.close()).toBe(closing);
    await value.close();
    expect([...new Set(cleared)]).toEqual(timers);
  });
});
