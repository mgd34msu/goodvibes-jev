import { describe, expect, test } from 'bun:test';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';

describe('hooks command', () => {
  test('is hidden from the Agent slash registry until hook authoring is redesigned for the Agent product', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);

    expect(registry.get('hooks')).toBeUndefined();
  });
});
