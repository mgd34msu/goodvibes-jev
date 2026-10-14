import { captureMemoryOperation, assertMemoryOperationCurrent, awaitMemoryOperation, type MemoryOperationOptions } from './memory-operation.js';
import { assertMemoryPreparedAddOptionsBinding, captureMemoryPreparedAddOptions, prepareMemoryStoreAdd, retainMemoryAddBinding } from './memory-store.js';
import type { MemoryClass, MemoryPreparedAdd, MemoryPreparedAddCommitOptions, MemoryAddPublication, MemoryAddOptions, MemoryBundle, MemoryDoctorReport, MemoryLink, MemoryRecord, MemoryReviewPatch, MemoryScope, MemorySearchFilter, MemorySemanticSearchResult, MemoryStore } from './memory-store.js';
import type { MemoryVectorStats } from './memory-vector-store.js';
import type { MemoryImportResult } from './memory-store.js';
import { runHonestMemorySearch, type HonestMemorySearchOptions, type HonestMemorySearchResult } from './memory-recall-contract.js';

/**
 * MemoryRegistry, thin observable wrapper around the MemoryStore.
 * Panels subscribe via listeners; commands push/retrieve through this.
 */
const memoryOwnerMapGet = WeakMap.prototype.get;
const memoryOwnerMapSet = WeakMap.prototype.set;
const memoryOwnerMapApply = Reflect.apply;
function ownerMapGet<K extends object, V>(map: WeakMap<K, V>, key: K): V | undefined {
  return memoryOwnerMapApply(memoryOwnerMapGet, map, [key]);
}
function ownerMapSet<K extends object, V>(map: WeakMap<K, V>, key: K, value: V): void {
  memoryOwnerMapApply(memoryOwnerMapSet, map, [key, value]);
}

const nativeRegistries = new WeakMap<object, { readonly store: MemoryStore; readonly notify: (operation: MemoryOperationOptions) => void }>();

export class MemoryRegistry {
  private store: MemoryStore;
  private listeners: Array<() => void> = [];

  constructor(store: MemoryStore) {
    this.store = store;
    ownerMapSet(nativeRegistries, this, Object.freeze({ store, notify: (operation: MemoryOperationOptions) => this.notify(operation) }));
  }

  getStore(): MemoryStore {
    return this.store;
  }

  captureOperationScope(): () => void {
    const store = this.store, current = store.captureOperationScope();
    return () => {
      if (this.store !== store) throw new Error('Memory operation registry changed');
      current();
    };
  }

  subscribe(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter(l => l !== fn);
    };
  }

  private notify(operation: MemoryOperationOptions): void {
    for (const fn of this.listeners) { assertMemoryOperationCurrent(operation); fn(); }
    assertMemoryOperationCurrent(operation);
  }

  async add(opts: MemoryAddOptions, options?: MemoryOperationOptions): Promise<MemoryRecord> {
    const operation = captureMemoryOperation(options);
    const record = await awaitMemoryOperation(() => this.store.add(opts, operation), operation);
    this.notify(operation);
    return record;
  }

  /** Search; a query in the filter is ranked by the memory-search rerank (see MemoryStore.search). */
  search(filter: MemorySearchFilter = {}, options?: MemoryOperationOptions): Promise<MemoryRecord[]> {
    return this.store.search(filter, options);
  }

  searchSemantic(filter: MemorySearchFilter = {}, options?: MemoryOperationOptions): Promise<MemorySemanticSearchResult[]> {
    return this.store.searchSemantic(filter, options);
  }

  /** The vector index's candidates in similarity order, retrieval only (see MemoryStore.semanticCandidates). */
  semanticCandidates(filter: MemorySearchFilter = {}): MemorySemanticSearchResult[] {
    return this.store.semanticCandidates(filter);
  }

  /**
   * Search honoring the recall-honesty contract: semantic-or-literal with a stated
   * fallback reason when the index is unavailable, and (with `options.recall`) the
   * flagged/confidence-floor exclusion. This is the method a wire client and an
   * offline surface both route through, so the honesty is identical either way.
   */
  honestSearch(filter: MemorySearchFilter = {}, options: HonestMemorySearchOptions = {}, lifecycle?: MemoryOperationOptions): Promise<HonestMemorySearchResult> {
    return runHonestMemorySearch(this.store, filter, options, lifecycle);
  }

  rebuildVectors(): MemoryVectorStats {
    return this.store.rebuildVectorIndex();
  }

  async rebuildVectorsAsync(): Promise<MemoryVectorStats> {
    return this.store.rebuildVectorIndexAsync();
  }

  vectorStats(options?: MemoryOperationOptions): MemoryVectorStats {
    return this.store.vectorStats(options);
  }

  async doctor(options?: MemoryOperationOptions): Promise<MemoryDoctorReport> {
    return this.store.doctor(options);
  }

  reviewQueue(limit = 10, scope?: MemoryScope, options?: MemoryOperationOptions): Promise<MemoryRecord[]> {
    return this.store.reviewQueue(limit, scope, options);
  }

  exportBundle(filter: MemorySearchFilter = {}, options?: MemoryOperationOptions): MemoryBundle {
    return this.store.exportBundle(filter, options);
  }

  async importBundle(bundle: MemoryBundle, options?: MemoryOperationOptions): Promise<MemoryImportResult> {
    const operation = captureMemoryOperation(options);
    const result = await awaitMemoryOperation(() => this.store.importBundle(bundle, operation), operation);
    this.notify(operation);
    return result;
  }

  get(id: string, options?: MemoryOperationOptions): MemoryRecord | null {
    return this.store.get(id, options);
  }

  async link(fromId: string, toId: string, relation: string, options?: MemoryOperationOptions): Promise<MemoryLink | null> {
    const operation = captureMemoryOperation(options);
    const link = await awaitMemoryOperation(() => this.store.link(fromId, toId, relation, operation), operation);
    if (link) this.notify(operation);
    return link;
  }

  linksFor(id: string, options?: MemoryOperationOptions): MemoryLink[] {
    return this.store.linksFor(id, options);
  }

  update(id: string, patch: { cls?: MemoryClass; scope?: MemoryScope; summary?: string; detail?: string; tags?: string[]; validFrom?: number | null; validUntil?: number | null }, options?: MemoryOperationOptions): MemoryRecord | null {
    const operation = captureMemoryOperation(options);
    const record = this.store.update(id, patch, operation);
    if (record) this.notify(operation);
    return record;
  }

  review(id: string, patch: MemoryReviewPatch, options?: MemoryOperationOptions): MemoryRecord | null {
    const operation = captureMemoryOperation(options);
    const record = this.store.review(id, patch, operation);
    if (record) this.notify(operation);
    return record;
  }

  delete(id: string, options?: MemoryOperationOptions): boolean {
    const operation = captureMemoryOperation(options);
    const removed = this.store.delete(id, operation);
    if (removed) this.notify(operation);
    return removed;
  }

  getAll(): MemoryRecord[] {
    return this.store.retrieve({});
  }
}

/** Genuine constructed registry bridge; generic MemoryApi doubles cannot issue native plans. */
export function prepareMemoryRegistryAdd(registry: object, input: MemoryAddOptions, options?: MemoryOperationOptions): MemoryPreparedAdd {
  const owner = ownerMapGet(nativeRegistries, registry);
  if (!owner || !(registry instanceof MemoryRegistry)) throw new Error('Memory prepared add registry unavailable');
  const store = owner.store;
  const binding = retainMemoryAddBinding(registry, ['store', 'getStore', 'getAll', 'notify']);
  assertNativeRegistryMethods(registry);
  if (registry.getStore() !== store) throw new Error('Memory prepared add registry changed');
  const lifecycle = captureMemoryPreparedAddOptions(options);
  const assertRegistryCurrent = () => {
    binding(); assertMemoryOperationCurrent(lifecycle); binding();
    if (registry.getStore() !== store) throw new Error('Memory prepared add registry changed');
  };
  assertRegistryCurrent();
  const native = prepareMemoryStoreAdd(store, input, { signal: lifecycle.signal, assertCurrent: assertRegistryCurrent });
  let commitLifecycle: MemoryPreparedAddCommitOptions | undefined;
  let consumed = false;
  const assertCurrent = () => {
    assertRegistryCurrent(); native.assertCurrent();
    if (commitLifecycle) assertMemoryOperationCurrent(commitLifecycle);
    assertRegistryCurrent();
  };
  const prepared: MemoryPreparedAdd = Object.freeze({
    record: native.record,
    assertCurrent,
    assertPublication(receipt: MemoryAddPublication) {
      if (this !== prepared) throw new Error('Memory publication plan changed');
      if (commitLifecycle) assertMemoryPreparedAddOptionsBinding(commitLifecycle);
      assertRegistryCurrent(); native.assertPublication(receipt); assertRegistryCurrent();
    },
    async commit(commitOptions: MemoryPreparedAddCommitOptions = {}): Promise<MemoryRecord> {
      if (this !== prepared || consumed) throw new Error('Memory prepared add is not available');
      consumed = true;
      commitLifecycle = captureMemoryPreparedAddOptions(commitOptions);
      assertCurrent();
      const assertCommitCurrent = () => {
        assertRegistryCurrent();
        if (commitLifecycle) assertMemoryOperationCurrent(commitLifecycle);
        assertRegistryCurrent();
      };
      const result = await native.commit({ signal: commitLifecycle.signal, assertCurrent: assertCommitCurrent,
        onPublished: receipt => {
          if (commitLifecycle) assertMemoryPreparedAddOptionsBinding(commitLifecycle);
          assertRegistryCurrent(); native.assertPublication(receipt);
          const outcome: unknown = commitLifecycle?.onPublished?.(receipt);
          if (outcome !== undefined) {
            if (outcome instanceof Promise) void outcome.catch(() => {});
            throw new TypeError('Memory publication callbacks must be synchronous');
          }
        },
      });
      assertCurrent();
      // Reuse the original observable path after durable save, with the same restrictions.
      const operation = captureMemoryOperation({ signal: commitLifecycle.signal, assertCurrent });
      owner.notify(operation);
      assertCurrent();
      return result;
    },
  });
  return prepared;
}

const nativeRegistryAddMethods = ['getStore', 'getAll', 'notify']
  .map(key => ({ key, value: Object.getOwnPropertyDescriptor(MemoryRegistry.prototype, key)?.value }));
function assertNativeRegistryMethods(registry: MemoryRegistry): void {
  for (const original of nativeRegistryAddMethods) {
    let holder: object | null = registry;
    while (holder) {
      const slot = Object.getOwnPropertyDescriptor(holder, original.key);
      if (slot) {
        if (!('value' in slot) || slot.value !== original.value) throw new Error('Memory prepared add native registry method changed');
        break;
      }
      holder = Object.getPrototypeOf(holder);
    }
    if (!holder) throw new Error('Memory prepared add native registry method unavailable');
  }
}
