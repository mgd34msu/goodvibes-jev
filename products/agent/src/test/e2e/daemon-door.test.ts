import { describe, expect, spyOn, test } from 'bun:test';
import { createServer } from 'node:net';
import { createDaemonDoor } from './daemon-door.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function unusedPort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Missing reserved port');
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function upstream(text: string) {
  return Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(text) });
}

function observe(promise: Promise<void>) {
  const outcome = { settled: false, error: undefined as unknown };
  const done = promise.then(
    () => { outcome.settled = true; },
    (error: unknown) => { outcome.settled = true; outcome.error = error; },
  );
  return { outcome, done };
}

describe('daemon door listener ownership', () => {
  for (const explicitlyClose of [false, true]) {
    test(`${explicitlyClose ? 'close then open' : 'open replacement'} waits for the owned listener stop to finish`, async () => {
      const first = upstream('first');
      const next = upstream('next');
      const port = await unusedPort();
      const door = createDaemonDoor(port);
      // Observe real Bun servers; only gate the completion of the old listener's stop.
      const serve = spyOn(Bun, 'serve');
      const stopEntered = deferred();
      const releaseStop = deferred();
      let closing: ReturnType<typeof observe> | undefined;
      let reopening: ReturnType<typeof observe> | undefined;
      let restoreStop = () => {};
      try {
        await door.open(first.port!);
        const created = serve.mock.results[0];
        if (created?.type !== 'return') throw new Error('Door listener was not created');
        const listener = created.value;
        const actualStop = listener.stop.bind(listener);
        const stop = spyOn(listener, 'stop').mockImplementation(async (force?: boolean) => {
          stopEntered.resolve();
          await releaseStop.promise;
          await actualStop(force);
        });
        restoreStop = () => { stop.mockRestore(); };
        expect(await (await fetch(`http://127.0.0.1:${port}/before`)).text()).toBe('first');
        if (explicitlyClose) closing = observe(Promise.resolve(door.close()));
        reopening = observe(Promise.resolve().then(() => door.open(next.port!)));
        await stopEntered.promise;
        // The old listener still owns this port while its stop is gated. A real
        // request gives both queued lifecycle calls an opportunity to settle.
        await fetch(`http://127.0.0.1:${port}/while-closing`).then((response) => response.text());
        expect(closing?.outcome.settled ?? false).toBe(false);
        expect(reopening.outcome.settled).toBe(false);
        expect(serve).toHaveBeenCalledTimes(1);
        expect(stop).toHaveBeenCalledTimes(1);
        expect(stop).toHaveBeenCalledWith(true);
        releaseStop.resolve();
        await closing?.done;
        await reopening.done;
        expect(closing?.outcome.error).toBeUndefined();
        expect(reopening.outcome.error).toBeUndefined();
        expect(await (await fetch(`http://127.0.0.1:${port}/after`)).text()).toBe('next');
        expect(serve).toHaveBeenCalledTimes(2);
      } finally {
        releaseStop.resolve();
        await closing?.done;
        await reopening?.done;
        restoreStop();
        serve.mockRestore();
        await door.stop();
        await first.stop(true);
        await next.stop(true);
      }
    });
  }

  test('close cancels a proxy request still waiting for upstream headers before awaiting the listener', async () => {
    const requestEntered = deferred();
    const releaseResponse = deferred();
    const waitingUpstream = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      async fetch() {
        requestEntered.resolve();
        await releaseResponse.promise;
        return new Response('late response');
      },
    });
    const next = upstream('replacement');
    const port = await unusedPort();
    const door = createDaemonDoor(port);
    let request: Promise<unknown> | undefined;
    try {
      await door.open(waitingUpstream.port!);
      request = fetch(`http://127.0.0.1:${port}/waiting`).then(
        (response) => response.text(),
        (error: unknown) => error,
      );
      await requestEntered.promise;
      // No upstream response is released until cleanup. close must cancel its
      // own outgoing fetch, or Bun's real stop promise cannot finish.
      const closed = door.close();
      expect(closed).toBeInstanceOf(Promise);
      await closed;
      await expect(fetch(`http://127.0.0.1:${port}/closed`)).rejects.toThrow();
      await door.open(next.port!);
      expect(await (await fetch(`http://127.0.0.1:${port}/returned`)).text()).toBe('replacement');
      expect(door.seen).toEqual(['GET /waiting', 'GET /returned']);
    } finally {
      releaseResponse.resolve();
      await door.stop();
      await request;
      await waitingUpstream.stop(true);
      await next.stop(true);
    }
  });

  test('stop closes a real long-lived event stream and releases the same port for a new owner', async () => {
    const streaming = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      fetch: () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('data: ready\n\n')); },
      }), { headers: { 'content-type': 'text/event-stream' } }),
    });
    const port = await unusedPort();
    const door = createDaemonDoor(port);
    let replacement: ReturnType<typeof upstream> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      await door.open(streaming.port!);
      const response = await fetch(`http://127.0.0.1:${port}/events`);
      reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: ready\n\n');
      const ended = reader.read().then((result) => result.done, () => true);
      const stopped = door.stop();
      expect(stopped).toBeInstanceOf(Promise);
      await stopped;
      expect(await ended).toBe(true);
      replacement = Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response('new owner') });
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('new owner');
      // Idempotent teardown must not affect the new listener using the old port.
      await door.close();
      await door.stop();
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('new owner');
    } finally {
      await reader?.cancel().catch(() => {});
      await door.stop();
      await replacement?.stop(true);
      await streaming.stop(true);
    }
  });

  test('a failed stop rejects replacement and retains the old listener for owned cleanup', async () => {
    const first = upstream('first');
    const next = upstream('next');
    const door = createDaemonDoor(await unusedPort());
    const serve = spyOn(Bun, 'serve');
    let restoreStop = () => {};
    try {
      await door.open(first.port!);
      const created = serve.mock.results[0];
      if (created?.type !== 'return') throw new Error('Door listener was not created');
      const listener = created.value;
      const failure = new Error('listener stop failed');
      const stop = spyOn(listener, 'stop').mockRejectedValueOnce(failure);
      restoreStop = () => { stop.mockRestore(); };
      await expect(door.open(next.port!)).rejects.toBe(failure);
      expect(serve).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledTimes(1);
      await door.close();
      expect(stop).toHaveBeenCalledTimes(2);
      await expect(fetch(`http://127.0.0.1:${door.port}/closed`)).rejects.toThrow();
    } finally {
      restoreStop();
      serve.mockRestore();
      await door.stop();
      await first.stop(true);
      await next.stop(true);
    }
  });
});
