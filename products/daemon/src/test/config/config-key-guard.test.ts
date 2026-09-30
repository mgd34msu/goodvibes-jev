import { describe, expect, test } from 'bun:test';
import { CONFIG_SCHEMA } from '@goodvibes-jev/engine/sdk/platform/config';
import { isKnownConfigKey } from '../../config/config-key-guard.ts';

describe('isKnownConfigKey', () => {
  test('accepts every key the live schema declares', () => {
    for (const setting of CONFIG_SCHEMA) {
      expect(isKnownConfigKey(setting.key, CONFIG_SCHEMA)).toBe(true);
    }
  });

  test('rejects a key the schema does not declare', () => {
    expect(isKnownConfigKey('not.a.key', CONFIG_SCHEMA)).toBe(false);
    expect(isKnownConfigKey('', CONFIG_SCHEMA)).toBe(false);
  });

  test('is case-sensitive and rejects a near-miss of a real key', () => {
    const real = CONFIG_SCHEMA[0]?.key;
    expect(real).toBeDefined();
    expect(isKnownConfigKey(`${real}.extra`, CONFIG_SCHEMA)).toBe(false);
    expect(isKnownConfigKey(String(real).toUpperCase(), CONFIG_SCHEMA)).toBe(false);
  });
});
