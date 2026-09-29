/**
 * budget-store.ts, the daily budget pools, durable across a restart.
 *
 * ── The defect this closes ────────────────────────────────────────────────
 *
 * `payments-composition.ts` used to construct a plain `BudgetLedger` with no
 * initial state and never write anything back to disk, a choice its own header
 * comment flagged as correct ONLY while checkout was unattached ("the sole
 * writer of a spend record is the checkout flow, so there is nothing to
 * persist"). Now that checkout is wired, that stopped being true: a daemon
 * restarted at noon, after spending half the daily item budget, would come
 * back with the full budget again, because nothing on disk remembered the
 * spend. `register.ts`'s `PaymentsHandlerDeps.budget` doc comment names the
 * same gap ("a ledger rebuilt at every boot would hand back a daily budget
 * that was already spent").
 *
 * ── What this is, and is not ──────────────────────────────────────────────
 *
 * A thin subclass of the SDK's own `BudgetLedger`. Every pool computation,
 * every reservation rule, every day-boundary decision stays exactly what the
 * SDK wrote (`snapshot()` recomputes from `spend`/`reservations` against the
 * CURRENT day every time it is asked, see budget.ts, which is what makes day
 * rollover correct with zero code here). This class adds exactly one thing:
 * a write-through to a JSON file after every mutating call, and a load of that
 * file at construction, using the constructor seam `BudgetLedger` already
 * exposes for it (`new BudgetLedger(initial?: BudgetStateSnapshot)`).
 *
 * ── Corruption is a warning, not a crash and not a silent empty pool ─────
 *
 * A missing file (the ordinary first-boot case, or any daemon that has never
 * spent anything) starts empty with no log line, the same silent-empty
 * treatment `DaemonPurchaseLedger`/`DaemonCardStore` give a missing file, and
 * what keeps `payments.budget.status`'s fresh-daemon response identical to
 * today's. A file that exists but fails to parse or does not hold the shape
 * this class wrote is different: that is data loss for a store that tracks
 * money, and it is logged as a warning naming the file, rather than swallowed
 * the way a purchase ledger's read failure is. Either way the daemon starts
 * empty and keeps running; refusing to boot over a damaged budget file would
 * take every other capability on this daemon down with it, the same reasoning
 * `readPurchasesFile` already gives for purchases.
 *
 * ── A write failure after commit must not erase a spend that already happened ──
 *
 * Every mutating method here throws on a write failure except one:
 * `commit`. By the time the checkout flow calls it (checkout-flow.ts, step 10,
 * after step 9 has already told the merchant to charge the card), the money is
 * gone whether or not this class can get a byte to disk. A full disk turning
 * that into a thrown error would mean the caller sees an exception for a
 * purchase that, at the merchant, already succeeded, and nothing downstream
 * of it, the response, the audit ledger row, would ever get written either.
 * So `commit`'s own write failure is logged loudly instead, the in-memory
 * commit stands (this class's whole `spend`/`reservations` state, and
 * therefore every subsequent `snapshot()`, already reflects it), and the write
 * is retried at the START of the next mutating call, whichever one that
 * happens to be, rather than being retried right away or dropped.
 */
import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteFileSync } from '../../config/atomic-write.js';
import { logger } from '../../utils/logger.js';
import { BudgetLedger } from '../budget.js';
import type {
  BudgetLimits,
  BudgetReservation,
  BudgetStateSnapshot,
  SpendRecord,
} from '../budget.js';

const BUDGET_FILE_VERSION = 1;

interface BudgetFile {
  readonly version: number;
  readonly spend: readonly SpendRecord[];
  readonly reservations: readonly BudgetReservation[];
}

/**
 * Whether `value` is a finite, non-negative amount.
 *
 * A pool total is a running sum of every entry that passes this check
 * (`BudgetLedger.snapshot`, budget.ts), so one entry that is not a real,
 * bounded number poisons the whole day's total: a negative amount inflates
 * what looks spent into what looks remaining, and `Infinity` or `NaN` (which
 * `1e999` parses to under `JSON.parse`) turns "remaining" into a value no
 * comparison against a limit can ever refuse. `typeof value === 'number'`
 * alone accepts both, which is why this checks `Number.isFinite` rather than
 * only the type.
 */
function isFiniteNonNegativeAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Whether `value` is a real millisecond timestamp `Date` can hold.
 *
 * The amount guard above (`isFiniteNonNegativeAmount`) never applied to
 * `atMs`/`createdAtMs`/`expiresAtMs`: those fields were only checked with a
 * bare `typeof value === 'number'`, which accepts `Infinity` and `NaN` the
 * same way an unchecked amount did. A timestamp that parses to `Infinity`
 * (`1e999`, valid JSON number syntax) or that is simply out of the range
 * `Date` can represent (`8.64e15` is `Date`'s own documented maximum) does not
 * fail loudly where an amount would: it passes `loadInitialState` and then
 * throws a `RangeError` out of `Intl.DateTimeFormat`/`Date` formatting the
 * first time `snapshot()` or `reserve()` computes a day key from it (`day.ts`),
 * on every call, forever, since nothing ever mutates the record to fix it or
 * calls `persist()` to rewrite the file. Checked the same way an amount is:
 * finite, and a whole number inside the range `Date` accepts.
 */
function isValidTimestampMs(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Number.isInteger(value)
    && value >= 0
    && value <= 8_640_000_000_000_000;
}

function isSpendRecord(value: unknown): value is SpendRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['purchaseId'] === 'string'
    && isValidTimestampMs(record['atMs'])
    && isFiniteNonNegativeAmount(record['itemMinorUnits'])
    && isFiniteNonNegativeAmount(record['overageMinorUnits'])
    && isFiniteNonNegativeAmount(record['toleranceMinorUnits']);
}

function isReservation(value: unknown): value is BudgetReservation {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['id'] === 'string'
    && typeof record['dayKey'] === 'string'
    && isFiniteNonNegativeAmount(record['itemMinorUnits'])
    && isFiniteNonNegativeAmount(record['overageMinorUnits'])
    && isFiniteNonNegativeAmount(record['toleranceMinorUnits'])
    && isValidTimestampMs(record['createdAtMs'])
    && isValidTimestampMs(record['expiresAtMs']);
}

/**
 * Read the persisted state, or `undefined` for "start empty".
 *
 * The only case that logs is a file that exists and fails to read as the
 * shape this class wrote; a missing file is the ordinary case and stays
 * quiet, matching the rest of this daemon's stores.
 */
function loadInitialState(filePath: string): BudgetStateSnapshot | undefined {
  if (!existsSync(filePath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (error) {
    logger.warn(
      'Budget ledger file could not be read; starting today\'s pools empty rather than guessing. '
      + 'A spent amount recorded before this may be missing from today\'s totals until this file is repaired.',
      { filePath, error: error instanceof Error ? error.message : String(error) },
    );
    return undefined;
  }
  if (
    typeof parsed !== 'object'
    || parsed === null
    || !Array.isArray((parsed as Partial<BudgetFile>).spend)
    || !Array.isArray((parsed as Partial<BudgetFile>).reservations)
  ) {
    logger.warn(
      'Budget ledger file does not hold the expected shape; starting today\'s pools empty rather than guessing.',
      { filePath },
    );
    return undefined;
  }
  const file = parsed as BudgetFile;
  const spend = file.spend.filter(isSpendRecord);
  const reservations = file.reservations.filter(isReservation);
  if (spend.length !== file.spend.length || reservations.length !== file.reservations.length) {
    logger.warn(
      'Budget ledger file held entries that do not match the expected record shape; those entries were '
      + 'dropped rather than trusted.',
      { filePath },
    );
  }
  // Named, not just counted: a reservation has no per-purchase narrative of
  // its own here (the checkout journal, checkout-journal-store.ts, records
  // the purchase's phases; this file records only the pools), so this
  // log line is the only record an operator has, at restart, of money that is
  // currently held against the daily limit for a purchase that may or may not
  // still be in flight. Reconciling it against what the merchant actually
  // charged is manual; naming the ids, amounts and dayKey here is what makes
  // that possible at all.
  if (reservations.length > 0) {
    logger.info(
      'Budget ledger loaded with reservations already held against today\'s pools. Each one holds budget until '
      + 'it is committed, released, or its TTL expires; if the purchase it belongs to did not actually complete, '
      + 'reconcile it against what the merchant charged.',
      {
        filePath,
        reservations: reservations.map((entry) => ({
          id: entry.id,
          dayKey: entry.dayKey,
          itemMinorUnits: entry.itemMinorUnits,
          overageMinorUnits: entry.overageMinorUnits,
          toleranceMinorUnits: entry.toleranceMinorUnits,
          expiresAtMs: entry.expiresAtMs,
        })),
      },
    );
  }
  return { spend, reservations };
}

/**
 * The daemon's durable `BudgetLedger`.
 *
 * Every mutating method the base class exposes is overridden to persist the
 * new state after the mutation succeeds. Reads (`snapshot`, `state`) are
 * untouched: they are pure functions over in-memory state and stay that way.
 */
export class DurableBudgetLedger extends BudgetLedger {
  private readonly filePath: string;
  /**
   * Set when a write to disk failed and was not retried at that moment.
   * Checked at the START of every mutating method below, before its own
   * write, so a disk that has come back gets the missed write on the very
   * next mutation rather than waiting for one to fail again to notice.
   */
  private persistPending = false;

  /**
   * `now` defaults to the real clock; a test passes its own so an old fixture
   * timestamp stays "recent" relative to whatever moment the test considers
   * "now", rather than being pruned out from under a scenario that has nothing
   * to do with retention.
   */
  constructor(filePath: string, now: () => number = Date.now) {
    super(loadInitialState(filePath));
    this.filePath = filePath;
    // Never called anywhere before this: a spend record older than the base
    // class's own two-day retention window (`BudgetLedger.prune`, budget.ts,
    // "anything older than two days cannot be 'today' in any timezone on
    // earth") could accumulate for the whole life of a long-running daemon,
    // since nothing else in this class's own mutation set ever shrinks
    // `spend`. Pruning once here, right after load, means a daemon that has
    // been running for months does not carry months of spend records it will
    // never again need: `snapshot()` only ever looks at "today", and the
    // purchase audit ledger, not this file, is the durable long-term record.
    // `this.prune` below persists on its own when it actually drops something,
    // so a fresh or already-pruned file triggers no extra write.
    this.prune(now());
  }

  override reserve(input: {
    readonly id: string;
    readonly itemMinorUnits: number;
    readonly overageMinorUnits: number;
    readonly toleranceMinorUnits: number;
    readonly limits: BudgetLimits;
    readonly nowMs: number;
    readonly timezone: string;
    readonly ttlMs?: number;
  }): BudgetReservation | null {
    this.retryPendingPersist();
    const result = super.reserve(input);
    if (result !== null) {
      try {
        this.persist();
      } catch (error) {
        // Unlike `commit` (below), a reservation that never reached disk
        // represents nothing that has happened yet: no money left this
        // process's control, nothing downstream saw it succeed. Holding it in
        // memory anyway would mean a caller that saw this throw and treated
        // the reservation as never made would nonetheless have it tie up
        // budget for the full 4h TTL. Roll the in-memory mutation back before
        // the caller sees the failure, so a failed reserve leaves `remaining`
        // exactly where it was, the same as if `super.reserve` itself had
        // refused.
        super.release(result.id);
        throw error;
      }
    }
    return result;
  }

  /**
   * Commit is different from every other mutation below: by the time this
   * runs, the checkout flow has already told the merchant to charge the card
   * (checkout-flow.ts, step 9, before step 10 calls this). A write failure
   * here must never un-happen a charge that already happened at the
   * merchant, so unlike every other method here it does not throw: the
   * failure is logged loudly, the in-memory commit `super.commit` already
   * made stands, and the write is retried on the next mutation
   * (`retryPendingPersist`, above), whichever method that turns out to be.
   */
  override commit(reservationId: string, atMs: number): SpendRecord | null {
    this.retryPendingPersist();
    const result = super.commit(reservationId, atMs);
    if (result !== null) this.persistAfterCommit();
    return result;
  }

  override release(reservationId: string): boolean {
    this.retryPendingPersist();
    const result = super.release(reservationId);
    if (result) this.persist();
    return result;
  }

  override sweep(nowMs: number): readonly BudgetReservation[] {
    this.retryPendingPersist();
    const result = super.sweep(nowMs);
    if (result.length > 0) this.persist();
    return result;
  }

  override prune(nowMs: number): void {
    this.retryPendingPersist();
    const before = super.state().spend.length;
    super.prune(nowMs);
    if (super.state().spend.length !== before) this.persist();
  }

  /** Retries a write a prior mutation could not make land, before this one's own. Silent: a still-down disk just stays pending. */
  private retryPendingPersist(): void {
    if (!this.persistPending) return;
    try {
      this.writeToDisk();
    } catch {
      // Still down. Stays pending; tried again on the next mutation.
    }
  }

  /** The commit-only path: never throws, logs instead, and leaves the write pending for a later retry. */
  private persistAfterCommit(): void {
    try {
      this.writeToDisk();
    } catch (error) {
      this.persistPending = true;
      logger.warn(
        'Budget ledger could not be written to disk after a committed spend. The spend is kept in memory and '
        + 'reported correctly for the rest of this process, and the write will be retried on the next budget '
        + 'change. But if this process dies before that retry lands, the file on disk still holds the OLD '
        + 'reservation, not this commit: the amount stays counted against the daily limit only until that '
        + 'reservation\'s own TTL passes, at which point it is treated as expired rather than spent, and the '
        + 'daily limit becomes re-spendable by the lost amount with no record it was ever charged.',
        { filePath: this.filePath, error: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  /** Every mutation but commit: a write failure here throws, unchanged from before this class had a retry path. */
  private persist(): void {
    this.writeToDisk();
  }

  private writeToDisk(): void {
    const contents: BudgetFile = { version: BUDGET_FILE_VERSION, ...super.state() };
    atomicWriteFileSync(this.filePath, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600, mkdirp: true });
    this.persistPending = false;
  }
}
