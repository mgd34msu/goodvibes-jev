import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { BROWSER_JUDGMENT_PATH, createBunRelayServer, createRelayDaemonRegistration, type RelayDaemonRegistrationOptions, type RelayClientWebSocket } from '../daemon-sdk/src/index.js';
import { createRelayClient } from '../transport-realtime/src/relay-transport.js';
import { decodeTunnelFrame, encodeTunnelFrame, generateRelayIdentity, RelaySecureChannel } from '../transport-core/src/relay/index.js';

const silent = { info() {}, warn() {}, error() {} };
const server = createBunRelayServer({ port: 0, hostname: '127.0.0.1', logger: silent });
const relayUrl = `ws://127.0.0.1:${server.port}`;
afterAll(() => { void server.stop(true); });

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() >= end) throw new Error('Synthetic relay lifecycle did not settle');
    await Bun.sleep(2);
  }
}
async function fixture(dispatch: RelayDaemonRegistrationOptions['dispatch'], options: Partial<RelayDaemonRegistrationOptions> = {}) {
  const registered = gate<void>();
  const reg = createRelayDaemonRegistration({
    relayUrl, rid: crypto.randomUUID(), identity: await generateRelayIdentity(), localBaseUrl: 'http://daemon.local',
    logger: silent, dispatch, onStatusChange: (status) => { if (status === 'registered') registered.resolve(); }, ...options,
  });
  reg.start(); await registered.promise;
  const client = createRelayClient({ pairing: await reg.mintPairing(), requestTimeoutMs: 25 });
  await client.connect();
  return { client, reg, close() { client.close(); reg.stop(); } };
}
const request = (signal?: AbortSignal) => ({ method: 'POST', body: '{}', ...(signal ? { signal } : {}) });
const url = `http://daemon.local${BROWSER_JUDGMENT_PATH}`;

function waitForAbort(req: Request, onAbort: () => void): Promise<Response> {
  return new Promise((_, reject) => {
    const abort = () => { onAbort(); reject(req.signal.reason); };
    if (req.signal.aborted) abort(); else req.signal.addEventListener('abort', abort, { once: true });
  });
}

describe('relay judgment request ownership (loopback and synthetic answers only)', () => {
  test('cancel is an encrypted tunnel frame with no caller reason', () => {
    const bytes = encodeTunnelFrame({ id: 'owned-request', kind: 'request-cancel' }, new Uint8Array(0));
    expect(decodeTunnelFrame(bytes)?.header).toEqual({ id: 'owned-request', kind: 'request-cancel' });
  });

  test('only POST judgment waits beyond the ordinary unary timeout; timed-out peers cancel remotely', async () => {
    const answer = gate<Response>(); let ordinaryAborts = 0; let judgmentSettled = false;
    const f = await fixture(async (req) => req.method === 'POST' && new URL(req.url).pathname === BROWSER_JUDGMENT_PATH
      ? answer.promise : waitForAbort(req, () => { ordinaryAborts++; }));
    try {
      const judgment = f.client.fetch(url, request()).then((response) => { judgmentSettled = true; return response; });
      const ordinary = f.client.fetch(url);
      await expect(ordinary).rejects.toThrow('timed out');
      await until(() => ordinaryAborts === 1);
      expect(judgmentSettled).toBe(false); expect(f.reg.stats().inFlightRequests).toBe(1);
      answer.resolve(Response.json({ status: 'synthetic-answer' }));
      expect(await (await judgment).json()).toEqual({ status: 'synthetic-answer' });
      await until(() => f.reg.stats().inFlightRequests === 0);
    } finally { answer.resolve(new Response('cleanup')); f.close(); }
  });

  test.each(['?extra=1', '/extra'])('near-matching judgment route %s retains its ordinary timeout', async (suffix) => {
    let aborted = false;
    const f = await fixture(async (req) => waitForAbort(req, () => { aborted = true; }));
    try {
      await expect(f.client.fetch(`${url}${suffix}`, request())).rejects.toThrow('timed out');
      await until(() => aborted && f.reg.stats().inFlightRequests === 0);
    } finally { f.close(); }
  });

  test('pre-aborted input never connects or dispatches', async () => {
    let calls = 0;
    const f = await fixture(async () => { calls++; return new Response('unused'); });
    try {
      const abort = new AbortController(); abort.abort();
      await expect(f.client.fetch(url, request(abort.signal))).rejects.toMatchObject({ name: 'AbortError' });
      expect(calls).toBe(0); expect(f.reg.stats().inFlightRequests).toBe(0);
    } finally { f.close(); }
  });

  test('closing during a pending handshake promptly rejects its owned connection', async () => {
    let closes = 0;
    const client = createRelayClient({
      pairing: { protocol: 1, relayUrl, rid: 'held-handshake', daemonPublicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      webSocketImpl: () => ({ binaryType: '', send() {}, close() { closes++; }, addEventListener() {} }),
    });
    const connecting = client.connect();
    client.close();
    await expect(connecting).rejects.toThrow(/closed/i);
    expect(closes).toBe(1); expect(client.ready).toBe(false);
  });

  test('cancellation during encrypted send prevents late transmission and preserves the next call', async () => {
    let calls = 0;
    const f = await fixture(async () => { calls++; return new Response('synthetic answer'); });
    const sealing = gate<void>(); const release = gate<void>(); let first = true;
    const original = RelaySecureChannel.prototype.seal;
    const seal = spyOn(RelaySecureChannel.prototype, 'seal').mockImplementation(async function (this: RelaySecureChannel, frame) {
      const encrypted = await original.call(this, frame);
      if (first) { first = false; sealing.resolve(); await release.promise; }
      return encrypted;
    });
    try {
      const abort = new AbortController(); const pending = f.client.fetch(url, request(abort.signal));
      await sealing.promise; abort.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      release.resolve();
      expect(await (await f.client.fetch(url, request())).text()).toBe('synthetic answer');
      expect(calls).toBe(1);
    } finally { release.resolve(); seal.mockRestore(); f.close(); }
  });

  test('delayed daemon encryption cannot reorder simultaneous responses', async () => {
    const f = await fixture(async () => new Response('ordered answer'));
    const sealing = gate<void>(); const release = gate<void>();
    const original = RelaySecureChannel.prototype.seal;
    let responses = 0; let secondSettled = false;
    const seal = spyOn(RelaySecureChannel.prototype, 'seal').mockImplementation(async function (this: RelaySecureChannel, frame) {
      const encrypted = await original.call(this, frame);
      if (decodeTunnelFrame(frame)?.header.kind === 'response' && ++responses === 1) {
        sealing.resolve(); await release.promise;
      }
      return encrypted;
    });
    try {
      const first = f.client.fetch(url, request()).then((response) => response.text());
      void first.catch(() => {});
      await sealing.promise;
      const second = f.client.fetch(url, request()).then(async (response) => { secondSettled = true; return response.text(); });
      void second.catch(() => {});
      await Bun.sleep(20);
      expect(secondSettled).toBe(false);
      release.resolve();
      expect(await Promise.all([first, second])).toEqual(['ordered answer', 'ordered answer']);
      expect(f.client.ready).toBe(true);
    } finally { release.resolve(); seal.mockRestore(); f.close(); }
  });

  test('delayed client decryption cannot let another frame overtake its counter validation', async () => {
    const f = await fixture(async () => new Response('ordered open'));
    const opening = gate<void>(); const release = gate<void>();
    const original = RelaySecureChannel.prototype.open;
    let clientChannel: RelaySecureChannel | undefined;
    let opens = 0;
    // First opened application frame belongs to the daemon (the request).
    // The next is the client's first response; delay it before its decrypt.
    let seen = 0;
    const open = spyOn(RelaySecureChannel.prototype, 'open').mockImplementation(async function (this: RelaySecureChannel, frame) {
      seen++;
      if (seen === 2) { clientChannel = this; opens++; opening.resolve(); await release.promise; }
      else if (this === clientChannel) opens++;
      return original.call(this, frame);
    });
    try {
      const first = f.client.fetch(url, request()).then((response) => response.text());
      void first.catch(() => {});
      await opening.promise;
      const second = f.client.fetch(url, request()).then((response) => response.text());
      void second.catch(() => {});
      await Bun.sleep(20);
      expect(opens).toBe(1);
      release.resolve();
      expect(await Promise.all([first, second])).toEqual(['ordered open', 'ordered open']);
      expect(f.client.ready).toBe(true);
    } finally { release.resolve(); open.mockRestore(); f.close(); }
  });

  test('stream and unary responses share the same daemon encrypted-send order', async () => {
    const subscribed = gate<void>(); let source!: ReadableStreamDefaultController<Uint8Array>;
    const f = await fixture(async (req) => req.method === 'GET'
      ? new Response(new ReadableStream<Uint8Array>({ start(controller) { source = controller; subscribed.resolve(); } }), { headers: { 'content-type': 'text/event-stream' } })
      : new Response('ordered unary'));
    const sealing = gate<void>(); const release = gate<void>();
    const original = RelaySecureChannel.prototype.seal;
    const seal = spyOn(RelaySecureChannel.prototype, 'seal').mockImplementation(async function (this: RelaySecureChannel, frame) {
      const encrypted = await original.call(this, frame);
      if (decodeTunnelFrame(frame)?.header.kind === 'stream-data') { sealing.resolve(); await release.promise; }
      return encrypted;
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const stream = await f.client.fetch('http://daemon.local/events', { headers: { accept: 'text/event-stream' } });
      reader = stream.body!.getReader(); await subscribed.promise;
      source.enqueue(new TextEncoder().encode('data: ordered\n\n'));
      await sealing.promise;
      let settled = false;
      const unary = f.client.fetch(url, request()).then(async (response) => { settled = true; return response.text(); });
      void unary.catch(() => {});
      await Bun.sleep(20); expect(settled).toBe(false);
      release.resolve();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: ordered\n\n');
      expect(await unary).toBe('ordered unary'); expect(f.client.ready).toBe(true);
    } finally { release.resolve(); await reader?.cancel(); seal.mockRestore(); f.close(); }
  });

  test.each([501, 502, 503])('HTTP %i refusal does not send after its pipe is retired during crypto', async (status) => {
    const waiting = gate<Response>();
    let calls = 0; let daemonSends = 0;
    const f = await fixture(async () => {
      calls++;
      if (status === 503) return waiting.promise;
      if (status === 501) return new Response('synthetic SSE', { headers: { 'content-type': 'text/event-stream' } });
      return new Response(new Uint8Array(32 * 1024 * 1024 + 1));
    }, { maxInFlightRequests: 1, webSocketImpl: (address) => {
      const ws = new WebSocket(address) as unknown as RelayClientWebSocket;
      const send = ws.send.bind(ws);
      ws.send = (data) => { if (typeof data !== 'string') daemonSends++; send(data); };
      return ws;
    } });
    const sealing = gate<void>(); const release = gate<void>();
    const original = RelaySecureChannel.prototype.seal;
    const seal = spyOn(RelaySecureChannel.prototype, 'seal').mockImplementation(async function (this: RelaySecureChannel, frame) {
      const encrypted = await original.call(this, frame);
      const header = decodeTunnelFrame(frame)?.header;
      if (header?.kind === 'response' && header.status === status) { sealing.resolve(); await release.promise; }
      return encrypted;
    });
    const pending: Promise<unknown>[] = [];
    try {
      if (status === 503) { pending.push(f.client.fetch(url, request()).catch(() => {})); await until(() => calls === 1); }
      pending.push(f.client.fetch(url, request()).catch(() => {}));
      await sealing.promise;
      f.reg.stop();
      const before = daemonSends;
      release.resolve();
      await Promise.all(pending);
      await Bun.sleep(5);
      expect(daemonSends).toBe(before);
    } finally { waiting.resolve(new Response('cleanup')); release.resolve(); seal.mockRestore(); f.close(); }
  });

  test('a stalled encrypted-send queue is bounded and retires its owning pipe', async () => {
    const f = await fixture(async () => new Response('held crypto'), { maxInFlightRequests: 1, maxStreamsPerPipe: 1 });
    const sealing = gate<void>(); const release = gate<void>();
    const original = RelaySecureChannel.prototype.seal;
    let held = false;
    const seal = spyOn(RelaySecureChannel.prototype, 'seal').mockImplementation(async function (this: RelaySecureChannel, frame) {
      const encrypted = await original.call(this, frame);
      if (!held && decodeTunnelFrame(frame)?.header.kind === 'response') { held = true; sealing.resolve(); await release.promise; }
      return encrypted;
    });
    const pending: Promise<unknown>[] = [];
    try {
      pending.push(f.client.fetch(url, request()).catch((error: unknown) => error));
      await sealing.promise;
      for (let i = 0; i < 4 && f.client.ready; i++) {
        pending.push(f.client.fetch(url, request()).catch((error: unknown) => error));
        await Bun.sleep(5);
      }
      await until(() => !f.client.ready);
      expect(f.reg.stats().droppedRequests).toBe(4);
      // The first response still owns its slot while crypto is held; retirement
      // fences sends but does not pretend uncooperative work has drained.
      expect(f.reg.stats().inFlightRequests).toBe(1);
      release.resolve();
      expect(await Promise.all(pending)).toHaveLength(5);
      await until(() => f.reg.stats().inFlightRequests === 0);
    } finally { release.resolve(); seal.mockRestore(); f.close(); }
  });

  test('caller cancellation reaches the daemon judgment and drains its owned slot', async () => {
    const entered = gate<void>(); let aborted = false;
    const f = await fixture(async (req) => { entered.resolve(); return waitForAbort(req, () => { aborted = true; }); });
    try {
      const abort = new AbortController();
      const pending = f.client.fetch(url, request(abort.signal));
      await entered.promise; abort.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await until(() => aborted && f.reg.stats().inFlightRequests === 0);
      expect(f.client.ready).toBe(true);
    } finally { f.close(); }
  });

  test.each(['client close', 'daemon stop'] as const)('%s cancels pending judgment and drains without a unary timer', async (kind) => {
    const entered = gate<void>(); let aborted = false;
    const f = await fixture(async (req) => { entered.resolve(); return waitForAbort(req, () => { aborted = true; }); });
    try {
      const pending = f.client.fetch(url, request());
      await entered.promise;
      if (kind === 'client close') f.client.close(); else f.reg.stop();
      await expect(pending).rejects.toThrow(/closed/i);
      await until(() => aborted && f.reg.stats().inFlightRequests === 0);
    } finally { f.close(); }
  });

  test('cancelled uncooperative dispatch keeps its admission slot until actual drain and cannot publish late success', async () => {
    const entered = gate<void>(); const answer = gate<Response>(); let signal!: AbortSignal;
    const f = await fixture(async (req) => { signal = req.signal; entered.resolve(); return answer.promise; }, { maxInFlightRequests: 1 });
    try {
      const abort = new AbortController(); const pending = f.client.fetch(url, request(abort.signal));
      await entered.promise; abort.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await until(() => signal.aborted);
      expect(f.reg.stats().inFlightRequests).toBe(1);
      const busy = await f.client.fetch(url, request());
      expect(busy.status).toBe(503);
      answer.resolve(new Response('late answer'));
      await until(() => f.reg.stats().inFlightRequests === 0);
    } finally { answer.resolve(new Response('cleanup')); f.close(); }
  });

  test('cancellation during unary response buffering releases the slot even if stream cancel never settles', async () => {
    const entered = gate<void>(); let cancelled = false;
    const f = await fixture(async () => new Response(new ReadableStream<Uint8Array>({
      start() { entered.resolve(); },
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    })));
    try {
      const abort = new AbortController(); const pending = f.client.fetch(url, request(abort.signal));
      await entered.promise; abort.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await until(() => cancelled && f.reg.stats().inFlightRequests === 0);
    } finally { f.close(); }
  });

  test('pipe-cap eviction cancels judgment on both sides without waiting for a unary timeout', async () => {
    const entered = gate<void>(); let aborted = false;
    const f = await fixture(async (req) => { entered.resolve(); return waitForAbort(req, () => { aborted = true; }); }, { maxPipes: 1 });
    const second = createRelayClient({ pairing: await f.reg.mintPairing() });
    try {
      const pending = f.client.fetch(url, request()).catch((error: unknown) => error);
      await entered.promise;
      await second.connect();
      expect(await pending).toMatchObject({ message: 'Relay pipe closed.' });
      await until(() => aborted && f.reg.stats().inFlightRequests === 0);
      expect(f.reg.stats().droppedPipes).toBe(1);
      expect(second.ready).toBe(true);
    } finally { second.close(); f.close(); }
  });

  test('source/authorization refusal remains terminal without any relay retry', async () => {
    let calls = 0;
    const f = await fixture(async () => { calls++; return Response.json({ error: { code: 'JUDGMENT_REFERENCE_HELD' } }, { status: 422 }); });
    try {
      const response = await f.client.fetch(url, request());
      expect(response.status).toBe(422); expect(calls).toBe(1);
      expect(await response.json()).toEqual({ error: { code: 'JUDGMENT_REFERENCE_HELD' } });
    } finally { f.close(); }
  });
});
