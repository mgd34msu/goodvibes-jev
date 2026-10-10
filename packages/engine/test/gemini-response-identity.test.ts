import { afterEach, describe, expect, test } from 'bun:test';
import { GeminiProvider } from '../sdk/src/platform/providers/gemini.js';
import { SyntheticProvider } from '../sdk/src/platform/providers/synthetic.js';
import { createGeminiResponseIdentityAccumulator, MAX_GEMINI_RESPONSE_IDENTITY_LENGTH } from '../sdk/src/platform/providers/gemini-response-identity.js';
import type { ChatRequest } from '../sdk/src/platform/providers/interface.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const requested = { provider: 'gemini', adapterKind: 'gemini' as const, model: 'gemini-requested-alias' };
const request = (model = requested.model): ChatRequest => ({ model, messages: [{ role: 'user', content: 'hello' }] });
const encode = (chunk: unknown, terminated = true) => new TextEncoder().encode(`data: ${JSON.stringify(chunk)}${terminated ? '\n\n' : ''}`);
const contentChunk = { candidates: [{ content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 } };
function installFetch(respond: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://generativelanguage.googleapis.com/v1beta/models/')) return new Response('outside test scope', { status: 404 });
    return respond(url);
  }) as typeof fetch;
}
function stream(chunks: unknown[], finalTerminated = true): Response {
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    chunks.forEach((chunk, i) => controller.enqueue(encode(chunk, i < chunks.length - 1 || finalTerminated)));
    controller.close();
  } }));
}

describe('bounded provider-reported identity', () => {
  test('missing fields stay missing; responseId is not model evidence', () => {
    const identity = createGeminiResponseIdentityAccumulator(requested);
    expect(identity.snapshot().modelVersion).toEqual({ status: 'missing' });
    identity.observe({ responseId: 'response-only' });
    expect(identity.snapshot()).toEqual({ requested, source: 'provider-reported', hasUnparsedDataChunks: false, modelVersion: { status: 'missing' }, responseId: { status: 'observed', value: 'response-only' } });
  });

  test.each([null, undefined, '', ' ', ' padded', 'padded ', 'line\nbreak', 'control\u007f', 'nonascii-é', 42, {}, [], 'x'.repeat(MAX_GEMINI_RESPONSE_IDENTITY_LENGTH + 1)].map(value => ({ value })))('rejects malformed or oversized values without retaining them (%j)', ({ value }) => {
    const identity = createGeminiResponseIdentityAccumulator(requested);
    identity.observe({ modelVersion: value, responseId: value });
    identity.observe({ modelVersion: 'later-valid', responseId: 'later-valid' });
    expect(identity.snapshot().modelVersion).toEqual({ status: 'rejected', reasons: ['invalid'] });
    expect(identity.snapshot().responseId).toEqual({ status: 'rejected', reasons: ['invalid'] });
    expect(JSON.stringify(identity.snapshot())).not.toContain('later-valid');
  });

  test('identical repeated values and the exact length boundary are accepted', () => {
    const identity = createGeminiResponseIdentityAccumulator(requested);
    const value = 'x'.repeat(MAX_GEMINI_RESPONSE_IDENTITY_LENGTH);
    identity.observe({ modelVersion: value, responseId: value });
    identity.observe({});
    identity.observe({ modelVersion: value, responseId: value });
    expect(identity.snapshot().modelVersion).toEqual({ status: 'observed', value });
    expect(identity.snapshot().responseId).toEqual({ status: 'observed', value });
  });

  test('conflicts cannot be overwritten, and invalid plus conflicting evidence stays explicit', () => {
    const identity = createGeminiResponseIdentityAccumulator(requested);
    identity.observe({ modelVersion: 'first', responseId: 'first' });
    identity.observe({ modelVersion: 'second', responseId: 'second' });
    identity.observe({ modelVersion: 'first', responseId: 'first' });
    expect(identity.snapshot().modelVersion).toEqual({ status: 'rejected', reasons: ['conflicting'] });
    identity.observe({ modelVersion: null });
    expect(identity.snapshot().modelVersion).toEqual({ status: 'rejected', reasons: ['invalid', 'conflicting'] });
    expect(identity.snapshot().responseId).toEqual({ status: 'rejected', reasons: ['conflicting'] });
  });
});

test('Gemini captures metadata-only chunks and final unterminated identity without changing content or usage', async () => {
  installFetch(() => stream([{ modelVersion: 'gemini-version-a' }, contentChunk, { modelVersion: 'gemini-version-a', responseId: 'response-a' }], false));
  const deltas: string[] = [];
  const result = await new GeminiProvider('fixture-key').chat({ ...request(), onDelta: delta => { if (delta.content) deltas.push(delta.content); } });
  expect(result.responseIdentity).toEqual({ requested, source: 'provider-reported', hasUnparsedDataChunks: false, modelVersion: { status: 'observed', value: 'gemini-version-a' }, responseId: { status: 'observed', value: 'response-a' } });
  expect(result.content).toBe('hello');
  expect(deltas).toEqual(['hello']);
  expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 3 });
  expect(result.stopReason).toBe('completed');
});

test('Gemini reports missing, malformed and conflicting fields from the wire', async () => {
  const scripted = [stream([contentChunk]), stream([{ modelVersion: null, responseId: 'x'.repeat(513) }, contentChunk]), stream([{ modelVersion: 'a', responseId: 'r1' }, contentChunk, { modelVersion: 'b', responseId: 'r2' }], false)];
  installFetch(() => scripted.shift()!);
  const provider = new GeminiProvider('fixture-key');
  const missing = await provider.chat(request());
  expect(missing.responseIdentity?.modelVersion).toEqual({ status: 'missing' });
  expect(missing.responseIdentity?.responseId).toEqual({ status: 'missing' });
  const malformed = await provider.chat(request());
  expect(malformed.responseIdentity?.modelVersion).toEqual({ status: 'rejected', reasons: ['invalid'] });
  expect(malformed.responseIdentity?.responseId).toEqual({ status: 'rejected', reasons: ['invalid'] });
  const conflict = await provider.chat(request());
  expect(conflict.responseIdentity?.modelVersion).toEqual({ status: 'rejected', reasons: ['conflicting'] });
  expect(conflict.responseIdentity?.responseId).toEqual({ status: 'rejected', reasons: ['conflicting'] });
});

test('concurrent calls on one provider retain independent identities', async () => {
  const controllers = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  let bothStarted!: () => void;
  const ready = new Promise<void>(resolve => { bothStarted = resolve; });
  installFetch(url => {
    const model = url.includes('/call-a:') ? 'call-a' : 'call-b';
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controllers.set(model, controller);
      controller.enqueue(encode({ modelVersion: `${model}-version` }));
      if (controllers.size === 2) bothStarted();
    } }));
  });
  const provider = new GeminiProvider('fixture-key');
  const a = provider.chat(request('call-a'));
  const b = provider.chat(request('call-b'));
  await ready;
  for (const model of ['call-b', 'call-a']) {
    const controller = controllers.get(model)!;
    controller.enqueue(encode(contentChunk));
    controller.enqueue(encode({ responseId: `${model}-response` }, false));
    controller.close();
  }
  const results = await Promise.all([a, b]);
  for (const [index, model] of ['call-a', 'call-b'].entries()) {
    expect(results[index]!.responseIdentity).toEqual({ requested: { ...requested, model }, source: 'provider-reported', hasUnparsedDataChunks: false, modelVersion: { status: 'observed', value: `${model}-version` }, responseId: { status: 'observed', value: `${model}-response` } });
  }
});

test('failed partial stream identity is discarded before an actual transport retry', async () => {
  let attempts = 0;
  let retries = 0;
  installFetch(() => {
    if (++attempts > 1) return stream([{ modelVersion: 'successful-version', responseId: 'successful-response' }, contentChunk]);
    let pulls = 0;
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      const pull = pulls++;
      if (pull === 0) controller.enqueue(encode({ modelVersion: 'failed-version', responseId: 'failed-response' }));
      else if (pull === 1) controller.enqueue(new TextEncoder().encode('data: {malformed-json}\n\n'));
      else controller.error(Object.assign(new Error('fixture stream dropped'), { status: 503 }));
    } }));
  });
  const result = await new GeminiProvider('fixture-key').chat({ ...request(), onRetry: () => { retries++; } });
  expect(attempts).toBe(2);
  expect(retries).toBe(1);
  expect(result.responseIdentity?.hasUnparsedDataChunks).toBe(false);
  expect(result.responseIdentity?.modelVersion).toEqual({ status: 'observed', value: 'successful-version' });
  expect(result.responseIdentity?.responseId).toEqual({ status: 'observed', value: 'successful-response' });
}, 10_000);

test('synthetic wrapper preserves the successful response and its adapter request unchanged', async () => {
  installFetch(() => stream([{ modelVersion: 'backend-version', responseId: 'backend-response' }, contentChunk]));
  const backend = new GeminiProvider('fixture-key');
  const response = await backend.chat(request());
  const synthetic = new SyntheticProvider({
    resolveProvider: () => ({ name: 'gemini', models: [requested.model], chat: async params => {
      expect(params.model).toBe(requested.model);
      return response;
    } }),
    getBenchmarks: () => undefined,
    getCatalogModels: () => [{ id: 'fixture-canonical', tier: 'paid', backendCount: 1, keyedBackendCount: 1, backends: [{ providerName: 'gemini', modelId: requested.model }] }],
  });
  const result = await synthetic.chat(request('fixture-canonical'));
  expect(result).toBe(response);
  expect(result.responseIdentity?.requested.model).toBe(requested.model);
});


test('requested identity is snapshotted at creation and returned snapshots cannot alter it', () => {
  const mutable = { ...requested };
  const identity = createGeminiResponseIdentityAccumulator(mutable);
  mutable.model = 'mutated-before-observation';
  identity.observe({ modelVersion: 'reported' });
  const snapshot = identity.snapshot();
  Object.assign(snapshot.requested, { model: 'mutated-returned-snapshot' });
  expect(identity.snapshot().requested).toEqual(requested);
});

test('malformed SSE data exposes a parse gap without discarding valid identity or changing success behavior', async () => {
  installFetch(() => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(encode({ modelVersion: 'valid-version', responseId: 'valid-response' }));
    controller.enqueue(new TextEncoder().encode('data: {malformed-json}\n\n'));
    controller.enqueue(encode(contentChunk, false));
    controller.close();
  } })));
  let retries = 0;
  const result = await new GeminiProvider('fixture-key').chat({ ...request(), onRetry: () => { retries++; } });
  expect(result.responseIdentity).toEqual({ requested, source: 'provider-reported', hasUnparsedDataChunks: true, modelVersion: { status: 'observed', value: 'valid-version' }, responseId: { status: 'observed', value: 'valid-response' } });
  expect(result.content).toBe('hello');
  expect(result.stopReason).toBe('completed');
  expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 3 });
  expect(retries).toBe(0);
});

test('fragmented bytes and CRLF lines preserve identity and normal content', async () => {
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify({ modelVersion: 'fragmented-version' })}\r\n\r\ndata: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'héllo' }] }, finishReason: 'STOP' }] })}\r\n\r\ndata: ${JSON.stringify({ responseId: 'fragmented-response' })}`);
  installFetch(() => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } })));
  const result = await new GeminiProvider('fixture-key').chat(request());
  expect(result.content).toBe('héllo');
  expect(result.responseIdentity?.hasUnparsedDataChunks).toBe(false);
  expect(result.responseIdentity?.modelVersion).toEqual({ status: 'observed', value: 'fragmented-version' });
  expect(result.responseIdentity?.responseId).toEqual({ status: 'observed', value: 'fragmented-response' });
});

test('cancellation after partial identity returns no response and does not contaminate the next call', async () => {
  const abort = new AbortController();
  let retries = 0;
  installFetch(() => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(encode({ modelVersion: 'cancelled-version', responseId: 'cancelled-response' }));
    controller.enqueue(encode(contentChunk));
    abort.signal.addEventListener('abort', () => controller.error(new DOMException('fixture cancelled', 'AbortError')), { once: true });
  } })));
  const provider = new GeminiProvider('fixture-key');
  await expect(provider.chat({ ...request(), signal: abort.signal, onDelta: () => abort.abort(), onRetry: () => { retries++; } })).rejects.toThrow('fixture cancelled');
  expect(retries).toBe(0);
  installFetch(() => stream([contentChunk]));
  const result = await provider.chat(request());
  expect(result.responseIdentity?.modelVersion).toEqual({ status: 'missing' });
  expect(result.responseIdentity?.responseId).toEqual({ status: 'missing' });
});
