import { isDeepStrictEqual, types as nodeTypes } from 'node:util';
import { redactStructuredDataAsync } from '@goodvibes-jev/engine/sdk/platform/utils';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { captureOwnedJson } from '@goodvibes-jev/engine/sdk/platform/gate';
import { inspectCatalogData, captureCatalogData, captureCatalogMethods, captureCatalogSnapshotGuard, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { captureModelReadingSnapshotGuard } from './agent-harness-model-reading-source.ts';
import type { EntryType, JsonValue } from '@goodvibes-jev/judgment/decisions';
import { personalOpsNativeFields, personalOpsResultFields, type PersonalOpsNativeSchema } from './agent-personal-ops-native-fields.ts';

/** Hidden producer data is still semantic source; serialization cannot omit it. */
export function capturePersonalOpsData(value: unknown): unknown {
  const captured = captureCatalogData(value);
  let nodes = 0, characters = 0;
  const visit = (entry: unknown): unknown => {
    if (++nodes > 20_000) throw new ToolInputProjectionError('invalid');
    if (typeof entry === 'string') { characters += entry.length; if (characters > 1_000_000) throw new ToolInputProjectionError('invalid'); }
    if (!entry || typeof entry !== 'object') return entry;
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    if (Array.isArray(entry)) {
      if (Object.keys(descriptors).length !== entry.length + 1 || Object.keys(descriptors).some(key => key !== 'length'
        && (!Number.isSafeInteger(Number(key)) || String(Number(key)) !== key || Number(key) < 0 || Number(key) >= entry.length))) throw new ToolInputProjectionError('invalid');
      return entry.map(visit);
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      characters += key.length; if (characters > 1_000_000) throw new ToolInputProjectionError('invalid');
      Object.defineProperty(result, key, { value: visit(descriptor.value), enumerable: true });
    }
    return result;
  };
  return visit(captured);
}

export function assertPersonalOpsDataCurrent(value: unknown, captured: unknown): void {
  if (!isDeepStrictEqual(capturePersonalOpsData(value), captured)) throw new ToolInputProjectionError('held');
}

const normalizationDescriptor = Object.getOwnPropertyDescriptor;
const normalizationDescriptors = Object.getOwnPropertyDescriptors;
const normalizationPrototype = Object.getPrototypeOf;
const normalizationIsArray = Array.isArray;
const normalizationIs = Object.is;
const normalizationFreeze = Object.freeze;
const normalizationIsFrozen = Object.isFrozen;
const normalizationKeys = Object.keys;
const normalizationNumber = Number;
const normalizationString = String;
const normalizationIsSafeInteger = Number.isSafeInteger;
const normalizationObjectPrototype = Object.prototype;

// Guard only operations consumed by capture and normalization. Unrelated
// additions remain supported. Retain inherited lookup paths as well as own
// descriptors, so an added shadowing accessor is refused without calling it.
const normalizationRoots: readonly { readonly subject: object; readonly keys: readonly PropertyKey[] }[] = [
  { subject: globalThis, keys: ['Object', 'Array', 'Number', 'String', 'Map', 'Set', 'WeakMap', 'Reflect'] },
  { subject: Reflect, keys: ['ownKeys'] },
  { subject: Object, keys: ['getOwnPropertyDescriptor', 'getOwnPropertyDescriptors', 'getOwnPropertySymbols', 'getPrototypeOf',
    'hasOwn', 'values', 'entries', 'create', 'defineProperty', 'freeze', 'isFrozen', 'keys', 'is'] },
  { subject: Array, keys: ['isArray', Symbol.species] },
  { subject: Array.prototype, keys: ['map', 'some', Symbol.iterator, 'constructor', Symbol.toStringTag] },
  { subject: normalizationPrototype([][Symbol.iterator]()), keys: ['next'] },
  { subject: Number, keys: ['isFinite', 'isInteger', 'isSafeInteger'] },
  { subject: Map.prototype, keys: ['get', 'set', 'size'] },
  { subject: Set.prototype, keys: ['has', 'add', 'delete'] },
  { subject: WeakMap.prototype, keys: ['get', 'set'] },
  { subject: nodeTypes, keys: ['isProxy'] },
];
const normalizationOperations = normalizationRoots.map(({ subject, keys }) => {
  const chain: object[] = [];
  let holder: object | null = subject;
  while (holder !== null) { chain.push(holder); holder = normalizationPrototype(holder); }
  const slots = keys.map(key => {
    for (let index = 0; index < chain.length; index++) {
      const owner = chain[index];
      if (!owner) throw new ToolInputProjectionError('invalid');
      const descriptor = normalizationDescriptor(owner, key);
      if (descriptor) return { key, owner, descriptor };
    }
    return { key, owner: undefined, descriptor: undefined };
  });
  return { chain, slots };
});
const normalizationDescriptorFields = ['value', 'get', 'set', 'enumerable', 'configurable', 'writable'];
function assertNormalizationOperations(problem: 'invalid' | 'held'): void {
  // Native descriptor records and definition literals inherit these absent
  // fields. Check absence first, before reading any optional descriptor field.
  if (normalizationPrototype(normalizationObjectPrototype) !== null) throw new ToolInputProjectionError(problem);
  for (let index = 0; index < normalizationDescriptorFields.length; index++) {
    const key = normalizationDescriptorFields[index];
    if (key === undefined || normalizationDescriptor(normalizationObjectPrototype, key) !== undefined) throw new ToolInputProjectionError(problem);
  }
  for (let index = 0; index < normalizationOperations.length; index++) {
    const operation = normalizationOperations[index];
    if (!operation) throw new ToolInputProjectionError(problem);
    for (let chainIndex = 0; chainIndex < operation.chain.length; chainIndex++) {
      const holder = operation.chain[chainIndex];
      if (!holder || normalizationPrototype(holder) !== (operation.chain[chainIndex + 1] ?? null)) throw new ToolInputProjectionError(problem);
    }
    for (let slotIndex = 0; slotIndex < operation.slots.length; slotIndex++) {
      const slot = operation.slots[slotIndex];
      if (!slot) throw new ToolInputProjectionError(problem);
      let owner: object | undefined, current: PropertyDescriptor | undefined;
      for (let chainIndex = 0; chainIndex < operation.chain.length; chainIndex++) {
        const holder = operation.chain[chainIndex];
        if (!holder) throw new ToolInputProjectionError(problem);
        current = normalizationDescriptor(holder, slot.key);
        if (current) { owner = holder; break; }
      }
      const before = slot.descriptor;
      if (owner !== slot.owner) throw new ToolInputProjectionError(problem);
      if (!before || !current) {
        if (before !== current) throw new ToolInputProjectionError(problem);
        continue;
      }
      if (!normalizationIs(before.value, current.value) || before.get !== current.get || before.set !== current.set
        || before.enumerable !== current.enumerable || before.configurable !== current.configurable || before.writable !== current.writable)
        throw new ToolInputProjectionError(problem);
    }
  }
}

type PersonalOpsComparison = { readonly kind: 'value'; readonly value: unknown } | {
  readonly kind: 'object'; readonly array: boolean; readonly length: number;
  readonly slots: ReadonlyMap<string, PersonalOpsComparison>;
};

/** Own a normalized baseline while keeping every fresh raw observation. The
 * public arbitrary-baseline assertion above deliberately keeps its old path. */
export function capturePersonalOpsSnapshot(value: unknown): {
  readonly captured: unknown;
  readonly assertCurrent: (current: unknown) => void;
} {
  if (value === null || typeof value !== 'object') {
    const captured = capturePersonalOpsData(value);
    return normalizationFreeze({ captured, assertCurrent(current: unknown) {
      // Scalars keep the original complete normalization. A changed-to-object
      // input still retains the paired reader's operation-retirement boundary.
      const object = current !== null && typeof current === 'object';
      if (object) assertNormalizationOperations('held');
      assertPersonalOpsDataCurrent(current, captured);
      if (object) assertNormalizationOperations('held');
    } });
  }
  assertNormalizationOperations('invalid');
  const captured = capturePersonalOpsData(value);
  assertNormalizationOperations('invalid');
  // Either the SDK's own capture or a completely frozen, already admitted DTO
  // can prove stable data identity. A frozen parent with mutable descendants
  // still requires a complete comparison at every boundary.
  let immutable = false;
  try { immutable = captureOwnedJson(value) === value; } catch { /* The personal-ops grammar remains authoritative. */ }
  if (!immutable) {
    const seen = new Set<object>();
    const deeplyFrozen = (entry: unknown): boolean => {
      if (entry === null || typeof entry !== 'object') return true;
      if (seen.has(entry)) return true;
      if (nodeTypes.isProxy(entry) || !normalizationIsFrozen(entry)) return false;
      seen.add(entry);
      const descriptors = normalizationDescriptors(entry), keys = normalizationKeys(descriptors);
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index], descriptor = key === undefined ? undefined : descriptors[key];
        if (!descriptor || !('value' in descriptor) || !deeplyFrozen(descriptor.value)) return false;
      }
      return true;
    };
    immutable = deeplyFrozen(value);
  }
  let expandedCatalogCharacters = 0;
  const compile = (entry: unknown): PersonalOpsComparison => {
    if (typeof entry === 'string') expandedCatalogCharacters += entry.length;
    if (entry === null || typeof entry !== 'object') return normalizationFreeze({ kind: 'value', value: entry });
    const descriptors = normalizationDescriptors(entry), array = normalizationIsArray(entry);
    const slots = new Map<string, PersonalOpsComparison>();
    const keys = normalizationKeys(descriptors);
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index];
      if (key === undefined || array && key === 'length') continue;
      expandedCatalogCharacters += key.length;
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor)) throw new ToolInputProjectionError('invalid');
      slots.set(key, compile(descriptor.value));
    }
    // Only the newly constructed normalization tree is frozen. Borrowed input
    // and public protection results retain their original mutability.
    normalizationFreeze(entry);
    const length: unknown = array ? descriptors.length?.value : 0;
    if (typeof length !== 'number') throw new ToolInputProjectionError('invalid');
    return normalizationFreeze({ kind: 'object', array, length, slots });
  };
  const original = compile(captured);
  // A complete immutable descendant can also be reused at its exact captured
  // position. Only enable this proof when the fully expanded key/text cost is
  // within the catalog budget, so changing aliases cannot evade that budget.
  // Expanded depth and array-length slots may exceed the native guard's stricter
  // limits; the original comparison paths remain authoritative in those cases.
  let assertNative: ((current: unknown) => void) | undefined;
  if (expandedCatalogCharacters <= 1_000_000) {
    try { assertNative = captureModelReadingSnapshotGuard(value, true); } catch { /* Keep the complete original grammar. */ }
  }
  // Exact catalog equality proves the same fully expanded normalized value,
  // whose stricter Personal Ops budgets were admitted above. This complete
  // single-pass guard avoids normalizing unchanged observations twice. Its
  // stricter descriptor/order comparison may refuse equivalent values; those
  // still take the original normalization path, including invalid-tail checks.
  const assertExact = captureCatalogSnapshotGuard(value);
  const assertCurrent = (current: unknown): void => {
    assertNormalizationOperations('held');
    if (immutable && current === value) return;
    if (assertNative) {
      try { assertNative(current); return; } catch { /* Descriptor differences may still normalize equally. */ }
    }
    try { assertExact(current); return; } catch { /* Preserve normalized equality and complete invalid precedence below. */ }
    // Keep the complete first pass and its invalid precedence, alias grammar,
    // depth, node, character and array-slot limits exactly as before.
    const observation = inspectCatalogData(current);
    assertNormalizationOperations('held');
    let nodes = 0, characters = 0, equal = true;
    const invalid = (): never => { throw new ToolInputProjectionError('invalid'); };
    const compare = (entry: unknown, expected: PersonalOpsComparison | undefined): void => {
      if (++nodes > 20_000) return invalid();
      if (typeof entry === 'string') { characters += entry.length; if (characters > 1_000_000) return invalid(); }
      if (entry === null || typeof entry !== 'object') {
        if (!expected || expected.kind !== 'value' || !normalizationIs(entry, expected.value)) equal = false;
        return;
      }
      const descriptors = observation.get(entry);
      if (!descriptors) return invalid();
      const keys = normalizationKeys(descriptors), array = normalizationIsArray(entry);
      const expectedObject = expected?.kind === 'object' ? expected : undefined;
      if (!expectedObject || expectedObject.array !== array) equal = false;
      if (array) {
        const length: unknown = descriptors.length?.value;
        if (typeof length !== 'number' || keys.length !== length + 1) return invalid();
        for (let index = 0; index < keys.length; index++) {
          const key = keys[index];
          if (key === undefined) return invalid();
          if (key !== 'length' && (!normalizationIsSafeInteger(normalizationNumber(key))
            || normalizationString(normalizationNumber(key)) !== key || normalizationNumber(key) < 0 || normalizationNumber(key) >= length)) return invalid();
        }
        if (expectedObject?.length !== length) equal = false;
        for (let index = 0; index < length; index++) {
          const key = normalizationString(index), descriptor = descriptors[key];
          if (!descriptor || !('value' in descriptor)) return invalid();
          // Array indices carry no extra phase-two key-text charge.
          compare(descriptor.value, expectedObject?.array ? expectedObject.slots.get(key) : undefined);
        }
        return;
      }
      if (!expectedObject || expectedObject.slots.size !== keys.length) equal = false;
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index];
        if (key === undefined) return invalid();
        characters += key.length; if (characters > 1_000_000) return invalid();
        const descriptor = descriptors[key];
        if (!descriptor || !('value' in descriptor)) return invalid();
        // Every hidden field becomes normalized enumerable meaning. Object
        // insertion order and original descriptor flags do not decide equality.
        compare(descriptor.value, expectedObject && !expectedObject.array ? expectedObject.slots.get(key) : undefined);
      }
    };
    // Never stop on an unequal early field: all expanded aliases and malformed
    // tails must finish admission before a mismatch can become held.
    // This pass reads only the validated descriptor cache with native methods;
    // it invokes no source callback or accessor after the operation fence above.
    compare(current, original);
    if (!equal) throw new ToolInputProjectionError('held');
  };
  return normalizationFreeze({ captured, assertCurrent });
}

/** JSON normalization follows serialization grammar after descriptor-safe capture. */
export function personalOpsJson(value: unknown): JsonValue {
  const captured = capturePersonalOpsData(value);
  const visit = (entry: unknown): JsonValue => {
    if (entry === undefined || entry === null) return null;
    if (typeof entry === 'string' || typeof entry === 'boolean' || typeof entry === 'number') return entry;
    if (Array.isArray(entry)) return entry.map(visit);
    if (typeof entry !== 'object') throw new ToolInputProjectionError('invalid');
    const result: Record<string, JsonValue> = Object.create(null);
    for (const [key, child] of Object.entries(entry)) {
      if (child === undefined) continue;
      Object.defineProperty(result, key, { value: visit(child), enumerable: true });
    }
    return result;
  };
  return visit(captured);
}

/** Entry grammar excludes bare numeric and boolean roots. */
export function personalOpsEntry(value: unknown): EntryType {
  const entry = personalOpsJson(value);
  return typeof entry === 'boolean' || typeof entry === 'number' ? { value: entry } : entry;
}

/** Native producer facts remain local until the complete DTO is protected. */
export async function protectPersonalOpsData(value: unknown, options: CatalogRankingOptions = {}, schema?: PersonalOpsNativeSchema): Promise<unknown> {
  return protectPersonalOpsSource(value, options, true, schema);
}

/** Arbitrary provider results are observational data. Redacted names/values may
 * change their representation; complete original ownership still survives every
 * reading and publication. Native contracts continue through protectPersonalOpsData. */
export async function protectPersonalOpsResult(value: unknown, options: CatalogRankingOptions = {}): Promise<unknown> {
  return protectPersonalOpsSource(value, options, false);
}

async function protectPersonalOpsSource(value: unknown, options: CatalogRankingOptions, nativeFacts: boolean, schema?: PersonalOpsNativeSchema): Promise<unknown> {
  const source = capturePersonalOpsSnapshot(value), captured = source.captured;
  const optionsCurrent = captureCatalogMethods(options, ['signal', 'sourceOwner', 'assertCurrent', 'retainCurrent']);
  const signal = options.signal, callerCurrent = options.assertCurrent, retainCurrent = options.retainCurrent;
  const assertSource = () => {
    optionsCurrent();
    if (options.signal !== signal || options.assertCurrent !== callerCurrent || options.retainCurrent !== retainCurrent) throw new ToolInputProjectionError('held');
    signal?.throwIfAborted();
    source.assertCurrent(value);
  };
  const assertCurrent = () => {
    assertSource();
    const result: unknown = callerCurrent?.();
    if (result !== undefined) { void Promise.resolve(result).catch(() => {}); throw new ToolInputProjectionError('held'); }
    assertSource();
  };
  assertCurrent();
  // This detached tree is native-owned and fully immutable. Keep the original
  // producer guard above, but avoid retaining its private copy as mutable data
  // at every redaction boundary.
  const result = await redactStructuredDataAsync(captureOwnedJson(captured), { signal: options.signal, assertCurrent,
    declaredFields: nativeFacts ? personalOpsNativeFields(captured, schema) : personalOpsResultFields(captured),
  });
  const preserveFacts = (original: unknown, protectedValue: unknown): void => {
    if (typeof original === 'boolean' || typeof original === 'number' || original === null) {
      if (original !== protectedValue) throw new ToolInputProjectionError('held');
      return;
    }
    if (!original || typeof original !== 'object') return;
    if (!protectedValue || typeof protectedValue !== 'object' || Array.isArray(original) !== Array.isArray(protectedValue)) throw new ToolInputProjectionError('held');
    const descriptors = Object.getOwnPropertyDescriptors(protectedValue);
    for (const [key, child] of Object.entries(original)) {
      const descriptor = descriptors[key];
      // Opaque private object keys cannot establish a native producer fact.
      if (!descriptor || !('value' in descriptor)) throw new ToolInputProjectionError('held');
      preserveFacts(child, descriptor.value);
    }
  };
  if (nativeFacts) preserveFacts(captured, result);
  assertCurrent(); retainCurrent?.(assertSource); assertCurrent(); return result;
}
