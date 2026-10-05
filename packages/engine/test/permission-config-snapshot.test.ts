import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../sdk/src/platform/config/index.js';
import { createPermissionConfigReader, PermissionManager } from '../sdk/src/platform/permissions/manager.js';
import { UserPermissionRuleStore } from '../sdk/src/platform/permissions/user-rule-store.js';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.js';
import { useGateReadings } from './_helpers/gate-readings.js';

useGateReadings();
const roots: string[] = [];
const restore: (() => void)[] = [];
afterEach(() => {
  for (const reset of restore.splice(0)) reset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function config(): ConfigManager {
  const root = mkdtempSync(join(tmpdir(), 'permission-config-snapshot-')); roots.push(root);
  return new ConfigManager({ surfaceRoot: 'agent', configDir: join(root, 'config'), workingDir: root, homeDir: root });
}

test('real permission readers take a fresh narrow snapshot without cloning unrelated config', async () => {
  const owner = config();
  owner.set('permissions.mode', 'custom');
  owner.set('permissions.tools.read', 'allow');
  const raw = spyOn(owner, 'getRaw').mockImplementation(() => { throw new Error('unrelated config must not be cloned'); });
  const narrow = spyOn(owner, 'getAutonomousPermissionSnapshot');
  restore.push(() => { raw.mockRestore(); narrow.mockRestore(); });
  const reader = createPermissionConfigReader(owner);
  const before = reader.getSnapshot();
  expect(Object.keys(before)).toEqual(['permissions']);
  expect(before.permissions.mode).toBe('custom');
  expect(before.permissions.tools.read).toBe('allow');
  await Promise.resolve();
  owner.set('permissions.tools.read', 'deny');
  const after = reader.getSnapshot();
  expect(after.permissions.tools.read).toBe('deny');
  expect(before.permissions.tools.read).toBe('allow');
  expect(after.permissions).not.toBe(before.permissions);
  expect(after.permissions.tools).not.toBe(before.permissions.tools);
  expect(narrow).toHaveBeenCalledTimes(2);
  expect(raw).not.toHaveBeenCalled();
  const frame = reader.getAutonomousSnapshot!();
  expect(frame.permissions).toEqual(after.permissions);
  expect(frame.directory).toBe(owner.getWorkingDirectory());
  expect(narrow).toHaveBeenCalledTimes(3);
});

test('returned nested permission data cannot mutate the owner or another reader', () => {
  const owner = config();
  owner.set('permissions.tools.read', 'allow');
  const one = createPermissionConfigReader(owner);
  const two = createPermissionConfigReader(owner);
  const exposed = one.getSnapshot();
  exposed.permissions.tools.read = 'deny';
  expect(owner.get('permissions.tools.read')).toBe('allow');
  expect(one.getSnapshot().permissions.tools.read).toBe('allow');
  expect(two.getSnapshot().permissions.tools.read).toBe('allow');
});

test('concurrent same-directory owners retain their own current permission state', async () => {
  const owner = config();
  const other = new ConfigManager({ surfaceRoot: 'agent', configDir: join(owner.getWorkingDirectory()!, 'other-config'),
    workingDir: owner.getWorkingDirectory()!, homeDir: owner.getHomeDirectory()! });
  owner.set('permissions.tools.read', 'allow');
  other.set('permissions.tools.read', 'deny');
  const one = createPermissionConfigReader(owner);
  const two = createPermissionConfigReader(other);
  const snapshots = await Promise.all([Promise.resolve().then(() => one.getSnapshot()), Promise.resolve().then(() => two.getSnapshot())]);
  expect(snapshots.map(snapshot => snapshot.permissions.tools.read)).toEqual(['allow', 'deny']);
  owner.set('permissions.tools.read', 'prompt');
  expect(one.getSnapshot().permissions.tools.read).toBe('prompt');
  expect(two.getSnapshot().permissions.tools.read).toBe('deny');
});

test('construction pins the owned accessor without pinning its values', () => {
  const owner = config();
  const reader = createPermissionConfigReader(owner);
  owner.getAutonomousPermissionSnapshot = () => { throw new Error('late accessor replacement'); };
  owner.set('permissions.mode', 'plan');
  expect(reader.getSnapshot().permissions.mode).toBe('plan');
  expect(reader.getAutonomousSnapshot!().permissions.mode).toBe('plan');
  const replacement = createPermissionConfigReader(owner);
  expect(() => replacement.getSnapshot()).toThrow('late accessor replacement');
});

test('legacy configuration readers still copy current snapshots on every call', async () => {
  const owner = config();
  const raw = spyOn(owner, 'getRaw'); restore.push(() => raw.mockRestore());
  const legacy = { get: owner.get.bind(owner), getRaw: owner.getRaw.bind(owner), getWorkingDirectory: owner.getWorkingDirectory.bind(owner) };
  const reader = createPermissionConfigReader(legacy);
  expect(reader.getAutonomousSnapshot).toBeUndefined();
  const before = reader.getSnapshot();
  await Promise.resolve();
  owner.set('permissions.mode', 'plan');
  expect(reader.getSnapshot().permissions.mode).toBe('plan');
  expect(before.permissions.mode).not.toBe('plan');
  expect(raw).toHaveBeenCalledTimes(2);
});

test('a failed narrow snapshot never retries through a broader configuration read', () => {
  const owner = config();
  owner.getAutonomousPermissionSnapshot = () => { throw new Error('owned frame unavailable'); };
  const raw = spyOn(owner, 'getRaw'); restore.push(() => raw.mockRestore());
  const reader = createPermissionConfigReader(owner);
  expect(() => reader.getSnapshot()).toThrow('owned frame unavailable');
  expect(() => reader.getAutonomousSnapshot!()).toThrow('owned frame unavailable');
  expect(raw).not.toHaveBeenCalled();
});

test('current stored read denials and live permission changes survive repeated narrow snapshots', async () => {
  const owner = config();
  owner.set('permissions.mode', 'custom');
  owner.set('permissions.tools.read', 'allow');
  const store = new UserPermissionRuleStore(':memory:');
  const permission = new PermissionManager(async () => { throw new Error('read access must not prompt'); },
    createPermissionConfigReader(owner), new PolicyRuntimeState(), null, { isEnabled: () => true }, store);
  const path = join(owner.getWorkingDirectory()!, 'input.txt');
  expect(await permission.readAccess(path)).toBe('allow');
  await store.add({ rule: { id: 'deny-live-input', type: 'path-scope', origin: 'user', effect: 'deny', toolPattern: 'read', pathPatterns: [path] },
    createdAt: Date.now(), tier: 'path', tool: 'read' });
  expect(await permission.readAccess(path)).toBe('restricted');
  expect(await permission.readAccess(join(owner.getWorkingDirectory()!, 'other.txt'))).toBe('allow');
  owner.set('permissions.tools.read', 'deny');
  expect(await permission.readAccess(join(owner.getWorkingDirectory()!, 'other.txt'))).toBe('restricted');
  owner.set('permissions.tools.read', 'allow');
  expect(await permission.readAccess(path)).toBe('restricted');
});
