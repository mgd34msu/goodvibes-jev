import { describe, expect, test } from 'bun:test';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';

const hiddenCopiedBreadthCommands = [
  'bridge',
  'cockpit',
  'communication',
  'control-plane',
  'controlplane',
  'cp',
  'daemon',
  'deeplink',
  'forensics',
  'guidance',
  'handoff',
  'helpers',
  'hooks',
  'incident',
  'incident-review',
  'install',
  'managed',
  'marketplace',
  'memory-review',
  'memory-sync',
  'ops',
  'orchestration',
  'policy',
  'plugin',
  'profiles',
  'profilesync',
  'recall',
  'remote',
  'remote-env',
  'remote-setup',
  'replay',
  'scan',
  'serve',
  'server',
  'service',
  'services',
  'surface',
  'surfaces',
  'session-memory',
  'settingssync',
  'share',
  'storage',
  'team-memory',
  'teleport',
  'template',
  'tools',
  'tunnel',
  // 'update' left this list when the Agent shipped its own real self-update
  // (/update check|apply|rollback over the SDK's verified swap path), it is
  // a first-class Agent command now, not a copied TUI surface.
  'web',
  'webhook',
  'worker-pool',
] as const;

const visibleAgentBreadthCommands = [
  'agent',
  'agent-profile',
  'approval',
  'automation',
  'auth',
  'brief',
  'health',
  'knowledge',
  'mcp',
  'memory',
  'notify',
  'personas',
  'provider',
  'qrcode',
  'routines',
  'schedule',
  'secrets',
  'security',
  'skills',
  'setup',
  'subscription',
  'tasks',
  'trust',
  'voice',
] as const;

describe('product breadth commands', () => {
  test('does not expose copied TUI breadth commands as Agent product workflows', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);

    for (const commandName of hiddenCopiedBreadthCommands) {
      expect(registry.get(commandName)).toBeUndefined();
    }
  });

  test('keeps Agent operator breadth commands visible', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);

    for (const commandName of visibleAgentBreadthCommands) {
      expect(registry.get(commandName)?.name).toBe(commandName);
    }

    expect(registry.get('agent-skills')?.name).toBe('skills');
    expect(registry.get('policy')).toBeUndefined();
    expect(registry.get('recall')).toBeUndefined();
  });
});
