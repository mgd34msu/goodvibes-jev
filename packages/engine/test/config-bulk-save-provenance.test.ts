import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { DEFAULT_CONFIG } from '../sdk/src/platform/config/schema.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value));
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bulk-save-provenance-')); roots.push(root);
  const config = new ConfigManager({ configDir: join(root, 'config'), workingDir: join(root, 'project'),
    surfaceRoot: 'tui', sharedTierPath: join(root, 'shared.json'), daemonTierPath: join(root, 'daemon.json') });
  return { config, global: config.getConfigPath(), project: config.getProjectConfigPath()!,
    shared: config.getSharedTierPath()!, daemon: config.getDaemonTierPath()! };
}

for (const destination of ['global', 'project'] as const) {
  test(`bulk ${destination} save reports the written underlay without retiring runtime inputs`, () => {
    const f = fixture();
    write(f.global, { provider: { model: 'synthetic:disk' } }); f.config.load();
    f.config.setRuntimeOverride('provider.model', 'synthetic:invocation');
    f.config.setRuntimeDefault('display.showTokenSpeed', true);
    if (destination === 'global') f.config.save(); else f.config.saveProject();
    expect(readFileSync(f[destination], 'utf8')).not.toContain('synthetic:invocation');
    const source = f.config.describeConfigKeySource('provider.model');
    expect(source).toMatchObject({ tier: destination, effectiveOrigin: 'runtime', value: 'synthetic:invocation' });
    expect(f.config.describeConfigKeySource('display.showTokenSpeed')).toMatchObject({ tier: 'default', effectiveOrigin: 'runtime-default', value: true });
    f.config.load(); expect(f.config.describeConfigKeySource('provider.model')).toEqual(source);
    expect(f.config.get('display.showTokenSpeed')).toBe(true);
  });

  test(`bulk ${destination} save removes stripped shipped-default provenance`, () => {
    const f = fixture();
    write(f[destination], { display: { showTokenSpeed: DEFAULT_CONFIG.display.showTokenSpeed } }); f.config.load();
    expect(f.config.describeConfigKeySource('display.showTokenSpeed').tier).toBe(destination);
    if (destination === 'global') f.config.save(); else f.config.saveProject();
    const source = f.config.describeConfigKeySource('display.showTokenSpeed');
    expect(source).toMatchObject({ tier: 'default', effectiveOrigin: 'default', value: DEFAULT_CONFIG.display.showTokenSpeed });
    f.config.load(); expect(f.config.describeConfigKeySource('display.showTokenSpeed')).toEqual(source);
  });

  test(`failed bulk ${destination} save preserves last-good values and origins`, () => {
    const f = fixture();
    write(f.global, { provider: { model: 'synthetic:disk' }, display: { showTokenSpeed: false } }); f.config.load();
    f.config.setRuntimeOverride('provider.model', 'synthetic:invocation');
    f.config.setRuntimeDefault('display.showTokenSpeed', true);
    const before = f.config.getRaw();
    const sources = ['provider.model', 'display.showTokenSpeed'].map(key => f.config.describeConfigKeySource(key as 'provider.model' | 'display.showTokenSpeed'));
    rmSync(f[destination], { force: true }); mkdirSync(f[destination], { recursive: true });
    expect(() => destination === 'global' ? f.config.save() : f.config.saveProject()).toThrow();
    expect(f.config.getRaw()).toEqual(before);
    expect(['provider.model', 'display.showTokenSpeed'].map(key => f.config.describeConfigKeySource(key as 'provider.model' | 'display.showTokenSpeed'))).toEqual(sources);
  });

  test(`bulk ${destination} save preserves accepted higher-tier sources`, () => {
    const f = fixture();
    write(f.project, { provider: { model: 'synthetic:project' } });
    write(f.shared, { tts: { voice: 'synthetic-shared' } });
    write(f.daemon, { surfaces: { email: { host: 'synthetic.example.test' } } }); f.config.load();
    if (destination === 'global') f.config.save(); else f.config.saveProject();
    const keys = ['provider.model', 'tts.voice', 'surfaces.email.host'] as const;
    const sources = keys.map(key => f.config.describeConfigKeySource(key));
    expect(sources.map(source => source.tier)).toEqual(['project', 'shared', 'daemon']);
    f.config.load(); expect(keys.map(key => f.config.describeConfigKeySource(key))).toEqual(sources);
  });
}

test.each(['load', 'set', 'category', 'bulk'] as const)('project stripping reveals the accepted global underlay from %s', origin => {
  const f = fixture();
  if (origin === 'load') { write(f.global, { display: { showTokenSpeed: true } }); f.config.load(); }
  if (origin === 'set') f.config.set('display.showTokenSpeed', true);
  if (origin === 'category') f.config.mergeCategory('display', { showTokenSpeed: true });
  if (origin === 'bulk') { f.config.setProjectValue('display.showTokenSpeed', true); f.config.save(); }
  f.config.setProjectValue('display.showTokenSpeed', false);
  f.config.setRuntimeOverride('provider.model', 'synthetic:invocation');
  f.config.saveProject();
  const source = f.config.describeConfigKeySource('display.showTokenSpeed');
  expect(source).toMatchObject({ tier: 'global', effectiveOrigin: 'global', value: true });
  f.config.load(); expect(f.config.describeConfigKeySource('display.showTokenSpeed')).toEqual(source);
  expect(f.config.get('provider.model')).toBe('synthetic:invocation');
});

test('project stripping does not accept unvalidated external edits to the lower tier', () => {
  const f = fixture();
  write(f.global, { display: { showTokenSpeed: true } });
  write(f.project, { display: { showTokenSpeed: false } }); f.config.load();
  writeFileSync(f.global, '{invalid');
  expect(() => f.config.load()).toThrow();
  f.config.saveProject();
  expect(f.config.describeConfigKeySource('display.showTokenSpeed')).toMatchObject({ tier: 'global', value: true });
  expect(readFileSync(f.global, 'utf8')).toBe('{invalid');
});

test('failed project save does not publish stripped-key fallback until the write succeeds', () => {
  const f = fixture();
  write(f.global, { display: { showTokenSpeed: true } });
  write(f.project, { display: { showTokenSpeed: false } }); f.config.load();
  const source = f.config.describeConfigKeySource('display.showTokenSpeed');
  rmSync(f.project); mkdirSync(f.project);
  expect(() => f.config.saveProject()).toThrow();
  expect(f.config.describeConfigKeySource('display.showTokenSpeed')).toEqual(source);
  rmSync(f.project, { recursive: true }); f.config.saveProject();
  expect(f.config.describeConfigKeySource('display.showTokenSpeed')).toMatchObject({ tier: 'global', value: true });
  f.config.load();
  expect(f.config.describeConfigKeySource('display.showTokenSpeed')).toMatchObject({ tier: 'global', value: true });
});

test.each(['reset', 'full-reset', 'remove', 'prepared-reset'] as const)('%s clears the accepted global fallback', operation => {
  const { config } = fixture(); config.set('display.showTokenSpeed', true);
  if (operation === 'reset') config.reset('display.showTokenSpeed');
  if (operation === 'full-reset') config.reset();
  if (operation === 'remove') config.removeCategoryKey('display', 'showTokenSpeed');
  if (operation === 'prepared-reset') {
    const handle = config.prepareSettingMutation({ operation: 'reset', key: 'display.showTokenSpeed' });
    expect(config.finishPreparedMutation(handle, config.beginPreparedMutation(handle)).status).toBe('committed');
  }
  config.setProjectValue('display.showTokenSpeed', false); config.saveProject();
  const source = config.describeConfigKeySource('display.showTokenSpeed');
  expect(source).toMatchObject({ tier: 'default', value: false });
  config.load(); expect(config.describeConfigKeySource('display.showTokenSpeed')).toEqual(source);
});

test('prepared set refreshes the accepted global fallback', () => {
  const { config } = fixture();
  const handle = config.prepareSettingMutation({ operation: 'set', key: 'display.showTokenSpeed', value: true });
  expect(config.finishPreparedMutation(handle, config.beginPreparedMutation(handle)).status).toBe('committed');
  config.setProjectValue('display.showTokenSpeed', false); config.saveProject();
  const source = config.describeConfigKeySource('display.showTokenSpeed');
  expect(source).toMatchObject({ tier: 'global', value: true });
  config.load(); expect(config.describeConfigKeySource('display.showTokenSpeed')).toEqual(source);
});

test('failed later-tier load does not replace the accepted global fallback', () => {
  const f = fixture(); f.config.set('display.showTokenSpeed', true);
  write(f.global, { display: { showTokenSpeed: false } });
  mkdirSync(dirname(f.project), { recursive: true }); writeFileSync(f.project, '{invalid');
  expect(() => f.config.load()).toThrow();
  write(f.project, {}); f.config.setProjectValue('display.showTokenSpeed', false); f.config.saveProject();
  expect(f.config.describeConfigKeySource('display.showTokenSpeed')).toMatchObject({ tier: 'global', value: true });
});

test('project stripping restores an accepted global atomic object', () => {
  const { config } = fixture();
  config.set('pricing.modelPrices', { 'synthetic:model': { input: 1, output: 2 } });
  config.setProjectValue('pricing.modelPrices', {}); config.saveProject();
  const source = config.describeConfigKeySource('pricing.modelPrices');
  expect(source).toMatchObject({ tier: 'global', value: { 'synthetic:model': { input: 1, output: 2 } } });
  config.load(); expect(config.describeConfigKeySource('pricing.modelPrices')).toEqual(source);
});
