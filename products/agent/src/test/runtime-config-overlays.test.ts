import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { applyRuntimeConfigOverrides as agentOverrides, applyRuntimeConfigValue as agentValue, applyRuntimeFeatureOverrides, applyRuntimeUrlOverride, applyRuntimeCommandEndpointFlagOverrides as agentEndpoint } from '../cli/config-overrides.ts';
import { applyRuntimeConfigValue, applyTerminalRuntimeConfigDefaults } from '@goodvibes-jev/engine/terminal-shell';
import { AgentConfigManager, AGENT_NOTIFICATIONS_METADATA_ONLY_KEY } from '../config/host-settings.ts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const configDir = mkdtempSync(join(tmpdir(), 'runtime-cli-')); roots.push(configDir);
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ provider: { model: 'synthetic:disk' } }));
  return new ConfigManager({ configDir });
}

test('Agent environment URL followed by explicit flags is captured once and survives later loads', () => {
  const config = fixture();
  expect(applyRuntimeUrlOverride(config, 'environment.example.test:4300', 'GOODVIBES_RUNTIME_URL')).toEqual([]);
  expect(agentOverrides(config, ['controlPlane.port=4301', 'provider.model=synthetic:generic'])).toEqual([]);
  expect(applyRuntimeFeatureOverrides(config, { enableFeatures: [], disableFeatures: ['session-compaction'] })).toEqual([]);
  agentValue(config, 'provider.model', 'synthetic:explicit-model');
  expect(applyRuntimeUrlOverride(config, 'explicit.example.test:4302')).toEqual([]);
  expect(agentEndpoint(config, 'pair', { hostname: 'endpoint.example.test', port: 4303 })).toEqual([]);
  writeFileSync(config.getConfigPath(), JSON.stringify({ provider: { model: 'synthetic:new-disk' }, controlPlane: { host: 'new-disk.example.test', port: 4304 } }));
  config.load(); config.load();
  expect(config.get('provider.model')).toBe('synthetic:explicit-model');
  expect(config.get('controlPlane.host')).toBe('endpoint.example.test'); expect(config.get('controlPlane.port')).toBe(4303);
  expect(config.get('behavior.compactionStrategy')).toBe('off');
});

test('Agent runtime inputs cannot grant host notification detail after a failed load', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-host-')); roots.push(root);
    const config = new AgentConfigManager({ configDir: join(root, 'config'), daemonTierPath: join(root, 'daemon.json') });
    config.getHostBooleanSetting(AGENT_NOTIFICATIONS_METADATA_ONLY_KEY).set(false);
    applyRuntimeConfigValue(config, 'provider.model', 'synthetic:cli');
    expect(() => applyRuntimeConfigValue(config, AGENT_NOTIFICATIONS_METADATA_ONLY_KEY as never, false)).toThrow('builtin schema key');
    mkdirSync(dirname(config.getDaemonTierPath()!), { recursive: true }); writeFileSync(config.getDaemonTierPath()!, '{invalid');
    expect(() => config.load()).toThrow(); expect(config.getHostBooleanSetting(AGENT_NOTIFICATIONS_METADATA_ONLY_KEY).get()).toBe(true);
    applyTerminalRuntimeConfigDefaults(config); expect(config.getHostBooleanSetting(AGENT_NOTIFICATIONS_METADATA_ONLY_KEY).get()).toBe(true);
    expect(config.get('provider.model')).toBe('synthetic:cli');
  });
test('Agent diagnostic wrappers omit raw override and URL markers', () => {
  const config = fixture();
  const errors = agentOverrides(config, ['controlPlane.port=synthetic-sensitive-marker', 'synthetic-sensitive-marker', 'synthetic-sensitive-marker=true']);
  expect(errors).toHaveLength(3); expect(errors.join('\n')).not.toContain('synthetic-sensitive-marker');
  expect(applyRuntimeUrlOverride(config, 'https://synthetic-sensitive-marker.example.test')[0]).not.toContain('synthetic-sensitive-marker');
});
