/**
 * relay-event-streaming.test.ts
 *
 * Live event subscriptions over the relay tunnel, end to end through a REAL
 * in-process Bun relay server, a real daemon-side registration bridging an event
 * source, and the real relay client. Proves: (1) events flow, an SSE request
 * opened over the relay streams the daemon's event bytes back; (2) the relay hub
 * only ever sees ciphertext (the plaintext event text never appears in the bytes
 * the daemon hands the relay); (3) overflow on the daemon's bounded send buffer
 * surfaces as a visible `relay-overflow` event, never a silent gap; (4) close
 * semantics, the daemon ending its source closes the client stream, and the
 * client cancelling reading unsubscribes the daemon's source.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  createBunRelayServer,
  createRelayDaemonRegistration,
  type RelayClientWebSocket,
} from '../daemon-sdk/src/index.js';
import { createRelayClient } from '../transport-realtime/src/relay-transport.js';
import { generateRelayIdentity } from '../transport-core/src/relay/index.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const server = createBunRelayServer({ port: 0, logger: silent });
const relayUrl = `ws://localhost:${server.port}`;

afterAll(() => {
  void server.stop(true);
});

/** A controllable Server-Sent-Events source the daemon dispatch hands back. */
function makePushableSource() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
    cancel() { cancelled = true; },
  });
  return {
    response: (): Response => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    push: (text: string): void => controller.enqueue(new TextEncoder().encode(text)),
    close: (): void => { try { controller.close(); } catch { /* already closed */ } },
    get cancelled(): boolean { return cancelled; },
  };
}

interface DaemonHandle {
  reg: ReturnType<typeof createRelayDaemonRegistration>;
  sentBinary: Uint8Array[];
}

async function standUpDaemon(
  rid: string,
  dispatch: (req: Request) => Promise<Response | null>,
  streamBufferChunks?: number,
): Promise<DaemonHandle> {
  const identity = await generateRelayIdentity();
  const sentBinary: Uint8Array[] = [];
  let resolveReg: () => void = () => {};
  const registered = new Promise<void>((resolve) => { resolveReg = resolve; });
  const reg = createRelayDaemonRegistration({
    relayUrl,
    rid,
    identity,
    localBaseUrl: 'http://daemon.local',
    dispatch,
    logger: silent,
    ...(streamBufferChunks !== undefined ? { streamBufferChunks } : {}),
    webSocketImpl: (url: string): RelayClientWebSocket => {
      const ws = new WebSocket(url) as unknown as RelayClientWebSocket;
      const realSend = ws.send.bind(ws);
      ws.send = (data: string | Uint8Array | ArrayBuffer): void => {
        if (typeof data !== 'string') {
          sentBinary.push(data instanceof ArrayBuffer ? new Uint8Array(data.slice(0)) : new Uint8Array(data));
        }
        realSend(data);
      };
      return ws;
    },
    onStatusChange: (s) => { if (s === 'registered') resolveReg(); },
  });
  reg.start();
  await registered;
  return { reg, sentBinary };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (accumulated: string) => boolean,
  timeoutMs = 3000,
): Promise<string> {
  const decoder = new TextDecoder();
  let acc = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(acc)) return acc;
    const { done, value } = await reader.read();
    if (done) return acc;
    if (value) acc += decoder.decode(value, { stream: true });
  }
  throw new Error(`predicate not satisfied within ${timeoutMs}ms; got: ${acc}`);
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function withinStreamBudget<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Relay stream operation did not settle within 3000ms.')), 3000);
  });
  try { return await Promise.race([work, deadline]); }
  finally { clearTimeout(timer); }
}

async function waitForStreamCondition(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  if (!check()) throw new Error('Relay stream native condition did not settle within 2000ms.');
}

describe('relay event streaming', () => {
  test('an SSE subscription streams events over the relay; the hub sees only ciphertext', async () => {
    const source = makePushableSource();
    const daemon = await standUpDaemon('rid-stream-flow', async (req) => {
      if (new URL(req.url).pathname === '/api/events-test') return source.response();
      return null;
    });
    const pairing = await daemon.reg.mintPairing('stream-daemon');
    const client = createRelayClient({ pairing });
    await client.connect();

    const res = await client.fetch('https://relay.invalid/api/events-test', {
      headers: { accept: 'text/event-stream' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();

    source.push('event: tick\ndata: {"n":1,"marker":"PLAINTEXT-EVENT-MARKER"}\n\n');
    source.push('event: tick\ndata: {"n":2}\n\n');

    const received = await readUntil(reader, (acc) => acc.includes('"n":1') && acc.includes('"n":2'));
    expect(received).toContain('PLAINTEXT-EVENT-MARKER');

    // Ciphertext-only at the hub: the distinctive plaintext must NOT appear in any
    // binary frame the daemon handed the relay (what the relay forwards verbatim).
    const marker = new TextEncoder().encode('PLAINTEXT-EVENT-MARKER');
    const leaked = daemon.sentBinary.some((frame) => containsSubsequence(frame, marker));
    expect(leaked).toBe(false);
    expect(daemon.sentBinary.length).toBeGreaterThan(0);

    await reader.cancel();
    client.close();
    daemon.reg.stop();
  });

  test('daemon closing its source closes the client stream (clean close)', async () => {
    const source = makePushableSource();
    const daemon = await standUpDaemon('rid-stream-close', async (req) =>
      new URL(req.url).pathname === '/api/events-test' ? source.response() : null,
    );
    const client = createRelayClient({ pairing: await daemon.reg.mintPairing() });
    await client.connect();
    const res = await client.fetch('https://relay.invalid/api/events-test', { headers: { accept: 'text/event-stream' } });
    const reader = res.body!.getReader();

    source.push('data: one\n\n');
    await readUntil(reader, (acc) => acc.includes('one'));

    source.close(); // daemon's source ends -> stream-close -> client stream ends
    const drain = async (): Promise<boolean> => {
      for (;;) { const { done } = await reader.read(); if (done) return true; }
    };
    expect(await drain()).toBe(true);

    client.close();
    daemon.reg.stop();
  });

  test('client cancelling the read unsubscribes the daemon source', async () => {
    const source = makePushableSource();
    const daemon = await standUpDaemon('rid-stream-cancel', async (req) =>
      new URL(req.url).pathname === '/api/events-test' ? source.response() : null,
    );
    const client = createRelayClient({ pairing: await daemon.reg.mintPairing() });
    await client.connect();
    const res = await client.fetch('https://relay.invalid/api/events-test', { headers: { accept: 'text/event-stream' } });
    const reader = res.body!.getReader();
    source.push('data: hi\n\n');
    await readUntil(reader, (acc) => acc.includes('hi'));

    await reader.cancel(); // sends stream-close to the daemon
    // The daemon should cancel its source reader in response.
    for (let i = 0; i < 100 && !source.cancelled; i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(source.cancelled).toBe(true);

    client.close();
    daemon.reg.stop();
  });

  test('request signal abort rejects a pending read and unsubscribes the daemon source', async () => {
    const source = makePushableSource();
    let daemonRequest: Request | undefined;
    const daemon = await standUpDaemon('rid-stream-request-abort', async (req) => {
      if (new URL(req.url).pathname !== '/api/events-test') return null;
      daemonRequest = req;
      return source.response();
    });
    const abort = new AbortController();
    const reason = new DOMException('Subscription cancelled.', 'AbortError');
    let client: ReturnType<typeof createRelayClient> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      client = createRelayClient({ pairing: await daemon.reg.mintPairing() });
      await client.connect();
      const response = await client.fetch('https://relay.invalid/api/events-test', {
        headers: { accept: 'text/event-stream' }, signal: abort.signal,
      });
      if (!response.body) throw new Error('Relay subscription has no response body.');
      reader = response.body.getReader();
      source.push('data: subscribed\n\n');
      expect(await withinStreamBudget(readUntil(reader, (text) => text.includes('subscribed')))).toContain('subscribed');

      const pendingRead = withinStreamBudget(reader.read());
      abort.abort(reason);
      await expect(pendingRead).rejects.toBe(reason);
      await waitForStreamCondition(() => source.cancelled && daemonRequest?.signal.aborted === true);
      expect(source.cancelled).toBe(true);
      expect(daemonRequest?.signal.aborted).toBe(true);
      expect(client.ready).toBe(true);
    } finally {
      abort.abort(reason);
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      client?.close();
      daemon.reg.stop();
      source.close();
    }
  });

  test('abort during deferred dispatch cancels its late body without delivering stale bytes', async () => {
    const source = makePushableSource();
    const lateResponse = source.response();
    const entered = deferred<Request>();
    const dispatch = deferred<Response>();
    const daemon = await standUpDaemon('rid-stream-late-dispatch', async (req) => {
      if (new URL(req.url).pathname !== '/api/events-test') return null;
      entered.resolve(req);
      return dispatch.promise;
    });
    const abort = new AbortController();
    const reason = new DOMException('Deferred subscription cancelled.', 'AbortError');
    let client: ReturnType<typeof createRelayClient> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      client = createRelayClient({ pairing: await daemon.reg.mintPairing() });
      await client.connect();
      const response = await client.fetch('https://relay.invalid/api/events-test', {
        headers: { accept: 'text/event-stream' }, signal: abort.signal,
      });
      if (!response.body) throw new Error('Relay subscription has no response body.');
      reader = response.body.getReader();
      const daemonRequest = await withinStreamBudget(entered.promise);
      const pendingRead = withinStreamBudget(reader.read());
      abort.abort(reason);
      await expect(pendingRead).rejects.toBe(reason);
      await waitForStreamCondition(() => daemonRequest.signal.aborted);
      expect(daemonRequest.signal.aborted).toBe(true);
      expect(source.cancelled).toBe(false);

      source.push('data: STALE-LATE-DISPATCH\n\n');
      dispatch.resolve(lateResponse);
      await waitForStreamCondition(() => source.cancelled);
      expect(source.cancelled).toBe(true);
      await expect(withinStreamBudget(reader.read())).rejects.toBe(reason);
      expect(client.ready).toBe(true);
    } finally {
      abort.abort(reason);
      dispatch.resolve(lateResponse);
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      client?.close();
      daemon.reg.stop();
      source.close();
    }
  });

  test('the final event survives an immediate clean source end before any client read', async () => {
    const source = makePushableSource();
    const daemon = await standUpDaemon('rid-stream-final-event', async (req) =>
      new URL(req.url).pathname === '/api/events-test' ? source.response() : null,
    );
    let client: ReturnType<typeof createRelayClient> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      client = createRelayClient({ pairing: await daemon.reg.mintPairing() });
      await client.connect();
      const response = await client.fetch('https://relay.invalid/api/events-test', { headers: { accept: 'text/event-stream' } });
      if (!response.body) throw new Error('Relay subscription has no response body.');
      const activeReader = response.body.getReader();
      reader = activeReader;
      const finalEvent = 'event: terminal\ndata: {"final":true}\n\n';
      source.push(finalEvent);
      source.close();

      const received = await withinStreamBudget((async () => {
        const decoder = new TextDecoder();
        let text = '';
        for (;;) {
          const { done, value } = await activeReader.read();
          if (done) return text + decoder.decode();
          text += decoder.decode(value, { stream: true });
        }
      })());
      expect(received).toBe(finalEvent);
      expect(source.cancelled).toBe(false);
      expect(client.ready).toBe(true);
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      client?.close();
      daemon.reg.stop();
      source.close();
    }
  });

  test('a bounded send buffer surfaces overflow as a visible relay-overflow event', async () => {
    const source = makePushableSource();
    // A tiny buffer so a burst of events must drop.
    const daemon = await standUpDaemon('rid-stream-overflow', async (req) =>
      new URL(req.url).pathname === '/api/events-test' ? source.response() : null,
    1);
    const client = createRelayClient({ pairing: await daemon.reg.mintPairing() });
    await client.connect();
    const res = await client.fetch('https://relay.invalid/api/events-test', { headers: { accept: 'text/event-stream' } });
    const reader = res.body!.getReader();

    // Burst far more events than the 1-chunk buffer can hold before they drain.
    for (let i = 0; i < 200; i += 1) source.push(`data: burst-${i}\n\n`);

    const received = await readUntil(reader, (acc) => acc.includes('event: relay-overflow'), 5000);
    expect(received).toContain('event: relay-overflow');
    expect(received).toMatch(/"dropped":\d+/);

    await reader.cancel();
    client.close();
    daemon.reg.stop();
  });
});

/** Whether `needle` appears as a contiguous byte subsequence of `haystack`. */
function containsSubsequence(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true;
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}
