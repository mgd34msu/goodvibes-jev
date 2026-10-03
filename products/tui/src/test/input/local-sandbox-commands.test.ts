import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { SandboxSessionRegistry } from '@goodvibes-jev/engine/sdk/platform/runtime/sandbox';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerLocalSetupCommands } from '../../input/commands/local-setup.ts';
import { registerPlatformSandboxRuntimeCommands } from '../../input/commands/platform-sandbox-runtime.ts';

// Exercise the command adapters with public SDK config/session objects and
// synthetic service/read-model data. No full runtime, providers or daemons.
describe('local sandbox and setup commands', () => {
  let root: string;
  let config: ConfigManager;
  let sessions: SandboxSessionRegistry;
  let registry: CommandRegistry;
  let ctx: CommandContext;
  let output: string[];
  const run = async (name: string, args: string[]) => {
    output.length = 0;
    await registry.get(name)!.handler(args, ctx);
    return output.join('\n');
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-local-sandbox-'));
    config = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, homeDir: root, configDir: join(root, 'config') });
    sessions = new SandboxSessionRegistry(root);
    registry = new CommandRegistry();
    registerPlatformSandboxRuntimeCommands(registry);
    registerLocalSetupCommands(registry);
    output = [];
    ctx = {
      print: (text: string) => output.push(text),
      openModal: () => {},
      session: { runtime: { sessionId: 'synthetic-session' } },
      platform: {
        configManager: config,
        serviceRegistry: { getAll: () => ({}), inspect: async () => null },
        subscriptionManager: { list: () => [], listPending: () => [] },
        readModels: { security: { getSnapshot: () => ({ plugins: [], mcpServers: [] }) } },
      },
      clients: { providerApi: { listModels: async () => [] } },
      ops: {},
      workspace: {
        sandboxSessionRegistry: sessions,
        shellPaths: {
          workingDirectory: root,
          homeDirectory: root,
          resolveWorkspacePath: (path: string) => resolve(root, path),
          resolveProjectPath: (...parts: string[]) => join(root, '.goodvibes', ...parts),
          resolveUserPath: (...parts: string[]) => join(root, '.goodvibes', ...parts),
        },
      },
    } as unknown as CommandContext;
  });

  afterEach(() => {
    config.stopWatchingConfigFiles();
    rmSync(root, { recursive: true, force: true });
  });

  test('review, profiles, recommendations, presets and doctor survive the local port', async () => {
    expect(await run('sandbox', ['review'])).toContain('resolved backend: local');
    expect(await run('sandbox', ['profiles'])).toContain('eval-py');
    expect(await run('sandbox', ['recommend'])).toContain('Sandbox Recommendation');
    expect(await run('sandbox', ['presets'])).toContain('secure-balanced');
    expect(await run('sandbox', ['preset', 'secure-isolated'])).toContain('host-local processes; no VM guest');
    expect(await run('sandbox', ['doctor'])).toContain('backend: local');
    const probe = await run('sandbox', ['probe']);
    expect(probe).toContain('backend: local');
    expect(probe).toContain('next: /sandbox doctor');
  });

  test('presets write only supported keys and invalid setting values leave config alone', async () => {
    const set = spyOn(config, 'setDynamic');
    try {
      expect(await run('sandbox', ['apply-preset', 'secure-isolated'])).toContain('Applied sandbox preset');
      expect(set.mock.calls.map(([key]) => key)).toEqual([
        'sandbox.replIsolation', 'sandbox.mcpIsolation', 'sandbox.windowsMode', 'sandbox.vmBackend',
      ]);
      expect(config.get('sandbox.vmBackend')).toBe('local');
      expect(config.get('sandbox.mcpIsolation')).toBe('per-server-vm');
      set.mockClear();
      for (const args of [['apply-preset', 'unknown'], ['set-backend', 'qemu'], ['set-repl', 'invalid'], ['set-mcp', 'invalid'], ['set-windows', 'invalid']]) {
        expect(await run('sandbox', args)).toContain('Usage:');
      }
      expect(set).not.toHaveBeenCalled();
      await run('sandbox', ['set-mcp', 'disabled']);
      await run('sandbox', ['set-repl', 'shared-vm']);
      await run('sandbox', ['set-windows', 'native-basic']);
      await run('sandbox', ['set-backend', 'local']);
      expect(config.get('sandbox.mcpIsolation')).toBe('disabled');
      expect(config.get('sandbox.replIsolation')).toBe('shared-vm');
      expect(config.get('sandbox.windowsMode')).toBe('native-basic');
    } finally {
      set.mockRestore();
    }
  });

  test('old QEMU invocations report retirement without writing settings or files', async () => {
    const set = spyOn(config, 'setDynamic');
    try {
      for (const sub of ['qemu', 'init-qemu', 'scaffold-qemu-wrapper', 'wrapper-test', 'guest-test', 'guest-bundle', 'set-qemu-binary', 'set-qemu-image', 'set-qemu-wrapper', 'set-qemu-guest-host', 'set-qemu-guest-port', 'set-qemu-guest-user', 'set-qemu-workspace', 'set-qemu-session-mode']) {
        expect(await run('sandbox', [sub, 'setup', 'retired-output'])).toContain('QEMU sandbox commands have been retired');
      }
      expect(set).not.toHaveBeenCalled();
      expect(existsSync(join(root, 'retired-output'))).toBe(false);
      expect(registry.get('sandbox')!.usage).not.toContain('qemu');
    } finally {
      set.mockRestore();
    }
  });

  test('sandbox bundle export/inspect round trips and malformed requests are handled', async () => {
    expect(await run('sandbox', ['bundle', 'export', 'bundle/review.json'])).toContain('Sandbox bundle exported');
    const bundle = JSON.parse(readFileSync(join(root, 'bundle/review.json'), 'utf8'));
    expect(bundle.review.reviewText).toContain('resolved backend: local');
    expect(await run('sandbox', ['bundle', 'inspect', 'bundle/review.json'])).toContain('Sandbox Bundle Review');
    for (const args of [['bundle'], ['bundle', 'unknown'], ['bundle', 'export'], ['bundle', 'inspect']]) {
      expect(await run('sandbox', args)).toContain('Usage: /sandbox bundle');
    }
    writeFileSync(join(root, 'bad.json'), '{');
    expect(await run('sandbox', ['bundle', 'inspect', 'bad.json'])).toContain('Failed to inspect sandbox bundle');
  });

  test('sessions start, inspect, execute with current options, export and stop through the public registry', async () => {
    expect(await run('sandbox', ['session', 'start', 'eval-py', 'Local', 'evaluation'])).toContain('Started sandbox session');
    const session = sessions.list()[0]!;
    expect(session.backend).toBe('local');
    expect(session.state).toBe('running');
    expect(session.label).toBe('Local evaluation');
    expect(await run('sandbox', ['session', 'list'])).toContain(session.id);
    expect(await run('sandbox', ['session', 'inspect', session.id])).toContain('profile: eval-py');
    const execute = spyOn(sessions, 'execute');
    try {
      expect(await run('sandbox', ['session', 'run', session.id, 'bash', '-lc', 'printf local-session-ok'])).toContain('stdout: local-session-ok');
      expect(execute).toHaveBeenCalledWith(session.id, 'bash', ['-lc', 'printf local-session-ok'], { timeoutMs: 10000 });
    } finally {
      execute.mockRestore();
    }
    expect(await run('sandbox', ['session', 'artifact', 'export', session.id, 'session.json'])).toContain('artifact exported');
    expect(await run('sandbox', ['session', 'artifact', 'inspect', 'session.json'])).toContain('Sandbox Session Artifact');
    expect(await run('sandbox', ['session', 'stop', session.id])).toContain(`Stopped sandbox session ${session.id}`);
    expect(sessions.get(session.id)?.state).toBe('stopped');
    expect(await run('sandbox', ['session', 'start', 'invalid'])).toContain('Usage:');
    expect(await run('sandbox', ['session', 'run', 'missing', 'bash'])).toContain('Unknown sandbox session');
  });

  test('setup review and support bundles retain useful local state without QEMU scaffolds', async () => {
    expect(await run('setup', ['review'])).toContain('sandbox backend: local');
    const sandboxReview = await run('setup', ['sandbox']);
    expect(sandboxReview).toContain('host-local processes; no VM guest');
    expect(sandboxReview).toContain('/sandbox doctor');
    expect(sandboxReview).not.toContain('qemu');
    expect(await run('setup', ['doctor'])).toContain('local backend:');
    expect(await run('setup', ['support-bundle', 'support'])).toContain('Exported support bundle');
    expect(existsSync(join(root, 'support/startup-review.json'))).toBe(true);
    expect(existsSync(join(root, 'support/remote-summary.json'))).toBe(true);
    expect(existsSync(join(root, 'support/qemu-wrapper.template.sh'))).toBe(false);
  });
});
