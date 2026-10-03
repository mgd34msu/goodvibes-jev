import { describe, expect, test } from 'bun:test';
import type { CommandContext } from '../../input/command-registry.ts';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';

const hiddenCopiedCommands = [
  'bootstrap',
  'branch',
  'bridge',
  'cockpit',
  'communication',
  'control-plane',
  'controlplane',
  'cp',
  'daemon',
  'deeplink',
  'forensics',
  'fork',
  'guidance',
  'handoff',
  'helpers',
  'hooks',
  'incident',
  'incident-review',
  'install',
  'managed',
  'marketplace',
  'merge',
  'memory-review',
  'memory-sync',
  'ops',
  'orchestration',
  'panel',
  'plugin',
  'policy',
  'profiles',
  'profilesync',
  'provider-opt',
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
  'wrfc',
  'wq',
] as const;

const expectedAgentCommands = [
  'accounts',
  'agent',
  'agent-profile',
  'automation',
  'auth',
  'brief',
  'bundle',
  'compat',
  'config',
  'delegate',
  'help',
  'knowledge',
  'memory',
  'model',
  'personas',
  'provider',
  'routines',
  'schedule',
  'secrets',
  'security',
  'sessions',
  'setup',
  'skills',
  'trust',
] as const;

describe('Agent command interface', () => {
  test('hides copied TUI coding/lifecycle/developer commands from the Agent slash registry', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const names = new Set(registry.list().map((command) => command.name));

    for (const commandName of hiddenCopiedCommands) {
      expect(names.has(commandName)).toBe(false);
      expect(registry.get(commandName)).toBeUndefined();
    }
  });

  test('keeps first-class Agent operator commands available', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const names = new Set(registry.list().map((command) => command.name));

    for (const commandName of expectedAgentCommands) {
      expect(names.has(commandName)).toBe(true);
    }
  });

  test('auth command discovery does not advertise runtime service session exchange or duplicate login aliases', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);

    const auth = registry.get('auth');

    expect(registry.get('login')).toBeUndefined();
    expect(registry.get('logout')).toBeUndefined();
    expect(auth?.description).toBe('Review provider auth posture and export redacted auth review bundles');
    expect(auth?.usage).not.toContain('listener');
    expect(auth?.usage).not.toContain('service');
  });

  test('runtime service login paths fail closed in Agent auth commands', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const printed: string[] = [];
    const dispatched: string[] = [];
    const context = {
      print: (message: string) => printed.push(message),
      executeCommand: async (name: string, args: string[]) => {
        dispatched.push([name, ...args].join(' '));
        return true;
      },
    } as unknown as CommandContext;

    await registry.execute('auth', ['login', 'runtime', 'http://127.0.0.1:3421', 'user', 'pass', '--yes'], context);

    expect(dispatched).toEqual([]);
    expect(printed.join('\n')).toContain('Connected-host login is outside GoodVibes Agent.');
    expect(printed.join('\n')).toContain('Use the owning GoodVibes host for connected-host auth administration.');
  });

  test('routes /skills to the Agent-local skills command, not the copied TUI skill-pack command', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);

    expect(registry.get('skills')?.name).toBe('skills');
    expect(registry.get('skill')?.name).toBe('skills');
    expect(registry.get('agent-skills')?.name).toBe('skills');
  });

  test('routes /memory to Agent-local durable memory instead of session-pinned compaction memory', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);

    expect(registry.get('memory')?.description).toContain('Agent-local memory');
    expect(registry.get('memory')?.description).not.toContain('session memories');
    expect(registry.get('mem')?.name).toBe('memory');
    expect(registry.get('recall')).toBeUndefined();
  });

  test('requires explicit confirmation for TUI support bundle write and import commands', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const printed: string[] = [];
    const context = {
      print: (message: string) => printed.push(message),
    } as unknown as CommandContext;

    await registry.execute('bundle', ['export', 'goodvibes-agent-bundle.json'], context);
    await registry.execute('bundle', ['import', 'goodvibes-agent-bundle.json'], context);

    expect(printed.join('\n')).toContain('Refusing to export Agent support bundle without --yes.');
    expect(printed.join('\n')).toContain('Refusing to import Agent support bundle without --yes.');
  });

  test('keeps undo and redo conversation-scoped instead of file-edit scoped', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);

    const undo = registry.get('undo');
    const redo = registry.get('redo');

    expect(undo?.description).toBe('Undo the last conversation turn');
    expect(redo?.description).toBe('Redo the last undone conversation turn');
    expect(`${undo?.description ?? ''} ${undo?.usage ?? ''} ${undo?.argsHint ?? ''}`).not.toContain('file');
    expect(`${redo?.description ?? ''} ${redo?.usage ?? ''} ${redo?.argsHint ?? ''}`).not.toContain('file');
  });

  test('visible Agent command metadata does not advertise copied panel entrypoints', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const checkedCommands = [
      'accounts',
      'approval',
      'health',
      'qrcode',
      'tasks',
    ] as const;

    for (const commandName of checkedCommands) {
      const command = registry.get(commandName);
      const metadata = [
        command?.description ?? '',
        command?.usage ?? '',
        command?.argsHint ?? '',
      ].join('\n');

      expect(metadata.toLowerCase(), commandName).not.toContain('panel');
    }

    expect(registry.get('health')?.usage ?? '').not.toContain('open');
  });
});
