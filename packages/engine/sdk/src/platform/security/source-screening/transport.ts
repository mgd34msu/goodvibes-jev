import { Client, interceptors } from 'undici/index.js';
import * as directClient from './direct-client.js';

const RESPONSE_LIMIT = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 120_000;

const diagnostics = new WeakSet<object>();
function diagnostic(message: string): Error {
  const error = new Error(message);
  diagnostics.add(error);
  return error;
}

const invalidEndpoint = () => diagnostic('source-screening endpoint is not an explicit literal-loopback target');
const invalidRequest = () => diagnostic('source-screening transport request is not allowed');
const cancelled = () => diagnostic('source-screening transport was cancelled');
const unauthorized = () => diagnostic('source-screening transport authority is no longer current');
const timedOut = () => diagnostic('source-screening transport timed out');
const failed = () => diagnostic('source-screening transport did not return a usable response');
const oversized = () => diagnostic('source-screening response exceeds the byte limit');
const routeUnavailable = () => diagnostic('source-screening local route is unavailable');

/**
 * Visible proxy configuration withholds admission even though dispatch uses
 * an explicitly owned socket client. Bun's native fetch can retain a proxy
 * after its environment entry is deleted, so absence alone is NOT the direct
 * routing proof: the fixed-origin Client below never uses native fetch or an
 * ambient/global dispatcher.
 * NO_PROXY is not an owner grant. Read only a presence bit, never retain or
 * print proxy values (which can themselves contain credentials).
 */
function requireDirectRoute(): void {
  // Bun's lazily materialized standard proxy keys can be non-enumerable after
  // assignment. Test the known spellings explicitly, then discover variants.
  const names = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
    ...Object.getOwnPropertyNames(process.env).filter((name) => ['http_proxy', 'https_proxy', 'all_proxy'].includes(name.toLowerCase()))]);
  if ([...names].some((name) => process.env[name] !== undefined && process.env[name] !== '')) throw routeUnavailable();
}

/** Capture syntax before URL parsing can repair a non-literal or ambiguous address. */
export function captureLoopbackEndpoint(value: string): string {
  if (typeof value !== 'string') throw invalidEndpoint();
  const match = /^(https?):\/\/(127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})\/?$/.exec(value);
  if (!match || match[0] !== value || Number(match[3]) > 65_535) throw invalidEndpoint();
  // Retain explicit default ports too: this value is an owner-captured base URL.
  return `${match[1]}://${match[2]}:${match[3]}`;
}

function captureTargets(endpoints: readonly string[]): Set<string> {
  if (!Array.isArray(endpoints) || endpoints.length === 0) throw invalidEndpoint();
  const targets = new Set<string>();
  for (const endpoint of endpoints) {
    if (typeof endpoint !== 'string') throw invalidEndpoint();
    const match = /^(https?:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9]\d{0,4})(\/v1\/(?:systemone|chat\/completions))$/.exec(endpoint);
    if (!match || match[0] !== endpoint) throw invalidEndpoint();
    const captured = `${captureLoopbackEndpoint(match[1]!)}${match[2]}`;
    targets.add(captured);
    // URL and Request serialize explicit default ports away. These two exact
    // spellings have the same captured destination; other repairs are rejected.
    targets.add(new URL(captured).href);
  }
  return targets;
}

function safeHeaders(response: { readonly headers: { get(name: string): string | null } }): Headers {
  const headers = new Headers({ 'content-type': 'application/json' });
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter !== null && retryAfter.length <= 32 && /^\d+(?:\.\d+)?$/.test(retryAfter)
    && Number.isFinite(Number(retryAfter)) && Number(retryAfter) <= Number.MAX_SAFE_INTEGER / 1_000) {
    headers.set('retry-after', retryAfter);
  }
  return headers;
}

interface ScreeningTransportOptions {
  /** Exact full /v1/chat/completions and /v1/systemone targets, captured by the owner. */
  readonly endpoints: readonly string[];
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
  readonly timeoutMs?: number;
}

interface ScreeningTransport {
  /** Check current admission/authority and direct routing before a logical retry. */
  assertUsable(): void;
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  /** Wait for the current underlying-operation snapshot without fencing admission. */
  drain(): Promise<void>;
  close(): Promise<void>;
}

/**
 * A private, bounded loopback boundary, not another retry owner. The canonical
 * judgment client can stop awaiting a cancelled call before its actual fetch
 * settles. Keep that fetch, every body read, and cancellation cleanup owned
 * until they settle; close must never mistake the SDK's race for a drain.
 */
export function createScreeningTransport(options: ScreeningTransportOptions): ScreeningTransport {
  const targets = captureTargets(options.endpoints);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw invalidRequest();
  const assertCurrent = options.assertCurrent;
  const sourceSignal = options.signal;
  const lifetime = new AbortController();
  const actualFetch = directClient.fetchDirect;
  const clients = new Map<string, Client>();
  const active = new Set<Promise<Response>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const stop = () => lifetime.abort(cancelled());
  sourceSignal.addEventListener('abort', stop, { once: true });
  if (sourceSignal.aborted) stop();

  function check(signal?: AbortSignal): void {
    if (closed || sourceSignal.aborted || lifetime.signal.aborted) throw cancelled();
    if (signal?.aborted) throw signal.reason;
    try {
      const result: unknown = assertCurrent();
      // An async hook must not silently authorize transmission before it fails.
      if (result !== null && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
        void Promise.resolve(result).catch(() => {});
        throw unauthorized();
      }
    } catch { throw unauthorized(); }
    if (closed || sourceSignal.aborted || lifetime.signal.aborted) throw cancelled();
    if (signal?.aborted) throw signal.reason;
  }

  return {
    assertUsable() { check(); requireDirectRoute(); },
    async fetch(input, init) {
      check();
      let request: Request;
      try {
        const address = typeof input === 'string' ? input : input instanceof URL ? input.href : input instanceof Request ? input.url : undefined;
        if (address === undefined || !targets.has(address)) throw invalidRequest();
        // Request admits standard fetch options only. In particular, do not
        // forward Bun proxy/unix/TLS/dispatcher extensions from a caller's init.
        request = new Request(input, { ...init, redirect: 'error', credentials: 'omit' });
        if (request.method !== 'POST' || !targets.has(request.url)) throw invalidRequest();
      } catch { throw invalidRequest(); }
      check();
      const controller = new AbortController();
      const abort = () => controller.abort(cancelled());
      lifetime.signal.addEventListener('abort', abort, { once: true });
      request.signal.addEventListener('abort', abort, { once: true });
      if (lifetime.signal.aborted || request.signal.aborted) abort();
      const timer = setTimeout(() => controller.abort(timedOut()), timeoutMs);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let cancellation: Promise<void> | undefined;
      let bodyFinished = false;
      const cancelBody = () => {
        if (reader && !bodyFinished && !cancellation) {
          try { cancellation = reader.cancel().then(() => {}, () => {}); }
          catch { cancellation = Promise.resolve(); }
        }
      };
      controller.signal.addEventListener('abort', cancelBody, { once: true });
      // Register before invoking any asynchronous work or caller hook again.
      const work = Promise.resolve().then(async () => {
        try {
          check(controller.signal);
          // No await or owner/caller hook may run between this check and
          // dispatch. Recheck each attempt, including canonical SDK retries.
          requireDirectRoute();
          const origin = new URL(request.url).origin;
          let client = clients.get(origin);
          if (!client) {
            // Undici's own HTTP/1.1 implementation connects through net/TLS to
            // this captured literal origin. Never use EnvHttpProxyAgent,
            // getGlobalDispatcher, Bun fetch, or caller-supplied connectors.
            client = new Client(origin, { pipelining: 0, allowH2: false,
              connect: { rejectUnauthorized: true },
              maxHeaderSize: 16 * 1024, connectTimeout: timeoutMs,
              headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
            clients.set(origin, client);
          }
          const response = await actualFetch(client.compose(interceptors.decompress({ maxSize: RESPONSE_LIMIT })), request, controller.signal);
          reader = response.body?.getReader();
          check(controller.signal);
          const chunks: Uint8Array[] = [];
          let size = 0;
          if (reader) {
            for (;;) {
              check(controller.signal);
              const next = await reader.read();
              check(controller.signal);
              if (next.done) { bodyFinished = true; break; }
              if (!(next.value instanceof Uint8Array) || next.value.byteLength > RESPONSE_LIMIT - size) throw oversized();
              size += next.value.byteLength;
              chunks.push(next.value);
            }
          }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          check(controller.signal);
          // No URL, status text, request ID, arbitrary headers, or upstream
          // errors accompany the bounded bytes handed to the canonical client.
          return new Response([204, 205, 304].includes(response.status) ? null : bytes, {
            status: response.status, headers: safeHeaders(response),
          });
        } catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason;
          // Preserve only diagnostics constructed in this boundary, never an
          // upstream Error (whose message/cause can contain source material).
          if (error !== null && (typeof error === 'object' || typeof error === 'function') && diagnostics.has(error)) throw error;
          throw failed();
        } finally {
          cancelBody();
          // Do not race this cleanup: it remains owned even after cancellation
          // has already released the caller or the canonical SDK's await.
          await cancellation;
          reader?.releaseLock();
          clearTimeout(timer);
          controller.signal.removeEventListener('abort', cancelBody);
          lifetime.signal.removeEventListener('abort', abort);
          request.signal.removeEventListener('abort', abort);
        }
      });
      active.add(work);
      const release = () => { active.delete(work); };
      void work.then(release, release);
      let interrupt = () => {};
      const interrupted = new Promise<never>((_resolve, reject) => {
        interrupt = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', interrupt, { once: true });
        if (controller.signal.aborted) interrupt();
      });
      try { return await Promise.race([work, interrupted]); }
      finally { controller.signal.removeEventListener('abort', interrupt); }
    },
    drain() { return Promise.allSettled([...active]).then(() => {}); },
    close() {
      if (!closing) {
        closed = true;
        stop();
        sourceSignal.removeEventListener('abort', stop);
        closing = Promise.allSettled([...active]).then(async () => {
          await Promise.all([...clients.values()].map((client) => client.destroy()));
          clients.clear();
        });
      }
      return closing;
    },
  };
}
