/**
 * DurableBudgetLedger: the daily pools survive a restart.
 *
 * The defect this covers: `BudgetLedger` was constructed fresh, with no
 * initial state and no write-back, in `payments-composition.ts`. A daemon
 * restarted mid-day handed back a full daily budget it had already spent, the
 * exact failure `payments-composition.ts`'s own header used to flag as correct
 * "ONLY while checkout is unattached". These tests exercise the persistence
 * this class adds over the SDK's own `BudgetLedger`, not the pool arithmetic
 * itself (budget.ts's own tests already cover that; this class changes
 * nothing about it).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { logger } from '../sdk/src/platform/utils/logger.js';
import { dayKey } from '../sdk/src/platform/payments/day.js';
import type { BudgetLimits } from '../sdk/src/platform/payments/budget.js';
import { DurableBudgetLedger } from '../sdk/src/platform/payments/host/budget-store.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const LIMITS: BudgetLimits = {
  dailyItemMinorUnits: 10_000,
  dailyOverageMinorUnits: 2_000,
  perPurchaseCeiling: { enabled: false, minorUnits: 0 },
  overageTolerance: { enabled: false, dailyAllowanceMinorUnits: 0 },
};

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = makeProjectTempDir('gv-budget-store');
  filePath = join(dir, 'payments-budget.json');
});

function withCapturedWarnings<T>(fn: () => T): { result: T; warnings: Array<{ message: string; data?: Record<string, unknown> | undefined }> } {
  const warnings: Array<{ message: string; data?: Record<string, unknown> | undefined }> = [];
  const spy = spyOn(logger, 'warn').mockImplementation(((message: string, data?: Record<string, unknown>) => {
    warnings.push({ message, data });
  }) as never);
  try {
    return { result: fn(), warnings };
  } finally {
    spy.mockRestore();
  }
}

function withCapturedInfo<T>(fn: () => T): { result: T; infos: Array<{ message: string; data?: Record<string, unknown> | undefined }> } {
  const infos: Array<{ message: string; data?: Record<string, unknown> | undefined }> = [];
  const spy = spyOn(logger, 'info').mockImplementation(((message: string, data?: Record<string, unknown>) => {
    infos.push({ message, data });
  }) as never);
  try {
    return { result: fn(), infos };
  } finally {
    spy.mockRestore();
  }
}

describe('a reservation survives a restart', () => {
  test('a reservation held by the first ledger is still held by the second', () => {
    const first = new DurableBudgetLedger(filePath);
    const reserved = first.reserve({
      id: 'pur-1', itemMinorUnits: 3_000, overageMinorUnits: 0, toleranceMinorUnits: 0,
      limits: LIMITS, nowMs: Date.parse('2026-08-19T12:00:00.000Z'), timezone: 'UTC',
    });
    expect(reserved).not.toBeNull();

    const second = new DurableBudgetLedger(filePath);
    const snapshot = second.snapshot(LIMITS, Date.parse('2026-08-19T12:05:00.000Z'), 'UTC');
    // The reservation is still held: 3000 reserved, so only 7000 remains of a
    // 10000 daily item budget, exactly as the first ledger left it.
    expect(snapshot.item.reserved).toBe(3_000);
    expect(snapshot.item.remaining).toBe(7_000);
    expect(second.state().reservations).toHaveLength(1);
    expect(second.state().reservations[0]?.id).toBe('pur-1');
  });
});

describe('a commit survives a restart', () => {
  test('a committed spend is still spent after reopening the ledger', () => {
    const first = new DurableBudgetLedger(filePath);
    const reserved = first.reserve({
      id: 'pur-1', itemMinorUnits: 4_000, overageMinorUnits: 0, toleranceMinorUnits: 0,
      limits: LIMITS, nowMs: Date.parse('2026-08-19T12:00:00.000Z'), timezone: 'UTC',
    });
    expect(reserved).not.toBeNull();
    const committed = first.commit('pur-1', Date.parse('2026-08-19T12:01:00.000Z'));
    expect(committed).not.toBeNull();

    // The whole defect this class exists to fix: a daemon restarted at noon
    // must not hand back the budget it already spent. `now` is pinned to this
    // test's own fixed timeline so the just-committed spend, minutes old on
    // that timeline, is not mistaken for the kind of stale record construction
    // now prunes.
    const second = new DurableBudgetLedger(filePath, () => Date.parse('2026-08-19T15:00:00.000Z'));
    const snapshot = second.snapshot(LIMITS, Date.parse('2026-08-19T15:00:00.000Z'), 'UTC');
    expect(snapshot.item.spent).toBe(4_000);
    expect(snapshot.item.remaining).toBe(6_000);
    expect(second.state().reservations).toHaveLength(0);
    expect(second.state().spend).toHaveLength(1);
  });

  test('a released reservation stays released after reopening', () => {
    const first = new DurableBudgetLedger(filePath);
    const reserved = first.reserve({
      id: 'pur-1', itemMinorUnits: 5_000, overageMinorUnits: 0, toleranceMinorUnits: 0,
      limits: LIMITS, nowMs: Date.parse('2026-08-19T12:00:00.000Z'), timezone: 'UTC',
    });
    expect(reserved).not.toBeNull();
    expect(first.release('pur-1')).toBe(true);

    const second = new DurableBudgetLedger(filePath);
    const snapshot = second.snapshot(LIMITS, Date.parse('2026-08-19T12:05:00.000Z'), 'UTC');
    expect(snapshot.item.reserved).toBe(0);
    expect(snapshot.item.remaining).toBe(10_000);
  });
});

describe('a missing or corrupt file starts empty rather than crashing', () => {
  test('a file that has never been written starts empty with no warning', () => {
    expect(existsSync(filePath)).toBe(false);
    const { result: ledger, warnings } = withCapturedWarnings(() => new DurableBudgetLedger(filePath));
    const snapshot = ledger.snapshot(LIMITS, Date.now(), 'UTC');
    expect(snapshot.item.spent).toBe(0);
    expect(snapshot.item.reserved).toBe(0);
    // The ordinary first-boot case: no file, nothing to warn about.
    expect(warnings).toHaveLength(0);
  });

  test('a corrupt file starts empty with a logged warning, not a thrown error', () => {
    writeFileSync(filePath, '{"version":1,"spend":[{"purchaseId":');
    const { result: ledger, warnings } = withCapturedWarnings(() => new DurableBudgetLedger(filePath));
    const snapshot = ledger.snapshot(LIMITS, Date.now(), 'UTC');
    expect(snapshot.item.spent).toBe(0);
    expect(snapshot.item.reserved).toBe(0);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((entry) => entry.message.toLowerCase().includes('budget ledger'))).toBe(true);
  });

  test('a file holding the wrong shape (not an object) starts empty with a warning', () => {
    writeFileSync(filePath, '"just a string, not budget state"');
    const { result: ledger, warnings } = withCapturedWarnings(() => new DurableBudgetLedger(filePath));
    expect(ledger.state()).toEqual({ spend: [], reservations: [] });
    expect(warnings.length).toBeGreaterThan(0);
  });

  test('the ledger keeps running after a corrupt boot: new reservations persist normally', () => {
    writeFileSync(filePath, 'not json at all {{{');
    const { result: ledger } = withCapturedWarnings(() => new DurableBudgetLedger(filePath));
    const reserved = ledger.reserve({
      id: 'pur-after-corruption', itemMinorUnits: 1_000, overageMinorUnits: 0, toleranceMinorUnits: 0,
      limits: LIMITS, nowMs: Date.now(), timezone: 'UTC',
    });
    expect(reserved).not.toBeNull();
    const reopened = new DurableBudgetLedger(filePath);
    expect(reopened.state().reservations).toHaveLength(1);
  });
});

describe('day rollover is unaffected by persistence', () => {
  test('a spend recorded yesterday does not count against today\'s pool after a restart', () => {
    const yesterday = Date.parse('2026-08-18T12:00:00.000Z');
    const today = Date.parse('2026-08-19T09:00:00.000Z');

    const first = new DurableBudgetLedger(filePath);
    const reserved = first.reserve({
      id: 'pur-yesterday', itemMinorUnits: 9_000, overageMinorUnits: 0, toleranceMinorUnits: 0,
      limits: LIMITS, nowMs: yesterday, timezone: 'UTC',
    });
    expect(reserved).not.toBeNull();
    expect(first.commit('pur-yesterday', yesterday)).not.toBeNull();

    // Reopen as a new process would, and ask about TODAY. `now` is pinned to
    // this test's own fixed timeline: yesterday's spend is a day old on that
    // timeline, well inside the base class's two-day prune window, and stays
    // distinct from the "beyond retention" case the prune-at-construction
    // tests cover below.
    const second = new DurableBudgetLedger(filePath, () => today);
    const snapshot = second.snapshot(LIMITS, today, 'UTC');
    expect(snapshot.dayKey).toBe(dayKey(today, 'UTC'));
    expect(snapshot.item.spent).toBe(0);
    expect(snapshot.item.remaining).toBe(10_000);

    // The record survived the restart; it is simply not counted against a
    // different day, exactly as it would not be within a single process.
    expect(second.state().spend).toHaveLength(1);
  });

  test('the persisted file itself holds both the raw record and the version envelope', () => {
    const ledger = new DurableBudgetLedger(filePath);
    const reserved = ledger.reserve({
      id: 'pur-1', itemMinorUnits: 1_000, overageMinorUnits: 0, toleranceMinorUnits: 0,
      limits: LIMITS, nowMs: Date.now(), timezone: 'UTC',
    });
    expect(reserved).not.toBeNull();
    const onDisk = JSON.parse(readFileSync(filePath, 'utf-8')) as { version: number; reservations: unknown[] };
    expect(onDisk.version).toBe(1);
    expect(onDisk.reservations).toHaveLength(1);
  });
});

describe('every stored amount must be finite and non-negative, or the entry is dropped', () => {
  // The reviewer reproduced pool inflation to Infinity from an entry like
  // these surviving into `snapshot()`'s running sum: a negative amount makes
  // "spent" look smaller than it is, and an amount that parses to `Infinity`
  // (which is what the valid JSON number syntax `1e999` parses to) turns
  // "remaining" into a value nothing can ever compare below a limit again.

  test('a spend record with a negative amount is dropped, not trusted', () => {
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      spend: [{ purchaseId: 'pur-negative', atMs: 1, itemMinorUnits: -500, overageMinorUnits: 0, toleranceMinorUnits: 0 }],
      reservations: [],
    }));
    const { result: ledger, warnings } = withCapturedWarnings(() => new DurableBudgetLedger(filePath));
    expect(ledger.state().spend).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test('a spend record whose amount is 1e999 (parses to Infinity) is dropped, not trusted', () => {
    // Written as raw text rather than through JSON.stringify/parse in JS
    // first: `1e999` is valid JSON number syntax, and `JSON.parse` resolves it
    // to `Infinity`, the exact value this validator has to catch.
    writeFileSync(
      filePath,
      '{"version":1,"spend":[{"purchaseId":"pur-inf","atMs":1,"itemMinorUnits":1e999,"overageMinorUnits":0,"toleranceMinorUnits":0}],"reservations":[]}',
    );
    const { result: ledger, warnings } = withCapturedWarnings(() => new DurableBudgetLedger(filePath));
    expect(ledger.state().spend).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test('a reservation with a negative amount is dropped, not trusted', () => {
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      spend: [],
      reservations: [{
        id: 'pur-negative', dayKey: '2026-08-19', itemMinorUnits: -1, overageMinorUnits: 0,
        toleranceMinorUnits: 0, createdAtMs: 1, expiresAtMs: 999_999_999_999,
      }],
    }));
    const { result: ledger, warnings } = withCapturedWarnings(() => new DurableBudgetLedger(filePath));
    expect(ledger.state().reservations).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test('a reservation whose amount is 1e999 (parses to Infinity) is dropped, not trusted', () => {
    writeFileSync(
      filePath,
      '{"version":1,"spend":[],"reservations":[{"id":"pur-inf","dayKey":"2026-08-19","itemMinorUnits":1e999,'
      + '"overageMinorUnits":0,"toleranceMinorUnits":0,"createdAtMs":1,"expiresAtMs":999999999999}]}',
    );
    const { result: ledger, warnings } = withCapturedWarnings(() => new DurableBudgetLedger(filePath));
    expect(ledger.state().reservations).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test('a finite, non-negative amount survives the same read path', () => {
    // atMs is recent, not the epoch: this test is about amount validation, not
    // retention, and an epoch timestamp would otherwise be dropped by the
    // construction-time prune the "prune runs once at construction" describe
    // block below covers on its own.
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      spend: [{ purchaseId: 'pur-ok', atMs: Date.now(), itemMinorUnits: 500, overageMinorUnits: 0, toleranceMinorUnits: 0 }],
      reservations: [],
    }));
    const { result: ledger, warnings } = withCapturedWarnings(() => new DurableBudgetLedger(filePath));
    expect(ledger.state().spend).toHaveLength(1);
    expect(warnings).toHaveLength(0);
  });
});

describe('a disk write that fails on commit never loses the spend, and retries on the next mutation', () => {
  /**
   * Blocks every write beneath `path`'s directory by replacing the directory
   * itself with a plain file: `atomicWriteFileSync`'s `mkdirSync(dirname(path),
   * { recursive: true })` then throws ENOTDIR, deterministically and
   * regardless of the process's privilege level (unlike a permission-bit
   * test, which root bypasses).
   */
  function blockWrites(path: string): void {
    rmSync(path, { recursive: true, force: true });
    writeFileSync(path, 'a plain file standing where a directory needs to be');
  }

  /** Undoes `blockWrites`, restoring the real directory so a write can land again. */
  function unblockWrites(path: string): void {
    rmSync(path, { force: true });
    mkdirSync(path, { recursive: true });
  }

  test('commit does not throw when the write fails; the spend is kept in memory and reported', () => {
    const ledger = new DurableBudgetLedger(filePath);
    // Reserve BEFORE sabotaging the directory, so this reservation's own write
    // succeeds normally and proves the ledger is otherwise working.
    const reserved = ledger.reserve({
      id: 'pur-1', itemMinorUnits: 3_000, overageMinorUnits: 0, toleranceMinorUnits: 0,
      limits: LIMITS, nowMs: Date.now(), timezone: 'UTC',
    });
    expect(reserved).not.toBeNull();

    blockWrites(dir);
    const { result: committed, warnings } = withCapturedWarnings(
      () => ledger.commit('pur-1', Date.now()),
    );
    // The whole point: a charge that already happened at the merchant is not
    // turned into a thrown error by a disk that cannot be written to.
    expect(committed).not.toBeNull();
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((entry) => entry.message.toLowerCase().includes('budget ledger'))).toBe(true);

    // Kept in memory and reported correctly for the rest of this process,
    // regardless of what made it to disk.
    const snapshot = ledger.snapshot(LIMITS, Date.now(), 'UTC');
    expect(snapshot.item.spent).toBe(3_000);
    expect(ledger.state().spend).toHaveLength(1);
    expect(ledger.state().reservations).toHaveLength(0);

    unblockWrites(dir);
  });

  test('the missed write is retried on the next mutation, once the disk is writable again', () => {
    const ledger = new DurableBudgetLedger(filePath);
    const reserved = ledger.reserve({
      id: 'pur-1', itemMinorUnits: 2_500, overageMinorUnits: 0, toleranceMinorUnits: 0,
      limits: LIMITS, nowMs: Date.now(), timezone: 'UTC',
    });
    expect(reserved).not.toBeNull();

    blockWrites(dir);
    expect(ledger.commit('pur-1', Date.now())).not.toBeNull();
    // Restore the directory, then make an UNRELATED mutation. It must not
    // throw either: `retryPendingPersist` swallows a still-failing retry, and
    // by now the disk is writable again, so this one lands.
    unblockWrites(dir);
    const secondReservation = ledger.reserve({
      id: 'pur-2', itemMinorUnits: 1_000, overageMinorUnits: 0, toleranceMinorUnits: 0,
      limits: LIMITS, nowMs: Date.now(), timezone: 'UTC',
    });
    expect(secondReservation).not.toBeNull();

    // The file on disk now holds BOTH: the commit the earlier write missed,
    // caught up by the retry, and the new reservation, from this call's own
    // write.
    const onDisk = JSON.parse(readFileSync(filePath, 'utf-8')) as {
      spend: { purchaseId: string }[];
      reservations: { id: string }[];
    };
    expect(onDisk.spend.map((entry) => entry.purchaseId)).toContain('pur-1');
    expect(onDisk.reservations.map((entry) => entry.id)).toContain('pur-2');
  });
});

describe('every stored timestamp must be a value Date can hold, or the entry is dropped', () => {
  // The reviewer reproduced a permanent RangeError: a bare `typeof value ===
  // 'number'` check on `atMs`/`createdAtMs`/`expiresAtMs` let a value like
  // `1e999` (valid JSON number syntax, parses to `Infinity`) or `1e18`
  // (comfortably past Date's own documented maximum of 8.64e15) survive
  // `loadInitialState`, and then every later `snapshot()`/`reserve()` threw
  // computing a day key from it, forever, since nothing mutates the record to
  // fix it and no read path ever calls `persist()` to rewrite the file.

  test('a spend record whose atMs is 1e999 (parses to Infinity) is dropped, not trusted', () => {
    writeFileSync(
      filePath,
      '{"version":1,"spend":[{"purchaseId":"pur-inf-ts","atMs":1e999,"itemMinorUnits":500,'
      + '"overageMinorUnits":0,"toleranceMinorUnits":0}],"reservations":[]}',
    );
    const { result: ledger, warnings } = withCapturedWarnings(() => new DurableBudgetLedger(filePath));
    expect(ledger.state().spend).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test('a spend record whose atMs is 1e18 (past what Date can represent) is dropped, not trusted', () => {
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      spend: [{ purchaseId: 'pur-huge-ts', atMs: 1e18, itemMinorUnits: 500, overageMinorUnits: 0, toleranceMinorUnits: 0 }],
      reservations: [],
    }));
    const { result: ledger, warnings } = withCapturedWarnings(() => new DurableBudgetLedger(filePath));
    expect(ledger.state().spend).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test('a reservation whose createdAtMs/expiresAtMs is 1e999 (parses to Infinity) is dropped, not trusted', () => {
    writeFileSync(
      filePath,
      '{"version":1,"spend":[],"reservations":[{"id":"pur-inf-ts","dayKey":"2026-08-19","itemMinorUnits":1,'
      + '"overageMinorUnits":0,"toleranceMinorUnits":0,"createdAtMs":1e999,"expiresAtMs":1e999}]}',
    );
    const { result: ledger, warnings } = withCapturedWarnings(() => new DurableBudgetLedger(filePath));
    expect(ledger.state().reservations).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test('a reservation whose expiresAtMs is 1e18 (past what Date can represent) is dropped, not trusted', () => {
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      spend: [],
      reservations: [{
        id: 'pur-huge-ts', dayKey: '2026-08-19', itemMinorUnits: 1, overageMinorUnits: 0,
        toleranceMinorUnits: 0, createdAtMs: 1, expiresAtMs: 1e18,
      }],
    }));
    const { result: ledger, warnings } = withCapturedWarnings(() => new DurableBudgetLedger(filePath));
    expect(ledger.state().reservations).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test('snapshot and reserve keep working after loading a file with a poisoned timestamp entry', () => {
    writeFileSync(
      filePath,
      '{"version":1,"spend":[{"purchaseId":"pur-inf-ts","atMs":1e999,"itemMinorUnits":500,'
      + '"overageMinorUnits":0,"toleranceMinorUnits":0}],"reservations":[]}',
    );
    // Before the fix, constructing this ledger loaded the poisoned record, and
    // the very first snapshot()/reserve() call afterward threw a RangeError
    // computing a day key from Infinity. Now the record is dropped at load, so
    // this is an ordinary call over what is, in effect, an empty ledger.
    const ledger = new DurableBudgetLedger(filePath);
    const snapshot = ledger.snapshot(LIMITS, Date.now(), 'UTC');
    expect(snapshot.item.spent).toBe(0);
    const reserved = ledger.reserve({
      id: 'pur-ok', itemMinorUnits: 1_000, overageMinorUnits: 0, toleranceMinorUnits: 0,
      limits: LIMITS, nowMs: Date.now(), timezone: 'UTC',
    });
    expect(reserved).not.toBeNull();
  });
});

describe('a disk write that fails on reserve rolls the reservation back rather than holding it', () => {
  function blockWrites(path: string): void {
    rmSync(path, { recursive: true, force: true });
    writeFileSync(path, 'a plain file standing where a directory needs to be');
  }

  function unblockWrites(path: string): void {
    rmSync(path, { force: true });
    mkdirSync(path, { recursive: true });
  }

  test('reserve throws when the write fails, and leaves remaining unchanged', () => {
    const ledger = new DurableBudgetLedger(filePath);

    blockWrites(dir);
    let threw = false;
    try {
      ledger.reserve({
        id: 'pur-1', itemMinorUnits: 3_000, overageMinorUnits: 0, toleranceMinorUnits: 0,
        limits: LIMITS, nowMs: Date.now(), timezone: 'UTC',
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    unblockWrites(dir);

    // Rolled back: nothing is held in memory either, so the full daily limit
    // is still available to a later reservation.
    expect(ledger.state().reservations).toHaveLength(0);
    const snapshot = ledger.snapshot(LIMITS, Date.now(), 'UTC');
    expect(snapshot.item.remaining).toBe(10_000);
  });
});

describe('prune runs once at construction, dropping spend the base class\'s own retention would refuse anyway', () => {
  test('a spend record older than two days is dropped when the ledger is constructed', () => {
    const old = Date.now() - 3 * 24 * 60 * 60 * 1000;
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      spend: [{ purchaseId: 'pur-old', atMs: old, itemMinorUnits: 500, overageMinorUnits: 0, toleranceMinorUnits: 0 }],
      reservations: [],
    }));
    const ledger = new DurableBudgetLedger(filePath);
    expect(ledger.state().spend).toHaveLength(0);
    // The prune's own persist ran too: the file on disk reflects the drop,
    // not only the in-memory state.
    const onDisk = JSON.parse(readFileSync(filePath, 'utf-8')) as { spend: unknown[] };
    expect(onDisk.spend).toHaveLength(0);
  });

  test('a recent spend record survives construction', () => {
    const recent = Date.now() - 60 * 60 * 1000;
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      spend: [{ purchaseId: 'pur-recent', atMs: recent, itemMinorUnits: 500, overageMinorUnits: 0, toleranceMinorUnits: 0 }],
      reservations: [],
    }));
    const ledger = new DurableBudgetLedger(filePath);
    expect(ledger.state().spend).toHaveLength(1);
    expect(ledger.state().spend[0]?.purchaseId).toBe('pur-recent');
  });
});

describe('a loaded file holding reservations discloses them at construction', () => {
  test('an info log names each held reservation\'s id, amounts, and dayKey', () => {
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      spend: [],
      reservations: [{
        id: 'pur-live', dayKey: '2026-08-19', itemMinorUnits: 1_000, overageMinorUnits: 200,
        toleranceMinorUnits: 0, createdAtMs: Date.now(), expiresAtMs: Date.now() + 1_000_000,
      }],
    }));
    const { infos } = withCapturedInfo(() => new DurableBudgetLedger(filePath));
    expect(infos.length).toBeGreaterThan(0);
    const reservationsLogged = infos
      .flatMap((entry) => (Array.isArray(entry.data?.['reservations']) ? entry.data['reservations'] as Array<{ id: string; dayKey: string }> : []));
    expect(reservationsLogged.some((entry) => entry.id === 'pur-live' && entry.dayKey === '2026-08-19')).toBe(true);
  });

  test('no info log is emitted for a file holding no reservations', () => {
    writeFileSync(filePath, JSON.stringify({ version: 1, spend: [], reservations: [] }));
    const { infos } = withCapturedInfo(() => new DurableBudgetLedger(filePath));
    expect(infos).toHaveLength(0);
  });
});
