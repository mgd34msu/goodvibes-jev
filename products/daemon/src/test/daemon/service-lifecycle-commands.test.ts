import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  DAEMON_SERVICE_SUBCOMMANDS,
  buildLifecycleResultLines,
  runDaemonServiceCli,
  serviceStatusExitCode,
  serviceStatusJson,
  SERVICE_STATUS_EXIT_INSTALLED_NOT_RUNNING,
  SERVICE_STATUS_EXIT_NOT_INSTALLED,
  SERVICE_STATUS_EXIT_RUNNING,
  type ManagedServiceActionRunner,
} from '../../daemon/service-commands.js';
import type { ManagedServiceStatus } from '@goodvibes-jev/engine/sdk/platform/daemon';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

/**
 * `start-service` / `stop-service` / `restart-service` are new commands on the
 * SAME PlatformServiceManager install/uninstall/service-status already use, and
 * `service-status` now answers with an exit code instead of always 0.
 *
 * Every test injects the systemctl runner, exactly as the install/uninstall
 * tests beside them do: no test in this file may reach the host's systemd.
 */
describe('service lifecycle verbs (systemd path, real PlatformServiceManager, stubbed systemctl)', () => {
  let dir = '';

  beforeEach(() => {
    dir = makeOwnedTempDir('gv-service-lifecycle');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function stubSystemctl(options: { readonly isActive?: boolean; readonly actionStatus?: number } = {}): {
    runner: ManagedServiceActionRunner;
    calls: string[][];
  } {
    const calls: string[][] = [];
    const runner: ManagedServiceActionRunner = (command, args) => {
      calls.push([command, ...args]);
      if (args.includes('is-active')) {
        return options.isActive === true ? { status: 0, stdout: 'active\n' } : { status: 3, stdout: 'inactive\n' };
      }
      return { status: options.actionStatus ?? 0 };
    };
    return { runner, calls };
  }

  function baseInput(overrides: Partial<Parameters<typeof runDaemonServiceCli>[0]> = {}) {
    return {
      subcommand: 'service-status' as const,
      binaryPath: '/usr/local/bin/goodvibes-daemon',
      homeDir: dir,
      unitHomeDir: dir,
      host: '127.0.0.1',
      port: 3421,
      actionRunner: stubSystemctl().runner,
      ...overrides,
    };
  }

  const unitPath = (): string => join(dir, '.config', 'systemd', 'user', 'goodvibes.service');

  async function install(runner: ManagedServiceActionRunner): Promise<void> {
    const result = await runDaemonServiceCli(baseInput({ subcommand: 'install-service', actionRunner: runner }));
    expect(result.ok).toBe(true);
    expect(existsSync(unitPath())).toBe(true);
  }

  test('the catalog of service verbs is the seven this dispatcher handles', () => {
    expect([...DAEMON_SERVICE_SUBCOMMANDS]).toEqual([
      'install-service',
      'uninstall-service',
      'service-status',
      'migrate-service',
      'start-service',
      'stop-service',
      'restart-service',
    ]);
  });

  test('start-service enables and starts the installed unit', async () => {
    const { runner, calls } = stubSystemctl();
    await install(runner);
    calls.length = 0;

    const result = await runDaemonServiceCli(baseInput({ subcommand: 'start-service', actionRunner: runner }));

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(calls.some((call) => call.join(' ').includes('enable --now goodvibes.service'))).toBe(true);
    expect(result.lines.join('\n')).toContain('started the systemd service goodvibes');
  });

  test('stop-service stops the unit and leaves it installed', async () => {
    const { runner, calls } = stubSystemctl();
    await install(runner);
    calls.length = 0;

    const result = await runDaemonServiceCli(baseInput({ subcommand: 'stop-service', actionRunner: runner }));

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(calls.some((call) => call.join(' ').includes('stop goodvibes.service'))).toBe(true);
    expect(existsSync(unitPath())).toBe(true);
    expect(result.lines.join('\n')).toContain('stopped the systemd service goodvibes');
  });

  test('restart-service restarts the unit', async () => {
    const { runner, calls } = stubSystemctl({ isActive: true });
    await install(runner);
    calls.length = 0;

    const result = await runDaemonServiceCli(baseInput({ subcommand: 'restart-service', actionRunner: runner }));

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(calls.some((call) => call.join(' ').includes('restart goodvibes.service'))).toBe(true);
    expect(result.lines.join('\n')).toContain('restarted the systemd service goodvibes');
    expect(result.lines.join('\n')).toContain('it is running');
  });

  test.each([['start-service'], ['stop-service'], ['restart-service']])(
    '%s against an absent service says so, exits 4, and dispatches nothing',
    async (subcommand) => {
      const { runner, calls } = stubSystemctl();
      const result = await runDaemonServiceCli(baseInput({
        subcommand: subcommand as 'start-service',
        actionRunner: runner,
      }));

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(SERVICE_STATUS_EXIT_NOT_INSTALLED);
      expect(result.lines.join('\n')).toContain('there is nothing to');
      expect(result.lines.join('\n')).toContain('install-service');
      // Nothing but the read-only liveness probe may have been dispatched.
      expect(calls.every((call) => call.includes('is-active') || call.includes('--version'))).toBe(true);
    },
  );

  test('a platform action that fails is reported as a failure, not a success', async () => {
    const { runner } = stubSystemctl();
    await install(runner);
    const failing = stubSystemctl({ actionStatus: 1 });

    const result = await runDaemonServiceCli(baseInput({
      subcommand: 'restart-service',
      actionRunner: failing.runner,
    }));

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('service restart failed');
  });

  test('the lifecycle receipt names the resolved unit, never a hardcoded one', () => {
    const status = {
      platform: 'launchd',
      serviceName: 'com.example.custom',
      path: '/Users/x/Library/LaunchAgents/com.example.custom.plist',
      installed: true,
      autostart: true,
      running: true,
      commandPreview: '',
      suggestedCommands: [],
    } as unknown as ManagedServiceStatus;
    const lines = buildLifecycleResultLines('start', status).join('\n');
    expect(lines).toContain('com.example.custom');
    expect(lines).toContain('launchd');
    expect(lines).not.toContain('systemd');
  });
});

describe('service-status answers with an exit code', () => {
  function status(installed: boolean, running: boolean): ManagedServiceStatus {
    return {
      platform: 'systemd',
      serviceName: 'goodvibes',
      path: '/home/x/.config/systemd/user/goodvibes.service',
      installed,
      autostart: installed,
      running,
      commandPreview: 'goodvibes-daemon',
      suggestedCommands: ['systemctl --user status goodvibes.service'],
    } as unknown as ManagedServiceStatus;
  }

  test('0 installed and running, 3 installed and not running, 4 not installed', () => {
    expect(serviceStatusExitCode(status(true, true))).toBe(SERVICE_STATUS_EXIT_RUNNING);
    expect(serviceStatusExitCode(status(true, true))).toBe(0);
    expect(serviceStatusExitCode(status(true, false))).toBe(SERVICE_STATUS_EXIT_INSTALLED_NOT_RUNNING);
    expect(serviceStatusExitCode(status(true, false))).toBe(3);
    expect(serviceStatusExitCode(status(false, false))).toBe(SERVICE_STATUS_EXIT_NOT_INSTALLED);
    expect(serviceStatusExitCode(status(false, false))).toBe(4);
    // "Not installed" wins over a stray running flag: there is no unit to report on.
    expect(serviceStatusExitCode(status(false, true))).toBe(4);
  });

  test('--json carries the fields and the exit code in one document', () => {
    const parsed = JSON.parse(serviceStatusJson(status(true, false), { present: false } as never)) as {
      ok: boolean;
      data: Record<string, unknown>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data['installed']).toBe(true);
    expect(parsed.data['running']).toBe(false);
    expect(parsed.data['serviceName']).toBe('goodvibes');
    expect(parsed.data['exitCode']).toBe(3);
    expect(parsed.data['legacyUnitPresent']).toBe(false);
  });
});

describe('service-status end to end', () => {
  let dir = '';

  beforeEach(() => {
    dir = makeOwnedTempDir('gv-service-status-exit');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function runner(isActive: boolean): ManagedServiceActionRunner {
    return (_command, args) => {
      if (args.includes('is-active')) {
        return isActive ? { status: 0, stdout: 'active\n' } : { status: 3, stdout: 'inactive\n' };
      }
      return { status: 0 };
    };
  }

  function baseInput(overrides: Partial<Parameters<typeof runDaemonServiceCli>[0]> = {}) {
    return {
      subcommand: 'service-status' as const,
      binaryPath: '/usr/local/bin/goodvibes-daemon',
      homeDir: dir,
      unitHomeDir: dir,
      host: '127.0.0.1',
      port: 3421,
      actionRunner: runner(false),
      ...overrides,
    };
  }

  test('exits 4 when nothing is installed', async () => {
    const result = await runDaemonServiceCli(baseInput());
    expect(result.exitCode).toBe(4);
    // The question was answered; `ok` reports that, the code reports the answer.
    expect(result.ok).toBe(true);
    expect(result.lines.join('\n')).toContain('installed: false');
  });

  test('exits 3 when installed but not running', async () => {
    await runDaemonServiceCli(baseInput({ subcommand: 'install-service' }));
    const result = await runDaemonServiceCli(baseInput());
    expect(result.exitCode).toBe(3);
  });

  test('exits 0 when installed and running', async () => {
    await runDaemonServiceCli(baseInput({ subcommand: 'install-service', actionRunner: runner(true) }));
    const result = await runDaemonServiceCli(baseInput({ actionRunner: runner(true) }));
    expect(result.exitCode).toBe(0);
  });

  test('--json prints one document and keeps the same exit code', async () => {
    await runDaemonServiceCli(baseInput({ subcommand: 'install-service' }));
    const result = await runDaemonServiceCli(baseInput({ json: true }));
    expect(result.exitCode).toBe(3);
    expect(result.lines.length).toBe(1);
    const parsed = JSON.parse(result.lines[0] as string) as { data: { exitCode: number } };
    expect(parsed.data.exitCode).toBe(3);
  });
});
