import { captureMemoryOperation, assertMemoryOperationCurrent, awaitMemoryOperation, type MemoryOperationOptions } from './memory-operation.js';
import type { MemoryAddOptions, MemoryBundle, MemoryDoctorReport, MemoryLink, MemoryRecord, MemoryReviewPatch, MemoryScope, MemorySearchFilter, MemorySemanticSearchResult, MemoryStore } from './memory-store.js';
import type { MemoryVectorStats } from './memory-vector-store.js';
import type { MemoryImportResult } from './memory-store.js';
import { runHonestMemorySearch, type HonestMemorySearchOptions, type HonestMemorySearchResult } from './memory-recall-contract.js';

/**
 * MemoryRegistry, thin observable wrapper around the MemoryStore.
 * Panels subscribe via listeners; commands push/retrieve through this.
 */
export class MemoryRegistry {
  private store: MemoryStore;
  private listeners: Array<() => void> = [];

  constructor(store: MemoryStore) {
    this.store = store;
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

  update(id: string, patch: { scope?: MemoryScope; summary?: string; detail?: string; tags?: string[]; validFrom?: number | null; validUntil?: number | null }, options?: MemoryOperationOptions): MemoryRecord | null {
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
