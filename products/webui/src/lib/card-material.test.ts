import { expect, test } from 'bun:test';
import { isDeclaredCardMaterialKey, isCardMaterialKey } from './card-material';
import { buildSettingsModel } from './settings-model';

test('declared card-entry fields are excluded even when a caller offers clearance', () => {
  const keys = ['payments.cardNumber', 'payments.cardExpiry', 'payments.cardCvv', 'payments.cardholderName'];
  for (const key of keys) expect(isDeclaredCardMaterialKey(key)).toBe(true);
  const model = buildSettingsModel({ payments: { cardNumber: 'number fixture', cardExpiry: 'expiry fixture', cardCvv: 'code fixture', cardholderName: 'name fixture' } }, new Set(keys), new Set(keys));
  const rows = model.flatMap(group => [...group.rawRows, ...group.plainRows]);
  expect(rows.some(row => keys.includes(row.key))).toBe(false);
});
test('unknown spellings have no synchronous semantic classification and remain excluded', () => {
  const keys = ['cvv', 'pan', 'rawPan', 'cardNumber', 'cardNum', 'companyName', 'japanRegion', 'panEnabled', 'cardExpiry', 'other.cardholderName'];
  for (const key of keys) expect(isCardMaterialKey(key)).toBe(false);
  expect(buildSettingsModel(Object.fromEntries(keys.map(key => [key, 'fixture']))).flatMap(group => group.rawRows)).toEqual([]);
});
