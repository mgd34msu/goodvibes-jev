import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { handleGoodVibesCliCommand, parseGoodVibesCli } from '../../cli/index.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { createWorkspaceRegistrationStore } from '../../config/workspace-registration.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

async function runWorkspacesCli(args: readonly string[], workingDirectory: string, homeDirectory: string) {
  const output: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (value?: unknown) => { output.push(String(value)); };
    const result = await handleGoodVibesCliCommand({
      cli: parseGoodVibesCli(args),
      configManager: new ConfigManager({ workingDir: workingDirectory, homeDir: homeDirectory, surfaceRoot: 'agent' }),
      workingDirectory,
      homeDirectory,
    });
    return { result, output: output.join('\n') };
  } finally {
    console.log = originalLog;
  }
}

describe('workspaces CLI command', () => {
  test('parses the workspaces command and its aliases', () => {
    expect(parseGoodVibesCli(['workspaces', 'list']).command).toBe('workspaces');
    expect(parseGoodVibesCli(['workspace', 'list']).command).toBe('workspaces');
  });

  test('list reports no registered workspaces by default', async () => {
    const home = makeProjectTempDir('goodvibes-agent-workspaces-cli');
    const work = makeProjectTempDir('goodvibes-agent-workspaces-cli-work');

    const { result, output } = await runWorkspacesCli(['workspaces', 'list'], work, home);
    expect(result.exitCode).toBe(0);
    expect(output).toContain('No registered workspaces');
    expect(output).toContain('registered no');
  });

  test('register refuses without --yes, then registers and shows up in list', async () => {
    const home = makeProjectTempDir('goodvibes-agent-workspaces-cli');
    const work = makeProjectTempDir('goodvibes-agent-workspaces-cli-work');

    const refused = await runWorkspacesCli(['workspaces', 'register'], work, home);
    expect(refused.result.exitCode).toBe(2);
    expect(refused.output).toContain('without --yes');

    const registered = await runWorkspacesCli(['workspaces', 'register', '--yes'], work, home);
    expect(registered.result.exitCode).toBe(0);
    expect(registered.output).toContain('Workspace registered');

    const shellPaths = createShellPathService({ workingDirectory: work, homeDirectory: home });
    const store = createWorkspaceRegistrationStore(shellPaths);
    expect((await store.resolve(work)).status).toBe('covered');

    const listed = await runWorkspacesCli(['workspaces', 'list'], work, home);
    expect(listed.output).toContain(work);
    expect(listed.output).toContain('registered yes');
  });

  test('unregister refuses without --yes, then removes the workspace', async () => {
    const home = makeProjectTempDir('goodvibes-agent-workspaces-cli');
    const work = makeProjectTempDir('goodvibes-agent-workspaces-cli-work');

    await runWorkspacesCli(['workspaces', 'register', '--yes'], work, home);

    const refused = await runWorkspacesCli(['workspaces', 'unregister'], work, home);
    expect(refused.result.exitCode).toBe(2);

    const unregistered = await runWorkspacesCli(['workspaces', 'unregister', '--yes'], work, home);
    expect(unregistered.result.exitCode).toBe(0);
    expect(unregistered.output).toContain('unregistered');

    const shellPaths = createShellPathService({ workingDirectory: work, homeDirectory: home });
    const store = createWorkspaceRegistrationStore(shellPaths);
    expect((await store.resolve(work)).status).toBe('unknown');

    const again = await runWorkspacesCli(['workspaces', 'unregister', '--yes'], work, home);
    expect(again.result.exitCode).toBe(1);
    expect(again.output).toContain('was not registered');
  });
});
