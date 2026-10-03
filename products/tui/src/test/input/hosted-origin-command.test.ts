import { afterEach, expect, mock, test } from 'bun:test';
import type { CommandContext } from '../../input/command-registry.ts';
import { CommandRegistry } from '../../input/command-registry.ts';
import { getSharedHostedSessionFeed, resetSharedHostedSessionFeed } from '../../views/hosted-session-feed.ts';
import type { HostedSessionRecord } from '../../runtime/client/hosted-sessions.ts';

const calls: { methodId: string; input: unknown }[] = [];
const record: HostedSessionRecord = {
  id: 'hosted-origin-command', workspaceRoot: '/tmp/hosted-origin-workspace', title: 'hosted',
  status: 'idle', detachPolicy: null, effectiveDetachPolicy: 'kill', attachedClients: [],
  createdAt: 1, updatedAt: 1, turnCount: 0, messageCount: 0, restoredFromDisk: false, contractIds: [],
};

// Only the transport boundary is replaced. The command and HostedSessionsClient
// both execute, so dropping the origin at either step breaks this assertion.
const endpoint = await import('../../runtime/client/operator-endpoint.ts');
mock.module('../../runtime/client/operator-endpoint.ts', () => ({
  ...endpoint,
  createDaemonVerbCaller: () => ({
    invoke: async (methodId: string, input: unknown) => {
      calls.push({ methodId, input });
      if (methodId === 'sessions.hosted.create') return { session: record };
      if (methodId === 'sessions.hosted.attach') return { session: record, history: [] };
      throw new Error(`Unexpected hosted command verb: ${methodId}`);
    },
  }),
  resolveControlPlaneBaseUrl: () => null,
  resolveDaemonStateDirectory: () => { throw new Error('No token or network is needed'); },
  describeOperatorRpcError: (error: unknown) => String(error),
}));
const { registerHostedRuntimeCommands } = await import('../../input/commands/hosted-runtime.ts');

afterEach(() => {
  calls.length = 0;
  resetSharedHostedSessionFeed();
  mock.restore();
});

test('/hosted new explicitly creates a session for the TUI', async () => {
  const registry = new CommandRegistry();
  registerHostedRuntimeCommands(registry);
  const lines: string[] = [];
  const context = {
    platform: { configManager: {} },
    workspace: { shellPaths: { workingDirectory: record.workspaceRoot, homeDirectory: '/tmp/hosted-origin-home' } },
    print: (line: string) => { lines.push(line); },
  } as unknown as CommandContext;

  await registry.get('hosted')!.handler(['new'], context);

  expect(calls.map((call) => call.methodId)).toEqual(['sessions.hosted.create', 'sessions.hosted.attach']);
  expect(calls[0]!.input).toMatchObject({ workspaceRoot: record.workspaceRoot, originSurface: 'tui' });
  expect(getSharedHostedSessionFeed().getState().record?.id).toBe(record.id);
  expect(lines.join('\n')).toContain('[hosted] created');
});
