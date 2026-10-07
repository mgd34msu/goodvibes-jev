import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import type { Dispatcher } from 'undici/index.js';

function requestStream(request: Request): { body: Readable | null; close(): Promise<void> } {
  const reader = request.body?.getReader();
  if (!reader) return { body: null, close: async () => {} };
  let closed = false;
  let retirement: Promise<void> | undefined;
  let reading: Promise<void> | undefined;
  const cancel = () => retirement ??= (async () => {
    closed = true;
    try { await reader.cancel(); } catch { /* Sanitized by the owning request. */ }
    await reading;
    reader.releaseLock();
  })();
  // Do not use Bun's fromWeb destroy callback: it can report retirement before
  // an asynchronous source cancel hook settles. Keep that promise owned here.
  const body = new Readable({
    read() {
      reading = (async () => {
        try {
          const next = await reader.read();
          if (closed) return;
          if (next.done) this.push(null);
          else this.push(next.value);
        } catch { if (!closed) this.destroy(new Error('request body failed')); }
      })();
    },
    destroy(error, callback) { void cancel().then(() => callback(error), () => callback(error)); },
  });
  const done = finished(body, { cleanup: true }).then(() => {}, () => {});
  return { body, async close() { body.destroy(); await cancel(); await done; } };
}

async function retire(body: Readable): Promise<void> {
  const done = finished(body, { cleanup: true }).then(() => {}, () => {});
  body.destroy();
  await done;
}

function responseStream(body: Readable): ReadableStream<Uint8Array> {
  const done = finished(body, { cleanup: true }).then(() => {}, () => {});
  const iterator = body[Symbol.asyncIterator]();
  let cancelled = false;
  // Bun 1.3.14's Readable.toWeb can enqueue an already scheduled data event
  // after cancellation. Own the iterator instead, checking cancellation after
  // each await and waiting for actual stream retirement before cancel settles.
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (cancelled) return;
        if (next.done) { controller.close(); return; }
        const bytes: unknown = next.value;
        if (!(bytes instanceof Uint8Array)) throw new Error('invalid body chunk');
        controller.enqueue(bytes);
      } catch (error) { if (!cancelled) controller.error(error); }
    },
    async cancel() {
      cancelled = true;
      body.destroy();
      try { await iterator.return?.(); } catch { /* The fixed outer boundary sanitizes errors. */ }
      await done;
    },
  }, { highWaterMark: 0 });
}

/** Private adapter over a fixed-origin dispatcher; never native/global fetch. */
export async function fetchDirect(client: Dispatcher, request: Request, signal: AbortSignal): Promise<Response> {
  const url = new URL(request.url);
  const input = requestStream(request);
  let response: Dispatcher.ResponseData;
  try {
    response = await client.request({ path: url.pathname, method: 'POST',
      headers: Object.fromEntries(request.headers), body: input.body, signal });
  } finally { await input.close(); }
  try {
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) throw new Error('redirect');
    const headers = new Headers();
    const retryAfter = response.headers['retry-after'];
    if (typeof retryAfter === 'string') headers.set('retry-after', retryAfter);
    if ([204, 205, 304].includes(response.statusCode)) {
      await response.body.dump({ limit: 256 * 1024, signal });
      return new Response(null, { status: response.statusCode, headers });
    }
    return new Response(responseStream(response.body), {
      status: response.statusCode, headers,
    });
  } catch (error) {
    await retire(response.body);
    throw error;
  }
}
