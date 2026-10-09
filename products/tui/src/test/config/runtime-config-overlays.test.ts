import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyRuntimeConfigValue, applyTerminalRuntimeConfigDefaults } from '@goodvibes-jev/engine/terminal-shell';
import { TuiConfigManager, TUI_NOTIFICATIONS_METADATA_ONLY_KEY } from '../../config/host-settings.ts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
test('read-only TUI pair preview uses runtime URL without touching settings or policy', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-pair-')); roots.push(root);
  const config = new TuiConfigManager({ configDir: join(root, 'absent'), readOnly: true });
  applyRuntimeConfigValue(config, 'controlPlane.publicBaseUrl', 'https://preview.example.test');
  config.load(); expect(config.get('controlPlane.publicBaseUrl')).toBe('https://preview.example.test');
  expect(readdirSync(root)).toEqual([]);
});

test('TUI runtime inputs cannot grant host notification detail after a failed load', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-host-')); roots.push(root);
    const config = new TuiConfigManager({ configDir: join(root, 'config'), daemonTierPath: join(root, 'daemon.json') });
    config.getHostBooleanSetting(TUI_NOTIFICATIONS_METADATA_ONLY_KEY).set(false);
    applyRuntimeConfigValue(config, 'provider.model', 'synthetic:cli');
    expect(() => applyRuntimeConfigValue(config, TUI_NOTIFICATIONS_METADATA_ONLY_KEY as never, false)).toThrow('builtin schema key');
    mkdirSync(dirname(config.getDaemonTierPath()!), { recursive: true }); writeFileSync(config.getDaemonTierPath()!, '{invalid');
    expect(() => config.load()).toThrow(); expect(config.getHostBooleanSetting(TUI_NOTIFICATIONS_METADATA_ONLY_KEY).get()).toBe(true);
    applyTerminalRuntimeConfigDefaults(config); expect(config.getHostBooleanSetting(TUI_NOTIFICATIONS_METADATA_ONLY_KEY).get()).toBe(true);
    expect(config.get('provider.model')).toBe('synthetic:cli');
  });