import { describe, expect, test } from 'bun:test';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';

const hiddenCopiedOperatorCommands = [
  'cockpit',
  'communication',
  'forensics',
  'hooks',
  'incident',
  'marketplace',
  'ops',
  'orchestration',
  'panel',
  'policy',
  'remote',
  'services',
  'storage',
  'deeplink',
] as const;

const visibleOperatorCommands = [
  'agent',
  'approval',
  'health',
  'knowledge',
  'mcp',
  'provider',
  'security',
  'session',
  'subscription',
  'trust',
] as const;

describe('operator visibility gate', () => {
  test('hides copied operator panels and lifecycle setup from slash-command discovery', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);

    for (const commandName of hiddenCopiedOperatorCommands) {
      expect(registry.get(commandName)).toBeUndefined();
    }
  });

  test('keeps Agent operator commands available', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);

    for (const commandName of visibleOperatorCommands) {
      expect(registry.get(commandName)?.name).toBe(commandName);
    }
  });

});
