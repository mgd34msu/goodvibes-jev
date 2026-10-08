import { afterEach, expect, test } from 'bun:test';
import {
  createNetworkFetch, GlobalNetworkTransportInstaller,
} from '../sdk/src/platform/runtime/network/outbound.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

type CapturedInit = RequestInit & { tls?: { ca?: string | readonly string[]; rejectUnauthorized?: boolean } };
function config(mode: 'bundled' | 'custom' = 'bundled', allowInsecureLocalhost = false) {
  const values: Record<string, unknown> = {
    'network.outboundTls.mode': mode,
    'network.outboundTls.allowInsecureLocalhost': allowInsecureLocalhost,
    'network.outboundTls.customCaFile': '',
    'network.outboundTls.customCaDir': '',
  };
  return { get: (key: string) => values[key], getControlPlaneConfigDir: () => '.' };
}

test('explicit TLS scope survives request reconstruction without bypassing ambient guards', async () => {
  const received: CapturedInit[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    received.push(init ?? {}); return new Response('owned response');
  }) as typeof globalThis.fetch;
  new GlobalNetworkTransportInstaller().install(config('bundled', true));
  const installed = globalThis.fetch;
  let guards = 0;
  const middleware = (async (input: RequestInfo | URL, init?: RequestInit) => {
    guards += 1;
    const request = new Request(input, init);
    if (new URL(request.url).pathname === '/refused') throw new Error('owned guard refusal');
    // Reconstructing Request deliberately does not copy private init properties.
    return installed(request);
  }) as typeof globalThis.fetch;
  Object.assign(middleware, installed);
  globalThis.fetch = middleware;

  const scoped = createNetworkFetch(globalThis.fetch, config());
  expect(await (await scoped('https://127.0.0.1/allowed')).text()).toBe('owned response');
  await expect(scoped('https://127.0.0.1/refused')).rejects.toThrow('owned guard refusal');
  expect(guards).toBe(2);
  expect(received).toEqual([{}]);
  expect(globalThis.fetch).toBe(middleware);
  await installed('https://127.0.0.1/unscoped');
  expect(received[1]?.tls?.rejectUnauthorized).toBe(false);
});

test('scoped policy preserves explicit request TLS and restores the global policy after rejection', async () => {
  const received: CapturedInit[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    received.push(init ?? {});
    if (received.length === 1) throw new Error('owned transport failure');
    return new Response('owned response');
  }) as typeof globalThis.fetch;
  new GlobalNetworkTransportInstaller().install(config('bundled', true));
  const installed = globalThis.fetch;
  const scoped = createNetworkFetch(installed, config());
  const init: CapturedInit = { tls: { ca: 'owned explicit CA', rejectUnauthorized: true } };
  await expect(scoped('https://127.0.0.1/explicit', init)).rejects.toThrow('owned transport failure');
  expect(received[0]?.tls).toEqual(init.tls);
  expect(init).toEqual({ tls: { ca: 'owned explicit CA', rejectUnauthorized: true } });
  await installed('https://127.0.0.1/unscoped');
  expect(received[1]?.tls?.rejectUnauthorized).toBe(false);
  expect(globalThis.fetch).toBe(installed);
});

test('overlapping scoped policies survive an asynchronous middleware boundary and foreign manager changes', async () => {
  const received = new Map<string, CapturedInit>();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    received.set(new URL(url).pathname, init ?? {}); return new Response('owned response');
  }) as typeof globalThis.fetch;
  new GlobalNetworkTransportInstaller().install(config('bundled', true));
  const installed = globalThis.fetch;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let bothEntered!: () => void;
  const entered = new Promise<void>(resolve => { bothEntered = resolve; });
  let count = 0;
  const middleware = (async (input: RequestInfo | URL) => {
    if (++count === 2) bothEntered();
    await barrier;
    return installed(input);
  }) as typeof globalThis.fetch;
  Object.assign(middleware, installed);
  globalThis.fetch = middleware;
  const strict = createNetworkFetch(middleware, config());
  const local = createNetworkFetch(middleware, config('bundled', true));
  const pending = [strict('https://127.0.0.1/strict'), local('https://127.0.0.1/local')];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([entered, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('owned requests did not enter middleware')), 2_000);
    })]);
    // This updates only the existing product wrapper; each admitted scope owns
    // its own reader despite this unrelated manager becoming unusable.
    new GlobalNetworkTransportInstaller().install(config('custom'));
    release();
    const responses = await Promise.all(pending);
    await Promise.all(responses.map(response => response.text()));
    expect(received.get('/strict')).toEqual({});
    expect(received.get('/local')?.tls?.rejectUnauthorized).toBe(false);
    await expect(installed('https://127.0.0.1/unscoped')).rejects.toThrow('no custom CA entries');
    expect(received.has('/unscoped')).toBe(false);
    expect(globalThis.fetch).toBe(middleware);
  } finally {
    clearTimeout(timer); release(); await Promise.allSettled(pending);
  }
});
