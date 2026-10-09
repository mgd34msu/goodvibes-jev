import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { applyRuntimeConfigOverrides, applyRuntimeConfigValue, applyRuntimeFeatureFlagOverrides, applyRuntimeCommandEndpointFlagOverrides, applyTerminalRuntimeConfigDefaults } from '../terminal-shell/src/cli-config-overrides.ts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const configDir = mkdtempSync(join(tmpdir(), 'runtime-cli-')); roots.push(configDir);
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ provider: { model: 'synthetic:disk' } }));
  return new ConfigManager({ configDir });
}

test('terminal sequence retains generic, translated features, model and endpoint authority across reload/save', () => {
  const config = fixture();
  expect(applyRuntimeConfigOverrides(config, ['provider.model=synthetic:generic', 'display.showTokenSpeed=false', 'controlPlane.port=4300'])).toEqual([]);
  expect(applyRuntimeFeatureFlagOverrides(config, { enableFeatures: [], disableFeatures: ['session-compaction'] })).toEqual([]);
  applyRuntimeConfigValue(config, 'provider.model', 'synthetic:explicit-model');
  expect(applyRuntimeCommandEndpointFlagOverrides(config, 'serve', { hostname: 'terminal.example.test', port: 4301 })).toEqual([]);
  applyTerminalRuntimeConfigDefaults(config);
  const before = config.getRaw(); config.load(); config.save(); config.load();
  expect(config.getRaw()).toEqual(before);
  const bytes = readFileSync(config.getConfigPath(), 'utf8');
  expect(bytes).not.toContain('terminal.example.test'); expect(bytes).not.toContain('synthetic:explicit-model');
  expect(bytes).not.toContain('showTokenSpeed'); expect(bytes).not.toContain('compactionStrategy');
});

test('terminal diagnostic wrappers omit raw override markers', () => {
  const errors = applyRuntimeConfigOverrides(fixture(), ['controlPlane.port=synthetic-sensitive-marker', 'synthetic-sensitive-marker', 'synthetic-sensitive-marker=true']);
  expect(errors).toHaveLength(3); expect(errors.join('\n')).not.toContain('synthetic-sensitive-marker');
});
