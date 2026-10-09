import { types as nodeTypes } from 'node:util';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { gateJudgmentRegistry, snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import { SOURCE_SCREENING_LIMITS, type ProtectedSourceOwner, type ProtectedSource, type SourceScreeningReceipt } from '@goodvibes-jev/engine/sdk/platform/security';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Ranked, Rerank } from '@goodvibes-jev/judgment';

export interface CatalogRankingOptions {
  readonly signal?: AbortSignal;
  readonly sourceOwner?: ProtectedSourceOwner;
  readonly assertCurrent?: () => void;
}

/** Capture private DTO metadata without interpreting fields that will never be sent. */
function captureCatalogData<T>(value: T): T {
  const ancestors = new Set<object>();
  const copies = new WeakMap<object, object>();
  let nodes = 0;
  const invalid = (): never => { throw new ToolInputProjectionError('invalid'); };
  const capture = (entry: unknown, depth: number): unknown => {
    if (++nodes > 20_000 || depth > 64) return invalid();
    if (entry === null || entry === undefined || typeof entry === 'string' || typeof entry === 'boolean') return entry;
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
    const result: object = array ? new Array(length) : Object.create(null) as object;
    ancestors.add(entry);
    try {
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (array && key === 'length') continue;
        Object.defineProperty(result, key, { value: capture(descriptor.value, depth + 1), enumerable: descriptor.enumerable });
      }
      Object.freeze(result); copies.set(entry, result); return result;
    } finally { ancestors.delete(entry); }
  };
  return capture(value, 0) as T;
}

/** Product data is locally screened in full before the canonical public engine reader. */
export async function rankHarnessCatalog<T>(
  entries: readonly T[],
  query: string,
  describe: (entry: T) => { readonly id: string; readonly description: string },
  site: string,
  options: CatalogRankingOptions = {},
): Promise<{ readonly matches: readonly { readonly entry: T; readonly judgment: Ranked }[]; readonly judgments: readonly Ranked[] }> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const capturedEntries = captureCatalogData(entries);
  const catalog = capturedEntries.map((entry) => ({ entry, ...describe(entry) }));
  // Capture the COMPLETE transmitted source before projection or display limits.
  const source = snapshotJudgmentInput({ query, catalog: catalog.map(({ id, description }) => ({ id, description })) }) as {
    readonly query: string; readonly catalog: readonly { readonly id: string; readonly description: string }[];
  };
  if (entries.length === 0) return { matches: [], judgments: [] };
  if (new Set(source.catalog.map(({ id }) => id)).size !== catalog.length) throw new ToolInputProjectionError('held');
  const port = judgmentPort(site);
  const portModel = port.model, portAsk = port.ask;
  const owner = options.sourceOwner;
  if (!owner) throw new ToolInputProjectionError('held');
  const parts = [source.query, ...source.catalog.flatMap(({ id, description }) => [id, description])];
  if (parts.reduce((total, part) => total + part.length, 0) > SOURCE_SCREENING_LIMITS.characters
    || Math.ceil(parts.length / SOURCE_SCREENING_LIMITS.parts) > SOURCE_SCREENING_LIMITS.sources) throw new ToolInputProjectionError('held');
  const handles: ProtectedSource[] = [];
  const receipts: SourceScreeningReceipt[] = [];
  let released = false;
  let releasing: Promise<void> | undefined;
  const release = (): Promise<void> => {
    if (releasing) return releasing;
    released = true;
    options.signal?.removeEventListener('abort', abort);
    releasing = Promise.all(handles.map((handle) => owner.release(handle))).then(() => {});
    return releasing;
  };
  const abort = () => { void release().catch(() => {}); };
  const assertCurrent = () => {
    options.signal?.throwIfAborted(); options.assertCurrent?.();
    if (released || judgmentPort(site) !== port || port.model !== portModel || port.ask !== portAsk) throw new ToolInputProjectionError('held');
    for (const receipt of receipts) owner.project(receipt);
    options.signal?.throwIfAborted();
  };
  try {
    assertCurrent();
    for (let offset = 0; offset < parts.length; offset += SOURCE_SCREENING_LIMITS.parts) {
      assertCurrent(); handles.push(owner.capture(parts.slice(offset, offset + SOURCE_SCREENING_LIMITS.parts)));
    }
    options.signal?.addEventListener('abort', abort, { once: true });
    assertCurrent();
    const projected: string[] = [];
    for (const handle of handles) {
      assertCurrent();
      const result = await owner.screen(handle);
      assertCurrent();
      if (result.status !== 'settled') throw new ToolInputProjectionError('held');
      receipts.push(result.receipt); projected.push(...owner.project(result.receipt));
    }
    assertCurrent();
    if (projected.length !== parts.length) throw new ToolInputProjectionError('held');
    const decision = gateJudgmentRegistry.get('engine.tools.registry-rank');
    if (!decision || !('rerank' in decision) || typeof decision.rerank !== 'function') throw new ToolInputProjectionError('unavailable');
    const guardedPort: typeof port = { model: port.model, ...(port.recorder ? { recorder: port.recorder } : {}), ...(port.health ? { health: port.health } : {}), ask: async (request) => {
      assertCurrent();
      const result = await port.ask({ ...request,
        beforeAttempt: () => { request.beforeAttempt?.(); assertCurrent(); },
        assertLogCurrent: () => { request.assertLogCurrent?.(); assertCurrent(); },
      });
      assertCurrent(); return result;
    } };
    // Opaque request ids prevent catalog identity from bypassing source screening in logs.
    const { ranked } = await (decision as Rerank).rerank(guardedPort, projected[0]!, source.catalog.map((_entry, index) => ({
      id: String(index), content: { type: 'tool', name: projected[1 + index * 2]!, description: projected[2 + index * 2]!.slice(0, 600) },
    })), { site, ...(options.signal ? { signal: options.signal } : {}) });
    assertCurrent();
    for (const judgment of ranked) {
      if (judgment.decisionId) port.recorder?.recordAction(judgment.decisionId,
        judgment.reading.verdict === 'yes' ? 'catalog candidate matched'
          : judgment.reading.verdict === 'no' ? 'catalog candidate rejected' : 'catalog candidate held: uncertain');
    }
    const judgments = ranked.map((judgment) => ({ ...judgment, id: source.catalog[Number(judgment.id)]!.id }));
    return {
      matches: ranked.flatMap((judgment, index) => judgment.reading.verdict === 'no' ? [] : [{ entry: catalog[Number(judgment.id)]!.entry, judgment: judgments[index]! }]),
      judgments,
    };
  } finally { await release(); }
}
