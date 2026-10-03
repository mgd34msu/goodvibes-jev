import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

type Headers = Record<string, string>;
interface Request { url: string; method: string; headers: Headers }
interface Response { status: number; headers: Headers }
interface Policy {
  now(): number;
  maxAge(): number;
  timeToLive(): number;
  useStaleWhileRevalidate(): boolean;
  satisfiesWithoutRevalidation(request: Request): boolean;
  evaluateRequest(request: Request): { response?: unknown; revalidation?: { synchronous: boolean } };
  revalidatedPolicy(request: Request, response: Response): { policy: Policy; modified: boolean; matches: boolean };
  toObject(): object;
}
interface PolicyConstructor {
  new(request: Request, response: Response, options?: { shared: boolean }): Policy;
  fromObject(value: object): Policy;
}
const require = createRequire(import.meta.url);
let dependencyRequire = require;
for (const name of ['verdaccio', '@verdaccio/hooks', 'got-cjs', 'cacheable-request']) {
  dependencyRequire = createRequire(dependencyRequire.resolve(name));
}
const installedPolicyPath = dependencyRequire.resolve('http-cache-semantics');
const CachePolicy = dependencyRequire('http-cache-semantics') as PolicyConstructor;
const request: Request = { url: 'https://cache.example.test/resource', method: 'GET', headers: { host: 'cache.example.test' } };
const staleRequest = (value: string): Request => ({ ...request, headers: { ...request.headers, 'cache-control': value } });

function policy(headers: Headers, shared = true): Policy {
  const value = new CachePolicy(request, { status: 200, headers }, { shared });
  const now = value.now();
  value.now = () => now + 2_000;
  return value;
}

describe('vendored cache policy security reuse restrictions', () => {
  test('the real Verdaccio consumer resolves exactly the checked-in patched implementation', () => {
    expect(readFileSync(installedPolicyPath, 'utf8')).toBe(readFileSync(require.resolve('../../../vendor/http-cache-semantics'), 'utf8'));
  });
  for (const [label, headers] of [
    ['shared cookies', { 'set-cookie': 'synthetic-session=fixture', 'cache-control': 'max-age=60' }],
    ['proxy-revalidate', { 'cache-control': 'max-age=60, proxy-revalidate' }],
    ['no-cache', { 'cache-control': 'no-cache' }],
    ['no-store', { 'cache-control': 'no-store' }],
    ['private shared response', { 'cache-control': 'private, max-age=60' }],
    ['vary wildcard', { vary: '*', 'cache-control': 'max-age=60' }],
  ] as const) {
    test(`${label} cannot be reused through max-stale, including after serialization`, () => {
      const original = policy(headers);
      for (const value of [original, CachePolicy.fromObject(original.toObject())]) {
        for (const directive of ['max-stale', 'max-stale=999999']) {
          const incoming = staleRequest(directive);
          expect(value.maxAge()).toBe(0);
          expect(value.satisfiesWithoutRevalidation(incoming)).toBe(false);
          expect(value.evaluateRequest(incoming).response).toBeUndefined();
          expect(value.evaluateRequest(incoming).revalidation?.synchronous).toBe(true);
        }
      }
    });

    test(`${label} cannot be reused through stale extensions or server errors`, () => {
      const value = policy({ ...headers, 'cache-control': `${headers['cache-control']}, stale-while-revalidate=600, stale-if-error=600` });
      expect(value.timeToLive()).toBe(0);
      expect(value.useStaleWhileRevalidate()).toBe(false);
      expect(value.evaluateRequest(request).response).toBeUndefined();
      expect(value.revalidatedPolicy(request, { status: 503, headers: {} }).modified).toBe(true);
    });
  }

  test('preserves ordinary max-stale and stale extensions after a positive lifetime expires', () => {
    const value = policy({ 'cache-control': 'public, max-age=1, stale-while-revalidate=60, stale-if-error=60' });
    expect(value.satisfiesWithoutRevalidation(staleRequest('max-stale=10'))).toBe(true);
    expect(value.useStaleWhileRevalidate()).toBe(true);
    expect(value.evaluateRequest(request).revalidation?.synchronous).toBe(false);
    expect(value.revalidatedPolicy(request, { status: 503, headers: {} }).modified).toBe(false);
  });

  test('preserves explicit zero max-age, public/immutable cookie opt-ins and private caches', () => {
    expect(policy({ 'cache-control': 'public, max-age=0' }).satisfiesWithoutRevalidation(staleRequest('max-stale'))).toBe(true);
    for (const optIn of ['public, max-age=60', 'immutable']) {
      expect(policy({ 'set-cookie': 'fixture=1', 'cache-control': optIn }).satisfiesWithoutRevalidation(request)).toBe(true);
    }
    expect(policy({ 'set-cookie': 'fixture=1', 'cache-control': 'private, max-age=60' }, false).satisfiesWithoutRevalidation(request)).toBe(true);
    expect(policy({ 'cache-control': 'max-age=60, proxy-revalidate' }, false).satisfiesWithoutRevalidation(request)).toBe(true);
  });

  test('preserves conditional revalidation and rejects mismatched requests', () => {
    const value = policy({ 'cache-control': 'no-cache', etag: '"fixture"' });
    const revalidated = value.revalidatedPolicy(request, { status: 304, headers: { etag: '"fixture"' } });
    expect(revalidated.modified).toBe(false);
    expect(revalidated.matches).toBe(true);
    expect(policy({ 'cache-control': 'public, max-age=60' }).satisfiesWithoutRevalidation({ ...request, url: 'https://cache.example.test/other' })).toBe(false);
  });

  test('Verdaccio’s actual HTTP client still performs requests and caches ordinary public responses', async () => {
    const hooksRequire = createRequire(createRequire(require.resolve('verdaccio')).resolve('@verdaccio/hooks'));
    const got = hooksRequire('got-cjs').default as (url: string, options: { cache: Map<string, string>; responseType: 'json' }) => Promise<{ body: { marker: string } }>;
    let hits = 0;
    const server = createServer((_request, response) => {
      hits++;
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' });
      response.end(JSON.stringify({ marker: 'synthetic-local-fixture' }));
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('Expected TCP fixture address');
      const cache = new Map<string, string>();
      const url = `http://127.0.0.1:${address.port}/fixture`;
      expect((await got(url, { cache, responseType: 'json' })).body.marker).toBe('synthetic-local-fixture');
      expect((await got(url, { cache, responseType: 'json' })).body.marker).toBe('synthetic-local-fixture');
      expect(hits).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
