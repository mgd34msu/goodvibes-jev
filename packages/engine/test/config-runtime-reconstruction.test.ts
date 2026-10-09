import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { DEFAULT_CONFIG } from '../sdk/src/platform/config/schema.ts';
import { ensureConnectorConfigSections } from '../sdk/src/platform/config/connector-config-sections.ts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function write(path: string, value: unknown) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); }
function fixture(global = false) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-reconstruction-')); roots.push(root);
  const workingDir = join(root, 'workspace'); mkdirSync(workingDir);
  const configDir = join(root, 'config'); if (global) write(join(configDir, 'settings.json'), {});
  const config = new ConfigManager({ configDir, workingDir, surfaceRoot: 'tui', sharedTierPath: join(root, 'shared.json'), daemonTierPath: join(root, 'daemon.json') });
  const paths = { global: config.getConfigPath(), project: config.getProjectConfigPath()!, shared: config.getSharedTierPath()!, daemon: config.getDaemonTierPath()! };
  return { config, paths };
}
const cases = [
  ['global', 'provider.model', 'synthetic:disk', DEFAULT_CONFIG.provider.model, { provider: { model: 'synthetic:disk' } }],
  ['project', 'provider.model', 'synthetic:disk', DEFAULT_CONFIG.provider.model, { provider: { model: 'synthetic:disk' } }],
  ['shared', 'tts.voice', 'synthetic-voice', DEFAULT_CONFIG.tts.voice, { tts: { voice: 'synthetic-voice' } }],
  ['daemon', 'surfaces.email.host', 'synthetic.example.test', DEFAULT_CONFIG.surfaces.email.host, { surfaces: { email: { host: 'synthetic.example.test' } } }],
] as const;
for (const global of [false, true]) for (const [tier, key, value, fallback, raw] of cases) {
  test(`${tier} key/file deletion reconstructs defaults; sparse global initially ${global}`, () => {
    const { config, paths } = fixture(global);
    config.setRuntimeOverride('permissions.mode', 'plan');
    write(paths[tier], raw); config.load(); expect(config.get(key)).toBe(value);
    write(paths[tier], {}); config.load(); expect(config.get(key)).toBe(fallback);
    write(paths[tier], raw); config.load(); rmSync(paths[tier]); config.load();
    expect(config.get(key)).toBe(fallback); expect(config.get('permissions.mode')).toBe('plan');
    expect(config.describeConfigKeySource(key).tier).toBe('default');
  });
}

test.each(['global', 'project', 'shared', 'daemon'] as const)('refused %s never publishes partial underlay or provenance; repair reconstructs', tier => {
  const { config, paths } = fixture();
  write(paths.global, { provider: { model: 'synthetic:last-good' }, display: { showTokenSpeed: false } });
  config.load(); config.setRuntimeDefault('display.showTokenSpeed', true); config.setRuntimeOverride('provider.model', 'synthetic:cli');
  const before = config.getRaw();
  const source = config.describeConfigKeySource('provider.model');
  write(paths.global, {}); write(paths[tier], { permissions: { mode: 'invalid' } });
  expect(() => config.load()).toThrow(); expect(config.getRaw()).toEqual(before);
  expect(config.describeConfigKeySource('provider.model')).toEqual(source);
  config.setRuntimeDefault('display.showTokenSpeed', true); expect(config.get('display.showTokenSpeed')).toBe(false);
  write(paths[tier], {}); config.load();
  expect(config.get('display.showTokenSpeed')).toBe(true);
  expect(config.describeConfigKeySource('display.showTokenSpeed')).toMatchObject({ tier: 'default', effectiveOrigin: 'runtime-default' });
});

test('runtime provenance retains daemon/shared ownership and resets on superseding writes', () => {
  const { config } = fixture();
  config.set('tts.voice', 'synthetic-shared'); config.set('surfaces.email.host', 'disk.example.test');
  config.setRuntimeOverride('tts.voice', 'synthetic-cli'); config.setRuntimeOverride('surfaces.email.host', 'cli.example.test');
  expect(config.describeConfigKeySource('tts.voice')).toMatchObject({ tier: 'shared', effectiveOrigin: 'runtime', shareable: true });
  expect(config.describeConfigKeySource('surfaces.email.host')).toMatchObject({ tier: 'daemon', effectiveOrigin: 'runtime', daemonOwned: true });
  config.set('surfaces.email.host', 'chosen.example.test');
  expect(config.describeConfigKeySource('surfaces.email.host')).toMatchObject({ tier: 'daemon', effectiveOrigin: 'daemon', value: 'chosen.example.test' });
});

test('unknown extension values disappear on deletion and connector seeders stay no-op', () => {
  const { config, paths } = fixture();
  config.mergeCategory('helper', { syntheticExtension: true } as never); config.load();
  expect(config.getCategory('helper')).toHaveProperty('syntheticExtension');
  write(paths.global, {}); config.load();
  expect(config.getCategory('helper')).not.toHaveProperty('syntheticExtension');
  const before = config.getRaw(); ensureConnectorConfigSections(config); expect(config.getRaw()).toEqual(before);
});

test('separate managers retain independent invocation authority over shared files', () => {
  const { config } = fixture();
  const other = new ConfigManager({ configDir: config.getControlPlaneConfigDir() });
  config.setRuntimeOverride('provider.model', 'synthetic:first'); other.setRuntimeOverride('provider.model', 'synthetic:second');
  config.set('provider.model', 'synthetic:persisted'); other.load();
  expect(config.get('provider.model')).toBe('synthetic:persisted'); expect(other.get('provider.model')).toBe('synthetic:second');
});

test('watcher ignores hidden underlay changes and notifies visible deletions once', async () => {
  const { config, paths } = fixture();
  write(paths.global, { provider: { model: 'synthetic:first' }, display: { showTokenSpeed: false } }); config.load();
  config.setRuntimeOverride('provider.model', 'synthetic:cli'); config.setRuntimeDefault('display.showTokenSpeed', true);
  const observed: unknown[] = [];
  config.subscribe('provider.model', value => observed.push(['model', value]));
  config.subscribe('display.showTokenSpeed', value => observed.push(['speed', value]));
  const stop = config.watchConfigFiles({ intervalMs: 5 });
  try {
    write(paths.global, { provider: { model: 'synthetic:second' } });
    const end = Date.now() + 2_000; while (!observed.length && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5));
    expect(observed).toEqual([['speed', true]]);
    await new Promise(resolve => setTimeout(resolve, 20)); expect(observed).toHaveLength(1);
    expect(config.get('provider.model')).toBe('synthetic:cli');
  } finally { stop(); }
});

test('deleting higher tiers reveals the next accepted layer and keeps active invocation authority', () => {
  const { config, paths } = fixture();
  write(paths.global, { tts: { voice: 'synthetic-global' } });
  write(paths.project, { tts: { voice: 'synthetic-project' } });
  write(paths.shared, { tts: { voice: 'synthetic-shared' } });
  config.load(); expect(config.get('tts.voice')).toBe('synthetic-shared');
  rmSync(paths.shared); config.load(); expect(config.get('tts.voice')).toBe('synthetic-project');
  rmSync(paths.project); config.load(); expect(config.get('tts.voice')).toBe('synthetic-global');
  config.setRuntimeOverride('tts.voice', 'synthetic-cli');
  rmSync(paths.global); config.load(); expect(config.get('tts.voice')).toBe('synthetic-cli');
  config.reset('tts.voice'); config.load(); expect(config.get('tts.voice')).toBe(DEFAULT_CONFIG.tts.voice);
});
