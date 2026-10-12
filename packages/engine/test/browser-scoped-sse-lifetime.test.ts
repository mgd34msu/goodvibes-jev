import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createBrowserKnowledgeSdk } from '../sdk/dist/browser-knowledge.js';
import { openRawServerSentEventStream } from '@goodvibes-jev/engine/transport-http';
import type { FetchLike } from '@goodvibes-jev/engine/transport-core';

const cleanups: (() => void | Promise<void>)[] = [];
const AUTH = 'authored-owned-sse-source-token';

async function until(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 4_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

interface HeldRequest {
  readonly request: Request;
  readonly reply: (response: Response) => void;
  replied: boolean;
  aborted: boolean;
  source: ReadableStreamDefaultController<Uint8Array> | null;
}

function nativeSource() {
  const arrivals: HeldRequest[] = [];
  const requestSignals: (AbortSignal | null | undefined)[] = [];
  const settledRequests: number[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method !== 'GET' || url.pathname !== '/api/control-plane/events'
        || url.searchParams.get('domains') !== 'turn') {
        return new Response('Unknown authored source route', { status: 404 });
      }
      if (request.headers.get('authorization') !== 'Bearer ' + AUTH) {
        return new Response('Authored source authority absent', { status: 401 });
      }
      return new Promise<Response>(resolve => {
        const held: HeldRequest = {
          request, replied: false, aborted: false, source: null,
          reply(response) {
            if (held.replied) throw new Error('Owned source response already settled');
            held.replied = true; resolve(response);
          },
        };
        arrivals.push(held);
        request.signal.addEventListener('abort', () => {
          held.aborted = true;
          if (!held.replied) held.reply(new Response('Owned source request cancelled', { status: 499 }));
        }, { once: true });
      });
    },
  });
  const fetchImpl: FetchLike = (input, init) => {
    const index = requestSignals.length;
    requestSignals.push(init?.signal);
    const pending = fetch(input, init);
    void pending.then(() => settledRequests.push(index), () => settledRequests.push(index));
    return pending;
  };
  const errors: unknown[] = [];
  const sdk = createBrowserKnowledgeSdk({
    baseUrl: 'http://127.0.0.1:' + server.port,
    authToken: AUTH,
    fetch: fetchImpl,
    realtime: { onError: error => errors.push(error) },
  });
  cleanups.push(async () => {
    for (const held of arrivals) {
      if (!held.replied) held.reply(new Response('Owned source shutting down', { status: 503 }));
      if (held.source) { held.source.close(); held.source = null; }
    }
    await server.stop(true);
  });
  function get(index: number) {
    const held = arrivals[index];
    if (!held) throw new Error('Owned native request missing');
    return held;
  }
  function open(index: number) {
    const held = get(index);
    held.reply(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        held.source = controller;
        controller.enqueue(new TextEncoder().encode(': owned source ready\n\n'));
      },
      cancel() { held.source = null; },
    }), { headers: { 'Content-Type': 'text/event-stream' } }));
  }
  function emitOwnedTurn(index: number) {
    const held = get(index);
    if (!held.source) throw new Error('Owned native event source is not open');
    const envelope = {
      type: 'TURN_SUBMITTED', ts: 1, sessionId: 'owned-synthetic-sse-session',
      payload: { type: 'TURN_SUBMITTED', turnId: 'owned-synthetic-sse-turn' },
    };
    held.source.enqueue(new TextEncoder().encode('event: turn\ndata: ' + JSON.stringify(envelope) + '\n\n'));
  }
  return { sdk, arrivals, requestSignals, settledRequests, errors, get, open, emitOwnedTurn };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('scoped SSE owns initial acquisition and caller cancellation', () => {
  test('only the last listener aborts a held first response, and repeated old cleanup cannot retire the replacement', async () => {
    const source = nativeSource(); const events = source.sdk.realtime.viaSse();
    const first = events.turn.onEnvelope('TURN_STARTED', () => {});
    const last = events.turn.onEnvelope('TURN_COMPLETED', () => {});
    cleanups.push(first, last);
    await until(() => source.arrivals.length === 1, 'Initial native source did not arrive');
    expect(source.get(0).replied).toBe(false);
    first();
    expect(source.requestSignals[0]?.aborted).toBe(false);
    expect(source.get(0).aborted).toBe(false);
    last();
    await until(() => source.requestSignals[0]?.aborted === true
      && source.get(0).aborted && source.settledRequests.includes(0), 'Last listener did not abort and drain initial native acquisition');
    const replacement = events.turn.onEnvelope('TURN_STARTED', () => {});
    cleanups.push(replacement);
    await until(() => source.arrivals.length === 2, 'Same bus replacement did not acquire its own source');
    first(); last();
    expect(source.requestSignals[1]?.aborted).toBe(false);
    expect(source.get(1).aborted).toBe(false);
    source.open(1);
    expect(source.errors).toEqual([]);
  }, 10_000);

  test('caller cancellation aborts only its own held event bus while an unrelated subscription stays live', async () => {
    const source = nativeSource(); const owner = new AbortController();
    const owned = source.sdk.realtime.viaSse({ signal: owner.signal });
    cleanups.push(owned.turn.onEnvelope('TURN_STARTED', () => {}));
    await until(() => source.arrivals.length === 1, 'Caller-owned request did not arrive');
    const unrelated = source.sdk.realtime.viaSse();
    cleanups.push(unrelated.turn.onEnvelope('TURN_STARTED', () => {}));
    await until(() => source.arrivals.length === 2, 'Unrelated request did not arrive');
    owner.abort();
    await until(() => source.requestSignals[0]?.aborted === true
      && source.get(0).aborted && source.settledRequests.includes(0), 'Caller abort did not drain its held native source');
    expect(source.requestSignals[1]?.aborted).toBe(false);
    expect(source.get(1).aborted).toBe(false);
    source.open(1);
    expect(source.errors).toEqual([]);
  }, 10_000);

  test('mutable invocation options cannot retarget the original signal listener or retire an unrelated owner', async () => {
    const source = nativeSource(); const original = new AbortController(); const unrelated = new AbortController();
    const removeOriginal = spyOn(original.signal, 'removeEventListener');
    cleanups.push(() => removeOriginal.mockRestore());
    const options = { signal: original.signal };
    const events = source.sdk.realtime.viaSse(options);
    const closeOriginal = events.turn.onEnvelope('TURN_STARTED', () => {});
    cleanups.push(closeOriginal);
    await until(() => source.arrivals.length === 1, 'Original option-bound native source did not arrive');
    options.signal = unrelated.signal;
    const current = source.sdk.realtime.viaSse({ signal: unrelated.signal });
    cleanups.push(current.turn.onEnvelope('TURN_STARTED', () => {}));
    await until(() => source.arrivals.length === 2, 'Unrelated native owner did not arrive');
    closeOriginal();
    await until(() => source.requestSignals[0]?.aborted === true
      && source.get(0).aborted && source.settledRequests.includes(0), 'Original option-bound source did not drain');
    expect(removeOriginal).toHaveBeenCalledTimes(1);
    expect(removeOriginal.mock.calls[0]?.[0]).toBe('abort');
    expect(source.requestSignals[1]?.aborted).toBe(false);
    expect(unrelated.signal.aborted).toBe(false);
    source.open(1);
    expect(source.errors).toEqual([]);
  }, 10_000);

  test('a callback that retires its owner prevents later callbacks from the same native frame', async () => {
    const source = nativeSource(); const owner = new AbortController(); const calls: string[] = [];
    const events = source.sdk.realtime.viaSse({ signal: owner.signal });
    const first = events.turn.onEnvelope('TURN_SUBMITTED', () => { calls.push('first'); owner.abort(); });
    const second = events.turn.onEnvelope('TURN_SUBMITTED', () => calls.push('retired second'));
    cleanups.push(first, second);
    await until(() => source.arrivals.length === 1, 'Original native event source did not arrive');
    source.open(0); source.emitOwnedTurn(0);
    await until(() => source.requestSignals[0]?.aborted === true && source.get(0).aborted,
      'The first native callback did not retire its own source');
    expect(calls).toEqual(['first']);
    const replacement = source.sdk.realtime.viaSse();
    cleanups.push(replacement.turn.onEnvelope('TURN_SUBMITTED', () => calls.push('replacement')));
    await until(() => source.arrivals.length === 2, 'Replacement native event source did not arrive');
    source.open(1); first(); second(); source.emitOwnedTurn(1);
    await until(() => calls.includes('replacement'), 'Retired cleanup blocked the real replacement event');
    expect(calls).toEqual(['first', 'replacement']);
    expect(source.requestSignals[1]?.aborted).toBe(false);
    expect(source.errors).toEqual([]);
  }, 10_000);

  test('an already-aborted caller cannot start acquisition or interfere with a live independent owner', async () => {
    const source = nativeSource(); const owner = new AbortController(); owner.abort();
    const cancelled = source.sdk.realtime.viaSse({ signal: owner.signal });
    cleanups.push(cancelled.turn.onEnvelope('TURN_STARTED', () => {}));
    const current = source.sdk.realtime.viaSse();
    cleanups.push(current.turn.onEnvelope('TURN_STARTED', () => {}));
    await until(() => source.arrivals.length === 1, 'Independent owner did not acquire its native source');
    expect(source.requestSignals).toHaveLength(1);
    expect(source.requestSignals[0]?.aborted).toBe(false);
    source.open(0);
    expect(source.errors).toEqual([]);
  }, 10_000);
});

function currentBody() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const fetchImpl: FetchLike = () => Promise.resolve(new Response(body, {
    headers: { 'Content-Type': 'text/event-stream' },
  }));
  function fail(error: unknown) {
    if (!controller) throw new Error('Authored native body missing');
    controller.error(error);
  }
  return { fetchImpl, fail };
}

describe('SSE distinguishes actual owner cancellation from a source error name', () => {
  test('a live source body AbortError reaches onError unchanged when the caller remains current', async () => {
    const source = currentBody(); const owner = new AbortController(); const errors: unknown[] = [];
    const close = await openRawServerSentEventStream(source.fetchImpl, 'http://owned-source.test/events', {
      onError: error => errors.push(error),
    }, { signal: owner.signal, reconnect: { enabled: false } });
    cleanups.push(close);
    const failure = new DOMException('Authored live source read failure', 'AbortError');
    source.fail(failure);
    await until(() => errors.length === 1, 'Actual source AbortError was mistaken for caller cancellation');
    expect(errors[0]).toBe(failure);
    expect(owner.signal.aborted).toBe(false);
  }, 10_000);

  test('the same body failure after caller cancellation cannot publish an obsolete error', async () => {
    const source = currentBody(); const owner = new AbortController(); const errors: unknown[] = [];
    const close = await openRawServerSentEventStream(source.fetchImpl, 'http://owned-source.test/events', {
      onError: error => errors.push(error),
    }, { signal: owner.signal, reconnect: { enabled: false } });
    cleanups.push(close);
    owner.abort();
    source.fail(new DOMException('Authored cancelled source read failure', 'AbortError'));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(owner.signal.aborted).toBe(true);
    expect(errors).toEqual([]);
  }, 10_000);
});
