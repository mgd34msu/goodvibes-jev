import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runDaemonServiceCli, type ManagedServiceActionRunner } from '../../daemon/service-commands.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

function fixture() {
  const root = makeOwnedTempDir('service-uninstall-safety');
  const homeDir = join(root, 'state');
  const unitHomeDir = join(root, 'login');
  const settings = join(homeDir, '.goodvibes', 'tui', 'settings.json');
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, JSON.stringify({ service: { platform: 'systemd', serviceName: 'owned-service' } }));
  const unit = join(unitHomeDir, '.config', 'systemd', 'user', 'owned-service.service');
  mkdirSync(dirname(unit), { recursive: true });
  const contents = 'owned recovery definition\n';
  writeFileSync(unit, contents);
  const input = { subcommand: 'uninstall-service' as const, binaryPath: '/fixture/goodvibes-daemon',
    homeDir, unitHomeDir, host: '127.0.0.1', port: 4567, legacyUnitFileExists: () => false };
  return { input, unit, contents };
}

for (const scenario of [
  { name: 'denied while active', result: { status: 1, stderr: 'Access denied' }, active: true },
  { name: 'denied while inactive', result: { status: 1, stderr: 'Access denied' }, active: false },
  { name: 'timed out', result: { status: null }, active: true },
  { name: 'missing exit status', result: {}, active: true },
  { name: 'nonzero with blank diagnostic', result: { status: 1, stderr: '   ' }, active: false },
  { name: 'successful action but still active', result: { status: 0 }, active: true },
]) {
  test(`uninstall preserves the definition when stopping is ${scenario.name}`, async () => {
    const { input, unit, contents } = fixture();
    const calls: string[][] = [];
    const runner: ManagedServiceActionRunner = (command, args) => {
      calls.push([command, ...args]);
      if (args.includes('is-active')) return scenario.active
        ? { status: 0, stdout: 'active\n' } : { status: 3, stdout: 'inactive\n' };
      // The missing-status case deliberately exercises a malformed adapter result.
      if (args.includes('stop')) return scenario.result as ReturnType<ManagedServiceActionRunner>;
      throw new Error('unexpected fixture action');
    };
    const result = await runDaemonServiceCli({ ...input, actionRunner: runner });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.status.installed).toBe(true);
    expect(result.status.running).toBe(scenario.active);
    expect(readFileSync(unit, 'utf8')).toBe(contents);
    expect(result.lines.join('\n')).toContain('not removed');
    expect(result.lines.join('\n')).not.toContain('may not have been running');
    expect(calls.filter((call) => !call.includes('is-active'))).toEqual([
      ['systemctl', '--user', 'stop', 'owned-service.service'],
    ]);
  });
}

for (const thrown of [new Error('fixture stop failed'), undefined]) {
  test(`uninstall returns an incomplete receipt when stop throws ${thrown === undefined ? 'undefined' : 'an error'}`, async () => {
    const { input, unit, contents } = fixture();
    const runner: ManagedServiceActionRunner = (_command, args) => {
      if (args.includes('is-active')) return { status: 0, stdout: 'active\n' };
      if (args.includes('stop')) throw thrown;
      throw new Error('unexpected fixture action');
    };
    const result = await runDaemonServiceCli({ ...input, actionRunner: runner });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(readFileSync(unit, 'utf8')).toBe(contents);
    expect(result.status.installed).toBe(true);
    expect(result.lines.join('\n')).toContain('not removed');
  });
}

test('a confirmed active-to-stopped transition removes only the managed definition', async () => {
  const { input, unit } = fixture();
  const neighbor = join(dirname(unit), 'unrelated.service');
  writeFileSync(neighbor, 'unrelated definition\n');
  let active = true;
  const runner: ManagedServiceActionRunner = (_command, args) => {
    if (args.includes('is-active')) return active
      ? { status: 0, stdout: 'active\n' } : { status: 3, stdout: 'inactive\n' };
    if (args.includes('stop')) { active = false; return { status: 0 }; }
    throw new Error('unexpected fixture action');
  };
  const result = await runDaemonServiceCli({ ...input, actionRunner: runner });
  expect(result.ok).toBe(true);
  expect(result.exitCode).toBe(0);
  expect(result.status.running).toBe(false);
  expect(result.status.installed).toBe(false);
  expect(existsSync(unit)).toBe(false);
  expect(readFileSync(neighbor, 'utf8')).toBe('unrelated definition\n');
  expect(result.lines.join('\n')).toContain('removed the systemd service');
});

test('a returned active state after removal reports incomplete without another stop or removal', async () => {
  const { input, unit } = fixture();
  let stops = 0;
  const runner: ManagedServiceActionRunner = (_command, args) => {
    if (args.includes('is-active')) return existsSync(unit)
      ? { status: 3, stdout: 'inactive\n' } : { status: 0, stdout: 'active\n' };
    if (args.includes('stop')) { stops += 1; return { status: 0 }; }
    throw new Error('unexpected fixture action');
  };
  const result = await runDaemonServiceCli({ ...input, actionRunner: runner });
  expect(result.ok).toBe(false);
  expect(result.exitCode).toBe(1);
  expect(result.status.installed).toBe(false);
  expect(result.status.running).toBe(true);
  expect(result.lines.join('\n')).toContain('incomplete');
  expect(stops).toBe(1);
});

for (const thrown of [new Error('fixture final query failed'), undefined]) {
  test(`an injected post-removal query throwing ${thrown === undefined ? 'undefined' : 'an error'} retains an honest incomplete receipt`, async () => {
    const { input, unit } = fixture();
    const runner: ManagedServiceActionRunner = (_command, args) => {
      if (args.includes('is-active')) {
        if (!existsSync(unit)) throw thrown;
        return { status: 3, stdout: 'inactive\n' };
      }
      if (args.includes('stop')) return { status: 0 };
      throw new Error('unexpected fixture action');
    };
    const result = await runDaemonServiceCli({ ...input, actionRunner: runner });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(existsSync(unit)).toBe(false);
    expect(result.lines.join('\n')).toContain('removal may already have happened');
    expect(result.lines.join('\n')).toContain('last confirmed state before removal');
    expect(result.lines.join('\n')).not.toContain('not removed');
  });
}
