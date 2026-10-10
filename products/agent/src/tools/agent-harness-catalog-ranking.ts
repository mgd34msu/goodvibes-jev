import { types as nodeTypes } from 'node:util';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { gateJudgmentRegistry, snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import { SOURCE_SCREENING_LIMITS, type ProtectedSourceOwner, type ProtectedSource, type SourceScreeningReceipt } from '@goodvibes-jev/engine/sdk/platform/security';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Ranked, Rerank } from '@goodvibes-jev/judgment';

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

/** Compare descriptors before touching a previously acquired backend again.
 * The installed recording port's stable model getter is the sole accessor. */
function catalogBackendSlots(subject: object, keys: readonly string[], modelGetter = false) {
  const chain: object[] = [];
  let owner: object | null = subject;
  while (owner) {
    if (nodeTypes.isProxy(owner) || chain.length >= 64) throw new ToolInputProjectionError('held');
    chain.push(owner); owner = Object.getPrototypeOf(owner) as object | null;
  }
  return { chain, fields: keys.map(key => {
    for (const owner of chain) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor) {
        if (!('value' in descriptor) && (!modelGetter || key !== 'model' || typeof descriptor.get !== 'function' || descriptor.set)) throw new ToolInputProjectionError('held');
        return { owner, descriptor };
      }
    }
    return undefined;
  }) };
}
function assertCatalogBackendSlots(before: ReturnType<typeof catalogBackendSlots>, after: ReturnType<typeof catalogBackendSlots>): void {
  if (after.chain.length !== before.chain.length || after.chain.some((owner, index) => owner !== before.chain[index])) throw new ToolInputProjectionError('held');
  for (const [index, field] of before.fields.entries()) {
    const current = after.fields[index];
    if (field?.owner !== current?.owner || field?.descriptor.value !== current?.descriptor.value
      || field?.descriptor.get !== current?.descriptor.get || field?.descriptor.set !== current?.descriptor.set
      || field?.descriptor.enumerable !== current?.descriptor.enumerable || field?.descriptor.configurable !== current?.descriptor.configurable
      || field?.descriptor.writable !== current?.descriptor.writable) throw new ToolInputProjectionError('held');
  }
}
function captureCatalogBackend(port: ReturnType<typeof judgmentPort>, decision: Rerank) {
  const decisionKeys = ['name', 'version', 'description', 'accuracyFloor', 'model', 'fixtureCount', 'checkFixtures', 'rerank'];
  const definition = catalogBackendSlots(decision, decisionKeys);
  const portKeys = ['model', 'ask', 'recorder'];
  const slots = catalogBackendSlots(port, portKeys, true);
  const model = port.model, ask = port.ask, recorder = port.recorder, rerank = decision.rerank;
  if (typeof ask !== 'function' || typeof rerank !== 'function') throw new ToolInputProjectionError('unavailable');
  const recorderKeys = ['recordReadings', 'recordAction'];
  const recording = recorder ? catalogBackendSlots(recorder, recorderKeys) : undefined;
  return { model, recorder, rerank, assertCurrent() {
    assertCatalogBackendSlots(definition, catalogBackendSlots(decision, decisionKeys));
    assertCatalogBackendSlots(slots, catalogBackendSlots(port, portKeys, true));
    if (recorder && recording) assertCatalogBackendSlots(recording, catalogBackendSlots(recorder, recorderKeys));
    if (port.model !== model || port.ask !== ask || port.recorder !== recorder) throw new ToolInputProjectionError('held');
  } };
}

/** Product data is locally screened in full before the canonical public engine reader. */
export async function rankHarnessCatalog<T>(
  entries: readonly T[],
  query: string,
  describe: (entry: T) => { readonly id: string; readonly description: string; readonly evidence?: unknown },
  site: string,
  options: CatalogRankingOptions = {},
): Promise<{ readonly matches: readonly { readonly entry: T; readonly judgment: Ranked }[]; readonly judgments: readonly Ranked[] }> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  if (!Array.isArray(entries) || nodeTypes.isProxy(entries) || Object.getPrototypeOf(entries) !== Array.prototype
    || entries.length >= SOURCE_SCREENING_LIMITS.parts * SOURCE_SCREENING_LIMITS.sources) throw new ToolInputProjectionError('held');
  const descriptors = Object.getOwnPropertyDescriptors(entries);
  if (Object.getOwnPropertySymbols(entries).length || Object.keys(descriptors).some((key) => key !== 'length'
    && (!/^(0|[1-9][0-9]*)$/.test(key) || !('value' in descriptors[key]!)))) throw new ToolInputProjectionError('invalid');
  const capturedEntries: T[] = [];
  const budget = { nodes: 0, characters: 0, slots: 0 };
  for (let index = 0; index < entries.length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !('value' in descriptor)) throw new ToolInputProjectionError('invalid');
    capturedEntries.push(captureCatalogData(descriptor.value as T, budget));
  }
  const catalog = capturedEntries.map((entry) => ({ entry, ...describe(entry) }));
  // Capture the COMPLETE transmitted source before projection or display limits.
  const source = {
    query: snapshotJudgmentInput(query) as string,
    catalog: catalog.map(({ id, description, evidence }) => snapshotJudgmentInput({ id, description, ...(evidence === undefined ? {} : { evidence }) }) as {
      readonly id: string; readonly description: string; readonly evidence?: unknown;
    }),
  };
  if (entries.length === 0) return { matches: [], judgments: [] };
  if (new Set(source.catalog.map(({ id }) => id)).size !== catalog.length) throw new ToolInputProjectionError('held');
  const owner = options.sourceOwner;
  if (!owner) throw new ToolInputProjectionError('held');
  // A whole candidate is one protected part, so the complete operator catalog
  // fits the owner's bounded source count without a lexical shortlist. JSON
  // framing is parsed only after screening; damaged framing holds the reading.
  const parts = [source.query, ...source.catalog.map(({ id, description, evidence }) => JSON.stringify([id, description, evidence ?? null]))];
  // Retain the original canonical whole-reading text budget across batches.
  if (parts.reduce((total, part) => total + part.length, 0) > 1_000_000) throw new ToolInputProjectionError('held');
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
    releasing = Promise.resolve().then(async () => { await Promise.all(handles.map(handle => Promise.resolve().then(() => owner.release(handle)))); });
    return releasing;
  };
  const abort = () => { void release().catch(() => {}); };
  // This guard deliberately survives source cleanup. Outer readers retain it
  // through subsequent enrichment and the final tool publication/release.
  const assertPublicationCurrent = () => {
    if (options.signal !== signal || options.sourceOwner !== owner || options.assertCurrent !== originalAssert
      || options.retainCurrent !== retainCurrent || options.requirePreservedSource !== requirePreservedSource) throw new ToolInputProjectionError('held');
    signal?.throwIfAborted(); originalAssert?.(); assertBackend?.();
  };
  const assertCurrent = () => {
    assertPublicationCurrent();
    if (released) throw new ToolInputProjectionError('held');
    for (const { receipt, projection } of receipts) {
      const current = owner.project(receipt);
      if (current.length !== projection.length || current.some((part, index) => part !== projection[index])) throw new ToolInputProjectionError('held');
    }
    signal?.throwIfAborted();
  };
  try {
    assertCurrent();
    for (const batch of batches) {
      assertCurrent(); handles.push(owner.capture(batch));
    }
    signal?.addEventListener('abort', abort, { once: true });
    assertCurrent();
    const projected: string[] = [];
    for (const handle of handles) {
      assertCurrent();
      const result = await owner.screen(handle);
      assertCurrent();
      if (result.status !== 'settled') throw new ToolInputProjectionError('held');
      const projection = owner.project(result.receipt);
      receipts.push({ receipt: result.receipt, projection }); projected.push(...projection);
    }
    assertCurrent();
    if (projected.length !== parts.length || (requirePreservedSource && projected.some((part, index) => part !== parts[index]))) throw new ToolInputProjectionError('held');
    const projectedCatalog = projected.slice(1).map((part) => {
      let value: unknown;
      try { value = JSON.parse(part); } catch { throw new ToolInputProjectionError('held'); }
      if (!Array.isArray(value) || value.length !== 3 || typeof value[0] !== 'string' || typeof value[1] !== 'string') throw new ToolInputProjectionError('held');
      return value as [string, string, unknown];
    });
    // No hosted port lookup, log, cache, or request precedes full screening.
    const port = judgmentPort(site);
    const decision = gateJudgmentRegistry.get('engine.tools.registry-rank');
    if (!decision) throw new ToolInputProjectionError('unavailable');
    const backend = captureCatalogBackend(port, decision as Rerank);
    const { model, recorder, rerank } = backend;
    assertBackend = () => {
      backend.assertCurrent();
      if (judgmentPort(site) !== port || gateJudgmentRegistry.get('engine.tools.registry-rank') !== decision) throw new ToolInputProjectionError('held');
    };
    retainCurrent?.(assertBackend, `engine.tools.registry-rank:${site}`);
    assertCurrent();
    const guardedPort: typeof port = { model, ...(recorder ? { recorder: {
      recordReadings: (...args: Parameters<typeof recorder.recordReadings>) => { assertCurrent(); recorder.recordReadings(...args); assertCurrent(); },
      recordAction: (...args: Parameters<typeof recorder.recordAction>) => { assertCurrent(); recorder.recordAction(...args); assertCurrent(); },
    } } : {}), ask: async (request) => {
      assertCurrent();
      const result = await port.ask({ ...request,
        beforeAttempt: () => { request.beforeAttempt?.(); assertCurrent(); },
        assertLogCurrent: () => { request.assertLogCurrent?.(); assertCurrent(); },
      });
      assertCurrent(); return result;
    } };
    // Opaque request ids prevent catalog identity from bypassing source screening in logs.
    const { ranked } = await rerank.call(decision, guardedPort, projected[0]!, source.catalog.map((_entry, index) => ({
      id: String(index), content: { type: 'tool', name: projectedCatalog[index]![0], description: projectedCatalog[index]![1].slice(0, 600) },
    })), { site, ...(signal ? { signal } : {}) });
    assertCurrent();
    if (ranked.length !== catalog.length || new Set(ranked.map(({ id }) => id)).size !== ranked.length
      || ranked.some(({ id }) => !/^(0|[1-9][0-9]*)$/.test(id) || Number(id) >= catalog.length)) throw new ToolInputProjectionError('held');
    for (const judgment of ranked) {
      assertCurrent();
      if (judgment.decisionId) guardedPort.recorder?.recordAction(judgment.decisionId,
        judgment.reading.verdict === 'yes' ? 'catalog candidate matched'
          : judgment.reading.verdict === 'no' ? 'catalog candidate rejected' : 'catalog candidate held: uncertain');
    }
    const judgments = ranked.map((judgment) => ({ ...judgment, id: source.catalog[Number(judgment.id)]!.id }));
    return {
      matches: ranked.flatMap((judgment, index) => judgment.reading.verdict === 'no' ? [] : [{ entry: catalog[Number(judgment.id)]!.entry, judgment: judgments[index]! }]),
      judgments,
    };
  } finally { await release(); assertPublicationCurrent(); }
}
