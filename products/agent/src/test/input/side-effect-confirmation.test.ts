import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerLocalRuntimeCommands } from '../../input/commands/local-runtime.ts';
import { registerNotifyRuntimeCommands } from '../../input/commands/notify-runtime.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeShellPaths(root: string) {
  return {
    workingDirectory: root,
    homeDirectory: root,
    resolveProjectPath: (...parts: string[]) => join(root, '.goodvibes', ...parts),
    resolveUserPath: (...parts: string[]) => join(root, '.goodvibes', ...parts),
    resolveWorkspacePath: (...parts: string[]) => join(root, ...parts),
    isWithinWorkingDirectory: (path: string) => path.startsWith(root),
  };
}

interface SideEffectCalls {
  secretDeletes: number;
  secretWrites: number;
  notificationConfigWrites: number;
  notificationUrlWrites: number;
  notificationTests: number;
  notificationSends: number;
}

function makeCalls(): SideEffectCalls {
  return {
    secretDeletes: 0,
    secretWrites: 0,
    notificationConfigWrites: 0,
    notificationUrlWrites: 0,
    notificationTests: 0,
    notificationSends: 0,
  };
}

function makeContext(root: string, out: string[], calls: SideEffectCalls): CommandContext {
  const shellPaths = makeShellPaths(root);
  const configManager = {
    getCategory: () => ({ webhookUrls: ['https://ntfy.sh/goodvibes-agent-test'] }),
    mergeCategory: () => {
      calls.notificationConfigWrites += 1;
    },
  };
  const secretsManager = {
    inspect: async () => ({
      policy: 'encrypted',
      secureKeys: 1,
      plaintextKeys: 0,
      locations: [],
      warnings: [],
    }),
    list: async () => ['OPENAI_API_KEY'],
    listDetailed: async () => [{ key: 'OPENAI_API_KEY', source: 'goodvibes' }],
    set: async () => {
      calls.secretWrites += 1;
    },
    get: async () => null,
    delete: async () => {
      calls.secretDeletes += 1;
    },
  };
  const webhookNotifier = {
    setUrls: () => {
      calls.notificationUrlWrites += 1;
    },
    test: async () => {
      calls.notificationTests += 1;
      return [{ ok: true, url: 'https://ntfy.sh/goodvibes-agent-test' }];
    },
    send: async () => {
      calls.notificationSends += 1;
      return {
        attempted: 1,
        delivered: 1,
        failed: 0,
        results: [{ ok: true, url: 'https://ntfy.sh/goodvibes-agent-test' }],
      };
    },
  };

  return {
    session: {} as never,
    provider: {} as never,
    workspace: { shellPaths } as never,
    platform: {
      configManager,
      secretsManager,
      webhookNotifier,
    } as never,
    ops: {} as never,
    extensions: {} as never,
    renderRequest: () => {},
    print: (text: string) => out.push(text),
    exit: () => {},
  } as CommandContext;
}

describe('side-effecting slash command confirmation', () => {
  test('notify mutation and network test commands require --yes', async () => {
    const root = makeProjectTempDir('gv-side-effects');
    try {
      const registry = new CommandRegistry();
      registerNotifyRuntimeCommands(registry);
      const out: string[] = [];
      const calls = makeCalls();
      const ctx = makeContext(root, out, calls);

      await registry.get('notify')!.handler(['add', 'https://ntfy.sh/new-topic'], ctx);
      await registry.get('notify')!.handler(['remove', 'https://ntfy.sh/goodvibes-agent-test'], ctx);
      await registry.get('notify')!.handler(['clear'], ctx);
      await registry.get('notify')!.handler(['test'], ctx);
      await registry.get('notify')!.handler(['send', 'hello'], ctx);

      expect(calls.notificationConfigWrites).toBe(0);
      expect(calls.notificationUrlWrites).toBe(0);
      expect(calls.notificationTests).toBe(0);
      expect(calls.notificationSends).toBe(0);
      expect(out.join('\n')).toContain('without --yes');

      out.length = 0;
      await registry.get('notify')!.handler(['send', 'hello', '--yes'], ctx);
      expect(calls.notificationUrlWrites).toBe(1);
      expect(calls.notificationSends).toBe(1);
      expect(out.join('\n')).toContain('Notification sent');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('secret set, link, and delete require --yes', async () => {
    const root = makeProjectTempDir('gv-side-effects');
    try {
      const registry = new CommandRegistry();
      registerLocalRuntimeCommands(registry);
      const out: string[] = [];
      const calls = makeCalls();
      const ctx = makeContext(root, out, calls);

      await registry.get('secrets')!.handler(['set', 'OPENAI_API_KEY', 'secret-value'], ctx);
      await registry.get('secrets')!.handler(['link', 'OPENAI_API_KEY', 'goodvibes://secrets/env/OPENAI_API_KEY'], ctx);
      await registry.get('secrets')!.handler(['delete', 'OPENAI_API_KEY'], ctx);

      expect(calls.secretWrites).toBe(0);
      expect(calls.secretDeletes).toBe(0);
      expect(out.join('\n')).toContain('without --yes');

      out.length = 0;
      await registry.get('secrets')!.handler(['link', 'OPENAI_API_KEY', 'goodvibes://secrets/env/OPENAI_API_KEY', '--yes'], ctx);
      await registry.get('secrets')!.handler(['delete', 'OPENAI_API_KEY', '--yes'], ctx);
      expect(calls.secretWrites).toBe(1);
      expect(calls.secretDeletes).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
