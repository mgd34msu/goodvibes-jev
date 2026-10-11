/** Pinned daemon service assertions 5c85003cde26cc618fda3d58e7a5cf1b78594594.
 * Reconstructed after executor replacement; see the bounded source-proof audit.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { PlatformServiceManager } from '@goodvibes-jev/engine/sdk/platform/daemon';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../../config/surface.js';
import { buildManagedDaemonServiceManager } from '../../runtime/legacy-daemon-migration.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

const surfaceRoot = GOODVIBES_DAEMON_SURFACE_ROOT;
type Call = { command: string; args: readonly string[] };
describe('canonical service lifecycle and product command composition', () => {
  let root = '';
  beforeEach(() => { root = makeOwnedTempDir('gv-service-manager'); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  function config(platform: 'manual' | 'systemd' | 'launchd' | 'windows', serviceName = 'goodvibes-test') {
    const value = new ConfigManager({ surfaceRoot, workingDir: root, homeDir: root, configDir: join(root, '.goodvibes', surfaceRoot) });
    value.set('service.platform', platform);
    value.set('service.serviceName', serviceName);
    return value;
  }
  function manager(value: ConfigManager, calls: Call[]) {
    return new PlatformServiceManager(value, {
      workingDirectory: root, homeDirectory: root, surfaceRoot,
      actionRunner: (command, args) => { calls.push({ command, args }); return { status: 0, stdout: '', stderr: '' }; },
    });
  }

  test('canonical manual definition preserves original default source-command contract', () => {
    const value = config('manual');
    value.set('service.autostart', true);
    value.set('service.restartOnFailure', true);
    value.set('service.logPath', `.goodvibes/${surfaceRoot}/service/manual-custom.log`);
    const service = manager(value, []);
    expect(service.status()).toMatchObject({ platform: 'manual', installed: false,
      logPath: join(root, '.goodvibes', surfaceRoot, 'service', 'manual-custom.log') });
    const installed = service.install();
    expect(installed.installed).toBe(true);
    expect(installed.path).toBe(join(root, '.goodvibes', surfaceRoot, 'service', 'manual-service.txt'));
    // Generic engine default only. Production daemon supplies an explicit binary below.
    expect(installed.contents).toContain('src/daemon/cli.ts');
    expect(installed.commandPreview).toContain('manual-service.txt');
    expect(service.uninstall().installed).toBe(false);
  });

  test('product manager installs the supplied executable and daemon state home, without legacy source or endpoint flags', () => {
    const value = config('systemd', 'gv-product');
    const binaryPath = new URL('../../../bin/goodvibes-daemon', import.meta.url).pathname;
    expect(existsSync(binaryPath)).toBe(true);
    const service = buildManagedDaemonServiceManager({
      configManager: value, binaryPath, homeDir: root, unitHomeDir: root,
      workingDirectory: root, host: '127.0.0.1', port: 31111,
      actionRunner: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    const installed = service.install();
    expect(installed.path).toBe(join(root, '.config', 'systemd', 'user', 'gv-product.service'));
    expect(installed.contents).toContain(binaryPath);
    expect(installed.contents).toContain('--daemon-home');
    expect(installed.contents).toContain(join(root, '.goodvibes', 'daemon'));
    expect(installed.contents).not.toContain('src/daemon/cli.ts');
    expect(installed.contents).not.toContain('--hostname');
    expect(installed.contents).not.toContain('--port');
    expect(service.uninstall().installed).toBe(false);
  });

  test('real manual child install/start/status/restart/stop preserves pid and log path', () => {
    const value = config('manual');
    const logPath = join(root, '.goodvibes', surfaceRoot, 'service', 'manual.log');
    value.set('service.logPath', logPath);
    const service = new PlatformServiceManager(value, {
      workingDirectory: root, homeDirectory: root, surfaceRoot,
      definitionOverride: { name: 'test-daemon', description: 'test daemon', workingDirectory: root,
        command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: {}, restartOnFailure: false },
    });
    try {
      expect(service.install().logPath).toBe(logPath);
      const started = service.start();
      expect(started.running).toBe(true);
      expect(typeof started.pid).toBe('number');
      expect(started.logPath).toBe(logPath);
      const restarted = service.restart();
      expect(restarted.running).toBe(true);
      expect(typeof restarted.pid).toBe('number');
      expect(restarted.pid).not.toBe(started.pid);
      expect(service.status().pid).toBe(restarted.pid);
      expect(service.status().running).toBe(true);
      expect(service.stop().running).toBe(false);
    } finally { service.stop(); service.uninstall(); }
  });

  test('systemd configured-name artifact and exact mutating command sequence', () => {
    const calls: Call[] = [];
    const value = config('systemd', 'gv-ops');
    value.set('service.restartOnFailure', false);
    value.set('service.autostart', true);
    const logPath = join(root, '.goodvibes', surfaceRoot, 'service', 'systemd.log');
    value.set('service.logPath', logPath);
    const service = manager(value, calls);
    const installed = service.install();
    expect(installed.path.endsWith('gv-ops.service')).toBe(true);
    expect(installed.contents).toContain('Restart=no');
    expect(installed.contents).toContain('ExecStart=');
    expect(installed.logPath).toBe(logPath);
    service.start(); service.stop(); service.restart();
    const statusQueries = calls.filter(c => c.args.includes('is-active'));
    for (const call of calls.filter(c => c.command === 'loginctl')) expect(['show-user', 'enable-linger']).toContain(call.args[0]!);
    expect(calls.filter(c => !c.args.includes('is-active') && !c.args.includes('--version') && c.command !== 'loginctl')).toEqual([
      { command: 'systemctl', args: ['--user', 'enable', '--now', 'gv-ops.service'] },
      { command: 'systemctl', args: ['--user', 'stop', 'gv-ops.service'] },
      { command: 'systemctl', args: ['--user', 'restart', 'gv-ops.service'] },
    ]);
    for (const query of statusQueries) expect(query).toEqual({ command: 'systemctl', args: ['--user', 'is-active', 'gv-ops.service'] });
  });

  test('launchd and Windows configured-name artifacts and exact actions', () => {
    const launchdCalls: Call[] = [];
    const launchd = manager(config('launchd', 'dev.goodvibes.launchd'), launchdCalls);
    const installed = launchd.install();
    expect(installed.path.endsWith('dev.goodvibes.launchd.plist')).toBe(true);
    expect(installed.contents).toContain('<key>Label</key>');
    expect(installed.contents).toContain('<string>dev.goodvibes.launchd</string>');
    launchd.start(); launchd.stop(); launchd.restart();
    expect(launchdCalls.filter(c => c.args[0] !== 'list')).toEqual([
      { command: 'launchctl', args: ['load', installed.path] },
      { command: 'launchctl', args: ['unload', installed.path] },
      { command: 'launchctl', args: ['unload', installed.path] },
      { command: 'launchctl', args: ['load', installed.path] },
    ]);
    const windowsCalls: Call[] = [];
    const windows = manager(config('windows', 'GoodVibesTask'), windowsCalls);
    expect(windows.install().contents).toContain('schtasks /Create /SC ONLOGON /TN "GoodVibesTask"');
    windows.start(); windows.stop(); windows.restart();
    expect(windowsCalls).toEqual([
      { command: 'schtasks', args: ['/Run', '/TN', 'GoodVibesTask'] },
      { command: 'schtasks', args: ['/End', '/TN', 'GoodVibesTask'] },
      { command: 'schtasks', args: ['/Run', '/TN', 'GoodVibesTask'] },
    ]);
  });
});
