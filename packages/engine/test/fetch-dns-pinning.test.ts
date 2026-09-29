// The fetch tool checks where a host name resolves, not only how it is
// written: every A and AAAA answer is compared with the refused address ranges
// before each request hop (the first and every redirect), and the request is
// pinned to the checked address so a second lookup cannot rebind it.
import { afterEach, describe, expect, test } from 'bun:test';
import { executeFetchInput } from '../sdk/src/platform/tools/fetch/runtime.ts';
import { classifyHostTrustTier, classifyResolvedAddress } from '../sdk/src/platform/tools/fetch/trust-tiers.ts';
import type { HostResolver } from '../sdk/src/platform/tools/fetch/pinned-request.ts';

const DNS: Readonly<Record<string, readonly string[]>> = {
  'loopback.test': ['127.0.0.1'],
  'metadata.test': ['169.254.169.254'],
  'private.test': ['10.0.0.5'],
  'mixed.test': ['203.0.113.10', '192.168.1.20'],
  'v6-local.test': ['fd00::5'],
  'public.test': ['203.0.113.10', '2001:db8::10'],
  'hop.test': ['203.0.113.20'],
  'metadata.google.internal': ['169.254.169.254'],
  'app.localhost': ['127.0.0.1'],
};

const lookups: string[] = [];
const resolver: HostResolver = async (hostname) => {
  lookups.push(hostname);
  const answers = DNS[hostname];
  if (!answers) throw new Error(`ENOTFOUND ${hostname}`);
  return answers.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

interface SeenRequest { readonly url: string; readonly host: string | null; readonly serverName?: string | undefined }
const seen: SeenRequest[] = [];
const originalFetch = globalThis.fetch;

function stubNetwork(respond: (request: SeenRequest) => Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit & { tls?: { serverName?: string } }) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const request = { url, host: new Headers(init?.headers).get('host'), serverName: init?.tls?.serverName };
    seen.push(request);
    return respond(request);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  seen.length = 0;
  lookups.length = 0;
});

async function fetchOne(url: string) {
  const output = await executeFetchInput({ urls: [{ url }] }, { resolveHost: resolver });
  return output.results?.[0];
}

describe('fetch resolves, checks and pins every hop', () => {
  test('a name resolving to loopback is refused', async () => {
    stubNetwork(() => new Response('reached'));
    expect((await fetchOne('http://loopback.test/admin'))?.error).toMatch(/resolves to 127\.0\.0\.1, a loopback address/);
    expect(seen).toEqual([]);
  });

  test('a name resolving to the metadata endpoint is refused', async () => {
    stubNetwork(() => new Response('reached'));
    expect((await fetchOne('http://metadata.test/latest/meta-data/'))?.error).toMatch(/169\.254\.169\.254, a metadata address/);
    expect(seen).toEqual([]);
  });

  test('a name resolving to a private range is refused, IPv4 and IPv6', async () => {
    stubNetwork(() => new Response('reached'));
    expect((await fetchOne('http://private.test/'))?.error).toMatch(/10\.0\.0\.5, a private address/);
    expect((await fetchOne('http://v6-local.test/'))?.error).toMatch(/fd00::5, a unique-local address/);
    expect(seen).toEqual([]);
  });

  test('a mixed answer set is refused when any answer is in a refused range', async () => {
    stubNetwork(() => new Response('reached'));
    expect((await fetchOne('http://mixed.test/'))?.error).toMatch(/192\.168\.1\.20, a private address/);
    expect(seen).toEqual([]);
  });

  test('a cloud metadata host name is refused by the address it resolves to, with no name list', async () => {
    stubNetwork(() => new Response('reached'));
    expect(classifyHostTrustTier('metadata.google.internal').tier).toBe('unknown');
    expect((await fetchOne('http://metadata.google.internal/computeMetadata/v1/'))?.error).toMatch(/169\.254\.169\.254, a metadata address/);
    expect(seen).toEqual([]);
  });

  test('a name under .localhost is a loopback target (RFC 6761): refused unless the project approved localhost', async () => {
    stubNetwork(() => new Response('dev', { headers: { 'content-type': 'text/plain' } }));
    expect(classifyHostTrustTier('app.localhost').tier).toBe('localhost');
    const refused = await fetchOne('http://app.localhost:5173/');
    expect(refused?.host_trust_tier).toBe('localhost');
    expect(seen).toEqual([]);
    const approved = await executeFetchInput({ urls: [{ url: 'http://app.localhost:5173/' }] }, { resolveHost: resolver, isLocalhostAllowed: () => true });
    expect(approved.results?.[0]?.content).toContain('dev');
    expect(seen[0]!.url).toBe('http://127.0.0.1:5173/');
    expect(seen[0]!.host).toBe('app.localhost:5173');
  });

  test('a name that does not resolve is refused, since nothing was checked', async () => {
    stubNetwork(() => new Response('reached'));
    expect((await fetchOne('http://nowhere.test/'))?.error).toMatch(/did not resolve/);
    expect(seen).toEqual([]);
  });

  test('a redirect to a name resolving to a refused range is refused before it is followed', async () => {
    stubNetwork((request) => new Response('', { status: 302, headers: { location: request.host === 'hop.test' ? 'http://loopback.test/steal' : '/' } }));
    const result = await fetchOne('http://hop.test/start');
    expect(result?.error).toMatch(/loopback\.test" resolves to 127\.0\.0\.1/);
    expect(seen.map((request) => request.host)).toEqual(['hop.test']);
    expect(lookups).toEqual(['hop.test', 'loopback.test']);
  });

  test('a public answer passes and the request is pinned to the checked address', async () => {
    stubNetwork(() => new Response('public page', { headers: { 'content-type': 'text/plain' } }));
    const result = await fetchOne('https://public.test/doc?x=1');
    expect(result?.error).toBeUndefined();
    expect(result?.content).toContain('public page');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://203.0.113.10/doc?x=1');
    expect(seen[0]!.host).toBe('public.test');
    expect(seen[0]!.serverName).toBe('public.test');
  });

  test('when the first checked address cannot be reached the next checked answer is tried', async () => {
    stubNetwork((request) => {
      if (request.url.startsWith('https://203.0.113.10/')) throw new Error('connection refused');
      return new Response('via v6', { headers: { 'content-type': 'text/plain' } });
    });
    const result = await fetchOne('https://public.test/');
    expect(result?.content).toContain('via v6');
    expect(seen.map((request) => request.url)).toEqual(['https://203.0.113.10/', 'https://[2001:db8::10]/']);
  });
});

describe('classifyResolvedAddress', () => {
  test('declared ranges by address arithmetic', () => {
    expect(classifyResolvedAddress('127.0.0.1')).toBe('loopback');
    expect(classifyResolvedAddress('169.254.169.254')).toBe('metadata');
    expect(classifyResolvedAddress('169.254.10.1')).toBe('link-local');
    expect(classifyResolvedAddress('172.16.0.1')).toBe('private');
    expect(classifyResolvedAddress('172.32.0.1')).toBeNull();
    expect(classifyResolvedAddress('0.0.0.0')).toBe('unspecified');
    expect(classifyResolvedAddress('::1')).toBe('loopback');
    expect(classifyResolvedAddress('fe80::1')).toBe('link-local');
    expect(classifyResolvedAddress('::ffff:127.0.0.1')).toBe('loopback');
    expect(classifyResolvedAddress('::ffff:a9fe:a9fe')).toBe('metadata');
    expect(classifyResolvedAddress('8.8.8.8')).toBeNull();
    expect(classifyResolvedAddress('2606:4700::1')).toBeNull();
  });
});
