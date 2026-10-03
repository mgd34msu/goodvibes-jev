import { describe, expect, mock, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { registerOperatorRuntimeCommands } from '../../input/commands/operator-runtime.ts';
import { registerSessionContentCommands } from '../../input/commands/session-content.ts';
import { sessionCommand } from '../../input/commands/session.ts';
import type { ShellModeManagerService } from '../../runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeShellPaths(root: string) {
  return {
    workingDirectory: root,
    homeDirectory: root,
    resolveProjectPath: (...parts: string[]) => join(root, '.goodvibes', ...parts),
    resolveUserPath: (...parts: string[]) => join(root, '.goodvibes', ...parts),
    resolveWorkspacePath: (...parts: string[]) => resolve(root, ...parts),
    isWithinWorkingDirectory: (path: string) => path.startsWith(root),
  };
}

function baseContext(root: string, out: string[]): CommandContext {
  return {
    session: {} as never,
    provider: {} as never,
    workspace: { shellPaths: makeShellPaths(root) } as never,
    platform: {} as never,
    ops: {} as never,
    extensions: {} as never,
    renderRequest: () => {},
    print: (text: string) => out.push(text),
    exit: () => {},
  } as CommandContext;
}

describe('write/export command confirmation', () => {
  test('conversation export requires --yes before writing a transcript file', async () => {
    const root = makeProjectTempDir('gv-export-confirm');
    try {
      const registry = new CommandRegistry();
      registerSessionContentCommands(registry);
      const out: string[] = [];
      const ctx = {
        ...baseContext(root, out),
        session: {
          conversationManager: {
            title: 'Exported Session',
            toJSON: () => ({ messages: [{ role: 'user', content: 'hello' }] }),
          },
          runtime: {
            model: 'gpt-test',
            provider: 'provider-test',
            sessionId: 'session-export-test',
          },
        },
      } as unknown as CommandContext;
      const target = join(root, 'conversation.md');

      await registry.get('export')!.handler([target], ctx);
      expect(existsSync(target)).toBe(false);
      expect(out.join('\n')).toContain('Refusing to export conversation');

      out.length = 0;
      await registry.get('export')!.handler([target, '--yes'], ctx);
      expect(existsSync(target)).toBe(true);
      expect(readFileSync(target, 'utf-8')).toContain('hello');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('session delete requires --yes and copied conversation-pinned memory command is not registered', async () => {
    const root = makeProjectTempDir('gv-delete-confirm');
    try {
      const registry = new CommandRegistry();
      registry.register(sessionCommand);
      registerSessionContentCommands(registry);
      const out: string[] = [];
      let deletedSession = '';
      const ctx = {
        ...baseContext(root, out),
        session: {
          runtime: {
            sessionId: 'active-session',
            model: 'gpt-test',
            provider: 'provider-test',
          },
          sessionManager: {
            list: () => [{
              name: 'saved-session',
              title: 'Saved Session',
              timestamp: Date.now(),
              messageCount: 1,
              filePath: join(root, 'saved-session.jsonl'),
            }],
            delete: (name: string) => {
              deletedSession = name;
            },
          },
          conversationManager: {},
        },
      } as unknown as CommandContext;

      await registry.get('session')!.handler(['delete', 'saved-session'], ctx);
      expect(deletedSession).toBe('');
      expect(out.join('\n')).toContain('Refusing to delete saved session saved-session without --yes');

      out.length = 0;
      await registry.get('session')!.handler(['delete', 'saved-session', '--yes'], ctx);
      expect(deletedSession).toBe('saved-session');
      expect(registry.get('session-memory')).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('copied prompt template write command is not registered in Agent', () => {
    const registry = new CommandRegistry();
    registerSessionContentCommands(registry);
    expect(registry.get('template')).toBeUndefined();
  });

  test('copied config profile save and delete commands are disabled in Agent', () => {
    const registry = new CommandRegistry();
    registerOperatorRuntimeCommands(registry);
    expect(registry.get('profiles')).toBeUndefined();
  });

  test('/settings list parses valued flags without swallowing later flags', async () => {
    const root = makeProjectTempDir('gv-settings-list-flags');
    try {
      const registry = new CommandRegistry();
      registerOperatorRuntimeCommands(registry);
      const out: string[] = [];
      const configManager = new ConfigManager({
        surfaceRoot: 'agent',
        workingDir: root,
        homeDir: root,
        configDir: join(root, '.goodvibes', 'agent'),
      });
      const ctx = {
        ...baseContext(root, out),
        platform: { configManager },
      } as unknown as CommandContext;

      // Both flags parsed: one row printed (--limit), all of them under
      // `provider.` (--category). The header names the settings the limit left
      // out, so it reads `Settings (1 of N ...)` rather than a bare count.
      await registry.get('settings')!.handler(['list', '--category=provider', '--limit=1'], ctx);
      expect(out.join('\n')).toMatch(/^Settings \(1 of \d+,/m);
      expect(out.join('\n')).toContain('this page is short');
      expect(out.join('\n')).toContain('provider.');

      out.length = 0;
      await registry.get('settings')!.handler(['list', '--category', '--limit', '1'], ctx);
      expect(out.join('\n')).toMatch(/^Settings \(1 of \d+,/m);
      expect(out.join('\n')).not.toContain('No settings matched.');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('mode preset and domain overrides require --yes before writing interaction state', async () => {
    const root = makeProjectTempDir('gv-mode-confirm');
    try {
      const registry = new CommandRegistry();
      registerOperatorRuntimeCommands(registry);
      const out: string[] = [];
      const setMode = mock((mode: Parameters<ShellModeManagerService['setHITLMode']>[0]) => mode);
      const setDomainVerbosity = mock((
        domain: Parameters<ShellModeManagerService['setDomainVerbosity']>[0],
        verbosity: Parameters<ShellModeManagerService['setDomainVerbosity']>[1],
      ) => `${domain}:${verbosity}`);
      const preset: ReturnType<ShellModeManagerService['getHITLPreset']> = {
        name: 'balanced',
        description: 'Balanced interaction mode',
        defaultDomainVerbosity: 'normal',
        quietWhileTyping: true,
        batchWindowMs: 500,
      };
      const modeManager: ShellModeManagerService = {
        getHITLMode: () => 'balanced',
        getHITLPreset: () => preset,
        listHITLPresets: () => [preset],
        setHITLMode: setMode,
        setDomainVerbosity,
        getDomainOverrides: () => ({}),
      };
      const configManager = new ConfigManager({
        surfaceRoot: 'agent',
        workingDir: root,
        homeDir: root,
        configDir: join(root, '.goodvibes', 'agent'),
      });
      const ctx = {
        ...baseContext(root, out),
        platform: { configManager },
        ops: { modeManager },
      } as unknown as CommandContext;

      await registry.get('mode')!.handler(['quiet'], ctx);
      expect(setMode).toHaveBeenCalledTimes(0);
      expect(out.join('\n')).toContain('Refusing to set HITL mode to quiet without --yes');

      out.length = 0;
      await registry.get('mode')!.handler(['quiet', '--yes'], ctx);
      expect(setMode).toHaveBeenCalledWith('quiet');
      expect(out.join('\n')).toContain('HITL mode set to: balanced');

      out.length = 0;
      await registry.get('mode')!.handler(['set-domain', 'automation', 'minimal'], ctx);
      expect(setDomainVerbosity).toHaveBeenCalledTimes(0);
      expect(out.join('\n')).toContain('Refusing to set HITL verbosity for automation without --yes');

      out.length = 0;
      await registry.get('mode')!.handler(['set-domain', 'automation', 'minimal', '--yes'], ctx);
      expect(setDomainVerbosity).toHaveBeenCalledWith('automation', 'minimal');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
