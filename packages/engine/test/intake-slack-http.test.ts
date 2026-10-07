import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'undici/index.js';
import * as directClient from '../sdk/src/platform/security/source-screening/direct-client.ts';
import { createSlackInboxHttpOwner } from '../sdk/src/platform/intake/providers/slack-http.ts';
import type { SlackInboxHttp } from '../sdk/src/platform/intake/providers/slack.ts';
import { isolatedTestEnvironment } from '../scripts/test-isolation.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const pause = (ms = 10) => new Promise<void>(resolve => setTimeout(resolve, ms));
const request = { method: 'GET' as const, headers: { Authorization: 'Bearer xoxb-synthetic-owned-fixture', Accept: 'application/json' as const } };
const auth = () => new URL('https://slack.com/api/auth.test');
const list = () => new URL('https://slack.com/api/conversations.list?types=im&limit=100');
const history = () => new URL('https://slack.com/api/conversations.history?channel=D-synthetic&limit=50&latest=1800000000.000000');
function endpoint(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
  cleanups.push(() => server.stop(true));
  return { base: `http://127.0.0.1:${server.port}`, server };
}
function owner(base: string, extra: Partial<Parameters<typeof createSlackInboxHttpOwner>[0]> = {}) {
  const owned = createSlackInboxHttpOwner({ signal: new AbortController().signal, assertCurrent() {}, timeoutMs: 2_000,
    createClient(origin, options) {
      expect(origin).toBe('https://slack.com');
      expect(options).toMatchObject({ connect: { rejectUnauthorized: true }, pipelining: 0, allowH2: false });
      return new Client(base, options);
    }, ...extra });
  cleanups.push(() => owned.close());
  return owned;
}
async function rejection(work: Promise<unknown>): Promise<Error> {
  try { await work; throw new Error('expected Slack HTTP rejection'); }
  catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toStartWith('Slack HTTP ');
    expect((error as Error).cause).toBeUndefined();
    return error as Error;
  }
}

async function isolatedScenario(mode: string, name = 'HTTP_PROXY') {
  const root = makeProjectTempDir('slack-http-route-child');
  const control = Bun.serve({ port: 0, fetch: () => new Response('synthetic-parent-control') });
  cleanups.push(() => control.stop(true));
  try {
    const url = `http://localhost:${control.port}`;
    expect(await (await fetch(url)).text()).toBe('synthetic-parent-control');
    const result = spawnSync(process.execPath, [
      '--preload', resolve(import.meta.dir, '../toolchain/src/test-runner/test-network-preload.ts'),
      resolve(import.meta.dir, 'fixtures/slack-http-route-child.ts'), mode, name,
    ], { env: isolatedTestEnvironment(process.env, root), encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' });
    expect(result.error?.message ?? null).toBeNull();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ mode, passed: true, proxyCalls: 0 });
    expect(await (await fetch(url)).text()).toBe('synthetic-parent-control');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** Synthetic replacement only after the real owned body has been retired. */
function replaceBody(factory: () => ReadableStream<Uint8Array>) {
  const actual = directClient.responseStream;
  const stub = spyOn(directClient, 'responseStream').mockImplementation(body => {
    const response = actual(body);
    // Cancellation of the genuine loopback body remains part of the replacement.
    let replacement: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cancelled = false;
    const retired = response.cancel().then(() => { replacement = factory().getReader(); });
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        await retired;
        try {
          const next = await replacement!.read();
          if (cancelled) return;
          if (next.done) controller.close(); else controller.enqueue(next.value);
        } catch (error) { if (!cancelled) controller.error(error); }
      },
      async cancel() { cancelled = true; await retired; await replacement!.cancel(); replacement!.releaseLock(); },
    }, { highWaterMark: 0 });
  });
  cleanups.push(() => stub.mockRestore());
}

describe('private Slack inbox fixed HTTP owner', () => {
  test('sends only the closed GET methods, projected headers and exact encoded queries', async () => {
    const calls: { method: string; path: string; headers: [string, string][]; body: string }[] = [];
    const local = endpoint(async incoming => {
      calls.push({ method: incoming.method, path: new URL(incoming.url).pathname + new URL(incoming.url).search,
        headers: [...incoming.headers], body: await incoming.text() });
      return Response.json({ ok: true, synthetic: 'result' }, { headers: { 'x-private-id': 'synthetic-private', 'set-cookie': 'synthetic=private' } });
    });
    const owned = owner(local.base);
    const cursor = 'synthetic + / &= cursor';
    const nextList = list(); nextList.searchParams.set('cursor', cursor);
    const nextHistory = history(); nextHistory.searchParams.set('oldest', '1790000000.000000'); nextHistory.searchParams.set('cursor', cursor);
    for (const url of [auth(), nextList, nextHistory]) expect(await owned.http(url, request)).toEqual({ ok: true, body: { ok: true, synthetic: 'result' } });
    expect(calls.map(call => call.path)).toEqual([auth(), nextList, nextHistory].map(url => url.pathname + url.search));
    for (const call of calls) {
      expect(call.method).toBe('GET'); expect(call.body).toBe('');
      expect(Object.fromEntries(call.headers)).toEqual({ authorization: request.headers.Authorization, accept: 'application/json',
        connection: 'close', host: new URL(local.base).host });
    }
  });

  test('rejects origins, paths, fragments and every unknown or duplicate method query before client creation', async () => {
    let creations = 0;
    const owned = owner('http://127.0.0.1:1', { createClient() { creations++; throw new Error('must not construct'); } });
    for (const value of [
      'http://slack.com/api/auth.test', 'https://example.com/api/auth.test', 'https://slack.com:444/api/auth.test',
      'https://synthetic:secret@slack.com/api/auth.test', 'https://slack.com/api/auth.test#',
      'https://slack.com/api/auth.test/', 'https://slack.com/api/chat.postMessage',
      'https://slack.com/api/auth.test?token=synthetic', 'https://slack.com/api/auth.test?cursor=synthetic',
      'https://slack.com/api/conversations.list?types=public_channel&limit=100',
      'https://slack.com/api/conversations.list?types=im&limit=100&limit=100',
      'https://slack.com/api/conversations.list?types=im&limit=100&channel=synthetic',
      'https://slack.com/api/conversations.history?channel=D&limit=50&latest=1e9',
      'https://slack.com/api/conversations.history?channel=D&limit=50&latest=1800000000.000000&inclusive=true',
      'https://slack.com/api/conversations.history?channel=D&limit=50&latest=1800000000.000000&oldest=garbage',
    ]) expect((await rejection(owned.http(new URL(value), request))).message).toBe('Slack HTTP request is not allowed');
    expect(creations).toBe(0);
  });

  test('refuses additional request options and headers, malformed credentials and borrowed getters', async () => {
    let calls = 0;
    const local = endpoint(() => { calls++; return Response.json({}); });
    const owned = owner(local.base);
    const hostile = Object.defineProperty({}, 'method', { get() { throw new Error('synthetic-private-token'); } });
    for (const init of [
      { ...request, method: 'POST' }, { ...request, body: 'synthetic' }, { ...request, redirect: 'follow' },
      { ...request, proxy: local.base }, { ...request, dispatcher: {} }, { ...request, tls: { rejectUnauthorized: false } },
      { ...request, headers: { ...request.headers, 'Proxy-Authorization': 'synthetic' } },
      { ...request, headers: { ...request.headers, Authorization: 'Bearer xoxb-synthetic\r\nx-private: secret' } },
      { ...request, headers: { ...request.headers, Accept: '*/*' } }, hostile,
    ]) expect((await rejection(owned.http(auth(), init as Parameters<SlackInboxHttp>[1]))).message).toBe('Slack HTTP request is not allowed');
    expect(calls).toBe(0);
  });

  test('validates deadlines and uses fixed production constructor settings', async () => {
    for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 120_001]) {
      expect(() => createSlackInboxHttpOwner({ signal: new AbortController().signal, assertCurrent() {}, timeoutMs })).toThrow('Slack HTTP request');
    }
    const local = endpoint(() => Response.json({}));
    const owned = createSlackInboxHttpOwner({ signal: new AbortController().signal, assertCurrent() {}, createClient(origin, options) {
      expect(origin).toBe('https://slack.com');
      expect(options).toEqual({ pipelining: 0, allowH2: false, connect: { rejectUnauthorized: true }, maxHeaderSize: 16 * 1024,
        connectTimeout: 10_000, headersTimeout: 10_000, bodyTimeout: 10_000 });
      return new Client(local.base, options);
    } });
    cleanups.push(() => owned.close());
    await owned.http(auth(), request);
  });

  test('snapshots caller URL and credential accessors before authority callbacks', async () => {
    const calls: string[] = [];
    const local = endpoint(incoming => {
      calls.push(new URL(incoming.url).pathname);
      expect(incoming.headers.get('authorization')).toBe(request.headers.Authorization);
      return Response.json({ ok: true });
    });
    const url = auth();
    let headersRead = 0; let tokenRead = 0;
    const owned = owner(local.base, { assertCurrent() { url.pathname = '/api/chat.postMessage'; } });
    await owned.http(url, { method: 'GET', get headers() {
      headersRead++;
      return { get Authorization() { tokenRead++; return request.headers.Authorization; }, Accept: 'application/json' as const };
    } });
    expect(calls).toEqual(['/api/auth.test']);
    expect(headersRead).toBe(1); expect(tokenRead).toBe(1);
  });

  test.each([301, 302, 303, 307, 308])('refuses redirect %s without forwarding credentials to the target', async status => {
    let targetCalls = 0;
    const target = endpoint(() => { targetCalls++; return Response.json({}); });
    const local = endpoint(() => new Response('synthetic-private-redirect-body', { status, headers: { location: `${target.base}/target` } }));
    expect((await rejection(owner(local.base).http(auth(), request))).message).toBe('Slack HTTP response is unavailable');
    expect(targetCalls).toBe(0);
  });

  test('accepts exactly 8 MiB and refuses one extra decoded byte', async () => {
    const limit = 8 * 1024 * 1024;
    let length = limit;
    const local = endpoint(() => new Response('"' + 'x'.repeat(length - 2) + '"'));
    const owned = owner(local.base);
    expect((await owned.http(auth(), request)).body).toHaveLength(limit - 2);
    length++;
    expect((await rejection(owned.http(auth(), request))).message).toBe('Slack HTTP response exceeds the byte limit');
  });

  test('bounds decoded compressed bytes rather than trusting compressed Content-Length', async () => {
    const compressed = Bun.gzipSync('"' + 'x'.repeat(8 * 1024 * 1024) + '"');
    expect(compressed.byteLength).toBeLessThan(16 * 1024);
    const local = endpoint(() => new Response(compressed, { headers: { 'content-encoding': 'gzip' } }));
    expect((await rejection(owner(local.base).http(auth(), request))).message).toBe('Slack HTTP response is unavailable');
  });

  test('accepts valid compressed JSON and bounds a chunked body without Content-Length', async () => {
    let compressed = true;
    const local = endpoint(() => compressed
      ? new Response(Bun.gzipSync('{"ok":true}'), { headers: { 'content-encoding': 'gzip' } })
      : new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new Uint8Array(4 * 1024 * 1024));
        controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
        controller.close();
      } })));
    const owned = owner(local.base);
    expect(await owned.http(auth(), request)).toEqual({ ok: true, body: { ok: true } });
    compressed = false;
    expect((await rejection(owned.http(auth(), request))).message).toBe('Slack HTTP response exceeds the byte limit');
  });

  test('never exposes malformed JSON, error bodies, status text or response headers', async () => {
    for (const response of [new Response('synthetic-private-body'), new Response(new Uint8Array([255])),
      new Response('synthetic-private-body', { status: 500, statusText: 'synthetic-private-status', headers: { 'x-request-id': 'synthetic-private-id' } })]) {
      const local = endpoint(() => response);
      expect((await rejection(owner(local.base).http(auth(), request))).message).toBe('Slack HTTP response is unavailable');
    }
  });

  test('429 fences the same method until Retry-After and lets other methods continue, without retries', async () => {
    let authCalls = 0; let listCalls = 0;
    const local = endpoint(incoming => {
      if (new URL(incoming.url).pathname.endsWith('conversations.list')) { listCalls++; return Response.json({ ok: true }); }
      authCalls++;
      return authCalls === 1 ? new Response('synthetic-private-rate-limit', { status: 429, headers: { 'retry-after': '0.15' } }) : Response.json({ ok: true });
    });
    const owned = owner(local.base);
    const simultaneous = [owned.http(auth(), request), owned.http(auth(), request)];
    expect((await rejection(simultaneous[0]!)).message).toBe('Slack HTTP method is rate limited');
    expect((await rejection(simultaneous[1]!)).message).toBe('Slack HTTP method is rate limited');
    expect(authCalls).toBe(1);
    expect(await owned.http(list(), request)).toEqual({ ok: true, body: { ok: true } });
    expect(listCalls).toBe(1);
    await rejection(owned.http(auth(), request)); expect(authCalls).toBe(1);
    await pause(170);
    expect(authCalls).toBe(1); // The owner did not schedule a retry.
    await owned.http(auth(), request); expect(authCalls).toBe(2);
  });

  test.each([undefined, '-1', 'synthetic-private-header', 'Infinity', '1e2'])(
    'invalid Retry-After %s uses the existing poll cadence', async retryAfter => {
      let calls = 0;
      const local = endpoint(() => { calls++; return new Response('{}', { status: 429,
        ...(retryAfter === undefined ? {} : { headers: { 'retry-after': retryAfter } }) }); });
      const owned = owner(local.base);
      await rejection(owned.http(auth(), request));
      await rejection(owned.http(auth(), request));
      expect(calls).toBe(1);
    });

  test('large numeric Retry-After cannot overflow into immediate readmission', async () => {
    let calls = 0;
    const local = endpoint(() => { calls++; return new Response('{}', { status: 429, headers: { 'retry-after': '9'.repeat(400) } }); });
    const owned = owner(local.base);
    await rejection(owned.http(auth(), request));
    await rejection(owned.http(auth(), request));
    expect(calls).toBe(1);
  });

  test('current-authority checks sanitize synchronous, asynchronous and hostile failures before dispatch', async () => {
    let calls = 0; let accesses = 0;
    const local = endpoint(() => { calls++; return Response.json({}); });
    const hostile = new Proxy({}, { get() { accesses++; throw new Error('synthetic'); }, getPrototypeOf() { accesses++; throw new Error('synthetic'); } });
    for (const assertCurrent of [() => { throw new Error('synthetic-private-authority'); }, async () => { throw new Error('synthetic-private-authority'); }, () => { throw hostile; }]) {
      expect((await rejection(owner(local.base, { assertCurrent }).http(auth(), request))).message).toBe('Slack HTTP authority is no longer current');
    }
    expect(calls).toBe(0); expect(accesses).toBe(0);
  });

  test('authority revoked after headers prevents received bytes from escaping', async () => {
    let current = true;
    const local = endpoint(() => { current = false; return Response.json({ synthetic: 'private-result' }); });
    expect((await rejection(owner(local.base, { assertCurrent() { if (!current) throw new Error('synthetic-private-reason'); } }).http(auth(), request))).message)
      .toBe('Slack HTTP authority is no longer current');
  });

  test('deadline covers a stalled body after successful headers', async () => {
    const local = endpoint(() => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([123])); } })));
    expect((await rejection(owner(local.base, { timeoutMs: 150 }).http(auth(), request))).message).toBe('Slack HTTP request timed out');
  });

  test('caller and owner cancellation sanitize reasons and retire the body', async () => {
    for (const cancelOwner of [false, true]) {
      const started = Promise.withResolvers<void>();
      const local = endpoint(() => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([123])); started.resolve(); } })));
      const caller = new AbortController(); const source = new AbortController();
      const owned = owner(local.base, { signal: source.signal });
      const pending = owned.http(auth(), { ...request, signal: caller.signal });
      await started.promise;
      (cancelOwner ? source : caller).abort(new Error('synthetic-private-abort-reason'));
      expect((await rejection(pending)).message).toBe('Slack HTTP request was cancelled');
      await owned.close();
    }
  });

  test('already aborted signals and a closed owner refuse network admission', async () => {
    let calls = 0;
    const local = endpoint(() => { calls++; return Response.json({}); });
    const caller = new AbortController();
    caller.abort(new Error('synthetic-private-abort-reason'));
    const owned = owner(local.base);
    expect((await rejection(owned.http(auth(), { ...request, signal: caller.signal }))).message).toBe('Slack HTTP request was cancelled');
    const closing = owned.close(); expect(owned.close()).toBe(closing); await closing;
    await rejection(owned.http(auth(), request));
    const source = new AbortController(); source.abort();
    await rejection(owner(local.base, { signal: source.signal }).http(auth(), request));
    expect(calls).toBe(0);
  });

  test('native signal operations ignore hostile caller and owner overrides', async () => {
    let accesses = 0;
    const source = new AbortController(); const caller = new AbortController();
    for (const signal of [source.signal, caller.signal]) {
      for (const name of ['aborted', 'addEventListener', 'removeEventListener']) {
        Object.defineProperty(signal, name, { get() { accesses++; throw new Error('synthetic-private-signal-error'); } });
      }
    }
    const started = Promise.withResolvers<void>();
    const local = endpoint(() => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([123])); started.resolve(); } })));
    const owned = owner(local.base, { signal: source.signal });
    const pending = owned.http(auth(), { ...request, signal: caller.signal });
    await started.promise; caller.abort(new Error('synthetic-private-abort-reason'));
    expect((await rejection(pending)).message).toBe('Slack HTTP request was cancelled');
    await owned.close();
    expect(accesses).toBe(0);
  });

  test('cancelling a queued request prevents its eventual network dispatch', async () => {
    const started = Promise.withResolvers<void>(); const finish = Promise.withResolvers<void>();
    let calls = 0;
    const local = endpoint(async () => { calls++; started.resolve(); await finish.promise; return Response.json({ ok: true }); });
    const owned = owner(local.base);
    cleanups.push(() => finish.resolve());
    const first = owned.http(auth(), request);
    await started.promise;
    const caller = new AbortController();
    const queued = owned.http(list(), { ...request, signal: caller.signal });
    caller.abort(new Error('synthetic-private-abort-reason'));
    finish.resolve(); await first;
    expect((await rejection(queued)).message).toBe('Slack HTTP request was cancelled');
    expect(calls).toBe(1);
  });

  test('a queued deadline prevents dispatch after an earlier cancellation finally drains', async () => {
    let calls = 0;
    const local = endpoint(() => { calls++; return Response.json({}); });
    const bodyRead = Promise.withResolvers<void>(); const cancelled = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    replaceBody(() => new ReadableStream<Uint8Array>({ pull() { bodyRead.resolve(); },
      cancel() { cancelled.resolve(); return finish.promise; } }, { highWaterMark: 0 }));
    const owned = owner(local.base, { timeoutMs: 80 });
    cleanups.push(() => finish.resolve());
    const first = owned.http(auth(), request);
    await bodyRead.promise;
    const queued = owned.http(list(), request);
    await cancelled.promise; await pause(100); finish.resolve();
    expect((await rejection(first)).message).toBe('Slack HTTP request timed out');
    expect((await rejection(queued)).message).toBe('Slack HTTP request timed out');
    expect(calls).toBe(1);
  });

  test('a late 429 received after caller cancellation still fences the method', async () => {
    let calls = 0;
    const local = endpoint(() => { calls++; return new Response('{}', { status: 429, headers: { 'retry-after': '60' } }); });
    const received = Promise.withResolvers<void>(); const deliver = Promise.withResolvers<void>();
    const owned = owner(local.base, { createClient(_origin, options) {
      const client = new Client(local.base, options);
      const compose = client.compose.bind(client);
      client.compose = (...args) => {
        const dispatcher = compose(args.flat());
        const actual = dispatcher.request.bind(dispatcher);
        dispatcher.request = (async (...input: Parameters<typeof actual>) => {
          const response = await actual(...input);
          received.resolve(); await deliver.promise; return response;
        }) as typeof dispatcher.request;
        return dispatcher;
      };
      return client;
    } });
    cleanups.push(() => deliver.resolve());
    const caller = new AbortController();
    const pending = owned.http(auth(), { ...request, signal: caller.signal });
    await received.promise; caller.abort(); deliver.resolve();
    expect((await rejection(pending)).message).toBe('Slack HTTP request was cancelled');
    expect((await rejection(owned.http(auth(), request))).message).toBe('Slack HTTP method is rate limited');
    expect(calls).toBe(1);
  });

  test('hostile body rejections never expose or inspect borrowed diagnostics', async () => {
    const local = endpoint(() => Response.json({}));
    let accesses = 0;
    const hostile = new Proxy({}, { get() { accesses++; throw new Error('synthetic-private'); },
      getPrototypeOf() { accesses++; throw new Error('synthetic-private'); } });
    replaceBody(() => new ReadableStream<Uint8Array>({ start(controller) { controller.error(hostile); } }));
    expect((await rejection(owner(local.base).http(auth(), request))).message).toBe('Slack HTTP response is unavailable');
    expect(accesses).toBe(0);
  });

  test('HTTP settlement and close both wait for actual asynchronous body cancellation', async () => {
    const local = endpoint(() => Response.json({}));
    const bodyRead = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    replaceBody(() => new ReadableStream<Uint8Array>({ pull() { bodyRead.resolve(); }, cancel() { cancelled.resolve(); return finish.promise; } }, { highWaterMark: 0 }));
    const caller = new AbortController();
    const owned = owner(local.base);
    cleanups.push(() => finish.resolve());
    const pending = owned.http(auth(), { ...request, signal: caller.signal });
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await bodyRead.promise; caller.abort(); await cancelled.promise;
    let closed = false;
    const closing = owned.close().then(() => { closed = true; });
    await pause(); expect(settled).toBe(false); expect(closed).toBe(false);
    finish.resolve();
    await rejection(pending); await closing;
    expect(settled).toBe(true); expect(closed).toBe(true);
  });

  test('a response delivered after cancellation is still retired before close settles', async () => {
    const local = endpoint(() => Response.json({}));
    const received = Promise.withResolvers<void>(); const deliver = Promise.withResolvers<void>();
    const finishCancel = Promise.withResolvers<void>(); const cancelled = Promise.withResolvers<void>();
    replaceBody(() => new ReadableStream<Uint8Array>({ cancel() { cancelled.resolve(); return finishCancel.promise; } }));
    const owned = owner(local.base, { createClient(_origin, options) {
      const client = new Client(local.base, options);
      const compose = client.compose.bind(client);
      client.compose = (...args) => {
        const dispatcher = compose(args.flat());
        const actual = dispatcher.request.bind(dispatcher);
        dispatcher.request = (async (...input: Parameters<typeof actual>) => {
          const response = await actual(...input);
          received.resolve(); await deliver.promise; return response;
        }) as typeof dispatcher.request;
        return dispatcher;
      };
      return client;
    } });
    cleanups.push(() => { deliver.resolve(); finishCancel.resolve(); });
    const pending = owned.http(auth(), request);
    await received.promise;
    let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
    let closed = false; const closing = owned.close().then(() => { closed = true; });
    await pause(); expect(settled).toBe(false); expect(closed).toBe(false);
    deliver.resolve(); await cancelled.promise;
    await pause(); expect(settled).toBe(false); expect(closed).toBe(false);
    finishCancel.resolve(); await rejection(pending); await closing;
    expect(owned.close()).toBe(owned.close());
    await rejection(owned.http(auth(), request));
  });

  test.each(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'HtTp_PrOxY', 'HtTpS_PrOxY', 'AlL_PrOxY'])(
    'refuses visible %s even with NO_PROXY', async name => isolatedScenario('configured', name));
  test('rechecks proxy state immediately after the last authority hook', async () => isolatedScenario('after-authority'));
  test('refuses proxy configuration appearing between calls', async () => isolatedScenario('between-calls'));
  test('cached native proxy routing cannot affect a new owned client', async () => isolatedScenario('stale-before-owner'));
  test('cached native proxy routing cannot affect an existing owned client', async () => isolatedScenario('stale-between-calls'));
  test('ambient TLS-disable state cannot authorize an invalid certificate', async () => isolatedScenario('tls-reject'));
});
