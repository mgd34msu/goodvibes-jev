import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import * as directClient from '../sdk/src/platform/security/source-screening/direct-client.ts';
import { isolatedTestEnvironment } from '../scripts/test-isolation.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { captureLoopbackEndpoint, createScreeningTransport } from '../sdk/src/platform/security/source-screening/transport.ts';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function endpoint(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
  cleanups.push(() => server.stop(true));
  const base = `http://127.0.0.1:${server.port}`;
  return { base, url: `${base}/v1/systemone`, proposal: `${base}/v1/chat/completions`, server };
}

function transport(endpoints: readonly string[], extra: { signal?: AbortSignal; assertCurrent?: () => void; timeoutMs?: number } = {}) {
  const owner = createScreeningTransport({ endpoints, signal: extra.signal ?? new AbortController().signal,
    assertCurrent: extra.assertCurrent ?? (() => {}), timeoutMs: extra.timeoutMs ?? 1_000 });
  cleanups.push(() => owner.close());
  return owner;
}
const post = { method: 'POST', body: '{"synthetic":"local-source"}' };
const pause = (ms = 10) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Test-local response substitution after a real guarded loopback request. */
function replaceLocalResponse(transform: (response: Response) => Promise<Response>): void {
  const actualFetch = directClient.fetchDirect;
  const replacement: typeof directClient.fetchDirect = async (client, request, signal) => transform(await actualFetch(client, request, signal));
  const stub = spyOn(directClient, 'fetchDirect').mockImplementation(replacement);
  cleanups.push(() => stub.mockRestore());
}

async function isolatedProxyScenario(mode: string, name = 'HTTP_PROXY'): Promise<void> {
  const root = makeProjectTempDir('source-screening-proxy-child');
  try {
    const control = Bun.serve({ port: 0, fetch: () => new Response('parent-localhost') });
    cleanups.push(() => control.stop(true));
    const url = `http://localhost:${control.port}`;
    expect(await (await fetch(url)).text()).toBe('parent-localhost');
    const result = spawnSync(process.execPath, [
      '--preload', resolve(import.meta.dir, '../toolchain/src/test-runner/test-network-preload.ts'),
      resolve(import.meta.dir, 'fixtures/source-screening-proxy-child.ts'), mode, name,
    ], { env: isolatedTestEnvironment(process.env, root), encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' });
    expect(result.error?.message ?? null).toBeNull();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ mode, proxyCalls: 0, passed: true });
    // This control fails with the former in-process set/delete fixture even
    // though every process.env proxy name reads undefined after its finally.
    expect(await (await fetch(url)).text()).toBe('parent-localhost');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

async function rejection(work: Promise<unknown>): Promise<Error> {
  try { await work; throw new Error('expected transport rejection'); }
  catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toStartWith('source-screening ');
    expect((error as Error).cause).toBeUndefined();
    return error as Error;
  }
}

describe('source-screening literal-loopback endpoint capture', () => {
  test.each([
    ['http://127.0.0.1:1', 'http://127.0.0.1:1'],
    ['http://127.0.0.1:80/', 'http://127.0.0.1:80'],
    ['https://127.0.0.1:443', 'https://127.0.0.1:443'],
    ['https://[::1]:65535/', 'https://[::1]:65535'],
  ])('captures %s without silently dropping its explicit port', (input, expected) => {
    expect(captureLoopbackEndpoint(input)).toBe(expected!);
  });

  test.each([
    '', 'http://localhost:1234', 'http://127.1:1234', 'http://127.0.0.2:1234',
    'http://2130706433:1234', 'http://0x7f000001:1234', 'http://0177.0.0.1:1234',
    'http://127.000.000.001:1234', 'http://[::ffff:127.0.0.1]:1234',
    'http://[0:0:0:0:0:0:0:1]:1234', 'http://127.0.0.1', 'https://[::1]',
    'HTTP://127.0.0.1:1234', 'http:127.0.0.1:1234', 'http:/127.0.0.1:1234',
    'http:////127.0.0.1:1234', 'ftp://127.0.0.1:1234',
    ' http://127.0.0.1:1234', 'http://127.0.0.1:1234\n', 'http://127.0.0.1:\t1234',
    'http://127.0.0.1:1234\\', 'http://127.0.0.1:1234/.', 'http://127.0.0.1:1234//',
    'http://127.0.0.1:1234/path', 'http://127.0.0.1:1234?', 'http://127.0.0.1:1234#',
    'http://user:secret@127.0.0.1:1234', 'http://@127.0.0.1:1234',
    'http://127.0.0.1:0', 'http://127.0.0.1:01234', 'http://127.0.0.1:+1234',
    'http://127.0.0.1:65536', 'http://127.0.0.1:999999',
  ])('rejects ambiguous or unauthorized syntax: %s', (input) => {
    expect(() => captureLoopbackEndpoint(input)).toThrow('source-screening endpoint');
  });
});

describe('source-screening exact loopback transport', () => {
  test('accepts only the captured full targets, including Request and URL inputs', async () => {
    const calls: { path: string; method: string; body: string }[] = [];
    const local = endpoint(async (request) => {
      calls.push({ path: new URL(request.url).pathname, method: request.method, body: await request.text() });
      return Response.json({ allowed: true });
    });
    const configured = [local.url, local.proposal];
    const owned = transport(configured);
    configured[0] = `${local.base}/changed`;
    expect(await (await owned.fetch(local.url, post)).json()).toEqual({ allowed: true });
    await owned.fetch(new URL(local.proposal), post);
    await owned.fetch(new Request(local.url, post));
    expect(calls).toEqual([
      { path: '/v1/systemone', method: 'POST', body: post.body },
      { path: '/v1/chat/completions', method: 'POST', body: post.body },
      { path: '/v1/systemone', method: 'POST', body: post.body },
    ]);
  });

  test('rejects all other methods, paths, ports, queries and repaired string targets before transmission', async () => {
    let calls = 0;
    const local = endpoint(() => { calls++; return Response.json({}); });
    const other = endpoint(() => { calls++; return Response.json({}); });
    const owned = transport([local.url]);
    for (const input of [local.proposal, `${local.url}/`, `${local.url}?`, `${local.url}#fragment`,
      `${local.base}/v1/./systemone`, local.url.replace('127.0.0.1', '127.1'), `${local.url}\n`, other.url]) {
      expect((await rejection(owned.fetch(input, post))).message).toContain('not allowed');
    }
    for (const method of ['GET', 'DELETE', 'PUT', 'HEAD']) {
      await rejection(owned.fetch(local.url, { method }));
    }
    expect(calls).toBe(0);
  });

  test('validates the entire target list and timeout before use', () => {
    for (const endpoints of [[], ['http://127.0.0.1:1234'], ['http://127.0.0.1:1234/other'],
      ['http://127.0.0.1:1234/v1/systemone', 'http://localhost:1234/v1/systemone']]) {
      expect(() => transport(endpoints)).toThrow('source-screening endpoint');
    }
    for (const timeoutMs of [0, -1, 1.1, NaN, Infinity, 120_001]) {
      expect(() => transport(['http://127.0.0.1:1234/v1/systemone'], { timeoutMs })).toThrow('source-screening transport request');
    }
  });

  test('does not forward redirects or arbitrary headers and preserves bounded error status/body once', async () => {
    let calls = 0;
    const local = endpoint(() => {
      calls++;
      return new Response('{"error":"synthetic-error-body"}', { status: 503, statusText: 'synthetic-secret-status', headers: {
        'content-type': 'text/plain; synthetic=source-secret',
        'x-typesafe-request-id': 'synthetic-source-secret', 'set-cookie': 'source=secret',
        'retry-after': '1.25', 'retry-after-ms': 'source-secret', 'x-source': 'secret',
      } });
    });
    const response = await transport([local.url]).fetch(local.url, post);
    expect(response.status).toBe(503);
    expect(response.statusText).toBe('');
    expect(response.url).toBe('');
    expect([...response.headers]).toEqual([['content-type', 'application/json'], ['retry-after', '1.25']]);
    expect(await response.text()).toBe('{"error":"synthetic-error-body"}');
    expect(calls).toBe(1);
  });

  test.each(['Wed, 21 Oct 2026 07:28:00 GMT', 'secret-header', '-1', '1e3', 'Infinity', '1'.repeat(40)])(
    'drops non-numeric or out-of-bounds Retry-After: %s', async (retryAfter) => {
      const local = endpoint(() => new Response('{}', { headers: { 'retry-after': retryAfter } }));
      const response = await transport([local.url]).fetch(local.url, post);
      expect([...response.headers]).toEqual([['content-type', 'application/json']]);
    },
  );

  test('never follows a redirect, including another loopback target', async () => {
    let redirectCalls = 0;
    const target = endpoint(() => { redirectCalls++; return Response.json({}); });
    const local = endpoint(() => Response.redirect(target.url, 307));
    const error = await rejection(transport([local.url, target.url]).fetch(local.url, { ...post, redirect: 'follow' }));
    expect(error.message).toBe('source-screening transport did not return a usable response');
    expect(redirectCalls).toBe(0);
  });

  test('ignores nonstandard routing overrides instead of passing them to the fixed client', async () => {
    let calls = 0;
    const local = endpoint(() => { calls++; return Response.json({}); });
    const init = { ...post, proxy: 'http://127.0.0.1:1', unix: '/does-not-exist/source-screening.sock' };
    await transport([local.url]).fetch(local.url, init);
    expect(calls).toBe(1);
  });

  // Bun 1.3.14 retains native proxy routing even after process.env restoration.
  // Own each mutation in a child so neither aliases nor native caches can leak
  // into another test's localhost requests. The canonical network guard remains.
  test.each(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'HtTp_PrOxY', 'HtTpS_PrOxY', 'AlL_PrOxY'])(
    'a configured %s refuses dispatch even when NO_PROXY names the target', async (name) => {
      await isolatedProxyScenario('configured', name);
    },
  );

  test('rechecks proxy environment at dispatch after the last authority callback', async () => {
    await isolatedProxyScenario('after-authority');
  });

  test('assertUsable checks proxy, authority and admission without creating a network request', async () => {
    await isolatedProxyScenario('assert-usable');
  });

  test('refuses a new attempt when proxy configuration appears after a successful dispatch', async () => {
    await isolatedProxyScenario('next-dispatch');
  });

  test('canonical judgment retry refuses a proxy that appears after the first attempt', async () => {
    await isolatedProxyScenario('judgment-retry');
  });

  test('stale native proxy state before owner creation cannot redirect protected dispatch', async () => {
    await isolatedProxyScenario('stale-before-owner');
  });

  test('stale native proxy state between dispatches cannot redirect protected dispatch', async () => {
    await isolatedProxyScenario('stale-between-dispatches');
  });

  test('ambient TLS-disable state cannot authorize an invalid local certificate', async () => {
    await isolatedProxyScenario('tls-reject');
  });

  test('accepts the byte limit and rejects one byte over using actual received bytes', async () => {
    const maximum = 256 * 1024;
    let size = maximum;
    const local = endpoint(() => new Response(new Uint8Array(size)));
    const owned = transport([local.url]);
    expect((await (await owned.fetch(local.url, post)).arrayBuffer()).byteLength).toBe(maximum);
    size++;
    expect((await rejection(owned.fetch(local.url, post))).message).toContain('exceeds the byte limit');
    await owned.drain();
  });

  test('counts decoded bytes rather than trusting compressed Content-Length', async () => {
    const compressed = Bun.gzipSync(new Uint8Array(256 * 1024 + 1));
    expect(compressed.byteLength).toBeLessThan(1024);
    const local = endpoint(() => new Response(compressed, { headers: { 'content-encoding': 'gzip' } }));
    expect((await rejection(transport([local.url]).fetch(local.url, post))).message).toBe('source-screening transport did not return a usable response');
  });

  test('checks current authority before sending without leaking a hook error', async () => {
    let calls = 0;
    const local = endpoint(() => { calls++; return Response.json({}); });
    const owned = transport([local.url], { assertCurrent() { throw new Error('synthetic-source-secret'); } });
    const error = await rejection(owned.fetch(local.url, post));
    expect(error.message).toBe('source-screening transport authority is no longer current');
    expect(calls).toBe(0);
  });

  test('rejects asynchronous authority hooks before sending', async () => {
    let calls = 0;
    const local = endpoint(() => { calls++; return Response.json({}); });
    const owned = transport([local.url], { assertCurrent: async () => { throw new Error('synthetic-source-secret'); } });
    await rejection(owned.fetch(local.url, post));
    expect(calls).toBe(0);
  });

  test('rechecks authority after headers arrive and before handing back any body', async () => {
    let current = true;
    const local = endpoint(() => { current = false; return Response.json({ synthetic: 'secret-result' }); });
    const owned = transport([local.url], { assertCurrent() { if (!current) throw new Error('synthetic-source-secret'); } });
    expect((await rejection(owned.fetch(local.url, post))).message).toContain('authority is no longer current');
    await owned.drain();
  });

  test('revocation during a response body prevents late buffered bytes from escaping', async () => {
    const local = endpoint(() => Response.json({}));
    const reading = Promise.withResolvers<void>();
    let current = true;
    let body: ReadableStreamDefaultController<Uint8Array> | undefined;
    replaceLocalResponse(async (response) => {
      await response.body?.cancel();
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { body = controller; },
        pull() { reading.resolve(); },
      }, { highWaterMark: 0 }));
    });
    const owned = transport([local.url], { assertCurrent() { if (!current) throw new Error('synthetic-private-revocation'); } });
    const pending = owned.fetch(local.url, post);
    await reading.promise;
    current = false;
    body!.enqueue(new TextEncoder().encode('{"synthetic":"late-secret"}'));
    body!.close();
    expect((await rejection(pending)).message).toBe('source-screening transport authority is no longer current');
    await owned.drain();
  });

  test('deadline spans a stalled body after successful response headers', async () => {
    const started = Promise.withResolvers<void>();
    const local = endpoint(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{')); started.resolve(); },
    })));
    const owned = transport([local.url], { timeoutMs: 250 });
    const pending = owned.fetch(local.url, post);
    await started.promise;
    expect((await rejection(pending)).message).toBe('source-screening transport timed out');
    await owned.close();
  });

  test('caller and owner cancellation never expose external reasons', async () => {
    for (const cancelOwner of [false, true]) {
      const source = new AbortController();
      const caller = new AbortController();
      const started = Promise.withResolvers<void>();
      const local = endpoint(() => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array([123])); started.resolve(); },
      })));
      const owned = transport([local.url], { signal: source.signal });
      const pending = owned.fetch(local.url, { ...post, signal: caller.signal });
      await started.promise;
      (cancelOwner ? source : caller).abort(new Error('synthetic-secret-abort-reason'));
      expect((await rejection(pending)).message).toBe('source-screening transport was cancelled');
      await owned.close();
    }
  });

  test('close fences new admission, cancels pending bodies, and is idempotent', async () => {
    const started = Promise.withResolvers<void>();
    let calls = 0;
    const local = endpoint(() => { calls++; return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([123])); started.resolve(); },
    })); });
    const owned = transport([local.url]);
    const pending = owned.fetch(local.url, post);
    await started.promise;
    const closed = owned.close();
    expect(owned.close()).toBe(closed);
    await rejection(pending);
    await closed;
    await rejection(owned.fetch(local.url, post));
    expect(calls).toBe(1);
  });

  test('request-body cancellation cleanup remains owned through drain and close', async () => {
    const local = endpoint(() => Response.json({}));
    const started = Promise.withResolvers<void>();
    const cancellation = Promise.withResolvers<void>();
    const finishCleanup = Promise.withResolvers<void>();
    const body = new ReadableStream<Uint8Array>({
      pull() { started.resolve(); },
      cancel() { cancellation.resolve(); return finishCleanup.promise; },
    }, { highWaterMark: 0 });
    const owned = transport([local.url]);
    cleanups.push(() => finishCleanup.resolve());
    const caller = new AbortController();
    const pending = owned.fetch(local.url, { method: 'POST', body, signal: caller.signal });
    await started.promise;
    caller.abort();
    await rejection(pending);
    await cancellation.promise;
    let drained = false;
    let closed = false;
    const draining = owned.drain().then(() => { drained = true; });
    const closing = owned.close().then(() => { closed = true; });
    await pause();
    expect(drained).toBe(false);
    expect(closed).toBe(false);
    finishCleanup.resolve();
    await Promise.all([draining, closing]);
    expect(drained).toBe(true);
    expect(closed).toBe(true);
  });

  test('a cancelled caller returns early but drain and close await actual body cancellation cleanup', async () => {
    const local = endpoint(() => Response.json({}));
    const cancellation = Promise.withResolvers<void>();
    const finishCleanup = Promise.withResolvers<void>();
    const bodyRead = Promise.withResolvers<void>();
    const stream = new ReadableStream<Uint8Array>({
      pull() { bodyRead.resolve(); },
      cancel() { cancellation.resolve(); return finishCleanup.promise; },
    }, { highWaterMark: 0 });
    // Only this test substitutes an in-process body after a real loopback fetch.
    // No injection seam is exposed by the production transport.
    replaceLocalResponse(async (response) => {
      await response.body?.cancel();
      return new Response(stream);
    });
    const owned = transport([local.url]);
    cleanups.push(() => finishCleanup.resolve());
    const caller = new AbortController();
    const pending = owned.fetch(local.url, { ...post, signal: caller.signal });
    await bodyRead.promise;
    caller.abort(new Error('synthetic-private-reason'));
    await rejection(pending);
    await cancellation.promise;
    let drained = false;
    let closed = false;
    const draining = owned.drain().then(() => { drained = true; });
    const closing = owned.close().then(() => { closed = true; });
    await pause();
    expect(drained).toBe(false);
    expect(closed).toBe(false);
    finishCleanup.resolve();
    await Promise.all([draining, closing]);
    expect(drained).toBe(true);
    expect(closed).toBe(true);
  });

  test('a late underlying fetch remains owned after timeout and its late body is cancelled before close resolves', async () => {
    const local = endpoint(() => Response.json({}));
    const received = Promise.withResolvers<void>();
    const finishFetch = Promise.withResolvers<void>();
    const finishCancel = Promise.withResolvers<void>();
    const cancellation = Promise.withResolvers<void>();
    const stream = new ReadableStream<Uint8Array>({
      cancel() { cancellation.resolve(); return finishCancel.promise; },
    });
    replaceLocalResponse(async (response) => {
      await response.body?.cancel();
      received.resolve();
      // This local response delivery gate deliberately ignores cancellation.
      await finishFetch.promise;
      return new Response(stream);
    });
    const owned = transport([local.url], { timeoutMs: 250 });
    cleanups.push(() => { finishFetch.resolve(); finishCancel.resolve(); });
    const pending = owned.fetch(local.url, post);
    await received.promise;
    expect((await rejection(pending)).message).toBe('source-screening transport timed out');
    let closed = false;
    const closing = owned.close().then(() => { closed = true; });
    await pause();
    expect(closed).toBe(false);
    finishFetch.resolve();
    await cancellation.promise;
    await pause();
    expect(closed).toBe(false);
    finishCancel.resolve();
    await closing;
    expect(closed).toBe(true);
  });

  test('hostile body rejection objects are never inspected or retained in diagnostics', async () => {
    const local = endpoint(() => Response.json({}));
    let accesses = 0;
    const hostile = new Proxy({}, {
      get() { accesses++; throw new Error('synthetic-private-getter'); },
      getPrototypeOf() { accesses++; throw new Error('synthetic-private-prototype'); },
    });
    replaceLocalResponse(async (response) => {
      await response.body?.cancel();
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(hostile); } }));
    });
    const owned = transport([local.url]);
    expect((await rejection(owned.fetch(local.url, post))).message).toBe('source-screening transport did not return a usable response');
    await owned.drain();
    expect(accesses).toBe(0);
  });

  test('drain waits for its snapshot without closing admission or retaining completed work', async () => {
    const local = endpoint(() => Response.json({}));
    const owned = transport([local.url]);
    await owned.fetch(local.url, post);
    await owned.drain();
    expect((await owned.fetch(local.url, post)).ok).toBe(true);
    await owned.drain();
  });
});
