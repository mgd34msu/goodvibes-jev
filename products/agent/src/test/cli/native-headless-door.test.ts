import { expect, test } from 'bun:test';
import { nativeDoor } from './native-headless-process-harness.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('headless door stop cancels its upstream fetch before headers arrive', async () => {
  const entered = deferred();
  const release = deferred();
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch() {
    entered.resolve();
    await release.promise;
    return new Response('late');
  } });
  const door = nativeDoor(`http://127.0.0.1:${upstream.port}`);
  const request = fetch(`${door.baseUrl}/pending`).then(response => response.text()).catch(() => 'closed');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await entered.promise;
    const stopped = door.stop();
    // A broken owner cannot hang the regression itself or strand its upstream.
    const outcome = await Promise.race([
      stopped.then(() => 'closed'),
      new Promise<string>(resolve => { timer = setTimeout(() => resolve('still waiting for upstream'), 2000); }),
    ]);
    expect(outcome).toBe('closed');
    await expect(fetch(`${door.baseUrl}/closed`)).rejects.toThrow();
  } finally {
    clearTimeout(timer);
    release.resolve();
    await door.stop();
    await request;
    await upstream.stop(true);
  }
});

test('headless door owns and closes a forwarded live response stream', async () => {
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch: () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('ready')); },
    })),
  });
  const door = nativeDoor(`http://127.0.0.1:${upstream.port}`);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = (await fetch(`${door.baseUrl}/stream`)).body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('ready');
    const ended = reader.read().then(result => result.done, () => true);
    await door.stop();
    expect(await ended).toBe(true);
    await door.stop();
  } finally {
    await reader?.cancel().catch(() => {});
    await door.stop();
    await upstream.stop(true);
  }
});
