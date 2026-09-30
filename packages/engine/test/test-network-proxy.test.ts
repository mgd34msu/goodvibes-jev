import { afterEach, expect, test } from 'bun:test';
import { installTestNetworkGuard, TestExternalNetworkError } from '../scripts/test-network-guard.ts';

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });

function stubTransports() {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const fetchCalls: unknown[][] = [];
  const socketCalls: unknown[][] = [];
  globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
    fetchCalls.push(args); return new Response('fixture');
  }, { preconnect() {} });
  globalThis.WebSocket = new Proxy(originalWebSocket, {
    construct(_target, args) { socketCalls.push(args); return {}; },
  });
  const violations: string[] = [];
  const undo = installTestNetworkGuard((diagnostic) => violations.push(diagnostic));
  restore = () => { undo(); globalThis.fetch = originalFetch; globalThis.WebSocket = originalWebSocket; };
  return { fetchCalls, socketCalls, violations };
}

const externalProxies = [
  'http://outside.invalid:9000',
  { url: 'http://outside.invalid:9000/private?token=synthetic', headers: { 'Proxy-Authorization': 'synthetic-test-only' } },
] as const;

test.each(externalProxies)('fetch proxy is checked before delegating a loopback target: %j', async (proxy) => {
  const { fetchCalls, violations } = stubTransports();
  await expect(fetch('http://127.0.0.1:8000', { proxy })).rejects.toBeInstanceOf(TestExternalNetworkError);
  expect(fetchCalls).toHaveLength(0);
  expect(violations).toEqual(['Unexpected external fetch proxy in ordinary tests: http://outside.invalid:9000']);
});

test.each(externalProxies)('WebSocket proxy is checked before delegating a loopback target: %j', (proxy) => {
  const { socketCalls, violations } = stubTransports();
  expect(() => new WebSocket('ws://127.0.0.1:8000', { proxy })).toThrow(TestExternalNetworkError);
  expect(socketCalls).toHaveLength(0);
  expect(violations).toEqual(['Unexpected external WebSocket proxy in ordinary tests: http://outside.invalid:9000']);
});

test('both supported loopback proxy forms retain transport options', async () => {
  const { fetchCalls, socketCalls, violations } = stubTransports();
  const proxies = ['http://127.0.0.1:9000', { url: 'http://[::1]:9000', headers: { 'Proxy-Authorization': 'synthetic-test-only' } }];
  for (const proxy of proxies) {
    await fetch('http://localhost:8000', { proxy });
    new WebSocket('ws://localhost:8000', { proxy, protocols: ['fixture'] });
  }
  expect(fetchCalls.map((args) => (args[1] as RequestInit & { proxy: unknown }).proxy)).toEqual(proxies);
  expect(socketCalls.map((args) => (args[1] as Bun.WebSocketOptions).proxy)).toEqual(proxies);
  expect(violations).toEqual([]);
});

test('invalid proxy values fail closed without leaking their contents', async () => {
  const { fetchCalls, socketCalls, violations } = stubTransports();
  for (const proxy of [null, 123, { url: 123, headers: { Authorization: 'synthetic' } }, { url: 'data:text/plain,synthetic' }]) {
    await expect(Reflect.apply(fetch, globalThis, ['http://127.0.0.1:8000', { proxy }])).rejects.toBeInstanceOf(TestExternalNetworkError);
    expect(() => Reflect.construct(WebSocket, ['ws://127.0.0.1:8000', { proxy }])).toThrow(TestExternalNetworkError);
  }
  expect(fetchCalls).toHaveLength(0);
  expect(socketCalls).toHaveLength(0);
  expect(violations).toHaveLength(8);
  expect(violations.join('\n')).not.toContain('synthetic');
});

test('native transports receive the checked proxy snapshot when accessors change later reads', async () => {
  const { fetchCalls, socketCalls, violations } = stubTransports();
  const changingProxy = () => {
    let reads = 0;
    return { get url() { return reads++ === 0 ? 'http://127.0.0.1:9000' : 'http://outside.invalid:9000'; } };
  };
  await fetch('http://localhost:8000', { proxy: changingProxy() });
  let optionReads = 0;
  new WebSocket('ws://localhost:8000', {
    get proxy() { return optionReads++ === 0 ? changingProxy() : 'http://outside.invalid:9000'; },
  });
  expect((fetchCalls[0]?.[1] as { proxy: { url: string } }).proxy.url).toBe('http://127.0.0.1:9000');
  expect((socketCalls[0]?.[1] as { proxy: { url: string } }).proxy.url).toBe('http://127.0.0.1:9000');
  expect(optionReads).toBe(1);
  expect(violations).toEqual([]);
});
