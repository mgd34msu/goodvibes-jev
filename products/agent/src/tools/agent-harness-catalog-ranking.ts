import { types as nodeTypes } from 'node:util';
import { judgmentPort, captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { gateJudgmentRegistry, prepareJudgmentResult, snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import { SOURCE_SCREENING_LIMITS, type ProtectedSourceOwner, type ProtectedSource, type SourceScreeningReceipt, type SourceScreeningHold } from '@goodvibes-jev/engine/sdk/platform/security';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Ranked, Rerank } from '@goodvibes-jev/judgment';
import { withModelReadingSource } from './agent-harness-model-reading-source.ts';

const ownDescriptor = Object.getOwnPropertyDescriptor;
const ownDescriptors = Object.getOwnPropertyDescriptors;
const prototypeOf = Object.getPrototypeOf;
const ownKeys = Reflect.ownKeys;
const isProxy = nodeTypes.isProxy;

export interface CatalogRankingOptions {
  readonly signal?: AbortSignal | undefined;
  readonly sourceOwner?: ProtectedSourceOwner | undefined;
  readonly assertCurrent?: (() => void) | undefined;
  /** Retain only acquired backend identities, never a released source receipt. */
  readonly retainCurrent?: ((guard: () => void, key?: string) => void) | undefined;
  /** Callers returning original semantic fields must hold if any source was redacted. */
  readonly requirePreservedSource?: boolean;
}

/** Capture private DTO metadata without interpreting fields that will never be sent. */
export function captureCatalogData<T>(value: T, budget = { nodes: 0, characters: 0, slots: 0 }): T {
  const ancestors = new Set<object>();
  const copies = new WeakMap<object, object>();
  const invalid = (): never => { throw new ToolInputProjectionError('invalid'); };
  const capture = (entry: unknown, depth: number): unknown => {
    if (++budget.nodes > 100_000 || depth > 64) return invalid();
    if (typeof entry === 'string') { budget.characters += entry.length; if (budget.characters > 1_000_000) return invalid(); return entry; }
    if (entry === null || entry === undefined || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number') return Number.isFinite(entry) ? entry : invalid();
    if (typeof entry !== 'object' || nodeTypes.isProxy(entry) || ancestors.has(entry)) return invalid();
    const existing = copies.get(entry); if (existing) return existing;
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
    const result: object = array ? new Array(length) : Object.create(null) as object;
    ancestors.add(entry);
    try {
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (array && key === 'length') continue;
        budget.characters += key.length;
        if (budget.characters > 1_000_000) return invalid();
        Object.defineProperty(result, key, { value: capture(descriptor.value, depth + 1), enumerable: descriptor.enumerable });
      }
      Object.freeze(result); copies.set(entry, result); return result;
    } finally { ancestors.delete(entry); }
  };
  return capture(value, 0) as T;
}

type CatalogSnapshot = { readonly kind: 'value'; readonly value: unknown } | {
  readonly kind: 'object'; readonly array: boolean; readonly length: number;
  readonly enumerableKeys: readonly string[];
  readonly slots: ReadonlyMap<string, { readonly enumerable: boolean; readonly value: CatalogSnapshot }>;
};

/** Retain the existing complete frozen copy alongside its fresh-data guard. */
export function captureCatalogSnapshot<T>(source: T): {
  readonly captured: T;
  readonly assertCurrent: (current: unknown) => void;
} {
  const captured = captureCatalogData(source);
  return { captured, assertCurrent: compileCatalogSnapshotGuard(captured) };
}

/** Compare fresh complete DTOs without copying them. Every call keeps the
 * original capture grammar and budgets, including alias and hidden-slot rules. */
export function captureCatalogSnapshotGuard(source: unknown): (current: unknown) => void {
  return compileCatalogSnapshotGuard(captureCatalogData(source));
}

function compileCatalogSnapshotGuard(captured: unknown): (current: unknown) => void {
  const snapshots = new WeakMap<object, CatalogSnapshot>();
  const snapshot = (value: unknown): CatalogSnapshot => {
    if (value === null || typeof value !== 'object') return { kind: 'value', value };
    const existing = snapshots.get(value); if (existing) return existing;
    const array = Array.isArray(value);
    const slots = new Map<string, { readonly enumerable: boolean; readonly value: CatalogSnapshot }>();
    const enumerableKeys: string[] = [];
    const result: CatalogSnapshot = { kind: 'object', array, length: array ? value.length : 0, enumerableKeys, slots };
    snapshots.set(value, result);
    for (const key of ownKeys(value)) {
      if (typeof key !== 'string') throw new ToolInputProjectionError('invalid');
      if (array && key === 'length') continue;
      const descriptor = ownDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) throw new ToolInputProjectionError('invalid');
      if (!array && descriptor.enumerable) enumerableKeys.push(key);
      slots.set(key, { enumerable: descriptor.enumerable === true, value: snapshot(descriptor.value) });
    }
    return result;
  };
  const original = snapshot(captured);
  return current => {
    const budget = { nodes: 0, characters: 0, slots: 0 };
    const ancestors = new Set<object>();
    const copies = new WeakMap<object, CatalogSnapshot>();
    const compared = new WeakMap<object, WeakSet<object>>();
    const changed = (): never => { throw new ToolInputProjectionError('held'); };
    const equal = (left: CatalogSnapshot, right: CatalogSnapshot): void => {
      if (left === right) return;
      if (left.kind === 'value' || right.kind === 'value') {
        if (left.kind !== 'value' || right.kind !== 'value' || !Object.is(left.value, right.value)) changed();
        return;
      }
      if (left.array !== right.array || left.length !== right.length || left.slots.size !== right.slots.size) changed();
      if (left.enumerableKeys.length !== right.enumerableKeys.length
        || left.enumerableKeys.some((key, index) => key !== right.enumerableKeys[index])) changed();
      const matches = compared.get(left) ?? new WeakSet<object>();
      if (matches.has(right)) return;
      matches.add(right); compared.set(left, matches);
      for (const [key, slot] of left.slots) {
        const other = right.slots.get(key);
        if (!other || other.enumerable !== slot.enumerable) return changed();
        equal(slot.value, other.value);
      }
    };
    const compare = (value: unknown, expected: CatalogSnapshot, depth: number): void => {
      if (++budget.nodes > 100_000 || depth > 64) changed();
      if (typeof value === 'string') {
        budget.characters += value.length;
        if (budget.characters > 1_000_000) changed();
      } else if (value !== null && value !== undefined && typeof value !== 'boolean'
        && (typeof value !== 'number' || !Number.isFinite(value)) && typeof value !== 'object') changed();
      if (value === null || typeof value !== 'object') {
        if (typeof value === 'number' && !Number.isFinite(value)) changed();
        if (expected.kind !== 'value' || !Object.is(value, expected.value)) changed();
        return;
      }
      if (isProxy(value) || ancestors.has(value) || expected.kind !== 'object') return changed();
      const existing = copies.get(value);
      if (existing) { equal(existing, expected); return; }
      const array = Array.isArray(value), prototype: unknown = prototypeOf(value);
      if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) changed();
      const descriptors = ownDescriptors(value), keys = ownKeys(descriptors);
      if (keys.some(key => typeof key !== 'string') || Object.hasOwn(descriptors, 'toJSON')
        || array && Object.hasOwn(descriptors, 'constructor')
        || Object.values(descriptors).some(descriptor => !('value' in descriptor) || typeof descriptor.value === 'function')) changed();
      const length: unknown = array ? descriptors.length?.value : 0;
      if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > 20_000) return changed();
      if (array && (budget.slots += length) > 100_000) changed();
      if (array !== expected.array || length !== expected.length || keys.length !== expected.slots.size + (array ? 1 : 0)) changed();
      ancestors.add(value);
      try {
        let enumerableIndex = 0;
        for (const key of keys) {
          if (typeof key !== 'string') return changed();
          if (array && key === 'length') continue;
          budget.characters += key.length;
          if (budget.characters > 1_000_000) changed();
          const descriptor = descriptors[key], slot = expected.slots.get(key);
          if (!descriptor || !slot || descriptor.enumerable !== slot.enumerable) return changed();
          if (!array && descriptor.enumerable && key !== expected.enumerableKeys[enumerableIndex++]) changed();
          compare(descriptor.value, slot.value, depth + 1);
        }
        copies.set(value, expected);
      } finally { ancestors.delete(value); }
    };
    compare(current, original, 0);
  };
}

/** Compare descriptors before touching a previously acquired backend again.
 * The installed recording port's stable model getter is the sole accessor. */
function catalogBackendSlots(subject: object, keys: readonly string[], modelGetter = false) {
  const chain: object[] = [];
  let owner: object | null = subject;
  while (owner) {
    if (isProxy(owner) || chain.length >= 64) throw new ToolInputProjectionError('held');
    chain.push(owner); owner = prototypeOf(owner);
  }
  return { chain, fields: keys.map(key => {
    for (const owner of chain) {
      const descriptor = ownDescriptor(owner, key);
      if (descriptor) {
        if (!('value' in descriptor) && (!modelGetter || key !== 'model' || typeof descriptor.get !== 'function' || descriptor.set)) throw new ToolInputProjectionError('held');
        return { key, owner, descriptor };
      }
    }
    return { key, owner: undefined, descriptor: undefined };
  }) };
}
function assertCatalogBackendSlots(before: ReturnType<typeof catalogBackendSlots>): void {
  for (let index = 0; index < before.chain.length; index++) {
    const owner = before.chain[index];
    if (!owner || prototypeOf(owner) !== (before.chain[index + 1] ?? null)) throw new ToolInputProjectionError('held');
  }
  for (const field of before.fields) {
    let owner: object | undefined, descriptor: PropertyDescriptor | undefined;
    for (const candidate of before.chain) {
      descriptor = ownDescriptor(candidate, field.key);
      if (descriptor) { owner = candidate; break; }
    }
    if (field.owner !== owner || field.descriptor?.value !== descriptor?.value
      || field.descriptor?.get !== descriptor?.get || field.descriptor?.set !== descriptor?.set
      || field.descriptor?.enumerable !== descriptor?.enumerable || field.descriptor?.configurable !== descriptor?.configurable
      || field.descriptor?.writable !== descriptor?.writable) throw new ToolInputProjectionError('held');
  }
}
/** Retain descriptor and prototype identity without invoking replacement accessors. */
export function captureCatalogMethods(subject: object, keys: readonly string[]): () => void {
  const names = [...keys];
  const captured = catalogBackendSlots(subject, names);
  return () => assertCatalogBackendSlots(captured);
}
function captureCatalogBackend(port: ReturnType<typeof judgmentPort>, decision: Rerank) {
  const decisionKeys = ['name', 'version', 'description', 'accuracyFloor', 'model', 'fixtureCount', 'checkFixtures', 'rerank'];
  const definition = catalogBackendSlots(decision, decisionKeys);
  const portKeys = ['model', 'ask', 'health', 'recorder'];
  const slots = catalogBackendSlots(port, portKeys, true);
  const model = port.model, ask = port.ask, recorder = port.recorder, rerank = decision.rerank;
  if (typeof ask !== 'function' || typeof rerank !== 'function') throw new ToolInputProjectionError('unavailable');
  const recorderKeys = ['recordReadings', 'recordAction'];
  const recording = recorder ? catalogBackendSlots(recorder, recorderKeys) : undefined;
  return { model, recorder, rerank, assertCurrent() {
    assertCatalogBackendSlots(definition);
    assertCatalogBackendSlots(slots);
    if (recorder && recording) assertCatalogBackendSlots(recording);
    if (port.model !== model || port.ask !== ask || port.recorder !== recorder) throw new ToolInputProjectionError('held');
  } };
}

type CatalogDescription = { readonly id: string; readonly description: string; readonly evidence?: unknown };
type CatalogCandidate = { readonly name: string; readonly description: string; readonly evidenceJson: string };
interface PreparedCatalog {
  readonly describe: object;
  readonly catalog: readonly CatalogDescription[];
  readonly parts: readonly string[];
  readonly ids: readonly string[];
  readonly candidates: readonly CatalogCandidate[];
}
const preparedCatalogs = new WeakMap<object, PreparedCatalog>();

const sourceScreeningHolds = Object.freeze({
  'route-unavailable': true, 'protected-input': true, malformed: true, unsettled: true,
  cancelled: true, stale: true, capacity: true, busy: true,
} satisfies Record<SourceScreeningHold, true>);

function screeningResultFields(value: unknown): PropertyDescriptorMap | undefined {
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value)) return undefined;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null || Reflect.ownKeys(value).length !== 2) return undefined;
  const fields = Object.getOwnPropertyDescriptors(value);
  if (!Object.hasOwn(fields, 'status') || Object.values(fields).some(field => !Object.hasOwn(field, 'value'))) return undefined;
  return fields;
}

function isSourceScreeningHold(value: unknown): value is SourceScreeningHold {
  return typeof value === 'string' && Object.hasOwn(sourceScreeningHolds, value);
}

/** Preserve only the native owner's finite operational refusal, never its input. */
function screeningHeldError(fields: PropertyDescriptorMap | undefined): ToolInputProjectionError {
  const error = new ToolInputProjectionError('held');
  const status: unknown = fields?.status?.value;
  const reason: unknown = fields && Object.hasOwn(fields, 'reason') ? fields.reason?.value : undefined;
  if (status === 'held' && isSourceScreeningHold(reason)) {
    Object.defineProperty(error, 'cause', { value: Object.freeze({ code: 'source-screening-held', reason }) });
  }
  return error;
}

function catalogEntryDescriptors(entries: readonly unknown[]) {
  if (!Array.isArray(entries) || nodeTypes.isProxy(entries) || Object.getPrototypeOf(entries) !== Array.prototype
    || entries.length >= SOURCE_SCREENING_LIMITS.parts * SOURCE_SCREENING_LIMITS.sources) throw new ToolInputProjectionError('held');
  const descriptors = Object.getOwnPropertyDescriptors(entries);
  if (Object.getOwnPropertySymbols(entries).length || Object.keys(descriptors).some((key) => key !== 'length'
    && (!/^(0|[1-9][0-9]*)$/.test(key) || !('value' in descriptors[key]!)))) throw new ToolInputProjectionError('invalid');
  return descriptors;
}
function captureCatalogEntries<T>(entries: readonly T[], descriptors: ReturnType<typeof catalogEntryDescriptors>): T[] {
  const capturedEntries: T[] = [];
  const budget = { nodes: 0, characters: 0, slots: 0 };
  for (let index = 0; index < entries.length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !('value' in descriptor)) throw new ToolInputProjectionError('invalid');
    capturedEntries.push(captureCatalogData(descriptor.value as T, budget));
  }
  return capturedEntries;
}
function captureCatalogDescription({ id, description, evidence }: CatalogDescription): CatalogDescription {
  const captured = snapshotJudgmentInput({ id, description, ...(evidence === undefined ? {} : { evidence }) });
  if (!captured || typeof captured !== 'object' || Array.isArray(captured) || !('id' in captured) || typeof captured.id !== 'string'
    || !('description' in captured) || typeof captured.description !== 'string') throw new ToolInputProjectionError('held');
  return Object.freeze({ id: captured.id, description: captured.description, ...('evidence' in captured ? { evidence: captured.evidence } : {}) });
}
function catalogParts(catalog: readonly CatalogDescription[]): readonly string[] {
  return Object.freeze(catalog.map(({ id, description, evidence }) => JSON.stringify([id, description, evidence ?? null])));
}

/** Prepare only immutable local metadata; each reading still captures and screens its complete distinct query. */
export function prepareHarnessCatalog<T>(entries: readonly T[], describe: (entry: T) => CatalogDescription): readonly T[] {
  const captured = Object.freeze(captureCatalogEntries(entries, catalogEntryDescriptors(entries)));
  const catalog = Object.freeze(captured.map(entry => captureCatalogDescription(describe(entry))));
  preparedCatalogs.set(captured, Object.freeze({ describe, catalog, parts: catalogParts(catalog),
    ids: Object.freeze(catalog.map(({ id }) => id)),
    candidates: Object.freeze(catalog.map(({ id, description, evidence }) => Object.freeze({
      name: id, description, evidenceJson: JSON.stringify(evidence ?? null),
    }))),
  }));
  return captured;
}

/** Product data is locally screened in full before the canonical public engine reader. */
export async function rankHarnessCatalog<T>(
  entries: readonly T[],
  query: string,
  describe: (entry: T) => { readonly id: string; readonly description: string; readonly evidence?: unknown },
  site: string,
  options: CatalogRankingOptions = {},
  decisionName = 'engine.tools.registry-rank',
): Promise<{ readonly matches: readonly { readonly entry: T; readonly judgment: Ranked }[]; readonly judgments: readonly Ranked[] }> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const descriptors = catalogEntryDescriptors(entries), found = preparedCatalogs.get(entries);
  const prepared = found?.describe === describe ? found : undefined;
  const capturedEntries = prepared ? entries : captureCatalogEntries(entries, descriptors);
  const catalog = prepared?.catalog ?? capturedEntries.map((entry) => ({ entry, ...describe(entry) }));
  // Capture the COMPLETE transmitted source before projection or display limits.
  const source = {
    query: snapshotJudgmentInput(query) as string,
    catalog: prepared ? catalog : catalog.map(captureCatalogDescription),
  };
  if (entries.length === 0) return { matches: [], judgments: [] };
  if (new Set(source.catalog.map(({ id }) => id)).size !== capturedEntries.length) throw new ToolInputProjectionError('held');
  const owner = options.sourceOwner;
  if (!owner) throw new ToolInputProjectionError('held');
  const assertOwnerMethods = captureCatalogMethods(owner, ['capture', 'screen', 'project', 'release']);
  const ownerMethods = { capture: owner.capture, screen: owner.screen, project: owner.project, release: owner.release };
  options.retainCurrent?.(assertOwnerMethods, `agent.catalog.owner:${site}`);
  // A whole candidate is one protected part, so the complete operator catalog
  // fits the owner's bounded source count without a lexical shortlist. JSON
  // framing is parsed only after screening; damaged framing holds the reading.
  const parts = [source.query, ...(prepared?.parts ?? catalogParts(source.catalog))];
  // Retain the original canonical whole-reading text budget across batches.
  if (parts.reduce((total, part) => total + part.length, 0) > 1_000_000) throw new ToolInputProjectionError('held');
  if (parts.some(part => part.length > SOURCE_SCREENING_LIMITS.characters)) {
    // Large schemas are complete structured values. Preserve every key/value
    // through the existing source framing instead of clipping a candidate or
    // splitting a semantic string. Original-returning readers require exact
    // preservation; uncertain or redacted source remains held.
    if (options.requirePreservedSource !== true) throw new ToolInputProjectionError('held');
    const assertOptions = captureCatalogMethods(options, ['signal', 'sourceOwner', 'assertCurrent', 'retainCurrent', 'requirePreservedSource']);
    const originalAssert = options.assertCurrent;
    return withModelReadingSource(source, { ...options, assertCurrent() { assertOptions(); originalAssert?.(); } }, async (captured, reading) => {
      let assertBackend: (() => void) | undefined;
      const assertCurrent = () => { reading.assertCurrent?.(); assertBackend?.(); };
      return consumeProtectedCatalog(capturedEntries, prepared?.ids ?? captured.catalog.map(({ id }) => id), captured.query,
        prepared?.candidates ?? captured.catalog.map(({ id, description, evidence }) => ({ name: id, description, evidenceJson: JSON.stringify(evidence ?? null) })),
        site, decisionName, { signal: reading.signal, assertCurrent, retainCurrent: reading.retainCurrent,
          retainBackend(guard) { assertBackend = guard; },
        });
    });
  }
  const batches: string[][] = [];
  for (const part of parts) {
    if (part.length > SOURCE_SCREENING_LIMITS.characters) throw new ToolInputProjectionError('held');
    let batch = batches.at(-1);
    if (!batch || batch.length >= SOURCE_SCREENING_LIMITS.parts
      || batch.reduce((total, text) => total + text.length, 0) + part.length > SOURCE_SCREENING_LIMITS.characters) {
      batch = []; batches.push(batch);
    }
    batch.push(part);
  }
  if (batches.length > SOURCE_SCREENING_LIMITS.sources) throw new ToolInputProjectionError('held');
  const signal = options.signal, originalAssert = options.assertCurrent, retainCurrent = options.retainCurrent;
  const requirePreservedSource = options.requirePreservedSource;
  let assertBackend: (() => void) | undefined;
  const handles: ProtectedSource[] = [];
  const receipts: { readonly receipt: SourceScreeningReceipt; readonly projection: readonly string[] }[] = [];
  let released = false;
  let releasing: Promise<void> | undefined;
  const release = (): Promise<void> => {
    if (releasing) return releasing;
    released = true;
    signal?.removeEventListener('abort', abort);
    releasing = Promise.resolve().then(async () => { await Promise.all(handles.map(handle => Promise.resolve().then(() => ownerMethods.release.call(owner, handle)))); });
    return releasing;
  };
  const abort = () => { void release().catch(() => {}); };
  // This guard deliberately survives source cleanup. Outer readers retain it
  // through subsequent enrichment and the final tool publication/release.
  const assertPublicationCurrent = () => {
    if (options.signal !== signal || options.sourceOwner !== owner || options.assertCurrent !== originalAssert
      || options.retainCurrent !== retainCurrent || options.requirePreservedSource !== requirePreservedSource) throw new ToolInputProjectionError('held');
    signal?.throwIfAborted(); originalAssert?.(); assertOwnerMethods(); assertBackend?.();
  };
  const assertCurrent = () => {
    assertPublicationCurrent();
    if (released) throw new ToolInputProjectionError('held');
    for (const { receipt, projection } of receipts) {
      const current = ownerMethods.project.call(owner, receipt);
      if (current.length !== projection.length || current.some((part, index) => part !== projection[index])) throw new ToolInputProjectionError('held');
    }
    signal?.throwIfAborted();
  };
  try {
    assertCurrent();
    for (const batch of batches) {
      assertCurrent(); handles.push(ownerMethods.capture.call(owner, batch));
    }
    signal?.addEventListener('abort', abort, { once: true });
    assertCurrent();
    const projected: string[] = [];
    for (const handle of handles) {
      assertCurrent();
      const result = await ownerMethods.screen.call(owner, handle);
      assertCurrent();
      const fields = screeningResultFields(result);
      const receipt: unknown = fields && Object.hasOwn(fields, 'receipt') ? fields.receipt?.value : undefined;
      if (!fields || !receipt || typeof receipt !== 'object' || nodeTypes.isProxy(receipt)
        || result.status !== 'settled') throw screeningHeldError(fields);
      const projection = ownerMethods.project.call(owner, result.receipt);
      receipts.push({ receipt: result.receipt, projection }); projected.push(...projection);
    }
    assertCurrent();
    if (projected.length !== parts.length || (requirePreservedSource && projected.some((part, index) => part !== parts[index]))) throw new ToolInputProjectionError('held');
    const preserved = prepared && requirePreservedSource;
    const projectedCatalog = preserved ? prepared.candidates : projected.slice(1).map((part) => {
      let value: unknown;
      try { value = JSON.parse(part); } catch { throw new ToolInputProjectionError('held'); }
      if (!Array.isArray(value) || value.length !== 3 || typeof value[0] !== 'string' || typeof value[1] !== 'string') throw new ToolInputProjectionError('held');
      const evidenceJson = JSON.stringify(value[2]);
      if (typeof evidenceJson !== 'string') throw new ToolInputProjectionError('held');
      return { name: value[0], description: value[1], evidenceJson };
    });
    return await consumeProtectedCatalog(capturedEntries, preserved ? prepared.ids : source.catalog.map(({ id }) => id), projected[0]!, projectedCatalog, site, decisionName, {
      signal, assertCurrent, retainCurrent,
      retainBackend(guard) { assertBackend = guard; },
    });
  } finally { await release(); assertPublicationCurrent(); }
}

/** The canonical reader consumes only a completely protected catalog. */
async function consumeProtectedCatalog<T>(entries: readonly T[], ids: readonly string[], query: string,
  projectedCatalog: readonly CatalogCandidate[],
  site: string, decisionName: string, options: {
    readonly signal?: AbortSignal | undefined;
    readonly assertCurrent: () => void;
    readonly retainCurrent?: CatalogRankingOptions['retainCurrent'];
    readonly retainBackend: (guard: () => void) => void;
  }): Promise<{ readonly matches: readonly { readonly entry: T; readonly judgment: Ranked }[]; readonly judgments: readonly Ranked[] }> {
  // No hosted port lookup, log, cache, or request precedes full screening.
  const port = judgmentPort(site);
  const decision = gateJudgmentRegistry.get(decisionName);
  if (!decision) throw new ToolInputProjectionError('unavailable');
  const backend = captureCatalogBackend(port, decision as Rerank);
  const { model, rerank } = backend;
  const installation = captureJudgmentPort(site, { signal: options.signal, prepareResultCapture: prepareJudgmentResult });
  const readingPort = installation.port, recorder = readingPort.recorder;
  let assertInstallation = installation.assertCurrent;
  const assertBackend = () => {
    backend.assertCurrent();
    assertInstallation();
    if (judgmentPort(site) !== port || gateJudgmentRegistry.get(decisionName) !== decision) throw new ToolInputProjectionError('held');
  };
  options.retainBackend(assertBackend);
  options.retainCurrent?.(assertBackend, `${decisionName}:${site}`);
  options.assertCurrent();
  const guardedPort: typeof port = { model, ...(recorder ? { recorder: {
    recordReadings: (...args: Parameters<typeof recorder.recordReadings>) => { options.assertCurrent(); recorder.recordReadings(...args); options.assertCurrent(); },
    recordAction: (...args: Parameters<typeof recorder.recordAction>) => { options.assertCurrent(); recorder.recordAction(...args); options.assertCurrent(); },
  } } : {}), ask: async (request) => {
    options.assertCurrent();
    const result = await readingPort.ask({ ...request,
      beforeAttempt: () => { request.beforeAttempt?.(); options.assertCurrent(); },
      assertLogCurrent: () => { request.assertLogCurrent?.(); options.assertCurrent(); },
    });
    options.assertCurrent(); return result;
  } };
  try {
    // Opaque request ids prevent catalog identity from bypassing source screening in logs.
    const { ranked } = await rerank.call(decision, guardedPort, query, ids.map((_entry, index) => ({
      id: String(index), content: { type: 'tool', ...projectedCatalog[index]! },
    })), { site, ...(options.signal ? { signal: options.signal } : {}) });
    options.assertCurrent();
    if (ranked.length !== entries.length || new Set(ranked.map(({ id }) => id)).size !== ranked.length
      || ranked.some(({ id }) => !/^(0|[1-9][0-9]*)$/.test(id) || Number(id) >= entries.length)) throw new ToolInputProjectionError('held');
    for (const judgment of ranked) {
      options.assertCurrent();
      if (judgment.decisionId) guardedPort.recorder?.recordAction(judgment.decisionId,
        judgment.reading.outcome !== 'act' ? 'catalog candidate held: unresolved reading'
          : judgment.reading.verdict === 'yes' ? 'catalog candidate matched'
          : judgment.reading.verdict === 'no' ? 'catalog candidate rejected' : 'catalog candidate held: uncertain');
    }
    const judgments = ranked.map((judgment) => ({ ...judgment, id: ids[Number(judgment.id)]! }));
    return {
      matches: ranked.flatMap((judgment, index) => judgment.reading.verdict === 'no' && judgment.reading.outcome === 'act' ? [] : [{ entry: entries[Number(judgment.id)]!, judgment: judgments[index]! }]),
      judgments,
    };
  } finally {
    const observation = installation.consumeObservation();
    assertInstallation = observation.assertCurrent;
    assertBackend();
  }
}
