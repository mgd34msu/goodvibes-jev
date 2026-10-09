import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConfigManager, type PreparedConfigMutation, type PreparedConfigMutationTransition } from '../sdk/src/platform/config/manager.js';
import { CONFIG_SCHEMA, type ConfigKey } from '../sdk/src/platform/config/schema.js';
import * as atomic from '../sdk/src/platform/utils/atomic-json-store.js';

const roots: string[] = [];
const restorers: Array<() => void> = [];
afterEach(() => {
  for (const restore of restorers.splice(0).reverse()) restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const hostKey = 'permissions.preparedFixture' as ConfigKey;
function fixture(options: { project?: boolean; tiers?: boolean; host?: boolean; readOnly?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'config-prepared-')); roots.push(root);
  const workingDir = options.project ? join(root, 'workspace') : undefined;
  if (workingDir) mkdirSync(workingDir);
  const manager = new ConfigManager({ configDir: join(root, 'config'),
    ...(workingDir ? { workingDir, surfaceRoot: 'tui' } : {}),
    ...(options.tiers ? { daemonTierPath: join(root, 'daemon.json'), sharedTierPath: join(root, 'shared.json') } : {}),
    ...(options.host ? { hostSettings: [{ key: hostKey, type: 'boolean', default: false, description: 'Synthetic restrictive flag' }] } : {}),
    readOnly: options.readOnly,
  });
  return { manager, root };
}
function write(path: string, data: unknown) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(data)); }
function read(path: string): Record<string, unknown> { return JSON.parse(readFileSync(path, 'utf8')); }
function model(manager: ConfigManager, value = 'openai:fixture-prepared') {
  return manager.prepareSettingMutation({ operation: 'set', key: 'provider.model', value });
}
function finish(manager: ConfigManager, handle: PreparedConfigMutation) {
  return manager.finishPreparedMutation(handle, manager.beginPreparedMutation(handle));
}
function changeValidator(callback: (value: unknown) => boolean) {
  const schema = CONFIG_SCHEMA.find(entry => entry.key === 'provider.model')!;
  const previous = schema.validate;
  schema.validate = callback;
  restorers.push(() => { schema.validate = previous; });
  return schema;
}

describe('ConfigManager prepared same-owner mutation', () => {
  test('normalizes before admission, exposes detached facts, and permits exactly its own transition', () => {
    const { manager } = fixture();
    const handle = manager.prepareSettingMutation({ operation: 'set', key: 'payments.budget.perPurchaseCeiling', value: '$12.34' });
    const facts = manager.inspectPreparedMutation(handle);
    expect(facts.value).toBe(12.34);
    expect(Object.isFrozen(facts)).toBe(true);
    expect(Object.isFrozen(facts.destinations)).toBe(true);
    const before = manager.getAutonomousPermissionSnapshot().incarnation;
    const transition = manager.beginPreparedMutation(handle);
    expect(manager.inspectPreparedMutationTransition(handle, transition)).toEqual({ beforeIncarnation: before, afterIncarnation: before + 1 });
    expect(manager.get('payments.budget.perPurchaseCeiling')).not.toBe(12.34);
    const receipt = manager.finishPreparedMutation(handle, transition);
    expect(receipt).toEqual({ status: 'committed', completedPaths: [manager.getConfigPath()] });
    expect(manager.get('payments.budget.perPurchaseCeiling')).toBe(12.34);
    expect(() => manager.finishPreparedMutation(handle, transition)).toThrow();
    expect(() => manager.beginPreparedMutation(handle)).toThrow();
  });

  test('rejects forged, copied, other-manager, and mismatched handles and transitions', () => {
    const { manager } = fixture(); const other = fixture().manager;
    const handle = model(manager);
    expect(() => manager.beginPreparedMutation({ ...handle } as PreparedConfigMutation)).toThrow();
    expect(() => other.beginPreparedMutation(handle)).toThrow();
    const transition = manager.beginPreparedMutation(handle);
    expect(() => manager.assertPreparedMutationTransition(handle, {} as PreparedConfigMutationTransition)).toThrow();
    expect(() => manager.assertPreparedMutationTransition(handle, { ...transition } as PreparedConfigMutationTransition)).toThrow();
    expect(() => other.assertPreparedMutationTransition(handle, transition)).toThrow();
    expect(() => manager.assertPreparedMutationTransition(model(manager), transition)).toThrow();
    expect(manager.finishPreparedMutation(handle, transition).status).toBe('committed');
  });

  for (const mutation of ['save', 'saveProject', 'noop', 'failed'] as const) {
    test(`a reentrant ${mutation} retires the expected own transition`, () => {
      const { manager } = fixture({ project: true });
      const handle = model(manager);
      let nested = false;
      manager.onDidInvalidate(() => {
        if (nested) return; nested = true;
        if (mutation === 'save') manager.save();
        if (mutation === 'saveProject') manager.saveProject();
        if (mutation === 'noop') manager.removeCategoryKey('helper', 'absent');
        if (mutation === 'failed') { try { manager.set('tts.speed', -4); } catch { /* Expected validation failure. */ } }
      });
      expect(() => manager.beginPreparedMutation(handle)).toThrow();
      expect(manager.get('provider.model')).not.toBe('openai:fixture-prepared');
      expect(() => manager.beginPreparedMutation(handle)).toThrow();
    });
  }

  test('save and saveProject advance incarnation without introducing invalidation callbacks', () => {
    const { manager } = fixture({ project: true }); let callbacks = 0;
    manager.onDidInvalidate(() => { callbacks++; });
    const initial = manager.getAutonomousPermissionSnapshot().incarnation;
    manager.save(); manager.saveProject();
    expect(callbacks).toBe(0);
    expect(manager.getAutonomousPermissionSnapshot().incarnation).toBe(initial + 2);
  });

  test('a callback validator cannot mutate or replace its captured schema and then commit', () => {
    const { manager } = fixture(); let armed = false;
    const schema = changeValidator(() => { if (armed) manager.save(); return true; });
    const handle = model(manager); armed = true;
    expect(() => manager.beginPreparedMutation(handle)).toThrow();
    armed = false;
    const second = model(manager); schema.validate = () => true;
    expect(() => manager.beginPreparedMutation(second)).toThrow();
  });

  test('final validation refuses a changed schema, policy, or same-owner ABA after begin', () => {
    for (const change of ['schema', 'policy', 'aba'] as const) {
      const { manager } = fixture(); const handle = model(manager);
      const transition = manager.beginPreparedMutation(handle);
      if (change === 'schema') changeValidator(() => true);
      if (change === 'policy') write(join(manager.getControlPlaneConfigDir(), 'settings-sync.json'),
        { version: 2, managedLocks: [{ key: 'provider.model', source: 'synthetic', reason: 'held', updatedAt: 1 }] });
      if (change === 'aba') { const old = manager.get('display.stream'); manager.set('display.stream', !old); manager.set('display.stream', old); }
      expect(() => manager.finishPreparedMutation(handle, transition)).toThrow();
      expect(manager.get('provider.model')).not.toBe('openai:fixture-prepared');
    }
  });

  test('strict preparation refuses malformed files/policy without quarantine or stale-temp cleanup', () => {
    const { manager } = fixture(); const path = manager.getConfigPath();
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '{bad');
    const stale = `${path}.tmp-stale`; writeFileSync(stale, 'synthetic'); utimesSync(stale, 0, 0);
    expect(() => model(manager)).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('{bad');
    expect(readdirSync(dirname(path)).sort()).toEqual(['settings.json', 'settings.json.tmp-stale']);
    write(path, {}); writeFileSync(join(dirname(path), 'settings-sync.json'), '{bad');
    expect(() => model(manager)).toThrow();
    expect(existsSync(stale)).toBe(true);
    write(join(dirname(path), 'settings-sync.json'), {});
    expect(finish(manager, model(manager)).status).toBe('committed');
    expect(existsSync(stale)).toBe(true);
  });

  test('readonly owners refuse preparation and reset while legacy manual APIs remain usable', () => {
    const readonly = fixture({ readOnly: true }).manager;
    expect(() => model(readonly)).toThrow('read-only');
    expect(() => readonly.prepareSettingMutation({ operation: 'reset', key: 'provider.model' })).toThrow('read-only');
    const { manager } = fixture(); manager.set('provider.model', 'openai:legacy');
    expect(manager.get('provider.model')).toBe('openai:legacy');
  });

  test('set binds daemon/shared/global destinations and merges latest unrelated store content', () => {
    const { manager } = fixture({ tiers: true });
    for (const [key, value, path] of [
      ['provider.model', 'openai:destination', manager.getConfigPath()],
      ['tts.voice', 'synthetic-voice', manager.getSharedTierPath()],
      ['surfaces.email.host', 'synthetic.invalid', manager.getDaemonTierPath()],
    ] as const) {
      const handle = manager.prepareSettingMutation({ operation: 'set', key, value });
      const destinations = manager.inspectPreparedMutation(handle).destinations;
      expect(destinations[0]?.path).toBe(path!);
      write(path!, { unrelatedSynthetic: true });
      expect(finish(manager, handle).completedPaths).toEqual([path!]);
      expect(read(path!).unrelatedSynthetic).toBe(true);
    }
  });

  test('local reset physically removes global and daemon/shared leaves, preserving project overrides', () => {
    const { manager } = fixture({ tiers: true, project: true });
    write(manager.getConfigPath(), { tts: { voice: 'global' }, untouched: true });
    write(manager.getDaemonTierPath()!, { tts: { voice: 'daemon' }, untouched: true });
    write(manager.getSharedTierPath()!, { tts: { voice: 'shared' }, untouched: true });
    write(manager.getProjectConfigPath()!, { tts: { voice: 'project' } });
    const handle = manager.prepareSettingMutation({ operation: 'reset', key: 'tts.voice' });
    expect(manager.inspectPreparedMutation(handle).destinations.map(entry => entry.path)).toEqual([
      manager.getConfigPath(), manager.getSharedTierPath()!,
    ]);
    expect(finish(manager, handle).status).toBe('committed');
    for (const path of [manager.getConfigPath(), manager.getSharedTierPath()!]) expect(read(path)).toEqual({ untouched: true });
    expect(read(manager.getDaemonTierPath()!)).toEqual({ tts: { voice: 'daemon' }, untouched: true });
    expect(read(manager.getProjectConfigPath()!)).toEqual({ tts: { voice: 'project' } });
    expect(manager.get('tts.voice') as unknown).toBe(CONFIG_SCHEMA.find(entry => entry.key === 'tts.voice')!.default);
  });

  test('daemon reset removes the global and daemon leaves without touching unrelated shared data', () => {
    const { manager } = fixture({ tiers: true });
    write(manager.getConfigPath(), { surfaces: { email: { host: 'global.invalid' } } });
    write(manager.getDaemonTierPath()!, { surfaces: { email: { host: 'daemon.invalid' } } });
    write(manager.getSharedTierPath()!, { untouched: true });
    const handle = manager.prepareSettingMutation({ operation: 'reset', key: 'surfaces.email.host' });
    expect(finish(manager, handle).completedPaths).toEqual([manager.getConfigPath(), manager.getDaemonTierPath()!]);
    expect(read(manager.getConfigPath())).toEqual({});
    expect(read(manager.getDaemonTierPath()!)).toEqual({});
    expect(read(manager.getSharedTierPath()!)).toEqual({ untouched: true });
  });

  test('host set edits an existing project leaf; host reset writes defaults to project then global', () => {
    const { manager } = fixture({ project: true, host: true });
    write(manager.getConfigPath(), { permissions: { preparedFixture: true } });
    write(manager.getProjectConfigPath()!, { permissions: { preparedFixture: true } });
    const handle = manager.prepareSettingMutation({ operation: 'set', key: hostKey, value: false });
    expect(manager.inspectPreparedMutation(handle).destinations.map(entry => entry.path)).toEqual([manager.getProjectConfigPath()!]);
    expect(finish(manager, handle).status).toBe('committed');
    expect(manager.getHostBooleanSetting(hostKey).get()).toBe(false);
    expect(read(manager.getConfigPath())).toEqual({ permissions: { preparedFixture: true } });
    const reset = manager.prepareSettingMutation({ operation: 'reset', key: hostKey });
    expect(finish(manager, reset).completedPaths).toEqual([manager.getProjectConfigPath()!, manager.getConfigPath()]);
    for (const path of [manager.getConfigPath(), manager.getProjectConfigPath()!]) expect(read(path)).toEqual({ permissions: { preparedFixture: false } });
  });

  test('changing host project routing cannot redirect an already prepared write', () => {
    const { manager } = fixture({ project: true, host: true });
    const handle = manager.prepareSettingMutation({ operation: 'set', key: hostKey, value: true });
    write(manager.getProjectConfigPath()!, { permissions: { preparedFixture: false } });
    expect(() => manager.beginPreparedMutation(handle)).toThrow();
    expect(existsSync(manager.getConfigPath())).toBe(false);
  });

  test('a second file I/O failure returns exact completed paths and spends the transition', () => {
    const { manager } = fixture({ tiers: true });
    write(manager.getConfigPath(), { tts: { voice: 'global' } });
    write(manager.getDaemonTierPath()!, { tts: { voice: 'daemon' } });
    write(manager.getSharedTierPath()!, { tts: { voice: 'shared' } });
    const handle = manager.prepareSettingMutation({ operation: 'reset', key: 'tts.voice' });
    const transition = manager.beginPreparedMutation(handle);
    const original = atomic.writeJsonFileAtomic;
    const spy = spyOn(atomic, 'writeJsonFileAtomic').mockImplementation((path, data, options) => {
      if (path === manager.getSharedTierPath()) throw new Error('synthetic second publication failure');
      original(path, data, options);
    });
    restorers.push(() => spy.mockRestore());
    expect(manager.finishPreparedMutation(handle, transition)).toEqual({ status: 'partial', completedPaths: [manager.getConfigPath()], uncertainPath: manager.getSharedTierPath()! });
    expect(read(manager.getConfigPath())).toEqual({});
    expect(read(manager.getSharedTierPath()!)).toEqual({ tts: { voice: 'shared' } });
    expect(() => manager.finishPreparedMutation(handle, transition)).toThrow();
  });

  test('an initial publication failure reports unknown, never a fictional rollback', () => {
    const { manager } = fixture(); const handle = model(manager);
    const transition = manager.beginPreparedMutation(handle);
    const spy = spyOn(atomic, 'writeJsonFileAtomic').mockImplementation(() => { throw new Error('synthetic write failure'); });
    restorers.push(() => spy.mockRestore());
    expect(manager.finishPreparedMutation(handle, transition)).toEqual({ status: 'unknown', completedPaths: [], uncertainPath: manager.getConfigPath() });
    expect(() => manager.finishPreparedMutation(handle, transition)).toThrow();
  });

  test('unloaded writes by another manager preserve documented whole-file last-writer-wins behavior', () => {
    const { manager } = fixture();
    const second = new ConfigManager({ configDir: manager.getControlPlaneConfigDir() });
    const handle = model(manager);
    second.set('display.stream', false);
    second.set('provider.model', 'openai:other-owner');
    expect(finish(manager, handle).status).toBe('committed');
    expect(read(manager.getConfigPath()).provider).toEqual({ model: 'openai:fixture-prepared' });
    expect(read(manager.getConfigPath()).display).toEqual({ stream: false });
  });

  test('a corrupted store after begin refuses before any effect without recovery', () => {
    const { manager } = fixture(); const handle = model(manager);
    const transition = manager.beginPreparedMutation(handle);
    mkdirSync(dirname(manager.getConfigPath()), { recursive: true });
    writeFileSync(manager.getConfigPath(), '{synthetic corruption');
    expect(() => manager.finishPreparedMutation(handle, transition)).toThrow();
    expect(readFileSync(manager.getConfigPath(), 'utf8')).toBe('{synthetic corruption');
    expect(readdirSync(dirname(manager.getConfigPath()))).toEqual(['settings.json']);
    expect(() => manager.finishPreparedMutation(handle, transition)).toThrow();
  });

  test('validators cannot retain and mutate a prepared object value', () => {
    const { manager } = fixture();
    const schema = CONFIG_SCHEMA.find(entry => entry.type === 'object' && entry.key === 'pricing.modelPrices')!;
    if (!schema) throw new Error('Expected object schema fixture');
    const previous = schema.validate;
    let retained: unknown;
    schema.validate = value => { retained = value; return true; };
    restorers.push(() => { schema.validate = previous; });
    const input = { read: true };
    const handle = manager.prepareSettingMutation({ operation: 'set', key: schema.key, value: input });
    input.read = false;
    expect(Object.isFrozen(retained)).toBe(true);
    expect(manager.inspectPreparedMutation(handle).value).toEqual({ read: true });
    expect(finish(manager, handle).status).toBe('committed');
    expect(manager.get(schema.key) as unknown).toEqual({ read: true });
  });

  test('postcommit reentrant subscribers cannot relabel a committed effect as a refusal', () => {
    const { manager } = fixture(); let calls = 0;
    manager.subscribe('provider.model', () => { calls++; manager.save(); throw new Error('synthetic subscriber'); });
    const receipt = finish(manager, model(manager));
    expect(receipt.status).toBe('committed'); expect(calls).toBe(1);
    expect(read(manager.getConfigPath()).provider).toEqual({ model: 'openai:fixture-prepared' });
  });
});
