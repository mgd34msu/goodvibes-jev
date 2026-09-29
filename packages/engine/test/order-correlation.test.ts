import { describe, expect, test } from 'bun:test';

import {
  correlatePurchaseMail,
  senderRegistrableDomain,
  extractConfirmationFacts,
} from '../sdk/src/platform/payments/order-correlation.js';
import type { PurchaseRecord } from '../sdk/src/platform/payments/purchase-record.js';
import { usePaymentsReadings, withPaymentsReadings } from './helpers/payments-readings.ts';

const readings = usePaymentsReadings();

/**
 * order-correlation.test.ts, converted from a reviewer's reproduction probe
 * (probe.ts) that showed `submitted-unverified` purchases, the ones whose own
 * report tells the owner "check your order history at this merchant", never
 * correlated with the merchant's confirmation mail at all: the filter in
 * `correlatePurchaseMail` accepted only `outcome === 'purchased'`, so a
 * default composition with no `describeSubmission` wired (every purchase it
 * records is `submitted-unverified`) got `unrelated` for every confirmation
 * email that ever arrived, however squarely it matched on domain and timing.
 */

const BASE: PurchaseRecord = {
  purchaseId: 'p1',
  atUtc: new Date(1_700_000_000_000).toISOString(),
  dayKey: '2023-11-14',
  timezone: 'UTC',
  merchantDomain: 'bestbuy.com',
  item: 'thing',
  currency: 'USD',
  itemMinorUnits: 100,
  taxMinorUnits: 0,
  feesMinorUnits: 0,
  shippingMinorUnits: 0,
  totalMinorUnits: 100,
  shippingTierRequested: 'standard',
  shippingTierUsed: 'standard',
  steppedDown: false,
  itemPoolDraw: 100,
  overagePoolDraw: 0,
  tolerancePoolDraw: 0,
  cardLast4: '4242',
  windowKind: 'veto',
  windowOutcome: 'proceeding-silent',
  answeredBy: null,
  outcome: 'purchased',
  refusalReason: null,
  merchantOrderId: null,
  refundedAt: null,
  merchantRecognised: true,
  merchantQualifier: 'major',
  merchantDiscovered: false,
};

const MAIL = {
  senderAddress: 'orders@bestbuy.com',
  receivedAtMs: 1_700_000_600_000,
  subject: 'Your order has been received',
  body: 'Thanks for your order. Order number BBY01-806512334: thing x1, total $1.00.',
};

describe('correlatePurchaseMail includes submitted-unverified records (BLOCKING 3)', () => {
  test('a purchased record still matches, exactly as before', async () => {
    const result = await correlatePurchaseMail(MAIL, [BASE]);
    expect(result.kind).toBe('matched');
    if (result.kind !== 'matched') throw new Error('unreachable');
    expect(result.record.purchaseId).toBe('p1');
    expect(result.senderDomain).toBe('bestbuy.com');
  });

  test('a submitted-unverified record now matches too, the regression this guards', async () => {
    const record: PurchaseRecord = { ...BASE, outcome: 'submitted-unverified' };
    const result = await correlatePurchaseMail(MAIL, [record]);
    // Before the fix this was `unrelated`: the filter accepted only
    // `outcome === 'purchased'`, so a default composition with no
    // describeSubmission wired (every one of its records is
    // submitted-unverified) never recognised its own confirmation mail.
    expect(result.kind).toBe('matched');
    if (result.kind !== 'matched') throw new Error('unreachable');
    expect(result.record.purchaseId).toBe('p1');
  });

  test('a match never rewrites the record: outcome and verified status are untouched', async () => {
    const record: PurchaseRecord = { ...BASE, outcome: 'submitted-unverified' };
    const result = await correlatePurchaseMail(MAIL, [record]);
    if (result.kind !== 'matched') throw new Error('expected a match');
    // Recognition, not re-verification: the stored outcome is exactly what was
    // recorded at submit time, whatever this mail says.
    expect(result.record.outcome).toBe('submitted-unverified');
    expect(result.record).toEqual(record);
  });

  test('a refused or cancelled purchase never correlates, and is not read: nothing was submitted', async () => {
    for (const outcome of ['refused', 'cancelled']) {
      const record: PurchaseRecord = { ...BASE, outcome };
      const result = await correlatePurchaseMail(MAIL, [record]);
      expect(result.kind).toBe('unrelated');
    }
    expect(readings.requests.filter((request) => request.context?.battery === 'engine.payments.order-mail')).toHaveLength(0);
  });

  test('two candidates the mail reads as about are ambiguous, never guessed', async () => {
    const first: PurchaseRecord = { ...BASE, purchaseId: 'p1', outcome: 'purchased' };
    const second: PurchaseRecord = { ...BASE, purchaseId: 'p2', outcome: 'submitted-unverified' };
    const result = await correlatePurchaseMail(MAIL, [first, second]);
    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') throw new Error('unreachable');
    expect(result.candidates.map((r) => r.purchaseId).sort()).toEqual(['p1', 'p2']);
  });

  test('a different registrable domain does not match, however similar it looks', async () => {
    const record: PurchaseRecord = { ...BASE, merchantDomain: 'bestbuy.com', outcome: 'submitted-unverified' };
    const result = await correlatePurchaseMail({ ...MAIL, senderAddress: 'orders@bestbuy.com.evil.test' }, [record]);
    expect(result.kind).toBe('unrelated');
  });

  test('a subdomain of the purchase domain still matches', async () => {
    const record: PurchaseRecord = { ...BASE, outcome: 'submitted-unverified' };
    const result = await correlatePurchaseMail({ ...MAIL, senderAddress: 'confirm@order-update.bestbuy.com' }, [record]);
    expect(result.kind).toBe('matched');
  });

  test('a same-domain mail the reading says is not about the order does not match', async () => {
    const record: PurchaseRecord = { ...BASE, outcome: 'submitted-unverified' };
    const promo = { ...MAIL, subject: 'Weekend deals', body: 'Up to 40% off TVs this weekend only.' };
    const result = await correlatePurchaseMail(promo, [record]);
    expect(result.kind).toBe('unrelated');
  });

  test('a shipping notice days later matches: there is no time window, only the reading', async () => {
    const record: PurchaseRecord = { ...BASE, outcome: 'purchased' };
    const later = { ...MAIL, receivedAtMs: 1_700_000_000_000 + 3 * 24 * 60 * 60 * 1000, subject: 'Your thing has shipped' };
    const result = await correlatePurchaseMail(later, [record]);
    expect(result.kind).toBe('matched');
  });

  test('the mail is read with card-shaped spans redacted', async () => {
    const record: PurchaseRecord = { ...BASE, outcome: 'purchased' };
    const withCard = { ...MAIL, body: `${MAIL.body} Paid with card 4111 1111 1111 1111.` };
    await correlatePurchaseMail(withCard, [record]);
    const asked = readings.requests.find((request) => request.context?.battery === 'engine.payments.order-mail');
    expect(JSON.stringify(asked?.state)).not.toContain('4111');
    expect(JSON.stringify(asked?.state)).toContain('[redacted:pan]');
  });

  test('mail predating the purchase does not match, however close it lands', async () => {
    const record: PurchaseRecord = { ...BASE, outcome: 'submitted-unverified' };
    const early = { ...MAIL, receivedAtMs: 1_699_999_999_999 };
    const result = await correlatePurchaseMail(early, [record]);
    expect(result.kind).toBe('unrelated');
  });

  test('senderRegistrableDomain reads the registrable domain of an address', () => {
    expect(senderRegistrableDomain('orders@bestbuy.com')).toBe('bestbuy.com');
    expect(senderRegistrableDomain('not-an-address')).toBeNull();
  });
});

describe('extractConfirmationFacts takes only what the readings pick', () => {
  const CONFIRMATION = {
    subject: 'Order confirmation',
    body: 'Confirmation number: BBY-01-556677. Tracking number 1Z999AA10123456784. Call 1-800-433-7200.',
    receivedAtMs: Date.parse('2026-08-18T10:00:00Z'),
  };

  test('the order number and tracking reference are the picked candidates', async () => {
    const facts = await extractConfirmationFacts(CONFIRMATION);
    expect(facts.orderNumber).toBe('BBY-01-556677');
    expect(facts.trackingReference).toBe('1Z999AA10123456784');
  });

  test('the ship date is the date the reading assembles, as YYYY-MM-DD', async () => {
    const facts = await withPaymentsReadings({ shipDate: () => '2026-08-20' }, () => extractConfirmationFacts(CONFIRMATION));
    expect(facts.shipDate).toBe('2026-08-20');
  });

  test('a reading that picks nothing leaves the fact null rather than guessing', async () => {
    const facts = await withPaymentsReadings({ identifier: () => null }, () => extractConfirmationFacts(CONFIRMATION));
    expect(facts.orderNumber).toBeNull();
    expect(facts.trackingReference).toBeNull();
    expect(facts.shipDate).toBeNull();
  });

  test('a mail with no identifier-shaped token asks no identifier reading', async () => {
    await extractConfirmationFacts({ ...CONFIRMATION, body: 'Thanks for shopping with us.' });
    const batteries = readings.requests.map((request) => request.context?.battery);
    expect(batteries).not.toContain('engine.payments.order-number');
    expect(batteries).not.toContain('engine.payments.tracking-reference');
  });

  test('candidates past one choice\'s limit are offered in groups and every token is considered', async () => {
    const filler = Array.from({ length: 300 }, (_, index) => `SKU${1000 + index}`).join(' ');
    const facts = await extractConfirmationFacts({ ...CONFIRMATION, body: `${filler} Confirmation number: BBY-01-556677.` });
    expect(facts.orderNumber).toBe('BBY-01-556677');
  });
});
