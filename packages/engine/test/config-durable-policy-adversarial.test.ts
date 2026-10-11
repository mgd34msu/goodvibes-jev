import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { cpSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DurablePolicyEpochOwner } from '../sdk/src/platform/config/durable-policy-epoch.js';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import * as atomic from '../sdk/src/platform/utils/atomic-json-store.js';
import { migrateDaemonOwnedConfig } from '../sdk/src/platform/config/daemon-config-migration.js';
import { daemonConfigMovedPath } from '../sdk/src/platform/config/daemon-config-migration-io.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function directory() { const dir = mkdtempSync(join(tmpdir(), 'gv-policy-review-')); dirs.push(dir); return dir; }
function fixture(present = true) {
  const dir = directory(); const file = join(dir, 'settings.json');
  if (present) writeFileSync(file, JSON.stringify({ behavior: { autoApprove: false } }));
  const owner = new DurablePolicyEpochOwner([file], true);
  owner.capture({});
  return { dir, file, sidecar: `${file}.policy-epoch.json`, owner };
}
function managerFixture() {
  const dir = directory();
  const options = { configDir: dir, surfaceRoot: 'daemon' };
  const manager = new ConfigManager(options);
  manager.captureDurableConfigurationIncarnation();
  return { dir, options, manager, restart: () => new ConfigManager(options) };
}

describe('actual durable configuration owner', () => {
  test('unchanged hydration and restart do not arbitrarily advance the owner', () => {
    const item = managerFixture(); const before = item.manager.getDurableConfigurationIncarnation();
    expect(item.restart().getDurableConfigurationIncarnation()).toBe(before);
    expect(item.manager.getDurableConfigurationIncarnation()).toBe(before);
  });

  test('a runtime A-to-B-to-A mutation survives restart as revoked history', () => {
    const item = managerFixture(); const before = item.manager.getDurableConfigurationIncarnation();
    item.manager.setRuntimeOverride('behavior.autoApprove', true);
    item.manager.setRuntimeOverride('behavior.autoApprove', false);
    expect(item.manager.get('behavior.autoApprove')).toBe(false);
    expect(item.manager.getDurableConfigurationIncarnation()).not.toBe(before);
    expect(item.restart().getDurableConfigurationIncarnation()).not.toBe(before);
  });

  test('constructor CLI policy A-to-B-to-A across separate processes cannot revive issued history', () => {
    const item = managerFixture(); const before = item.manager.getDurableConfigurationIncarnation();
    const changed = new ConfigManager({ ...item.options, autoApprove: true });
    expect(changed.get('behavior.autoApprove')).toBe(true);
    expect(changed.getDurableConfigurationIncarnation()).not.toBe(before);
    const restored = item.restart();
    expect(restored.get('behavior.autoApprove')).toBe(false);
    expect(restored.getDurableConfigurationIncarnation()).not.toBe(before);
  });

  test('constructor migration intent is durable before the first settings rewrite', () => {
    const dir = directory(); const file = join(dir, 'settings.json');
    writeFileSync(file, JSON.stringify({ orchestration: { maxActiveAgents: 7 } }));
    const owner = new DurablePolicyEpochOwner([file, join(dir, 'settings-sync.json')], true);
    owner.capture({}); const sidecar = `${file}.policy-epoch.json`;
    const before = JSON.parse(readFileSync(sidecar, 'utf8')).incarnation;
    const original = atomic.writeJsonFileAtomic; let observed = false;
    const write = spyOn(atomic, 'writeJsonFileAtomic').mockImplementation((path, value, options) => {
      if (path === file) {
        observed = true; expect(JSON.parse(readFileSync(sidecar, 'utf8')).incarnation).not.toBe(before);
      }
      return original(path, value, options);
    });
    try {
      const manager = new ConfigManager({ configDir: dir, surfaceRoot: 'daemon' });
      expect(manager.get('fleet.maxSize')).toBe(7);
      expect(() => manager.getDurableConfigurationIncarnation()).not.toThrow();
      expect(observed).toBe(true);
    } finally { write.mockRestore(); }
  });

  test('constructor migration with unavailable durable intent preserves read recovery without disk effects', () => {
    const dir = directory(); const file = join(dir, 'settings.json');
    const raw = JSON.stringify({ orchestration: { maxActiveAgents: 7 } }); writeFileSync(file, raw);
    const owner = new DurablePolicyEpochOwner([file, join(dir, 'settings-sync.json')], true); owner.capture({});
    mkdirSync(`${file}.policy-epoch.json.owner-lock`);
    const manager = new ConfigManager({ configDir: dir, surfaceRoot: 'daemon' });
    expect(manager.get('fleet.maxSize')).toBe(7);
    expect(readFileSync(file, 'utf8')).toBe(raw);
    expect(() => manager.getDurableConfigurationIncarnation()).toThrow();
    expect(() => readFileSync(join(dir, 'feature-announcements.json'))).toThrow();
  });

  test('constructor CLI overrides cannot escape unavailable intent or reappear after history becomes readable', () => {
    const item = managerFixture(); const lock = `${item.manager.getConfigPath()}.policy-epoch.json.owner-lock`;
    mkdirSync(lock); let escaped: ConfigManager | undefined;
    expect(() => { escaped = new ConfigManager({ ...item.options, autoApprove: true }); }).toThrow('mutation intent');
    expect(escaped).toBeUndefined();
    expect(item.manager.get('behavior.autoApprove')).toBe(false);
    expect(() => item.manager.getDurableConfigurationIncarnation()).toThrow();
    rmSync(lock, { recursive: true });
    const restarted = item.restart();
    expect(restarted.get('behavior.autoApprove')).toBe(false);
    expect(() => restarted.getDurableConfigurationIncarnation()).not.toThrow();
    // No attempted permissive config instance ever escaped to execute work.
  });

  test('pre-constructor daemon migration owns intent on changed roots and leaves unchanged starts stable', () => {
    const home = directory(); const source = join(home, '.goodvibes', 'tui', 'settings.json');
    const destination = join(home, '.goodvibes', 'daemon', 'settings.json');
    mkdirSync(dirname(source), { recursive: true }); mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(source, JSON.stringify({ watchers: { enabled: true } }));
    const owner = new DurablePolicyEpochOwner([source, destination], true); const original = owner.capture({});
    const before = [source, destination].map(path => JSON.parse(readFileSync(`${path}.policy-epoch.json`, 'utf8')).incarnation);
    const result = migrateDaemonOwnedConfig({ homeDir: home }); expect(result.migrated).toBe(true);
    const after = [source, destination].map(path => JSON.parse(readFileSync(`${path}.policy-epoch.json`, 'utf8')).incarnation);
    expect(after[0]).not.toBe(before[0]); expect(after[1]).not.toBe(before[1]);
    expect(new DurablePolicyEpochOwner([source, destination], true).current({})).not.toBe(original);
    expect(migrateDaemonOwnedConfig({ homeDir: home }).migrated).toBe(false);
    expect([source, destination].map(path => JSON.parse(readFileSync(`${path}.policy-epoch.json`, 'utf8')).incarnation)).toEqual(after);
  });

  test('pre-constructor daemon migration refuses before marker or settings effects if a changed root intent is unavailable', () => {
    const home = directory(); const source = join(home, '.goodvibes', 'tui', 'settings.json');
    const destination = join(home, '.goodvibes', 'daemon', 'settings.json');
    mkdirSync(dirname(source), { recursive: true }); mkdirSync(dirname(destination), { recursive: true });
    const raw = JSON.stringify({ watchers: { enabled: true } }); writeFileSync(source, raw);
    const owner = new DurablePolicyEpochOwner([source, destination], true); owner.capture({});
    mkdirSync(`${source}.policy-epoch.json.owner-lock`);
    expect(() => migrateDaemonOwnedConfig({ homeDir: home })).toThrow('mutation intent');
    expect(readFileSync(source, 'utf8')).toBe(raw);
    expect(() => readFileSync(destination)).toThrow();
    expect(() => readFileSync(daemonConfigMovedPath(destination))).toThrow();
  });

  test('a persisted A-to-B-to-A mutation survives restart as revoked history', () => {
    const item = managerFixture(); const before = item.manager.getDurableConfigurationIncarnation();
    item.manager.set('behavior.autoApprove', true); item.manager.set('behavior.autoApprove', false);
    expect(item.manager.getDurableConfigurationIncarnation()).not.toBe(before);
    expect(item.restart().getDurableConfigurationIncarnation()).not.toBe(before);
  });

  test('failed/no-op mutation intent advances before effects and survives restart', () => {
    const item = managerFixture(); const before = item.manager.getDurableConfigurationIncarnation();
    item.manager.setRuntimeOverride('behavior.autoApprove', false);
    const noop = item.manager.getDurableConfigurationIncarnation(); expect(noop).not.toBe(before);
    expect(() => item.manager.setRuntimeOverride('behavior.autoApprove', 'invalid' as never)).toThrow();
    expect(item.manager.getDurableConfigurationIncarnation()).not.toBe(noop);
    expect(item.restart().getDurableConfigurationIncarnation()).not.toBe(noop);
  });

  test('external A-to-B-to-A while down changes durable revision even with equal effective data', () => {
    const item = managerFixture(); item.manager.set('behavior.autoApprove', false);
    const before = item.manager.getDurableConfigurationIncarnation(); const file = item.manager.getConfigPath();
    const original = readFileSync(file, 'utf8');
    writeFileSync(file, JSON.stringify({ behavior: { autoApprove: true } })); writeFileSync(file, original);
    const restarted = item.restart();
    expect(() => restarted.getDurableConfigurationIncarnation()).toThrow();
    restarted.load(); expect(restarted.getDurableConfigurationIncarnation()).not.toBe(before);
  });

  test('external edits are not silently adopted by the current owner read', () => {
    const item = managerFixture(); const before = item.manager.getDurableConfigurationIncarnation();
    writeFileSync(item.manager.getConfigPath(), JSON.stringify({ behavior: { autoApprove: true } }));
    expect(() => item.manager.getDurableConfigurationIncarnation()).toThrow();
    item.manager.load(); expect(item.manager.get('behavior.autoApprove')).toBe(true);
    expect(item.manager.getDurableConfigurationIncarnation()).not.toBe(before);
  });

  test('read-only configuration cannot create persistent continuation history', () => {
    const dir = directory(); const manager = new ConfigManager({ configDir: dir, surfaceRoot: 'daemon', readOnly: true });
    expect(() => manager.getDurableConfigurationIncarnation()).toThrow();
    manager.setRuntimeOverride('behavior.autoApprove', false);
    expect(manager.get('behavior.autoApprove')).toBe(false);
  });

  test('another owner cannot bind a new durable revision to this manager stale effective config', () => {
    const item = managerFixture(); item.manager.getDurableConfigurationIncarnation();
    const other = item.restart(); other.set('behavior.autoApprove', true);
    expect(item.manager.get('behavior.autoApprove')).toBe(false);
    expect(() => item.manager.getDurableConfigurationIncarnation()).toThrow();
    item.manager.load();
    expect(item.manager.get('behavior.autoApprove')).toBe(true);
    expect(() => item.manager.getDurableConfigurationIncarnation()).not.toThrow();
  });

  test('an owner constructed before activation discovers durable history before its later mutation', () => {
    const dir = directory(); const options = { configDir: dir, surfaceRoot: 'daemon' };
    const early = new ConfigManager(options); const issuer = new ConfigManager(options);
    const before = issuer.captureDurableConfigurationIncarnation();
    early.setRuntimeOverride('behavior.autoApprove', true); early.setRuntimeOverride('behavior.autoApprove', false);
    expect(new ConfigManager(options).getDurableConfigurationIncarnation()).not.toBe(before);
  });

  test('a preactivation owner cannot silently adopt another owner newly issued history', () => {
    const dir = directory(); const options = { configDir: dir, surfaceRoot: 'daemon' };
    const early = new ConfigManager(options); const issuer = new ConfigManager(options);
    issuer.captureDurableConfigurationIncarnation(); issuer.set('behavior.autoApprove', true);
    expect(() => early.captureDurableConfigurationIncarnation()).toThrow();
    early.load(); expect(early.get('behavior.autoApprove')).toBe(true);
    expect(() => early.captureDurableConfigurationIncarnation()).not.toThrow();
  });

  test('global, project, shared, and daemon owner mutations each revoke the captured revision', () => {
    const base = directory(); const home = join(base, 'home'); const project = join(base, 'project');
    mkdirSync(home); mkdirSync(project);
    const options = { homeDir: home, workingDir: project, surfaceRoot: 'daemon', ownsDaemonTier: true };
    const manager = new ConfigManager(options);
    manager.captureDurableConfigurationIncarnation();
    for (const file of [manager.getConfigPath(), manager.getProjectConfigPath()!, manager.getSharedTierPath()!, manager.getDaemonTierPath()!]) {
      const before = manager.getDurableConfigurationIncarnation();
      mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, '{}');
      expect(() => manager.getDurableConfigurationIncarnation()).toThrow(); manager.load();
      expect(manager.getDurableConfigurationIncarnation()).not.toBe(before);
    }
  });
});

describe('epoch custody and crash boundaries', () => {
  test('missing or corrupt state is never manufactured by current()', () => {
    const item = fixture();
    for (const raw of ['{broken', JSON.stringify({ version: 1 }), 'null']) {
      writeFileSync(item.sidecar, raw); expect(() => item.owner.current({})).toThrow();
      expect(readFileSync(item.sidecar, 'utf8')).toBe(raw);
    }
    rmSync(item.sidecar); expect(() => item.owner.current({})).toThrow();
  });

  test('array-coerced and malformed epoch identities remain corrupt after restart', () => {
    for (const field of ['incarnation', 'fileIdentity'] as const) {
      const item = fixture(); const value = JSON.parse(readFileSync(item.sidecar, 'utf8'));
      value[field] = [value[field]]; const raw = JSON.stringify(value); writeFileSync(item.sidecar, raw);
      expect(() => new DurablePolicyEpochOwner([item.file], true).current({})).toThrow();
      expect(readFileSync(item.sidecar, 'utf8')).toBe(raw);
    }
  });

  test('a newly initialized missing epoch can never match the previous issued epoch', () => {
    const item = fixture(); const before = item.owner.current({}); rmSync(item.sidecar);
    const restarted = new DurablePolicyEpochOwner([item.file], true);
    expect(() => restarted.current({})).toThrow();
    expect(restarted.capture({})).not.toBe(before);
  });

  test('fresh ordinary configuration never writes continuation state during recovery reads', () => {
    const dir = directory(); const manager = new ConfigManager({ configDir: dir, surfaceRoot: 'daemon' });
    manager.setRuntimeOverride('behavior.autoApprove', false);
    expect(() => manager.getDurableConfigurationIncarnation()).toThrow();
    expect(() => readFileSync(`${manager.getConfigPath()}.policy-epoch.json`)).toThrow();
    expect(manager.captureDurableConfigurationIncarnation()).toMatch(/^[0-9a-f]{64}$/);
  });

  test('held/crash-left mutation lock prevents current() from accepting old state', () => {
    const item = fixture(); mkdirSync(`${item.sidecar}.owner-lock`);
    expect(() => item.owner.current({})).toThrow();
    expect(() => new DurablePolicyEpochOwner([item.file], true).current({})).toThrow();
  });

  test('an observed missing epoch cannot be restored into the same serving owner', () => {
    const item = fixture(); const saved = readFileSync(item.sidecar, 'utf8'); rmSync(item.sidecar);
    expect(() => item.owner.current({})).toThrow(); writeFileSync(item.sidecar, saved);
    expect(() => item.owner.current({})).toThrow();
  });

  test('a symlink transplanted to the same policy inode changes or refuses the epoch', () => {
    const item = fixture(); const before = item.owner.current({});
    renameSync(item.file, `${item.file}.displaced`); symlinkSync(`${item.file}.displaced`, item.file);
    let after: string | undefined; try { after = item.owner.current({}); } catch { /* Refusal is valid. */ }
    expect(after).not.toBe(before);
  });

  test('a symlink transplanted to the same epoch sidecar is refused', () => {
    const item = fixture(); renameSync(item.sidecar, `${item.sidecar}.displaced`);
    symlinkSync(`${item.sidecar}.displaced`, item.sidecar);
    expect(() => item.owner.current({})).toThrow();
    expect(() => new DurablePolicyEpochOwner([item.file], true).current({})).toThrow();
  });

  test('active intent refuses a symlinked root before it can write copied history or configuration elsewhere', () => {
    const item = managerFixture(); const moved = `${item.dir}-original`; dirs.push(moved);
    renameSync(item.dir, moved); symlinkSync(moved, item.dir);
    const sidecar = join(moved, 'settings.json.policy-epoch.json'); const before = readFileSync(sidecar, 'utf8');
    expect(() => item.manager.set('behavior.autoApprove', true)).toThrow('mutation intent');
    expect(readFileSync(sidecar, 'utf8')).toBe(before);
    expect(() => readFileSync(join(moved, 'settings.json'))).toThrow();
  });

  test('a serving manager cannot write through a copied replacement root incarnation', () => {
    const item = managerFixture(); const moved = `${item.dir}-original`; dirs.push(moved);
    renameSync(item.dir, moved); cpSync(moved, item.dir, { recursive: true });
    const sidecar = join(item.dir, 'settings.json.policy-epoch.json'); const before = readFileSync(sidecar, 'utf8');
    expect(() => item.manager.set('behavior.autoApprove', true)).toThrow('mutation intent');
    expect(readFileSync(sidecar, 'utf8')).toBe(before);
    expect(() => readFileSync(join(item.dir, 'settings.json'))).toThrow();
  });

  test('post-effect reconciliation cannot adopt a newer owner nonce', () => {
    const item = fixture(); item.owner.advance();
    const other = new DurablePolicyEpochOwner([item.file], true); other.advance();
    item.owner.reconcile();
    expect(() => item.owner.current({})).toThrow();
    expect(() => other.current({})).not.toThrow();
  });

  test('crash after durable intent but before effects cannot recover the earlier grant', () => {
    const item = fixture(); const before = item.owner.current({}); item.owner.advance();
    const restarted = new DurablePolicyEpochOwner([item.file], true);
    expect(restarted.current({})).not.toBe(before);
  });

  test('partial multi-root intent aborts effects and cannot revive the earlier combined revision', () => {
    const dir = directory(); const files = [join(dir, 'first.json'), join(dir, 'second.json')];
    for (const file of files) writeFileSync(file, '{}');
    const owner = new DurablePolicyEpochOwner(files, true); const before = owner.capture({});
    const original = atomic.writeJsonFileAtomic;
    const write = spyOn(atomic, 'writeJsonFileAtomic').mockImplementation((file, data, options) => {
      if (file === `${files[1]}.policy-epoch.json`) throw new Error('synthetic second-root failure');
      return original(file, data, options);
    });
    try { expect(() => owner.advance()).toThrow('mutation intent'); } finally { write.mockRestore(); }
    expect(() => owner.current({})).toThrow();
    expect(new DurablePolicyEpochOwner(files, true).current({})).not.toBe(before);
  });

  test('reconciliation failure preserves committed config truth and fences further durable use', () => {
    const item = managerFixture(); const original = atomic.writeJsonFileAtomic;
    const write = spyOn(atomic, 'writeJsonFileAtomic').mockImplementation((file, data, options) => {
      if (file === item.manager.getConfigPath()) {
        original(file, data, options);
        mkdirSync(`${file}.policy-epoch.json.owner-lock`);
        return;
      }
      return original(file, data, options);
    });
    try { expect(() => item.manager.set('behavior.autoApprove', true)).not.toThrow(); } finally { write.mockRestore(); }
    expect(item.manager.get('behavior.autoApprove')).toBe(true);
    expect(JSON.parse(readFileSync(item.manager.getConfigPath(), 'utf8')).behavior.autoApprove).toBe(true);
    expect(() => item.manager.getDurableConfigurationIncarnation()).toThrow();
    expect(() => item.restart().getDurableConfigurationIncarnation()).toThrow();
  });

  test('absent policy plus copied sidecar cannot survive owner-root replacement', () => {
    const item = fixture(false); const before = item.owner.current({}); const saved = readFileSync(item.sidecar, 'utf8');
    renameSync(item.dir, `${item.dir}-old`); dirs.push(`${item.dir}-old`); mkdirSync(item.dir); writeFileSync(item.sidecar, saved);
    let after: string | undefined; try { after = new DurablePolicyEpochOwner([item.file], true).current({}); } catch { /* Refusal is valid. */ }
    expect(after).not.toBe(before);
  });

  test('failed durable intent aborts mutation before runtime effects can escape into restart ABA', () => {
    const item = managerFixture(); const before = item.manager.getDurableConfigurationIncarnation();
    const write = spyOn(atomic, 'writeJsonFileAtomic').mockImplementationOnce(() => { throw new Error('synthetic epoch disk failure'); });
    let failed = false;
    try { item.manager.setRuntimeOverride('behavior.autoApprove', true); } catch { failed = true; }
    finally { write.mockRestore(); }
    expect(failed).toBe(true); expect(item.manager.get('behavior.autoApprove')).toBe(false);
    // If effects did occur, no new process may reconstruct exactly the old authority.
    if (!failed) expect(item.restart().getDurableConfigurationIncarnation()).not.toBe(before);
  });

  test('failed durable intent still fences the existing in-memory source lifetime', () => {
    const item = managerFixture(); const before = item.manager.getConfigurationIncarnation(); let invalidated = 0; let incarnated = 0;
    item.manager.onDidInvalidate(() => { invalidated++; }); item.manager.onDidChangeIncarnation(() => { incarnated++; });
    const write = spyOn(atomic, 'writeJsonFileAtomic').mockImplementationOnce(() => { throw new Error('synthetic epoch failure'); });
    try { expect(() => item.manager.setRuntimeOverride('behavior.autoApprove', true)).toThrow(); } finally { write.mockRestore(); }
    expect(item.manager.getConfigurationIncarnation()).toBe(before + 1);
    expect(invalidated).toBe(1); expect(incarnated).toBe(1); expect(item.manager.get('behavior.autoApprove')).toBe(false);
  });

  test('active history write failure retains registered host fail-restrictive behavior', () => {
    const dir = directory(); const manager = new ConfigManager({ configDir: dir, surfaceRoot: 'daemon',
      hostSettings: [{ key: 'behavior.syntheticPrivateHost', type: 'boolean', default: true, description: 'Synthetic restrictive fixture' }] });
    const handle = manager.getHostBooleanSetting('behavior.syntheticPrivateHost'); handle.set(false);
    manager.captureDurableConfigurationIncarnation(); chmodSync(dir, 0);
    try { expect(() => handle.set(true)).toThrow(); expect(handle.get()).toBe(true); }
    finally { chmodSync(dir, 0o700); }
    expect(() => manager.getDurableConfigurationIncarnation()).toThrow();
  });

  test('managed policy changes are part of actual configuration ownership', () => {
    const item = managerFixture(); const before = item.manager.getDurableConfigurationIncarnation();
    writeFileSync(join(item.dir, 'settings-sync.json'), JSON.stringify({ version: 2, managedLocks: [
      { key: 'behavior.autoApprove', source: 'synthetic-admin', reason: 'synthetic policy change', updatedAt: 1 },
    ] }));
    let after: string | undefined; try { after = item.manager.getDurableConfigurationIncarnation(); } catch { /* Refusal is valid. */ }
    expect(after).not.toBe(before);
    const restarted = item.restart();
    expect(() => restarted.getDurableConfigurationIncarnation()).toThrow();
    restarted.load(); expect(restarted.getDurableConfigurationIncarnation()).not.toBe(before);
  });
});
