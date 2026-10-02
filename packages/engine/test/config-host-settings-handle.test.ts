import { afterEach, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager, type HostBooleanSetting } from '../sdk/src/platform/config/index.ts';
import { defaultStore, getSettingsControlPlaneSnapshot, readStore } from '../sdk/src/platform/runtime/settings.ts';
import * as atomicJson from '../sdk/src/platform/utils/atomic-json-store.ts';
import * as hostSettingsIo from '../sdk/src/platform/config/manager-host-settings.ts';

const FIRST = 'behavior.hostHandleFirst';
const SECOND = 'behavior.hostHandleSecond';
const definitions: readonly HostBooleanSetting[] = [FIRST, SECOND].map(key => ({ key, type: 'boolean', default: true, description: 'Synthetic restrictive host preference' }));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(hostSettings: readonly HostBooleanSetting[] = definitions) {
  const root = mkdtempSync(join(tmpdir(), 'config-host-handle-'));
  roots.push(root);
  const workingDir = join(root, 'project');
  mkdirSync(workingDir);
  const options = { configDir: join(root, 'config'), workingDir, surfaceRoot: 'agent', hostSettings };
  const config = new ConfigManager(options);
  return { config, options };
}
function observe(config: ConfigManager) {
  const changes: unknown[] = [];
  const events: unknown[] = [];
  const first = config.getHostBooleanSetting(FIRST);
  const second = config.getHostBooleanSetting(SECOND);
  const offFirst = first.subscribe((next, previous) => changes.push([FIRST, previous, next]));
  const offSecond = second.subscribe((next, previous) => changes.push([SECOND, previous, next]));
  const detach = config.attachHookDispatcher({ fire: async event => {
    events.push([event.specific, event.payload.previousValue, event.payload.value]);
    return { ok: true };
  } });
  return { first, second, changes, events, off: () => { offFirst(); offSecond(); detach(); } };
}
function pause(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!check() && Date.now() < deadline) await pause(5);
  expect(check()).toBe(true);
}

test('host handles validate exact registration without startup writes and keep detached methods bound', () => {
  const { config } = fixture();
  const handle = config.getHostBooleanSetting(FIRST);
  expect(Object.isFrozen(handle)).toBe(true);
  expect(handle.key).toBe(FIRST);
  expect(Reflect.set(handle, 'key', SECOND)).toBe(false);
  expect(Reflect.set(handle, 'get', () => false)).toBe(false);
  expect(existsSync(config.getConfigPath())).toBe(false);
  const { get, set, setProjectValue, subscribe, reset } = handle;
  const changes: unknown[] = [];
  const off = subscribe((next, previous) => changes.push([next, previous]));
  set(false);
  expect(get()).toBe(false);
  setProjectValue(true);
  expect(get()).toBe(true);
  set(false); // Existing project override is still the scalar destination.
  expect(JSON.parse(readFileSync(config.getProjectConfigPath()!, 'utf8')).behavior.hostHandleFirst).toBe(false);
  reset();
  expect(get()).toBe(true);
  const { config: other } = fixture();
  expect(other.getHostBooleanSetting(FIRST).get()).toBe(true);
  off(); set(false);
  expect(changes).toEqual([[false, true], [true, false], [false, true], [true, false]]);
  expect(other.getHostBooleanSetting(FIRST).get()).toBe(true);
});

test('unregistered, builtin, nested, and unsafe handle lookup rejects without side effects', () => {
  const { config } = fixture();
  const before = config.getRaw();
  for (const key of ['behavior.typo', 'behavior.autoApprove', 'behavior.__proto__', '__proto__.host', 'behavior.hostHandleFirst.child', 'behavior.hostHandleFirst ']) {
    expect(() => config.getHostBooleanSetting(key)).toThrow('not registered');
  }
  const { config: bare } = fixture([]);
  expect(() => bare.getHostBooleanSetting(FIRST)).toThrow('not registered');
  expect(config.getRaw()).toEqual(before);
  expect(existsSync(config.getConfigPath())).toBe(false);
  expect(existsSync(config.getProjectConfigPath()!)).toBe(false);
});

test('setting the default respects the effective tier while explicit reset revokes both stored tiers', () => {
  const { config } = fixture();
  const handle = config.getHostBooleanSetting(FIRST);
  handle.set(false); handle.setProjectValue(false);
  handle.set(true);
  expect(handle.get()).toBe(true);
  expect(JSON.parse(readFileSync(config.getConfigPath(), 'utf8')).behavior.hostHandleFirst).toBe(false);
  expect(JSON.parse(readFileSync(config.getProjectConfigPath()!, 'utf8')).behavior.hostHandleFirst).toBe(true);
  handle.reset();
  expect(JSON.parse(readFileSync(config.getConfigPath(), 'utf8')).behavior.hostHandleFirst).toBe(true);
  expect(JSON.parse(readFileSync(config.getProjectConfigPath()!, 'utf8')).behavior.hostHandleFirst).toBe(true);
});

test('handles reject nonboolean JavaScript calls and retain managed/read-only guards and options', () => {
  const { config, options } = fixture();
  const handle = config.getHostBooleanSetting(FIRST);
  for (const value of ['false', 0, null, {}]) {
    expect(() => Reflect.apply(handle.set, null, [value])).toThrow('literal boolean');
    expect(() => Reflect.apply(handle.setProjectValue, null, [value])).toThrow('literal boolean');
  }
  expect(existsSync(config.getConfigPath())).toBe(false);
  // Seed the persisted v2 policy fixture; dynamic-host policy authoring is not
  // added to the builtin ConfigKey governance API by host registration.
  mkdirSync(options.configDir, { recursive: true });
  writeFileSync(join(options.configDir, 'settings-sync.json'), JSON.stringify({
    ...defaultStore(),
    managedLocks: [{ key: FIRST, source: 'host-test', reason: 'Fixture managed setting', updatedAt: 1 }],
  }));
  const snapshot = getSettingsControlPlaneSnapshot(config);
  expect(snapshot.managedLocks).toEqual([]);
  expect(snapshot.managedLockCount).toBe(0);
  expect(handle.getResolved().managedLock?.reason).toBe('Fixture managed setting');
  expect(() => handle.set(false)).toThrow('locked');
  expect(() => handle.setProjectValue(false)).toThrow('locked');
  expect(() => handle.reset()).toThrow('locked');
  handle.set(false, { bypassManagedLock: true });
  expect(handle.get()).toBe(false);
  handle.setProjectValue(true, { bypassManagedLock: true });
  expect(handle.get()).toBe(true);
  const readonly = new ConfigManager({ ...options, readOnly: true }).getHostBooleanSetting(FIRST);
  expect(() => readonly.set(false, { bypassManagedLock: true })).toThrow('read-only');
  expect(() => readonly.setProjectValue(false, { bypassManagedLock: true })).toThrow('read-only');
  expect(() => readonly.reset()).toThrow('read-only');
  expect(readonly.get()).toBe(true);
});

test('host watcher sees chmod-only read failure and restoration once, with stable failure avoiding churn', async () => {
  const { config } = fixture();
  const { first, changes, events } = observe(config);
  first.set(false); changes.length = 0; events.length = 0;
  const path = config.getConfigPath();
  const before = statSync(path);
  const loads = spyOn(config, 'load');
  const stop = config.watchConfigFiles({ intervalMs: 5 });
  chmodSync(path, 0);
  try {
    expect([statSync(path).mtimeMs, statSync(path).size]).toEqual([before.mtimeMs, before.size]);
    await waitFor(() => first.get() === true);
    expect(loads).toHaveBeenCalledTimes(1);
    await pause(40);
    expect(loads).toHaveBeenCalledTimes(1);
    expect(config.getIngestionQuarantine().some(notice => notice.action === 'refused')).toBe(true);
    chmodSync(path, 0o600);
    expect([statSync(path).mtimeMs, statSync(path).size]).toEqual([before.mtimeMs, before.size]);
    await waitFor(() => first.get() === false);
    expect(loads).toHaveBeenCalledTimes(2);
    await pause(40);
    expect(loads).toHaveBeenCalledTimes(2);
    expect(changes).toEqual([[FIRST, false, true], [FIRST, true, false]]);
    expect(events).toEqual(changes);
  } finally { chmodSync(path, 0o600); stop(); loads.mockRestore(); }
});

test('no-host watcher keeps stat-only behavior across chmod-only changes', async () => {
  const { config } = fixture([]);
  config.set('behavior.autoApprove', true);
  const path = config.getConfigPath();
  const loads = spyOn(config, 'load');
  const stop = config.watchConfigFiles({ intervalMs: 5 });
  chmodSync(path, 0);
  try {
    await pause(40);
    chmodSync(path, 0o600);
    await pause(40);
    expect(loads).not.toHaveBeenCalled();
    expect(config.get('behavior.autoApprove')).toBe(true);
  } finally { chmodSync(path, 0o600); stop(); loads.mockRestore(); }
});

test.each(['global', 'project', 'reset-global', 'reset-project'])('failed %s persistence revokes all host leaves once before rethrowing', (scope) => {
  const { config } = fixture();
  const { first, second, changes, events } = observe(config);
  first.set(false); second.set(false);
  const project = scope.endsWith('project');
  if (project) first.setProjectValue(false);
  changes.length = 0; events.length = 0;
  const directory = dirname(project ? config.getProjectConfigPath()! : config.getConfigPath());
  const attempt = () => scope.startsWith('reset') ? first.reset() : project ? first.setProjectValue(true) : first.set(true);
  chmodSync(directory, 0);
  try {
    expect(attempt).toThrow();
    expect([first.get(), second.get()]).toEqual([true, true]);
    expect(changes).toEqual([[FIRST, false, true], [SECOND, false, true]]);
    expect(events).toEqual(changes);
    expect(attempt).toThrow();
    expect(events).toHaveLength(2);
  } finally { chmodSync(directory, 0o700); }
});

test.each(['global', 'project', 'reset'])('failed %s write preserves original error identity while publishing external host changes', (scope) => {
  const { config } = fixture();
  const { first, second, changes, events } = observe(config);
  first.set(false); second.set(false);
  if (scope === 'project') first.setProjectValue(false);
  changes.length = 0; events.length = 0;
  writeFileSync(config.getConfigPath(), JSON.stringify({ behavior: { hostHandleFirst: false, hostHandleSecond: true } }));
  const original = new Error('Synthetic persistence failure');
  const writer = spyOn(atomicJson, 'writeJsonFileAtomic').mockImplementation(() => { throw original; });
  let caught: unknown;
  try {
    try {
      if (scope === 'project') first.setProjectValue(true);
      else if (scope === 'reset') first.reset();
      else first.set(true);
    } catch (error) { caught = error; }
    expect(caught).toBe(original);
    expect(first.get()).toBe(false);
    expect(second.get()).toBe(true);
    expect(changes).toEqual([[SECOND, false, true]]);
    expect(events).toEqual(changes);
  } finally { writer.mockRestore(); }
});

test('successful scalar refresh hooks every changed host once and repeated same-value writes do not duplicate hooks', () => {
  const { config } = fixture();
  const { first, second, changes, events } = observe(config);
  first.set(false); second.set(false); changes.length = 0; events.length = 0;
  writeFileSync(config.getConfigPath(), JSON.stringify({ behavior: { hostHandleFirst: false, hostHandleSecond: true } }));
  first.set(true);
  expect(changes).toEqual([[FIRST, false, true], [SECOND, false, true]]);
  expect(events).toEqual(changes);
  first.set(true); first.setProjectValue(true); config.load();
  expect(events).toHaveLength(2);
});

test('failed privacy refresh does not replace the original write error and revokes every host leaf', () => {
  const { config } = fixture();
  const { first, second, changes, events } = observe(config);
  first.set(false); second.set(false); first.setProjectValue(false);
  changes.length = 0; events.length = 0;
  const directory = dirname(config.getProjectConfigPath()!);
  const original = new Error('Synthetic original write failure');
  const writer = spyOn(atomicJson, 'writeJsonFileAtomic').mockImplementation(() => { throw original; });
  chmodSync(directory, 0);
  let caught: unknown;
  try {
    try { first.setProjectValue(true); } catch (error) { caught = error; }
    expect(caught).toBe(original);
    expect([first.get(), second.get()]).toEqual([true, true]);
    expect(changes).toEqual([[FIRST, false, true], [SECOND, false, true]]);
    expect(events).toEqual(changes);
  } finally { chmodSync(directory, 0o700); writer.mockRestore(); }
});

test.each(['unreadable', 'malformed', 'invalid-parent'])('host set refuses %s project ownership before changing either destination', (failure) => {
  const { config } = fixture();
  const { first, changes, events } = observe(config);
  first.set(true); first.setProjectValue(false); changes.length = 0; events.length = 0;
  const project = config.getProjectConfigPath()!;
  const directory = dirname(project);
  const globalBefore = readFileSync(config.getConfigPath(), 'utf8');
  if (failure === 'unreadable') chmodSync(directory, 0);
  else if (failure === 'malformed') writeFileSync(project, '{malformed');
  else { rmSync(directory, { recursive: true }); writeFileSync(directory, 'synthetic invalid parent'); }
  try {
    expect(() => first.set(false)).toThrow();
    expect(first.get()).toBe(true);
    expect(readFileSync(config.getConfigPath(), 'utf8')).toBe(globalBefore);
    expect(changes).toEqual([[FIRST, false, true]]);
    expect(events).toEqual(changes);
    if (failure === 'malformed') expect(readFileSync(project, 'utf8')).toBe('{malformed');
    if (failure === 'invalid-parent') expect(readFileSync(directory, 'utf8')).toBe('synthetic invalid parent');
  } finally { if (failure === 'unreadable') chmodSync(directory, 0o700); }
  if (failure === 'unreadable') expect(JSON.parse(readFileSync(project, 'utf8')).behavior.hostHandleFirst).toBe(false);
});

test('project ownership read failures keep their original identity and never invoke persistence', () => {
  const { config } = fixture();
  const { first, changes, events } = observe(config);
  first.set(true); first.setProjectValue(false); changes.length = 0; events.length = 0;
  const globalBefore = readFileSync(config.getConfigPath(), 'utf8');
  const projectBefore = readFileSync(config.getProjectConfigPath()!, 'utf8');
  const original = new Error('Synthetic project ownership read failure');
  const reader = spyOn(hostSettingsIo, 'readHostSettingsFile').mockImplementation(() => { throw original; });
  const writer = spyOn(atomicJson, 'writeJsonFileAtomic');
  let caught: unknown;
  try {
    try { first.set(false); } catch (error) { caught = error; }
    expect(caught).toBe(original);
    expect(writer).not.toHaveBeenCalled();
    expect(first.get()).toBe(true);
    expect(readFileSync(config.getConfigPath(), 'utf8')).toBe(globalBefore);
    expect(readFileSync(config.getProjectConfigPath()!, 'utf8')).toBe(projectBefore);
    expect(changes).toEqual([[FIRST, false, true]]);
    expect(events).toEqual(changes);
  } finally { reader.mockRestore(); writer.mockRestore(); }
});

test('retained handles expose fresh frozen host metadata across reloads and policy changes', () => {
  const { config, options } = fixture();
  const handle = config.getHostBooleanSetting(FIRST);
  const { getResolved } = handle;
  const initial = getResolved();
  expect(initial).toEqual({ key: FIRST, value: true, defaultValue: true, source: 'default', managedLock: null });
  expect(Object.isFrozen(initial)).toBe(true);
  expect(existsSync(options.configDir)).toBe(false);
  handle.set(false);
  const policyPath = join(options.configDir, 'settings-sync.json');
  writeFileSync(policyPath, JSON.stringify({ ...defaultStore(), managedLocks: [{ key: FIRST, source: 'fixture-policy', reason: 'Keep restricted', updatedAt: 12 }] }));
  const before = readFileSync(policyPath, 'utf8');
  const resolved = getResolved();
  expect(resolved).toEqual({ key: FIRST, value: false, defaultValue: true, source: 'local', managedLock: { source: 'fixture-policy', reason: 'Keep restricted', updatedAt: 12 } });
  expect(Object.isFrozen(resolved.managedLock)).toBe(true);
  expect(Reflect.set(resolved, 'value', true)).toBe(false);
  expect(Reflect.set(resolved.managedLock!, 'reason', 'changed')).toBe(false);
  expect(readFileSync(policyPath, 'utf8')).toBe(before);
  writeFileSync(config.getConfigPath(), JSON.stringify({ behavior: { hostHandleFirst: true } }));
  config.load();
  expect(getResolved().value).toBe(true);
  expect(getResolved().source).toBe('default');
  expect(resolved.value).toBe(false);
  rmSync(policyPath);
  expect(getResolved().managedLock).toBeNull();
});

test.each([
  '{malformed', 'null', '[]',
  '{"version":2,"managedLocks":null}',
  '{"version":2,"managedLocks":[null]}',
  '{"version":2,"managedLocks":[{"key":"behavior.hostHandleFirst","source":1,"reason":"x","updatedAt":1}]}',
  '{"version":2,"managedLocks":[{"key":"behavior.hostHandleFirst","source":"x","reason":{},"updatedAt":1}]}',
  '{"version":2,"managedLocks":[{"key":"behavior.hostHandleFirst","source":"x","reason":"x","updatedAt":1e999}]}',
])('malformed policy metadata throws without quarantining or changing %s', (raw) => {
  const { config, options } = fixture();
  const handle = config.getHostBooleanSetting(FIRST); handle.set(false);
  const policyPath = join(options.configDir, 'settings-sync.json');
  writeFileSync(policyPath, raw);
  const names = readdirSync(options.configDir);
  expect(() => handle.getResolved()).toThrow('Host setting metadata is unavailable because managed policy could not be read.');
  expect(readFileSync(policyPath, 'utf8')).toBe(raw);
  expect(readdirSync(options.configDir)).toEqual(names);
  expect(handle.get()).toBe(false);
});

test('unreadable policy metadata throws a bounded error and recovers after readability returns', () => {
  const { config, options } = fixture();
  const handle = config.getHostBooleanSetting(FIRST); handle.set(false);
  const policyPath = join(options.configDir, 'settings-sync.json');
  const raw = JSON.stringify(defaultStore()); writeFileSync(policyPath, raw);
  chmodSync(policyPath, 0);
  try {
    expect(() => handle.getResolved()).toThrow('Host setting metadata is unavailable because managed policy could not be read.');
    expect(handle.get()).toBe(false);
  } finally { chmodSync(policyPath, 0o600); }
  expect(readFileSync(policyPath, 'utf8')).toBe(raw);
  expect(handle.getResolved().managedLock).toBeNull();
});

test('ordinary policy reads retain their existing quarantine recovery behavior', () => {
  const { options } = fixture();
  mkdirSync(options.configDir, { recursive: true });
  const policyPath = join(options.configDir, 'settings-sync.json');
  writeFileSync(policyPath, '{malformed');
  expect(readStore(options.configDir)).toEqual(defaultStore());
  expect(existsSync(policyPath)).toBe(false);
  expect(readdirSync(options.configDir).some(name => name.startsWith('settings-sync.json.'))).toBe(true);
});
