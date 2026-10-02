import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerSubscriptionRuntimeCommands } from '../../input/commands/subscription-runtime.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeContext(out: string[], root: string): CommandContext {
  const shellPaths = {
    workingDirectory: root,
    homeDirectory: root,
    resolveProjectPath: (...parts: string[]) => join(root, '.goodvibes', ...parts),
    resolveUserPath: (...parts: string[]) => join(root, '.goodvibes', ...parts),
    resolveWorkspacePath: (...parts: string[]) => join(root, ...parts),
    isWithinWorkingDirectory: (path: string) => path.startsWith(root),
  };
  const subscriptions: Record<string, unknown> = {};
  const serviceRegistryStore: { get: (p: string) => unknown; getAll: () => Record<string, unknown> } = {
    getAll: () => ({}),
    get: () => undefined,
  };
  return {
    print: (text: string) => out.push(text),
    platform: {
      configManager: {} as never,
      subscriptionManager: {
        list: () => [],
        get: (p: string) => subscriptions[p],
        getPending: () => undefined,
        savePending: () => {},
        saveSubscription: (s: unknown) => s,
        logout: () => false,
        listPending: () => [],
        beginOAuthLogin: async () => ({ pending: { state: 'st' }, authorizationUrl: 'http://example.com/auth' }),
        completeOAuthLogin: async () => { throw new Error('token exchange failed'); },
      },
      secretsManager: { list: async () => [] },
      serviceRegistry: serviceRegistryStore,
    },
    workspace: { shellPaths } as never,
    session: {} as never,
    provider: {} as never,
    ops: {} as never,
    extensions: {} as never,
    _serviceRegistryStore: serviceRegistryStore,
  } as unknown as CommandContext;
}

describe('subscription runtime command', () => {
  test('bundle inspect with bad path prints contextual error instead of throwing', async () => {
    const root = makeProjectTempDir('gv-sub');
    const registry = new CommandRegistry();
    registerSubscriptionRuntimeCommands(registry);
    const out: string[] = [];
    const ctx = makeContext(out, root);

    await registry.get('subscription')!.handler(['bundle', 'inspect', 'nonexistent.json'], ctx);

    const text = out.join('\n');
    expect(text).toContain('Could not read that bundle file:');
  });

  test('completeOAuthLogin failure prints contextual error', async () => {
    const root = makeProjectTempDir('gv-sub');
    const registry = new CommandRegistry();
    registerSubscriptionRuntimeCommands(registry);
    const out: string[] = [];
    const ctx = makeContext(out, root);
    // Provide a fake service with oauth config so we reach completeOAuthLogin
    (ctx.platform as never as { serviceRegistry: { get: (p: string) => unknown; getAll: () => Record<string, unknown> } }).serviceRegistry = {
      getAll: () => ({}),
      get: () => ({
        name: 'myprovider',
        authType: 'oauth',
        oauth: {
          authUrl: 'https://auth.example.com',
          tokenUrl: 'https://token.example.com',
          clientId: 'cid',
          redirectUri: 'http://127.0.0.1/callback',
          scopes: [],
        },
      }),
    } as never;

    await registry.get('subscription')!.handler(
      ['login', 'myprovider', 'finish', 'somecode', '--yes'],
      ctx,
    );

    const text = out.join('\n');
    expect(text).toContain('Could not complete OAuth login for myprovider');
    expect(text).toContain('token exchange failed');
  });

  test('bundle export success receipt includes token privacy warning', async () => {
    const root = makeProjectTempDir('gv-sub');
    const registry = new CommandRegistry();
    registerSubscriptionRuntimeCommands(registry);
    const out: string[] = [];
    const ctx = makeContext(out, root);

    await registry.get('subscription')!.handler(['bundle', 'export', 'out.json', '--yes'], ctx);

    const text = out.join('\n');
    expect(text).toContain('Subscription bundle exported to');
    expect(text).toContain('This file contains active sign-in tokens. Keep it private and delete it after use.');
  });

  test('fallback usage string does not advertise [--manual]', async () => {
    const root = makeProjectTempDir('gv-sub');
    const registry = new CommandRegistry();
    registerSubscriptionRuntimeCommands(registry);
    const out: string[] = [];
    const ctx = makeContext(out, root);

    await registry.get('subscription')!.handler(['unknown-subcmd'], ctx);

    const text = out.join('\n');
    expect(text).not.toContain('--manual');
    expect(text).toContain('/subscription');
  });
});
