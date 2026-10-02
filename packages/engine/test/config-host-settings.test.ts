import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager, CONFIG_SCHEMA, DEFAULT_CONFIG, type ConfigKey, type HostBooleanSetting } from '../sdk/src/platform/config/index.ts';
import {
  applySettingsSyncBundle, applyStagedManagedBundle, exportSettingsSyncBundle,
  defaultStore, getSettingsControlPlaneSnapshot, stageManagedSettingsBundle,
} from '../sdk/src/platform/runtime/settings.ts';

const KEY = 'behavior.hostPrivacyExample';
const definition: HostBooleanSetting = { key: KEY, type: 'boolean', default: true, description: 'Restrict this host capability by default.' };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(hostSettings: readonly HostBooleanSetting[] = [definition]) {
  const root = mkdtempSync(join(tmpdir(), 'sdk-host-setting-'));
  roots.push(root);
  const workingDir = join(root, 'project');
  mkdirSync(workingDir);
  const options = { configDir: join(root, 'config'), workingDir, surfaceRoot: 'agent', hostSettings };
  return { root, options, config: new ConfigManager(options) };
}
function write(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
function host(value: unknown): unknown { return { behavior: { hostPrivacyExample: value } }; }
async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}

describe('public instance-owned boolean host settings', () => {
  test('registration is copied, schema mutation cannot relax validation, and no startup default is written', () => {
    const input = { ...definition };
    const { options, config } = fixture([input]);
    input.default = false;
    input.description = 'changed outside';
    const entry = config.getHostSettingsSchema().find((setting) => setting.key === KEY)!;
    expect(Reflect.set(entry, 'default', false)).toBe(false);
    expect(Reflect.set(entry, 'validate', () => true)).toBe(false);
    expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
    expect(config.getHostSettingsSchema().find((setting) => setting.key === KEY)?.default).toBe(true);
    expect(() => Reflect.apply(config.getHostBooleanSetting(KEY).set, null, ['false'])).toThrow('literal boolean');
    expect(existsSync(config.getConfigPath())).toBe(false);
    expect(existsSync(config.getProjectConfigPath()!)).toBe(false);
    expect(new Set<string>(CONFIG_SCHEMA.map(setting => setting.key)).has(KEY)).toBe(false);
    expect(Object.hasOwn(DEFAULT_CONFIG.behavior, 'hostPrivacyExample')).toBe(false);
    const bare = new ConfigManager({ ...options, hostSettings: undefined });
    expect(bare.getSchema()).toBe(CONFIG_SCHEMA);
    expect(bare.getHostSettingsSchema()).toEqual([]);
    expect(Object.hasOwn(bare.getCategory('behavior'), 'hostPrivacyExample')).toBe(false);
  });

  test.each(['behavior.autoApprove', 'behavior.__proto__', '__proto__.host', 'behavior.constructor', 'behavior.prototype', 'behavior.nested.host', 'unknown.host', 'surfaces.hostExample'])('rejects invalid or colliding descriptor %s', (key) => {
    expect(() => fixture([{ ...definition, key }])).toThrow();
  });
  test('rejects duplicate and malformed descriptors before loading', () => {
    expect(() => fixture([definition, definition])).toThrow('collides');
    expect(() => fixture([{ ...definition, default: 'false' } as never])).toThrow();
  });

  test.each([null, 'false', 0, {}, []].map((value) => [value]))('malformed present project leaf %j cannot reveal global false', (value) => {
    const { config } = fixture();
    config.getHostBooleanSetting(KEY).set(false);
    write(config.getProjectConfigPath()!, host(value));
    config.load();
    expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
    expect(config.getIngestionQuarantine().some((notice) => notice.key === KEY)).toBe(true);
  });
  test.each([null, [], 'invalid'].map((value) => [value]))('malformed project category %j cannot reveal global false', (value) => {
    const { config } = fixture();
    config.getHostBooleanSetting(KEY).set(false);
    write(config.getProjectConfigPath()!, { behavior: value });
    config.load();
    expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
  });

  test('normal missing-project precedence inherits explicit global false, but sole-project removal defaults', () => {
    const { config } = fixture();
    config.getHostBooleanSetting(KEY).set(false);
    config.getHostBooleanSetting(KEY).setProjectValue(true);
    write(config.getProjectConfigPath()!, {});
    config.load();
    expect(config.getHostBooleanSetting(KEY).get()).toBe(false);
    rmSync(config.getConfigPath());
    config.getHostBooleanSetting(KEY).setProjectValue(false);
    write(config.getProjectConfigPath()!, {});
    config.load();
    expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
  });

  test.each(['global', 'project'])('deleting sole %s file then load revokes once and recovers without duplicate callbacks', (tier) => {
    const { config } = fixture();
    if (tier === 'project') config.getHostBooleanSetting(KEY).setProjectValue(false); else config.getHostBooleanSetting(KEY).set(false);
    const changes: unknown[] = [];
    const off = config.getHostBooleanSetting(KEY).subscribe((next, previous) => changes.push([next, previous]));
    const path = tier === 'global' ? config.getConfigPath() : config.getProjectConfigPath()!;
    rmSync(path);
    config.load(); config.load();
    expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
    write(path, host(false)); config.load(); config.load();
    expect(changes).toEqual([[true, false], [false, true]]);
    off(); write(path, host(true)); config.load();
    expect(changes).toHaveLength(2);
  });

  test.each(['invalid-json', 'directory', 'null-root'])('unreadable %s project revokes without exposing lower false', (mode) => {
    const { config } = fixture();
    config.getHostBooleanSetting(KEY).set(false); config.getHostBooleanSetting(KEY).setProjectValue(false);
    const changes: unknown[] = [];
    config.getHostBooleanSetting(KEY).subscribe((next, previous) => changes.push([next, previous]));
    const path = config.getProjectConfigPath()!;
    if (mode === 'directory') { rmSync(path); mkdirSync(path); }
    else writeFileSync(path, mode === 'null-root' ? 'null' : '{invalid');
    expect(() => config.load()).toThrow();
    expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
    expect(() => config.load()).toThrow();
    expect(changes).toEqual([[true, false]]);
  });

  test('scalar set refuses an unreadable project destination and explicit project writes stay restrictive on global failure', () => {
    const { config } = fixture();
    config.getHostBooleanSetting(KEY).set(true);
    write(config.getProjectConfigPath()!, {});
    writeFileSync(config.getProjectConfigPath()!, '{invalid');
    expect(() => config.getHostBooleanSetting(KEY).set(false)).toThrow('could not be read');
    expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
    expect(JSON.parse(readFileSync(config.getConfigPath(), 'utf8')).behavior.hostPrivacyExample).toBe(true);
    write(config.getProjectConfigPath()!, {}); config.load();
    expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
    writeFileSync(config.getConfigPath(), '{invalid');
    expect(() => config.getHostBooleanSetting(KEY).setProjectValue(true)).toThrow('could not be read');
    expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
  });

  test('an inaccessible project parent is a failed read, never absence revealing global false', () => {
    const { config, options } = fixture();
    config.getHostBooleanSetting(KEY).set(false); config.getHostBooleanSetting(KEY).setProjectValue(true);
    const directory = join(options.workingDir, '.goodvibes', 'agent');
    chmodSync(directory, 0);
    try {
      expect(() => config.load()).toThrow('could not be accessed');
      expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
      expect(() => config.getHostBooleanSetting(KEY).set(false)).toThrow('could not be read');
      expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
    } finally { chmodSync(directory, 0o700); }
  });

  test('host scalar, external reload, failed-read revocation, and reset emit change hooks exactly once', async () => {
    const { config } = fixture();
    const events: unknown[] = [];
    config.attachHookDispatcher({ fire: async (event) => {
      events.push([event.path, event.payload.previousValue, event.payload.value]);
      return { handled: false, actions: [] } as never;
    } });
    config.getHostBooleanSetting(KEY).subscribe(() => {});
    config.getHostBooleanSetting(KEY).set(false);
    expect(events).toEqual([[`Change:config:${KEY}`, true, false]]);
    write(config.getConfigPath(), host(true)); config.load(); config.load();
    expect(events.at(-1)).toEqual([`Change:config:${KEY}`, false, true]);
    config.getHostBooleanSetting(KEY).set(false);
    writeFileSync(config.getConfigPath(), '{invalid');
    expect(() => config.load()).toThrow();
    expect(events.at(-1)).toEqual([`Change:config:${KEY}`, false, true]);
    write(config.getConfigPath(), host(false)); config.load();
    config.getHostBooleanSetting(KEY).reset(); config.getHostBooleanSetting(KEY).reset();
    expect(events).toHaveLength(6);
    expect(events.at(-1)).toEqual([`Change:config:${KEY}`, false, true]);
  });

  test('host watcher sees absent-to-unreadable once, does not churn, and observes readable recovery', async () => {
    const { config, options } = fixture();
    config.getHostBooleanSetting(KEY).set(false);
    const changes: unknown[] = [];
    config.getHostBooleanSetting(KEY).subscribe((next, previous) => changes.push([next, previous]));
    const loads = spyOn(config, 'load');
    const stop = config.watchConfigFiles({ intervalMs: 5 });
    const directory = join(options.workingDir, '.goodvibes', 'agent');
    write(config.getProjectConfigPath()!, host(true));
    chmodSync(directory, 0);
    try {
      await waitFor(() => config.getHostBooleanSetting(KEY).get() === true);
      expect(loads).toHaveBeenCalledTimes(1);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(loads).toHaveBeenCalledTimes(1);
      expect(config.getIngestionQuarantine().some((notice) => notice.action === 'refused')).toBe(true);
      chmodSync(directory, 0o700);
      write(config.getProjectConfigPath()!, host(false));
      await waitFor(() => config.getHostBooleanSetting(KEY).get() === false);
      expect(loads).toHaveBeenCalledTimes(2);
      expect(changes).toEqual([[true, false], [false, true]]);
    } finally { chmodSync(directory, 0o700); stop(); loads.mockRestore(); }
  });

  test('no-host watcher retains its existing absent-file observation behavior', async () => {
    const { options } = fixture([]);
    const config = new ConfigManager(options);
    config.set('behavior.autoApprove', true);
    const loads = spyOn(config, 'load');
    const stop = config.watchConfigFiles({ intervalMs: 5 });
    const directory = join(options.workingDir, '.goodvibes', 'agent');
    write(config.getProjectConfigPath()!, { behavior: { autoApprove: false } });
    chmodSync(directory, 0);
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(loads).not.toHaveBeenCalled();
      expect(config.get('behavior.autoApprove')).toBe(true);
      chmodSync(directory, 0o700);
      await waitFor(() => config.get('behavior.autoApprove') === false);
      expect(loads).toHaveBeenCalledTimes(1);
    } finally { chmodSync(directory, 0o700); stop(); loads.mockRestore(); }
  });

  test('bulk saves preserve only their destination host leaves and cannot resurrect deleted cached permission', () => {
    const { config } = fixture();
    config.getHostBooleanSetting(KEY).set(false); config.getHostBooleanSetting(KEY).setProjectValue(true);
    config.save(); config.saveProject();
    expect(JSON.parse(readFileSync(config.getConfigPath(), 'utf8')).behavior.hostPrivacyExample).toBe(false);
    expect(JSON.parse(readFileSync(config.getProjectConfigPath()!, 'utf8')).behavior.hostPrivacyExample).toBe(true);
    rmSync(config.getConfigPath()); rmSync(config.getProjectConfigPath()!);
    config.load(); config.save(); config.saveProject(); config.load();
    expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
    expect(JSON.parse(readFileSync(config.getConfigPath(), 'utf8')).behavior?.hostPrivacyExample).toBeUndefined();
    expect(JSON.parse(readFileSync(config.getProjectConfigPath()!, 'utf8')).behavior?.hostPrivacyExample).toBeUndefined();
  });

  test('bulk saves preserve malformed destination leaves and refuse unreadable destination files untouched', () => {
    const { config } = fixture();
    config.getHostBooleanSetting(KEY).set(false); write(config.getProjectConfigPath()!, host('false')); config.load();
    config.saveProject();
    expect(JSON.parse(readFileSync(config.getProjectConfigPath()!, 'utf8')).behavior.hostPrivacyExample).toBe('false');
    const path = config.getProjectConfigPath()!;
    writeFileSync(path, '{invalid');
    expect(() => config.saveProject()).toThrow('could not be read');
    expect(readFileSync(path, 'utf8')).toBe('{invalid');
    expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
    config.save(); // This destination is still readable and remains unchanged for the host key.
    expect(JSON.parse(readFileSync(config.getConfigPath(), 'utf8')).behavior.hostPrivacyExample).toBe(false);
    expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
  });

  test('existing synthetic nonhost dynamic leaves, options, and ordinary setters retain behavior', () => {
    const { config, options } = fixture();
    const synthetic = 'payments.cardNumber' as ConfigKey;
    config.setDynamic(synthetic, 'goodvibes://secrets/test');
    expect(config.get(synthetic)).toBe('goodvibes://secrets/test');
    config.set('behavior.autoApprove', true);
    expect(config.get('behavior.autoApprove')).toBe(true);
    write(join(options.configDir, 'settings-sync.json'), { ...defaultStore(), managedLocks: [{ key: KEY, source: 'test-policy', reason: 'locked host preference', updatedAt: 1 }] });
    expect(() => config.getHostBooleanSetting(KEY).set(false)).toThrow('locked');
    config.getHostBooleanSetting(KEY).set(false, { bypassManagedLock: true });
    expect(config.getHostBooleanSetting(KEY).get()).toBe(false);
    expect(() => config.getHostBooleanSetting(KEY).reset()).toThrow('locked');
  });

  test('registered host normalization never bypasses existing safety-setting ingestion refusal', () => {
    const { config, options } = fixture();
    write(config.getConfigPath(), { ...host(false) as object, permissions: { mode: 'invalid-mode' } });
    expect(() => new ConfigManager(options)).toThrow();
  });

  test('supplemental host discovery is truthful and leaves builtin snapshots/counts unchanged', () => {
    const { config, options } = fixture();
    const bare = new ConfigManager({ ...options, hostSettings: undefined });
    const handle = config.getHostBooleanSetting(KEY);
    handle.set(false);
    expect(config.getSchema()).toBe(CONFIG_SCHEMA);
    expect(config.getHostSettingsSchema()).toEqual([definition]);
    expect(handle.getResolved()).toEqual({ key: KEY, value: false, defaultValue: true, source: 'local', managedLock: null });
    expect(JSON.stringify(getSettingsControlPlaneSnapshot(config))).toBe(JSON.stringify(getSettingsControlPlaneSnapshot(bare)));
    handle.setProjectValue(true);
    expect(handle.getResolved().source).toBe('default');
    handle.setProjectValue(false);
    write(join(options.configDir, 'settings-sync.json'), { ...defaultStore(), managedLocks: [
      { key: KEY, source: 'host-lock', reason: 'host policy', updatedAt: 1 },
      { key: 'behavior.autoApprove', source: 'builtin-lock', reason: 'builtin policy', updatedAt: 2 },
    ] });
    expect(handle.getResolved()).toEqual({ key: KEY, value: false, defaultValue: true, source: 'local',
      managedLock: { source: 'host-lock', reason: 'host policy', updatedAt: 1 } });
    const snapshot = getSettingsControlPlaneSnapshot(config);
    expect(snapshot.managedLockCount).toBe(1);
    expect(snapshot.managedLocks).toEqual([{ key: 'behavior.autoApprove', source: 'builtin-lock', reason: 'builtin policy', updatedAt: 2 }]);
    expect(new Set<string>(snapshot.resolvedEntries.map(entry => entry.key)).has(KEY)).toBe(false);
  });

  test('read-only discovery does not expand sync export, import, or managed staging/apply allowlists', async () => {
    const { config } = fixture();
    expect(Object.hasOwn(exportSettingsSyncBundle(config).settings, KEY)).toBe(false);
    expect(applySettingsSyncBundle(config, {
      version: 1, exportedAt: 0, source: 'settings-sync', settings: { [KEY]: false },
    }, 'host-only-sync-fixture')).toEqual({ appliedCount: 0, conflictCount: 0 });
    expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
    const staged = await stageManagedSettingsBundle(config, {
      version: 1, profileName: 'host-only', exportedAt: 0, settings: { [KEY]: false },
    }, 'host-only-managed-fixture');
    expect(staged.changes).toEqual([]);
    await expect(applyStagedManagedBundle(config)).rejects.toThrow('No staged managed settings matched');
    expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
  });
});
