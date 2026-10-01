import { describe, expect, test } from 'bun:test';
import { createPluginAPI, type PluginAPIContext } from '../sdk/src/platform/plugins/api.ts';
import { createOwnedPluginCapabilities } from '../sdk/src/platform/plugins/owned-capabilities.ts';
import { PluginClosedError, PluginInFlightTracker } from '../sdk/src/platform/plugins/in-flight.ts';
import { ChannelPluginRegistry } from '../sdk/src/platform/channels/plugin-registry.ts';
import type { ChannelPlugin } from '../sdk/src/platform/channels/plugin-registry.ts';
import type { LLMProvider, ChatRequest, ChatResponse } from '../sdk/src/platform/providers/interface.ts';
import type { VoiceProvider, VoiceAudioChunk } from '../sdk/src/platform/voice/types.ts';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function turns() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

function ownership() {
  const tracker = new PluginInFlightTracker();
  const owned = createOwnedPluginCapabilities((call) => tracker.track('fixture', call));
  return { tracker, owned, close: () => tracker.close('fixture') };
}

const response: ChatResponse = { content: 'fixture', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'completed' };
const request: ChatRequest = { messages: [], model: 'fixture' };

test('a frozen class provider retains receiver/private fields, live metadata and nested batch ownership', async () => {
  const hold = gate();
  class Provider implements LLMProvider {
    #secret = 'receiver';
    readonly name = 'fixture';
    readonly models = ['first'];
    batch = { kind: 'provider-batch' as const, endpoints: [],
      async createChatBatch() { await hold.promise; return { providerBatchId: 'batch', status: 'completed' as const }; },
      async retrieveBatch() { return { providerBatchId: 'batch', status: 'completed' as const, resultAvailable: true }; },
      async getResults() { return []; },
    };
    async chat() { expect(this.#secret).toBe('receiver'); await hold.promise; return response; }
    isConfigured() { return this.#secret === 'receiver'; }
  }
  const source = Object.freeze(new Provider());
  const fx = ownership();
  const provider = fx.owned.provider(source);
  expect(provider.isConfigured?.()).toBe(true);
  expect(provider.constructor).toBe(Provider);
  source.models.push('second');
  expect(provider.models).toEqual(['first', 'second']);
  const call = provider.chat(request);
  const batch = provider.batch?.createChatBatch({ requests: [] });
  let closed = false;
  const closing = fx.close().then(() => { closed = true; });
  try {
    await turns();
    expect(closed).toBe(false);
    expect(fx.tracker.inFlight('fixture')).toBe(2);
    await expect(provider.chat(request)).rejects.toThrow(PluginClosedError);
    await expect(provider.batch!.getResults('batch')).rejects.toThrow(PluginClosedError);
    expect(() => provider.isConfigured?.()).toThrow(PluginClosedError);
  } finally { hold.release(); await Promise.all([call, batch, closing]); }
  expect(await call).toBe(response);
});

test('real channel registry and returned agent tools share the owned callback lifetime', async () => {
  const fx = ownership();
  const hold = gate();
  const source: ChannelPlugin = Object.freeze({
    id: 'fixture', surface: 'webhook', displayName: 'Fixture', capabilities: [],
    async runTool() { expect(this.id).toBe('fixture'); await hold.promise; return 'channel result'; },
    listAgentTools() { return [{ definition: { name: 'nested', description: '', parameters: {} }, async execute() { await hold.promise; return { success: true, output: this.definition.name }; } }]; },
  });
  const channels = new ChannelPluginRegistry();
  channels.register(fx.owned.channel(source));
  const captured = channels.get('fixture')!;
  const tools = channels.listAgentTools('webhook');
  const channelCall = channels.runTool('webhook', 'fixture');
  const toolCall = tools[0]!.execute({});
  const closing = fx.close();
  try {
    expect(fx.tracker.inFlight('fixture')).toBe(2);
    await expect(captured.runTool!('late')).rejects.toThrow(PluginClosedError);
    await expect(tools[0]!.execute({})).rejects.toThrow(PluginClosedError);
  } finally { hold.release(); await Promise.all([closing, channelCall, toolCall]); }
  expect(await channelCall).toBe('channel result');
  expect((await toolCall).output).toBe('nested');
});

describe('voice stream ownership', () => {
  test('retains a started iterator until its real return/finally settles', async () => {
    const fx = ownership();
    const hold = gate();
    const cleanup = gate();
    const returning = gate();
    let produced = 0;
    const provider: VoiceProvider = { id: 'fixture', label: 'Fixture', capabilities: ['tts-stream'], synthesizeStream() {
      const chunks = (async function* () {
        try { await hold.promise; produced++; yield { data: new Uint8Array([1]), sequence: 0 }; }
        finally { returning.release(); await cleanup.promise; }
      })();
      return { providerId: this.id, mimeType: 'audio/wav', format: 'wav', metadata: { marker: 'kept' }, chunks };
    } };
    const result = await fx.owned.voice(provider).synthesizeStream!({ text: 'fixture' });
    expect(produced).toBe(0);
    const iterator = result.chunks[Symbol.asyncIterator]();
    const next = iterator.next();
    let closed = false;
    const closing = fx.close().then(() => { closed = true; });
    hold.release();
    expect((await next).value?.sequence).toBe(0);
    const returned = iterator.return!();
    await returning.promise;
    expect(closed).toBe(false);
    expect(fx.tracker.inFlight('fixture')).toBe(1);
    cleanup.release();
    await returned; await closing;
    expect(result.metadata).toEqual({ marker: 'kept' });
    expect(() => result.chunks[Symbol.asyncIterator]()).toThrow(PluginClosedError);
  });

  test('an unconsumed stream is honestly pending and an explicit iterator return releases it', async () => {
    const fx = ownership();
    let produced = 0;
    const provider: VoiceProvider = { id: 'fixture', label: '', capabilities: ['tts-stream'], synthesizeStream() {
      return { providerId: 'fixture', mimeType: 'audio/wav', format: 'wav', metadata: {}, chunks: (async function* () { produced++; yield { data: new Uint8Array(), sequence: 0 }; })() };
    } };
    const result = await fx.owned.voice(provider).synthesizeStream!({ text: '' });
    let closed = false;
    const closing = fx.close().then(() => { closed = true; });
    await turns(); expect(closed).toBe(false); expect(produced).toBe(0);
    await result.chunks[Symbol.asyncIterator]().return!();
    await closing; expect(produced).toBe(0);
  });

  test.each(['eof', 'error'] as const)('settles ownership on iterator %s while preserving its result', async (mode) => {
    const fx = ownership();
    const failure = new Error('stream failure');
    const provider: VoiceProvider = { id: 'fixture', label: '', capabilities: ['tts-stream'], synthesizeStream() {
      return { providerId: 'fixture', mimeType: 'audio/wav', format: 'wav', metadata: {}, chunks: (async function* (): AsyncGenerator<VoiceAudioChunk> { if (mode === 'error') throw failure; })() };
    } };
    const result = await fx.owned.voice(provider).synthesizeStream!({ text: '' });
    const iterator = result.chunks[Symbol.asyncIterator]();
    if (mode === 'error') await expect(iterator.next()).rejects.toBe(failure);
    else expect((await iterator.next()).done).toBe(true);
    await fx.close(); expect(fx.tracker.inFlight('fixture')).toBe(0);
  });

  test('return cannot release a concurrently pending next call early', async () => {
    const fx = ownership();
    const hold = gate();
    const provider: VoiceProvider = { id: 'fixture', label: '', capabilities: ['tts-stream'], synthesizeStream() {
      return { providerId: 'fixture', mimeType: 'audio/wav', format: 'wav', metadata: {}, chunks: { [Symbol.asyncIterator]() {
        return { async next() { await hold.promise; return { done: false, value: { data: new Uint8Array(), sequence: 0 } }; }, async return() { return { done: true as const, value: undefined }; } };
      } } };
    } };
    const result = await fx.owned.voice(provider).synthesizeStream!({ text: '' });
    const iterator = result.chunks[Symbol.asyncIterator]();
    const next = iterator.next();
    let closed = false;
    const closing = fx.close().then(() => { closed = true; });
    await iterator.return!(); await turns(); expect(closed).toBe(false);
    hold.release(); await next; await closing;
  });
});

test.each(['read', 'cancel'] as const)('channel Response preserves backpressure and drains body %s', async (mode) => {
  const fx = ownership();
  const hold = gate();
  const cancelling = gate();
  let pulls = 0;
  let cancellations = 0;
  const original = new Response(new ReadableStream<Uint8Array>({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array([65])); controller.close(); },
    async cancel() { cancellations++; cancelling.release(); await hold.promise; },
  }, { highWaterMark: 0 }), { status: 202, headers: { 'x-fixture': 'kept' } });
  const source: ChannelPlugin = { id: 'fixture', surface: 'webhook', displayName: '', capabilities: [], async handleInbound() { return original; } };
  const result = await fx.owned.channel(source).handleInbound!(new Request('http://127.0.0.1/fixture'));
  expect(result.status).toBe(202); expect(result.headers.get('x-fixture')).toBe('kept'); expect(result.type).toBe(original.type);
  expect(pulls).toBe(0);
  let closed = false;
  const closing = fx.close().then(() => { closed = true; });
  await turns(); expect(closed).toBe(false);
  if (mode === 'read') { expect(await result.text()).toBe('A'); expect(pulls).toBe(1); }
  else {
    const cancelled = result.body!.cancel('fixture stop');
    await cancelling.promise; expect(closed).toBe(false);
    hold.release(); await cancelled; expect(cancellations).toBe(1); expect(pulls).toBe(0);
  }
  await closing;
});

test('every API registration family installs an owned callable rather than the raw object', async () => {
  const tracker = new PluginInFlightTracker();
  const registrations = new PluginInFlightTracker();
  const captured = new Map<string, object>();
  const cleanup: Array<() => void> = [];
  const registry = (kind: string) => ({ register(value: object) { captured.set(kind, value); return () => captured.delete(kind); } });
  const api = createPluginAPI({ pluginName: 'fixture', inFlight: tracker, registrations, cleanup,
    providerRegistry: { registerRuntimeProvider(value: { provider: object }) { captured.set('provider', value.provider); return () => captured.delete('provider'); }, has() { return captured.has('provider'); }, getRegistered() { return captured.get('provider'); } },
    channelDeliveryRouter: { registerStrategy(value: object) { captured.set('delivery', value); }, listStrategies() { return [...captured.values()]; }, unregisterStrategy() { captured.delete('delivery'); } },
    memoryEmbeddingRegistry: registry('memory'), voiceProviderRegistry: registry('voice'), mediaProviderRegistry: registry('media'), webSearchProviderRegistry: registry('search'),
  } as unknown as PluginAPIContext);
  api.registerProviderInstance({ provider: { name: 'fixture', models: [], async chat() { return response; } } });
  api.registerDeliveryStrategy({ id: 'fixture', canHandle: () => true, async deliver() { return {}; } });
  api.registerMemoryEmbeddingProvider({ id: 'fixture', label: '', dimensions: 1, async embed() { return { vector: new Float32Array([1]), dimensions: 1 }; } });
  api.registerVoiceProvider({ id: 'fixture', label: '', capabilities: [], async listVoices() { return []; } });
  api.registerMediaProvider({ id: 'fixture', label: '', capabilities: [], async status() { return { id: 'fixture', label: '', state: 'healthy', configured: true, capabilities: [], metadata: {} }; } });
  api.registerWebSearchProvider({ id: 'fixture', label: '', capabilities: [], async search() { return { results: [], metadata: {} }; } });
  await tracker.close(); await registrations.close();
  for (const [kind, method] of [['provider', 'chat'], ['delivery', 'deliver'], ['memory', 'embed'], ['voice', 'listVoices'], ['media', 'status'], ['search', 'search']]) {
    const value = captured.get(kind!);
    if (!value) throw new Error(`missing ${kind} registration`);
    const call = Reflect.get(value, method!) as () => Promise<unknown>;
    await expect(Promise.resolve().then(() => call())).rejects.toThrow(PluginClosedError);
  }
  for (const dispose of cleanup) dispose();
  expect(captured.size).toBe(0);
});

test('ignored async registration has no detached outer rejection and still rejects for an awaiting caller', async () => {
  const tracker = new PluginInFlightTracker();
  const registrations = new PluginInFlightTracker();
  const unhandled: unknown[] = [];
  const observed = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', observed);
  try {
    const api = createPluginAPI({ pluginName: 'fixture', inFlight: tracker, registrations, cleanup: [],
      providerRegistry: { registerRuntimeProvider() { throw new Error('closed registration reached registry'); } },
    } as unknown as PluginAPIContext);
    void api.registerProvider('fixture', { baseURL: 'http://127.0.0.1:1', models: ['fixture'] });
    await tracker.close('fixture'); await registrations.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
    expect(registrations.inFlight('fixture')).toBe(0);
    await expect(api.registerProvider('late', { baseURL: 'http://127.0.0.1:1', models: [] })).rejects.toThrow(PluginClosedError);
  } finally { process.removeListener('unhandledRejection', observed); }
});

test('the convenience OpenAI registration also installs the owned callback facade', async () => {
  const tracker = new PluginInFlightTracker();
  const registrations = new PluginInFlightTracker();
  const cleanup: Array<() => void> = [];
  let registered: LLMProvider | undefined;
  const api = createPluginAPI({ pluginName: 'fixture', inFlight: tracker, registrations, cleanup,
    providerRegistry: {
      registerRuntimeProvider(value: { provider: LLMProvider }) { registered = value.provider; return () => { registered = undefined; }; },
      has() { return registered !== undefined; }, getRegistered() { return registered; },
    },
  } as unknown as PluginAPIContext);
  await api.registerProvider('fixture', { baseURL: 'http://127.0.0.1:1', models: ['fixture'] });
  if (!registered?.isConfigured) throw new Error('fixture provider not registered');
  const captured = registered;
  await tracker.close(); await registrations.close();
  expect(() => captured.isConfigured!()).toThrow(PluginClosedError);
  for (const dispose of cleanup) dispose();
  expect(registered).toBeUndefined();
});

test('cleanup does not remove a newer provider or strategy occupying the same registry key', async () => {
  const { ChannelDeliveryRouter } = await import('../sdk/src/platform/channels/delivery-router.ts');
  const router = new ChannelDeliveryRouter({ strategies: [] });
  const providers = new Map<string, LLMProvider>();
  const cleanup: Array<() => void> = [];
  const api = createPluginAPI({ pluginName: 'fixture', cleanup,
    channelDeliveryRouter: router,
    providerRegistry: {
      registerRuntimeProvider(value: { provider: LLMProvider }) { providers.set(value.provider.name, value.provider); return () => providers.delete(value.provider.name); },
      has(name: string) { return providers.has(name); }, getRegistered(name: string) { return providers.get(name); },
    },
  } as unknown as PluginAPIContext);
  api.registerProviderInstance({ provider: { name: 'fixture', models: [], async chat() { return response; } } });
  api.registerDeliveryStrategy({ id: 'fixture', canHandle: () => false, async deliver() { return {}; } });
  const replacement: LLMProvider = { name: 'fixture', models: [], async chat() { return response; } };
  const replacementStrategy = { id: 'fixture', canHandle: () => true, async deliver() { return { responseId: 'replacement' }; } };
  providers.set('fixture', replacement);
  router.registerStrategy(replacementStrategy, { replace: true });
  for (const dispose of cleanup) dispose();
  expect(providers.get('fixture')).toBe(replacement);
  expect(router.listStrategies()).toContain(replacementStrategy);
});

test('stream creation rejection releases its admission and preserves the original error', async () => {
  const fx = ownership();
  const hold = gate();
  const failure = new Error('creation failed');
  const source: VoiceProvider = { id: 'fixture', label: '', capabilities: ['tts-stream'], async synthesizeStream() { await hold.promise; throw failure; } };
  const result = Promise.resolve(fx.owned.voice(source).synthesizeStream!({ text: '' })).catch((error: unknown) => error);
  let closed = false;
  const closing = fx.close().then(() => { closed = true; });
  await turns(); expect(closed).toBe(false);
  hold.release(); expect(await result).toBe(failure); await closing;
  expect(fx.tracker.inFlight('fixture')).toBe(0);
});

test('a failing Response stream preserves its error and releases owned activity', async () => {
  const fx = ownership();
  const failure = new Error('body failed');
  const source: ChannelPlugin = { id: 'fixture', surface: 'webhook', displayName: '', capabilities: [], async handleInbound() {
    return new Response(new ReadableStream({ pull(controller) { controller.error(failure); } }, { highWaterMark: 0 }));
  } };
  const result = await fx.owned.channel(source).handleInbound!(new Request('http://127.0.0.1/fixture'));
  await expect(result.text()).rejects.toBe(failure);
  await fx.close(); expect(fx.tracker.inFlight('fixture')).toBe(0);
});

test('Response cancellation cannot finish ownership while its actual cancel callback is held', async () => {
  const fx = ownership();
  const pulling = gate();
  const pulled = gate();
  const cancelled = gate();
  const cancelHold = gate();
  const source: ChannelPlugin = { id: 'fixture', surface: 'webhook', displayName: '', capabilities: [], async handleInbound() {
    return new Response(new ReadableStream<Uint8Array>({
      async pull() { pulling.release(); await pulled.promise; },
      async cancel() { cancelled.release(); await cancelHold.promise; },
    }, { highWaterMark: 0 }));
  } };
  const result = await fx.owned.channel(source).handleInbound!(new Request('http://127.0.0.1/fixture'));
  const reader = result.body!.getReader();
  const read = reader.read();
  await pulling.promise;
  let closed = false;
  const closing = fx.close().then(() => { closed = true; });
  const cancel = reader.cancel();
  try {
    await cancelled.promise; await read; await turns();
    expect(closed).toBe(false);
    expect(fx.tracker.inFlight('fixture')).toBe(1);
  } finally { cancelHold.release(); pulled.release(); await cancel; await closing; reader.releaseLock(); }
});

test('a frozen stream result preserves required prototype getters and their private receiver', async () => {
  const fx = ownership();
  class StreamResult {
    #providerId = 'class-fixture';
    get providerId() { return this.#providerId; }
    get mimeType() { return 'audio/wav'; }
    get format() { return 'wav'; }
    get metadata() { return { receiver: this.#providerId }; }
    get chunks(): AsyncIterable<VoiceAudioChunk> { return (async function* (): AsyncGenerator<VoiceAudioChunk> {})(); }
  }
  const result = Object.freeze(new StreamResult());
  const provider: VoiceProvider = { id: 'fixture', label: '', capabilities: ['tts-stream'], synthesizeStream() { return result; } };
  const owned = await fx.owned.voice(provider).synthesizeStream!({ text: '' });
  try {
    expect(owned.providerId).toBe('class-fixture');
    expect(owned.mimeType).toBe('audio/wav');
    expect(owned.format).toBe('wav');
    expect(owned.metadata).toEqual({ receiver: 'class-fixture' });
    expect(owned.chunks).toBe(owned.chunks);
  } finally { await owned.chunks[Symbol.asyncIterator]().return!(); await fx.close(); }
});

test('the owned Response retains BYOB reading for native byte streams', async () => {
  const fx = ownership();
  const original = new Response(new ReadableStream<Uint8Array>({ type: 'bytes',
    pull(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); },
  }));
  const source: ChannelPlugin = { id: 'fixture', surface: 'webhook', displayName: '', capabilities: [], async handleInbound() { return original; } };
  const result = await fx.owned.channel(source).handleInbound!(new Request('http://127.0.0.1/fixture'));
  const reader = result.body!.getReader({ mode: 'byob' });
  try {
    const first = await reader.read(new Uint8Array(8));
    expect(first.done).toBe(false);
    expect([...first.value!]).toEqual([1, 2, 3]);
    const last = await reader.read(new Uint8Array(8));
    expect(last.done).toBe(true);
    await fx.close();
  } finally { await reader.cancel(); reader.releaseLock(); }
});

test('real registries retain tracked prototype methods through their normalization copies', async () => {
  const { MediaProviderRegistry } = await import('../sdk/src/platform/media/provider-registry.ts');
  const { VoiceProviderRegistry } = await import('../sdk/src/platform/voice/provider-registry.ts');
  const { MemoryEmbeddingProviderRegistry } = await import('../sdk/src/platform/state/memory-embeddings.ts');
  const { WebSearchProviderRegistry } = await import('../sdk/src/platform/web-search/provider-registry.ts');
  const media = new MediaProviderRegistry();
  const voice = new VoiceProviderRegistry();
  const memory = new MemoryEmbeddingProviderRegistry({ configManager: { get: () => '' } as never });
  const search = new WebSearchProviderRegistry({ env: {}, serviceRegistry: { get: () => null } });
  const tracker = new PluginInFlightTracker();
  const registrations = new PluginInFlightTracker();
  const cleanup: Array<() => void> = [];
  const api = createPluginAPI({ pluginName: 'fixture', inFlight: tracker, registrations, cleanup,
    mediaProviderRegistry: media, voiceProviderRegistry: voice, memoryEmbeddingRegistry: memory, webSearchProviderRegistry: search,
  } as unknown as PluginAPIContext);
  class Media {
    #receiver = 'media';
    get id() { return ' media-fixture '; }
    get label() { return this.#receiver; }
    capabilities = [];
    async status() { return { id: this.id, label: this.#receiver, state: 'healthy' as const, configured: true, capabilities: [], metadata: {} }; }
  }
  class Voice {
    #receiver = 'voice';
    get id() { return 'voice-fixture'; }
    get label() { return this.#receiver; }
    capabilities = [];
    async listVoices() { return [{ id: this.#receiver, label: this.#receiver, metadata: {} }]; }
  }
  class Memory {
    #receiver = 7;
    id = 'memory-fixture'; label = 'memory'; dimensions = 1;
    async embed() { return { dimensions: 1, vector: [this.#receiver] }; }
  }
  class Search {
    #receiver = 'search';
    id = 'search-fixture'; label = 'search'; capabilities = [];
    async search() { return { results: [], metadata: { receiver: this.#receiver } }; }
  }
  api.registerMediaProvider(Object.freeze(new Media()));
  api.registerVoiceProvider(Object.freeze(new Voice()));
  api.registerMemoryEmbeddingProvider(Object.freeze(new Memory()));
  api.registerWebSearchProvider(Object.freeze(new Search()));
  const m = media.get('media-fixture')!;
  const v = voice.get('voice-fixture')!;
  const e = memory.get('memory-fixture')!;
  const s = search.get('search-fixture')!;
  expect((await m.status!()).label).toBe('media');
  expect((await v.listVoices!())[0]?.id).toBe('voice');
  expect((await e.embed!({ text: '', dimensions: 1, usage: 'query' })).vector).toEqual([7]);
  expect((await s.search({ query: '' })).metadata).toEqual({ receiver: 'search' });
  await tracker.close(); await registrations.close();
  for (const invoke of [() => m.status!(), () => v.listVoices!(), () => e.embed!({ text: '', dimensions: 1, usage: 'query' }), () => s.search({ query: '' })]) {
    await expect(Promise.resolve().then<unknown>(invoke)).rejects.toThrow(PluginClosedError);
  }
  for (const dispose of cleanup) dispose();
  expect(media.get('media-fixture')).toBeNull(); expect(voice.get('voice-fixture')).toBeNull();
  expect(memory.get('memory-fixture')).toBeNull(); expect(search.get('search-fixture')).toBeNull();
});

test.each([false, true])('feature-hidden channel cleanup preserves exact storage ownership (replaced=%s)', async (replace) => {
  let enabled = true;
  const channels = new ChannelPluginRegistry({ featureFlags: { isEnabled: () => enabled } as never });
  const tracker = new PluginInFlightTracker();
  const registrations = new PluginInFlightTracker();
  const cleanup: Array<() => void> = [];
  const api = createPluginAPI({ pluginName: 'fixture', inFlight: tracker, registrations, cleanup, channelRegistry: channels } as unknown as PluginAPIContext);
  api.registerChannelPlugin({ id: 'fixture', surface: 'webhook', displayName: 'Owned', capabilities: [] });
  const replacement: ChannelPlugin = { id: 'fixture', surface: 'webhook', displayName: 'Replacement', capabilities: [] };
  if (replace) channels.register(replacement);
  enabled = false;
  expect(channels.get('fixture')).toBeNull();
  await tracker.close(); await registrations.close();
  for (const dispose of cleanup) dispose();
  enabled = true;
  expect(channels.get('fixture')).toBe(replace ? replacement : null);
});

test('a default Response stream may contain empty chunks without losing byte-reader compatibility', async () => {
  const fx = ownership();
  let pulls = 0;
  const source: ChannelPlugin = { id: 'fixture', surface: 'webhook', displayName: '', capabilities: [], async handleInbound() {
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (pulls++ === 0) controller.enqueue(new Uint8Array());
      else { controller.enqueue(new Uint8Array([65])); controller.close(); }
    } }, { highWaterMark: 0 }));
  } };
  const result = await fx.owned.channel(source).handleInbound!(new Request('http://127.0.0.1/fixture'));
  expect(await result.text()).toBe('A');
  expect(pulls).toBe(2);
  await fx.close();
});

test('provider cleanup uses the stored instance even when ordinary lookup routes to a subscriber', async () => {
  const cleanup: Array<() => void> = [];
  let stored: LLMProvider | undefined;
  const subscriber: LLMProvider = { name: 'openai-subscriber', models: [], async chat() { return response; } };
  const api = createPluginAPI({ pluginName: 'fixture', cleanup,
    providerRegistry: {
      registerRuntimeProvider(value: { provider: LLMProvider }) { stored = value.provider; return () => { stored = undefined; }; },
      has() { return stored !== undefined; }, getRegistered() { return stored; }, get() { return subscriber; },
    },
  } as unknown as PluginAPIContext);
  api.registerProviderInstance({ provider: { name: 'openai', models: [], async chat() { return response; } } });
  expect(stored).toBeDefined();
  for (const dispose of cleanup) dispose();
  expect(stored).toBeUndefined();
});
