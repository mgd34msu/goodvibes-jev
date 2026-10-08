export interface DaemonDoor {
  readonly port: number;
  /** Every request that reached the door while a daemon was behind it: path with query. */
  readonly seen: string[];
  /** Close any previous listener completely, then forward to the new daemon. */
  open(upstreamPort: number): Promise<void>;
  /** Resolve only after the owned listener closes and its port refuses connections. */
  close(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * The configured daemon port, held by the test: while open it forwards every
 * HTTP request to a real daemon on another port and records its path; while
 * closed nothing listens there. The Agent sees one daemon that goes away and
 * comes back; the test sees exactly which calls the Agent made and when.
 */
export function createDaemonDoor(port: number): DaemonDoor {
  const seen: string[] = [];
  let listener: { server: ReturnType<typeof Bun.serve>; requests: AbortController } | null = null;
  let pending = Promise.resolve();

  function enqueue(operation: () => Promise<void>): Promise<void> {
    const result = pending.then(operation);
    // Report failure to this caller, but leave owned cleanup available afterward.
    pending = result.catch(() => {});
    return result;
  }

  async function closeListener(): Promise<void> {
    if (!listener) return;
    // Force downstream connections closed and cancel outgoing fetches. Bun
    // still waits for pending handlers, including those awaiting upstream headers.
    const stopped = listener.server.stop(true);
    listener.requests.abort();
    await stopped;
    // Retain the actual owner until stop succeeds. The queue prevents a new
    // listener from binding while this one is closing, even for overlapping calls.
    listener = null;
  }

  return {
    port,
    seen,
    open(upstreamPort) {
      return enqueue(async () => {
        await closeListener();
        const requests = new AbortController();
        const server = Bun.serve({
          port,
          hostname: '127.0.0.1',
          // The Agent holds a long-lived event stream open through the door.
          idleTimeout: 0,
          async fetch(req) {
            const url = new URL(req.url);
            seen.push(`${req.method} ${url.pathname}${url.search}`);
            const target = `http://127.0.0.1:${upstreamPort}${url.pathname}${url.search}`;
            const headers = new Headers(req.headers);
            headers.delete('host');
            try {
              const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
              const upstream = await fetch(target, { method: req.method, headers, body, redirect: 'manual', signal: requests.signal });
              // Give this listener an owned response stream. Passing Bun's native
              // fetch body through directly can retain a pending server request
              // after stop(true), even after the downstream connection closes.
              const responseBody = upstream.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>());
              return new Response(responseBody, { status: upstream.status, headers: upstream.headers });
            } catch {
              return new Response('upstream unavailable', { status: 502 });
            }
          },
        });
        listener = { server, requests };
      });
    },
    close() { return enqueue(closeListener); },
    stop() { return enqueue(closeListener); },
  };
}
