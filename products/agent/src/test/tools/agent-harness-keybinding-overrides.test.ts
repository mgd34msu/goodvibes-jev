import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CommandContext } from '../../input/command-registry.ts';
import { KeybindingsManager } from '../../input/keybindings.ts';
import { resetHarnessKeybinding, setHarnessKeybinding } from '../../tools/agent-harness-keybinding-metadata.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

interface KeybindingFixture {
  readonly configPath: string;
  readonly manager: KeybindingsManager;
  readonly context: CommandContext;
}

function withKeybindings<T>(fn: (fixture: KeybindingFixture) => T): T {
  const root = makeProjectTempDir('gv-keybinding-overrides');
  const configPath = join(root, 'agent', 'keybindings.json');
  mkdirSync(dirname(configPath), { recursive: true });
  const manager = new KeybindingsManager({ configPath });
  // The keybinding metadata helpers reach only for workspace.keybindingsManager;
  // the cast keeps the fixture to the surface actually exercised here.
  const context = { workspace: { keybindingsManager: manager } } as unknown as CommandContext;
  try {
    return fn({ configPath, manager, context });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function readOverrides(configPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
}

describe('agent harness keybinding override file', () => {
  test('writes an override atomically and leaves no temp file behind', () => {
    withKeybindings(({ configPath, manager, context }) => {
      const result = setHarnessKeybinding(context, { actionId: 'search', combo: { key: 'g', ctrl: true } });

      expect(result.status).toBe('updated');
      expect(readOverrides(configPath).search).toBeDefined();
      expect(manager.matches('search', { logicalName: 'g', ctrl: true })).toBe(true);
      expect(readdirSync(dirname(configPath)).filter((name) => name.endsWith('.tmp'))).toHaveLength(0);
    });
  });

  test('degrades a crash-truncated overrides file to no overrides instead of throwing', () => {
    withKeybindings(({ configPath, context }) => {
      writeFileSync(configPath, '{"search": [{"key": "g", "ctr');

      expect(() => setHarnessKeybinding(context, { actionId: 'search', combo: { key: 'j', ctrl: true } })).not.toThrow();
      expect(readOverrides(configPath)).toEqual({ search: { key: 'j', ctrl: true } });
      // The unreadable file was preserved rather than silently discarded.
      expect(existsSync(`${configPath}.corrupt`)).toBe(true);
    });
  });

  test('degrades a zero-byte overrides file to no overrides', () => {
    withKeybindings(({ configPath, context }) => {
      writeFileSync(configPath, '');

      const result = setHarnessKeybinding(context, { actionId: 'search', combo: { key: 'k', ctrl: true } });
      expect(result.status).toBe('updated');
      expect(readOverrides(configPath)).toEqual({ search: { key: 'k', ctrl: true } });
      // An empty file carries nothing worth preserving, so nothing is quarantined.
      expect(existsSync(`${configPath}.corrupt`)).toBe(false);
    });
  });

  test('degrades an overrides file that is valid JSON but not an object', () => {
    withKeybindings(({ configPath, context }) => {
      writeFileSync(configPath, '["search"]\n');

      expect(() => resetHarnessKeybinding(context, { actionId: 'search' })).not.toThrow();
      expect(readOverrides(configPath)).toEqual({});
      expect(existsSync(`${configPath}.corrupt`)).toBe(true);
    });
  });

  test('keeps unrelated overrides when resetting one action', () => {
    withKeybindings(({ configPath, context }) => {
      setHarnessKeybinding(context, { actionId: 'search', combo: { key: 'g', ctrl: true } });
      setHarnessKeybinding(context, { actionId: 'screen-clear', combo: { key: 'l', ctrl: true } });
      resetHarnessKeybinding(context, { actionId: 'search' });

      const overrides = readOverrides(configPath);
      expect(overrides.search).toBeUndefined();
      expect(overrides['screen-clear']).toBeDefined();
    });
  });
});
