// Ordinary tests may use local fixture servers and replace network functions
// with mocks. Any real fetch, TCP/TLS, Bun TCP or WebSocket connection this
// preload sees must stay on loopback (or a local Unix socket). This is not an
// OS sandbox: native addons, UDP and independently launched subprocesses are
// outside these JavaScript hooks. Live proofs do not install this guard.
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';

export type NetworkViolationReporter = (diagnostic: string) => void;

export class TestExternalNetworkError extends Error {
  constructor(diagnostic: string) {
    super(diagnostic);
    this.name = 'TestExternalNetworkError';
  }
}

function loopback(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  const parts = normalized.split('.');
  return parts.length === 4 && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** A diagnostic deliberately has no path, query, credentials, headers or body. */
function reject(reporter: NetworkViolationReporter, kind: string, destination: string): never {
  const diagnostic = `Unexpected external ${kind} in ordinary tests: ${destination}`;
  reporter(diagnostic);
  throw new TestExternalNetworkError(diagnostic);
}

function localUrl(value: string | URL, reporter: NetworkViolationReporter, kind: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { return reject(reporter, kind, '[invalid URL]'); }
  if (url.username || url.password) reject(reporter, kind, `${url.protocol}//${url.host}`);
  if (['data:', 'blob:', 'file:'].includes(url.protocol)) return url;
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || !loopback(url.hostname)) {
    reject(reporter, kind, `${url.protocol}//${url.host}`);
  }
  return url;
}

function localProxy(value: unknown, reporter: NetworkViolationReporter, kind: string): string | { url: string; headers?: unknown } | undefined {
  if (value === undefined) return undefined;
  const address = typeof value === 'string' ? value
    : value !== null && (typeof value === 'object' || typeof value === 'function') && 'url' in value ? value.url : undefined;
  if (typeof address !== 'string') reject(reporter, kind, '[invalid proxy]');
  const url = localUrl(address, reporter, kind);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') reject(reporter, kind, '[invalid proxy protocol]');
  // Native transports must receive the value we checked, even when an option
  // uses an accessor or reading its headers mutates the original proxy object.
  return typeof value === 'string' ? address : { ...value as object, url: address };
}

function localSocket(args: readonly unknown[], reporter: NetworkViolationReporter, kind: string): void {
  const first = args[0];
  if (Array.isArray(first)) return localSocket(first, reporter, kind);
  if (typeof first === 'string' && !/^\d+$/.test(first)) return; // Unix socket path.
  const options = args.filter((argument): argument is Record<string, unknown> => typeof argument === 'object' && argument !== null && !Array.isArray(argument));
  if (options.some((option) => typeof option.path === 'string' || typeof option.unix === 'string')) return;
  // TLS also accepts (port, options) and (port, host, options). Check every
  // stated host rather than assuming all overloads put it in argument zero.
  const hosts = options.flatMap((option) => [option.host, option.hostname]).filter((host) => host !== undefined);
  if (typeof args[1] === 'string') hosts.push(args[1]);
  if (hosts.length === 0) hosts.push('localhost');
  const port = options.find((option) => option.port !== undefined)?.port ?? first;
  for (const host of hosts) if (typeof host !== 'string' || !loopback(host)) {
    const displayHost = typeof host === 'string' && /^[a-z\d.:[\]_-]+$/i.test(host) ? host : '[invalid host]';
    reject(reporter, kind, `${displayHost}:${typeof port === 'number' || typeof port === 'string' && /^\d+$/.test(port) ? port : '[port]'}`);
  }
}

/** Install without freezing globals, so existing per-test mocks still work. */
export function installTestNetworkGuard(reporter: NetworkViolationReporter): () => void {
  const originalFetch = globalThis.fetch;
  const originalConnect = net.Socket.prototype.connect;
  const originalTlsConnect = tls.connect;
  const originalBunConnect = Bun.connect;
  const originalWebSocket = globalThis.WebSocket;

  const guardedFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const methodLabel = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE|CONNECT)$/i.test(method) ? method.toUpperCase() : '[custom method]';
    localUrl(input instanceof Request ? input.url : String(input), reporter, `fetch ${methodLabel}`);
    let request = new Request(input, init);
    const redirect = request.redirect;
    const { method: _method, body: _body, headers: _headers, signal: _signal, redirect: _redirect, ...transport } = init ?? {};
    // A native follow could leave loopback without calling this wrapper again.
    // Follow each hop here instead, checking it before the next connection.
    for (let hop = 0; ; hop++) {
      localUrl(request.url, reporter, `fetch ${request.method}`);
      const proxy = localProxy('proxy' in transport ? transport.proxy : undefined, reporter, 'fetch proxy');
      const response = await originalFetch(request.clone(), { ...transport, ...(proxy === undefined ? {} : { proxy }), redirect: 'manual' } as Parameters<typeof fetch>[1]);
      const location = response.headers.get('location');
      if (![301, 302, 303, 307, 308].includes(response.status) || location === null || redirect === 'manual') return response;
      if (redirect === 'error') throw new TypeError('Fetch redirect refused by request policy');
      if (hop >= 19) throw new TypeError('Too many fetch redirects');
      const next = localUrl(new URL(location, request.url), reporter, `fetch ${request.method} redirect`);
      const headers = new Headers(request.headers);
      if (new URL(request.url).origin !== next.origin) {
        headers.delete('authorization');
        headers.delete('proxy-authorization');
        headers.delete('cookie');
      }
      const rewrite = response.status === 303 && request.method !== 'HEAD'
        || (response.status === 301 || response.status === 302) && request.method === 'POST';
      if (rewrite) { headers.delete('content-type'); headers.delete('content-length'); }
      await response.body?.cancel();
      request = new Request(next, {
        method: rewrite ? 'GET' : request.method, headers,
        body: rewrite || request.method === 'GET' || request.method === 'HEAD' ? null : request.body,
        signal: request.signal, redirect, credentials: request.credentials,
      });
    }
  }) as typeof fetch;
  Object.assign(guardedFetch, originalFetch);
  guardedFetch.preconnect = (...args: Parameters<typeof fetch.preconnect>) => {
    localUrl(String(args[0]), reporter, 'fetch preconnect');
    return originalFetch.preconnect(...args);
  };
  globalThis.fetch = guardedFetch;

  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]): net.Socket {
    localSocket(args, reporter, 'TCP');
    return Reflect.apply(originalConnect, this, args) as net.Socket;
  } as typeof originalConnect;
  tls.connect = function (...args: unknown[]): tls.TLSSocket {
    localSocket(args, reporter, 'TLS');
    return Reflect.apply(originalTlsConnect, tls, args) as tls.TLSSocket;
  } as typeof originalTlsConnect;
  Reflect.set(Bun, 'connect', (...args: unknown[]) => {
    localSocket(args, reporter, 'Bun TCP');
    return Reflect.apply(originalBunConnect, Bun, args);
  });
  globalThis.WebSocket = new Proxy(originalWebSocket, {
    construct(target, args, newTarget) {
      localUrl(String(args[0]), reporter, 'WebSocket');
      const options = args[1];
      if (options !== null && (typeof options === 'object' || typeof options === 'function') && 'proxy' in options) {
        const snapshot = { ...options };
        args[1] = { ...snapshot, proxy: localProxy(snapshot.proxy, reporter, 'WebSocket proxy') };
      }
      return Reflect.construct(target, args, newTarget);
    },
  });
  syncBuiltinESMExports();

  return () => {
    globalThis.fetch = originalFetch;
    net.Socket.prototype.connect = originalConnect;
    tls.connect = originalTlsConnect;
    Reflect.set(Bun, 'connect', originalBunConnect);
    globalThis.WebSocket = originalWebSocket;
    syncBuiltinESMExports();
  };
}
