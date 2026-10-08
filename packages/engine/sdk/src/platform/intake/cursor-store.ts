// ---------------------------------------------------------------------------
// Persistent cursor + item store for the inbound feed.
//
// Backed by HandlerSqliteStore (sql.js WASM) at
//   {wd}/.goodvibes/tui/operator/inbox.sqlite
//
// Three tables:
//   items(id PK, provider, kind, fromDigest, subjectPreview, bodyPreview,
//         routeId, receivedAt INT, unread INT)
//   cursors(provider PK, nextSince INT)
//   imap_checkpoints(provider PK, checkpoint TEXT)
//
// Dedup is by items.id (upsert). nextSince advances monotonically per provider
// = max(receivedAt) ever seen. Triage metadata is NOT persisted here: it is
// applied downstream at the triage overlay layer (triage/integration.ts) over a
// separate store, so this feed store carries only the raw inbound fields.
//
// RETENTION. The items table is bounded by BOTH an age TTL and a count cap, and
// the sweep runs at init(), the recovery point, right after the database file
// is opened, and then on a timer for the life of the store, so a daemon that
// stays up for weeks keeps reclaiming. `pruneOlderThan` used to exist with no
// production caller at all, which meant the table grew without bound in
// practice. Reclaimed counts are handed to the `onSweep` hook (counts only,
// message previews and sender ids never reach a log line).
//
// Cursors are deliberately NOT reaped. Timestamp watermarks are monotonic;
// IMAP checkpoints retain their explicit generation and history baseline.
// Only an explicit UIDVALIDITY reset can replace an IMAP generation.
//
// Idempotence/concurrency: a sweep re-run immediately reclaims nothing (the
// DELETEs are set-based over the current contents). Two processes opening the
// same file each hold their own sql.js snapshot and `save()` writes the whole
// file via temp+rename. HandlerSqliteStore orders saves within one process,
// but separate processes still have last-writer-wins snapshots. This store is
// single-owner; it does not claim cross-process mutation safety.
// ---------------------------------------------------------------------------

import { HandlerSqliteStore, type HandlerSqliteTransaction } from '../state/daemon-handler-sqlite-store.js';
import type { ImapUidCheckpoint, ImapUidCheckpointAdvance, InboundChannelItem } from './provider-adapter.js';
import { captureImapAdvance, captureImapCheckpoint, captureImapItems, sameImapCheckpoint } from './imap-checkpoint.js';

/**
 * Age TTL for feed items: rows whose receivedAt is older than this are dropped
 * on every sweep. Long enough that "what did that person say last month" still
 * works, short enough that the table cannot grow indefinitely.
 */
export const INBOX_ITEM_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Count cap for feed items: the newest this many rows survive a sweep, older
 * ones are dropped. Guards the case the TTL cannot, a very chatty month.
 */
export const INBOX_ITEM_CAP = 5_000;

/**
 * Cadence of the background retention sweep. The first sweep happens at init();
 * this timer is what keeps it from being a startup-only reap.
 */
export const INBOX_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

const DEFAULT_STORE_FILE_NAME = 'inbox.sqlite';

/** Result of one retention sweep. Counts only, never item content. */
export interface InboxSweepSummary {
  /** Unix ms of the sweep. */
  readonly at: number;
  /** Rows removed by the age TTL. */
  readonly expired: number;
  /** Rows removed by the count cap. */
  readonly capped: number;
  /** Rows left in the items table afterwards. */
  readonly remaining: number;
}

export interface InboxCursorStoreOptions {
  /** Override the age TTL (tests / embedders). Defaults to INBOX_ITEM_TTL_MS. */
  readonly itemTtlMs?: number;
  /** Override the count cap (tests / embedders). Defaults to INBOX_ITEM_CAP. */
  readonly itemCap?: number;
  /** Sweep cadence; 0 or less disables the timer (the init sweep still runs). */
  readonly sweepIntervalMs?: number;
  /** Called after a sweep that reclaimed at least one row. Counts only. */
  readonly onSweep?: (summary: InboxSweepSummary) => void;
  /** Called when a sweep failed, so retention problems are visible rather than swallowed. */
  readonly onSweepError?: (message: string) => void;
  /** Clock seam (tests). Defaults to Date.now. */
  readonly now?: () => number;
  /** Timer seams (tests). Default to the globals. */
  readonly setIntervalImpl?: typeof setInterval;
  readonly clearIntervalImpl?: typeof clearInterval;
}

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS imap_checkpoints (
     provider TEXT PRIMARY KEY, checkpoint TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS items (
     id TEXT PRIMARY KEY,
     provider TEXT NOT NULL,
     kind TEXT NOT NULL,
     fromDigest TEXT NOT NULL,
     subjectPreview TEXT NOT NULL,
     bodyPreview TEXT NOT NULL,
     routeId TEXT,
     receivedAt INTEGER NOT NULL,
     unread INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_items_provider_received
     ON items(provider, receivedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_items_received
     ON items(receivedAt)`,
  `CREATE TABLE IF NOT EXISTS cursors (
     provider TEXT PRIMARY KEY,
     nextSince INTEGER NOT NULL
   )`,
];

interface ItemRow {
  id: string;
  provider: string;
  kind: string;
  fromDigest: string;
  subjectPreview: string;
  bodyPreview: string;
  routeId: string | null;
  receivedAt: number;
  unread: number;
}

/**
 * A position in the feed's total order (receivedAt DESC, id ASC). Paging is
 * keyset rather than OFFSET because the feed is written to while it is being
 * read: an OFFSET page re-anchors on every insert, so a caller walking pages
 * while a poll lands would see items twice and skip others. A key resumes from
 * a row, not from a count, so an insert above the cursor cannot shift it.
 */
export interface InboxPosition {
  readonly receivedAt: number;
  readonly id: string;
}

export interface InboxQuery {
  providers?: readonly string[];
  since?: number;
  /** Resume strictly AFTER this position in the feed order. */
  after?: InboxPosition;
  /** Max items returned across the whole query. */
  limit: number;
}

export class InboxCursorStore {
  private readonly store: HandlerSqliteStore;
  private revision = 0;
  private persistedRevision = 0;
  private initialized = false;
  private initializing: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private readonly flushing = new Set<Promise<void>>();
  private readonly sweeping = new Set<Promise<void>>();
  private readonly itemTtlMs: number;
  private readonly itemCap: number;
  private readonly sweepIntervalMs: number;
  private readonly onSweep: ((summary: InboxSweepSummary) => void) | undefined;
  private readonly onSweepError: ((message: string) => void) | undefined;
  private readonly now: () => number;
  private readonly setIntervalImpl: typeof setInterval;
  private readonly clearIntervalImpl: typeof clearInterval;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Set by close(). `init()` is async and arms the retention timer only after
   * two awaits, so a surface that is torn down while its bootstrap is still in
   * flight would otherwise arm a timer AFTER the only thing that could clear it
   * had already run. That is not hypothetical: registerInboxMethods() kicks
   * init() off without awaiting it, so any shutdown inside the first tick of a
   * daemon's life hits exactly this window.
   */
  private closed = false;

  constructor(
    workingDirectory: string,
    fileName: string = DEFAULT_STORE_FILE_NAME,
    options: InboxCursorStoreOptions = {},
  ) {
    this.store = new HandlerSqliteStore({
      workingDirectory,
      fileName: fileName || DEFAULT_STORE_FILE_NAME,
      schema: SCHEMA,
    });
    this.itemTtlMs = options.itemTtlMs ?? INBOX_ITEM_TTL_MS;
    this.itemCap = options.itemCap ?? INBOX_ITEM_CAP;
    this.sweepIntervalMs = options.sweepIntervalMs ?? INBOX_SWEEP_INTERVAL_MS;
    this.onSweep = options.onSweep;
    this.onSweepError = options.onSweepError;
    this.now = options.now ?? Date.now;
    this.setIntervalImpl = options.setIntervalImpl ?? setInterval;
    this.clearIntervalImpl = options.clearIntervalImpl ?? clearInterval;
  }

  get dbPath(): string {
    return this.store.dbPath;
  }

  /**
   * Open the database, then immediately reap: recovery is exactly when stale
   * rows from previous runs must go. The periodic timer starts afterwards so
   * retention is not a startup-only event.
   */
  init(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('InboxCursorStore is closed.'));
    if (this.initialized) return Promise.resolve();
    if (this.initializing) return this.initializing;
    const pending = (async () => {
      await this.store.init();
      if (this.closed) return;
      await this.runSweep();
      if (this.closed) return;
      this.initialized = true;
      this.startSweepTimer();
    })();
    this.initializing = pending;
    void pending.then(
      () => { if (this.initializing === pending) this.initializing = null; },
      () => { if (this.initializing === pending) this.initializing = null; },
    );
    return pending;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('InboxCursorStore is closed.');
  }

  /**
   * One retention pass: age TTL first, then the count cap over what is left.
   * Returns counts only. Running it twice in a row reclaims nothing the second
   * time, the pass is a function of the table's current contents.
   */
  sweepRetention(): InboxSweepSummary {
    this.assertOpen();
    const at = this.now();
    const expired = this.pruneOlderThan(at - this.itemTtlMs);
    const capped = this.enforceItemCap();
    return { at, expired, capped, remaining: this.countItems() };
  }

  /** Sweep, persist and disclose counts. Observer failures cannot strand a timer. */
  private runSweep(): Promise<void> {
    if (this.closed) return Promise.resolve();
    const pending = (async () => {
      try {
        const summary = this.sweepRetention();
        if (summary.expired + summary.capped === 0) return;
        await this.flushSnapshot();
        this.onSweep?.(summary);
      } catch (error) {
        try { this.onSweepError?.(error instanceof Error ? error.message : String(error)); }
        catch { /* Observer callbacks cannot create unhandled timer rejections. */ }
      }
    })();
    this.sweeping.add(pending);
    void pending.then(() => { this.sweeping.delete(pending); });
    return pending;
  }

  private startSweepTimer(): void {
    if (this.closed || this.sweepTimer !== null || this.sweepIntervalMs <= 0) return;
    const handle = this.setIntervalImpl(() => {
      void this.runSweep();
    }, this.sweepIntervalMs);
    // Retention must never be the reason the process stays alive (Bun/Node unref).
    (handle as unknown as { unref?: () => void }).unref?.();
    this.sweepTimer = handle;
  }

  private stopSweepTimer(): void {
    if (this.sweepTimer === null) return;
    this.clearIntervalImpl(this.sweepTimer);
    this.sweepTimer = null;
  }

  /**
   * Count cap: keep the newest `itemCap` rows (receivedAt DESC, id ASC, the
   * same order listItems() uses), delete the rest. Returns rows removed.
   */
  private enforceItemCap(): number {
    const before = this.countItems();
    if (before <= this.itemCap) return 0;
    this.store.run(
      `DELETE FROM items WHERE id NOT IN (
         SELECT id FROM items ORDER BY receivedAt DESC, id ASC LIMIT ?
       )`,
      [this.itemCap],
    );
    const removed = before - this.countItems();
    if (removed > 0) this.revision += 1;
    return removed;
  }

  /**
   * Insert/refresh items, deduping by id. On conflict the mutable feed fields
   * (unread, previews, routeId, receivedAt) are updated in place.
   * Returns the number of NEW (previously unseen) items.
   */
  upsertItems(items: readonly InboundChannelItem[]): number {
    this.assertOpen();
    if (items.length === 0) return 0;
    let inserted = 0;
    this.store.transaction(() => { inserted = upsertRows(this.store, items); });
    this.revision += 1;
    return inserted;
  }

  /** Account scoping belongs to the owning store path, never to mailbox data. */
  getImapCheckpoint(provider: string): ImapUidCheckpoint | null {
    this.assertOpen();
    return readImapCheckpoint(this.store, provider);
  }

  /**
   * Publish redacted rows and their UID progress as one durable image. The
   * synchronous fence is rechecked immediately before atomic rename. Failed
   * transactions never publish an in-memory checkpoint or feed row.
   */
  commitImapPoll(provider: string, inputItems: readonly InboundChannelItem[], input: ImapUidCheckpointAdvance,
    assertCurrent: () => void,
  ): Promise<number> {
    this.assertOpen();
    const items = captureImapItems(provider, inputItems);
    const advance = captureImapAdvance(input, items);
    const pending = this.store.persistTransaction((transaction) => {
      if (!sameImapCheckpoint(readImapCheckpoint(transaction, provider), advance.previous)) {
        throw new Error('IMAP inbox checkpoint changed before commit');
      }
      if (advance.transition === 'reset') transaction.run('DELETE FROM items WHERE provider = ?', [provider]);
      for (const item of items) {
        const existing = transaction.get<{ provider: string }>('SELECT provider FROM items WHERE id = ?', [item.id]);
        if (existing && existing.provider !== provider) throw new Error('IMAP inbox item id belongs to another provider');
      }
      const inserted = upsertRows(transaction, items);
      transaction.run(`INSERT INTO imap_checkpoints (provider, checkpoint) VALUES (?, ?)
        ON CONFLICT(provider) DO UPDATE SET checkpoint = excluded.checkpoint`, [provider, JSON.stringify(advance.next)]);
      return inserted;
    }, () => { this.assertOpen(); const result = assertCurrent(); this.assertOpen(); return result; });
    // Do not mark ordinary revisions clean: a separate flush still owns any
    // mutation accepted after this transaction's synchronous publication.
    const tracked = pending.then(() => {});
    this.flushing.add(tracked);
    void tracked.then(() => this.flushing.delete(tracked), () => this.flushing.delete(tracked));
    return pending;
  }

  /**
   * Advance a provider's cursor monotonically. The stored value is always the
   * max of the current value and the supplied candidate.
   */
  advanceCursor(provider: string, candidate: number): void {
    this.assertOpen();
    if (!Number.isFinite(candidate)) return;
    const current = this.getCursor(provider);
    const next = Math.max(current, Math.floor(candidate));
    if (next === current && current !== 0) return;
    this.store.run(
      `INSERT INTO cursors (provider, nextSince) VALUES (?, ?)
       ON CONFLICT(provider) DO UPDATE SET
         nextSince = MAX(cursors.nextSince, excluded.nextSince)`,
      [provider, next],
    );
    this.revision += 1;
  }

  /** Current cursor for a provider (0 when unset). */
  getCursor(provider: string): number {
    this.assertOpen();
    const row = this.store.get<{ nextSince: number }>(
      'SELECT nextSince FROM cursors WHERE provider = ?',
      [provider],
    );
    return row ? Number(row.nextSince) : 0;
  }

  /**
   * Read items for the feed, filtered by provider set + since, newest first,
   * capped at limit. Maps SQLite rows back to the internal item shape.
   */
  listItems(query: InboxQuery): InboundChannelItem[] {
    this.assertOpen();
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (query.providers && query.providers.length > 0) {
      const placeholders = query.providers.map(() => '?').join(', ');
      clauses.push(`provider IN (${placeholders})`);
      params.push(...query.providers);
    }
    if (typeof query.since === 'number' && Number.isFinite(query.since)) {
      clauses.push('receivedAt > ?');
      params.push(Math.floor(query.since));
    }
    if (query.after && Number.isFinite(query.after.receivedAt)) {
      // Strictly after the cursor row in (receivedAt DESC, id ASC) order: an
      // older timestamp, or the same timestamp with a higher id. Both halves
      // are needed, several items can share a receivedAt, and comparing on
      // the timestamp alone would drop every one of its ties.
      clauses.push('(receivedAt < ? OR (receivedAt = ? AND id > ?))');
      const at = Math.floor(query.after.receivedAt);
      params.push(at, at, query.after.id);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.max(0, Math.floor(query.limit));
    params.push(limit);
    const rows = this.store.all<ItemRow>(
      `SELECT id, provider, kind, fromDigest, subjectPreview, bodyPreview,
              routeId, receivedAt, unread
         FROM items ${where}
         ORDER BY receivedAt DESC, id ASC
         LIMIT ?`,
      params,
    );
    return rows.map(rowToItem);
  }

  /** Highest receivedAt across the (optionally provider-filtered) feed, or 0. */
  maxReceivedAt(providers?: readonly string[]): number {
    this.assertOpen();
    const { where, params } = filterClause(providers);
    const row = this.store.get<{ maxReceived: number | null }>(
      `SELECT MAX(receivedAt) AS maxReceived FROM items ${where}`,
      params,
    );
    return row && row.maxReceived != null ? Number(row.maxReceived) : 0;
  }

  /**
   * Total count of items matching the (optional) provider set and `since`
   * watermark.
   *
   * `since` is part of the filter and not an afterthought: the total is what a
   * caller compares its page against to know whether it has seen everything, so
   * a total counting rows the same call's `since` excluded would tell it there
   * is more when there is not.
   */
  countItems(providers?: readonly string[], since?: number): number {
    this.assertOpen();
    const { where, params } = filterClause(providers, since);
    const row = this.store.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM items ${where}`,
      params,
    );
    return row ? Number(row.n) : 0;
  }

  /**
   * Per-provider item counts over the same filter, in ONE query.
   *
   * The aggregator reports a stored count for every provider on every call, and
   * doing that with one countItems() per provider would be a query per provider
   * per request. Providers absent from the result simply have no rows.
   */
  countItemsByProvider(providers?: readonly string[], since?: number): Map<string, number> {
    this.assertOpen();
    const { where, params } = filterClause(providers, since);
    const rows = this.store.all<{ provider: string; n: number }>(
      `SELECT provider, COUNT(*) AS n FROM items ${where} GROUP BY provider`,
      params,
    );
    const out = new Map<string, number>();
    for (const row of rows) out.set(row.provider, Number(row.n));
    return out;
  }

  /**
   * Retention: delete items strictly older than `cutoff` (Unix ms), optionally
   * scoped to a provider set. Returns the number of rows removed. Cursors are
   * left untouched so already-consumed watermarks never regress. A non-finite
   * cutoff is a no-op (prevents an accidental whole-table wipe).
   */
  pruneOlderThan(cutoff: number, providers?: readonly string[]): number {
    this.assertOpen();
    if (!Number.isFinite(cutoff)) return 0;
    const clauses = ['receivedAt < ?'];
    const params: (string | number)[] = [Math.floor(cutoff)];
    if (providers && providers.length > 0) {
      const placeholders = providers.map(() => '?').join(', ');
      clauses.push(`provider IN (${placeholders})`);
      params.push(...providers);
    }
    const before = this.countItems(providers);
    this.store.run(`DELETE FROM items WHERE ${clauses.join(' AND ')}`, params);
    const removed = before - this.countItems(providers);
    if (removed > 0) this.revision += 1;
    return removed;
  }

  /** Persist the current revision; a newer mutation cannot be marked saved by it. */
  flush(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('InboxCursorStore is closed.'));
    return this.flushSnapshot();
  }

  private flushSnapshot(): Promise<void> {
    if (this.revision === this.persistedRevision) return Promise.resolve();
    const revision = this.revision;
    const pending = this.store.save().then(() => {
      this.persistedRevision = Math.max(this.persistedRevision, revision);
    });
    this.flushing.add(pending);
    void pending.then(
      () => { this.flushing.delete(pending); },
      () => { this.flushing.delete(pending); },
    );
    return pending;
  }

  /** Stop admission/timers, await owned I/O, flush the last revision and close. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = Promise.resolve().then(async () => {
      let timerError: unknown;
      try { this.stopSweepTimer(); } catch (error) { timerError = error; }
      try {
        // A late init must finish before we close its handle. It is prevented
        // from starting a sweep/timer once closed, but its actual I/O is owned.
        await Promise.allSettled([this.initializing, ...this.sweeping, ...this.flushing]);
        await this.flushSnapshot();
        if (timerError !== undefined) throw timerError;
      } finally { this.store.close(); }
    });
    return this.closing;
  }
}

/** Shared WHERE builder for the provider-set + since filter the reads share. */
function filterClause(
  providers?: readonly string[],
  since?: number,
): { where: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (providers && providers.length > 0) {
    clauses.push(`provider IN (${providers.map(() => '?').join(', ')})`);
    params.push(...providers);
  }
  if (typeof since === 'number' && Number.isFinite(since)) {
    clauses.push('receivedAt > ?');
    params.push(Math.floor(since));
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function rowToItem(row: ItemRow): InboundChannelItem {
  const item: InboundChannelItem = {
    id: row.id,
    provider: row.provider,
    kind: normalizeKind(row.kind),
    fromDigest: row.fromDigest,
    subjectPreview: row.subjectPreview,
    bodyPreview: row.bodyPreview,
    receivedAt: Number(row.receivedAt),
    unread: Number(row.unread) !== 0,
  };
  if (row.routeId != null) item.routeId = row.routeId;
  return item;
}

function normalizeKind(value: string): InboundChannelItem['kind'] {
  return value === 'dm' || value === 'thread' || value === 'mention' || value === 'reaction'
    ? value
    : 'dm';
}

function readImapCheckpoint(store: HandlerSqliteTransaction, provider: string): ImapUidCheckpoint | null {
  const row = store.get<{ checkpoint: string }>('SELECT checkpoint FROM imap_checkpoints WHERE provider = ?', [provider]);
  return row ? captureImapCheckpoint(JSON.parse(row.checkpoint) as ImapUidCheckpoint) : null;
}

function upsertRows(store: HandlerSqliteTransaction, items: readonly InboundChannelItem[]): number {
  if (items.length === 0) return 0;
  const batchIds = [...new Set(items.map((item) => item.id))];
  const existing = new Set(store.all<{ id: string }>(
    `SELECT id FROM items WHERE id IN (${batchIds.map(() => '?').join(', ')})`, batchIds,
  ).map((row) => row.id));
  let inserted = 0;
  for (const item of items) {
    if (!existing.has(item.id)) { inserted += 1; existing.add(item.id); }
    store.run(`INSERT INTO items
      (id, provider, kind, fromDigest, subjectPreview, bodyPreview, routeId, receivedAt, unread)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, kind = excluded.kind,
      fromDigest = excluded.fromDigest, subjectPreview = excluded.subjectPreview,
      bodyPreview = excluded.bodyPreview, routeId = COALESCE(excluded.routeId, items.routeId),
      receivedAt = excluded.receivedAt, unread = excluded.unread`,
    [item.id, item.provider, item.kind, item.fromDigest, item.subjectPreview, item.bodyPreview,
      item.routeId ?? null, item.receivedAt, item.unread ? 1 : 0]);
  }
  return inserted;
}
