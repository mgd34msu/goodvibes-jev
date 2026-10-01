import { describe, expect, test } from 'bun:test';
import type { DaemonWebSocket, DaemonWebSocketFactory } from '@goodvibes-jev/engine/terminal-shell';
import { isSessionsSubcommand, runSessionsCommand } from '../../daemon/sessions-command.js';

function config() {
  const values: Record<string, unknown> = {
    'controlPlane.hostMode': 'local',
    'controlPlane.host': '127.0.0.1',
    'controlPlane.port': 3421,
  };
  return { get: (key: string): never => values[key] as never };
}

interface SocketRecorder {
  factory: DaemonWebSocketFactory;
  methodIds: string[];
  bodies: unknown[];
  urls: string[];
  headers: Record<string, string>[];
}

function fakeSocketFactory(
  answer: { ok: boolean; body?: unknown; status?: number } | { authFails: true },
): SocketRecorder {
  const methodIds: string[] = [];
  const bodies: unknown[] = [];
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const factory: DaemonWebSocketFactory = (url, init) => {
    urls.push(url);
    headers.push({ ...init.headers });
    const socket: DaemonWebSocket = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send(data: string): void {
        const frame = JSON.parse(data) as { type: string; id?: string; methodId?: string; body?: unknown };
        if (frame.type === 'auth') {
          if ('authFails' in answer) {
            queueMicrotask(() => socket.onmessage?.({
              data: JSON.stringify({ type: 'auth', ok: false, error: 'Unauthorized' }),
            }));
            return;
          }
          queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({ type: 'auth', ok: true }) }));
          return;
        }
        if (frame.type === 'call' && !('authFails' in answer)) {
          methodIds.push(frame.methodId ?? '');
          bodies.push(frame.body);
          queueMicrotask(() => socket.onmessage?.({
            data: JSON.stringify({
              type: 'response',
              id: frame.id,
              ok: answer.ok,
              status: answer.status ?? (answer.ok ? 200 : 400),
              body: answer.body,
            }),
          }));
        }
      },
      close(): void {
        // Nothing to release.
      },
    };
    queueMicrotask(() => socket.onopen?.({}));
    return socket;
  };
  return { factory, methodIds, bodies, urls, headers };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    configManager: config(),
    daemonHomeDir: '/home/x/.goodvibes/daemon',
    controlPlaneConfigDir: '/home/x/.goodvibes',
    readToken: () => JSON.stringify({ token: 'op-token' }),
    now: () => 1_000_000,
    flags: { host: undefined, port: undefined, token: undefined, json: false, all: false },
    args: ['list'],
    ...overrides,
  };
}

describe('sessions arguments', () => {
  test('only list and kill are sessions subcommands', () => {
    expect(isSessionsSubcommand('list')).toBe(true);
    expect(isSessionsSubcommand('kill')).toBe(true);
    expect(isSessionsSubcommand('ls')).toBe(false);
    expect(isSessionsSubcommand(undefined)).toBe(false);
  });

  test('no subcommand is a usage refusal, exit 2', async () => {
    const { factory } = fakeSocketFactory({ ok: true, body: { sessions: [] } });
    const result = await runSessionsCommand({ ...baseInput({ args: [] }), socketFactory: factory });
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('sessions list');
  });

  test('an unrecognized subcommand names the two that exist', async () => {
    const { factory } = fakeSocketFactory({ ok: true, body: { sessions: [] } });
    const result = await runSessionsCommand({ ...baseInput({ args: ['stop'] }), socketFactory: factory });
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('try list or kill');
  });

  test('kill with no id is refused rather than treated as "kill everything"', async () => {
    const { factory, methodIds } = fakeSocketFactory({ ok: true, body: {} });
    const result = await runSessionsCommand({ ...baseInput({ args: ['kill'] }), socketFactory: factory });
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('kill needs the session to end');
    expect(methodIds).toEqual([]);
  });

  test('a stray extra argument is refused', async () => {
    const { factory } = fakeSocketFactory({ ok: true, body: { sessions: [] } });
    expect((await runSessionsCommand({ ...baseInput({ args: ['list', 'x'] }), socketFactory: factory })).exitCode).toBe(2);
    expect((await runSessionsCommand({ ...baseInput({ args: ['kill', 'a', 'b'] }), socketFactory: factory })).exitCode).toBe(2);
  });

  test('a usage refusal in --json mode is still one JSON document', async () => {
    const { factory } = fakeSocketFactory({ ok: true, body: {} });
    const result = await runSessionsCommand({
      ...baseInput({ args: ['kill'], flags: { host: undefined, port: undefined, token: undefined, json: true, all: false } }),
      socketFactory: factory,
    });
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.lines[0] as string)).toMatchObject({ ok: false });
  });
});

describe('sessions list', () => {
  const RECORD = {
    id: 'hs-1',
    title: 'refactor the parser',
    workspaceRoot: '/srv/project',
    status: 'idle',
    effectiveDetachPolicy: 'survive',
    attachedClients: 1,
    turnCount: 7,
    updatedAt: 940_000,
  };

  test('calls the ws-only list verb with the operator token', async () => {
    const { factory, methodIds, bodies, urls, headers } = fakeSocketFactory({ ok: true, body: { sessions: [RECORD] } });
    const result = await runSessionsCommand({ ...baseInput(), socketFactory: factory });

    expect(result.exitCode).toBe(0);
    expect(methodIds).toEqual(['sessions.hosted.list']);
    expect(bodies).toEqual([{ includeTerminated: false }]);
    expect(urls[0]).toBe('ws://127.0.0.1:3421/api/control-plane/ws');
    expect(headers[0]?.['Authorization']).toBe('Bearer op-token');
  });

  test('renders id, status, title, workspace and the facts that matter', async () => {
    const { factory } = fakeSocketFactory({ ok: true, body: { sessions: [RECORD] } });
    const result = await runSessionsCommand({ ...baseInput(), socketFactory: factory });
    const text = result.lines.join('\n');
    expect(text).toContain('hs-1');
    expect(text).toContain('idle');
    expect(text).toContain('refactor the parser');
    expect(text).toContain('/srv/project');
    expect(text).toContain('7 turns');
    expect(text).toContain('1 client attached');
    expect(text).toContain('on last detach: survive');
    expect(text).toContain('1m ago');
  });

  test('--all asks for terminated sessions too', async () => {
    const { factory, bodies } = fakeSocketFactory({ ok: true, body: { sessions: [] } });
    await runSessionsCommand({
      ...baseInput({ flags: { host: undefined, port: undefined, token: undefined, json: false, all: true } }),
      socketFactory: factory,
    });
    expect(bodies).toEqual([{ includeTerminated: true }]);
  });

  test('an empty list says so, and points at --all', async () => {
    const { factory } = fakeSocketFactory({ ok: true, body: { sessions: [] } });
    const result = await runSessionsCommand({ ...baseInput(), socketFactory: factory });
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain('hosting no sessions');
    expect(result.lines.join('\n')).toContain('--all');
  });

  test('a daemon that does not know the verb says exactly that', async () => {
    const { factory } = fakeSocketFactory({ ok: false, status: 404 });
    const result = await runSessionsCommand({ ...baseInput(), socketFactory: factory });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('does not know the verb sessions.hosted.list');
  });

  test('a refused token is reported as a token problem, not a missing daemon', async () => {
    const { factory } = fakeSocketFactory({ authFails: true });
    const result = await runSessionsCommand({ ...baseInput(), socketFactory: factory });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('refused the operator token');
  });

  test('--json returns the daemon\'s own record', async () => {
    const { factory } = fakeSocketFactory({ ok: true, body: { sessions: [RECORD] } });
    const result = await runSessionsCommand({
      ...baseInput({ flags: { host: undefined, port: undefined, token: undefined, json: true, all: false } }),
      socketFactory: factory,
    });
    const parsed = JSON.parse(result.lines[0] as string) as { ok: boolean; data: { sessions: unknown[] } };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.sessions.length).toBe(1);
  });
});

describe('sessions kill', () => {
  test('calls the ws-only kill verb with the named id', async () => {
    const { factory, methodIds, bodies } = fakeSocketFactory({
      ok: true,
      body: { session: { id: 'hs-1', status: 'terminated', endedReason: 'killed' } },
    });
    const result = await runSessionsCommand({ ...baseInput({ args: ['kill', 'hs-1'] }), socketFactory: factory });

    expect(result.exitCode).toBe(0);
    expect(methodIds).toEqual(['sessions.hosted.kill']);
    expect(bodies).toEqual([{ sessionId: 'hs-1' }]);
    expect(result.lines.join('\n')).toContain('ended hs-1');
    expect(result.lines.join('\n')).toContain('retention window');
  });

  test('a refusal from the daemon is reported with its own fix line', async () => {
    const { factory } = fakeSocketFactory({
      ok: false,
      status: 400,
      body: { error: 'no session hs-9', fix: 'run sessions list' },
    });
    const result = await runSessionsCommand({ ...baseInput({ args: ['kill', 'hs-9'] }), socketFactory: factory });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('no session hs-9');
    expect(result.lines.join('\n')).toContain('run sessions list');
  });
});

describe('sessions against another machine', () => {
  test('--host/--port build the ws URL for that machine', async () => {
    const { factory, urls, headers } = fakeSocketFactory({ ok: true, body: { sessions: [] } });
    await runSessionsCommand({
      ...baseInput({ flags: { host: '10.0.0.7', port: 4321, token: 'other-token', json: false, all: false } }),
      socketFactory: factory,
    });
    expect(urls[0]).toBe('ws://10.0.0.7:4321/api/control-plane/ws');
    expect(headers[0]?.['Authorization']).toBe('Bearer other-token');
  });
});
