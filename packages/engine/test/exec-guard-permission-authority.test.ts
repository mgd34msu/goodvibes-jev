/**
 * Exec guard: the run-time catastrophic check.
 *
 * Every risk a command carries is decided by the gate before the exec tool
 * runs (Jev's stakes reading and the preset), so the guard never re-denies a
 * command by name or class: kill, docker, sudo and rm on real paths run. What
 * the guard repeats is the gate's catastrophic reading (engine.gate.boundary):
 * a yes is refused; an uncertain reading is allowed only when the gate read it
 * (and so already sent it to the owner at critical stakes), and refused when
 * the exec tool runs without the gate in front of it. With AST parsing on, a
 * command that parses to no runnable segment is refused.
 */
import { describe, expect, test } from 'bun:test';
import { useGateReadings } from './_helpers/gate-readings.ts';
import { guardExecCommand } from '../sdk/src/platform/tools/exec/ast-guard.js';
import { readToolCall } from '../sdk/src/platform/gate/reading.js';
import { createFeatureFlagManager } from '../sdk/src/platform/runtime/feature-flags/index.js';

const flags = (enabledIds: readonly string[]) => ({
  isEnabled(id: string): boolean {
    return enabledIds.includes(id);
  },
});

describe('exec guard: the gate owns command risk', () => {
  useGateReadings([
    ['"rm -rf /"', { mutates: true, catastrophic: true }],
    ['dd if=/dev/zero of=/dev/sda', { mutates: true, catastrophic: true }],
  ]);

  test('ordinary process, container, privilege and cleanup commands run', async () => {
    for (const command of ['kill -TERM 12345', 'docker compose up -d', 'sudo systemctl restart myservice', 'rm -rf /tmp/scratch-dir']) {
      expect((await guardExecCommand(command)).allowed).toBe(true);
    }
  });

  test('a command Jev reads as catastrophic is refused, in both parse modes', async () => {
    for (const mode of [[], ['shell-ast-normalization']]) {
      const result = await guardExecCommand('rm -rf /', flags(mode));
      expect(result.allowed).toBe(false);
      expect(result.denialMessage).toContain('destroying the machine');
    }
    expect((await guardExecCommand('dd if=/dev/zero of=/dev/sda')).allowed).toBe(false);
  });

  test('the guard reuses the gate\'s reading of the same command instead of asking again', async () => {
    const reading = await readToolCall({ toolName: 'exec', args: { command: 'rm -rf /' }, askObfuscated: true });
    expect(reading.boundary.catastrophic).toBe('yes');
    expect((await guardExecCommand('rm -rf /')).allowed).toBe(false);
  });
});

describe('exec guard: an uncertain reading', () => {
  useGateReadings([['maybe-wipe.sh', { mutates: true, catastrophic: 'uncertain' }]]);

  test('is refused when the exec tool runs without the gate in front of it', async () => {
    expect((await guardExecCommand('./maybe-wipe.sh')).allowed).toBe(false);
  });

  test('runs when the gate read it (the gate already sent it to the owner at critical stakes)', async () => {
    const reading = await readToolCall({ toolName: 'exec', args: { command: './maybe-wipe.sh' }, askObfuscated: true });
    expect(reading.boundary.catastrophic).toBe('uncertain');
    expect(reading.stakes).toBe('critical');
    expect((await guardExecCommand('./maybe-wipe.sh')).allowed).toBe(true);
  });
});

describe('exec guard: AST parsing', () => {
  useGateReadings();

  test('a fresh feature-flag manager has AST parsing on, and the guard reports it', async () => {
    const mgr = createFeatureFlagManager();
    expect(mgr.isEnabled('shell-ast-normalization')).toBe(true);
    const result = await guardExecCommand('kill -TERM 12345', mgr);
    expect(result.astModeActive).toBe(true);
    expect(result.allowed).toBe(true);
    mgr.disable('shell-ast-normalization');
    expect((await guardExecCommand('kill -TERM 12345', mgr)).astModeActive).toBe(false);
  });

  test('a malformed command never throws and returns a decision', async () => {
    const result = await guardExecCommand("echo 'unterminated", flags(['shell-ast-normalization']));
    expect(typeof result.allowed).toBe('boolean');
  });

  test('a command with no runnable segment is refused', async () => {
    const result = await guardExecCommand('  ', flags(['shell-ast-normalization']));
    expect(result.allowed).toBe(false);
  });
});
