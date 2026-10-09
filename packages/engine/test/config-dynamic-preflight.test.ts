import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import type { ConfigKey } from '../sdk/src/platform/config/schema.ts';
import { setManagedSettingLock } from '../sdk/src/platform/runtime/settings/control-plane.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(readOnly = false) {
  const root = mkdtempSync(join(tmpdir(), 'config-preflight-')); roots.push(root);
  const configDir = join(root, 'config');
  mkdirSync(configDir, { recursive: true });
  const manager = new ConfigManager({ configDir, readOnly });
  return { root, configDir, manager };
}

test('dynamic preflight admits synthetic secret leaves without writing or invalidating', () => {
  const f = fixture();
  const before = f.manager.getRaw();
  const files = readdirSync(f.configDir);
  let invalidations = 0;
  f.manager.onDidInvalidate(() => { invalidations++; });
  f.manager.validateDynamic('payments.cardNumber' as ConfigKey, 'goodvibes://secrets/goodvibes/fixture');
  expect(f.manager.getRaw()).toEqual(before);
  expect(readdirSync(f.configDir)).toEqual(files);
  expect(invalidations).toBe(0);
});

test('schema and path preflight failures preserve setter semantics and do not invalidate', () => {
  const f = fixture();
  let invalidations = 0;
  f.manager.onDidInvalidate(() => { invalidations++; });
  expect(() => f.manager.validateDynamic('controlPlane.hostMode', 'unsupported')).toThrow();
  expect(() => f.manager.validateDynamic('absent.token' as ConfigKey, 'reference')).toThrow('Invalid config path');
  expect(invalidations).toBe(0);
  expect(() => f.manager.setDynamic('controlPlane.hostMode', 'unsupported')).toThrow();
  expect(invalidations).toBe(1);
});

test('managed and read-only owners reject before any proposed mutation', () => {
  const f = fixture();
  const key = 'payments.cardNumber' as ConfigKey;
  setManagedSettingLock(key, 'test-policy', 'locked', f.configDir);
  const before = f.manager.getRaw();
  expect(() => f.manager.validateDynamic(key, 'reference')).toThrow('locked');
  expect(f.manager.getRaw()).toEqual(before);
  const reader = new ConfigManager({ configDir: f.configDir, readOnly: true });
  expect(() => reader.validateDynamic('surfaces.ntfy.token', 'reference')).toThrow('read-only');
});

test('unreadable policy is rejected without recovery, quarantine, or file changes', () => {
  const f = fixture();
  const path = join(f.configDir, 'settings-sync.json');
  writeFileSync(path, '{ malformed policy');
  const files = readdirSync(f.configDir);
  expect(() => f.manager.validateDynamic('surfaces.ntfy.token', 'reference')).toThrow('metadata');
  expect(readFileSync(path, 'utf8')).toBe('{ malformed policy');
  expect(readdirSync(f.configDir)).toEqual(files);
});
