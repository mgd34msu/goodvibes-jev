/** Lifetime adapters for the callable capabilities a plugin registers. */
import type { ChannelPlugin, ChannelDeliveryStrategy } from '../channels/index.js';
import type { LLMProvider, ProviderBatchAdapter } from '../providers/interface.js';
import type { MemoryEmbeddingProvider } from '../state/index.js';
import type { VoiceProvider, VoiceSynthesisStreamResult } from '../voice/index.js';
import type { MediaProvider } from '../media/index.js';
import type { WebSearchProvider } from '../web-search/index.js';
import type { Tool } from '../types/tools.js';

type Modes<T> = { [K in keyof T]-?: NonNullable<T[K]> extends (...args: never[]) => unknown ? 'sync' | 'async' | 'either' : 'value' };
type Track = <T>(call: () => T) => T;
type Transform = (result: unknown) => unknown;

const providerMethods = { name: 'value', models: 'value', adapterKind: 'value', batch: 'value', capabilities: 'value', modelSource: 'value', credentialAuthority: 'value', chat: 'async', embed: 'async', describeRuntime: 'either', isConfigured: 'sync', describeAuthState: 'sync' } satisfies Modes<LLMProvider>;
const batchMethods = { kind: 'value', endpoints: 'value', createChatBatch: 'async', retrieveBatch: 'async', cancelBatch: 'async', getResults: 'async' } satisfies Modes<ProviderBatchAdapter>;
const channelMethods = {
  id: 'value', surface: 'value', displayName: 'value', capabilities: 'value', setupVersion: 'value', webhookPath: 'value',
  handleInbound: 'async', renderPolicy: 'either', renderEvent: 'async', deliverReply: 'async', deliverProgress: 'async', notifyApproval: 'async',
  getSetupSchema: 'either', doctor: 'either', listRepairActions: 'either', getLifecycleState: 'either', resolveAllowlist: 'either', editAllowlist: 'either',
  getStatus: 'async', listAccounts: 'async', getAccount: 'async', startAccount: 'async', stopAccount: 'async', loginAccount: 'async', loginWithQrStart: 'async', loginWithQrWait: 'async', logoutAccount: 'async', runAccountAction: 'async',
  authorizeActorAction: 'async', getActionAvailabilityState: 'async', listCapabilities: 'either', listTools: 'either', runTool: 'async', listOperatorActions: 'either', runOperatorAction: 'async',
  lookupDirectory: 'async', queryDirectory: 'async', listGroupMembers: 'async', parseExplicitTarget: 'either', inferTargetConversationKind: 'either', resolveTarget: 'async', resolveSessionTarget: 'either', resolveParentConversationCandidates: 'async', listAgentTools: 'sync',
} satisfies Modes<ChannelPlugin>;
const deliveryMethods = { id: 'value', canHandle: 'sync', deliver: 'async' } satisfies Modes<ChannelDeliveryStrategy>;
const memoryMethods = { capturedInputAdmission: 'value', id: 'value', label: 'value', dimensions: 'value', deterministic: 'value', local: 'value', embedSync: 'sync', embed: 'async', status: 'either' } satisfies Modes<MemoryEmbeddingProvider>;
const voiceMethods = { id: 'value', label: 'value', capabilities: 'value', billing: 'value', status: 'either', listVoices: 'either', synthesize: 'async', synthesizeStream: 'either', transcribe: 'async', openRealtimeSession: 'async', resetEngineFailureState: 'sync' } satisfies Modes<VoiceProvider>;
const mediaMethods = { id: 'value', label: 'value', capabilities: 'value', status: 'either', analyze: 'async', transform: 'async', generate: 'async' } satisfies Modes<MediaProvider>;
const searchMethods = { id: 'value', label: 'value', capabilities: 'value', descriptor: 'sync', search: 'async' } satisfies Modes<WebSearchProvider>;
const toolMethods = { definition: 'value', execute: 'async' } satisfies Modes<Tool>;

const streamFields = { providerId: 'value', mimeType: 'value', format: 'value', chunks: 'value', metadata: 'value' } satisfies Modes<VoiceSynthesisStreamResult>;

function thenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function';
}

function rejected(error: unknown): Promise<never> {
  const result = Promise.reject(error);
  // This is still a rejected result for callers. The lifetime owner also
  // observes it when a plugin intentionally starts work without awaiting it.
  void result.catch(() => {});
  return result;
}

function declared<T>(map: Readonly<Record<string, T>> | undefined, key: PropertyKey): T | undefined {
  return typeof key === 'string' && map && Object.hasOwn(map, key) ? map[key] : undefined;
}

function mapResult(value: unknown, transform?: Transform): unknown {
  if (!transform) return value;
  return thenable(value) ? Promise.resolve(value).then(transform) : transform(value);
}

/**
 * A facade preserves live data/getters and invokes methods with their original
 * receiver, including private fields. Declared members are own enumerable
 * properties so registry normalization cannot recover unwrapped prototypes.
 * A separate plain target also supports frozen source objects.
 */
function facade<T extends object>(source: T, modes: Modes<T>, track: Track, options: {
  readonly results?: Readonly<Record<string, Transform>>;
  readonly replacements?: Readonly<Record<string, unknown>>;
  readonly streams?: Readonly<Record<string, (call: () => unknown, args: readonly unknown[]) => unknown>>;
  readonly values?: Readonly<Record<string, (value: unknown) => unknown>>;
} = {}): T {
  const methods = new Map<PropertyKey, { original: unknown; wrapped: (...args: unknown[]) => unknown }>();
  const get = (key: PropertyKey): unknown => {
    if (typeof key === 'string' && options.replacements && Object.hasOwn(options.replacements, key)) return options.replacements[key];
    const value: unknown = Reflect.get(source, key, source);
    const valueTransform = declared(options.values, key);
    if (valueTransform) return valueTransform(value);
    const mode = declared(modes as Record<string, string>, key);
    if (!mode || mode === 'value' || typeof value !== 'function') return value;
    const cached = methods.get(key);
    if (cached?.original === value) return cached.wrapped;
    const wrapped = (...args: unknown[]): unknown => {
      try {
        const call = () => Reflect.apply(value, source, args) as unknown;
        const stream = declared(options.streams, key);
        return stream ? stream(call, args) : track(() => mapResult(call(), declared(options.results, key)));
      } catch (error) {
        if (mode === 'async') return rejected(error);
        throw error;
      }
    };
    methods.set(key, { original: value, wrapped });
    return wrapped;
  };
  return new Proxy({} as T, {
    get: (_target, key) => get(key),
    has: (_target, key) => Reflect.has(source, key),
    ownKeys: () => [...new Set([...Reflect.ownKeys(source), ...Object.keys(modes).filter((key) => Reflect.has(source, key))])],
    getOwnPropertyDescriptor: (_target, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
      const declaredField = typeof key === 'string' && Object.hasOwn(modes, key) && Reflect.has(source, key);
      return descriptor || declaredField ? { configurable: true, enumerable: declaredField || descriptor?.enumerable === true, get: () => get(key) } : undefined;
    },
    set: (_target, key, value: unknown) => Reflect.set(source, key, value, source),
  });
}

function lease(track: Track): () => void {
  let release!: () => void;
  const completion = new Promise<void>((resolve) => { release = resolve; });
  track(() => completion);
  return release;
}

function holdResult(track: Track, call: () => unknown, transform: (value: unknown, release: () => void) => unknown): unknown {
  const release = lease(track);
  const finish = (value: unknown): unknown => {
    try { return transform(value, release); }
    catch (error) { release(); throw error; }
  };
  try {
    const result = call();
    if (!thenable(result)) return finish(result);
    const pending = Promise.resolve(result).then(finish, (error: unknown) => { release(); throw error; });
    void pending.catch(() => {});
    return pending;
  } catch (error) {
    release();
    throw error;
  }
}

/** Each iterator stays admitted until done, error, return or throw completes. */
function ownChunks<T>(chunks: AsyncIterable<T>, firstRelease: () => void, track: Track): AsyncIterable<T> {
  let first = true;
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const release = first ? firstRelease : lease(track);
      first = false;
      let original: AsyncIterator<T>;
      try { original = chunks[Symbol.asyncIterator](); }
      catch (error) { release(); throw error; }
      let finished = false;
      let pending = 0;
      const finish = () => { finished = true; if (pending === 0) release(); };
      const invoke = async (method: 'next' | 'return' | 'throw', args: unknown[]): Promise<IteratorResult<T>> => {
        // Calls finishing an already admitted iterator remain available during
        // shutdown. A new iterator must acquire its own admission above.
        if (finished) {
          if (method === 'throw') throw args[0];
          return { done: true, value: method === 'return' ? args[0] : undefined };
        }
        pending++;
        try {
          const fn = original[method];
          if (!fn) {
            finish();
            if (method === 'throw') throw args[0];
            return { done: true, value: method === 'return' ? args[0] : undefined };
          }
          const result = await Reflect.apply(fn, original, args) as IteratorResult<T>;
          if (result.done) finish();
          return result;
        } catch (error) { finish(); throw error; }
        finally { pending--; if (finished && pending === 0) release(); }
      };
      const iterator: AsyncIterableIterator<T> = {
        next: (...args: [] | [unknown]) => invoke('next', args),
        return: (...args: [] | [unknown]) => invoke('return', args),
        throw: (...args: [] | [unknown]) => invoke('throw', args),
        [Symbol.asyncIterator]() { return this; },
      };
      return iterator;
    },
  };
}

function ownResponse(value: unknown, release: () => void, request?: Request): Response | Promise<Response> {
  const original = value as Response;
  const requestSignal = request?.signal;
  const body = original.body;
  if (!body) { release(); return original; }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let finished = false;
  let released = false;
  let cancelled = false;
  let pending = 0;
  let removeAbortListener = () => {};
  let cancellation: Promise<void> | undefined;
  const releaseIfIdle = () => {
    if (!finished || pending !== 0 || released) return;
    released = true;
    removeAbortListener();
    reader?.releaseLock();
    release();
  };
  const finish = () => { finished = true; releaseIfIdle(); };
  const cancelBody = (reason: unknown): Promise<void> => {
    if (cancellation) return cancellation;
    cancelled = true;
    pending++;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    cancellation = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const settled = (failed: boolean, error?: unknown) => {
      pending--; finish();
      if (failed) reject(error); else resolve();
    };
    try {
      const result = reader ? reader.cancel(reason) : body.cancel(reason);
      void Promise.resolve(result).then(() => settled(false), (error: unknown) => settled(true, error));
    } catch (error) { settled(true, error); }
    return cancellation;
  };
  const owned = new ReadableStream({
    type: 'bytes',
    async pull(controller) {
      pending++;
      try {
        reader ??= body.getReader();
        for (;;) {
          const result = await reader.read();
          if (cancelled) break;
          if (result.done) { controller.close(); controller.byobRequest?.respond(0); finish(); break; }
          // A zero-length default-stream chunk carries no bytes. Continue this
          // read rather than leaving a byte-stream consumer's request pending.
          if (result.value.byteLength === 0) continue;
          // Byte controllers transfer their buffer. Buffer.slice() may retain
          // a non-detachable Node pool, so make an actual owned byte copy.
          controller.enqueue(new Uint8Array(result.value));
          break;
        }
      } catch (error) { if (!cancelled) controller.error(error); finish(); }
      finally { pending--; releaseIfIdle(); }
    },
    cancel: cancelBody,
  }, { highWaterMark: 0 });
  const response = new Response(owned, { status: original.status, statusText: original.statusText, headers: original.headers });
  const preserveMetadata = (response: Response): Response => {
    const clone = response.clone.bind(response);
    // Native HTTP servers require the Response's internal slots. A Proxy can
    // pass JS method tests while Bun rejects it instead of consuming its body.
    Object.defineProperties(response, {
      url: { configurable: true, get: () => original.url },
      redirected: { configurable: true, get: () => original.redirected },
      type: { configurable: true, get: () => original.type },
      clone: { configurable: true, value: () => preserveMetadata(clone()) },
    });
    return response;
  };
  if (request?.method === 'HEAD') {
    // Native HTTP servers discard a HEAD body without reading or cancelling
    // it. Retire that unused source before returning a native empty result.
    // A closed, resource-free stream keeps an unknown representation length
    // unknown: Bun would infer content-length:0 from a null replacement body.
    // Explicit representation headers remain unchanged; no source is read to
    // compute a missing length (RFC 9110 sections 8.6 and 9.3.2).
    const empty = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    const head = preserveMetadata(new Response(empty, { status: original.status, statusText: original.statusText, headers: original.headers }));
    return owned.cancel().then(() => head);
  }
  const result = preserveMetadata(response);
  if (requestSignal) {
    const onAbort = () => {
      // An active reader owns its cancellation path. Bun cancels its locked
      // HTTP reader on disconnect; this path retires a body nobody claimed.
      if (finished || cancelled || owned.locked) return;
      const reason: unknown = requestSignal.reason ?? new DOMException('Request aborted', 'AbortError');
      const pendingCancel = owned.cancel(reason);
      // The owner still waits for actual cancellation; an event callback has
      // no promise consumer. The already-aborted acquisition below awaits it.
      void pendingCancel.catch(() => {});
      return pendingCancel;
    };
    requestSignal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => requestSignal.removeEventListener('abort', onAbort);
    if (requestSignal.aborted) {
      const pendingCancel = onAbort();
      // Bun discards a response returned after disconnect without reading or
      // cancelling its body. Retire it here before the admitted call settles.
      return Promise.resolve(pendingCancel).then(() => result);
    }
  }
  return result;
}

/** Creates wrappers for one loaded plugin instance, all using the same owner. */
export function createOwnedPluginCapabilities(track: Track) {
  const tools = new WeakMap<Tool, Tool>();
  const batches = new WeakMap<ProviderBatchAdapter, ProviderBatchAdapter>();
  const ownTool = (tool: Tool): Tool => {
    let owned = tools.get(tool);
    if (!owned) { owned = facade(tool, toolMethods, track); tools.set(tool, owned); }
    return owned;
  };
  return {
    provider: (source: LLMProvider): LLMProvider => facade(source, providerMethods, track, { values: {
      batch: (value) => {
        if (!value) return value;
        const source = value as ProviderBatchAdapter;
        let owned = batches.get(source);
        if (!owned) { owned = facade(source, batchMethods, track); batches.set(source, owned); }
        return owned;
      },
    } }),
    channel: (source: ChannelPlugin): ChannelPlugin => facade(source, channelMethods, track, {
      results: { listAgentTools: (value) => (value as readonly Tool[]).map(ownTool) },
      streams: { handleInbound: (call, args) => holdResult(track, call, (value, release) =>
        ownResponse(value, release, args[0] as Request | undefined)) },
    }),
    delivery: (source: ChannelDeliveryStrategy): ChannelDeliveryStrategy => facade(source, deliveryMethods, track),
    memory: (source: MemoryEmbeddingProvider): MemoryEmbeddingProvider => facade(source, memoryMethods, track),
    voice: (source: VoiceProvider): VoiceProvider => facade(source, voiceMethods, track, { streams: {
      synthesizeStream: (call) => holdResult(track, call, (value, release) => {
        const result = value as VoiceSynthesisStreamResult;
        return facade(result, streamFields, track, { replacements: { chunks: ownChunks(result.chunks, release, track) } });
      }),
    } }),
    media: (source: MediaProvider): MediaProvider => facade(source, mediaMethods, track),
    search: (source: WebSearchProvider): WebSearchProvider => facade(source, searchMethods, track),
  };
}
