/**
 * LocalLedgerExporter, append-only JSON lines span exporter.
 *
 * Writes completed spans to a rotating JSON Lines (.jsonl) file.
 * Export failures are isolated from the runtime and reported through
 * structured logger entries.
 *
 * Also provides typed event ledger recording for deterministic replay.
 * Call `recordEvent()` to append a `LedgerEntry` to the ledger file. When a
 * `captureRunSnapshot` source is configured, the first entry recorded for a
 * run id also stores the runtime state snapshot taken at that moment in a
 * sibling `<ledgerFilePath>.snapshots.jsonl` file, which `readRunSnapshot()`
 * returns as the replay baseline for that run.
 */
import { appendFileSync, statSync, renameSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { logger } from '../../../utils/logger.js';
import type { ReadableSpan, SpanExporter } from '../types.js';
import type { RuntimeStateSnapshot } from '../../diagnostics/types.js';
import { summarizeError } from '../../../utils/error-display.js';
import {
  type AtRestPolicy,
  DEFAULT_AT_REST_POLICY,
  AtRestLineWriter,
  enforceFileRetention,
} from '../../at-rest-persistence.js';

/** The decision sites the ledger's credential span readings are logged under. */
const SPAN_FILE_CREDENTIAL_SITE = 'runtime.telemetry.local-ledger.span-credential-span';
const LEDGER_FILE_CREDENTIAL_SITE = 'runtime.telemetry.local-ledger.event-credential-span';

/** Configuration for LocalLedgerExporter. */
export interface LocalLedgerConfig {
  /**
   * Absolute path to the output file (e.g. `/home/user/.goodvibes/telemetry/spans.jsonl`).
   */
  readonly filePath: string;
  /**
   * Maximum file size in bytes before rotation.
   * When the file exceeds this size, it is renamed to `<filePath>.1` and a
   * fresh file is started. Defaults to 10 MB.
   */
  readonly maxFileSizeBytes?: number | undefined;
  /**
   * Optional path for the typed event ledger file.
   * When provided, `recordEvent()` appends `LedgerEntry` lines here.
   * Defaults to `<filePath>.ledger.jsonl`.
   */
  readonly ledgerFilePath?: string | undefined;
  /**
   * At-rest redaction + retention policy for the span and ledger files. When
   * omitted, the honest default applies (redaction ON; retention generous but
   * bounded). Wire from config via resolveAtRestPolicy(configManager.get).
   */
  readonly atRestPolicy?: AtRestPolicy | undefined;
  /**
   * Source of the runtime state snapshot stored when a run starts, usually a
   * diagnostics provider's `getStateSnapshot`. It is called once per run id,
   * on the first `recordEvent()` for that run. When omitted, no snapshots are
   * stored and replay of those runs starts from an empty baseline.
   */
  readonly captureRunSnapshot?: (() => RuntimeStateSnapshot) | undefined;
}

/** One line of the run snapshot file. */
interface RunSnapshotRecord {
  readonly runId: string;
  readonly snapshot: RuntimeStateSnapshot;
}

function isRunSnapshotRecord(value: unknown): value is RunSnapshotRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { runId?: unknown; snapshot?: unknown };
  if (typeof record.runId !== 'string' || typeof record.snapshot !== 'object' || record.snapshot === null) return false;
  const snapshot = record.snapshot as { capturedAt?: unknown; domains?: unknown };
  return typeof snapshot.capturedAt === 'number' && Array.isArray(snapshot.domains);
}

/**
 * A single typed event entry in the replay ledger.
 *
 * Each entry captures the run identifier, a monotonically increasing
 * revision counter, the event name, payload, and wall-clock timestamp.
 * The revision counter is used by the deterministic replay engine for
 * seek and stepwise playback.
 */
export interface LedgerEntry {
  /** Run identifier, groups entries belonging to the same recorded run. */
  readonly runId: string;
  /** Monotonically increasing revision counter within the run (starts at 1). */
  readonly rev: number;
  /** Event name recorded in the typed runtime ledger. */
  readonly eventName: string;
  /** Full event payload, JSON-serialisable. */
  readonly payload: unknown;
  /** Wall-clock timestamp (epoch ms) when the event was recorded. */
  readonly ts: number;
}

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * LocalLedgerExporter, writes spans as JSON lines to a rotating file.
 *
 * Usage:
 * ```ts
 * const exporter = new LocalLedgerExporter({
 *   filePath: '/home/user/.goodvibes/telemetry/spans.jsonl',
 *   maxFileSizeBytes: 5 * 1024 * 1024,
 * });
 * ```
 */
export class LocalLedgerExporter implements SpanExporter {
  readonly name = 'local-ledger';
  private readonly filePath: string;
  private readonly maxFileSizeBytes: number;
  private readonly ledgerFilePath: string;
  private readonly snapshotFilePath: string;
  private readonly atRestPolicy: AtRestPolicy;
  private readonly captureRunSnapshot: (() => RuntimeStateSnapshot) | undefined;
  /** Run ids whose start has been handled; loaded from the snapshot file on first use. */
  private snapshottedRunIds: Set<string> | null = null;
  /** Keep each file's lines in order while their credential spans are read. */
  private readonly spanWriter = new AtRestLineWriter(SPAN_FILE_CREDENTIAL_SITE);
  private readonly ledgerWriter = new AtRestLineWriter(LEDGER_FILE_CREDENTIAL_SITE);

  constructor(config: LocalLedgerConfig) {
    this.filePath = config.filePath;
    this.maxFileSizeBytes = config.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;
    this.ledgerFilePath = config.ledgerFilePath ?? `${config.filePath}.ledger.jsonl`;
    this.snapshotFilePath = `${this.ledgerFilePath}.snapshots.jsonl`;
    this.atRestPolicy = config.atRestPolicy ?? DEFAULT_AT_REST_POLICY;
    this.captureRunSnapshot = config.captureRunSnapshot;
  }

  /**
   * Export a batch of spans as JSON lines.
   *
   * Failures are logged and isolated from callers so exporter I/O cannot break
   * runtime work.
   */
  async export(spans: ReadableSpan[]): Promise<void> {
    if (spans.length === 0) return;

    const lines: string[] = [];
    let droppedSpans = 0;
    for (const span of spans) {
      try {
        lines.push(JSON.stringify(span));
      } catch (err) {
        droppedSpans++;
        logger.warn('[local-ledger] span serialization failed', {
          error: summarizeError(err),
          spanName: span.name,
          traceId: span.spanContext.traceId,
          spanId: span.spanContext.spanId,
        });
      }
    }

    if (lines.length === 0) {
      logger.warn('[local-ledger] export produced no serializable spans', {
        spanCount: spans.length,
        droppedSpans,
      });
      return;
    }

    const payload = `${lines.join('\n')}\n`;
    const append = (text: string): void => {
      try {
        this._rotateIfNeeded();
        this._enforceRetention();
        appendFileSync(this.filePath, text, 'utf8');
      } catch (err) {
        logger.warn('[local-ledger] export failed', {
          error: summarizeError(err),
          filePath: this.filePath,
          spanCount: spans.length,
          writtenSpans: lines.length,
          droppedSpans,
        });
      }
    };

    // All I/O in a microtask to keep the call non-blocking. With redaction on,
    // the batch waits for the readings of any credential-shaped span in it.
    await Promise.resolve().then(() => {
      if (this.atRestPolicy.redact) this.spanWriter.write(payload, append);
      else append(payload);
    });
    await this.spanWriter.flush();
  }

  /**
   * Record a typed event entry to the ledger file.
   *
   * Used by the deterministic replay engine to build a per-run event log.
   * Failures are logged and isolated from callers.
   *
   * @param entry - The ledger entry to append.
   *
   * @remarks
   * This method is used by the event recording integration that
   * wires typed runtime events to the ledger. The integration subscribes to the
   * runtime bus at session start and calls `recordEvent()` for each event that should
   * be included in the replay ledger. See `DeterministicReplayEngine.load()`
   * for the consumer side of this pipeline.
   */
  recordEvent(entry: LedgerEntry): void {
    this._storeSnapshotIfRunStarts(entry.runId);
    const append = (line: string): void => {
      try {
        appendFileSync(this.ledgerFilePath, `${line}\n`, 'utf8');
      } catch (err) {
        logger.warn('[local-ledger] ledger write failed', {
          error: summarizeError(err),
          ledgerFilePath: this.ledgerFilePath,
          runId: entry.runId,
          rev: entry.rev,
          eventName: entry.eventName,
        });
      }
    };
    let serialized: string;
    try {
      serialized = JSON.stringify(entry);
    } catch (err) {
      logger.warn('[local-ledger] ledger write failed', {
        error: summarizeError(err),
        ledgerFilePath: this.ledgerFilePath,
        runId: entry.runId,
        rev: entry.rev,
        eventName: entry.eventName,
      });
      return;
    }
    // A line with a credential-shaped span not yet read is written once the
    // span is read, after every line ahead of it; flush() waits for those.
    if (this.atRestPolicy.redact) this.ledgerWriter.write(serialized, append);
    else append(serialized);
  }

  /**
   * Read all ledger entries for a given run.
   *
   * Parses the ledger file line-by-line. Malformed lines are skipped.
   * Returns entries sorted by revision (ascending).
   *
   * @param runId - The run to retrieve entries for.
   * @returns Ordered ledger entries for the run.
   */
  readRunEntries(runId: string): LedgerEntry[] {
    if (!existsSync(this.ledgerFilePath)) return [];

    const entries: LedgerEntry[] = [];
    let raw: string;
    try {
      raw = readFileSync(this.ledgerFilePath, 'utf8');
    } catch (err) {
      logger.warn('[local-ledger] ledger read failed', {
        error: summarizeError(err),
        ledgerFilePath: this.ledgerFilePath,
        runId,
      });
      return [];
    }

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as LedgerEntry;
        if (entry.runId === runId) {
          entries.push(entry);
        }
      } catch {
        // Skip malformed lines, ledger may have partial writes.
      }
    }

    entries.sort((a, b) => a.rev - b.rev);
    return entries;
  }

  /**
   * List all run IDs recorded in the ledger.
   */
  listRunIds(): string[] {
    if (!existsSync(this.ledgerFilePath)) return [];

    let raw: string;
    try {
      raw = readFileSync(this.ledgerFilePath, 'utf8');
    } catch (err) {
      logger.warn('[local-ledger] ledger read failed', {
        error: summarizeError(err),
        ledgerFilePath: this.ledgerFilePath,
      });
      return [];
    }

    const seen = new Set<string>();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as LedgerEntry;
        if (typeof entry.runId === 'string') {
          seen.add(entry.runId);
        }
      } catch {
        // Skip malformed lines.
      }
    }
    return [...seen];
  }

  /**
   * Read the runtime state snapshot stored when a run started.
   *
   * @param runId - The run to look up.
   * @returns The snapshot, or null when none was stored for the run (the run
   *   was recorded before snapshots existed, or with no snapshot source).
   */
  readRunSnapshot(runId: string): RuntimeStateSnapshot | null {
    let found: RuntimeStateSnapshot | null = null;
    for (const record of this._readSnapshotRecords()) {
      if (record.runId === runId) found = record.snapshot;
    }
    return found;
  }

  /**
   * On the first entry of a run id with no stored snapshot, capture the
   * runtime state and queue it ahead of that entry on the ledger writer, so
   * the snapshot line is written first and gets the same at-rest redaction.
   * A run is captured at most once: a later event would describe a state
   * after the run began, so a failed capture is logged and not retried.
   */
  private _storeSnapshotIfRunStarts(runId: string): void {
    if (!this.captureRunSnapshot) return;
    if (this.snapshottedRunIds === null) {
      this.snapshottedRunIds = new Set(this._readSnapshotRecords().map((record) => record.runId));
    }
    if (this.snapshottedRunIds.has(runId)) return;
    this.snapshottedRunIds.add(runId);

    let serialized: string;
    try {
      const record: RunSnapshotRecord = { runId, snapshot: this.captureRunSnapshot() };
      serialized = JSON.stringify(record);
    } catch (err) {
      logger.warn('[local-ledger] run snapshot capture failed', {
        error: summarizeError(err),
        snapshotFilePath: this.snapshotFilePath,
        runId,
      });
      return;
    }
    const append = (line: string): void => {
      try {
        appendFileSync(this.snapshotFilePath, `${line}\n`, 'utf8');
      } catch (err) {
        logger.warn('[local-ledger] run snapshot write failed', {
          error: summarizeError(err),
          snapshotFilePath: this.snapshotFilePath,
          runId,
        });
      }
    };
    if (this.atRestPolicy.redact) this.ledgerWriter.write(serialized, append);
    else append(serialized);
  }

  private _readSnapshotRecords(): RunSnapshotRecord[] {
    if (!existsSync(this.snapshotFilePath)) return [];
    let raw: string;
    try {
      raw = readFileSync(this.snapshotFilePath, 'utf8');
    } catch (err) {
      logger.warn('[local-ledger] run snapshot read failed', {
        error: summarizeError(err),
        snapshotFilePath: this.snapshotFilePath,
      });
      return [];
    }
    const records: RunSnapshotRecord[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isRunSnapshotRecord(parsed)) records.push(parsed);
      } catch {
        // Skip malformed lines, the file may have partial writes.
      }
    }
    return records;
  }

  /** Resolves once every line waiting on a credential span reading is written. */
  async flush(): Promise<void> {
    await Promise.all([this.spanWriter.flush(), this.ledgerWriter.flush()]);
  }

  /** Shutdown writes any line still waiting on a reading; there is nothing else to tear down. */
  async shutdown(): Promise<void> {
    await this.flush();
  }

  /**
   * Rotate the log file if it exceeds the configured maximum size.
   * Renames the current file to `<filePath>.1` (overwrites any existing `.1`).
   */
  /**
   * Retention enforcement point (called on every export, alongside rotation).
   * Applies the age + total-size caps across the span file, its rotated backup,
   * the ledger file and the run snapshot file, deleting oldest-first. The freshly-written active files
   * carry the most recent mtime, so they are only ever reclaimed as a last
   * resort under extreme size pressure, a rotated backup goes first.
   */
  private _enforceRetention(): void {
    try {
      const outcome = enforceFileRetention(
        [this.filePath, `${this.filePath}.1`, this.ledgerFilePath, this.snapshotFilePath],
        this.atRestPolicy,
      );
      if (outcome.deletedFiles.length > 0) {
        logger.debug('[local-ledger] retention reclaimed files', {
          deleted: outcome.deletedFiles.length,
          reclaimedBytes: outcome.reclaimedBytes,
        });
      }
    } catch (err) {
      logger.debug('[local-ledger] retention check failed', { error: summarizeError(err) });
    }
  }

  private _rotateIfNeeded(): void {
    try {
      const stat = statSync(this.filePath);
      if (stat.size >= this.maxFileSizeBytes) {
        renameSync(this.filePath, `${this.filePath}.1`);
        writeFileSync(this.filePath, '', 'utf8');
        logger.debug(`[local-ledger] rotated ${this.filePath}`);
      }
    } catch (err) {
      if (isNodeErrorCode(err, 'ENOENT')) {
        return;
      }
      logger.warn('[local-ledger] rotation check failed', {
        error: summarizeError(err),
        filePath: this.filePath,
      });
    }
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}
