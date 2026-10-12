import { captureVoiceWakeReadSource } from '@goodvibes-jev/engine/sdk/platform/runtime/voice-setup';
import { dirname } from 'node:path';
import { VoiceProviderRegistry, captureVoiceProviderReadSource } from '@goodvibes-jev/engine/sdk/platform/voice';
import { MediaProviderRegistry, captureMediaProviderReadSource } from '@goodvibes-jev/engine/sdk/platform/media';
import { types as nodeTypes } from 'node:util';
import { constants as fsConstants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { captureAgentExportPath } from './agent-artifact-effect.ts';
import { connectedHostOperatorTokenPath, readConnectedHostOperatorToken } from '../runtime/connected-host-auth.ts';
import { captureCatalogSnapshot } from './agent-harness-catalog-ranking.ts';
import { captureNativeReadModelObservation } from './agent-harness-autonomy-live-records.ts';
import { snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import { SOURCE_SCREENING_LIMITS, type ProtectedSource, type ProtectedSourceOwner, type SourceScreeningReceipt } from '@goodvibes-jev/engine/sdk/platform/security';
import { assertProjectionCurrent, ToolInputProjectionError, type ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { agentResearchSourceOwner } from '../agent/protected-research-report.ts';
import type { ArtifactDescriptor } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { CommandContext } from '../input/command-registry.ts';
import { captureCatalogMethods } from './agent-harness-catalog-ranking.ts';
import type { ProviderApiLike, ArtifactListLike } from './agent-harness-model-routing-types.ts';
import { contextWindowFor, modelRegistryKey } from './agent-harness-model-catalog.ts';

const consumeNativePromise = Promise.prototype.then;
const originalCopyGet = WeakMap.prototype.get;
const originalCopySet = WeakMap.prototype.set;
const applyNativeOperation = Reflect.apply;
const checkNativeSignal = AbortSignal.prototype.throwIfAborted;
const addNativeSignalListener = EventTarget.prototype.addEventListener;
const removeNativeSignalListener = EventTarget.prototype.removeEventListener;
function assertReadingRestriction(callback: (() => unknown) | undefined): void {
  if (callback === undefined) return;
  if (typeof callback !== 'function' || nodeTypes.isProxy(callback)) throw new ToolInputProjectionError('held');
  assertProjectionCurrent(callback);
}

export interface ModelReadingOptions {
  readonly signal?: AbortSignal | undefined;
  readonly sourceOwner?: ProtectedSourceOwner | undefined;
  readonly assertCurrent?: (() => void) | undefined;
  /** Backend guards outlive inner receipt cleanup and remain active until publication. */
  readonly retainCurrent?: ((guard: () => void, key?: string) => void) | undefined;
}

/** Inspect every descriptor, including fields consumers do not display. */
function captureModelReadingData<T>(value: T): T {
  if (Object.getOwnPropertyDescriptor(WeakMap.prototype, 'get')?.value !== originalCopyGet
    || Object.getOwnPropertyDescriptor(WeakMap.prototype, 'set')?.value !== originalCopySet) throw new ToolInputProjectionError('held');
  const budget = { nodes: 0, characters: 0, slots: 0 };
  const ancestors = new Set<object>();
  const copies = new WeakMap<object, object>();
  const getCopy = (entry: object): object | undefined => applyNativeOperation(originalCopyGet, copies, [entry]);
  const setCopy = (entry: object, copy: object): void => { applyNativeOperation(originalCopySet, copies, [entry, copy]); };
  const arrays: { readonly length: number; readonly keys: readonly string[] }[] = [];
  const invalid = (): never => { throw new ToolInputProjectionError('invalid'); };
  const capture = (entry: unknown, depth: number): unknown => {
    if (++budget.nodes > 100_000 || depth > 64) return invalid();
    if (typeof entry === 'string') { budget.characters += entry.length; if (budget.characters > 1_000_000) return invalid(); return entry; }
    if (entry === null || entry === undefined || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number') return Number.isFinite(entry) ? entry : invalid();
    if (typeof entry !== 'object' || nodeTypes.isProxy(entry) || ancestors.has(entry)) return invalid();
    const existing = getCopy(entry); if (existing) return existing;
    const array = Array.isArray(entry);
    const prototype: unknown = Object.getPrototypeOf(entry);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    if (Object.getOwnPropertySymbols(entry).length > 0 || Object.hasOwn(descriptors, 'toJSON')
      || (array && Object.hasOwn(descriptors, 'constructor'))
      || Object.values(descriptors).some((descriptor) => !('value' in descriptor) || typeof descriptor.value === 'function')) return invalid();
    const length: unknown = array ? descriptors.length?.value : 0;
    if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > 20_000) return invalid();
    if (array && (budget.slots += length) > 100_000) return invalid();
    if (array) arrays.push({ length, keys: Object.keys(descriptors) });
    const result: object = array ? new Array(length) : Object.create(null);
    ancestors.add(entry);
    try {
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (array && key === 'length') continue;
        budget.characters += key.length;
        if (budget.characters > 1_000_000) return invalid();
        // Hidden source data is screened through the same final enumerable DTO.
        Object.defineProperty(result, key, { value: capture(descriptor.value, depth + 1), enumerable: true });
      }
      Object.freeze(result); setCopy(entry, result); return result;
    } finally { ancestors.delete(entry); }
  };
  const data = capture(value, 0);
  // Keep the original array-layout checks after complete source capture. They
  // inspect only the captured key lists, so a second detached tree is unnecessary.
  for (const { length, keys } of arrays) {
    if (keys.length !== length + 1 || keys.some(key => key !== 'length'
      && (!Number.isSafeInteger(Number(key)) || String(Number(key)) !== key || Number(key) < 0 || Number(key) >= length)))
      throw new ToolInputProjectionError('invalid');
  }
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

/** Only the retained native ArtifactStore contract declares these top-level
 * fields as generated epoch clocks. Preserve the complete raw descriptor locally
 * and expose the same instant as ISO before privacy screening. Metadata, bodies
 * and every other field retain their original meaning and screening. */
export function captureModelArtifactClockSource<T extends ArtifactDescriptor>(value: T) {
  const native = captureModelReadingData(value);
  const instant = (clock: number): string => {
    if (!Number.isSafeInteger(clock) || Math.abs(clock) > 8_640_000_000_000_000) throw new ToolInputProjectionError('invalid');
    return new Date(clock).toISOString();
  };
  const reading = { ...native, createdAt: instant(native.createdAt),
    ...(Object.hasOwn(native, 'expiresAt') ? { expiresAt: native.expiresAt === undefined ? undefined : instant(native.expiresAt) } : {}) };
  return { native, reading };
}

/** Validate the complete borrowed list before invoking any array operation. */
export function captureModelArtifactClockSources(value: readonly ArtifactDescriptor[]) {
  const native = captureModelReadingData(value);
  return { native, reading: native.map(artifact => captureModelArtifactClockSource(artifact).reading) };
}

/** Compare every original slot with its captured data without rebuilding JSON.
 * The snapshot has already passed complete structural and privacy capture. */
export function captureModelReadingSnapshotGuard(captured: unknown): (value: unknown) => void {
  type Snapshot = { readonly kind: 'value'; readonly value: unknown }
    | { readonly kind: 'object'; readonly array: boolean; readonly slots: readonly { readonly key: string; readonly snapshot: Snapshot }[] };
  const changed = (): never => { throw new ToolInputProjectionError('held'); };
  let capturedNodes = 0;
  const capture = (value: unknown, depth: number): Snapshot => {
    if (++capturedNodes > 20_000 || depth > 64) changed();
    if (value === null || typeof value !== 'object') return { kind: 'value', value };
    if (nodeTypes.isProxy(value)) changed();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const slots = Reflect.ownKeys(descriptors).map(key => {
      if (typeof key !== 'string') return changed();
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor)) return changed();
      return { key, snapshot: capture(descriptor.value, depth + 1) };
    });
    return { kind: 'object', array: Array.isArray(value), slots };
  };
  const original = capture(captured, 0);
  const immutableMatches = new WeakMap<object, Set<Snapshot>>();
  return value => {
    let nodes = 0;
    const ancestors = new Set<object>();
    const compare = (current: unknown, snapshot: Snapshot, depth: number): boolean => {
      if (++nodes > 20_000 || depth > 64) changed();
      if (snapshot.kind === 'value') {
        if (!Object.is(current, snapshot.value)) changed();
        return true;
      }
      if (current === null || typeof current !== 'object') return changed();
      // A complete match of a recursively frozen native tree remains exact:
      // neither its slots nor any descendant's prototype can subsequently change.
      if (immutableMatches.get(current)?.has(snapshot)) return true;
      if (nodeTypes.isProxy(current) || ancestors.has(current)) return changed();
      if (Array.isArray(current) !== snapshot.array) changed();
      const prototype: unknown = Object.getPrototypeOf(current);
      if (snapshot.array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) changed();
      if (Reflect.ownKeys(current).length !== snapshot.slots.length) changed();
      ancestors.add(current);
      let immutable = Object.isFrozen(current);
      try {
        for (const slot of snapshot.slots) {
          const descriptor = Object.getOwnPropertyDescriptor(current, slot.key);
          if (!descriptor || !('value' in descriptor)) return changed();
          immutable = compare(descriptor.value, slot.snapshot, depth + 1) && immutable;
        }
      } finally { ancestors.delete(current); }
      if (immutable) {
        const matches = immutableMatches.get(current) ?? new Set<Snapshot>();
        matches.add(snapshot); immutableMatches.set(current, matches);
      }
      return immutable;
    };
    compare(value, original, 0);
  };
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
  const assertOptions = captureCatalogMethods(options, ['signal', 'sourceOwner', 'assertCurrent', 'retainCurrent']);
  const assertSerialization = captureCatalogMethods(JSON, ['stringify']);
  const objectPrototype = Object.prototype, arrayPrototype = Array.prototype;
  const assertNoSerializer = (): void => {
    assertSerialization();
    if (Object.getPrototypeOf(objectPrototype) !== null || Object.getPrototypeOf(arrayPrototype) !== objectPrototype
      || Object.getOwnPropertyDescriptor(objectPrototype, 'toJSON') !== undefined
      || Object.getOwnPropertyDescriptor(arrayPrototype, 'toJSON') !== undefined) throw new ToolInputProjectionError('held');
  };
  assertOptions(); assertNoSerializer();
  const signal = options.signal, originalAssert = options.assertCurrent, originalRetain = options.retainCurrent;
  const signalMethods = signal ? captureCatalogMethods(signal, ['throwIfAborted', 'addEventListener', 'removeEventListener']) : () => {};
  const checkSignal = (): void => { signalMethods(); if (signal) Reflect.apply(checkNativeSignal, signal, []); };
  const assertSynchronous = (callback: (() => unknown) | undefined): void => {
    assertReadingRestriction(callback);
    assertOptions(); assertNoSerializer();
  };
  if (originalRetain !== undefined && (typeof originalRetain !== 'function' || nodeTypes.isProxy(originalRetain))) throw new ToolInputProjectionError('held');
  checkSignal(); assertSynchronous(originalAssert); checkSignal();
  const captured = captureModelReadingInput(source);
  const assertSourceSnapshot = captureModelReadingSnapshotGuard(captured);
  const serialized = JSON.stringify(captured);
  if (typeof serialized !== 'string') throw new ToolInputProjectionError('held');
  const batches = screeningBatches(captured, serialized);
  const retained = new Set<() => void>();
  const retainCurrent = (guard: () => void, key?: string) => {
    assertOptions();
    if (typeof guard !== 'function' || nodeTypes.isProxy(guard)) throw new ToolInputProjectionError('held');
    retained.add(guard);
    assertSynchronous(originalRetain ? () => originalRetain(guard, key) : undefined);
    assertOptions();
  };
  const owner = options.sourceOwner;
  if (!owner) throw new ToolInputProjectionError('unavailable');
  const assertOwnerMethods = captureCatalogMethods(owner, ['capture', 'screen', 'project', 'release']);
  const capture = owner.capture, screen = owner.screen, project = owner.project, releaseHandle = owner.release;
  retainCurrent(assertOwnerMethods, 'model-reading.owner-methods');
  const handles: ProtectedSource[] = [];
  const receipts: { readonly receipt: SourceScreeningReceipt; readonly parts: readonly string[] }[] = [];
  let released = false, releasing: Promise<void> | undefined;
  const release = (): Promise<void> => {
    if (releasing) return releasing;
    released = true; signal && Reflect.apply(removeNativeSignalListener, signal, ['abort', abort]);
    releasing = Promise.resolve().then(async () => { await Promise.all(handles.map(handle => Promise.resolve().then(() => releaseHandle.call(owner, handle)))); });
    return releasing;
  };
  const abort = () => { void release().catch(() => {}); };
  const assertPublicationCurrent = () => {
    assertOptions(); assertOwnerMethods(); assertNoSerializer();
    if (options.signal !== signal || options.sourceOwner !== owner || options.assertCurrent !== originalAssert || options.retainCurrent !== originalRetain) throw new ToolInputProjectionError('held');
    checkSignal(); assertSynchronous(originalAssert);
    for (const guard of retained.values()) assertSynchronous(guard);
    assertOptions(); assertOwnerMethods(); checkSignal();
    assertSourceSnapshot(source);
  };
  const assertCurrent = () => {
    assertPublicationCurrent();
    if (released) throw new ToolInputProjectionError('held');
    for (const { receipt, parts } of receipts) {
      const projection = project.call(owner, receipt);
      if (projection.length !== parts.length || projection.some((part, index) => part !== parts[index])) throw new ToolInputProjectionError('held');
    }
    assertSynchronous(originalAssert); assertOptions(); assertOwnerMethods(); checkSignal();
  };
  try {
    signal && Reflect.apply(addNativeSignalListener, signal, ['abort', abort, { once: true }]);
    assertCurrent();
    for (const batch of batches) { assertCurrent(); handles.push(capture.call(owner, batch)); }
    for (const [index, handle] of handles.entries()) {
      assertCurrent(); const screened = await screen.call(owner, handle, { signal, assertCurrent }); assertCurrent();
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

const modelReadingSources = new WeakMap<ModelReadingOptions, { readonly context: CommandContext; readonly source: ReturnType<typeof captureCatalogProducerSources> }>();
const getModelReadingSources = modelReadingSources.get.bind(modelReadingSources);
const setModelReadingSources = modelReadingSources.set.bind(modelReadingSources);

/** Captures the complete original invocation before adapters can omit fields. */
export function modelReadingOptions(context: CommandContext, registry?: ToolRegistry, signal?: AbortSignal,
  assertExecution?: () => void, retainCurrent?: (guard: () => void, key?: string) => void): ModelReadingOptions {
  const holderGuards: Array<() => void> = [];
  const acquire = (keys: readonly string[]): unknown => {
    let current: unknown = context;
    for (const key of keys) {
      if (current === null || current === undefined) return undefined;
      if (typeof current !== 'object' || nodeTypes.isProxy(current)) throw new ToolInputProjectionError('held');
      const owner = current, binding = captureCatalogMethods(owner, [key]); binding();
      const original = slot(owner, key);
      holderGuards.push(() => { binding(); if (!Object.is(slot(owner, key), original)) throw new ToolInputProjectionError('held'); });
      current = original;
    }
    return current;
  };
  for (const keys of [['session', 'runtime'], ['clients', 'providerApi'], ['provider', 'providerRegistry'],
    ['platform', 'config'], ['platform', 'configManager'], ['platform', 'artifactStore'], ['platform', 'readModels'], ...READ_MODEL_PATHS]) acquire(keys);
  const readSources = captureCatalogProducerSources(context, READ_MODEL_PATHS.map(keys => `context.${keys.join('.')}`), SNAPSHOT_METHODS);
  const sourceOwner = agentResearchSourceOwner(registry);
  const session = path(context, ['session', 'runtime']), sessionId = slot(session, 'sessionId');
  const api = path(context, ['clients', 'providerApi']), provider = path(context, ['provider', 'providerRegistry']);
  const config = path(context, ['platform', 'config']), manager = path(context, ['platform', 'configManager']);
  const artifact = path(context, ['platform', 'artifactStore']);
  const readModels = path(context, ['platform', 'readModels']);
  const identities = [api, provider, manager, artifact].map(object => ({ object,
    methods: ['getFavorites', 'getCurrentModel', 'listModels', 'listProviderIds', 'listProviders', 'get', 'list', 'readContent', 'getKnownContextWindowForModel', 'getContextWindowForModel', 'getAutonomousPermissionSnapshot']
      .map(key => ({ key, value: slot(object, key) })) }));
  const sources = READ_MODEL_PATHS.map(keys => ({ keys, source: path(context, keys),
    methods: SNAPSHOT_METHODS.map(key => ({ key, value: slot(path(context, keys), key) })) }));
  for (const identity of identities) if (identity.object !== null && typeof identity.object === 'object')
    holderGuards.push(captureCatalogMethods(identity.object, identity.methods.map(method => method.key)));
  const configRevisionMethod = slot(manager, 'getAutonomousPermissionSnapshot');
  const configIncarnation = (): unknown => {
    if (typeof configRevisionMethod !== 'function') return undefined;
    const value = slot(configRevisionMethod.call(manager), 'incarnation');
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ToolInputProjectionError('held');
    return value;
  };
  const configRevision = configIncarnation();
  const assertSourceCurrent = () => {
    signal?.throwIfAborted(); for (const guard of holderGuards) guard(); readSources.assertCurrent();
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
  };
  assertSourceCurrent();
  if (retainCurrent !== undefined && (typeof retainCurrent !== 'function' || nodeTypes.isProxy(retainCurrent))) throw new ToolInputProjectionError('held');
  assertReadingRestriction(retainCurrent ? () => retainCurrent(assertSourceCurrent, 'model-reading.native-source') : undefined);
  const options = { sourceOwner, signal, retainCurrent, assertCurrent() {
    signal?.throwIfAborted(); assertReadingRestriction(assertExecution); assertSourceCurrent();
  } };
  setModelReadingSources(options, { context, source: readSources });
  return options;
}

/** Registry services hold adapters, not JSON metadata. This explicit in-process
 * DTO boundary reads only routing/display facts; credential/client internals and
 * transport functions never enter a reading. Plain published DTOs are captured
 * completely, including undisplayed and hidden fields. */
export const MODEL_PROVIDER_READING_FACT_FIELDS = Object.freeze(['name', 'id', 'providerId', 'label', 'displayName', 'description', 'baseURL', 'baseUrl', 'endpoint', 'api',
    'hosting', 'documentation', 'setupDescription', 'anonymousDetail', 'capabilities', 'adapterKind', 'modelSource', 'serviceNames', 'envVars', 'metadata', 'available', 'isAvailable'] as const);

function providerReadingFacts(provider: unknown, initial = true): unknown {
  if (provider === null || typeof provider !== 'object' || nodeTypes.isProxy(provider)) throw new ToolInputProjectionError('invalid');
  const prototype = Object.getPrototypeOf(provider);
  if (prototype === Object.prototype || prototype === null) return initial ? captureModelReadingInput(provider) : captureModelReadingData(provider);
  const facts: Record<string, unknown> = {};
  for (const key of MODEL_PROVIDER_READING_FACT_FIELDS) {
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
  const assertOptions = captureCatalogMethods(options, ['signal', 'sourceOwner', 'assertCurrent', 'retainCurrent']);
  const signal = options.signal, callerCurrent = options.assertCurrent;
  const assertCurrent = () => { assertOptions(); signal?.throwIfAborted(); assertReadingRestriction(callerCurrent); assertOptions(); signal?.throwIfAborted(); };
  assertCurrent();
  const originalInvocation = captureModelReadingInput(invocation);
  const originalSources = getModelReadingSources(options);
  if (originalSources && originalSources.context !== context) throw new ToolInputProjectionError('held');
  const native = originalSources?.source ?? captureCatalogProducerSources(context, READ_MODEL_PATHS.map(keys => `context.${keys.join('.')}`), SNAPSHOT_METHODS);
  const retain = options.retainCurrent;
  if (retain !== undefined && (typeof retain !== 'function' || nodeTypes.isProxy(retain))) throw new ToolInputProjectionError('held');
  assertReadingRestriction(retain ? () => retain(native.assertCurrent, 'model-reading.complete-producer-source') : undefined);
  native.assertCurrent(); assertCurrent();
  const api = path(context, ['clients', 'providerApi']) as ProviderApiLike | undefined;
  const registry = path(context, ['provider', 'providerRegistry']);
  const store = path(context, ['platform', 'artifactStore']) as ArtifactListLike | undefined;
  const manager = path(context, ['platform', 'configManager']);
  const session = path(context, ['session', 'runtime']);
  const sourceContext = { provider: { providerRegistry: registry } } as unknown as CommandContext;
  const runtimeFacts = () => ({ sessionId: slot(session, 'sessionId'), model: slot(session, 'model'), provider: slot(session, 'provider'), reasoningEffort: slot(session, 'reasoningEffort') });
  for (const method of ['listModels', 'getFavorites', 'getCurrentModel', 'listProviderIds']) slot(api, method);
  const artifactList = slot(store, 'list'), artifactReadContent = slot(store, 'readContent');
  const readContent = store?.readContent;
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
  const originalArtifacts = store?.list?.(100) ?? [];
  const artifactSources = captureModelArtifactClockSources(originalArtifacts);
  const nativeArtifacts = artifactSources.native;
  tracked.push({ raw: originalArtifacts, serialized: JSON.stringify(nativeArtifacts) });
  const artifacts = captureModelReadingInput(artifactSources.reading);
  const windowSubjects = [...models, ...(currentModel ? [currentModel] : [])];
  const contextWindows = windowSubjects.map(model => ({ registryKey: modelRegistryKey(model), value: contextWindowFor(sourceContext, model) }));
  const readModels = READ_MODEL_PATHS.map(keys => ({ keys, data: snapshotReadModel(native.source(`context.${keys.join('.')}`)) }));
  const configGet = slot(manager, 'get');
  const readConfig = (key: string): unknown => typeof configGet === 'function' ? configGet.call(manager, key) : undefined;
  const config = Object.fromEntries(CONFIG_KEYS.map(key => [key, capture(readConfig(key))]));
  const runtime = captureModelReadingInput(runtimeFacts());
  const source = { invocation: originalInvocation, models, favorites, currentModel, providerIds, registryModels, providers, artifacts, contextWindows, readModels, config, runtime, producerSource: native.evidence() };
  const stateGuard = () => {
    assertCurrent();
    if (path(context, ['platform', 'artifactStore']) !== store
      || slot(store, 'list') !== artifactList || slot(store, 'readContent') !== artifactReadContent) throw new ToolInputProjectionError('held');
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
    if (store?.list) assertModelReadingInputCurrent(store.list(100), JSON.stringify(nativeArtifacts));
    for (const key of CONFIG_KEYS) assertModelReadingInputCurrent(readConfig(key), JSON.stringify(config[key]));
    for (const entry of readModels) if (JSON.stringify(snapshotReadModel(path(context, entry.keys), false)) !== JSON.stringify(entry.data)) throw new ToolInputProjectionError('held');
  };
  return withModelReadingSource(source, { ...options, assertCurrent: stateGuard }, async (captured, scoped) => {
    const projected: Record<string, unknown> = { session: { runtime: captured.runtime },
      provider: { providerRegistry: { listModels: () => captured.registryModels, listProviders: () => captured.providers,
        getKnownContextWindowForModel: (model: unknown) => captured.contextWindows.find(entry => entry.registryKey === modelRegistryKey(model))?.value ?? null,
        getContextWindowForModel: (model: unknown) => captured.contextWindows.find(entry => entry.registryKey === modelRegistryKey(model))?.value ?? null } },
      platform: { readModels: {}, artifactStore: store ? { list: () => nativeArtifacts, ...(readContent ? { readContent: async (id: string) => {
          scoped.signal?.throwIfAborted(); assertProjectionCurrent(scoped.assertCurrent);
          if (!captured.artifacts.some(artifact => artifact.id === id)) throw new ToolInputProjectionError('held');
          const content = await readContent.call(store, id);
          scoped.signal?.throwIfAborted(); assertProjectionCurrent(scoped.assertCurrent); return content;
        } } : {}) } : undefined,
        configManager: { get: (key: string) => captured.config[key] } }, clients: { operator: {} } };
    for (const entry of captured.readModels) setPath(projected, entry.keys, entry.data);
    // Preserve the provider API's actual structural location for requireProviderApi.
    const providerApi = api ? { listModels: async () => captured.models, getFavorites: async () => captured.favorites,
      getCurrentModel: async () => captured.currentModel, listProviderIds: () => captured.providerIds } : undefined;
    (projected.clients as Record<string, unknown>).providerApi = providerApi;
    const result = await consume(projected as unknown as CommandContext, scoped);
    assertProjectionCurrent(scoped.assertCurrent); return result;
  });
}

export { captureReadModelData as captureModelReadModelData, providerReadingFacts as captureModelProviderReadingFacts };

/** Capture selected producer paths before collectors touch any wrapper or method.
 * The private views preserve the collector's call order. Complete native results
 * enter the same screening input as the collected records, including hidden data. */
export function captureCatalogProducerSources(context: unknown, paths: readonly string[], methodNames: readonly string[], allowFunctionSources = false) {
  const guards: Array<() => void> = [];
  const results: Array<{ readonly path: string; readonly data: unknown }> = [];
  const views = new Map<string, unknown>();
  const observers: Array<{ readonly owner: object; readonly binding: () => void }> = [];
  const evidence: Array<{ readonly path: string; readonly data: unknown }> = [];
  const ancestors = new Set<object>();
  type ProducerCopy = { readonly view: object; readonly data: unknown };
  const copies = new WeakMap<object, ProducerCopy>();
  if (Object.getOwnPropertyDescriptor(WeakMap.prototype, 'get')?.value !== originalCopyGet
    || Object.getOwnPropertyDescriptor(WeakMap.prototype, 'set')?.value !== originalCopySet) throw new ToolInputProjectionError('held');
  const getCopy = (entry: object): ProducerCopy | undefined => applyNativeOperation(originalCopyGet, copies, [entry]);
  const setCopy = (entry: object, copy: ProducerCopy): void => { applyNativeOperation(originalCopySet, copies, [entry, copy]); };
  let nodes = 0;
  const held = (): never => { throw new ToolInputProjectionError('held'); };
  const invalid = (): never => { throw new ToolInputProjectionError('invalid'); };
  const assertBindings = (): void => { for (const guard of guards) guard(); };
  const assertCurrent = (): void => { assertBindings(); };
  const readPath = (name: string): unknown => {
    let current: unknown = context;
    for (const key of name.replace(/^context\./, '').split('.')) {
      if (current === undefined || current === null) return undefined;
      if (typeof current !== 'object' || nodeTypes.isProxy(current)) return invalid();
      const owner = current, binding = captureCatalogMethods(owner, [key]);
      binding(); guards.push(binding);
      const original = slot(owner, key);
      guards.push(() => { binding(); if (!Object.is(slot(owner, key), original)) held(); });
      current = original;
    }
    return current;
  };
  // Every selected path is bound before the first producer callback is invoked.
  const roots = paths.map(name => ({ name, value: readPath(name) }));
  const capture = (value: unknown, sourcePath: string, depth: number): { readonly view: unknown; readonly data: unknown } => {
    if (++nodes > 20_000 || depth > 64) return invalid();
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint'
        || (typeof value === 'number' && !Number.isFinite(value))) return invalid();
      return { view: value, data: value };
    }
    if (nodeTypes.isProxy(value) || ancestors.has(value)) return invalid();
    const prior = getCopy(value); if (prior) return prior;
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype === Map.prototype) {
      const methods = captureCatalogMethods(value, ['entries', 'get', 'set', 'delete', 'clear']);
      // Native Map.size is a getter. Validate its exact native descriptor without
      // asking the generic method capture to invoke or admit an accessor.
      const entries = Map.prototype.entries;
      if (Reflect.ownKeys(value).length || slot(Map.prototype, 'entries') !== entries) return invalid();
      const original = [...entries.call(value)];
      const view = new Map<string, unknown>();
      const rows: Array<{ readonly key: string; readonly value: unknown }> = [];
      ancestors.add(value);
      try {
        for (const [key, child] of original) {
          if (typeof key !== 'string') return invalid();
          const captured = capture(child, `${sourcePath}.${key}`, depth + 1);
          view.set(key, captured.view); rows.push({ key, value: captured.data });
        }
      } finally { ancestors.delete(value); }
      const captured = { view, data: { nativeMap: rows } }; setCopy(value, captured);
      guards.push(() => {
        methods();
        if (Object.getPrototypeOf(value) !== prototype || Reflect.ownKeys(value).length) held();
        const current = [...entries.call(value)];
        if (current.length !== original.length || current.some((entry, index) => {
          const old = original[index]; return !old || !Object.is(entry[0], old[0]) || !Object.is(entry[1], old[1]);
        })) held();
      });
      return captured;
    }
    const array = Array.isArray(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== 'string') || (array && Object.hasOwn(descriptors, 'constructor'))) return invalid();
    const length: unknown = array ? descriptors.length?.value : 0;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > 20_000) return invalid();
    const view: object = array ? new Array(length) : Object.create(null);
    const data: object = array ? new Array(length) : Object.create(null);
    const nativeMethods: string[] = [];
    const binding = captureCatalogMethods(value, [...keys.filter((key): key is string => typeof key === 'string'), ...methodNames, 'subscribe']);
    binding();
    ancestors.add(value);
    try {
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!('value' in descriptor)) return invalid();
        if (array && key === 'length') continue;
        const child: unknown = descriptor.value;
        if (typeof child === 'function') {
          if (array || !methodNames.includes(key) && key !== 'subscribe' || nodeTypes.isProxy(child)) return invalid();
          nativeMethods.push(key);
          if (key === 'subscribe') continue;
          Object.defineProperty(view, key, { enumerable: descriptor.enumerable, value: () => {
            assertCurrent();
            const original: unknown = child.call(value);
            if (nodeTypes.isPromise(original)) {
              void consumeNativePromise.call(original, undefined, () => {}); return held();
            }
            binding();
            const captured = capture(original, `${sourcePath}.${key}()`, depth + 1);
            results.push({ path: `${sourcePath}.${key}()`, data: captured.data });
            // Complete native rows and fresh detached DTOs are checked separately.
            const baseline = captureReadModelData(original, false);
            const matches = captureModelReadingSnapshotGuard(baseline);
            guards.push(() => {
              binding(); matches(captureReadModelData(original, false));
              const current: unknown = child.call(value);
              if (nodeTypes.isPromise(current)) {
                void consumeNativePromise.call(current, undefined, () => {}); held();
              }
              binding(); matches(captureReadModelData(current, false));
            });
            assertCurrent(); return captured.view;
          } });
          continue;
        }
        const captured = capture(child, `${sourcePath}.${key}`, depth + 1);
        Object.defineProperty(view, key, { value: captured.view, enumerable: descriptor.enumerable });
        Object.defineProperty(data, key, { value: captured.data, enumerable: true });
      }
    } finally { ancestors.delete(value); }
    if (array && (keys.length !== length + 1 || keys.some(key => key !== 'length'
      && (typeof key !== 'string' || !Number.isSafeInteger(Number(key)) || String(Number(key)) !== key || Number(key) < 0 || Number(key) >= length)))) return invalid();
    if (typeof slot(value, 'getSnapshot') === 'function' && typeof slot(value, 'subscribe') === 'function') {
      observers.push({ owner: value, binding });
    }
    const captured = { view, data: nativeMethods.length ? { data, nativeMethods } : data };
    setCopy(value, captured);
    guards.push(() => {
      binding(); const current = Reflect.ownKeys(value);
      if (current.length !== keys.length || current.some((key, index) => key !== keys[index])) held();
      for (const [key, descriptor] of Object.entries(descriptors)) {
        const now = Object.getOwnPropertyDescriptor(value, key);
        if (!now || !('value' in now) || !Object.is(now.value, descriptor.value)
          || now.enumerable !== descriptor.enumerable || now.configurable !== descriptor.configurable || now.writable !== descriptor.writable) held();
      }
    });
    return captured;
  };
  for (const root of roots) {
    if (typeof root.value === 'function') {
      if (!allowFunctionSources || nodeTypes.isProxy(root.value)) return invalid();
      const read = root.value, descriptors = Object.getOwnPropertyDescriptors(read), keys = Reflect.ownKeys(descriptors);
      if (keys.some(key => typeof key !== 'string')) return invalid();
      const binding = captureCatalogMethods(read, keys.filter((key): key is string => typeof key === 'string'));
      const metadata: Record<string, unknown> = Object.create(null);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!('value' in descriptor)) return invalid();
        if (key === 'prototype') {
          const prototype: unknown = descriptor.value;
          if (prototype === null || typeof prototype !== 'object' || nodeTypes.isProxy(prototype) || Object.getPrototypeOf(prototype) !== Object.prototype) return invalid();
          const fields = Object.getOwnPropertyDescriptors(prototype), names = Reflect.ownKeys(fields);
          if (names.some(name => typeof name !== 'string')) return invalid();
          const prototypeBinding = captureCatalogMethods(prototype, names.filter((name): name is string => typeof name === 'string'));
          guards.push(() => { prototypeBinding(); const current = Reflect.ownKeys(prototype); if (current.length !== names.length || current.some((name, index) => name !== names[index])) held(); });
          const data: Record<string, unknown> = Object.create(null);
          for (const [name, field] of Object.entries(fields)) {
            if (!('value' in field)) return invalid();
            if (name === 'constructor' && field.value === read) continue;
            data[name] = capture(field.value, `${root.name}.prototype.${name}`, 1).data;
          }
          metadata.prototype = data;
        } else metadata[key] = capture(descriptor.value, `${root.name}.${key}`, 1).data;
      }
      guards.push(() => { binding(); const current = Reflect.ownKeys(read); if (current.length !== keys.length || current.some((key, index) => key !== keys[index])) held(); });
      views.set(root.name, () => {
        assertCurrent(); const original: unknown = read(); binding();
        if (nodeTypes.isPromise(original)) { void consumeNativePromise.call(original, undefined, () => {}); return held(); }
        const captured = capture(original, `${root.name}()`, 0);
        results.push({ path: `${root.name}()`, data: captured.data });
        const matches = captureModelReadingSnapshotGuard(captureReadModelData(original, false));
        guards.push(() => {
          binding(); matches(captureReadModelData(original, false));
          const current: unknown = read(); binding();
          if (nodeTypes.isPromise(current)) { void consumeNativePromise.call(current, undefined, () => {}); held(); }
          matches(captureReadModelData(current, false));
        });
        assertCurrent(); return captured.view;
      });
      evidence.push({ path: root.name, data: { nativeSourceMethod: true, metadata } });
      continue;
    }
    const captured = capture(root.value, root.name, 0);
    views.set(root.name, captured.view); evidence.push({ path: root.name, data: captured.data });
  }
  captureModelReadingInput({ sources: evidence });
  for (const { owner, binding } of observers) {
    assertCurrent(); binding(); guards.push(captureNativeReadModelObservation(owner)); binding(); assertCurrent();
  }
  assertCurrent();
  return {
    source(name: string): unknown { assertCurrent(); if (!views.has(name)) return invalid(); return views.get(name); },
    evidence(): unknown { assertCurrent(); return captureModelReadingInput({ sources: evidence, results }); },
    assertCurrent,
  };
}

const CATALOG_NATIVE_CONFIG_KEYS = {
  "media": [
    "tts.provider",
    "tts.voice",
    "tts.llmProvider",
    "tts.llmModel",
    "ui.voiceEnabled",
    "web.enabled",
    "web.publicBaseUrl",
    "voice.wake.enabled",
    "voice.wake.surfaces.agent",
    "voice.wake.models",
    "voice.wake.noiseSuppression",
    "voice.wake.vadThreshold",
    "voice.wake.retainAudio",
    "voice.wake.activationSound",
    "voice.wake.activationSoundPath",
    "voice.wake.threshold",
    "voice.wake.patienceFrames",
    "voice.wake.cooldownMs",
    "voice.wake.inputDevice",
    "voice.wake.captureCommand",
    "voice.wake.indicator",
    "voice.wake.preRollMs",
    "voice.wake.captureMaxSeconds",
    "voice.wake.silenceStopMs",
    "voice.wake.silenceFloorRms",
    "voice.wake.speechRetriggerMs",
    "voice.wake.autoSubmit",
    "voice.wake.customModelDir",
    "voice.wake.maxRestarts",
    "voice.wake.restartBackoffMs",
    "voice.wake.crashWindowSeconds",
    "voice.wake.browserBackend"
  ],
  "pairing": [
    "controlPlane.enabled",
    "controlPlane.hostMode",
    "controlPlane.host",
    "controlPlane.port",
    "web.enabled",
    "web.hostMode",
    "web.host",
    "web.port",
    "ui.voiceEnabled",
    "notifications.webhookUrls",
    "tts.provider",
    "tts.voice",
    "tts.llmProvider",
    "tts.llmModel",
    "surfaces.slack.enabled",
    "surfaces.slack.botToken",
    "surfaces.slack.signingSecret",
    "surfaces.slack.defaultChannel",
    "surfaces.discord.enabled",
    "surfaces.discord.botToken",
    "surfaces.discord.publicKey",
    "surfaces.discord.applicationId",
    "surfaces.discord.defaultChannelId",
    "surfaces.telegram.enabled",
    "surfaces.telegram.botToken",
    "surfaces.telegram.defaultChatId",
    "surfaces.ntfy.enabled",
    "surfaces.ntfy.baseUrl",
    "surfaces.ntfy.chatTopic",
    "surfaces.ntfy.agentTopic",
    "surfaces.ntfy.topic",
    "surfaces.googleChat.enabled",
    "surfaces.googleChat.webhookUrl",
    "surfaces.googleChat.verificationToken",
    "surfaces.googleChat.spaceId",
    "surfaces.signal.enabled",
    "surfaces.signal.bridgeUrl",
    "surfaces.signal.account",
    "surfaces.signal.defaultRecipient",
    "surfaces.whatsapp.enabled",
    "surfaces.whatsapp.accessToken",
    "surfaces.whatsapp.verifyToken",
    "surfaces.whatsapp.phoneNumberId",
    "surfaces.whatsapp.defaultRecipient",
    "surfaces.telephony.enabled",
    "surfaces.telephony.bridgeUrl",
    "surfaces.telephony.accountSid",
    "surfaces.telephony.authToken",
    "surfaces.telephony.fromNumber",
    "surfaces.telephony.defaultRecipient",
    "surfaces.imessage.enabled",
    "surfaces.imessage.bridgeUrl",
    "surfaces.imessage.account",
    "surfaces.imessage.defaultChatId",
    "surfaces.bluebubbles.enabled",
    "surfaces.bluebubbles.serverUrl",
    "surfaces.bluebubbles.password",
    "surfaces.bluebubbles.defaultChatGuid",
    "surfaces.msteams.enabled",
    "surfaces.msteams.appId",
    "surfaces.msteams.appPassword",
    "surfaces.msteams.defaultConversationId",
    "surfaces.msteams.defaultChannelId",
    "surfaces.mattermost.enabled",
    "surfaces.mattermost.baseUrl",
    "surfaces.mattermost.botToken",
    "surfaces.mattermost.defaultChannelId",
    "surfaces.matrix.enabled",
    "surfaces.matrix.homeserverUrl",
    "surfaces.matrix.accessToken",
    "surfaces.matrix.defaultRoomId",
    "surfaces.webhook.enabled",
    "surfaces.webhook.defaultTarget"
  ],
  "cockpit": [
    "web.enabled",
    "web.hostMode",
    "web.host",
    "web.port",
    "web.publicBaseUrl"
  ]
} as const;
const CATALOG_PROVIDER_ENV_KEYS = ["OPENAI_API_KEY", "OPENAI_KEY", "DEEPGRAM_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_API_KEY", "ELEVENLABS_API_KEY", "XI_API_KEY", "VYDRA_API_KEY", "BYTEPLUS_API_KEY", "RUNWAY_API_KEY", "RUNWAYML_API_SECRET", "MODELSTUDIO_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_KEY", "FAL_KEY", "FAL_API_KEY", "COMFY_BASE_URL", "COMFY_API_KEY"] as const;


/** Bind private native facts before the leaf's first awaited acquisition. Raw
 * credential/file values remain local; complete provider metadata is screened. */
export function captureCatalogNativeFacts(context: unknown, family: 'media' | 'pairing' | 'cockpit') {
  const bindings: Array<() => void> = [], observations: Array<() => void> = [];
  function held(): never { throw new ToolInputProjectionError('held'); }
  const acquire = (keys: readonly string[]): unknown => {
    let value: unknown = context;
    for (const key of keys) {
      if (value === undefined || value === null) return undefined;
      if (typeof value !== 'object' || nodeTypes.isProxy(value)) return held();
      const owner = value, binding = captureCatalogMethods(owner, [key]); binding();
      const original = slot(owner, key);
      bindings.push(() => { binding(); if (!Object.is(slot(owner, key), original)) held(); });
      value = original;
    }
    return value;
  };
  const manager = acquire(['platform', 'configManager']), config = acquire(['platform', 'config']);
  const session = acquire(['session', 'runtime']);
  if (session !== null && typeof session === 'object') bindings.push(captureCatalogMethods(session, ['sessionId']));
  const registries = family === 'cockpit' ? [] : ['voiceProviderRegistry', 'mediaProviderRegistry']
    .map(key => ({ key, registry: acquire(['platform', key]) }));
  const paths = family === 'pairing' ? acquire(['workspace', 'shellPaths']) : undefined;
  const wakeService = family === 'media' ? acquire(['platform', 'voiceSetup']) : undefined;
  if (family === 'media') for (const keys of [['platform', 'voiceService'], ['submitSpokenInput'], ['stopSpokenOutput']]) {
    const owner = acquire(keys);
    if (owner !== null && typeof owner === 'object') bindings.push(captureCatalogMethods(owner, ['transcribe']));
  }
  if (wakeService !== null && wakeService !== undefined) {
    if (typeof wakeService !== 'object') held();
    bindings.push(captureCatalogMethods(wakeService, ['wakeStatus']));
  }
  if (manager !== null && manager !== undefined) {
    if (typeof manager !== 'object') held();
    bindings.push(captureCatalogMethods(manager, ['get', 'getConfigurationIncarnation']));
  }
  for (const { registry } of registries) if (registry !== null && registry !== undefined) {
    if (typeof registry !== 'object') held();
    bindings.push(captureCatalogMethods(registry, ['list', 'get', 'status', 'getIncarnation', 'captureReadSource', 'register', 'unregister']));
  }
  if (paths !== undefined && paths !== null) {
    if (typeof paths !== 'object') held();
    bindings.push(captureCatalogMethods(paths, ['homeDirectory', 'workingDirectory']));
  }
  const env = process.env;
  const environmentKeys = family === 'cockpit' ? [] : [...CATALOG_PROVIDER_ENV_KEYS,
    ...(family === 'pairing' ? ['GOODVIBES_CONNECTED_HOST_TOKEN', 'GOODVIBES_DAEMON_TOKEN'] : [])];
  const envSlots = captureCatalogMethods(env, environmentKeys); envSlots();
  bindings.push(() => { if (process.env !== env) held(); envSlots(); });
  const assertBindings = (): void => { for (const binding of bindings) binding(); };
  assertBindings();
  if (wakeService !== null && wakeService !== undefined) {
    const wakeCurrent = captureVoiceWakeReadSource(wakeService);
    assertBindings(); observations.push(() => { assertBindings(); wakeCurrent(); assertBindings(); });
  }
  // File identity, ancestry and complete original bytes are private custody,
  // not semantic evidence or permission to publish the selected credential.
  if (paths !== null && typeof paths === 'object') {
    const home = slot(paths, 'homeDirectory'); if (typeof home !== 'string') held();
    const file = connectedHostOperatorTokenPath(home), physical = captureAgentExportPath(home, file);
    bindings.push(() => { physical.assertCurrent(); });
    type FileObservation = { readonly kind: 'file'; readonly stat: string; readonly bytes: Buffer } | { readonly kind: 'absent'; readonly ancestor: string; readonly stat: string };
    const read = (): FileObservation => {
      assertBindings(); const before = lstatSync(file, { bigint: true, throwIfNoEntry: false });
      if (!before) {
        let ancestor = dirname(file);
        while (true) {
          const parent = lstatSync(ancestor, { bigint: true, throwIfNoEntry: false });
          if (parent) {
            if (!parent.isDirectory() || parent.isSymbolicLink()) held();
            assertBindings();
            return { kind: 'absent', ancestor, stat: `${parent.dev}:${parent.ino}:${parent.size}:${parent.mtimeNs}:${parent.ctimeNs}` };
          }
          const next = dirname(ancestor); if (next === ancestor) held(); ancestor = next;
        }
      }
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) held();
      const fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd, { bigint: true });
        if (opened.dev !== before.dev || opened.ino !== before.ino) held();
        const bytes = readFileSync(fd), after = fstatSync(fd, { bigint: true });
        const key = (stat: typeof opened) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
        if (key(opened) !== key(after)) held();
        assertBindings(); return { kind: 'file', stat: key(after), bytes };
      } finally { closeSync(fd); }
    };
    const original = read();
    const assertFile = (): void => {
      const current = read();
      if (original.kind !== current.kind || original.stat !== current.stat) held();
      if (original.kind === 'file' && current.kind === 'file' && !current.bytes.equals(original.bytes)) held();
      if (original.kind === 'absent' && current.kind === 'absent' && original.ancestor !== current.ancestor) held();
    };
    observations.push(assertFile);
    assertBindings(); assertFile(); const selected = readConnectedHostOperatorToken(home); assertFile(); assertBindings();
    const selection = captureCatalogSnapshot(selected);
    observations.push(() => {
      assertBindings(); assertFile(); const current = readConnectedHostOperatorToken(home); assertFile(); assertBindings(); selection.assertCurrent(current);
    });
  }
  if (manager !== null && typeof manager === 'object') {
    const get = slot(manager, 'get'), revision = slot(manager, 'getConfigurationIncarnation');
    if (typeof get !== 'function' || typeof revision !== 'function') held();
    assertBindings(); const before: unknown = revision.call(manager); assertBindings();
    if (typeof before !== 'number' || !Number.isSafeInteger(before) || before < 0) held();
    observations.push(() => { assertBindings(); if (revision.call(manager) !== before) held(); assertBindings(); });
    for (const key of CATALOG_NATIVE_CONFIG_KEYS[family]) {
      assertBindings(); const original: unknown = get.call(manager, key); assertBindings();
      const capture = captureCatalogSnapshot(original);
      observations.push(() => { assertBindings(); capture.assertCurrent(original); const current: unknown = get.call(manager, key); assertBindings(); capture.assertCurrent(current); });
    }
  }
  const providerDescriptors: Array<{ readonly domain: string; readonly data: unknown }> = [];
  const providerFacts: Array<{ readonly domain: string; readonly id: string; readonly data: unknown; readonly methods: readonly string[] }> = [];
  for (const { key, registry } of registries) {
    if (registry === null || registry === undefined) continue;
    if (typeof registry !== 'object') held();
    const list = slot(registry, 'list'), get = slot(registry, 'get'), revision = slot(registry, 'getIncarnation');
    if (typeof list !== 'function' || typeof get !== 'function' || typeof revision !== 'function') held();
    assertBindings();
    const nativeGuard = key === 'voiceProviderRegistry'
      ? registry instanceof VoiceProviderRegistry ? captureVoiceProviderReadSource(registry) : held()
      : registry instanceof MediaProviderRegistry ? captureMediaProviderReadSource(registry) : held();
    assertBindings();
    observations.push(() => { assertBindings(); nativeGuard(); assertBindings(); });
    assertBindings(); const incarnation: unknown = revision.call(registry); assertBindings();
    if (typeof incarnation !== 'number' || !Number.isSafeInteger(incarnation) || incarnation < 0) held();
    assertBindings(); const original: unknown = list.call(registry); assertBindings();
    const capture = captureCatalogSnapshot(original); providerDescriptors.push({ domain: key, data: capture.captured });
    if (!Array.isArray(capture.captured)) held();
    for (const descriptor of capture.captured) {
      const id = slot(descriptor, 'id'); if (typeof id !== 'string') held();
      assertBindings(); const provider: unknown = get.call(registry, id); assertBindings();
      if (provider === null || typeof provider !== 'object' || nodeTypes.isProxy(provider)) held();
      const keys = Reflect.ownKeys(provider);
      if (keys.some(key => typeof key !== 'string')) held();
      const fields = Object.getOwnPropertyDescriptors(provider);
      if (Object.values(fields).some(field => !('value' in field) || typeof field.value === 'function' && nodeTypes.isProxy(field.value))) held();
      const providerBinding = captureCatalogMethods(provider, keys.filter((key): key is string => typeof key === 'string'));
      bindings.push(providerBinding);
      const facts: Record<string, unknown> = Object.create(null), methods: string[] = [];
      for (const [name, field] of Object.entries(fields)) {
        if (typeof field.value === 'function') methods.push(name); else facts[name] = field.value;
      }
      const data = captureCatalogSnapshot(facts);
      providerFacts.push({ domain: key, id, data: data.captured, methods });
      observations.push(() => {
        assertBindings(); if (get.call(registry, id) !== provider) held(); assertBindings();
        const currentKeys = Reflect.ownKeys(provider);
        if (currentKeys.length !== keys.length || currentKeys.some((key, index) => key !== keys[index])) held();
        const current: Record<string, unknown> = Object.create(null);
        for (const [name, field] of Object.entries(Object.getOwnPropertyDescriptors(provider))) {
          if (!('value' in field)) held(); if (typeof field.value !== 'function') current[name] = field.value;
        }
        data.assertCurrent(current);
      });
    }
    observations.push(() => {
      assertBindings(); capture.assertCurrent(original);
      if (revision.call(registry) !== incarnation) held(); assertBindings();
      const current: unknown = list.call(registry); assertBindings(); capture.assertCurrent(current);
    });
  }
  const assertCurrent = (): void => { assertBindings(); for (const observation of observations) observation(); assertBindings(); void config; };
  assertCurrent();
  return { assertCurrent, providerEvidence: captureModelReadingInput({ providerDescriptors, providerFacts }) };
}

/** General catalogs bind original invocation source slots before direct reads.
 * Only the pure native restriction is retained by the parent publication guard. */
export function catalogReadingOptions(context: CommandContext, registry: ToolRegistry | undefined, signal: AbortSignal | undefined,
  assertExecution: () => void, retainCurrent: (guard: () => void, key?: string) => void) {
  const paths = [['session', 'runtime'], ['session', 'runtime', 'sessionId'], ['clients', 'mcpApi'], ['extensions', 'mcpRegistry']];
  const guards: Array<() => void> = [];
  for (const keys of paths) {
    let current: unknown = context;
    for (const key of keys) {
      if (current === undefined || current === null) break;
      if (typeof current !== 'object' || nodeTypes.isProxy(current)) throw new ToolInputProjectionError('held');
      const owner = current, binding = captureCatalogMethods(owner, [key]); binding();
      const original = slot(owner, key);
      guards.push(() => { binding(); if (!Object.is(slot(owner, key), original)) throw new ToolInputProjectionError('held'); });
      current = original;
    }
  }
  const sourceOwner = agentResearchSourceOwner(registry);
  const assertSourceCurrent = (): void => {
    signal?.throwIfAborted(); for (const guard of guards) guard();
    if (agentResearchSourceOwner(registry) !== sourceOwner) throw new ToolInputProjectionError('held');
  };
  if (typeof retainCurrent !== 'function' || nodeTypes.isProxy(retainCurrent)) throw new ToolInputProjectionError('held');
  assertSourceCurrent(); assertReadingRestriction(() => retainCurrent(assertSourceCurrent, 'agent.catalog.native-invocation-source')); assertSourceCurrent();
  return { signal, sourceOwner, retainCurrent, assertCurrent() { signal?.throwIfAborted(); assertReadingRestriction(assertExecution); assertSourceCurrent(); } };
}
