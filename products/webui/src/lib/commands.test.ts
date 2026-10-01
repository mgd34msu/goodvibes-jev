import { describe, expect, test, beforeEach } from 'bun:test';
import {
  registerCommand,
  unregisterCommand,
  getCommands,
  filterCommands,
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
// filterCommands
// ---------------------------------------------------------------------------

describe('filterCommands', () => {
  const commands: CommandDef[] = [
    makeCmd({ id: 'nav.chat', title: 'Go to Chat', group: 'navigation', keywords: ['chat', 'messages'] }),
    makeCmd({ id: 'nav.knowledge', title: 'Go to Knowledge', group: 'navigation', keywords: ['knowledge', 'wiki'] }),
    makeCmd({ id: 'nav.providers', title: 'Go to Providers', group: 'navigation', keywords: ['providers', 'models', 'llm'] }),
    makeCmd({ id: 'chat.new', title: 'New Chat', group: 'chat', keywords: ['new', 'create', 'session'] }),
    makeCmd({ id: 'system.palette', title: 'Open Command Palette', group: 'system', keywords: ['command', 'palette'] }),
  ];

  test('empty query returns all commands unchanged', () => {
    expect(filterCommands(commands, '')).toHaveLength(commands.length);
  });

  test('whitespace-only query returns all commands', () => {
    expect(filterCommands(commands, '   ')).toHaveLength(commands.length);
  });

  test('exact title prefix match scores highest (first result)', () => {
    const results = filterCommands(commands, 'new');
    expect(results[0].id).toBe('chat.new');
  });

  test('title prefix match ranks above keyword match', () => {
    // "go" is a prefix in title "Go to Chat" (score 0) vs keyword "knowledge" which includes "go" nowhere
    const results = filterCommands(commands, 'go');
    expect(results.every((c) => c.title.toLowerCase().startsWith('go'))).toBe(true);
  });

  test('keyword prefix match returns relevant commands', () => {
    const results = filterCommands(commands, 'llm');
    expect(results.map((c) => c.id)).toContain('nav.providers');
  });

  test('substring match in title is included', () => {
    const results = filterCommands(commands, 'palette');
    expect(results.map((c) => c.id)).toContain('system.palette');
  });

  test('group substring match returns commands in that group', () => {
    const results = filterCommands(commands, 'navigation');
    expect(results.every((c) => c.group === 'navigation')).toBe(true);
  });

  test('fuzzy match on title: "nwcht" matches "New Chat"', () => {
    const results = filterCommands(commands, 'nwcht');
    expect(results.map((c) => c.id)).toContain('chat.new');
  });

  test('no match returns empty array', () => {
    expect(filterCommands(commands, 'zzznomatch')).toHaveLength(0);
  });

  test('matching ignores query case', () => {
    expect(filterCommands(commands, 'CHAT')).toEqual(filterCommands(commands, 'chat'));
  });

  test('results are ordered by match quality: keyword prefix, then title substring, then group', () => {
    // 'chat': nav.chat has the keyword 'chat' (score 1); nav.knowledge and nav.providers
    // do not match at all; chat.new has 'chat' inside its title (2); system.palette only
    // matches through the 'chat' group? No, its group is 'system', so it falls to fuzzy
    // ('chat' is not a subsequence of 'open command palette') and is excluded.
    expect(filterCommands(commands, 'chat').map((c) => c.id)).toEqual(['nav.chat', 'chat.new']);
  });
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
