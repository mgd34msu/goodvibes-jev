import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_SCHEMA, DEFAULT_CONFIG, ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { defaultStore } from '@goodvibes-jev/engine/sdk/platform/runtime/settings';
import { readNotificationsMetadataOnly } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import { AgentConfigManager, AGENT_NOTIFICATIONS_METADATA_ONLY_KEY as KEY, readAgentHostSetting } from '../../config/host-settings.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function fixture() {
  const root = makeProjectTempDir('agent-host-settings');
  const configDir = join(root, 'config');
  return { root, configDir, path: join(configDir, 'settings.json') };
}

function seed(configDir: string, value: unknown): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ behavior: { notificationsMetadataOnly: value } }));
}

function seedPolicyLock(configDir: string, reason: string): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'settings-sync.json'), JSON.stringify({ ...defaultStore(), managedLocks: [{ key: KEY, source: 'test-policy', reason, updatedAt: 1 }] }));
}

function privacy(config: ConfigManager): boolean {
  return readNotificationsMetadataOnly((key) => readAgentHostSetting(config, key));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(predicate()).toBe(true);
}

describe('Agent host-owned notification privacy settings', () => {
  test('one local descriptor, restrictive absent read, no startup write or SDK mutation', () => {
    const { configDir, path } = fixture();
    const beforeSchema = [...CONFIG_SCHEMA];
    const beforeDefaults = JSON.stringify(DEFAULT_CONFIG);
    const bare = new ConfigManager({ configDir });
    const config = new AgentConfigManager({ configDir });
    const descriptor = config.getHostSettingsSchema().filter(setting => setting.key === KEY);
    expect(descriptor).toHaveLength(1);
    expect(descriptor[0]).toMatchObject({ type: 'boolean', default: true });
    expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
    expect(privacy(config)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(bare.getHostSettingsSchema()).toEqual([]);
    expect(() => bare.getHostBooleanSetting(KEY)).toThrow('not registered');
    expect(Reflect.set(descriptor[0]!, 'default', false)).toBe(false);
    expect(config.getHostSettingsSchema().find(setting => setting.key === KEY)?.default).toBe(true);
    expect(CONFIG_SCHEMA).toEqual(beforeSchema);
    expect(JSON.stringify(DEFAULT_CONFIG)).toBe(beforeDefaults);
  });

  test.each([undefined, null, 'false', 'true', 0, 1, {}, [], true, false].map((value) => [value]))('persisted %j reads restrictive except literal false', (value) => {
    const { configDir } = fixture();
    seed(configDir, value);
    const config = new AgentConfigManager({ configDir });
    expect(config.getHostBooleanSetting(KEY).get()).toBe(value !== false);
    expect(privacy(config)).toBe(value !== false);
  });

  test('literal booleans persist, reload, notify, and reset through guarded writes', () => {
    const { configDir, path } = fixture();
    const config = new AgentConfigManager({ configDir });
    const changes: unknown[] = [];
    const unsubscribe = config.getHostBooleanSetting(KEY).subscribe((next, previous) => changes.push([next, previous]));
    config.getHostBooleanSetting(KEY).set(false);
    expect(changes).toEqual([[false, true]]);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ behavior: { notificationsMetadataOnly: false } });
    expect(new AgentConfigManager({ configDir }).getHostBooleanSetting(KEY).get()).toBe(false);
    config.getHostBooleanSetting(KEY).reset();
    expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
    expect(new AgentConfigManager({ configDir }).getHostBooleanSetting(KEY).get()).toBe(true);
    expect(changes).toEqual([[false, true], [true, false]]);
    config.getHostBooleanSetting(KEY).set(false);
    config.set('behavior.autoApprove', true);
    config.reset();
    expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
    expect(config.get('behavior.autoApprove')).toBe(DEFAULT_CONFIG.behavior.autoApprove);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({});
    expect(changes.at(-1)).toEqual([true, false]);
    unsubscribe();
  });

  test.each([undefined, null, 'false', 'true', 0, 1, {}, []].map((value) => [value]))('rejects non-boolean write %j without changing bytes', (value) => {
    const { configDir, path } = fixture();
    const config = new AgentConfigManager({ configDir });
    config.getHostBooleanSetting(KEY).set(true);
    const before = readFileSync(path, 'utf8');
    expect(() => Reflect.apply(config.getHostBooleanSetting(KEY).set, null, [value])).toThrow('literal boolean');
    expect(() => Reflect.apply(config.getHostBooleanSetting(KEY).setProjectValue, null, [value])).toThrow('literal boolean');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
  });

  test('project writes use the public project writer and retain strict validation', () => {
    const { root, configDir, path } = fixture();
    const workingDir = join(root, 'project');
    mkdirSync(workingDir);
    const options = { configDir, workingDir, surfaceRoot: 'agent' };
    const config = new AgentConfigManager(options);
    config.getHostBooleanSetting(KEY).setProjectValue(false);
    expect(existsSync(path)).toBe(false);
    expect(new AgentConfigManager(options).getHostBooleanSetting(KEY).get()).toBe(false);
    expect(JSON.parse(readFileSync(config.getProjectConfigPath()!, 'utf8')).behavior.notificationsMetadataOnly).toBe(false);
    config.getHostBooleanSetting(KEY).reset();
    expect(new AgentConfigManager(options).getHostBooleanSetting(KEY).get()).toBe(true);
    config.getHostBooleanSetting(KEY).setProjectValue(false);
    config.reset();
    expect(new AgentConfigManager(options).getHostBooleanSetting(KEY).get()).toBe(true);
  });

  test('scalar writes update existing malformed project leaves, retaining locks and public options', () => {
    const { root, configDir, path } = fixture();
    const workingDir = join(root, 'project');
    mkdirSync(workingDir);
    seed(join(workingDir, '.goodvibes', 'agent'), 'false');
    const options = { configDir, workingDir, surfaceRoot: 'agent' };
    const config = new AgentConfigManager(options);
    expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
    config.getHostBooleanSetting(KEY).set(false);
    expect(existsSync(path)).toBe(false);
    expect(new AgentConfigManager(options).getHostBooleanSetting(KEY).get()).toBe(false);
    seedPolicyLock(configDir, 'project choice managed');
    expect(() => config.getHostBooleanSetting(KEY).set(true)).toThrow('locked');
    expect(() => config.getHostBooleanSetting(KEY).reset()).toThrow('locked');
    expect(new AgentConfigManager(options).getHostBooleanSetting(KEY).get()).toBe(false);
    config.getHostBooleanSetting(KEY).set(true, { bypassManagedLock: true });
    expect(new AgentConfigManager(options).getHostBooleanSetting(KEY).get()).toBe(true);
  });

  test('a reset that revokes the project tier then fails globally reports failure and remains restrictive on reload', () => {
    const { root, configDir } = fixture();
    const workingDir = join(root, 'project');
    mkdirSync(workingDir);
    const options = { configDir, workingDir, surfaceRoot: 'agent' };
    const config = new AgentConfigManager(options);
    config.getHostBooleanSetting(KEY).set(false);
    config.getHostBooleanSetting(KEY).setProjectValue(false);
    renameSync(configDir, join(root, 'saved-config'));
    writeFileSync(configDir, 'blocked global path');
    expect(() => config.getHostBooleanSetting(KEY).reset()).toThrow();
    expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
    // Restore the original global false value; the successfully revoked
    // higher-priority project tier must keep reload restrictive.
    const restored = join(root, 'saved-config');
    expect(new AgentConfigManager({ ...options, configDir: restored }).getHostBooleanSetting(KEY).get()).toBe(true);
  });

  test('read-only and managed locks block setting and both reset paths', () => {
    const { configDir, path } = fixture();
    seed(configDir, false);
    const readOnly = new AgentConfigManager({ configDir, readOnly: true });
    for (const action of [() => readOnly.getHostBooleanSetting(KEY).set(true), () => readOnly.getHostBooleanSetting(KEY).reset(), () => readOnly.reset()]) {
      expect(action).toThrow('read-only');
      expect(readOnly.getHostBooleanSetting(KEY).get()).toBe(false);
    }
    const config = new AgentConfigManager({ configDir });
    const before = readFileSync(path, 'utf8');
    seedPolicyLock(configDir, 'privacy choice managed');
    for (const action of [() => config.getHostBooleanSetting(KEY).set(true), () => config.getHostBooleanSetting(KEY).reset(), () => config.reset()]) {
      expect(action).toThrow('locked');
      expect(config.getHostBooleanSetting(KEY).get()).toBe(false);
      expect(readFileSync(path, 'utf8')).toBe(before);
    }
    // Existing public options remain available; the host adapter invents none.
    config.getHostBooleanSetting(KEY).set(true, { bypassManagedLock: true });
    expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
  });

  test('failed persistence revokes unreadable privacy once and never reports success', () => {
    const { root, configDir } = fixture();
    const config = new AgentConfigManager({ configDir });
    config.getHostBooleanSetting(KEY).set(false);
    const changes: unknown[] = [];
    config.getHostBooleanSetting(KEY).subscribe((next) => changes.push(next));
    renameSync(configDir, join(root, 'saved-config'));
    writeFileSync(configDir, 'blocked parent path');
    for (const action of [() => config.getHostBooleanSetting(KEY).set(true), () => config.getHostBooleanSetting(KEY).reset(), () => config.reset()]) {
      expect(action).toThrow();
      expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
      expect(changes).toEqual([true]);
    }
  });

  test('external reload revokes details for true, malformed, and removed values', async () => {
    const { configDir, path } = fixture();
    const config = new AgentConfigManager({ configDir });
    config.getHostBooleanSetting(KEY).set(false);
    const changes: unknown[] = [];
    config.getHostBooleanSetting(KEY).subscribe((next, previous) => changes.push([next, previous]));
    const stop = config.watchConfigFiles({ intervalMs: 5 });
    try {
      for (const value of [true, 'false', undefined]) {
        seed(configDir, value);
        await waitFor(() => config.getHostBooleanSetting(KEY).get() === true);
        expect(privacy(config)).toBe(true);
        writeFileSync(path, JSON.stringify({ behavior: { notificationsMetadataOnly: false } }));
        await waitFor(() => config.getHostBooleanSetting(KEY).get() === false);
      }
      expect(changes).toEqual(Array.from({ length: 3 }, () => [[true, false], [false, true]]).flat());
    } finally { stop(); }
  });

  test('category mutations cannot bypass host scalar guards; ordinary keys retain their SDK behavior', () => {
    const { configDir } = fixture();
    const config = new AgentConfigManager({ configDir });
    expect(() => config.mergeCategory('behavior', { notificationsMetadataOnly: false } as never)).toThrow('guarded scalar set');
    config.mergeCategory('behavior', { autoApprove: true });
    expect(config.get('behavior.autoApprove')).toBe(true);
    config.getHostBooleanSetting(KEY).set(false);
    config.removeCategoryKey('behavior', 'notificationsMetadataOnly');
    expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
    config.setDynamic('behavior.autoApprove', false);
    expect(config.get('behavior.autoApprove')).toBe(false);
  });
});
