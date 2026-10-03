import { describe, expect, test } from 'bun:test';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';

describe('remote command', () => {
  test('is hidden from the Agent slash registry because local/remote coding workers are delegated to GoodVibes TUI', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);

    expect(registry.get('remote')).toBeUndefined();
    expect(registry.get('remote-setup')).toBeUndefined();
    expect(registry.get('remote-env')).toBeUndefined();
    expect(registry.get('teleport')).toBeUndefined();
    expect(registry.get('tunnel')).toBeUndefined();
    expect(registry.get('worker-pool')).toBeUndefined();
  });
});
