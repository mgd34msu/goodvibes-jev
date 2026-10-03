import { describe, expect, test } from 'bun:test';
import { handleTasks } from '../../cli/management-commands.ts';
import type { CliCommandRuntime } from '../../cli/management.ts';
import { parseGoodVibesCli } from '../../cli/parser.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeRuntime(args: readonly string[]): CliCommandRuntime {
  return {
    cli: parseGoodVibesCli(['tasks', ...args]),
    configManager: {} as CliCommandRuntime['configManager'],
    workingDirectory: join(tmpdir(), 'goodvibes-agent-workspace'),
    homeDirectory: join(tmpdir(), 'goodvibes-agent-home'),
  };
}

describe('CLI tasks command', () => {
  test('blocks copied submit path instead of starting a one-off task run', async () => {
    const output = await handleTasks(makeRuntime(['submit', 'summarize', 'today']));

    expect(output).toContain('blocks CLI task submission');
    expect(output).toContain('goodvibes-agent run <prompt>');
    expect(output).toContain('goodvibes-agent delegate <task>');
    expect(output).toContain('no local task was started');
  });
});
