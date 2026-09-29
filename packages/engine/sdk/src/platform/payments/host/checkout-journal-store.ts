/**
 * checkout-journal-store.ts, the in-flight checkout journal, durable across a
 * restart.
 *
 * ── The defect this closes ────────────────────────────────────────────────
 *
 * The composition used to hand `PaymentsGatewayServiceImpl` the SDK's own
 * `MemoryCheckoutJournal`, documented "durable across nothing". The phase
 * ladder in checkout-registry.ts exists for exactly one ambiguous moment: a
 * crash between the `submit-pending` flush and the merchant's response. With
 * an in-memory journal that flush kept nothing, so a restart could never say
 * "this purchase may already have been submitted, do not resubmit it". This
 * file is the durable journal that record was waiting for.
 *
 * ── The contract this implements ──────────────────────────────────────────
 *
 * The SDK's `CheckoutJournal` (checkout-registry.ts): `put` must not return
 * until the record would survive a power cut, `remove` drops one by
 * purchaseId, `list` returns what is held. `put` here writes through
 * `atomicWriteFileSync` (a synchronous rename-into-place) before resolving,
 * which is the flush the `submit-pending` guarantee rides on; a `put` whose
 * write fails THROWS, because a journal that reports durable-and-was-not
 * turns that guarantee into a comment.
 *
 * `remove` is the one deliberate asymmetry: its write failure is logged and
 * swallowed rather than thrown. By the time `remove` runs the checkout is
 * finished or abandoned; failing the caller would turn a completed purchase's
 * report into an error over a cleanup write, and the stale record it leaves
 * on disk fails in the safe direction, a restart discloses a checkout that
 * needs checking rather than forgetting one that does. The in-memory removal
 * stands either way, and the next successful `put`/`remove` rewrites the file
 * without the stale record.
 *
 * ── Unknown fields ride along untouched ───────────────────────────────────
 *
 * Records are persisted and reloaded as the objects they arrive as, not
 * projected through this module's idea of the record shape. Only
 * `purchaseId` (the removal key) is checked at load; every other field,
 * including fields added by an SDK this build has never seen, round-trips
 * byte-for-byte. The repin that teaches
 * the SDK to recover these records must find everything its writer put here,
 * not everything this file knew to keep.
 *
 * ── Corruption is a warning, not a crash ──────────────────────────────────
 *
 * Same conventions as `DurableBudgetLedger` (budget-store.ts): a missing file
 * starts empty silently; a file that exists but cannot be parsed or does not
 * hold this shape is logged as a warning naming the file, and the journal
 * starts empty rather than taking the daemon down. Entries without a string
 * `purchaseId` are dropped with a warning, since nothing could ever remove
 * them.
 */
import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteFileSync } from '../../config/atomic-write.js';
import { logger } from '../../utils/logger.js';
import type { CheckoutJournal, InFlightCheckout } from '../checkout-registry.js';

const JOURNAL_FILE_VERSION = 1;

interface JournalFile {
  readonly version: number;
  readonly records: readonly Record<string, unknown>[];
}

/** The two fields this module actually reads; everything else is opaque cargo. */
function hasJournalKeys(value: unknown): value is Record<string, unknown> & { purchaseId: string } {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && typeof (value as Record<string, unknown>)['purchaseId'] === 'string';
}

/** Read the persisted records, keyed by purchaseId, or empty for "start empty". */
function loadInitialRecords(filePath: string): Map<string, Record<string, unknown>> {
  const records = new Map<string, Record<string, unknown>>();
  if (!existsSync(filePath)) return records;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (error) {
    logger.warn(
      'Checkout journal file could not be read; starting with no in-flight checkouts rather than guessing. '
      + 'If a purchase was mid-submit when this daemon last stopped, check that merchant\'s order history by hand.',
      { filePath, error: error instanceof Error ? error.message : String(error) },
    );
    return records;
  }
  if (
    typeof parsed !== 'object'
    || parsed === null
    || !Array.isArray((parsed as Partial<JournalFile>).records)
  ) {
    logger.warn(
      'Checkout journal file does not hold the expected shape; starting with no in-flight checkouts rather than guessing.',
      { filePath },
    );
    return records;
  }
  const rows = (parsed as JournalFile).records;
  for (const row of rows) {
    if (hasJournalKeys(row)) {
      records.set(row.purchaseId, row);
    }
  }
  if (records.size !== rows.length) {
    logger.warn(
      'Checkout journal file held entries with no purchaseId; those entries were dropped rather than trusted, '
      + 'since nothing could ever remove them.',
      { filePath },
    );
  }
  return records;
}

/**
 * The durable `CheckoutJournal` this daemon composes. See the module header
 * for the contract and the conventions.
 */
export class DurableCheckoutJournal implements CheckoutJournal {
  private readonly records: Map<string, Record<string, unknown>>;

  constructor(private readonly filePath: string) {
    this.records = loadInitialRecords(filePath);
  }

  /** Durable before it resolves; throws when the write does not land. */
  async put(record: InFlightCheckout): Promise<void> {
    const previous = this.records.get(record.purchaseId);
    this.records.set(record.purchaseId, record as unknown as Record<string, unknown>);
    try {
      this.persist();
    } catch (error) {
      if (previous === undefined) this.records.delete(record.purchaseId);
      else this.records.set(record.purchaseId, previous);
      throw error;
    }
  }

  /** Removes in memory always; a failed cleanup write is logged, never thrown. See the header. */
  async remove(purchaseId: string): Promise<void> {
    if (!this.records.delete(purchaseId)) return;
    try {
      this.persist();
    } catch (error) {
      logger.warn(
        'Checkout journal could not be rewritten after removing a finished checkout. The stale record stays on '
        + 'disk until the next journal write lands; at worst a restart reports a checkout that needs checking '
        + 'when it was already complete, never the reverse.',
        { filePath: this.filePath, purchaseId, error: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  async list(): Promise<readonly InFlightCheckout[]> {
    return [...this.records.values()] as unknown as readonly InFlightCheckout[];
  }

  private persist(): void {
    const contents: JournalFile = { version: JOURNAL_FILE_VERSION, records: [...this.records.values()] };
    atomicWriteFileSync(this.filePath, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600, mkdirp: true });
  }
}
