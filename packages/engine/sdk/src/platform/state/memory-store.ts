/**
 * MemoryStore, project memory substrate.
 *
 * Durable, provenance-rich memory for decisions, constraints, incidents, and
 * patterns. Backed by SQLite via SQLiteStore. Survives process restarts and is
 * queryable by runtime/panel/context enrichment consumers.
 *
 * Provenance links can reference: session, turn, task, event, or file.
 */

import { captureMemoryOperation, assertMemoryOperationCurrent, awaitMemoryOperation, type MemoryOperationOptions } from './memory-operation.js';
import { randomUUID } from 'node:crypto';
import { rankReviewQueue, rankSemanticSearch, rerankRetrieved } from './memory-search-ranking.js';
import { SQLiteStore } from './sqlite-store.js';
import {
  SqliteVecMemoryIndex,
  type MemoryVectorStats,
  resolveMemoryVectorDbPath,
} from './memory-vector-store.js';
import {
  HASHED_MEMORY_EMBEDDING_PROVIDER,
  MemoryEmbeddingProviderRegistry,
  type MemoryEmbeddingDoctorReport,
} from './memory-embeddings.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import {
  clampConfidence,
  compareByTrust,
  createSchema,
  isReviewFlagged,
  normalizeReviewState,
  normalizeScope,
  recordMatchesPostSqlFilter,
  rowToRecord,
} from './memory-store-helpers.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type MemoryClass =
  | 'decision'
  | 'constraint'
  | 'incident'
  | 'pattern'
  | 'fact'
  | 'risk'
  | 'runbook'
  | 'architecture'
  | 'ownership';

export type MemoryScope = 'session' | 'project' | 'team';

export type MemoryReviewState = 'fresh' | 'reviewed' | 'stale' | 'contradicted';

export type ProvenanceLinkKind = 'session' | 'turn' | 'task' | 'event' | 'file';

export interface ProvenanceLink {
  kind: ProvenanceLinkKind;
  /** The referenced identifier (session ID, turn number, task ID, event ID, or file path). */
  ref: string;
  /** Optional human-readable label. */
  label?: string | undefined;
}

export interface MemoryRecord {
  /** Auto-assigned, unique within the store. */
  id: string;
  /** Scope of the record for retrieval and sharing workflows. */
  scope: MemoryScope;
  /** Memory class, governs retrieval priority and display grouping. */
  cls: MemoryClass;
  /** Brief summary (one sentence). */
  summary: string;
  /** Optional expanded detail. */
  detail?: string | undefined;
  /** Tags for search and grouping. */
  tags: string[];
  /** Provenance links back to the source context. */
  provenance: ProvenanceLink[];
  /** Operator/state review signal. */
  reviewState: MemoryReviewState;
  /** Confidence score from 0-100. Higher means the record is more trusted for retrieval. */
  confidence: number;
  /** Last explicit review timestamp, if any. */
  reviewedAt?: number | undefined;
  /** Reviewer identity, if recorded. */
  reviewedBy?: string | undefined;
  /** If stale/contradicted, why. */
  staleReason?: string | undefined;
  /** Creation timestamp (epoch ms). */
  createdAt: number;
  /** Last updated timestamp (epoch ms). */
  updatedAt: number;
  /**
   * Temporal validity window, start. Epoch ms. When set, the record is NOT
   * injected before this time (it is "pending"). Undefined means valid from
   * creation. Consulted at injection time; see memory-recall-contract.ts.
   */
  validFrom?: number | undefined;
  /**
   * Temporal validity window, end. Epoch ms. When set, the record stops being
   * injected at/after this time (it is "expired"), but it is NOT deleted, and
   * read/list surfaces label it expired rather than silently dropping it.
   * Undefined means no expiry.
   */
  validUntil?: number | undefined;
}

export type { MemoryTemporalStatus } from './memory-temporal.js';
export { memoryRecordTemporalStatus, isMemoryTemporallyActive } from './memory-temporal.js';

export interface MemoryLink {
  /** ID of the source record. */
  fromId: string;
  /** ID of the target record. */
  toId: string;
  /** Human-readable relationship label, e.g. "caused", "supersedes". */
  relation: string;
  /** Creation timestamp (epoch ms). */
  createdAt: number;
}

export interface MemorySearchFilter {
  scope?: MemoryScope | undefined;
  cls?: MemoryClass | undefined;
  tags?: string[] | undefined;
  /** Full-text substring match on summary and detail; the matches are ordered by the memory-search rerank. */
  query?: string | undefined;
  /** Use the sqlite-vec semantic index for query ranking when available. */
  semantic?: boolean | undefined;
  /** Return records created after this timestamp. */
  since?: number | undefined;
  /** Match a specific review state or a small set of states. */
  reviewState?: MemoryReviewState | MemoryReviewState[] | undefined;
  /** Minimum confidence threshold, 0-100. */
  minConfidence?: number | undefined;
  /** Restrict to records with at least one matching provenance kind. */
  provenanceKinds?: ProvenanceLinkKind[] | undefined;
  /** Convenience flag for review queue retrieval. */
  staleOnly?: boolean | undefined;
  limit?: number | undefined;
}

export interface MemoryAddOptions {
  scope?: MemoryScope | undefined;
  cls: MemoryClass;
  summary: string;
  detail?: string | undefined;
  tags?: string[] | undefined;
  provenance?: ProvenanceLink[] | undefined;
  /** Temporal validity window start (epoch ms). Undefined = valid from creation. */
  validFrom?: number | undefined;
  /** Temporal validity window end (epoch ms). Undefined = no expiry. */
  validUntil?: number | undefined;
  review?: {
    state?: MemoryReviewState | undefined;
    confidence?: number | undefined;
    reviewedAt?: number | undefined;
    reviewedBy?: string | undefined;
    staleReason?: string | undefined;
  };
}

export interface MemoryReviewPatch {
  state?: MemoryReviewState | undefined;
  confidence?: number | undefined;
  reviewedBy?: string | undefined;
  staleReason?: string | undefined;
}

export interface MemoryBundle {
  schemaVersion: 'v1';
  exportedAt: number;
  scope: MemoryScope | 'all';
  recordCount: number;
  linkCount: number;
  records: MemoryRecord[];
  links: MemoryLink[];
}

export interface MemoryImportResult {
  importedRecords: number;
  skippedRecords: number;
  importedLinks: number;
}

export interface MemorySemanticSearchResult {
  record: MemoryRecord;
  distance: number;
  similarity: number;
  /** The memory-search rerank's probability on 0 to 100 (the record's confidence when there is no query). */
  score: number;
}

export interface MemoryStoreOptions {
  embeddingRegistry: MemoryEmbeddingProviderRegistry;
  enableVectorIndex?: boolean | undefined;
  vectorDbPath?: string | undefined;
}

export interface MemoryDoctorReport {
  readonly vector: MemoryVectorStats;
  readonly embeddings: MemoryEmbeddingDoctorReport;
  readonly checkedAt: number;
}

export { MemoryRegistry } from './memory-registry.js';

// ── MemoryStore ───────────────────────────────────────────────────────────────

export class MemoryStore {
  private sqlite: SQLiteStore;
  private vectorIndex: SqliteVecMemoryIndex | null;
  private ready = false;
  private rebuildVectorIndexPromise: Promise<MemoryVectorStats> | null = null;
  private readonly embeddingRegistry: MemoryEmbeddingProviderRegistry;
  private mutationRevision = 0;
  private backendEpoch = 0;
  private readonly operations = new WeakMap<MemoryOperationOptions, { revision: number }>();

  constructor(dbPath: string | undefined, options: MemoryStoreOptions) {
    this.sqlite = new SQLiteStore(dbPath);
    this.embeddingRegistry = options.embeddingRegistry;
    this.vectorIndex = options.enableVectorIndex === false
      ? null
      : new SqliteVecMemoryIndex(
          options.vectorDbPath ?? resolveMemoryVectorDbPath(dbPath),
          undefined,
          this.embeddingRegistry,
        );
  }

  async init(): Promise<void> {
    if (this.ready) return;
    this.backendEpoch++;
    await this.sqlite.init(createSchema as Parameters<SQLiteStore['init']>[0], { storeName: 'memory store', schemaVersion: 1 });
    this.ready = true;
    await this.vectorIndex?.init();
    this.rebuildVectorIndex();
    logger.info('MemoryStore: initialized', { ready: true });
  }

  get isReady(): boolean {
    return this.ready;
  }

  /** The on-disk database path backing this store, or null when ephemeral. */
  get dbPath(): string | null {
    return this.sqlite.databasePath;
  }

  /** Backend incarnation only; ordinary writes do not change this binding. */
  captureOperationScope(): () => void {
    const sqlite = this.sqlite, vector = this.vectorIndex, ready = this.ready, epoch = this.backendEpoch;
    const provider = this.embeddingRegistry.getDefaultProviderOrNull();
    return () => {
      if (this.sqlite !== sqlite || this.vectorIndex !== vector || this.ready !== ready || this.backendEpoch !== epoch
        || this.embeddingRegistry.getDefaultProviderOrNull() !== provider) {
        throw new Error('Memory operation store changed');
      }
    };
  }

  private captureOperation(options?: MemoryOperationOptions): MemoryOperationOptions {
    if (options && this.operations.has(options)) return options;
    const lifecycle = captureMemoryOperation(options), scope = this.captureOperationScope();
    const state = { revision: this.mutationRevision };
    const operation = captureMemoryOperation({ signal: lifecycle.signal, assertCurrent: () => {
      assertMemoryOperationCurrent(lifecycle); scope();
      if (this.mutationRevision !== state.revision) throw new Error('Memory operation source changed');
    } });
    this.operations.set(operation, state);
    return operation;
  }

  /** Add a new memory record. Returns the created record. */
  async add(opts: MemoryAddOptions, options?: MemoryOperationOptions): Promise<MemoryRecord> {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    if (!this.ready) throw new Error('MemoryStore: not initialized');

    const now = Date.now();
    const id = `mem_${now.toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;

    const record: MemoryRecord = {
      id,
      scope: opts.scope ?? 'project',
      cls: opts.cls,
      summary: opts.summary,
      detail: opts.detail,
      tags: opts.tags ?? [],
      provenance: opts.provenance ?? [],
      reviewState: opts.review?.state ?? 'fresh',
      confidence: clampConfidence(opts.review?.confidence ?? 60),
      reviewedAt: opts.review?.reviewedAt,
      reviewedBy: opts.review?.reviewedBy,
      staleReason: opts.review?.staleReason,
      createdAt: now,
      updatedAt: now,
      validFrom: opts.validFrom,
      validUntil: opts.validUntil,
    };

    this.runMutation(
      `INSERT INTO memory_records
         (id, scope, cls, summary, detail, tags, provenance, review_state, confidence, reviewed_at, reviewed_by, stale_reason, created_at, updated_at, valid_from, valid_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.scope,
        record.cls,
        record.summary,
        record.detail ?? null,
        JSON.stringify(record.tags),
        JSON.stringify(record.provenance),
        record.reviewState,
        record.confidence,
        record.reviewedAt ?? null,
        record.reviewedBy ?? null,
        record.staleReason ?? null,
        record.createdAt,
        record.updatedAt,
        record.validFrom ?? null,
        record.validUntil ?? null,
      ],
      operation,
    );

    this.vectorIndex?.upsert(record, operation);
    this.persist(operation);
    assertMemoryOperationCurrent(operation);
    logger.info('MemoryStore: record added', { id, cls: opts.cls });
    return record;
  }

  /** Retrieve a single record by ID. */
  get(id: string, options?: MemoryOperationOptions): MemoryRecord | null {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    if (!this.ready) return null;

    const rows = this.sqlite.exec(
      `SELECT id, scope, cls, summary, detail, tags, provenance, review_state, confidence, reviewed_at, reviewed_by, stale_reason, created_at, updated_at, valid_from, valid_until
         FROM memory_records WHERE id = ? LIMIT 1`,
      [id],
    );

    if (!rows.length || !(rows[0]?.values.length)) return null;
    return rowToRecord(rows[0]?.columns ?? [], rows[0]?.values[0] ?? []);
  }

  /**
   * Search records with an optional filter. Retrieval is code (the SQL filter,
   * or the vector index when `semantic` is set); when the filter carries a
   * query, the `engine.state.memory-search` rerank orders what retrieval found.
   */
  async search(filter: MemorySearchFilter = {}, options?: MemoryOperationOptions): Promise<MemoryRecord[]> {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    if (!this.ready) return [];
    if (filter.semantic) {
      return (await awaitMemoryOperation(() => this.searchSemantic(filter, operation), operation)).map((entry) => entry.record);
    }
    const query = filter.query?.trim();
    if (!query) return this.retrieve(filter, operation);
    const ranked = await awaitMemoryOperation(() => rerankRetrieved(query, this.retrieve({ ...filter, limit: undefined }, operation), filter.limit, operation), operation);
    const records = ranked.map((entry) => entry.record);
    return filter.limit !== undefined ? records.slice(0, filter.limit) : records;
  }

  /**
   * Retrieval only, no relevance ranking: the filter's records in
   * compareByTrust order. Bulk reads (getAll, review queue, export) use it.
   */
  retrieve(filter: MemorySearchFilter = {}, options?: MemoryOperationOptions): MemoryRecord[] {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    if (!this.ready) return [];

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter.scope) {
      conditions.push('scope = ?');
      params.push(filter.scope);
    }

    if (filter.cls) {
      conditions.push('cls = ?');
      params.push(filter.cls);
    }

    if (filter.since) {
      conditions.push('created_at >= ?');
      params.push(filter.since);
    }

    if (filter.reviewState) {
      if (Array.isArray(filter.reviewState)) {
        conditions.push(`review_state IN (${filter.reviewState.map(() => '?').join(', ')})`);
        params.push(...filter.reviewState);
      } else {
        conditions.push('review_state = ?');
        params.push(filter.reviewState);
      }
    }

    if (filter.query) {
      const escaped = filter.query.replace(/%/g, '\\%').replace(/_/g, '\\_');
      conditions.push("(summary LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\')");
      params.push(`%${escaped}%`, `%${escaped}%`);
    }

    if (filter.tags?.length) {
      for (const tag of filter.tags) {
        const escapedTag = tag.replace(/%/g, '\\%').replace(/_/g, '\\_');
        conditions.push("tags LIKE ? ESCAPE '\\'");
        params.push(`%"${escapedTag}"%`);
      }
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.sqlite.exec(
      `SELECT id, scope, cls, summary, detail, tags, provenance, review_state, confidence, reviewed_at, reviewed_by, stale_reason, created_at, updated_at, valid_from, valid_until
         FROM memory_records ${where}
         ORDER BY updated_at DESC, created_at DESC`,
      params,
    );

    if (!rows.length) return [];

    let records = (rows[0]?.values ?? []).map(v => rowToRecord(rows[0]?.columns ?? [], v));

    if (filter.minConfidence !== undefined) {
      records = records.filter((record) => record.confidence >= filter.minConfidence!);
    }

    if (filter.provenanceKinds?.length) {
      const allowed = new Set(filter.provenanceKinds);
      records = records.filter((record) => record.provenance.some((link) => allowed.has(link.kind)));
    }

    if (filter.staleOnly) {
      records = records.filter((record) => isReviewFlagged(record));
    }

    records = records.sort(compareByTrust);

    if (filter.limit !== undefined) {
      records = records.slice(0, filter.limit);
    }

    return records;
  }

  /**
   * The vector index's candidates for the filter's query, in similarity order,
   * with the filter's post-SQL conditions applied. Retrieval only: nothing here
   * judges relevance. Empty when there is no query or the index returns
   * nothing. `score` is the similarity on a 0 to 100 scale.
   */
  semanticCandidates(filter: MemorySearchFilter = {}, options?: MemoryOperationOptions): MemorySemanticSearchResult[] {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    if (!this.ready) return [];
    const query = filter.query?.trim();
    if (!query) return [];
    const requestedLimit = Math.max(1, filter.limit ?? 10);
    const vectorFilter = {
      ...filter,
      limit: Math.max(requestedLimit * 8, 50),
    };
    const results: MemorySemanticSearchResult[] = [];
    for (const candidate of this.vectorIndex?.search(query, vectorFilter, operation) ?? []) {
      const record = this.get(candidate.id, operation);
      if (!record) continue;
      if (!recordMatchesPostSqlFilter(record, filter)) continue;
      results.push({ record, distance: candidate.distance, similarity: candidate.similarity, score: candidate.similarity * 100 });
    }
    return results.sort((a, b) => a.distance - b.distance || b.record.updatedAt - a.record.updatedAt);
  }

  /** Semantic search: the vector index builds the shortlist, the rerank orders it (memory-search-ranking.ts). */
  async searchSemantic(filter: MemorySearchFilter = {}, options?: MemoryOperationOptions): Promise<MemorySemanticSearchResult[]> {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    if (!this.ready) return [];
    return awaitMemoryOperation(() => rankSemanticSearch(this, filter, operation), operation);
  }

  /** Records to review: the least trusted records, ordered by the memory-review-priority reading. */
  async reviewQueue(limit = 10, scope?: MemoryScope, options?: MemoryOperationOptions): Promise<MemoryRecord[]> {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    const leastTrustedFirst = this.retrieve(scope ? { scope } : {}, operation).reverse();
    return awaitMemoryOperation(() => rankReviewQueue(leastTrustedFirst.slice(0, Math.max(limit * 4, 25)), limit, operation), operation);
  }

  /** Exports the records the filter selects; a query here filters, it does not rank. */
  exportBundle(filter: MemorySearchFilter = {}, options?: MemoryOperationOptions): MemoryBundle {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    const records = this.retrieve(filter, operation);
    const recordIds = new Set(records.map((record) => record.id));
    const links: MemoryLink[] = [];
    for (const record of records) {
      for (const link of this.linksFor(record.id, operation)) {
        if (!recordIds.has(link.fromId) || !recordIds.has(link.toId)) continue;
        const duplicate = links.some((existing) => (
          existing.fromId === link.fromId
          && existing.toId === link.toId
          && existing.relation === link.relation
        ));
        if (!duplicate) links.push(link);
      }
    }

    return {
      schemaVersion: 'v1',
      exportedAt: Date.now(),
      scope: filter.scope ?? 'all',
      recordCount: records.length,
      linkCount: links.length,
      records,
      links,
    };
  }

  async importBundle(bundle: MemoryBundle, options?: MemoryOperationOptions): Promise<MemoryImportResult> {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    if (!this.ready) throw new Error('MemoryStore: not initialized');

    let importedRecords = 0;
    let skippedRecords = 0;
    let importedLinks = 0;

    for (const record of bundle.records) {
      if (this.get(record.id)) {
        skippedRecords++;
        continue;
      }
      this.runMutation(
        `INSERT INTO memory_records
           (id, scope, cls, summary, detail, tags, provenance, review_state, confidence, reviewed_at, reviewed_by, stale_reason, created_at, updated_at, valid_from, valid_until)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          normalizeScope(record.scope),
          record.cls,
          record.summary,
          record.detail ?? null,
          JSON.stringify(record.tags),
          JSON.stringify(record.provenance),
          normalizeReviewState(record.reviewState),
          clampConfidence(record.confidence),
          record.reviewedAt ?? null,
          record.reviewedBy ?? null,
          record.staleReason ?? null,
          record.createdAt,
          record.updatedAt,
          record.validFrom ?? null,
          record.validUntil ?? null,
        ],
        operation,
      );
      importedRecords++;
      this.vectorIndex?.upsert(record, operation);
    }

    for (const link of bundle.links) {
      if (!this.get(link.fromId) || !this.get(link.toId)) continue;
      this.runMutation(
        `INSERT OR REPLACE INTO memory_links (from_id, to_id, relation, created_at)
         VALUES (?, ?, ?, ?)`,
        [link.fromId, link.toId, link.relation, link.createdAt],
        operation,
      );
      importedLinks++;
    }

    this.persist(operation);
    assertMemoryOperationCurrent(operation);
    logger.info('MemoryStore: bundle imported', { importedRecords, skippedRecords, importedLinks });
    return { importedRecords, skippedRecords, importedLinks };
  }

  /** Create a directed link between two records. */
  async link(fromId: string, toId: string, relation: string, options?: MemoryOperationOptions): Promise<MemoryLink | null> {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    if (!this.ready) return null;

    const from = this.get(fromId);
    const to = this.get(toId);

    if (!from) {
      logger.warn('MemoryStore: link source not found', { fromId });
      return null;
    }
    if (!to) {
      logger.warn('MemoryStore: link target not found', { toId });
      return null;
    }

    const now = Date.now();

    try {
      this.runMutation(
        `INSERT OR REPLACE INTO memory_links (from_id, to_id, relation, created_at)
         VALUES (?, ?, ?, ?)`,
        [fromId, toId, relation, now],
        operation,
      );
    } catch (err) {
      assertMemoryOperationCurrent(operation);
      logger.error('MemoryStore: link insert failed', {
        error: summarizeError(err),
      });
      return null;
    }

    this.persist(operation);
    return { fromId, toId, relation, createdAt: now };
  }

  /** Get all links where this record is either source or target. */
  linksFor(id: string, options?: MemoryOperationOptions): MemoryLink[] {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    if (!this.ready) return [];

    const rows = this.sqlite.exec(
      `SELECT from_id, to_id, relation, created_at
         FROM memory_links
         WHERE from_id = ? OR to_id = ?
         ORDER BY created_at DESC`,
      [id, id],
    );

    if (!rows.length) return [];

    return (rows[0]?.values ?? []).map(v => {
      const col = rows[0]?.columns ?? [];
      return {
        fromId:    String(v[col.indexOf('from_id')]),
        toId:      String(v[col.indexOf('to_id')]),
        relation:  String(v[col.indexOf('relation')]),
        createdAt: Number(v[col.indexOf('created_at')]),
      };
    });
  }

  /**
   * Update mutable fields of an existing record. For the temporal window,
   * `undefined` leaves the current bound unchanged while an explicit `null`
   * clears it (so the projection round-trip can both set and remove a window).
   */
  update(id: string, patch: {
    scope?: MemoryScope;
    summary?: string;
    detail?: string;
    tags?: string[];
    validFrom?: number | null;
    validUntil?: number | null;
  }, options?: MemoryOperationOptions): MemoryRecord | null {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    if (!this.ready) return null;

    const existing = this.get(id);
    if (!existing) {
      logger.warn('MemoryStore: update target not found', { id });
      return null;
    }

    const now = Date.now();
    const newScope   = patch.scope   ?? existing.scope;
    const newSummary = patch.summary ?? existing.summary;
    const newDetail  = patch.detail  !== undefined ? patch.detail : existing.detail;
    const newTags    = patch.tags    ?? existing.tags;
    const newValidFrom  = patch.validFrom  === undefined ? existing.validFrom  : (patch.validFrom  ?? undefined);
    const newValidUntil = patch.validUntil === undefined ? existing.validUntil : (patch.validUntil ?? undefined);

    this.runMutation(
      `UPDATE memory_records
         SET scope = ?, summary = ?, detail = ?, tags = ?, valid_from = ?, valid_until = ?, updated_at = ?
         WHERE id = ?`,
      [newScope, newSummary, newDetail ?? null, JSON.stringify(newTags), newValidFrom ?? null, newValidUntil ?? null, now, id],
      operation,
    );

    const updated = { ...existing, scope: newScope, summary: newSummary, detail: newDetail, tags: newTags, validFrom: newValidFrom, validUntil: newValidUntil, updatedAt: now };
    this.vectorIndex?.upsert(updated, operation);
    this.persist(operation);
    assertMemoryOperationCurrent(operation);
    logger.info('MemoryStore: record updated', { id });
    return updated;
  }

  review(id: string, patch: MemoryReviewPatch, options?: MemoryOperationOptions): MemoryRecord | null {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    if (!this.ready) return null;

    const existing = this.get(id);
    if (!existing) {
      logger.warn('MemoryStore: review target not found', { id });
      return null;
    }

    const now = Date.now();
    const reviewState = patch.state ?? existing.reviewState;
    const confidence = clampConfidence(patch.confidence ?? existing.confidence);
    const reviewedAt = now;
    const reviewedBy = patch.reviewedBy ?? existing.reviewedBy;
    const staleReason = reviewState === 'stale' || reviewState === 'contradicted'
      ? (patch.staleReason ?? existing.staleReason ?? 'marked by operator')
      : undefined;

    this.runMutation(
      `UPDATE memory_records
         SET review_state = ?, confidence = ?, reviewed_at = ?, reviewed_by = ?, stale_reason = ?, updated_at = ?
         WHERE id = ?`,
      [
        reviewState,
        confidence,
        reviewedAt,
        reviewedBy ?? null,
        staleReason ?? null,
        now,
        id,
      ],
      operation,
    );

    const reviewed = { ...existing, reviewState, confidence, reviewedAt, reviewedBy, staleReason, updatedAt: now };
    this.vectorIndex?.upsert(reviewed, operation);
    this.persist(operation);
    assertMemoryOperationCurrent(operation);
    logger.info('MemoryStore: record reviewed', { id, reviewState, confidence });
    return reviewed;
  }

  /** Delete a record and all its links. */
  delete(id: string, options?: MemoryOperationOptions): boolean {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    if (!this.ready) return false;

    const existing = this.get(id);
    if (!existing) return false;

    // Delete links explicitly as well as via FK cascade; sql.js may load older
    // stores with FK enforcement disabled for a connection.
    this.runMutation('DELETE FROM memory_links WHERE from_id = ? OR to_id = ?', [id, id], operation);
    this.runMutation('DELETE FROM memory_records WHERE id = ?', [id], operation);
    this.vectorIndex?.delete(id, operation);
    this.persist(operation);
    assertMemoryOperationCurrent(operation);
    logger.info('MemoryStore: record deleted', { id });
    return true;
  }

  rebuildVectorIndex(): MemoryVectorStats {
    if (!this.ready) return this.vectorStats();
    const rows = this.sqlite.exec(
      `SELECT id, scope, cls, summary, detail, tags, provenance, review_state, confidence, reviewed_at, reviewed_by, stale_reason, created_at, updated_at, valid_from, valid_until
         FROM memory_records
         ORDER BY updated_at DESC, created_at DESC`,
    );
    const records = rows.length ? (rows[0]?.values ?? []).map((value) => rowToRecord(rows[0]?.columns ?? [], value)) : [];
    this.vectorIndex?.sync(records);
    return this.vectorStats();
  }

  async rebuildVectorIndexAsync(): Promise<MemoryVectorStats> {
    if (!this.ready) return this.vectorStats();
    if (!this.rebuildVectorIndexPromise) {
      this.rebuildVectorIndexPromise = (async () => {
        try {
          const rows = this.sqlite.exec(
            `SELECT id, scope, cls, summary, detail, tags, provenance, review_state, confidence, reviewed_at, reviewed_by, stale_reason, created_at, updated_at, valid_from, valid_until
               FROM memory_records
               ORDER BY updated_at DESC, created_at DESC`,
          );
          const records = rows.length ? (rows[0]?.values ?? []).map((value) => rowToRecord(rows[0]?.columns ?? [], value)) : [];
          if (this.vectorIndex?.syncAsync) {
            await this.vectorIndex.syncAsync(records, { force: true });
          } else {
            this.vectorIndex?.sync(records);
          }
          return this.vectorStats();
        } finally {
          this.rebuildVectorIndexPromise = null;
        }
      })();
    }
    return this.rebuildVectorIndexPromise;
  }

  vectorStats(options?: MemoryOperationOptions): MemoryVectorStats {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    return this.vectorIndex?.stats() ?? {
      backend: 'sqlite-vec',
      enabled: false,
      available: false,
      path: '',
      dimensions: 0,
      indexedRecords: 0,
      embeddingProviderId: HASHED_MEMORY_EMBEDDING_PROVIDER.id,
      embeddingProviderLabel: HASHED_MEMORY_EMBEDDING_PROVIDER.label,
      error: 'memory vector index disabled',
    };
  }

  async doctor(options?: MemoryOperationOptions): Promise<MemoryDoctorReport> {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    return {
      vector: this.vectorStats(),
      embeddings: await awaitMemoryOperation(() => this.embeddingRegistry.doctor(), operation),
      checkedAt: Date.now(),
    };
  }

  async save(options?: MemoryOperationOptions): Promise<boolean> {
    const operation = this.captureOperation(options);
    assertMemoryOperationCurrent(operation);
    return awaitMemoryOperation(() => this.sqlite.save(), operation);
  }

  close(): void {
    this.backendEpoch++;
    this.sqlite.close();
    this.vectorIndex?.close();
    this.ready = false;
  }

  /**
   * Re-root the store to a new SQLite database path.
   *
   * Closes the existing SQLite handle and vector index, then re-opens both at
   * the new path. The caller is responsible for ensuring no writes are in-flight
   * when this is called (WorkspaceSwapManager enforces this via the busy-session
   * guard).
   *
   * @throws if the new SQLite store or vector index cannot be opened.
   */
  async reroot(newDbPath: string): Promise<void> {
    this.backendEpoch++;
    this.sqlite.close();
    this.vectorIndex?.close();
    this.ready = false;
    this.rebuildVectorIndexPromise = null;
    this.sqlite = new SQLiteStore(newDbPath);
    this.vectorIndex = new SqliteVecMemoryIndex(
      resolveMemoryVectorDbPath(newDbPath),
      undefined,
      this.embeddingRegistry,
    );
    await this.init();
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private runMutation(sql: Parameters<SQLiteStore['run']>[0], params: Parameters<SQLiteStore['run']>[1], operation: MemoryOperationOptions): void {
    assertMemoryOperationCurrent(operation);
    const state = this.operations.get(operation);
    if (!state) throw new Error('Memory operation is not owned by this store');
    const revision = ++this.mutationRevision;
    try { this.sqlite.run(sql, params); }
    finally {
      if (this.mutationRevision !== revision) throw new Error('Memory operation source changed');
      state.revision = revision;
      assertMemoryOperationCurrent(operation);
    }
  }

  private persist(operation: MemoryOperationOptions): void {
    assertMemoryOperationCurrent(operation);
    void this.save(operation).catch((err) => {
      try { assertMemoryOperationCurrent(operation); } catch { return; }
      logger.warn('MemoryStore: autosave failed', { error: summarizeError(err) });
    });
  }
}
