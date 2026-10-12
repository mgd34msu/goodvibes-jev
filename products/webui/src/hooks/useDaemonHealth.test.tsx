import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useDaemonHealth } from './useDaemonHealth';
import { sdk } from '../lib/goodvibes';
import { invalidateClientLifetime, RELAY_PAIRING_STORAGE_KEY } from '../lib/client-lifetime';
import { closeRelayClient, setActiveRoute } from '../lib/relay-connection';
import { activityPhrase } from '../components/shell/AccountMenu';
import { nativeRequestPrimitives } from '../test-setup';

const cleanups: (() => void | Promise<void>)[] = [];
const nativeResponse = nativeRequestPrimitives.Response;
const nativeFetch = nativeRequestPrimitives.fetch;
const domRequestPrimitives = {
  Request: globalThis.Request,
  Headers: globalThis.Headers,
  AbortController: globalThis.AbortController,
  AbortSignal: globalThis.AbortSignal,
};

async function until(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 4_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise<void>(resolve => setImmediate(resolve));
    flushSync(() => {});
  }
}

interface Arrival {
  readonly request: Request;
  readonly reply: (response: Response) => void;
  replied: boolean;
  aborted: boolean;
  source: ReadableStreamDefaultController<Uint8Array> | null;
}

// This is an owned HTTP source for the actual shipped SDK, not a fake event bus.
// It emits comments only. A successful socket or reconnect cannot make health active.
function sourceEndpoint() {
  const arrivals: Arrival[] = [];
  const clientSignals: (AbortSignal | null | undefined)[] = [];
  const completedErrorResponses: number[] = [];
  const settledRequests: number[] = [];
  const originalFetch = globalThis.fetch;
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method !== 'GET' || url.pathname !== '/api/control-plane/events' || url.searchParams.get('domains') !== 'turn') {
        return new nativeResponse('Unknown authored source route', { status: 404 });
      }
      return new Promise<Response>(resolve => {
        const arrival: Arrival = {
          request, replied: false, aborted: false, source: null,
          reply(response) {
            if (arrival.replied) throw new Error('Authored source response already settled');
            arrival.replied = true; resolve(response);
          },
        };
        arrivals.push(arrival);
        request.signal.addEventListener('abort', () => {
          arrival.aborted = true;
          if (!arrival.replied) arrival.reply(new nativeResponse('Owned source request cancelled', { status: 499 }));
        }, { once: true });
      });
    },
  });
  globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
    const originalUrl = new URL(input instanceof Request ? input.url : String(input));
    expect(originalUrl.pathname).toBe('/api/control-plane/events');
    expect(originalUrl.searchParams.get('domains')).toBe('turn');
    const requestIndex = clientSignals.length;
    clientSignals.push(init?.signal);
    const target = new URL(originalUrl.pathname + originalUrl.search, 'http://127.0.0.1:' + server.port);
    const pending = nativeFetch(target, init);
    void pending.then(() => settledRequests.push(requestIndex), () => settledRequests.push(requestIndex));
    void pending.then(async response => {
      if (response.status >= 400) {
        await response.clone().text(); completedErrorResponses.push(response.status);
      }
    }).catch(() => {});
    return pending;
  }, { preconnect: (...args: Parameters<typeof fetch.preconnect>) => nativeFetch.preconnect(...args) });
  cleanups.push(async () => {
    globalThis.fetch = originalFetch;
    for (const arrival of arrivals) {
      if (!arrival.replied) arrival.reply(new nativeResponse('Owned source shutting down', { status: 503 }));
      if (arrival.source) { arrival.source.close(); arrival.source = null; }
    }
    await server.stop(true);
  });
  function get(index: number) {
    const arrival = arrivals[index];
    if (!arrival) throw new Error('Native source request not acquired');
    return arrival;
  }
  function open(index: number) {
    const arrival = get(index);
    const body = new ReadableStream<Uint8Array>({
      start(controller) { arrival.source = controller; controller.enqueue(new TextEncoder().encode(': owned source ready\n\n')); },
      cancel() { arrival.source = null; },
    });
    arrival.reply(new nativeResponse(body, { headers: { 'Content-Type': 'text/event-stream' } }));
  }
  function end(index: number) {
    const arrival = get(index);
    if (!arrival.source) throw new Error('Owned source is not open');
    arrival.source.close(); arrival.source = null;
  }
  return { arrivals, clientSignals, completedErrorResponses, settledRequests, get, open, end };
}

function renderHealth() {
  // The health stream stays real; unrelated polling is disabled by this query owner.
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, gcTime: 0 } } });
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  let mounted = true;
  function Probe() {
    const health = useDaemonHealth();
    return <output data-sse={health.sse}>{activityPhrase(health)}</output>;
  }
  flushSync(() => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
  const unmount = () => {
    if (!mounted) return;
    mounted = false; flushSync(() => root.unmount()); container.remove(); client.clear();
  };
  cleanups.push(unmount);
  return { unmount, state: () => container.querySelector('output')?.getAttribute('data-sse'), text: () => container.textContent };
}

beforeEach(() => {
  // Preserve actual platform Request/signal behavior at the network seam while
  // Happy DOM continues to own the rendered document and React lifecycle.
  Object.assign(globalThis, {
    Request: nativeRequestPrimitives.Request,
    Headers: nativeRequestPrimitives.Headers,
    AbortController: nativeRequestPrimitives.AbortController,
    AbortSignal: nativeRequestPrimitives.AbortSignal,
  });
  window.localStorage.removeItem(RELAY_PAIRING_STORAGE_KEY);
  closeRelayClient(); setActiveRoute('direct'); sdk.auth.clearToken();
});
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    closeRelayClient(); setActiveRoute('direct'); sdk.auth.clearToken();
    Object.assign(globalThis, domRequestPrimitives);
  }
});

describe('health consumes the actual SDK source error and owner lifetime', () => {
  test('an asynchronously closed native source pauses health and the real SDK reconnects without inventing active events', async () => {
    const endpoint = sourceEndpoint(); const health = renderHealth();
    await until(() => endpoint.arrivals.length === 1, 'Initial native SSE request did not arrive');
    endpoint.open(0); expect(health.state()).toBe('connecting');
    endpoint.end(0);
    await until(() => health.state() === 'error', 'Asynchronous native source failure did not pause health');
    expect(health.text()).toContain('live updates paused');
    await until(() => endpoint.arrivals.length === 2, 'The SDK did not perform its original reconnect');
    endpoint.open(1); expect(health.state()).toBe('error');
    expect(health.text()).not.toContain('live updates on');
  }, 10_000);

  test('a same-route native client retirement ignores the old transport error before adopting current source errors', async () => {
    const endpoint = sourceEndpoint(); const retiredErrors: unknown[] = []; const currentErrors: unknown[] = [];
    const retired = sdk.realtime.viaSse({ onError: error => retiredErrors.push(error) });
    cleanups.push(retired.turn.onEnvelope('TURN_STARTED', () => {}));
    await until(() => endpoint.arrivals.length === 1, 'Retired native source was not acquired');
    closeRelayClient(); // The actual pool retires its client/lifetime even when route stays direct.
    const current = sdk.realtime.viaSse({ onError: error => currentErrors.push(error) });
    cleanups.push(current.turn.onEnvelope('TURN_STARTED', () => {}));
    await until(() => endpoint.arrivals.length === 2, 'Replacement native source was not acquired');
    endpoint.get(0).reply(new nativeResponse('Retired source unavailable', { status: 503 }));
    await until(() => endpoint.completedErrorResponses.length === 1, 'Actual retired HTTP failure body did not complete');
    expect(retiredErrors).toEqual([]); expect(currentErrors).toEqual([]);
    endpoint.get(1).reply(new nativeResponse('Current source unavailable', { status: 503 }));
    await until(() => currentErrors.length > 0, 'Actual current HTTP failure did not reach its source callback');
    expect(currentErrors[0]).toBeInstanceOf(Error); expect(retiredErrors).toEqual([]);
  }, 10_000);

  test('mutable facade options cannot hide a current source failure behind another caller signal or callback', async () => {
    const endpoint = sourceEndpoint(); const original = new AbortController(); const other = new AbortController();
    const originalErrors: unknown[] = []; const replacedErrors: unknown[] = [];
    const options = { signal: original.signal, onError: (error: unknown) => originalErrors.push(error) };
    const events = sdk.realtime.viaSse(options);
    cleanups.push(events.turn.onEnvelope('TURN_STARTED', () => {}));
    await until(() => endpoint.arrivals.length === 1, 'Original facade native source did not arrive');
    options.signal = other.signal;
    options.onError = error => replacedErrors.push(error);
    other.abort();
    expect(original.signal.aborted).toBe(false);
    expect(endpoint.clientSignals[0]?.aborted).toBe(false);
    endpoint.get(0).reply(new nativeResponse('Current original source unavailable', { status: 503 }));
    await until(() => originalErrors.length === 1, 'Mutable options retargeted or hid the original current source failure');
    expect(originalErrors[0]).toBeInstanceOf(Error);
    expect(replacedErrors).toEqual([]);
    expect(original.signal.aborted).toBe(false);
  }, 10_000);

  test('same-route lifetime replacement drains the pending source without pausing its replacement', async () => {
    const endpoint = sourceEndpoint(); const health = renderHealth();
    await until(() => endpoint.arrivals.length === 1, 'Initial native request did not arrive');
    flushSync(() => invalidateClientLifetime());
    await until(() => endpoint.arrivals.length === 2, 'Same-route lifetime replacement did not open a fresh source');
    await until(() => endpoint.clientSignals[0]?.aborted === true
      && endpoint.get(0).aborted && endpoint.settledRequests.includes(0), 'Retired pending native source did not abort and drain');
    endpoint.open(1);
    expect(endpoint.clientSignals[1]?.aborted).toBe(false);
    expect(health.state()).toBe('connecting');
    expect(health.text()).not.toContain('live updates paused');
    endpoint.end(1);
    await until(() => health.state() === 'error', 'Current replacement failure did not pause its owning hook');
  }, 10_000);

  test('unmount aborts and drains the held first native response while a replacement owner stays live', async () => {
    const endpoint = sourceEndpoint(); const original = renderHealth();
    await until(() => endpoint.arrivals.length === 1, 'Held initial native request did not arrive');
    expect(endpoint.get(0).replied).toBe(false);
    expect(endpoint.clientSignals[0]?.aborted).toBe(false);
    original.unmount();
    await until(() => endpoint.clientSignals[0]?.aborted === true
      && endpoint.get(0).aborted && endpoint.settledRequests.includes(0), 'Unmount did not abort and drain the held native request');
    const replacement = renderHealth();
    await until(() => endpoint.arrivals.length === 2, 'Replacement owner did not acquire a new native request');
    expect(endpoint.clientSignals[1]?.aborted).toBe(false);
    expect(endpoint.get(1).aborted).toBe(false);
    endpoint.open(1);
    expect(replacement.state()).toBe('connecting');
    expect(replacement.text()).not.toContain('live updates paused');
    endpoint.end(1);
    await until(() => replacement.state() === 'error', 'Replacement owner no longer observed its genuine source failure');
  }, 10_000);

  test('an actual current response-body AbortError pauses health when its caller has not cancelled', async () => {
    // HTTP cannot preserve a peer's local error class. This native Response body
    // supplies the exact reader failure through the real SDK FetchLike seam.
    const originalFetch = globalThis.fetch;
    const sources: { controller: ReadableStreamDefaultController<Uint8Array>; failed: boolean }[] = [];
    const requestSignals: (AbortSignal | null | undefined)[] = [];
    globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.pathname).toBe('/api/control-plane/events');
      expect(url.searchParams.get('domains')).toBe('turn');
      requestSignals.push(init?.signal);
      const body = new ReadableStream<Uint8Array>({
        start(controller) { sources.push({ controller, failed: false }); },
      });
      return Promise.resolve(new nativeResponse(body, { headers: { 'Content-Type': 'text/event-stream' } }));
    }, { preconnect: (...args: Parameters<typeof fetch.preconnect>) => nativeFetch.preconnect(...args) });
    cleanups.push(() => {
      globalThis.fetch = originalFetch;
      for (const source of sources) {
        if (!source.failed) { source.failed = true; source.controller.close(); }
      }
    });
    const health = renderHealth();
    await until(() => sources.length === 1, 'The real SDK did not acquire its authored native body');
    await new Promise<void>(resolve => setImmediate(resolve));
    const source = sources[0];
    if (!source) throw new Error('Native body source missing');
    expect(requestSignals[0]?.aborted).toBe(false);
    source.failed = true;
    source.controller.error(new DOMException('Authored current source read failed', 'AbortError'));
    await until(() => health.state() === 'error', 'Current body AbortError was mistaken for caller cancellation');
    expect(health.text()).toContain('live updates paused');
    expect(health.text()).not.toContain('live updates on');
  }, 10_000);

  test('unmount aborts the acquired native stream without pausing a newly mounted health owner', async () => {
    const endpoint = sourceEndpoint(); const original = renderHealth();
    await until(() => endpoint.arrivals.length === 1, 'Original native source did not arrive'); endpoint.open(0);
    // Wait for ready to install the native closer before exercising caller cleanup.
    await until(() => endpoint.get(0).source !== null, 'Original source is not open');
    await new Promise<void>(resolve => setImmediate(resolve));
    original.unmount();
    await until(() => endpoint.clientSignals[0]?.aborted === true, 'Unsubscribe did not abort the native stream request');
    const replacement = renderHealth();
    await until(() => endpoint.arrivals.length === 2, 'New health owner did not acquire its native stream'); endpoint.open(1);
    expect(replacement.state()).toBe('connecting');
    expect(replacement.text()).not.toContain('live updates paused');
  }, 10_000);
});
