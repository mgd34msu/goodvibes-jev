import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { CONFIG_SCHEMA } from '../sdk/src/platform/config/schema.ts';
import {
  NOTIFICATIONS_METADATA_ONLY_KEY,
  readNotificationsMetadataOnly,
} from '../sdk/src/platform/runtime/operations.ts';

describe('the live, fail-closed notification privacy reader', () => {
  test('only literal false allows content-bearing notifications', () => {
    expect(readNotificationsMetadataOnly(() => false)).toBe(false);
    expect(readNotificationsMetadataOnly(() => true)).toBe(true);
    for (const value of [undefined, null, 'false', 'true', '', 0, 1, NaN, {}, [], () => false]) {
      expect(readNotificationsMetadataOnly(() => value)).toBe(true);
    }
  });

  test('reads the exact key once on every call and reflects live changes', () => {
    let value: unknown = true;
    const keys: string[] = [];
    const get = (key: string): unknown => { keys.push(key); return value; };
    expect(readNotificationsMetadataOnly(get)).toBe(true);
    value = false;
    expect(readNotificationsMetadataOnly(get)).toBe(false);
    value = undefined;
    expect(readNotificationsMetadataOnly(get)).toBe(true);
    expect(keys).toEqual(Array(3).fill('behavior.notificationsMetadataOnly'));
  });

  test('an older throwing getter or private read error remains restrictive', () => {
    for (const error of [new Error('Unknown config key'), new Error('synthetic private content'), 'private failure', null]) {
      expect(readNotificationsMetadataOnly(() => { throw error; })).toBe(true);
    }
  });
});

describe('actual ConfigManager reads before the new schema is installed', () => {
  function withConfig(raw: unknown, run: (manager: ConfigManager, path: string) => void): void {
    const configDir = mkdtempSync(join(tmpdir(), 'notification-privacy-reader-'));
    const path = join(configDir, 'settings.json');
    writeFileSync(path, JSON.stringify(raw));
    try { run(new ConfigManager({ configDir, readOnly: true }), path); }
    finally { rmSync(configDir, { recursive: true, force: true }); }
  }

  function reader(manager: ConfigManager): boolean {
    // A host's string-key reader is the public seam. No ConfigKey/schema entry
    // is added merely to make this future preference readable in this proof.
    return readNotificationsMetadataOnly((key) => manager.get(key as Parameters<ConfigManager['get']>[0]));
  }

  test('missing preference and a malformed behavior section cannot open disclosure', () => {
    expect(CONFIG_SCHEMA.some((setting) => String(setting.key) === NOTIFICATIONS_METADATA_ONLY_KEY)).toBe(false);
    for (const raw of [{}, { behavior: [] }, { behavior: 'malformed section' }]) {
      withConfig(raw, (manager, path) => {
        expect(reader(manager)).toBe(true);
        expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(raw);
      });
    }
  });

  test('malformed persisted preferences remain restrictive, including false-like values', () => {
    for (const value of ['false', 0, null, [], {}]) {
      withConfig({ behavior: { notificationsMetadataOnly: value } }, (manager, path) => {
        expect(reader(manager)).toBe(true);
        expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ behavior: { notificationsMetadataOnly: value } });
      });
    }
  });

  test('explicit booleans are read live after a real disk reload, with no reader cache', () => {
    withConfig({ behavior: { notificationsMetadataOnly: true } }, (manager, path) => {
      expect(reader(manager)).toBe(true);
      writeFileSync(path, JSON.stringify({ behavior: { notificationsMetadataOnly: false } }));
      manager.load();
      expect(reader(manager)).toBe(false);
      writeFileSync(path, JSON.stringify({ behavior: { notificationsMetadataOnly: 'false' } }));
      manager.load();
      expect(reader(manager)).toBe(true);
    });
  });
});
