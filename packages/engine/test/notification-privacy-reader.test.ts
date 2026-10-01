import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { CONFIG_SCHEMA } from '../sdk/src/platform/config/schema.ts';
import { withTestTimeout } from './_helpers/test-timeout.ts';
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

  test('async and thenable results cannot authorize or leak rejected private errors in a real process', async () => {
    const readerPath = resolve(import.meta.dir, '../sdk/src/platform/runtime/notification-privacy.ts');
    const source = `
      import { readNotificationsMetadataOnly } from ${JSON.stringify(readerPath)};
      const privateError = () => new Error('synthetic-private-config-failure');
      let rejectLate;
      const lateFailure = new Promise((_, reject) => { rejectLate = reject; });
      let resolveLate;
      const lateFalse = new Promise((resolve) => { resolveLate = resolve; });
      const getters = [
        async () => { throw privateError(); },
        () => Promise.reject(privateError()),
        () => lateFailure,
        () => ({ then(_resolve, reject) { reject(privateError()); } }),
        () => ({ get then() { throw privateError(); } }),
        () => ({ then() { throw privateError(); } }),
        async () => false,
        () => Promise.resolve(false),
        () => lateFalse,
      ];
      const results = getters.map((get) => readNotificationsMetadataOnly(get));
      if (results.some((result) => result !== true)) throw new Error('Async result authorized notification content');
      rejectLate(privateError());
      resolveLate(false);
      await new Promise((resolve) => setTimeout(resolve, 30));
      console.log('malformed readers stayed metadata-only');
    `;
    const child = Bun.spawn([process.execPath, '--eval', source], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    try {
      // Observe the real runtime's unhandled-rejection behavior, not the test
      // runner's hooks. Drain both streams while awaiting the owned child.
      const [code, stdout, stderr] = await withTestTimeout(Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]), 30_000, 'Notification privacy subprocess did not settle');
      expect(code, stderr).toBe(0);
      expect(stderr).toBe('');
      expect(stdout.trim()).toBe('malformed readers stayed metadata-only');
    } finally {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      await child.exited.catch(() => undefined);
    }
  }, 35_000);
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
