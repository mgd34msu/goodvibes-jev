import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import type { ConfigKey } from '../sdk/src/platform/config/schema.ts';
import * as atomic from '../sdk/src/platform/utils/atomic-json-store.ts';
const roots: string[] = [];
const restores: Array<() => void> = [];
afterEach(() => { for (const restore of restores.splice(0).reverse()) restore(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const HOST = 'behavior.runtimePrivacy' as ConfigKey;
function fixture(host = false, project = false) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-review-')); roots.push(root);
  return new ConfigManager({ configDir: join(root, 'config'), daemonTierPath: join(root, 'daemon.json'),
    ...(project ? { workingDir: root, surfaceRoot: 'tui' } : {}),
    ...(host ? { hostSettings: [{ key: HOST, type: 'boolean', default: true, description: 'Synthetic restrictive host flag' }] } : {}),
  });
}
function write(path: string, value: unknown) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); }
const prices = () => ({ 'synthetic:model': { input: 1, output: 2 } });

test.each(['override', 'default', 'persisted'] as const)('%s object reads and provenance values cannot mutate live state', mode => {
  const config = fixture();
  if (mode === 'override') config.setRuntimeOverride('pricing.modelPrices', prices());
  if (mode === 'default') config.setRuntimeDefault('pricing.modelPrices', prices());
  if (mode === 'persisted') config.set('pricing.modelPrices', prices());
  const before = config.getAutonomousPermissionSnapshot().incarnation;
  let notifications = 0; config.subscribe('pricing.modelPrices', () => { notifications++; });
  config.get('pricing.modelPrices')['synthetic:model']!.input = 99;
  (config.describeConfigKeySource('pricing.modelPrices').value as ReturnType<typeof prices>)['synthetic:model'].output = 98;
  expect(config.get('pricing.modelPrices')).toEqual(prices());
  expect(config.getRaw().pricing.modelPrices).toEqual(prices());
  expect(config.getAutonomousPermissionSnapshot().incarnation).toBe(before);
  expect(notifications).toBe(0);
});

test('each listener and hook gets independent object payloads with no retained manager aliases', () => {
  const config = fixture(); const observed: unknown[] = []; const retained: unknown[] = [];
  config.subscribe('pricing.modelPrices', (next, previous) => {
    retained.push(next, previous); next['synthetic:model']!.input = 99;
  });
  config.subscribe('pricing.modelPrices', next => { observed.push(next); });
  config.attachHookDispatcher({ fire: async event => {
    const value = (event.payload as { value: ReturnType<typeof prices> }).value;
    observed.push(structuredClone(value)); value['synthetic:model'].output = 98;
    retained.push(value); return { ok: true };
  } });
  config.setRuntimeOverride('pricing.modelPrices', prices());
  expect(observed).toEqual([prices(), prices()]);
  expect(config.get('pricing.modelPrices')).toEqual(prices());
  (retained[0] as ReturnType<typeof prices>)['synthetic:model'].input = 100;
  expect(config.get('pricing.modelPrices')).toEqual(prices());
});

test.each([false, true])('category replacement derives explicit descendant presence from its actual fields (daemon=%s)', daemon => {
  const withTier = fixture();
  const config = daemon ? withTier : new ConfigManager({ configDir: withTier.getControlPlaneConfigDir() });
  config.setRuntimeDefault('controlPlane.webui.serve', true);
  config.mergeCategory('controlPlane', { webui: {} } as never);
  expect(config.get('controlPlane.webui.serve')).toBe(true);
  expect(config.describeConfigKeySource('controlPlane.webui.serve')).toMatchObject({ tier: 'default', effectiveOrigin: 'runtime-default' });
  config.save(); expect(readFileSync(config.getConfigPath(), 'utf8')).not.toContain('serve');
  config.load(); expect(config.get('controlPlane.webui.serve')).toBe(true);
  config.mergeCategory('controlPlane', { webui: { serve: false } } as never);
  expect(config.get('controlPlane.webui.serve')).toBe(false);
  expect(config.describeConfigKeySource('controlPlane.webui.serve').effectiveOrigin).toBe(daemon ? 'daemon' : 'global');
});

test.each(['prepared-set', 'prepared-reset', 'manual-reset'] as const)('%s host publication carries its accepted global origin before callbacks', operation => {
  const config = fixture(true);
  const observed: unknown[] = [];
  config.getHostBooleanSetting(HOST).subscribe(() => { observed.push(config.describeConfigKeySource(HOST)); });
  if (operation === 'manual-reset') config.reset(HOST);
  else {
    const handle = config.prepareSettingMutation(operation === 'prepared-set'
      ? { operation: 'set', key: HOST, value: false }
      : { operation: 'reset', key: HOST });
    expect(config.finishPreparedMutation(handle, config.beginPreparedMutation(handle)).status).toBe('committed');
  }
  const value = operation !== 'prepared-set';
  expect(config.describeConfigKeySource(HOST)).toMatchObject({ value, tier: 'global', effectiveOrigin: 'global' });
  for (const report of observed) expect(report).toMatchObject({ value, tier: 'global', effectiveOrigin: 'global' });
});

test('prepared host partial publication reports the known project effect, unknown retains prior metadata', () => {
  const config = fixture(true, true);
  config.getHostBooleanSetting(HOST).set(false); config.getHostBooleanSetting(HOST).setProjectValue(false);
  const handle = config.prepareSettingMutation({ operation: 'reset', key: HOST });
  const transition = config.beginPreparedMutation(handle);
  const original = atomic.writeJsonFileAtomic;
  const spy = spyOn(atomic, 'writeJsonFileAtomic').mockImplementation((path, data, options) => {
    if (path === config.getConfigPath()) throw new Error('synthetic later failure');
    original(path, data, options);
  }); restores.push(() => spy.mockRestore());
  expect(config.finishPreparedMutation(handle, transition).status).toBe('partial');
  expect(config.describeConfigKeySource(HOST)).toMatchObject({ value: true, tier: 'project', effectiveOrigin: 'project' });
  spy.mockRestore();
  const previous = config.describeConfigKeySource(HOST);
  const unknown = config.prepareSettingMutation({ operation: 'set', key: HOST, value: false });
  const next = config.beginPreparedMutation(unknown);
  const fail = spyOn(atomic, 'writeJsonFileAtomic').mockImplementation(() => { throw new Error('synthetic uncertain failure'); });
  restores.push(() => fail.mockRestore());
  expect(config.finishPreparedMutation(unknown, next).status).toBe('unknown');
  expect(config.describeConfigKeySource(HOST)).toEqual(previous);
});

test('full reset retains explicit project host provenance while clearing the global host copy', () => {
  const config = fixture(true, true);
  config.getHostBooleanSetting(HOST).set(false); config.getHostBooleanSetting(HOST).setProjectValue(false);
  config.reset();
  expect(config.describeConfigKeySource(HOST)).toMatchObject({ value: true, tier: 'project', effectiveOrigin: 'project' });
  expect(JSON.parse(readFileSync(config.getConfigPath(), 'utf8'))).toEqual({});
  config.load(); expect(config.describeConfigKeySource(HOST)).toMatchObject({ value: true, tier: 'project', effectiveOrigin: 'project' });
});

test('restrictive failed-read and malformed host projections distinguish effective default from accepted tier', () => {
  const config = fixture(true, true);
  config.getHostBooleanSetting(HOST).set(false);
  writeFileSync(config.getDaemonTierPath()!, '{invalid');
  expect(() => config.load()).toThrow();
  expect(config.describeConfigKeySource(HOST)).toMatchObject({ value: true, tier: 'global', effectiveOrigin: 'default' });
  write(config.getDaemonTierPath()!, {}); config.load();
  expect(config.describeConfigKeySource(HOST)).toMatchObject({ value: false, tier: 'global', effectiveOrigin: 'global' });
  write(config.getProjectConfigPath()!, { behavior: [] }); config.load();
  expect(config.describeConfigKeySource(HOST)).toMatchObject({ value: true, tier: 'global', effectiveOrigin: 'default' });
  write(config.getProjectConfigPath()!, { behavior: { runtimePrivacy: true } }); config.load();
  expect(config.describeConfigKeySource(HOST)).toMatchObject({ value: true, tier: 'project', effectiveOrigin: 'project' });
});
