import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  reapMissingRoutineScheduleReceipts,
  reconcileRoutineScheduleReceipts,
  RoutineScheduleReceiptStore,
} from '../../agent/routine-schedule-receipts.ts';
import {
  ROUTINE_SCHEDULE_LIST_METHOD,
  ROUTINE_SCHEDULE_METHOD,
  ROUTINE_SCHEDULE_ROUTE,
  type RoutineScheduleCorrelation,
  type RoutineScheduleCorrelationResult,
  type RoutineScheduleReceipt,
} from '../../agent/routine-schedule-promotion.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { leftoverStoreTempFiles } from '../helpers/store-temp-files.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_URL = 'http://127.0.0.1:7317';

function withStorePath<T>(fn: (storePath: string) => T): T {
  const root = makeProjectTempDir('gv-routine-schedule-receipts');
  try {
    return fn(join(root, 'schedule-receipts.json'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function withStorePathAsync<T>(fn: (storePath: string) => Promise<T>): Promise<T> {
  const root = makeProjectTempDir('gv-routine-schedule-receipts');
  try {
    return await fn(join(root, 'schedule-receipts.json'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function makeReceipt(id: string, createdAtMs: number, scheduleId = `sched-${id}`): RoutineScheduleReceipt {
  return {
    id,
    createdAt: new Date(createdAtMs).toISOString(),
    routineId: `routine-${id}`,
    routineName: `Routine ${id}`,
    route: ROUTINE_SCHEDULE_ROUTE,
    method: ROUTINE_SCHEDULE_METHOD,
    status: 'created',
    connectedHostBaseUrl: BASE_URL,
    scheduleId,
    scheduleName: `Routine ${id}`,
    scheduleKind: 'cron',
    scheduleValue: '0 9 * * *',
    enabled: true,
    target: {},
  };
}

function writeStoreFile(storePath: string, receipts: readonly RoutineScheduleReceipt[]): void {
  writeFileSync(storePath, `${JSON.stringify({ version: 1, receipts }, null, 2)}\n`, 'utf-8');
}

function missingCorrelation(receipt: RoutineScheduleReceipt): RoutineScheduleCorrelation {
  return { receipt, liveStatus: 'missing', matchReason: 'not-found' };
}

function listedResult(correlations: readonly RoutineScheduleCorrelation[], scheduleCount = 0): RoutineScheduleCorrelationResult {
  return {
    ok: true,
    kind: ROUTINE_SCHEDULE_LIST_METHOD,
    route: ROUTINE_SCHEDULE_ROUTE,
    baseUrl: BASE_URL,
    scheduleCount,
    receiptCount: correlations.length,
    correlations,
  };
}

function unreachableResult(): RoutineScheduleCorrelationResult {
  return {
    ok: false,
    kind: 'connected_host_unavailable',
    error: 'fetch failed: ECONNREFUSED',
    route: ROUTINE_SCHEDULE_ROUTE,
    baseUrl: BASE_URL,
  };
}

describe('routine schedule receipt store housekeeping', () => {
  test('degrades a zero-byte store to no receipts instead of throwing', () => {
    withStorePath((storePath) => {
      writeFileSync(storePath, '');
      const store = new RoutineScheduleReceiptStore(storePath);
      expect(() => store.snapshot()).not.toThrow();
      expect(store.snapshot().receipts).toHaveLength(0);
      expect(store.lastMaintenance()?.recovered).toBe('empty-file');
    });
  });

  test('degrades a crash-truncated store to no receipts, preserving the bad file aside', () => {
    withStorePath((storePath) => {
      writeFileSync(storePath, '{"version":1,"receipts":[{"id":"routine-a","createdAt":"2026-07-0');
      const store = new RoutineScheduleReceiptStore(storePath);

      expect(store.snapshot().receipts).toHaveLength(0);
      expect(store.lastMaintenance()?.recovered).toBe('quarantined');
      expect(existsSync(`${storePath}.corrupt`)).toBe(true);
      expect(existsSync(storePath)).toBe(false);
    });
  });

  test('expires receipts past the age TTL while recent ones survive, and persists the prune', () => {
    withStorePath((storePath) => {
      const now = Date.now();
      writeStoreFile(storePath, [
        makeReceipt('old-a', now - 120 * DAY_MS),
        makeReceipt('old-b', now - 100 * DAY_MS),
        makeReceipt('recent', now - 2 * DAY_MS),
      ]);

      const store = new RoutineScheduleReceiptStore(storePath, 200, 90 * DAY_MS);
      const snapshot = store.snapshot();

      expect(snapshot.receipts.map((receipt) => receipt.id)).toEqual(['recent']);
      expect(store.lastMaintenance()?.expired).toBe(2);
      expect(store.lastMaintenance()?.kept).toBe(1);

      const persisted = JSON.parse(readFileSync(storePath, 'utf-8')) as { readonly receipts: readonly { readonly id: string }[] };
      expect(persisted.receipts.map((receipt) => receipt.id)).toEqual(['recent']);
    });
  });

  test('applies the count cap and is a no-op the second time', () => {
    withStorePath((storePath) => {
      const now = Date.now();
      writeStoreFile(storePath, Array.from({ length: 8 }, (_, index) => makeReceipt(`r${index}`, now - (8 - index) * 1000)));

      const store = new RoutineScheduleReceiptStore(storePath, 3, 90 * DAY_MS);
      expect(store.snapshot().receipts.map((receipt) => receipt.id)).toEqual(['r7', 'r6', 'r5']);
      expect(store.lastMaintenance()?.overflow).toBe(5);

      const afterFirst = readFileSync(storePath, 'utf-8');
      expect(store.snapshot().receipts).toHaveLength(3);
      expect(store.lastMaintenance()?.overflow).toBe(0);
      expect(store.lastMaintenance()?.expired).toBe(0);
      expect(readFileSync(storePath, 'utf-8')).toBe(afterFirst);
    });
  });

  test('reaps a receipt whose schedule the connected host authoritatively does not list', () => {
    withStorePath((storePath) => {
      const now = Date.now();
      const stale = makeReceipt('gone', now - 2 * DAY_MS);
      const live = makeReceipt('present', now - 2 * DAY_MS);
      writeStoreFile(storePath, [stale, live]);

      const store = new RoutineScheduleReceiptStore(storePath);
      const result = listedResult([
        missingCorrelation(stale),
        { receipt: live, liveStatus: 'matched', matchReason: 'schedule-id' },
      ], 1);

      const reaping = reapMissingRoutineScheduleReceipts(store, result, now);
      expect(reaping.authoritative).toBe(true);
      expect(reaping.reaped).toBe(1);
      expect(store.snapshot().receipts.map((receipt) => receipt.id)).toEqual(['present']);

      // Idempotent: the same authoritative answer removes nothing the second time.
      const again = reapMissingRoutineScheduleReceipts(store, result, now);
      expect(again.reaped).toBe(0);
      expect(store.snapshot().receipts.map((receipt) => receipt.id)).toEqual(['present']);
    });
  });

  test('never reaps when the connected host is unreachable', () => {
    withStorePath((storePath) => {
      const now = Date.now();
      writeStoreFile(storePath, [makeReceipt('gone', now - 2 * DAY_MS)]);

      const store = new RoutineScheduleReceiptStore(storePath);
      const reaping = reapMissingRoutineScheduleReceipts(store, unreachableResult(), now);

      expect(reaping.authoritative).toBe(false);
      expect(reaping.reaped).toBe(0);
      expect(store.snapshot().receipts.map((receipt) => receipt.id)).toEqual(['gone']);
    });
  });

  test('leaves a just-created receipt alone even when the host does not list it yet', () => {
    withStorePath((storePath) => {
      const now = Date.now();
      const fresh = makeReceipt('brand-new', now - 5_000);
      writeStoreFile(storePath, [fresh]);

      const store = new RoutineScheduleReceiptStore(storePath);
      const reaping = reapMissingRoutineScheduleReceipts(store, listedResult([missingCorrelation(fresh)]), now);

      expect(reaping.authoritative).toBe(true);
      expect(reaping.reaped).toBe(0);
      expect(reaping.withinGrace).toBe(1);
      expect(store.snapshot().receipts.map((receipt) => receipt.id)).toEqual(['brand-new']);
    });
  });

  test('reconcile without an operator token reaps nothing', async () => {
    await withStorePathAsync(async (storePath) => {
      const now = Date.now();
      writeStoreFile(storePath, [makeReceipt('gone', now - 2 * DAY_MS)]);
      const store = new RoutineScheduleReceiptStore(storePath);

      const result = await reconcileRoutineScheduleReceipts(
        { baseUrl: BASE_URL, token: null, tokenPath: join(storePath, '..', 'operator-token') },
        store.snapshot(),
      );

      expect(result.ok).toBe(false);
      expect(store.snapshot().receipts.map((receipt) => receipt.id)).toEqual(['gone']);
    });
  });

  test('writes through a private temp file and leaves none behind', () => {
    withStorePath((storePath) => {
      const now = Date.now();
      writeStoreFile(storePath, Array.from({ length: 5 }, (_, index) => makeReceipt(`r${index}`, now - (5 - index) * 1000)));
      const store = new RoutineScheduleReceiptStore(storePath, 2, 90 * DAY_MS);
      expect(store.snapshot().receipts).toHaveLength(2);
      expect(leftoverStoreTempFiles(storePath)).toEqual([]);
    });
  });
});
