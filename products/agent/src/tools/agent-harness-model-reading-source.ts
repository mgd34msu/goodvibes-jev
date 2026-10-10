import { types as nodeTypes } from 'node:util';
import { snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import { SOURCE_SCREENING_LIMITS, type ProtectedSource, type ProtectedSourceOwner, type SourceScreeningReceipt } from '@goodvibes-jev/engine/sdk/platform/security';
import { ToolInputProjectionError, type ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { agentResearchSourceOwner } from '../agent/protected-research-report.ts';
import type { CommandContext } from '../input/command-registry.ts';
import { captureCatalogData } from './agent-harness-catalog-ranking.ts';
import type { ProviderApiLike, ArtifactListLike } from './agent-harness-model-routing-types.ts';
import { contextWindowFor, modelRegistryKey } from './agent-harness-model-catalog.ts';

export interface ModelReadingOptions {
  readonly signal?: AbortSignal | undefined;
  readonly sourceOwner?: ProtectedSourceOwner | undefined;
  readonly assertCurrent?: (() => void) | undefined;
  /** Backend guards outlive inner receipt cleanup and remain active until publication. */
  readonly retainCurrent?: ((guard: () => void, key?: string) => void) | undefined;
}

/** Inspect every descriptor, including fields consumers do not display. */
function captureModelReadingData<T>(value: T): T {
  const captured = captureCatalogData(value);
  // Complete source includes hidden data properties. JSON's enumerability
  // convention is not permission to omit a semantic field from screening.
  const copies = new WeakMap<object, object>();
  const enumerable = (entry: unknown): unknown => {
    if (entry === null || typeof entry !== 'object') return entry;
    const existing = copies.get(entry); if (existing) return existing;
    const array = Array.isArray(entry);
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    if (array && (Object.keys(descriptors).length !== entry.length + 1 || Object.keys(descriptors).some(key => key !== 'length'
      && (!Number.isSafeInteger(Number(key)) || String(Number(key)) !== key || Number(key) < 0 || Number(key) >= entry.length))))
      throw new ToolInputProjectionError('invalid');
    const result: object = array ? new Array(entry.length) : Object.create(null) as object;
    copies.set(entry, result);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array && key === 'length') continue;
      Object.defineProperty(result, key, { value: enumerable(descriptor.value), enumerable: true });
    }
    return Object.freeze(result);
  };
  const data = enumerable(captured);
  // Bound expanded JSON work as well as unique DAG nodes. An alias added during
  // a late mutation cannot make equality checking expand exponentially.
  let nodes = 0, characters = 0;
  const bound = (entry: unknown): void => {
    if (++nodes > 20_000) throw new ToolInputProjectionError('invalid');
    if (typeof entry === 'string') characters += entry.length;
    else if (entry !== null && typeof entry === 'object') for (const [key, child] of Object.entries(entry)) { characters += key.length; bound(child); }
    if (characters > 1_000_000) throw new ToolInputProjectionError('invalid');
  };
  bound(data);
  return data as T;
}

/** Screen the complete immutable input once; no service acquisition precedes it. */
export function captureModelReadingInput<T>(value: T): T {
  return snapshotJudgmentInput(captureModelReadingData(value)) as T;
}
/** Fresh descriptor-only capture must equal the already-screened bytes. Repeating
 * privacy classification on unchanged bytes at each nested guard adds no proof. */
export function assertModelReadingInputCurrent(value: unknown, serialized: string | undefined): void {
  if (JSON.stringify(captureModelReadingData(value)) !== serialized) throw new ToolInputProjectionError('held');
}

/** Whole semantic values are batched, never truncated or split inside strings.
 * Large collections retain their complete key path and every entry. */
function screeningBatches(captured: unknown, serialized: string): readonly (readonly string[])[] {
  if (serialized.length > 1_000_000) throw new ToolInputProjectionError('held');
  const parts: string[] = [];
  const visit = (value: unknown, keys: readonly string[]) => {
    const part = keys.length ? JSON.stringify({ path: keys, value }) : serialized;
    if (part.length <= SOURCE_SCREENING_LIMITS.characters) { parts.push(part); return; }
    if (value === null || typeof value !== 'object') throw new ToolInputProjectionError('held');
    const entries = Object.entries(value);
    if (!entries.length) throw new ToolInputProjectionError('held');
    for (const [key, child] of entries) visit(child, [...keys, key]);
  };
  visit(captured, []);
  const batches: string[][] = [];
  let size = 0, total = 0;
  for (const part of parts) {
    total += part.length;
    if (total > 1_000_000) throw new ToolInputProjectionError('held');
    let batch = batches.at(-1);
    if (!batch || batch.length >= SOURCE_SCREENING_LIMITS.parts || size + part.length > SOURCE_SCREENING_LIMITS.characters) {
      batch = []; batches.push(batch); size = 0;
    }
    batch.push(part); size += part.length;
  }
  if (batches.length > SOURCE_SCREENING_LIMITS.sources) throw new ToolInputProjectionError('held');
  return batches;
}

/** A projection is authority to use these exact captured facts, never to rewrite identity. */
export async function withModelReadingSource<T, R>(source: T, options: ModelReadingOptions,
  consume: (captured: T, options: ModelReadingOptions) => Promise<R>): Promise<R> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const captured = captureModelReadingInput(source);
  const serialized = JSON.stringify(captured);
  if (typeof serialized !== 'string') throw new ToolInputProjectionError('held');
  const batches = screeningBatches(captured, serialized);
  const signal = options.signal, originalAssert = options.assertCurrent, originalRetain = options.retainCurrent;
  const retained = new Map<string | (() => void), () => void>();
  const retainCurrent = (guard: () => void, key?: string) => { if (!retained.has(key ?? guard)) retained.set(key ?? guard, guard); originalRetain?.(guard, key); };
  const owner = options.sourceOwner;
  if (!owner) throw new ToolInputProjectionError('unavailable');
  const handles: ProtectedSource[] = [];
  const receipts: { readonly receipt: SourceScreeningReceipt; readonly parts: readonly string[] }[] = [];
  let released = false, releasing: Promise<void> | undefined;
  const release = (): Promise<void> => {
    if (releasing) return releasing;
    released = true; signal?.removeEventListener('abort', abort);
    releasing = Promise.resolve().then(async () => { await Promise.all(handles.map(handle => Promise.resolve().then(() => owner.release(handle)))); });
    return releasing;
  };
  const abort = () => { void release().catch(() => {}); };
  const assertPublicationCurrent = () => {
    if (options.signal !== signal || options.sourceOwner !== owner || options.assertCurrent !== originalAssert || options.retainCurrent !== originalRetain) throw new ToolInputProjectionError('held');
    signal?.throwIfAborted(); originalAssert?.();
    for (const guard of retained.values()) guard();
    assertModelReadingInputCurrent(source, serialized);
  };
  const assertCurrent = () => {
    assertPublicationCurrent();
    if (released) throw new ToolInputProjectionError('held');
    for (const { receipt, parts } of receipts) {
      const projection = owner.project(receipt);
      if (projection.length !== parts.length || projection.some((part, index) => part !== parts[index])) throw new ToolInputProjectionError('held');
    }
    options.assertCurrent?.(); signal?.throwIfAborted();
  };
  try {
    signal?.addEventListener('abort', abort, { once: true });
    assertCurrent();
    for (const batch of batches) { assertCurrent(); handles.push(owner.capture(batch)); }
    for (const [index, handle] of handles.entries()) {
      assertCurrent(); const screened = await owner.screen(handle); assertCurrent();
      if (screened.status !== 'settled') throw new ToolInputProjectionError('held');
      receipts.push({ receipt: screened.receipt, parts: batches[index]! }); assertCurrent();
    }
    const result = await consume(captured, { ...options, assertCurrent, retainCurrent });
    assertCurrent(); return result;
  } finally { await release(); assertPublicationCurrent(); }
}

/** Read service slots without invoking accessors or proxy traps. */
function slot(source: unknown, key: string): unknown {
  if (source == null) return undefined;
  if (typeof source !== 'object' || nodeTypes.isProxy(source)) throw new ToolInputProjectionError('held');
  let cursor: object | null = source;
  for (let depth = 0; cursor && depth < 64; depth++) {
    if (nodeTypes.isProxy(cursor)) throw new ToolInputProjectionError('held');
    const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
    if (descriptor) {
      if (!('value' in descriptor)) throw new ToolInputProjectionError('held');
      return descriptor.value;
    }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  return undefined;
}
function path(source: unknown, keys: readonly string[]): unknown {
  return keys.reduce((value, key) => slot(value, key), source);
}
export { path as modelReadingServicePath };

const READ_MODEL_PATHS = [
  ['platform', 'readModels', 'providerHealth'], ['platform', 'readModels', 'providersHealth'],
  ['platform', 'readModels', 'modelRouteHealth'], ['platform', 'readModels', 'routeHealth'],
  ['platform', 'readModels', 'models', 'providerHealth'], ['platform', 'readModels', 'models', 'routeHealth'],
  ['platform', 'providerHealth'], ['clients', 'operator', 'providerHealth'],
  ['platform', 'readModels', 'localModelServers'], ['platform', 'readModels', 'localModelServing'],
  ['platform', 'readModels', 'localModelDiagnostics'], ['platform', 'readModels', 'models', 'localServers'],
  ['platform', 'readModels', 'models', 'servingDiagnostics'], ['platform', 'readModels', 'localModels', 'servingDiagnostics'],
  ['platform', 'readModels', 'ollama', 'servingDiagnostics'], ['platform', 'readModels', 'llamaCpp', 'servingDiagnostics'],
  ['platform', 'readModels', 'vllm', 'servingDiagnostics'], ['platform', 'readModels', 'localAi', 'servingDiagnostics'],
  ['platform', 'readModels', 'openAiCompatible', 'servingDiagnostics'], ['platform', 'localModelServing'],
  ['clients', 'operator', 'models', 'servingDiagnostics'], ['clients', 'operator', 'localModelServingDiagnostics'],
] as const;
const CONFIG_KEYS = ['provider.reasoningEffort', 'provider.embeddingProvider', 'provider.systemPromptFile',
  'helper.enabled', 'helper.globalProvider', 'helper.globalModel', 'tools.llmEnabled', 'tools.llmProvider', 'tools.llmModel'] as const;
const SNAPSHOT_METHODS = ['getSnapshot', 'snapshot', 'list', 'listProviders', 'listRoutes', 'listHealth'] as const;

/** Normalize native Maps mechanically, inspecting every descriptor first. */
function captureReadModelData(value: unknown, initial = true): unknown {
  const ancestors = new Set<object>();
  let nodes = 0, characters = 0;
  const invalid = (): never => { throw new ToolInputProjectionError('invalid'); };
  const walk = (entry: unknown, depth: number): unknown => {
    if (++nodes > 20_000 || depth > 64) return invalid();
    if (typeof entry === 'string') { characters += entry.length; if (characters > 1_000_000) return invalid(); return entry; }
    if (entry == null || typeof entry === 'boolean' || typeof entry === 'number') return entry;
    if (typeof entry !== 'object' || nodeTypes.isProxy(entry) || ancestors.has(entry)) return invalid();
    const prototype = Object.getPrototypeOf(entry);
    ancestors.add(entry);
    try {
      if (prototype === Map.prototype) {
        if (Reflect.ownKeys(entry).length) return invalid();
        const rows: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        for (const [key, child] of Map.prototype.entries.call(entry) as IterableIterator<[unknown, unknown]>) {
          if (typeof key !== 'string') return invalid();
          characters += key.length; if (characters > 1_000_000) return invalid();
          Object.defineProperty(rows, key, { value: walk(child, depth + 1), enumerable: true });
        }
        return rows;
      }
      const array = Array.isArray(entry);
      if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return invalid();
      const descriptors = Object.getOwnPropertyDescriptors(entry);
      if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string') || Object.hasOwn(descriptors, 'toJSON')
        || Object.values(descriptors).some(descriptor => !('value' in descriptor) || typeof descriptor.value === 'function')) return invalid();
      const length = array ? descriptors.length?.value : 0;
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > 20_000) return invalid();
      const result: object = array ? new Array(length) : Object.create(null) as object;
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (array && key === 'length') continue;
        characters += key.length; if (characters > 1_000_000) return invalid();
        Object.defineProperty(result, key, { value: walk(descriptor.value, depth + 1), enumerable: descriptor.enumerable });
      }
      return result;
    } finally { ancestors.delete(entry); }
  };
  const normalized = walk(value, 0);
  // Existing readers distinguish a keyed record collection from a single record.
  const rootMap = value !== null && typeof value === 'object' && !nodeTypes.isProxy(value) && Object.getPrototypeOf(value) === Map.prototype;
  const data = rootMap ? { records: normalized } : normalized;
  return initial ? captureModelReadingInput(data) : captureModelReadingData(data);
}
function snapshotReadModel(source: unknown, initial = true): unknown {
  if (source == null) return source;
  for (const key of SNAPSHOT_METHODS) {
    const method = slot(source, key);
    if (typeof method === 'function') {
      const result: unknown = method.call(source);
      if (nodeTypes.isPromise(result)) throw new ToolInputProjectionError('held');
      return captureReadModelData(result, initial);
    }
  }
  return captureReadModelData(source, initial);
}
function setPath(target: Record<string, unknown>, keys: readonly string[], value: unknown): void {
  let current = target;
  for (const key of keys.slice(0, -1)) {
    if (!current[key]) current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  current[keys.at(-1)!] = value;
}

/** Captures the complete original invocation before adapters can omit fields. */
export function modelReadingOptions(context: CommandContext, registry?: ToolRegistry, signal?: AbortSignal,
  assertExecution?: () => void, retainCurrent?: (guard: () => void, key?: string) => void): ModelReadingOptions {
  const sourceOwner = agentResearchSourceOwner(registry);
  const session = path(context, ['session', 'runtime']), sessionId = slot(session, 'sessionId');
  const api = path(context, ['clients', 'providerApi']), provider = path(context, ['provider', 'providerRegistry']);
  const config = path(context, ['platform', 'config']), manager = path(context, ['platform', 'configManager']);
  const artifact = path(context, ['platform', 'artifactStore']);
  const readModels = path(context, ['platform', 'readModels']);
  const identities = [api, provider, manager, artifact].map(object => ({ object,
    methods: ['getFavorites', 'getCurrentModel', 'listModels', 'listProviderIds', 'listProviders', 'get', 'list', 'getKnownContextWindowForModel', 'getContextWindowForModel', 'getAutonomousPermissionSnapshot']
      .map(key => ({ key, value: slot(object, key) })) }));
  const sources = READ_MODEL_PATHS.map(keys => ({ keys, source: path(context, keys),
    methods: SNAPSHOT_METHODS.map(key => ({ key, value: slot(path(context, keys), key) })) }));
  const configRevisionMethod = slot(manager, 'getAutonomousPermissionSnapshot');
  const configIncarnation = (): unknown => {
    if (typeof configRevisionMethod !== 'function') return undefined;
    const value = slot(configRevisionMethod.call(manager), 'incarnation');
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ToolInputProjectionError('held');
    return value;
  };
  const configRevision = configIncarnation();
  return { sourceOwner, signal, retainCurrent, assertCurrent() {
    signal?.throwIfAborted(); assertExecution?.();
    if (agentResearchSourceOwner(registry) !== sourceOwner || path(context, ['session', 'runtime']) !== session || slot(session, 'sessionId') !== sessionId
      || path(context, ['clients', 'providerApi']) !== api || path(context, ['provider', 'providerRegistry']) !== provider || path(context, ['platform', 'config']) !== config
      || path(context, ['platform', 'configManager']) !== manager || path(context, ['platform', 'artifactStore']) !== artifact || path(context, ['platform', 'readModels']) !== readModels)
      throw new ToolInputProjectionError('held');
    for (const identity of identities) for (const method of identity.methods)
      if (slot(identity.object, method.key) !== method.value) throw new ToolInputProjectionError('held');
    if (configIncarnation() !== configRevision) throw new ToolInputProjectionError('held');
    for (const source of sources) {
      if (path(context, source.keys) !== source.source) throw new ToolInputProjectionError('held');
      for (const method of source.methods) if (slot(source.source, method.key) !== method.value) throw new ToolInputProjectionError('held');
    }
  } };
}

/** Registry services hold adapters, not JSON metadata. This explicit in-process
 * DTO boundary reads only routing/display facts; credential/client internals and
 * transport functions never enter a reading. Plain published DTOs are captured
 * completely, including undisplayed and hidden fields. */
function providerReadingFacts(provider: unknown, initial = true): unknown {
  if (provider === null || typeof provider !== 'object' || nodeTypes.isProxy(provider)) throw new ToolInputProjectionError('invalid');
  const prototype = Object.getPrototypeOf(provider);
  if (prototype === Object.prototype || prototype === null) return initial ? captureModelReadingInput(provider) : captureModelReadingData(provider);
  const facts: Record<string, unknown> = {};
  for (const key of ['name', 'id', 'providerId', 'label', 'displayName', 'description', 'baseURL', 'baseUrl', 'endpoint', 'api',
    'hosting', 'documentation', 'setupDescription', 'anonymousDetail', 'capabilities', 'adapterKind', 'modelSource', 'serviceNames', 'envVars', 'metadata', 'available', 'isAvailable']) {
    const value = slot(provider, key);
    if (value !== undefined) facts[key] = value;
  }
  // Built-in providers can expose models through a getter. Do not invoke it:
  // the registry's captured model catalog supplies the actual model facts.
  const modelField = Object.getOwnPropertyDescriptor(provider, 'models');
  if (modelField) {
    if (!('value' in modelField)) throw new ToolInputProjectionError('invalid');
    facts.models = modelField.value;
  }
  const configured = slot(provider, 'isConfigured');
  if (typeof configured === 'function') {
    const result: unknown = configured.call(provider);
    if (typeof result !== 'boolean') throw new ToolInputProjectionError('held');
    facts.isConfigured = result;
  } else if (configured !== undefined) facts.isConfigured = configured;
  return initial ? captureModelReadingInput(facts) : captureModelReadingData(facts);
}
function providerFactsList(value: unknown, expected?: { readonly identities: readonly unknown[]; readonly configuredMethods: readonly unknown[] }): { readonly identities: readonly unknown[]; readonly facts: readonly unknown[]; readonly configuredMethods: readonly unknown[] } {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new ToolInputProjectionError('invalid');
  const descriptors = Object.getOwnPropertyDescriptors(value as object);
  const length = descriptors.length?.value as unknown;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > 20_000
    || Reflect.ownKeys(descriptors).length !== length + 1) throw new ToolInputProjectionError('invalid');
  if (expected && length !== expected.identities.length) throw new ToolInputProjectionError('held');
  const identities: unknown[] = [], facts: unknown[] = [], configuredMethods: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const field = descriptors[String(index)];
    if (!field || !('value' in field)) throw new ToolInputProjectionError('invalid');
    const method = slot(field.value, 'isConfigured');
    if (expected && (field.value !== expected.identities[index] || method !== expected.configuredMethods[index])) throw new ToolInputProjectionError('held');
    identities.push(field.value); configuredMethods.push(method);
  }
  // All identities are checked before any trusted adapter method is invoked.
  for (const provider of identities) {
    facts.push(providerReadingFacts(provider, expected === undefined));
  }
  return { identities, facts, configuredMethods };
}

/** All asynchronous readers consume a single screened snapshot of the sources.
 * The synchronous cookbook remains a separate facts-only startup snapshot. */
export async function withModelReadingContext<T>(context: CommandContext, invocation: unknown, options: ModelReadingOptions,
  consume: (context: CommandContext, options: ModelReadingOptions) => Promise<T>): Promise<T> {
  const originalInvocation = captureModelReadingInput(invocation);
  const assertCurrent = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
  assertCurrent();
  const api = path(context, ['clients', 'providerApi']) as ProviderApiLike | undefined;
  const registry = path(context, ['provider', 'providerRegistry']);
  const store = path(context, ['platform', 'artifactStore']) as ArtifactListLike | undefined;
  const manager = path(context, ['platform', 'configManager']);
  const session = path(context, ['session', 'runtime']);
  const sourceContext = { provider: { providerRegistry: registry } } as unknown as CommandContext;
  const runtimeFacts = () => ({ sessionId: slot(session, 'sessionId'), model: slot(session, 'model'), provider: slot(session, 'provider'), reasoningEffort: slot(session, 'reasoningEffort') });
  for (const method of ['listModels', 'getFavorites', 'getCurrentModel', 'listProviderIds']) slot(api, method);
  slot(store, 'list');
  const tracked: { readonly raw: unknown; readonly serialized: string | undefined }[] = [];
  const capture = <V>(raw: V): V => { const copy = captureModelReadingInput(raw); tracked.push({ raw, serialized: JSON.stringify(copy) }); return copy; };
  const models = api ? capture(await api.listModels({ selectableOnly: true })) : [];
  assertCurrent();
  const favorites = api ? capture(await api.getFavorites()) : null;
  assertCurrent();
  const currentModel = api ? capture(await api.getCurrentModel()) : null;
  assertCurrent();
  const providerIds = capture(api?.listProviderIds() ?? []);
  const registryModelsMethod = slot(registry, 'listModels'), providersMethod = slot(registry, 'listProviders');
  const registryModels = capture(typeof registryModelsMethod === 'function' ? registryModelsMethod.call(registry) : []);
  const providerSnapshot = providerFactsList(typeof providersMethod === 'function' ? providersMethod.call(registry) : []);
  const providers = providerSnapshot.facts;
  const artifacts = capture(store?.list?.(100) ?? []);
  const windowSubjects = [...models, ...(currentModel ? [currentModel] : [])];
  const contextWindows = windowSubjects.map(model => ({ registryKey: modelRegistryKey(model), value: contextWindowFor(sourceContext, model) }));
  const readModels = READ_MODEL_PATHS.map(keys => ({ keys, data: snapshotReadModel(path(context, keys)) }));
  const configGet = slot(manager, 'get');
  const readConfig = (key: string): unknown => typeof configGet === 'function' ? configGet.call(manager, key) : undefined;
  const config = Object.fromEntries(CONFIG_KEYS.map(key => [key, capture(readConfig(key))]));
  const runtime = captureModelReadingInput(runtimeFacts());
  const source = { invocation: originalInvocation, models, favorites, currentModel, providerIds, registryModels, providers, artifacts, contextWindows, readModels, config, runtime };
  const stateGuard = () => {
    assertCurrent();
    for (const [index, model] of windowSubjects.entries()) if (contextWindowFor(sourceContext, model) !== contextWindows[index]?.value) throw new ToolInputProjectionError('held');
    for (const entry of tracked) assertModelReadingInputCurrent(entry.raw, entry.serialized);
    assertModelReadingInputCurrent(runtimeFacts(), JSON.stringify(runtime));
    if (typeof registryModelsMethod === 'function') assertModelReadingInputCurrent(registryModelsMethod.call(registry), JSON.stringify(registryModels));
    if (typeof providersMethod === 'function') {
      // Compare trusted method identities before invoking any replacement.
      for (const [index, provider] of providerSnapshot.identities.entries())
        if (slot(provider, 'isConfigured') !== providerSnapshot.configuredMethods[index]) throw new ToolInputProjectionError('held');
      const current = providerFactsList(providersMethod.call(registry), providerSnapshot);
      if (current.identities.length !== providerSnapshot.identities.length || current.identities.some((provider, index) => provider !== providerSnapshot.identities[index])
        || JSON.stringify(current.facts) !== JSON.stringify(providers)) throw new ToolInputProjectionError('held');
    }
    if (store?.list) assertModelReadingInputCurrent(store.list(100), JSON.stringify(artifacts));
    for (const key of CONFIG_KEYS) assertModelReadingInputCurrent(readConfig(key), JSON.stringify(config[key]));
    for (const entry of readModels) if (JSON.stringify(snapshotReadModel(path(context, entry.keys), false)) !== JSON.stringify(entry.data)) throw new ToolInputProjectionError('held');
  };
  return withModelReadingSource(source, { ...options, assertCurrent: stateGuard }, async (captured, scoped) => {
    const projected: Record<string, unknown> = { session: { runtime: captured.runtime },
      provider: { providerRegistry: { listModels: () => captured.registryModels, listProviders: () => captured.providers,
        getKnownContextWindowForModel: (model: unknown) => captured.contextWindows.find(entry => entry.registryKey === modelRegistryKey(model))?.value ?? null,
        getContextWindowForModel: (model: unknown) => captured.contextWindows.find(entry => entry.registryKey === modelRegistryKey(model))?.value ?? null } },
      platform: { readModels: {}, artifactStore: store ? { list: () => captured.artifacts } : undefined,
        configManager: { get: (key: string) => captured.config[key] } }, clients: { operator: {} } };
    for (const entry of captured.readModels) setPath(projected, entry.keys, entry.data);
    // Preserve the provider API's actual structural location for requireProviderApi.
    const providerApi = api ? { listModels: async () => captured.models, getFavorites: async () => captured.favorites,
      getCurrentModel: async () => captured.currentModel, listProviderIds: () => captured.providerIds } : undefined;
    (projected.clients as Record<string, unknown>).providerApi = providerApi;
    const result = await consume(projected as unknown as CommandContext, scoped);
    scoped.assertCurrent?.(); return result;
  });
}
