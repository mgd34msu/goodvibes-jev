/**
 * settings-modal-theme-mode.test.ts, the display.themeMode settings-modal
 * entry.
 *
 * Proves: (1) the display group carries the schema-driven enum entry (auto|
 * dark|light) so the preference is discoverable like any other setting; (2)
 * cycling it persists through the real ConfigManager and fires
 * onSettingApplied; (3) the apply hook flips the active theme mode NOW for
 * forced dark/light (with a full repaint) and states the next-launch
 * contract for auto.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { SettingsModal } from '../../input/settings-modal.ts';
import { CONFIG_SCHEMA, ConfigManager, type ConfigKey } from '@goodvibes-jev/engine/sdk/platform/config';
import { SecretsManager } from '../../config/secrets.ts';
import { ServiceRegistry } from '@goodvibes-jev/engine/sdk/platform/config';
import { SubscriptionManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { McpRegistry } from '@goodvibes-jev/engine/sdk/platform/mcp';
import {
  applyThemeModeSettingChange,
  THEME_MODE_CONFIG_KEY,
} from '../../renderer/theme-mode-config.ts';
import { getActiveThemeMode, setActiveThemeMode } from '../../renderer/theme.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeTmpDir(): string {
  const dir = makeProjectTempDir(`gv-theme-mode-setting-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return dir;
}

describe('display.themeMode settings-modal entry (schema-driven)', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  let tmpDir: string;
  let cm: ConfigManager;
  let ffm: FeatureFlagManager;
  let modal: SettingsModal;
  let mcpRegistry: McpRegistry;
  let subscriptionManager: SubscriptionManager;
  let serviceRegistry: ServiceRegistry;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    process.env.HOME = tmpDir;
    process.chdir(tmpDir);
    cm = new ConfigManager({
      surfaceRoot: 'tui',
      workingDir: tmpDir,
      homeDir: tmpDir,
      configDir: join(tmpDir, '.goodvibes', 'global-tui'),
    });
    ffm = createFeatureFlagManager();
    modal = new SettingsModal();
    subscriptionManager = new SubscriptionManager(join(tmpDir, '.goodvibes', 'tui', 'subscriptions.json'));
    serviceRegistry = new ServiceRegistry(join(tmpDir, '.goodvibes', 'tui', 'services.json'), {
      secretsManager: new SecretsManager({ projectRoot: tmpDir, globalHome: tmpDir, configManager: cm }),
      subscriptionManager,
    });
    mcpRegistry = { listServerSecurity: () => [], setServerTrustMode: () => {} } as unknown as McpRegistry;
    mkdirSync(join(tmpDir, '.goodvibes', 'tui'), { recursive: true });
  });

  afterEach(() => {
    setActiveThemeMode('dark'); // restore the shared test-process default
    process.chdir(originalCwd);
    if (originalHome !== undefined) process.env.HOME = originalHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function themeModeEntry() {
    const entries = modal.groups.get('display') ?? [];
    return entries.find((e) => String(e.setting.key) === THEME_MODE_CONFIG_KEY);
  }

  test('display group carries the schema-driven enum entry (discoverable)', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    const entry = themeModeEntry();
    const schemaEntry = CONFIG_SCHEMA.find((s) => s.key === THEME_MODE_CONFIG_KEY);
    expect(entry).toBeDefined();
    expect(entry!.setting.type).toBe('enum');
    expect(entry!.setting.enumValues).toEqual(schemaEntry!.enumValues);
    expect(entry!.currentValue).toBe('auto'); // unset → honest default
    expect(entry!.isDefault).toBe(true);
  });

  test('entry appears exactly once across re-opens', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    modal.close();
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    const entries = modal.groups.get('display') ?? [];
    expect(entries.filter((e) => String(e.setting.key) === THEME_MODE_CONFIG_KEY).length).toBe(1);
  });

  test('cycling the enum persists via setDynamic and fires onSettingApplied', () => {
    const applied: Array<{ key: string; value: unknown }> = [];
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry, undefined, {
      onSettingApplied: (change) => {
        applied.push({ key: String(change.key), value: change.value });
        return { message: 'ok' };
      },
    });
    // Select the themeMode entry by key, the same path ui-openers' selectTarget uses.
    modal.selectTarget(THEME_MODE_CONFIG_KEY);
    expect(modal.focusPane).toBe('settings');
    expect(String(modal.getSelected()?.setting.key)).toBe(THEME_MODE_CONFIG_KEY);

    modal.activateSelected(); // Enter: auto → dark (settings-cycle order)
    expect(cm.get(THEME_MODE_CONFIG_KEY as ConfigKey)).toBe('dark');
    expect(themeModeEntry()!.currentValue).toBe('dark');
    expect(themeModeEntry()!.isDefault).toBe(false);
    expect(applied).toEqual([{ key: THEME_MODE_CONFIG_KEY, value: 'dark' }]);

    modal.activateSelected(); // dark → light
    expect(cm.get(THEME_MODE_CONFIG_KEY as ConfigKey)).toBe('light');

    modal.activateSelected(); // light → auto (wraps)
    expect(cm.get(THEME_MODE_CONFIG_KEY as ConfigKey)).toBe('auto');

    // Arrow-key adjustment cycles too (the other enum edit path).
    modal.adjustSelected('right'); // auto → dark
    expect(cm.get(THEME_MODE_CONFIG_KEY as ConfigKey)).toBe('dark');
    modal.adjustSelected('left'); // dark → auto
    expect(cm.get(THEME_MODE_CONFIG_KEY as ConfigKey)).toBe('auto');
  });

  test('Enter on display.theme opens the theme picker instead of cycling', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    modal.selectTarget('display.theme');
    expect(String(modal.getSelected()?.setting.key)).toBe('display.theme');
    const before = cm.get('display.theme' as ConfigKey);
    modal.activateSelected();
    expect(modal.pendingSettingsPickerAction).toBe('theme');
    expect(cm.get('display.theme' as ConfigKey)).toBe(before);
  });
});

describe('applyThemeModeSettingChange (the ui-openers apply hook)', () => {
  afterEach(() => setActiveThemeMode('dark'));

  test('forced light flips the active mode now and requests a full repaint', () => {
    let repaints = 0;
    const result = applyThemeModeSettingChange('light', () => { repaints += 1; });
    expect(getActiveThemeMode()).toBe('light');
    expect(repaints).toBe(1);
    expect(result.message).toBe('Theme mode: light (applied now)');
  });

  test('forced dark flips back now', () => {
    setActiveThemeMode('light');
    const result = applyThemeModeSettingChange('dark');
    expect(getActiveThemeMode()).toBe('dark');
    expect(result.message).toBe('Theme mode: dark (applied now)');
  });

  test('auto does NOT flip the mode and states the next-launch contract', () => {
    let repaints = 0;
    const result = applyThemeModeSettingChange('auto', () => { repaints += 1; });
    expect(getActiveThemeMode()).toBe('dark'); // unchanged
    expect(repaints).toBe(0);
    expect(result.message).toBe('Theme mode: auto (probes terminal on next startup)');
  });

  test('garbage input coerces to the default (auto): no flip', () => {
    const result = applyThemeModeSettingChange(42);
    expect(getActiveThemeMode()).toBe('dark');
    expect(result.message).toContain('auto');
  });
});
