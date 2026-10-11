import { afterEach, expect, test } from 'bun:test';
import { createMemorySpineRestTransport } from '../../runtime/memory-spine-rest-transport.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('stable Agent transport methods reach the real loopback HTTP endpoint', async () => {
  let requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    requests++;
    expect(request.headers.get('authorization')).toBe('Bearer synthetic-memory-token');
    return Response.json({ record: null });
  } });
  cleanups.push(() => server.stop(true));
  const transport = createMemorySpineRestTransport({
    resolveConnection: () => ({ baseUrl: server.url.origin, token: 'synthetic-memory-token' }),
  });
  expect(transport.get).toBe(transport.get);
  expect(transport.add).toBe(transport.add);
  expect(await transport.get('synthetic-record')).toBeNull();
  expect(requests).toBe(1);
});

test('caller cancellation prevents credential resolution and HTTP dispatch', async () => {
  let resolutions = 0;
  const controller = new AbortController(), reason = new Error('cancel before credentials');
  controller.abort(reason);
  const transport = createMemorySpineRestTransport({ resolveConnection: () => {
    resolutions++;
    return { baseUrl: 'http://127.0.0.1:1', token: 'synthetic-memory-token' };
  } });
  await expect(transport.get('cancelled', { signal: controller.signal })).rejects.toBe(reason);
  expect(resolutions).toBe(0);
});

test('the Agent timeout adapter preserves caller cancellation during a held HTTP response', async () => {
  const started = deferred<void>(), release = deferred<void>();
  let released = false;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch() {
    started.resolve();
    await release.promise;
    return Response.json({ record: null });
  } });
  cleanups.push(() => { release.resolve(); server.stop(true); });
  const transport = createMemorySpineRestTransport({
    resolveConnection: () => ({ baseUrl: server.url.origin, token: 'synthetic-memory-token' }),
    timeoutMs: 30_000,
  });
  const controller = new AbortController(), reason = new Error('cancel held Agent HTTP response');
  const pending = transport.get('held', { signal: controller.signal });
  await started.promise;
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(released).toBe(false);
  released = true;
  release.resolve();
});

test('a successful HTTP response is held when the outer source retires', async () => {
  let current = true, requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    requests++; current = false;
    return Response.json({ record: null });
  } });
  cleanups.push(() => server.stop(true));
  const transport = createMemorySpineRestTransport({
    resolveConnection: () => ({ baseUrl: server.url.origin, token: 'synthetic-memory-token' }),
  });
  await expect(transport.get('retired', { assertCurrent: () => {
    if (!current) throw new Error('retired outer memory source');
  } })).rejects.toThrow('retired outer memory source');
  expect(requests).toBe(1);
});

test('credential incarnation changes retire a captured connection scope', () => {
  const connection = { baseUrl: 'http://127.0.0.1:1', token: 'first-synthetic-token' };
  const transport = createMemorySpineRestTransport({ resolveConnection: () => connection });
  const scope = transport.captureOperationScope?.();
  expect(scope).toBeDefined();
  scope?.();
  connection.token = 'second-synthetic-token';
  expect(() => scope?.()).toThrow('Memory spine connection changed');
});

test('credential changes during HTTP work hold the successful result', async () => {
  const connection = { baseUrl: '', token: 'first-synthetic-token' };
  let requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    requests++;
    expect(request.headers.get('authorization')).toBe('Bearer first-synthetic-token');
    connection.token = 'second-synthetic-token';
    return Response.json({ record: null });
  } });
  connection.baseUrl = server.url.origin;
  cleanups.push(() => server.stop(true));
  const transport = createMemorySpineRestTransport({ resolveConnection: () => connection });
  await expect(transport.get('old-credentials')).rejects.toThrow('Memory spine connection changed');
  expect(requests).toBe(1);
});
