/**
 * DaemonPurchaseLedger: append-only, newest first, and reconcilable.
 *
 * The interesting assertions are about what the ledger will NOT do: it exposes
 * no update and no delete, `total` counts the filter rather than the page, and a
 * row that arrived without `merchantDiscovered` reads as false rather than
 * acquiring a claim nothing observed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'bun:test';
import type { PurchaseRecord } from '../sdk/src/platform/payments/purchase-record.js';
import { DaemonPurchaseLedger, MAX_PURCHASE_LIST_LIMIT } from '../sdk/src/platform/payments/host/purchase-ledger.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

function purchase(overrides: Partial<PurchaseRecord> = {}): PurchaseRecord {
  return {
    purchaseId: 'pur-1',
    atUtc: '2026-08-19T10:00:00.000Z',
    dayKey: '2026-08-19',
    timezone: 'UTC',
    merchantDomain: 'example.invalid',
    item: 'a replacement kettle' as PurchaseRecord['item'],
    currency: 'USD' as PurchaseRecord['currency'],
    itemMinorUnits: 4599,
    taxMinorUnits: 380,
    feesMinorUnits: 0,
    shippingMinorUnits: 599,
    totalMinorUnits: 5578,
    shippingTierRequested: 'normal',
    shippingTierUsed: 'normal',
    steppedDown: false,
    itemPoolDraw: 4599,
    overagePoolDraw: 979,
    tolerancePoolDraw: 0,
    cardLast4: '1111',
    windowKind: 'veto',
    windowOutcome: 'proceeded',
    answeredBy: null,
    outcome: 'purchased',
    refusalReason: null,
    merchantOrderId: 'ORD-9',
    refundedAt: null,
    merchantRecognised: true,
    merchantQualifier: 'major-retailer',
    merchantDiscovered: false,
    ...overrides,
  };
}

let filePath = '';

beforeEach(() => {
  filePath = join(makeProjectTempDir('gv-payments-ledger'), 'payments-purchases.json');
});

describe('DaemonPurchaseLedger', () => {
  test('an absent ledger lists as empty rather than failing', () => {
    const ledger = new DaemonPurchaseLedger({ filePath });
    expect(ledger.list({ limit: 10, dayKey: undefined })).toEqual({ purchases: [], total: 0 });
  });

  test('a recorded purchase comes back whole', async () => {
    const ledger = new DaemonPurchaseLedger({ filePath });
    await ledger.record(purchase());
    const result = ledger.list({ limit: 10, dayKey: undefined });
    expect(result.total).toBe(1);
    expect(result.purchases[0]!.purchaseId).toBe('pur-1');
    expect(result.purchases[0]!.totalMinorUnits).toBe(5578);
    expect(result.purchases[0]!.cardLast4).toBe('1111');
  });

  test('a row carries no card material, only the last four digits', async () => {
    const ledger = new DaemonPurchaseLedger({ filePath });
    await ledger.record(purchase());
    const onDisk = readFileSync(filePath, 'utf-8');
    expect(onDisk).toContain('"cardLast4"');
    expect(onDisk).not.toContain('4111111111111111');
  });

  test('newest first, so a surface showing five shows the last five', async () => {
    const ledger = new DaemonPurchaseLedger({ filePath });
    for (const n of [1, 2, 3]) await ledger.record(purchase({ purchaseId: `pur-${String(n)}` }));
    const result = ledger.list({ limit: 10, dayKey: undefined });
    expect(result.purchases.map((row) => row.purchaseId)).toEqual(['pur-3', 'pur-2', 'pur-1']);
  });

  test('total counts the filter, not the page', async () => {
    const ledger = new DaemonPurchaseLedger({ filePath });
    for (const n of [1, 2, 3, 4, 5]) await ledger.record(purchase({ purchaseId: `pur-${String(n)}` }));
    const result = ledger.list({ limit: 2, dayKey: undefined });
    expect(result.purchases).toHaveLength(2);
    expect(result.total).toBe(5);
  });

  test('a dayKey filter narrows both the page and the total', async () => {
    const ledger = new DaemonPurchaseLedger({ filePath });
    await ledger.record(purchase({ purchaseId: 'pur-a', dayKey: '2026-08-18' }));
    await ledger.record(purchase({ purchaseId: 'pur-b', dayKey: '2026-08-19' }));
    await ledger.record(purchase({ purchaseId: 'pur-c', dayKey: '2026-08-19' }));
    const result = ledger.list({ limit: 10, dayKey: '2026-08-19' });
    expect(result.total).toBe(2);
    expect(result.purchases.map((row) => row.purchaseId)).toEqual(['pur-c', 'pur-b']);
  });

  test('the limit is clamped rather than trusted', async () => {
    const ledger = new DaemonPurchaseLedger({ filePath });
    await ledger.record(purchase());
    expect(ledger.list({ limit: 0, dayKey: undefined }).purchases).toHaveLength(1);
    expect(ledger.list({ limit: -5, dayKey: undefined }).purchases).toHaveLength(1);
    expect(ledger.list({ limit: MAX_PURCHASE_LIST_LIMIT * 10, dayKey: undefined }).purchases).toHaveLength(1);
  });

  test('a record with no merchantDiscovered reads as false, never as a claim', async () => {
    const ledger = new DaemonPurchaseLedger({ filePath });
    // A legacy row from before the field existed: strip it deliberately.
    const { merchantDiscovered: _dropped, ...legacy } = purchase();
    await ledger.record(legacy as PurchaseRecord);
    expect(ledger.list({ limit: 1, dayKey: undefined }).purchases[0]!.merchantDiscovered).toBe(false);
  });

  test('a record that states merchantDiscovered keeps it', async () => {
    const ledger = new DaemonPurchaseLedger({ filePath });
    await ledger.record({ ...purchase(), merchantDiscovered: true } as PurchaseRecord);
    expect(ledger.list({ limit: 1, dayKey: undefined }).purchases[0]!.merchantDiscovered).toBe(true);
  });

  test('records append: a second write never replaces the first', async () => {
    const ledger = new DaemonPurchaseLedger({ filePath });
    await ledger.record(purchase({ purchaseId: 'pur-1' }));
    await ledger.record(purchase({ purchaseId: 'pur-1', outcome: 'refunded' }));
    // Same id twice is two rows, not an edit. The row is evidence a purchase
    // happened, and evidence a later call can overwrite is not evidence.
    expect(ledger.list({ limit: 10, dayKey: undefined }).total).toBe(2);
  });

  test('a torn ledger file reads as empty rather than taking the daemon down', () => {
    writeFileSync(filePath, '{"version":1,"purchases":[{');
    expect(new DaemonPurchaseLedger({ filePath }).list({ limit: 10, dayKey: undefined }).total).toBe(0);
  });

  test('a file with no purchases array reads as empty', () => {
    writeFileSync(filePath, '{"version":1}');
    expect(new DaemonPurchaseLedger({ filePath }).list({ limit: 10, dayKey: undefined }).total).toBe(0);
  });

  test('a second ledger over the same path sees what the first wrote', async () => {
    await new DaemonPurchaseLedger({ filePath }).record(purchase());
    expect(new DaemonPurchaseLedger({ filePath }).list({ limit: 10, dayKey: undefined }).total).toBe(1);
  });
});
