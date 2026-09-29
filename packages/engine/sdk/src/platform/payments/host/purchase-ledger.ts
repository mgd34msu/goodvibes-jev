/**
 * purchase-ledger.ts, the durable audit ledger behind `payments.purchases.list`.
 *
 * The SDK declares `PurchaseLedger` as a one-method write port
 * (platform/payments/checkout-flow.ts) and ships no implementation, for the same
 * reason it ships no card store: the flow must be drivable in a test with an
 * in-memory ledger, so the durable one belongs to whoever actually runs it. This
 * is that one.
 *
 * Append-only by construction. There is no update and no delete: the row is the
 * evidence a purchase happened, and a ledger a later call can edit is not
 * evidence of anything. A refund is recorded on the row as `refundedAt` by the
 * flow that observes it, and credits no pool, see the descriptor.
 *
 * ── `merchantDiscovered` ──────────────────────────────────────────────────
 *
 * The control-plane view requires it and `PurchaseRecord` does not carry it, so
 * a row written by a flow that did not state it reads as `false`, "the owner
 * named this storefront". That is the conservative direction: `true` is the
 * flag that says a storefront was found while browsing, and inventing it would
 * put a claim in the audit trail that nothing observed.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWriteFileSync } from '../../config/atomic-write.js';
import type { PurchaseLedger } from '../payment-ports.js';
import type { PurchaseRecord } from '../purchase-record.js';

/** A stored row: the SDK record plus the one view field it does not declare. */
export interface StoredPurchase extends PurchaseRecord {
  readonly merchantDiscovered: boolean;
}

const PURCHASES_FILE_VERSION = 1;

/** Hard ceiling on rows the list verb will hand back in one call. */
export const MAX_PURCHASE_LIST_LIMIT = 500;

interface PurchasesFile {
  readonly version: number;
  readonly purchases: readonly StoredPurchase[];
}

function readPurchasesFile(filePath: string): StoredPurchase[] {
  if (!existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<PurchasesFile>;
    return Array.isArray(parsed.purchases) ? [...parsed.purchases] : [];
  } catch {
    // A torn ledger file reads as an empty one rather than taking the daemon
    // down. It is reported as empty, not as an error, because every other verb
    // on this daemon is unrelated to it and refusing to boot would take them
    // all with it.
    return [];
  }
}

export interface DaemonPurchaseLedgerOptions {
  readonly filePath: string;
}

export interface PurchaseListQuery {
  readonly limit: number;
  readonly dayKey: string | undefined;
}

/**
 * The daemon's purchase ledger.
 *
 * Implements the SDK's `PurchaseLedger` write port, so the checkout flow can be
 * handed this object unchanged once `payments.checkout.begin` has a page driver
 * to run against, and adds the read half the `payments.purchases.list` verb needs.
 */
export class DaemonPurchaseLedger implements PurchaseLedger {
  private readonly filePath: string;

  constructor(options: DaemonPurchaseLedgerOptions) {
    this.filePath = options.filePath;
  }

  /** Append one purchase. The only write this class performs. */
  async record(entry: PurchaseRecord): Promise<void> {
    const discovered = (entry as { merchantDiscovered?: unknown }).merchantDiscovered;
    const row: StoredPurchase = { ...entry, merchantDiscovered: discovered === true };
    const rows = [...readPurchasesFile(this.filePath), row];
    mkdirSync(dirname(this.filePath), { recursive: true });
    const contents: PurchasesFile = { version: PURCHASES_FILE_VERSION, purchases: rows };
    atomicWriteFileSync(this.filePath, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 });
  }

  /**
   * The most recent purchases first, optionally narrowed to one calendar day.
   *
   * `total` is the number of rows matching the FILTER, not the number returned,
   * so a surface showing 100 of 340 can say so instead of implying there are
   * only 100.
   */
  list(query: PurchaseListQuery): { purchases: readonly StoredPurchase[]; total: number } {
    const rows = readPurchasesFile(this.filePath);
    const matching = query.dayKey === undefined
      ? rows
      : rows.filter((row) => row.dayKey === query.dayKey);
    const limit = Math.min(Math.max(1, Math.floor(query.limit)), MAX_PURCHASE_LIST_LIMIT);
    return {
      purchases: [...matching].reverse().slice(0, limit),
      total: matching.length,
    };
  }
}
