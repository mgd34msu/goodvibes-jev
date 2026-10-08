import { expect, test } from 'bun:test';
import { createBuiltinMemoryEmbeddingProviders } from '../sdk/src/platform/state/memory-embedding-http.js';

// No network or credentials: the HTTP transport is a scripted in-process fetch.
test('concrete HTTP embedding admission rejects revoked attempts before fetch and forwards cancellation', async () => {
  let permitted = true; let fetches = 0; let observedSignal: AbortSignal | null | undefined; let redirect: RequestRedirect | undefined;
  const signal = new AbortController();
  const providers = createBuiltinMemoryEmbeddingProviders({ env: { OPENAI_COMPATIBLE_BASE_URL: 'http://fixture.invalid/v1' }, fetchImpl: async (_input, init) => {
    fetches++; observedSignal = init?.signal; redirect = init?.redirect;
    return new Response(JSON.stringify({ data: [{ embedding: Array.from({ length: 384 }, (_, i) => i === 0 ? 1 : 0) }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  const provider = providers.find(p => p.id === 'openai-compatible')!;
  expect(provider.capturedInputAdmission).toBe('per-attempt');
  const request = { text: 'authorized fixture', dimensions: 384, usage: 'record' as const, signal: signal.signal, beforeAttempt: async () => { await Promise.resolve(); if (!permitted) throw new Error('revoked before concrete HTTP attempt'); } };
  await provider.embed!(request);
  expect(fetches).toBe(1); expect(observedSignal).toBe(signal.signal); expect(redirect).toBe('error');
  permitted = false;
  await expect(provider.embed!(request)).rejects.toThrow('revoked before concrete HTTP attempt');
  expect(fetches).toBe(1);
  signal.abort(new Error('cancelled before dispatch'));
  await expect(provider.embed!({ ...request, beforeAttempt: async () => {} })).rejects.toThrow('cancelled before dispatch');
  expect(fetches).toBe(1);
  await provider.embed!({ text: 'ordinary fixture', dimensions: 384, usage: 'record' });
  expect(fetches).toBe(2); expect(redirect).toBeUndefined();
});
