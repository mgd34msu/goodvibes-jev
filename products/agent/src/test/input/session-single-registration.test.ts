// ---------------------------------------------------------------------------
// session-single-registration.test.ts
//
// Regression guard for the /session shadow bug (coherence audit E8 worst
// instance): /session was registered TWICE, once by
// registerSessionWorkflowCommands and once by the fuller sessionCommand
// (commands/session.ts), and the registry silently overwrote, so which one
// won depended on registration order. Two guarantees now hold:
//   1. registerBuiltinCommands registers exactly ONE /session command, and it
//      is the fuller one (graph inspection + delegation to the workflow handler).
//   2. CommandRegistry.register is LOUD: a duplicate primary name or a shadowing
//      alias throws instead of silently overwriting.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';

describe('/session single honest registration', () => {
  test('registerBuiltinCommands registers exactly one /session command', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const sessions = registry.getAll().filter((c) => c.name === 'session');
    expect(sessions.length).toBe(1);
  });

  test('the surviving /session is the fuller command (graph inspection + sess alias)', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const session = registry.get('session');
    expect(session).toBeDefined();
    // The fuller sessionCommand (commands/session.ts), not the workflow stub,
    // owns the read-only cross-session graph inspection surface.
    expect(session?.description).toContain('graph inspection');
    expect(session?.aliases).toContain('sess');
    // Its alias resolves to the same command instance.
    expect(registry.get('sess')).toBe(session);
  });
});

describe('CommandRegistry loud collisions', () => {
  const noop = async (): Promise<void> => {};

  test('a second command with the same primary name throws', () => {
    const registry = new CommandRegistry();
    registry.register({ name: 'dup', description: 'first', handler: noop });
    expect(() => registry.register({ name: 'dup', description: 'second', handler: noop })).toThrow(/collision/);
  });

  test('an alias that shadows an existing command name throws', () => {
    const registry = new CommandRegistry();
    registry.register({ name: 'keybindings', description: 'kb', aliases: ['kb'], handler: noop });
    expect(() => registry.register({ name: 'knowledge', description: 'kb', aliases: ['kb'], handler: noop })).toThrow(/alias collision/);
  });

  test('an alias that shadows another command\'s alias throws', () => {
    const registry = new CommandRegistry();
    registry.register({ name: 'alpha', description: 'a', aliases: ['x'], handler: noop });
    expect(() => registry.register({ name: 'beta', description: 'b', aliases: ['x'], handler: noop })).toThrow(/alias collision/);
  });
});
