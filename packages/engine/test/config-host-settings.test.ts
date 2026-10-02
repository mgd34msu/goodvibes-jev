import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager, CONFIG_SCHEMA, DEFAULT_CONFIG, type ConfigKey, type HostBooleanSetting } from '../sdk/src/platform/config/index.ts';
import {
  applySettingsSyncBundle, applyStagedManagedBundle, exportSettingsSyncBundle,
  getResolvedSettingLookup, getSettingsControlPlaneSnapshot, setManagedSettingLock, stageManagedSettingsBundle,
} from '../sdk/src/platform/runtime/settings.ts';

const KEY = 'behavior.hostPrivacyExample' as ConfigKey;
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
    const entry = config.getSchema().find((setting) => setting.key === KEY)!;
    entry.default = false;
    entry.validate = () => true;
    expect(config.get(KEY)).toBe(true);
    expect(config.getSchema().find((setting) => setting.key === KEY)?.default).toBe(true);
    expect(() => config.setDynamic(KEY, 'false')).toThrow('literal boolean');
    expect(existsSync(config.getConfigPath())).toBe(false);
    expect(existsSync(config.getProjectConfigPath()!)).toBe(false);
    expect(CONFIG_SCHEMA.some((setting) => setting.key === KEY)).toBe(false);
    expect(Object.hasOwn(DEFAULT_CONFIG.behavior, 'hostPrivacyExample')).toBe(false);
    const bare = new ConfigManager({ ...options, hostSettings: undefined });
    expect(bare.getSchema()).toBe(CONFIG_SCHEMA);
    expect(bare.get(KEY)).toBeUndefined();
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
    config.set(KEY, false);
    write(config.getProjectConfigPath()!, host(value));
    config.load();
    expect(config.get(KEY)).toBe(true);
    expect(config.getIngestionQuarantine().some((notice) => notice.key === KEY)).toBe(true);
  });
  test.each([null, [], 'invalid'].map((value) => [value]))('malformed project category %j cannot reveal global false', (value) => {
    const { config } = fixture();
    config.set(KEY, false);
    write(config.getProjectConfigPath()!, { behavior: value });
    config.load();
    expect(config.get(KEY)).toBe(true);
  });

  test('normal missing-project precedence inherits explicit global false, but sole-project removal defaults', () => {
    const { config } = fixture();
    config.set(KEY, false);
    config.setProjectValue(KEY, true);
    write(config.getProjectConfigPath()!, {});
    config.load();
    expect(config.get(KEY)).toBe(false);
    rmSync(config.getConfigPath());
    config.setProjectValue(KEY, false);
    write(config.getProjectConfigPath()!, {});
    config.load();
    expect(config.get(KEY)).toBe(true);
  });

  test.each(['global', 'project'])('deleting sole %s file then load revokes once and recovers without duplicate callbacks', (tier) => {
    const { config } = fixture();
    if (tier === 'project') config.setProjectValue(KEY, false); else config.set(KEY, false);
    const changes: unknown[] = [];
    const off = config.subscribe(KEY, (next, previous) => changes.push([next, previous]));
    const path = tier === 'global' ? config.getConfigPath() : config.getProjectConfigPath()!;
    rmSync(path);
    config.load(); config.load();
    expect(config.get(KEY)).toBe(true);
    write(path, host(false)); config.load(); config.load();
    expect(changes).toEqual([[true, false], [false, true]]);
    off(); write(path, host(true)); config.load();
    expect(changes).toHaveLength(2);
  });

  test.each(['invalid-json', 'directory', 'null-root'])('unreadable %s project revokes without exposing lower false', (mode) => {
    const { config } = fixture();
    config.set(KEY, false); config.setProjectValue(KEY, false);
    const changes: unknown[] = [];
    config.subscribe(KEY, (next, previous) => changes.push([next, previous]));
    const path = config.getProjectConfigPath()!;
    if (mode === 'directory') { rmSync(path); mkdirSync(path); }
    else writeFileSync(path, mode === 'null-root' ? 'null' : '{invalid');
    expect(() => config.load()).toThrow();
    expect(config.get(KEY)).toBe(true);
    expect(() => config.load()).toThrow();
    expect(changes).toEqual([[true, false]]);
  });

  test('successful scalar persistence cannot grant details when another participating tier is unreadable', () => {
    const { config } = fixture();
    config.set(KEY, true);
    write(config.getProjectConfigPath()!, {});
    writeFileSync(config.getProjectConfigPath()!, '{invalid');
    expect(() => config.set(KEY, false)).toThrow('could not be read');
    expect(config.get(KEY)).toBe(true);
    expect(JSON.parse(readFileSync(config.getConfigPath(), 'utf8')).behavior.hostPrivacyExample).toBe(false);
    write(config.getProjectConfigPath()!, {}); config.load();
    expect(config.get(KEY)).toBe(false);
    writeFileSync(config.getConfigPath(), '{invalid');
    expect(() => config.setProjectValue(KEY, true)).toThrow('could not be read');
    expect(config.get(KEY)).toBe(true);
  });

  test('an inaccessible project parent is a failed read, never absence revealing global false', () => {
    const { config, options } = fixture();
    config.set(KEY, false); config.setProjectValue(KEY, true);
    const directory = join(options.workingDir, '.goodvibes', 'agent');
    chmodSync(directory, 0);
    try {
      expect(() => config.load()).toThrow('could not be accessed');
      expect(config.get(KEY)).toBe(true);
      expect(() => config.set(KEY, false)).toThrow('could not be read');
      expect(config.get(KEY)).toBe(true);
    } finally { chmodSync(directory, 0o700); }
  });

  test('host scalar, external reload, failed-read revocation, and reset emit change hooks exactly once', async () => {
    const { config } = fixture();
    const events: unknown[] = [];
    config.attachHookDispatcher({ fire: async (event) => {
      events.push([event.path, event.payload.previousValue, event.payload.value]);
      return { handled: false, actions: [] } as never;
    } });
    config.subscribe(KEY, () => {});
    config.set(KEY, false);
    expect(events).toEqual([[`Change:config:${KEY}`, true, false]]);
    write(config.getConfigPath(), host(true)); config.load(); config.load();
    expect(events.at(-1)).toEqual([`Change:config:${KEY}`, false, true]);
    config.set(KEY, false);
    writeFileSync(config.getConfigPath(), '{invalid');
    expect(() => config.load()).toThrow();
    expect(events.at(-1)).toEqual([`Change:config:${KEY}`, false, true]);
    write(config.getConfigPath(), host(false)); config.load();
    config.reset(KEY); config.reset(KEY);
    expect(events).toHaveLength(6);
    expect(events.at(-1)).toEqual([`Change:config:${KEY}`, false, true]);
  });

  test('host watcher sees absent-to-unreadable once, does not churn, and observes readable recovery', async () => {
    const { config, options } = fixture();
    config.set(KEY, false);
    const changes: unknown[] = [];
    config.subscribe(KEY, (next, previous) => changes.push([next, previous]));
    const loads = spyOn(config, 'load');
    const stop = config.watchConfigFiles({ intervalMs: 5 });
    const directory = join(options.workingDir, '.goodvibes', 'agent');
    write(config.getProjectConfigPath()!, host(true));
    chmodSync(directory, 0);
    try {
      await waitFor(() => config.get(KEY) === true);
      expect(loads).toHaveBeenCalledTimes(1);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(loads).toHaveBeenCalledTimes(1);
      expect(config.getIngestionQuarantine().some((notice) => notice.action === 'refused')).toBe(true);
      chmodSync(directory, 0o700);
      write(config.getProjectConfigPath()!, host(false));
      await waitFor(() => config.get(KEY) === false);
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
    config.set(KEY, false); config.setProjectValue(KEY, true);
    config.save(); config.saveProject();
    expect(JSON.parse(readFileSync(config.getConfigPath(), 'utf8')).behavior.hostPrivacyExample).toBe(false);
    expect(JSON.parse(readFileSync(config.getProjectConfigPath()!, 'utf8')).behavior.hostPrivacyExample).toBe(true);
    rmSync(config.getConfigPath()); rmSync(config.getProjectConfigPath()!);
    config.load(); config.save(); config.saveProject(); config.load();
    expect(config.get(KEY)).toBe(true);
    expect(JSON.parse(readFileSync(config.getConfigPath(), 'utf8')).behavior?.hostPrivacyExample).toBeUndefined();
    expect(JSON.parse(readFileSync(config.getProjectConfigPath()!, 'utf8')).behavior?.hostPrivacyExample).toBeUndefined();
  });

  test('bulk saves preserve malformed destination leaves and refuse unreadable destination files untouched', () => {
    const { config } = fixture();
    config.set(KEY, false); write(config.getProjectConfigPath()!, host('false')); config.load();
    config.saveProject();
    expect(JSON.parse(readFileSync(config.getProjectConfigPath()!, 'utf8')).behavior.hostPrivacyExample).toBe('false');
    const path = config.getProjectConfigPath()!;
    writeFileSync(path, '{invalid');
    expect(() => config.saveProject()).toThrow('could not be read');
    expect(readFileSync(path, 'utf8')).toBe('{invalid');
    expect(config.get(KEY)).toBe(true);
    config.save(); // This destination is still readable and remains unchanged for the host key.
    expect(JSON.parse(readFileSync(config.getConfigPath(), 'utf8')).behavior.hostPrivacyExample).toBe(false);
    expect(config.get(KEY)).toBe(true);
  });

  test('existing synthetic nonhost dynamic leaves, options, and ordinary setters retain behavior', () => {
    const { config, options } = fixture();
    const synthetic = 'payments.cardNumber' as ConfigKey;
    config.setDynamic(synthetic, 'goodvibes://secrets/test');
    expect(config.get(synthetic)).toBe('goodvibes://secrets/test');
    config.set('behavior.autoApprove', true);
    expect(config.get('behavior.autoApprove')).toBe(true);
    setManagedSettingLock(KEY, 'test-policy', 'locked host preference', options.configDir);
    expect(() => config.set(KEY, false)).toThrow('locked');
    config.set(KEY, false, { bypassManagedLock: true });
    expect(config.get(KEY)).toBe(false);
    expect(() => config.reset(KEY)).toThrow('locked');
  });

  test('registered host normalization never bypasses existing safety-setting ingestion refusal', () => {
    const { config, options } = fixture();
    write(config.getConfigPath(), { ...host(false) as object, permissions: { mode: 'invalid-mode' } });
    expect(() => new ConfigManager(options)).toThrow();
  });

  test('read-only control-plane discovery includes host values, locks and counts without changing builtin snapshots', () => {
    const { config, options } = fixture();
    const bare = new ConfigManager({ ...options, hostSettings: undefined });
    expect(getResolvedSettingLookup(bare, KEY)).toBeNull();
    config.set(KEY, false);
    expect(getResolvedSettingLookup(config, KEY)?.entry).toMatchObject({ effectiveValue: false, defaultValue: true, effectiveSource: 'local' });
    const registered = getSettingsControlPlaneSnapshot(config);
    const ordinary = getSettingsControlPlaneSnapshot(bare);
    expect(registered.liveKeyCount).toBe(ordinary.liveKeyCount + 1);
    expect(JSON.stringify({
      ...registered,
      liveKeyCount: ordinary.liveKeyCount,
      resolvedCounts: { ...registered.resolvedCounts, local: registered.resolvedCounts.local - 1 },
      resolvedEntries: registered.resolvedEntries.filter((entry) => entry.key !== KEY),
    })).toBe(JSON.stringify(ordinary));
    config.setProjectValue(KEY, true);
    expect(getResolvedSettingLookup(config, KEY)?.entry.effectiveSource).toBe('default');
    config.setProjectValue(KEY, false);
    setManagedSettingLock(KEY, 'host-lock', 'host policy', options.configDir);
    expect(getResolvedSettingLookup(config, KEY)).toMatchObject({
      entry: { effectiveSource: 'local', effectiveValue: false, locked: true },
      lock: { source: 'host-lock', reason: 'host policy' },
    });
    expect(getSettingsControlPlaneSnapshot(config).managedLockCount).toBe(1);
  });

  test('read-only discovery does not expand sync export, import, or managed staging/apply allowlists', async () => {
    const { config } = fixture();
    expect(Object.hasOwn(exportSettingsSyncBundle(config).settings, KEY)).toBe(false);
    expect(applySettingsSyncBundle(config, {
      version: 1, exportedAt: 0, source: 'settings-sync', settings: { [KEY]: false },
    }, 'host-only-sync-fixture')).toEqual({ appliedCount: 0, conflictCount: 0 });
    expect(config.get(KEY)).toBe(true);
    const staged = await stageManagedSettingsBundle(config, {
      version: 1, profileName: 'host-only', exportedAt: 0, settings: { [KEY]: false },
    }, 'host-only-managed-fixture');
    expect(staged.changes).toEqual([]);
    await expect(applyStagedManagedBundle(config)).rejects.toThrow('No staged managed settings matched');
    expect(config.get(KEY)).toBe(true);
  });
});
