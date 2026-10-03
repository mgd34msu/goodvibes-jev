/**
 * The /ci, /principals, and /channel-profiles TUI slash commands are thin
 * bridges onto the same CLI handlers the terminal commands use, these tests
 * prove the bridge end-to-end without a live connected host: the command is
 * registered, dispatches through the real CLI parser + handler, and reports
 * the honest auth_required failure (no operator token on disk) instead of
 * pretending anything succeeded.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerConnectedHostAdminCommands } from '../../input/commands/connected-host-admin-runtime.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeContext(printed: string[]): CommandContext {
  const home = makeProjectTempDir('gv-agent-admin-cmd');
  return {
    print: (text: string) => printed.push(text),
    platform: {
      configManager: { get: () => undefined },
    },
    workspace: {
      shellPaths: {
        homeDirectory: home,
        workingDirectory: home,
      },
    },
  } as unknown as CommandContext;
}

describe('connected-host admin TUI commands', () => {
  const registry = new CommandRegistry();
  registerConnectedHostAdminCommands(registry);

  test('registers ci, principals, and channel-profiles with aliases', () => {
    expect(registry.get('ci')).toBeTruthy();
    expect(registry.get('principals')).toBeTruthy();
    expect(registry.get('principal')).toBeTruthy();
    expect(registry.get('channel-profiles')).toBeTruthy();
    expect(registry.get('channel-profile')).toBeTruthy();
  });

  test('principals list reports auth_required honestly when no operator token exists', async () => {
    const printed: string[] = [];
    await registry.get('principals')!.handler(['list'], makeContext(printed));
    const output = printed.join('\n');
    expect(output.toLowerCase()).toContain('auth_required');
    expect(output).toContain('operator token');
  });

  test('ci with no subcommand prints usage instead of calling the host', async () => {
    const printed: string[] = [];
    await registry.get('ci')!.handler([], makeContext(printed));
    expect(printed.join('\n')).toContain('Usage:');
  });

  test('channel-profiles set refuses without --yes before any network call', async () => {
    const printed: string[] = [];
    await registry.get('channel-profiles')!.handler(['set', 'slack', '--model', 'test-model'], makeContext(printed));
    const output = printed.join('\n');
    expect(output).toContain('--yes');
  });
});
