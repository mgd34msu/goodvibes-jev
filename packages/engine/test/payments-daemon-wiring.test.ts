/**
 * payments-daemon-wiring.test.ts, the two links between "the flow exists" and
 * "the flow runs".
 *
 * Both were the same shape of gap as the one that made `runCheckout`
 * unreachable: a complete, tested component with nothing constructing it.
 *
 *  1. `PaymentsServiceConfig` had the right fields and nothing built it from
 *     the real config manager, so a budget the owner typed did nothing.
 *  2. `MerchantJudgePort` had a criterion and a contract and nothing asked
 *     anything, so "determine if it is reputable" always resolved to "I could
 *     not form a judgement". It is now the Jev merchant reading.
 */
import { describe, expect, test } from 'bun:test';

import {
  readBudgetLimits,
  readCvvHandling,
  readMerchantPolicy,
  readNotifyChannels,
  readPaymentsServiceConfig,
  type PaymentsConfigReader,
} from '../sdk/src/platform/payments/payments-config.js';
import { createJevMerchantJudge } from '../sdk/src/platform/payments/merchant-judge-model.js';
import { MERCHANT_RECOURSE_CRITERION } from '../sdk/src/platform/payments/merchant-recourse.js';
import { usePaymentsReadings, withPaymentsReadings } from './helpers/payments-readings.ts';

/** A config manager standing on a plain map, so a test can set one key. */
function config(values: Record<string, unknown>): PaymentsConfigReader {
  return { get: (key: string) => values[key] };
}

describe('the service configuration is read from live config', () => {
  test('an empty config yields a daemon that refuses rather than one with invented limits', () => {
    const resolved = readPaymentsServiceConfig(config({}));
    // Zero item budget is a terminal refusal in decidePurchase. A daemon nobody
    // has configured must not inherit a spending limit from a default.
    expect(resolved.limits.dailyItemMinorUnits).toBe(0);
    expect(String(resolved.budgetCurrency)).toBe('USD');
    expect(resolved.timezone).toBe('UTC');
    expect(resolved.preferredTier).toBe('normal');
  });

  test('every field comes from its key', () => {
    const resolved = readPaymentsServiceConfig(config({
      'payments.currency': 'GBP',
      'daemon.timezone': 'America/Detroit',
      'payments.shipping.preferredTier': 'fastest',
      'payments.budget.dailyItem': 250,
      'payments.budget.dailyOverage': 40,
      'payments.windows.approvalMinutes': 45,
      'payments.windows.vetoMinutes': 15,
    }));

    expect(String(resolved.budgetCurrency)).toBe('GBP');
    expect(resolved.timezone).toBe('America/Detroit');
    expect(resolved.preferredTier).toBe('fastest');
    expect(resolved.limits.dailyItemMinorUnits).toBe(25_000);
    expect(resolved.limits.dailyOverageMinorUnits).toBe(4_000);
    expect(resolved.approvalMinutes).toBe(45);
    expect(resolved.vetoMinutes).toBe(15);
  });

  test('the timezone key is the one the owner profile writes', () => {
    // owner-profile/consumers.ts maps location.timezone onto daemon.timezone.
    // Reading the KEY rather than the profile keeps one consumer and means a
    // machine with no profile still has a definite day boundary.
    expect(readPaymentsServiceConfig(config({ 'daemon.timezone': 'Europe/Berlin' })).timezone)
      .toBe('Europe/Berlin');
  });

  test('a mid-session change is visible on the next read, because nothing is cached', () => {
    const values: Record<string, unknown> = { 'payments.budget.dailyItem': 100 };
    const reader = config(values);
    expect(readPaymentsServiceConfig(reader).limits.dailyItemMinorUnits).toBe(10_000);
    // He raises it in the settings UI while a session is open.
    values['payments.budget.dailyItem'] = 900;
    expect(readPaymentsServiceConfig(reader).limits.dailyItemMinorUnits).toBe(90_000);
  });

  test('the amount is an amount of the configured currency, whatever its smallest division is', () => {
    // 500 with USD is 500 dollars -> 50000 hundredths.
    expect(readBudgetLimits(config({ 'payments.budget.dailyItem': 500 }), 'USD').dailyItemMinorUnits)
      .toBe(50_000);
    // JPY has no smaller division: 500 is 500 yen -> 500.
    expect(readBudgetLimits(config({ 'payments.budget.dailyItem': 500 }), 'JPY').dailyItemMinorUnits)
      .toBe(500);
    // BHD has three: 500 is 500 dinar -> 500000 fils.
    expect(readBudgetLimits(config({ 'payments.budget.dailyItem': 500 }), 'BHD').dailyItemMinorUnits)
      .toBe(500_000);
  });

  test('a decimal amount lands on an exact whole count, with no floating-point dust', () => {
    // 19.99 * 100 is 1998.9999999999998 as a bare multiply; the reader rounds
    // once so the limit is exactly 1999.
    expect(readBudgetLimits(config({ 'payments.budget.dailyItem': 19.99 }), 'USD').dailyItemMinorUnits)
      .toBe(1999);
    expect(readBudgetLimits(config({ 'payments.budget.perPurchaseCeiling': 0.29 }), 'USD').perPurchaseCeiling.minorUnits)
      .toBe(29);
  });

  test('an amount hand-written into the file as text reads the same as one set through a surface', () => {
    expect(readBudgetLimits(config({ 'payments.budget.dailyItem': '$250.50' }), 'USD').dailyItemMinorUnits)
      .toBe(25_050);
  });

  test('the safe defaults ship: ceiling ON, tolerance OFF with nothing allowed', () => {
    const limits = readBudgetLimits(config({}), 'USD');
    expect(limits.perPurchaseCeiling.enabled).toBe(true);
    expect(limits.overageTolerance.enabled).toBe(false);
    expect(limits.overageTolerance.dailyAllowanceMinorUnits).toBe(0);
  });

  test('a malformed setting falls back rather than being coerced', () => {
    const limits = readBudgetLimits(config({
      'payments.budget.dailyItem': -500,
      'payments.budget.dailyOverage': 'lots',
    }), 'USD');
    // Neither becomes a spending limit. Rounding or coercing someone's budget
    // is how a limit stops meaning what the person who typed it believes.
    expect(limits.dailyItemMinorUnits).toBe(0);
    expect(limits.dailyOverageMinorUnits).toBe(0);
  });

  test('cvvHandling and notify channels are read', () => {
    expect(readCvvHandling(config({}))).toBe('stored');
    expect(readCvvHandling(config({ 'payments.cvvHandling': 'prompt' }))).toBe('prompt');
    expect(readNotifyChannels(config({ 'payments.notifyChannels': 'telegram, tui' })))
      .toEqual(['telegram', 'tui']);
  });

  test('the owner\'s merchant overrides are read from his keys', () => {
    const policy = readMerchantPolicy(config({
      'payments.majorRetailersAdditional': 'microcenter.com, redbubble.com',
      'payments.majorRetailersExcluded': 'jeffsgadgets.biz',
    }));
    expect(JSON.stringify(policy)).toContain('microcenter.com');
    expect(JSON.stringify(policy)).toContain('jeffsgadgets.biz');
  });
});

// ═══ The judge ═════════════════════════════════════════════════════════════

describe('the merchant judgement is the Jev merchant reading', () => {
  const readings = usePaymentsReadings();
  const judge = createJevMerchantJudge();

  test('the reading sees the domain and nothing else, and asks the criterion', async () => {
    await judge.judge({ registrableDomain: 'bestbuy.com' });
    expect(readings.requests).toHaveLength(1);
    const request = readings.requests[0]!;
    // The ONLY variable content. A page title, seller name or review count in
    // here would be the merchant writing its own reference.
    expect(request.state).toEqual({ registrable_domain: 'bestbuy.com' });
    expect(request.context?.battery).toBe('engine.payments.merchant');
    expect(JSON.stringify(request.questions['qualifies'])).toContain('Size is not the test');
    expect(MERCHANT_RECOURSE_CRITERION).toContain('recourse');
  });

  test('a confident qualifying reading is a confident yes, with the recourse named', async () => {
    const verdict = await judge.judge({ registrableDomain: 'bestbuy.com' });
    expect(verdict).toEqual({
      qualifies: true,
      confident: true,
      recourse: 'an established retailer that stands behind its sales with a returns process',
      marketplace: 'none',
    });
  });

  test('a marketplace kind comes from the recourse reading', async () => {
    expect((await judge.judge({ registrableDomain: 'etsy.com' })).marketplace).toBe('buyer-protection');
    expect((await judge.judge({ registrableDomain: 'ebay.com' })).marketplace).toBe('per-seller');
  });

  test('a confident no is a confident not-qualifying judgement', async () => {
    const verdict = await judge.judge({ registrableDomain: 'jeffsgadgets.biz' });
    expect(verdict.qualifies).toBe(false);
    expect(verdict.confident).toBe(true);
  });

  test('a reading that does not act is not confident, and carries no marketplace kind', async () => {
    const verdict = await withPaymentsReadings(
      { merchant: () => ({ qualifies: true, recourse: 'per-seller', unsure: true }) },
      () => judge.judge({ registrableDomain: 'unknown.example' }),
    );
    // classifyMerchant treats unconfident as not-major, so this resolves to an
    // approval where silence denies.
    expect(verdict.confident).toBe(false);
    expect(verdict.marketplace).toBeUndefined();
  });

  test('a yes with no recourse named is a contradiction, read as not confident', async () => {
    const verdict = await withPaymentsReadings(
      { merchant: () => ({ qualifies: true, recourse: 'none' }) },
      () => judge.judge({ registrableDomain: 'odd.example' }),
    );
    expect(verdict.qualifies).toBe(false);
    expect(verdict.confident).toBe(false);
  });

  test('an empty domain is not asked about at all', async () => {
    const verdict = await judge.judge({ registrableDomain: '   ' });
    expect(readings.requests).toHaveLength(0);
    expect(verdict.qualifies).toBe(false);
    expect(verdict.confident).toBe(false);
  });
});
