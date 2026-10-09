import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { DEFAULT_CONFIG } from '../sdk/src/platform/config/schema.ts';
import { setManagedSettingLock } from '../sdk/src/platform/runtime/settings/control-plane.ts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'runtime-lifecycle-')); roots.push(root);
  const configDir = join(root, 'config'); mkdirSync(configDir);
  const config = new ConfigManager({ configDir, daemonTierPath: join(root, 'daemon', 'settings.json'), sharedTierPath: join(root, 'shared', 'settings.json') });
  return { root, config };
}

test.each(['set', 'dynamic', 'project-fallback'] as const)('%s same-value explicit write retires constructor authority and preserves a sibling', kind => {
  const { root } = fixture();
  const config = new ConfigManager({ configDir: join(root, 'second'), model: 'synthetic:cli', autoApprove: false, systemPromptFile: '' });
  if (kind === 'set') config.set('provider.model', 'synthetic:cli');
  if (kind === 'dynamic') config.setDynamic('provider.model', 'synthetic:cli');
  if (kind === 'project-fallback') config.setProjectValue('provider.model', 'synthetic:cli');
  writeFileSync(config.getConfigPath(), JSON.stringify({ provider: { model: 'synthetic:later' }, behavior: { autoApprove: true } }));
  config.load();
  expect(config.get('provider.model')).toBe('synthetic:later');
  expect(config.get('behavior.autoApprove')).toBe(false);
});

test('standalone locks do not reconcile old invocation values; a managed persistent update retires them', () => {
  const { config } = fixture();
  config.setRuntimeOverride('provider.model', 'synthetic:cli');
  setManagedSettingLock('provider.model', 'synthetic', 'test', config.getControlPlaneConfigDir());
  config.load(); expect(config.get('provider.model')).toBe('synthetic:cli');
  expect(() => config.setRuntimeOverride('provider.model', 'synthetic:second')).toThrow();
  config.setDynamic('provider.model', 'synthetic:managed', { bypassManagedLock: true });
  config.load(); expect(config.get('provider.model')).toBe('synthetic:managed');
});

test.each(['set', 'category', 'remove', 'reset', 'full-reset'] as const)('%s failed file write retains live and invocation state', kind => {
  const { config } = fixture();
  config.setRuntimeOverride('provider.model', 'synthetic:cli');
  const before = config.getRaw();
  const privateWriter = config as unknown as { writeRawGlobal(raw: unknown): void };
  const failure = spyOn(privateWriter, 'writeRawGlobal').mockImplementation(() => { throw new Error('synthetic failure'); });
  try {
    expect(() => {
      if (kind === 'set') config.set('provider.model', 'synthetic:next');
      if (kind === 'category') config.mergeCategory('provider', { model: 'synthetic:next' });
      if (kind === 'remove') config.removeCategoryKey('provider', 'model');
      if (kind === 'reset') config.reset('provider.model');
      if (kind === 'full-reset') config.reset();
    }).toThrow('synthetic failure');
    expect(config.getRaw()).toEqual(before);
  } finally { failure.mockRestore(); }
  config.load(); expect(config.get('provider.model')).toBe('synthetic:cli');
  config.save(); expect(readFileSync(config.getConfigPath(), 'utf8')).not.toContain('synthetic:cli');
});

test('a later category write failure leaves complete memory intact even after the daemon file changed', () => {
  const { config } = fixture();
  config.setRuntimeOverride('controlPlane.host', 'cli.example.test');
  config.setRuntimeOverride('controlPlane.port', 4311);
  const before = config.getRaw();
  const privateWriter = config as unknown as { writeRawGlobal(raw: unknown): void };
  const failure = spyOn(privateWriter, 'writeRawGlobal').mockImplementation(() => { throw new Error('synthetic late failure'); });
  try {
    expect(() => config.mergeCategory('controlPlane', { host: 'disk.example.test', port: 4312 })).toThrow();
    expect(config.getRaw()).toEqual(before);
    expect(readFileSync(config.getDaemonTierPath()!, 'utf8')).toContain('disk.example.test');
  } finally { failure.mockRestore(); }
  config.load(); expect(config.get('controlPlane.host')).toBe('cli.example.test');
  expect(config.get('controlPlane.port')).toBe(4311);
});

test('a later reset tier failure does not publish retirement after the global write completed', () => {
  const { config } = fixture();
  config.set('provider.model', 'synthetic:disk');
  config.setRuntimeOverride('provider.model', 'synthetic:cli');
  const before = config.getRaw();
  const shared = config.getSharedTierPath()!; mkdirSync(dirname(shared), { recursive: true }); mkdirSync(shared);
  expect(() => config.reset()).toThrow();
  expect(config.getRaw()).toEqual(before);
  expect(JSON.parse(readFileSync(config.getConfigPath(), 'utf8'))).toEqual({});
  rmSync(shared, { recursive: true });
  config.load(); expect(config.get('provider.model')).toBe('synthetic:cli');
});

test('category replacement retires descendants and undefined patch fields preserve their overlays', () => {
  const { config } = fixture();
  config.setRuntimeOverride('controlPlane.webui.serve', true);
  config.setRuntimeOverride('controlPlane.port', 4311);
  config.mergeCategory('controlPlane', { webui: { ...DEFAULT_CONFIG.controlPlane.webui, serve: false }, port: undefined } as never);
  config.load();
  expect(config.get('controlPlane.webui.serve')).toBe(false);
  expect(config.get('controlPlane.port')).toBe(4311);
});

test('subscriber reentrant load sees committed retirement and complete batch state', () => {
  const { config } = fixture();
  config.setRuntimeOverride('controlPlane.host', 'cli.example.test');
  config.setRuntimeOverride('controlPlane.port', 4311);
  const observed: unknown[] = [];
  config.subscribe('controlPlane.host', () => { config.load(); observed.push([config.get('controlPlane.host'), config.get('controlPlane.port')]); });
  config.setDaemonValues({ 'controlPlane.host': 'disk.example.test', 'controlPlane.port': 4312 });
  expect(observed).toEqual([['disk.example.test', 4312]]);
});
