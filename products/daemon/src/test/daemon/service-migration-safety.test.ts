import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { runDaemonServiceCli } from '../../daemon/service-commands.js';
import { buildManagedDaemonServiceManager, legacyUnitPath, runLegacyDaemonMigration, type ManagedServiceActionRunner } from '../../runtime/legacy-daemon-migration.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

function fixture() {
  const root = makeOwnedTempDir('service-migration-safety');
  const unitHomeDir = join(root, 'login');
  const homeDir = join(root, 'state');
  const settings = join(homeDir, '.goodvibes', 'tui', 'settings.json');
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, JSON.stringify({ controlPlane: { port: 4567 }, service: { platform: 'systemd', serviceName: 'owned-service' } }));
  const legacy = legacyUnitPath(unitHomeDir);
  const managed = join(unitHomeDir, '.config', 'systemd', 'user', 'owned-service.service');
  mkdirSync(dirname(legacy), { recursive: true });
  writeFileSync(legacy, 'owned legacy unit\n');
  const calls: string[][] = [];
  const runner: ManagedServiceActionRunner = (command, args) => {
    calls.push([command, ...args]);
    if (args[1] === 'is-active') return { status: 3, stdout: 'inactive' };
    if (args[0] === 'show-user') return { status: 0, stdout: 'Linger=yes' };
    return { status: 0 };
  };
  const input = { subcommand: 'migrate-service' as const, binaryPath: '/owned-fixture/goodvibes-daemon', homeDir, unitHomeDir,
    host: '127.0.0.1', port: 4567, actionRunner: runner, portProbe: () => false };
  return { root, settings, legacy, managed, calls, input };
}

function files(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(path: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const target = join(path, entry.name);
      if (entry.isDirectory()) { result[`${relative(root, target)}/`] = '<directory>'; walk(target); }
      else result[relative(root, target)] = readFileSync(target, 'utf8');
    }
  }
  walk(root);
  return result;
}

for (const mode of ['dry-run', 'status', 'refused-flags'] as const) {
  test(`${mode} preserves genuinely unmigrated configuration byte-for-byte`, async () => {
    const { root, calls, input } = fixture();
    const before = files(root);
    const result = await runDaemonServiceCli({ ...input,
      ...(mode === 'status' ? { subcommand: 'service-status' as const } : {}),
      ...(mode === 'refused-flags' ? { confirmMigration: true, portFlagProvided: true } : {}),
    });
    expect(files(root)).toEqual(before);
    expect(calls.every((call) => call.includes('is-active') || call.includes('show'))).toBe(true);
    expect(result.status.serviceName).toBe('owned-service');
  });
}

test('pre-existing custom managed unit is refused without changing unit or settings', async () => {
  const { root, managed, calls, input } = fixture();
  writeFileSync(managed, 'owned custom unit that must survive\n');
  const before = files(root);
  const result = await runDaemonServiceCli({ ...input, confirmMigration: true });
  expect(result.ok).toBe(false);
  expect(result.lines.join('\n')).toContain('already exists');
  expect(files(root)).toEqual(before);
  expect(calls.some((call) => call.includes('enable') || call.includes('disable') || call.includes('stop'))).toBe(false);
});

test('failed health preserves configuration and legacy unit while removing only the new unit', async () => {
  const { root, managed, input } = fixture();
  const before = files(root);
  const result = await runDaemonServiceCli({ ...input, confirmMigration: true });
  expect(result.ok).toBe(false);
  expect(existsSync(managed)).toBe(false);
  expect(result.status.installed).toBe(false);
  expect(files(root)).toEqual(before);
  expect(result.lines.join('\n')).toContain('rolled back');
});

for (const failure of ['throws', 'nonzero'] as const) {
  test(`rollback disable ${failure} preserves the new unit with a truthful failure receipt`, async () => {
    const { legacy, managed, input } = fixture();
    const runner: ManagedServiceActionRunner = (command, args) => {
      if (args.includes('disable')) {
        if (failure === 'throws') throw new Error('owned rollback failure');
        return { status: 1, stderr: 'owned rollback refusal' };
      }
      return input.actionRunner(command, args);
    };
    const result = await runDaemonServiceCli({ ...input, actionRunner: runner, confirmMigration: true });
    expect(result.ok).toBe(false);
    expect(existsSync(managed)).toBe(true);
    expect(readFileSync(legacy, 'utf8')).toBe('owned legacy unit\n');
    expect(result.lines.join('\n')).toContain('rollback');
    expect(result.lines.join('\n')).not.toContain('has been rolled back (removed)');
  });
}

test('rollback uninstall exception is returned as failure without claiming removal', async () => {
  const { legacy, managed, input } = fixture();
  const manager = buildManagedDaemonServiceManager(input);
  manager.uninstall = () => { throw new Error('owned uninstall failure'); };
  const result = await runLegacyDaemonMigration({ ...input, trackedServiceName: 'owned-service', confirmMigration: true },
    manager, { present: true, active: false, path: legacy });
  expect(result.ok).toBe(false);
  expect(existsSync(managed)).toBe(true);
  expect(result.lines.join('\n')).toContain('rollback');
  expect(result.lines.join('\n')).not.toContain('has been rolled back (removed)');
});

for (const stage of ['install', 'start'] as const) {
  test(`a thrown ${stage} returns rollback outcome without touching the legacy unit`, async () => {
    const { legacy, managed, input } = fixture();
    const manager = buildManagedDaemonServiceManager(input);
    const originalInstall = manager.install.bind(manager);
    if (stage === 'install') manager.install = () => { originalInstall(); throw new Error('owned install exception'); };
    else manager.start = () => { throw new Error('owned start exception'); };
    const result = await runLegacyDaemonMigration({ ...input, trackedServiceName: 'owned-service', confirmMigration: true },
      manager, { present: true, active: false, path: legacy });
    expect(result.ok).toBe(false);
    expect(result.status.installed).toBe(false);
    expect(existsSync(managed)).toBe(false);
    expect(readFileSync(legacy, 'utf8')).toBe('owned legacy unit\n');
  });
}

function layeredConfig(root: string) {
  const homeDir = join(root, 'home');
  const workingDir = join(root, 'project');
  const write = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
  write(join(homeDir, '.goodvibes', 'tui', 'settings.json'), {
    service: { serviceName: 'global-service' }, orchestration: { maxActiveAgents: 4 },
    danger: { daemon: false }, controlPlane: { baseUrl: 'http://owned-fixture:4567' },
    payments: { budget: { perPurchaseCeilingCents: 1234 } },
  });
  write(join(workingDir, '.goodvibes', 'tui', 'settings.json'), { service: { serviceName: 'project-service' } });
  write(join(homeDir, '.goodvibes', 'daemon', 'settings.json'), { service: { serviceName: 'daemon-service' },
    payments: { budget: { perPurchaseCeilingCents: 2500 } } });
  write(join(homeDir, '.goodvibes', 'shared', 'settings.json'), { tts: { enabled: false } });
  return { homeDir, workingDir, surfaceRoot: 'tui', ownsDaemonTier: true };
}

test('read-only construction preserves canonical defaults, layers and migrations without files or receipts', () => {
  const root = makeOwnedTempDir('service-readonly-config');
  const options = layeredConfig(root);
  const before = files(root);
  const readOnly = new ConfigManager({ ...options, readOnly: true });
  expect(files(root)).toEqual(before);
  expect(readOnly.get('service.serviceName')).toBe('project-service');
  expect(readOnly.get('payments.budget.perPurchaseCeiling')).toBe(25);
  expect(readOnly.get('fleet.maxSize')).toBe(4);
  const other = makeOwnedTempDir('service-writable-config');
  const writable = new ConfigManager(layeredConfig(other));
  expect(readOnly.getRaw()).toEqual(writable.getRaw());
  readOnly.load();
  expect(files(root)).toEqual(before);
});

test('every persistent mutator refuses before memory or disk changes on a read-only manager', () => {
  const root = makeOwnedTempDir('service-readonly-mutators');
  const manager = new ConfigManager({ ...layeredConfig(root), readOnly: true });
  const before = files(root);
  const values = manager.getRaw();
  const mutations = [
    () => manager.set('controlPlane.port', 5678),
    () => manager.setDynamic('controlPlane.port', 5678),
    () => manager.setProjectValue('controlPlane.port', 5678),
    () => manager.save(), () => manager.saveProject(),
    () => manager.reset(), () => manager.reset('controlPlane.port'),
    () => manager.mergeCategory('service', { serviceName: 'changed' }),
    () => manager.removeCategoryKey('service', 'serviceName'),
  ];
  for (const mutate of mutations) {
    expect(mutate).toThrow('read-only');
    expect(manager.getRaw()).toEqual(values);
    expect(files(root)).toEqual(before);
  }
});

for (const tier of ['tui', 'daemon', 'shared']) {
  test(`read-only refusal of malformed ${tier} settings creates no quarantine or receipt`, () => {
    const root = makeOwnedTempDir('service-readonly-malformed');
    const settings = join(root, '.goodvibes', tier, 'settings.json');
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, '{owned-malformed');
    const before = files(root);
    expect(() => new ConfigManager({ homeDir: root, surfaceRoot: 'tui', readOnly: true })).toThrow();
    expect(files(root)).toEqual(before);
  });
}

test('read-only construction of an empty home creates nothing', () => {
  const root = makeOwnedTempDir('service-readonly-empty');
  new ConfigManager({ homeDir: root, surfaceRoot: 'tui', readOnly: true });
  expect(files(root)).toEqual({});
});

for (const platform of ['manual', 'windows'] as const) {
  test(`${platform} read-only status preserves malformed PID state without host calls`, async () => {
    const { root, settings, input, calls } = fixture();
    writeFileSync(settings, JSON.stringify({ service: { platform, serviceName: 'owned-service' } }));
    const pid = join(input.homeDir, '.goodvibes', 'service', `${platform}.pid`);
    mkdirSync(dirname(pid), { recursive: true });
    writeFileSync(pid, 'owned-malformed-pid');
    const before = files(root);
    const result = await runDaemonServiceCli({ ...input, subcommand: 'service-status', legacyUnitFileExists: () => false });
    expect(result.status.running).toBe(false);
    expect(files(root)).toEqual(before);
    expect(calls).toEqual([]);
  });
}

for (const confirmMigration of [false, true]) {
  test(`pre-existing running target without a definition is never installed or rolled back (confirmed=${confirmMigration})`, async () => {
    const { root, legacy, input } = fixture();
    const actions: string[] = [];
    const runner: ManagedServiceActionRunner = (_command, args) => {
      if (args[1] === 'is-active') return { status: 0, stdout: 'active' };
      actions.push(args.join(' '));
      return { status: 0 };
    };
    const manager = buildManagedDaemonServiceManager({ ...input, actionRunner: runner });
    expect(manager.status()).toMatchObject({ installed: false, running: true });
    manager.install = () => { actions.push('install'); throw new Error('owned install failure'); };
    manager.uninstall = () => { actions.push('uninstall'); return manager.status(); };
    const before = files(root);
    const result = await runLegacyDaemonMigration({ ...input, actionRunner: runner,
      trackedServiceName: 'owned-service', confirmMigration }, manager, { present: true, active: true, path: legacy });
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('already running');
    expect(actions).toEqual([]);
    expect(files(root)).toEqual(before);
  });
}
