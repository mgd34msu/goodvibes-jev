import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function manager() {
  const configDir = mkdtempSync(join(tmpdir(), 'runtime-admission-'));
  roots.push(configDir);
  return { configDir, config: new ConfigManager({ configDir, readOnly: true }) };
}

test('read-only runtime inputs are detached, validate, notify after publication, and never write', () => {
  const { configDir, config } = manager();
  const seen: unknown[] = [];
  config.subscribe('provider.model', () => seen.push(config.get('provider.model')));
  config.setRuntimeOverride('provider.model', 'synthetic:cli');
  config.setRuntimeOverride('provider.model', 'synthetic:cli');
  expect(seen).toEqual(['synthetic:cli']);
  expect(() => config.set('provider.model', 'synthetic:persisted')).toThrow('read-only');
  expect(() => config.setRuntimeOverride('behavior.autoApprove', 'private-invalid' as never)).toThrow('Invalid runtime value for behavior.autoApprove.');
  expect(() => config.setRuntimeOverride('notifications.hostPrivacy' as never, false as never)).toThrow('builtin schema key');
  const prices = { 'synthetic:model': { input: 1, output: 2 } };
  config.setRuntimeOverride('pricing.modelPrices', prices);
  prices['synthetic:model'].input = 9;
  expect(config.get('pricing.modelPrices')).toEqual({ 'synthetic:model': { input: 1, output: 2 } });
  (config.get('pricing.modelPrices') as typeof prices)['synthetic:model'].input = 8;
  expect(config.get('pricing.modelPrices')).toEqual({ 'synthetic:model': { input: 1, output: 2 } });
  expect(readdirSync(configDir)).toEqual([]);
});

test('strict policy admission refuses locked and malformed policy without repair', () => {
  const { configDir, config } = manager();
  const policy = join(configDir, 'settings-sync.json');
  writeFileSync(policy, JSON.stringify({ version: 2, managedLocks: [{ key: 'provider.model', source: 'synthetic', reason: 'test', updatedAt: 1 }] }));
  expect(() => config.setRuntimeOverride('provider.model', 'synthetic:cli')).toThrow('managed');
  writeFileSync(policy, '{broken-policy');
  expect(() => config.setRuntimeDefault('display.showTokenSpeed', true)).toThrow('policy could not be read');
  expect(readFileSync(policy, 'utf8')).toBe('{broken-policy');
  expect(readdirSync(configDir)).toEqual(['settings-sync.json']);
});

test('runtime structured input rejects non-JSON shapes without exposing values', () => {
  const { config } = manager();
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const getter = Object.defineProperty({}, 'secret', { get() { throw new Error('private-getter-value'); }, enumerable: true });
  for (const value of [cycle, getter, new Date(), { 'synthetic:model': { input: Infinity, output: 1 } }, { secret: undefined }]) {
    expect(() => config.setRuntimeOverride('pricing.modelPrices', value as never)).toThrow('Invalid runtime value for pricing.modelPrices.');
  }
});
