// relay-transport.ts
//
// The client half of the relay path. Its whole job is to produce a `fetch`
// implementation backed by the end-to-end secure channel, so the EXISTING typed
// operator/peer client works completely unchanged over the relay: you build the
// SDK with `fetchImpl: relayClient.fetch` instead of the default, and every
// contract call is serialized to an HTTP request, tunneled as ciphertext to the
// daemon, replayed there, and its response tunneled back. The relay operator
// never sees any of it.
//
// This tunnels unary request/response calls AND live event subscriptions. A
// request whose `Accept` is `text/event-stream` is opened as a tunneled stream:
// the returned `Response` carries a `ReadableStream` body fed by `stream-data`
// frames, so the EXISTING Server-Sent-Events connector idiom
// (openServerSentEventStream, which just calls `fetch` and reads the streaming
// body) works over the relay unchanged. Overflow on the daemon's bounded send
// buffer surfaces as a visible `relay-overflow` SSE event (never a silent gap).

import { GoodVibesSdkError } from '@goodvibes-jev/engine/errors';
import { createUuidV4, type FetchLike } from '@goodvibes-jev/engine/transport-core';
import {
  RelaySecureChannel,
  decodeControlFrame,
  decodeRelayPairingString,
  decodeTunnelFrame,
  encodeControlFrame,
  encodeTunnelFrame,
  encodeUtf8,
  finishInitiatorHandshake,
  fromBase64Url,
  startInitiatorHandshake,
  type RelayInitiatorState,
  type RelayPairingPayload,
} from '@goodvibes-jev/engine/transport-core/relay';

/** Minimal structural WebSocket shape the relay client needs (browser/Bun/Node). */
export interface RelayWebSocketLike {
  binaryType: string;
  send(data: string | Uint8Array | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: unknown) => void): void;
}

/** Options for {@link createRelayClient}. */
export interface RelayClientOptions {
  /** Pairing payload (object or the `gvrelay1.` encoded string) identifying the daemon. */
  readonly pairing: RelayPairingPayload | string;
  /** WebSocket constructor override (defaults to `globalThis.WebSocket`). */
  readonly webSocketImpl?: (url: string) => RelayWebSocketLike;
  /** Milliseconds to wait for the pipe + handshake before failing connect (default 15000). */
  readonly connectTimeoutMs?: number;
  /** Unary timeout (default 30000); judgment waits until its caller or connection cancels. */
  readonly requestTimeoutMs?: number;
}

/** A live relay client: a relay-backed `fetch` plus explicit lifecycle. */
export interface RelayClient {
  /** A `fetch` implementation to hand to the SDK as `fetchImpl`. */
  readonly fetch: FetchLike;
  /** Establish the pipe + E2E handshake. Idempotent; the fetch auto-connects too. */
  connect(): Promise<void>;
  /** Tear down the relay connection. */
  close(): void;
  /** True once the E2E channel is ready. */
  readonly ready: boolean;
}

const MAX_QUEUED_FRAMES = 1024;
const MAX_QUEUED_FRAME_BYTES = 64 * 1024 * 1024;
interface FrameQueue { tail: Promise<void>; count: number; bytes: number; }

interface PendingRequest {
  resolve(response: Response): void;
  reject(error: unknown): void;
}

interface PendingStream {
  readonly controller: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
}

function resolvePairing(pairing: RelayPairingPayload | string): RelayPairingPayload {
  return typeof pairing === 'string' ? decodeRelayPairingString(pairing) : pairing;
}

function defaultWebSocket(url: string): RelayWebSocketLike {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => RelayWebSocketLike }).WebSocket;
  if (!Ctor) {
    throw new GoodVibesSdkError('No WebSocket implementation is available in this runtime.', {
      category: 'config',
      source: 'transport',
      recoverable: false,
      hint: 'Provide options.webSocketImpl, or run where globalThis.WebSocket exists.',
    });
  }
  return new Ctor(url);
}

function toBytes(data: unknown): Uint8Array<ArrayBuffer> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) return new Uint8Array(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  throw new GoodVibesSdkError('Relay received a non-binary data frame.', { category: 'protocol', source: 'transport', recoverable: false });
}

/** Cancellation stops waiting without cancelling another caller's shared connection attempt. */
async function whileActive<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

/**
 * Create a relay client for a paired daemon. The returned `fetch` transparently
 * tunnels every request through the zero-knowledge channel.
 */
export function createRelayClient(options: RelayClientOptions): RelayClient {
  const pairing = resolvePairing(options.pairing);
  const daemonPubRaw = fromBase64Url(pairing.daemonPublicKey);
  const ridBytes = encodeUtf8(pairing.rid);
  const connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const makeSocket = options.webSocketImpl ?? defaultWebSocket;

  let socket: RelayWebSocketLike | null = null;
  let channel: RelaySecureChannel | null = null;
  let initiatorState: RelayInitiatorState | null = null;
  let connectPromise: Promise<void> | null = null;
  let cancelConnection: ((error: unknown) => void) | undefined;
  const pending = new Map<string, PendingRequest>();
  const streams = new Map<string, PendingStream>();
  const outgoing = new WeakMap<RelaySecureChannel, FrameQueue>();
  const incoming = new WeakMap<RelayWebSocketLike, FrameQueue>();

  /** Keep encrypted request/cancel/stream frames in counter order through async crypto. */
  function sendFrame(frame: Uint8Array<ArrayBuffer>, activeChannel: RelaySecureChannel, activeSocket: RelayWebSocketLike,
    wanted: () => boolean = () => true, sending: () => void = () => {}): Promise<void> {
    const current = () => channel === activeChannel && socket === activeSocket && wanted();
    if (!current()) return Promise.resolve();
    const queue = outgoing.get(activeChannel) ?? { tail: Promise.resolve(), count: 0, bytes: 0 };
    if (queue.count >= MAX_QUEUED_FRAMES || queue.bytes + frame.byteLength > MAX_QUEUED_FRAME_BYTES) {
      const error = new GoodVibesSdkError('Relay outgoing frame queue limit exceeded.', { category: 'protocol', source: 'transport', recoverable: true });
      teardown(error); return Promise.reject(error);
    }
    queue.count++; queue.bytes += frame.byteLength;
    const work = queue.tail.then(async () => {
      if (!current()) return;
      const sealed = await activeChannel.seal(frame);
      if (!current()) return;
      sending(); activeSocket.send(sealed);
    });
    queue.tail = work.then(() => {}, () => {}).finally(() => { queue.count--; queue.bytes -= frame.byteLength; });
    outgoing.set(activeChannel, queue);
    return work;
  }

  /** WebSocket order must survive asynchronous AEAD open/counter validation. */
  function receiveFrame(bytes: Uint8Array<ArrayBuffer>, ws: RelayWebSocketLike, markReady: () => void): Promise<void> {
    if (socket !== ws) return Promise.resolve();
    const queue = incoming.get(ws) ?? { tail: Promise.resolve(), count: 0, bytes: 0 };
    if (queue.count >= MAX_QUEUED_FRAMES || queue.bytes + bytes.byteLength > MAX_QUEUED_FRAME_BYTES) {
      const error = new GoodVibesSdkError('Relay incoming frame queue limit exceeded.', { category: 'protocol', source: 'transport', recoverable: true });
      teardown(error); return Promise.reject(error);
    }
    queue.count++; queue.bytes += bytes.byteLength;
    const work = queue.tail.then(async () => { if (socket === ws) await onBinary(bytes, ws, markReady); });
    queue.tail = work.then(() => {}, () => {}).finally(() => { queue.count--; queue.bytes -= bytes.byteLength; });
    incoming.set(ws, queue);
    return work;
  }

  function closeStream(id: string, error?: unknown): void {
    const stream = streams.get(id);
    if (!stream) return;
    streams.delete(id);
    if (stream.closed) return;
    stream.closed = true;
    try {
      if (error) stream.controller.error(error);
      else stream.controller.close();
    } catch {
      // controller already closed
    }
  }

  function failAll(error: unknown): void {
    for (const [, p] of pending) {
      p.reject(error);
    }
    pending.clear();
    for (const id of [...streams.keys()]) closeStream(id, error);
  }

  function teardown(error: unknown = new GoodVibesSdkError('Relay connection closed.', { category: 'network', source: 'transport', recoverable: true })): void {
    failAll(error);
    const previous = socket;
    const cancel = cancelConnection;
    cancelConnection = undefined;
    socket = null;
    channel = null;
    initiatorState = null;
    connectPromise = null;
    cancel?.(error);
    try { previous?.close(); } catch { /* already disconnected */ }
  }

  async function onBinary(bytes: Uint8Array<ArrayBuffer>, ws: RelayWebSocketLike, markReady: () => void): Promise<void> {
    if (!channel) {
      // First binary is the handshake response (message2).
      if (!initiatorState) throw new GoodVibesSdkError('Unexpected relay frame before handshake start.', { category: 'protocol', source: 'transport', recoverable: false });
      const keys = await finishInitiatorHandshake(initiatorState, bytes);
      if (socket !== ws) return;
      channel = new RelaySecureChannel(keys, 'client');
      markReady();
      return;
    }
    const activeChannel = channel;
    const framed = decodeTunnelFrame(await activeChannel.open(bytes));
    if (!framed || socket !== ws || channel !== activeChannel) return;
    const header = framed.header;
    if (header.kind === 'response') {
      const waiting = pending.get(header.id);
      if (!waiting) return;
      waiting.resolve(new Response(framed.body.length > 0 ? framed.body : null, {
        status: header.status,
        headers: header.headers.map(([k, v]) => [k, v] as [string, string]),
      }));
      return;
    }
    if (header.kind === 'stream-data') {
      const stream = streams.get(header.id);
      if (stream && !stream.closed && framed.body.length > 0) {
        try { stream.controller.enqueue(framed.body); } catch { /* consumer cancelled */ }
      }
      return;
    }
    if (header.kind === 'stream-overflow') {
      const stream = streams.get(header.id);
      if (stream && !stream.closed) {
        // Surface the gap as a visible SSE event, never a silent drop.
        const notice = encodeUtf8(`event: relay-overflow\ndata: {"dropped":${header.dropped}}\n\n`);
        try { stream.controller.enqueue(notice); } catch { /* consumer cancelled */ }
      }
      return;
    }
    if (header.kind === 'stream-close') {
      closeStream(header.id);
      return;
    }
  }

  function connect(): Promise<void> {
    if (channel) return Promise.resolve();
    if (connectPromise) return connectPromise;
    connectPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const cancelled = (error: unknown): void => {
        if (settled) return;
        settled = true; clearTimeout(timer); reject(error);
      };
      cancelConnection = cancelled;
      const done = (err?: unknown): void => {
        if (settled) { if (err && socket === ws) teardown(err); return; }
        if (cancelConnection === cancelled) cancelConnection = undefined;
        settled = true;
        clearTimeout(timer);
        if (err) {
          teardown(err);
          reject(err);
        } else {
          resolve();
        }
      };
      const timer = setTimeout(() => done(new GoodVibesSdkError('Timed out establishing the relay connection.', {
        category: 'timeout',
        source: 'transport',
        recoverable: true,
        hint: 'The daemon may be offline or the relay unreachable.',
      })), connectTimeoutMs);

      let ws: RelayWebSocketLike;
      try { ws = makeSocket(pairing.relayUrl); }
      catch (error) { done(error); return; }
      ws.binaryType = 'arraybuffer';
      socket = ws;
      ws.addEventListener('open', () => {
        ws.send(encodeControlFrame({ t: 'connect', role: 'client', protocol: 1, rid: pairing.rid }));
      });
      ws.addEventListener('message', (event) => {
        if (socket !== ws) return;
        const data = (event as { data: unknown }).data;
        void (async () => {
          try {
            if (typeof data === 'string') {
              const frame = decodeControlFrame(data);
              if (!frame) return;
              if (frame.t === 'connected') {
                const started = await startInitiatorHandshake(daemonPubRaw, ridBytes);
                if (socket !== ws) return;
                initiatorState = started.state;
                ws.send(started.message1);
              } else if (frame.t === 'error') {
                done(new GoodVibesSdkError(`Relay refused the connection: ${frame.message}`, {
                  category: frame.code === 'daemon-offline' ? 'not_found' : 'service',
                  source: 'transport',
                  recoverable: frame.code !== 'daemon-offline',
                  hint: frame.code === 'daemon-offline' ? 'The daemon is not registered on the relay (offline or wrong rendezvous id).' : undefined,
                }));
              } else if (frame.t === 'pipe-close') {
                done(new GoodVibesSdkError('Relay pipe closed.', { category: 'network', source: 'transport', recoverable: true }));
              }
              return;
            }
            await receiveFrame(toBytes(data), ws, () => done());
          } catch (err) {
            if (socket === ws) done(err);
          }
        })();
      });
      ws.addEventListener('close', () => {
        if (socket !== ws) return;
        done(new GoodVibesSdkError('Relay connection closed.', { category: 'network', source: 'transport', recoverable: true }));
      });
      ws.addEventListener('error', () => {
        if (socket !== ws) return;
        done(new GoodVibesSdkError('Relay WebSocket error.', { category: 'network', source: 'transport', recoverable: true }));
      });
    });
    return connectPromise;
  }

  async function openStream(
    path: string,
    headers: Array<[string, string]>,
    activeChannel: RelaySecureChannel,
    activeSocket: RelayWebSocketLike,
  ): Promise<Response> {
    const id = createUuidV4();
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller; },
      cancel() {
        // The consumer stopped reading, tell the daemon to unsubscribe.
        const stream = streams.get(id);
        if (stream) stream.closed = true;
        streams.delete(id);
        void (async () => {
          try {
            const frame = encodeTunnelFrame({ id, kind: 'stream-close' }, new Uint8Array(0));
            await sendFrame(frame, activeChannel, activeSocket);
          } catch { /* socket already gone */ }
        })();
      },
    });
    streams.set(id, { controller: streamController!, closed: false });
    const openFrame = encodeTunnelFrame({ id, kind: 'stream-open', method: 'GET', path, headers }, new Uint8Array(0));
    await sendFrame(openFrame, activeChannel, activeSocket);
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }

  const relayFetch: FetchLike = async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    request.signal.throwIfAborted();
    await whileActive(connect(), request.signal);
    request.signal.throwIfAborted();
    if (!channel || !socket) throw new GoodVibesSdkError('Relay channel is not ready.', { category: 'network', source: 'transport', recoverable: true });
    const activeChannel = channel;
    const activeSocket = socket;
    const url = new URL(request.url, 'http://relay.local');
    const headers: Array<[string, string]> = [];
    request.headers.forEach((value, key) => headers.push([key, value]));
    // A Server-Sent-Events request is opened as a tunneled stream rather than a
    // unary call (its body never ends). The existing SSE connector, which just
    // calls fetch and reads the streaming body, then works over the relay.
    const accept = request.headers.get('accept') ?? '';
    if (request.method === 'GET' && accept.includes('text/event-stream')) {
      return openStream(`${url.pathname}${url.search}`, headers, channel, socket);
    }
    const bodyText = request.method === 'GET' || request.method === 'HEAD' ? '' : await whileActive(request.text(), request.signal);
    request.signal.throwIfAborted();
    const id = createUuidV4();
    const frame = encodeTunnelFrame(
      { id, kind: 'request', method: request.method, path: `${url.pathname}${url.search}`, headers },
      bodyText ? encodeUtf8(bodyText) : new Uint8Array(0),
    );
    if (channel !== activeChannel || socket !== activeSocket) throw new GoodVibesSdkError('Relay connection changed.', { category: 'network', source: 'transport', recoverable: true });
    return new Promise<Response>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let sent = false;
      const cleanup = (): boolean => {
        if (!pending.delete(id)) return false;
        clearTimeout(timer);
        request.signal.removeEventListener('abort', cancel);
        return true;
      };
      const cancelRemote = (): void => {
        if (!sent || channel !== activeChannel || socket !== activeSocket) return;
        void (async () => {
          try {
            const cancelled = encodeTunnelFrame({ id, kind: 'request-cancel' }, new Uint8Array(0));
            await sendFrame(cancelled, activeChannel, activeSocket);
          } catch { if (socket === activeSocket) teardown(); }
        })();
      };
      const fail = (error: unknown): void => { if (cleanup()) reject(error); };
      const cancel = (): void => { cancelRemote(); fail(request.signal.reason); };
      pending.set(id, { resolve: (response) => { if (cleanup()) resolve(response); }, reject: fail });
      request.signal.addEventListener('abort', cancel, { once: true });
      // This exact closed-schema route borrows Jev's one central retry owner.
      // Other unary calls retain the ordinary request timeout. Neither branch
      // changes source/reference expiry or authorization checks in the daemon.
      if (request.method !== 'POST' || url.pathname !== '/api/judgment/batteries/run' || url.search !== '') {
        timer = setTimeout(() => {
          cancelRemote();
          fail(new GoodVibesSdkError('Relay request timed out.', { category: 'timeout', source: 'transport', recoverable: true }));
        }, requestTimeoutMs);
      }
      if (request.signal.aborted) { cancel(); return; }
      void sendFrame(frame, activeChannel, activeSocket, () => pending.has(id), () => { sent = true; }).catch(fail);
    });
  };

  return {
    fetch: relayFetch,
    connect,
    close: () => teardown(),
    get ready(): boolean {
      return channel !== null;
    },
  };
}
