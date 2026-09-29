import { afterEach, describe, expect, test } from 'bun:test';
import { validatePublicWebhookUrl } from '@goodvibes-jev/engine/sdk/platform/utils';
import { postToPublicWebhook } from '../sdk/src/platform/utils/url-safety.ts';
import type { HostResolver } from '../sdk/src/platform/tools/fetch/pinned-request.ts';

describe('validatePublicWebhookUrl', () => {
  test('accepts normalized public https webhook URLs', () => {
    expect(validatePublicWebhookUrl('https://example.com/callback?run=1')).toEqual({
      ok: true,
      url: 'https://example.com/callback?run=1',
    });
  });

  test('rejects non-public or credential-bearing webhook URLs', () => {
    const unsafeUrls = [
      'http://example.com/callback',
      'https://user:pass@example.com/callback',
      'https://localhost/callback',
      'https://api.localhost/callback',
      'https://127.0.0.1/callback',
      'https://10.0.0.5/callback',
      'https://172.16.0.5/callback',
      'https://192.168.1.5/callback',
      'https://[::1]/callback',
      'https://[::ffff:127.0.0.1]/callback',
      'https://[fd00::1]/callback',
      'https://[fe80::1]/callback',
      'https://169.254.169.254/latest',
      'https://224.0.0.1/callback',
    ];

    for (const url of unsafeUrls) {
      expect(validatePublicWebhookUrl(url).ok).toBe(false);
    }
  });
});

// At delivery the host is resolved and every answer checked, then the request
// is pinned to a checked address: the same check the fetch tool makes.
const DNS: Readonly<Record<string, readonly string[]>> = {
  'metadata.google.internal': ['169.254.169.254'],
  'hooks.internal.example': ['10.0.0.8'],
  'mixed.example': ['203.0.113.30', '127.0.0.1'],
  'hooks.example': ['203.0.113.31'],
};
const resolveHost: HostResolver = async (host) => {
  const answers = DNS[host];
  if (!answers) throw new Error(`ENOTFOUND ${host}`);
  return answers.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};
const originalFetch = globalThis.fetch;
const sent: Array<{ url: string; host: string | null; redirect?: RequestRedirect | undefined }> = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  sent.length = 0;
});
function stub(response: () => Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), host: new Headers(init?.headers).get('host'), redirect: init?.redirect });
    return response();
  }) as typeof fetch;
}

describe('postToPublicWebhook', () => {
  test('a name resolving to the metadata endpoint, a private range or a mixed answer set is refused before sending', async () => {
    stub(() => new Response('ok'));
    await expect(postToPublicWebhook('https://metadata.google.internal/computeMetadata/v1', { method: 'POST' }, { resolveHost })).rejects.toThrow(/169\.254\.169\.254, a metadata address/);
    await expect(postToPublicWebhook('https://hooks.internal.example/h', { method: 'POST' }, { resolveHost })).rejects.toThrow(/10\.0\.0\.8, a private address/);
    await expect(postToPublicWebhook('https://mixed.example/h', { method: 'POST' }, { resolveHost })).rejects.toThrow(/127\.0\.0\.1, a loopback address/);
    expect(sent).toEqual([]);
  });

  test('a public answer is sent pinned to the checked address, and a redirect is not followed', async () => {
    stub(() => new Response(null, { status: 302, headers: { location: 'https://hooks.internal.example/steal' } }));
    const response = await postToPublicWebhook('https://hooks.example/h?run=1', { method: 'POST', body: '{}' }, { resolveHost });
    expect(response.status).toBe(302);
    expect(sent).toEqual([{ url: 'https://203.0.113.31/h?run=1', host: 'hooks.example', redirect: 'manual' }]);
  });

  test('an unsafe URL is refused without a lookup', async () => {
    stub(() => new Response('ok'));
    await expect(postToPublicWebhook('http://hooks.example/h', { method: 'POST' }, { resolveHost })).rejects.toThrow(/must use https/);
    expect(sent).toEqual([]);
  });
});
