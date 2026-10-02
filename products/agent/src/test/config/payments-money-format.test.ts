/**
 * Tests for money-field detection: SDK 2.0.5 removed the `Cents` suffix and
 * the minor-unit storage, so the only thing left for this repo to get right
 * is identifying a money field from the schema's `unit: 'money'` mark rather
 * than the key's name.
 */
import { describe, test, expect } from 'bun:test';
import { CONFIG_SCHEMA } from '@goodvibes-jev/engine/sdk/platform/config';
import { isMoneyConfigKey } from '../../config/payments-money-format.ts';

function settingFor(key: string) {
  const setting = CONFIG_SCHEMA.find((entry) => entry.key === key);
  if (!setting) throw new Error(`No CONFIG_SCHEMA entry for ${key}`);
  return setting;
}

describe('isMoneyConfigKey', () => {
  test('matches every payments.budget.* amount key via the schema unit mark', () => {
    expect(isMoneyConfigKey(settingFor('payments.budget.dailyItem'))).toBe(true);
    expect(isMoneyConfigKey(settingFor('payments.budget.dailyOverage'))).toBe(true);
    expect(isMoneyConfigKey(settingFor('payments.budget.perPurchaseCeiling'))).toBe(true);
    expect(isMoneyConfigKey(settingFor('payments.budget.overageToleranceDailyAllowance'))).toBe(true);
  });

  test('does not match a key that merely lives under payments.* but holds no amount', () => {
    expect(isMoneyConfigKey(settingFor('payments.currency'))).toBe(false);
    expect(isMoneyConfigKey(settingFor('payments.cvvHandling'))).toBe(false);
    expect(isMoneyConfigKey(settingFor('payments.windows.vetoMinutes'))).toBe(false);
    expect(isMoneyConfigKey(settingFor('payments.budget.perPurchaseCeilingEnabled'))).toBe(false);
  });

});
