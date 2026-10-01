import { describe, expect, test, beforeEach } from 'bun:test';
import {
  registerCommand,
  unregisterCommand,
  getCommands,
  type CommandDef,
} from './commands';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCmd(overrides: Partial<CommandDef> & { id: string }): CommandDef {
  return {
    title: overrides.id,
    group: 'system',
    run: () => undefined,
    ...overrides,
  };
}

// Clean registry between tests
beforeEach(() => {
  // Unregister any test commands that may have leaked from a previous test.
  // This is safe, unregistering a non-existent id is a no-op.
  for (const cmd of getCommands()) {
    unregisterCommand(cmd.id);
  }
});

// ---------------------------------------------------------------------------
// registerCommand / unregisterCommand / getCommands
// ---------------------------------------------------------------------------

describe('registerCommand', () => {
  test('registers a command and it appears in getCommands()', () => {
    registerCommand(makeCmd({ id: 'test.cmd', title: 'Test Command' }));
    const ids = getCommands().map((c) => c.id);
    expect(ids).toContain('test.cmd');
  });

  test('re-registering same id replaces the command', () => {
    registerCommand(makeCmd({ id: 'test.dup', title: 'First' }));
    registerCommand(makeCmd({ id: 'test.dup', title: 'Second' }));
    const cmds = getCommands().filter((c) => c.id === 'test.dup');
    expect(cmds).toHaveLength(1);
    expect(cmds[0].title).toBe('Second');
  });

  test('unregisterCommand removes the command', () => {
    registerCommand(makeCmd({ id: 'test.remove' }));
    unregisterCommand('test.remove');
    const ids = getCommands().map((c) => c.id);
    expect(ids).not.toContain('test.remove');
  });

  test('getCommands returns commands sorted by group then title', () => {
    registerCommand(makeCmd({ id: 'b.cmd', title: 'B', group: 'navigation' }));
    registerCommand(makeCmd({ id: 'a.cmd', title: 'A', group: 'navigation' }));
    registerCommand(makeCmd({ id: 'c.cmd', title: 'C', group: 'chat' }));
    const sorted = getCommands();
    // chat < navigation alphabetically
    const groups = sorted.map((c) => c.group);
    const chatIdx = groups.indexOf('chat');
    const navIdx = groups.indexOf('navigation');
    expect(chatIdx).toBeLessThan(navIdx);
    // Within navigation, A comes before B
    const navCmds = sorted.filter((c) => c.group === 'navigation');
    expect(navCmds[0].title).toBe('A');
    expect(navCmds[1].title).toBe('B');
  });
});
