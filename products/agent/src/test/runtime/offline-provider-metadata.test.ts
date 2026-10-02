import { expect, test } from 'bun:test';
import { withOfflineProviderMetadata } from '../helpers/offline-provider-metadata.ts';

test('metadata fixture resolves only exact known GETs and restores the guarded fetch', async () => {
  const guardedFetch = globalThis.fetch;
  const { result, requests } = await withOfflineProviderMetadata(async () => (await fetch('https://openrouter.ai/api/v1/models')).json());
  expect(result).toEqual({ data: [] });
  expect(requests).toEqual(['https://openrouter.ai/api/v1/models']);
  expect(globalThis.fetch).toBe(guardedFetch);
});

for (const input of [
  { url: 'https://openrouter.ai/api/v1/models?unexpected=1' },
  { url: 'https://unlisted.invalid/models' },
  { url: 'https://openrouter.ai/api/v1/models', method: 'POST', body: 'synthetic' },
]) {
  test(`metadata fixture does not hide an unexpected ${input.method ?? 'GET'} request`, async () => {
    const guardedFetch = globalThis.fetch;
    await expect(withOfflineProviderMetadata(async () => {
      // Production may catch network failures. The fixture must still fail the test.
      await fetch(input.url, input).catch(() => undefined);
    })).rejects.toThrow('unexpected request');
    expect(globalThis.fetch).toBe(guardedFetch);
  });
}
