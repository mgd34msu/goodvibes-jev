/**
 * DurableCheckoutJournal: the property under test is durability with opaque
 * cargo. A `submit-pending` record written before a crash must come back
 * byte-faithfully after a restart (that record is the one thing that lets a
 * restart say "this purchase may already have been submitted"), fields this
 * build has never heard of must round-trip untouched (the 2.0.20 repin's
 * recovery reads what its writer put here, not what this file knew to keep),
 * and a damaged file must warn and start empty rather than take the daemon
 * down or invent state.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'bun:test';
import type { InFlightCheckout } from '../sdk/src/platform/payments/checkout-registry.js';
import { DurableCheckoutJournal } from '../sdk/src/platform/payments/host/checkout-journal-store.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

function record(overrides: Partial<InFlightCheckout> = {}): InFlightCheckout {
  return {
    purchaseId: 'pur-journal-1',
    sessionId: 'session-1',
    pageId: 'page-1',
    merchantDomain: 'example.invalid',
    cardId: 'card-1',
    item: 'a replacement kettle' as InFlightCheckout['item'],
    currency: 'USD' as InFlightCheckout['currency'],
    phase: 'submit-pending',
    startedAtMs: 1_766_000_000_000,
    updatedAtMs: 1_766_000_060_000,
    draw: null,
    reservationId: 'res-1',
    shippingTierRequested: 'normal',
    shippingTierUsed: 'normal',
    stepDown: null,
    totalMinorUnits: 5578,
    ...overrides,
  };
}

let dir = '';
let filePath = '';

beforeEach(() => {
  dir = makeProjectTempDir('gv-checkout-journal');
  filePath = join(dir, 'payments-checkout-journal.json');
});

describe('DurableCheckoutJournal: durable before put resolves', () => {
  test('a put record is on disk before the promise resolves, not merely in memory', async () => {
    const journal = new DurableCheckoutJournal(filePath);
    await journal.put(record());
    // Read the FILE, not the instance: this is the flush the submit-pending
    // guarantee rides on.
    expect(existsSync(filePath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(filePath, 'utf-8')) as { records: Record<string, unknown>[] };
    expect(onDisk.records).toHaveLength(1);
    expect(onDisk.records[0]!['purchaseId']).toBe('pur-journal-1');
    expect(onDisk.records[0]!['phase']).toBe('submit-pending');
  });

  test('a submit-pending record survives a restart byte-faithfully', async () => {
    const before = new DurableCheckoutJournal(filePath);
    await before.put(record());

    // A new instance over the same file IS the restart.
    const after = new DurableCheckoutJournal(filePath);
    const restored = await after.list();
    expect(restored).toHaveLength(1);
    expect(restored[0]).toEqual(record());
  });

  test('remove drops the record from disk, so a finished checkout is not reported after a restart', async () => {
    const journal = new DurableCheckoutJournal(filePath);
    await journal.put(record());
    await journal.put(record({ purchaseId: 'pur-journal-2', pageId: 'page-2' }));
    await journal.remove('pur-journal-1');

    const after = new DurableCheckoutJournal(filePath);
    const restored = await after.list();
    expect(restored).toHaveLength(1);
    expect(restored[0]!.purchaseId).toBe('pur-journal-2');
  });

  test('a second put for the same purchaseId replaces the record, as a phase advance does', async () => {
    const journal = new DurableCheckoutJournal(filePath);
    await journal.put(record({ phase: 'arming-payment' }));
    await journal.put(record({ phase: 'submit-pending' }));
    const listed = await journal.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.phase).toBe('submit-pending');
  });
});

describe('DurableCheckoutJournal: unknown fields are opaque cargo', () => {
  test('fields this build has never seen round-trip untouched through a restart', async () => {
    // The shape the 2.0.20 repin may add (a deliveries field is the named
    // candidate), simulated as any extra keys: the journal must persist and
    // reload them without knowing what they are.
    const withUnknown = {
      ...record(),
      deliveries: [{ carrier: 'ups', trackingNumber: '1Z999', deliveredAt: null }],
      someFutureFlag: true,
    } as unknown as InFlightCheckout;
    const before = new DurableCheckoutJournal(filePath);
    await before.put(withUnknown);

    const after = new DurableCheckoutJournal(filePath);
    const restored = await after.list();
    expect(restored).toHaveLength(1);
    expect(restored[0]).toEqual(withUnknown);
    const raw = restored[0] as unknown as Record<string, unknown>;
    expect(raw['deliveries']).toEqual([{ carrier: 'ups', trackingNumber: '1Z999', deliveredAt: null }]);
    expect(raw['someFutureFlag']).toBe(true);
  });
});

describe('DurableCheckoutJournal: corruption warns and starts empty', () => {
  test('a file that is not JSON starts empty rather than throwing', async () => {
    writeFileSync(filePath, 'not json at all {', 'utf-8');
    const journal = new DurableCheckoutJournal(filePath);
    expect(await journal.list()).toHaveLength(0);
    // Still usable: the next put overwrites the damaged file.
    await journal.put(record());
    expect((await new DurableCheckoutJournal(filePath).list())).toHaveLength(1);
  });

  test('a file holding the wrong shape starts empty rather than guessing', async () => {
    writeFileSync(filePath, JSON.stringify({ version: 1, records: 'not-an-array' }), 'utf-8');
    const journal = new DurableCheckoutJournal(filePath);
    expect(await journal.list()).toHaveLength(0);
  });

  test('entries without a purchaseId are dropped; the rest are kept', async () => {
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      records: [record(), { phase: 'submit-pending', noId: true }],
    }), 'utf-8');
    const journal = new DurableCheckoutJournal(filePath);
    const listed = await journal.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.purchaseId).toBe('pur-journal-1');
  });

  test('a missing file is the ordinary first boot: empty, no file created until a put', async () => {
    const journal = new DurableCheckoutJournal(filePath);
    expect(await journal.list()).toHaveLength(0);
    expect(existsSync(filePath)).toBe(false);
  });
});

describe('DurableCheckoutJournal: concurrent writes land through the atomic write', () => {
  test('many concurrent puts leave one parseable file holding every record', async () => {
    const journal = new DurableCheckoutJournal(filePath);
    await Promise.all(
      Array.from({ length: 20 }, (unused, index) =>
        journal.put(record({ purchaseId: `pur-concurrent-${String(index)}`, pageId: `page-${String(index)}` }))),
    );
    // The file parses (an interleaved non-atomic write would tear it) and a
    // restart sees all twenty.
    const restored = await new DurableCheckoutJournal(filePath).list();
    expect(restored).toHaveLength(20);
    const ids = restored.map((entry) => entry.purchaseId).sort();
    expect(new Set(ids).size).toBe(20);
  });

  test('interleaved puts and removes settle to exactly the surviving records', async () => {
    const journal = new DurableCheckoutJournal(filePath);
    await Promise.all([
      journal.put(record({ purchaseId: 'pur-a' })),
      journal.put(record({ purchaseId: 'pur-b' })),
      journal.put(record({ purchaseId: 'pur-c' })),
    ]);
    await Promise.all([journal.remove('pur-b'), journal.put(record({ purchaseId: 'pur-d' }))]);
    const restored = await new DurableCheckoutJournal(filePath).list();
    expect(restored.map((entry) => entry.purchaseId).sort()).toEqual(['pur-a', 'pur-c', 'pur-d']);
  });
});
