import { describe, expect, test } from 'bun:test';
import type { DaemonFetch } from '@goodvibes-jev/engine/terminal-shell';
import type { DaemonWebSocket, DaemonWebSocketFactory } from '@goodvibes-jev/engine/terminal-shell';
import type { LocalStateIo } from '../../daemon/local-daemon-state.js';
import { localDaemonStatePaths } from '../../daemon/local-daemon-state.js';
import { runStatusCommand, runUpdateCommand } from '../../daemon/status-command.js';

const CONFIG_DIR = '/home/x/.goodvibes';
const PATHS = localDaemonStatePaths(CONFIG_DIR);

/** Config values the remote-target resolver reads. */
function config(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'controlPlane.hostMode': 'local',
    'controlPlane.host': '127.0.0.1',
    'controlPlane.port': 3421,
    ...overrides,
  };
  return { get: (key: string): never => values[key] as never };
}

/**
 * A fetch that answers a fixed map of paths, in the SAME envelopes a real
 * daemon uses: `/api/cluster/*` wraps its answer in `{ ok, data }`, and
 * `/status`, `/api/health` and `/api/channels/status` answer with the payload
 * itself. Reading one as the other turned a healthy 200 into "the daemon
 * refused the request" against a live daemon, so the doubles here reproduce the
 * distinction rather than flattening it.
 */
function fakeFetch(routes: Record<string, unknown>, options: { readonly missing?: readonly string[] } = {}): {
  fetchImpl: DaemonFetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl: DaemonFetch = async (url) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (options.missing?.includes(path)) {
      return new Response(JSON.stringify({ ok: false, error: 'not here' }), { status: 404 });
    }
    const body = routes[path];
    if (body === undefined) {
      return new Response(JSON.stringify({ ok: false, error: `no route ${path}` }), { status: 500 });
    }
    const wrapped = path.startsWith('/api/cluster/');
    return new Response(JSON.stringify(wrapped ? { ok: true, data: body } : body), { status: 200 });
  };
  return { fetchImpl, calls };
}

/**
 * A WebSocket stand-in that plays the daemon's side of the frame exchange:
 * accept the auth frame, then answer the call frame with a canned body.
 */
function fakeSocketFactory(answer: { ok: boolean; body?: unknown; status?: number }): {
  factory: DaemonWebSocketFactory;
  headers: Record<string, string>[];
  methodIds: string[];
  bodies: unknown[];
} {
  const headers: Record<string, string>[] = [];
  const methodIds: string[] = [];
  const bodies: unknown[] = [];
  const factory: DaemonWebSocketFactory = (_url, init) => {
    headers.push({ ...init.headers });
    const socket: DaemonWebSocket = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send(data: string): void {
        const frame = JSON.parse(data) as { type: string; id?: string; methodId?: string; body?: unknown };
        if (frame.type === 'auth') {
          queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({ type: 'auth', ok: true }) }));
          return;
        }
        if (frame.type === 'call') {
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
        // Nothing to release: this double never opened anything.
      },
    };
    queueMicrotask(() => socket.onopen?.({}));
    return socket;
  };
  return { factory, headers, methodIds, bodies };
}

function io(files: Record<string, string>): LocalStateIo {
  return { read: (path: string) => files[path] ?? null };
}

const HEALTHY_ROUTES = {
  '/status': {
    status: 'running',
    version: '1.28.0',
    cluster: { enabled: true, role: 'master', nodeId: 'n1', heldSurfaceCount: 3, consumersRunning: true },
  },
  '/api/health': {
    overall: 'healthy',
    degradedDomains: [],
    providerProblems: [],
    integrationProblems: [],
    mcpProblems: { degraded: [], quarantined: [] },
    network: { controlPlane: { host: '127.0.0.1', port: 3421, scheme: 'http', ready: true, errors: [] } },
  },
  '/api/channels/status': { channels: [{ id: 'telegram', label: 'Telegram', state: 'ready', enabled: true }] },
  '/api/cluster/status': { membership: 'member', groupName: 'the workshop', groupId: 'g1', memberCount: 3 },
};

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    configManager: config(),
    daemonHomeDir: '/home/x/.goodvibes/daemon',
    controlPlaneConfigDir: CONFIG_DIR,
    readToken: () => JSON.stringify({ token: 'op-token' }),
    now: () => 1_000_000,
    localStateIo: io({}),
    ...overrides,
  };
}

describe('status talks to a running daemon over the remote-target convention', () => {
  test('defaults to this machine and authenticates with the operator token', async () => {
    const { fetchImpl, calls } = fakeFetch(HEALTHY_ROUTES);
    const { factory, headers } = fakeSocketFactory({ ok: true, body: { sessions: [] } });

    const result = await runStatusCommand({
      ...baseDeps(),
      fetchImpl,
      socketFactory: factory,
      flags: { host: undefined, port: undefined, token: undefined, json: false },
    });

    expect(result.exitCode).toBe(0);
    expect(calls).toContain('/status');
    expect(calls).toContain('/api/health');
    expect(calls).toContain('/api/channels/status');
    expect(calls).toContain('/api/cluster/status');
    expect(headers[0]?.['Authorization']).toBe('Bearer op-token');
    expect(result.lines[0]).toContain('this machine');
  });

  test('--host/--port/--token aim it at another machine', async () => {
    const seen: string[] = [];
    const fetchImpl: DaemonFetch = async (url, init) => {
      seen.push(url);
      expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer other-token');
      const path = new URL(url).pathname;
      const body = (HEALTHY_ROUTES as Record<string, unknown>)[path];
      const wrapped = path.startsWith('/api/cluster/');
      return new Response(JSON.stringify(wrapped ? { ok: true, data: body } : body), { status: 200 });
    };
    const { factory } = fakeSocketFactory({ ok: true, body: { sessions: [] } });

    const result = await runStatusCommand({
      ...baseDeps(),
      fetchImpl,
      socketFactory: factory,
      flags: { host: '10.0.0.7', port: 4321, token: 'other-token', json: false },
    });

    expect(result.exitCode).toBe(0);
    expect(seen[0]).toBe('http://10.0.0.7:4321/status');
    expect(result.lines[0]).toContain('http://10.0.0.7:4321');
  });

  test('reports version, health, binding, channels, cluster role and hosted sessions', async () => {
    const { fetchImpl } = fakeFetch(HEALTHY_ROUTES);
    const { factory } = fakeSocketFactory({ ok: true, body: { sessions: [{ id: 'a' }, { id: 'b' }] } });

    const result = await runStatusCommand({
      ...baseDeps(),
      fetchImpl,
      socketFactory: factory,
      flags: { host: undefined, port: undefined, token: undefined, json: false },
    });

    const text = result.lines.join('\n');
    expect(text).toContain('1.28.0');
    expect(text).toContain('health:   healthy');
    expect(text).toContain('bound:    http://127.0.0.1:3421');
    expect(text).toContain('1 of 1 switched on');
    expect(text).toContain('master in "the workshop" of 3');
    expect(text).toContain('2 hosted by this daemon');
  });

  test('reports uptime, receipts, the rejected version and a rollback for a local daemon', async () => {
    const { fetchImpl } = fakeFetch(HEALTHY_ROUTES);
    const { factory } = fakeSocketFactory({ ok: true, body: { sessions: [] } });

    const result = await runStatusCommand({
      ...baseDeps({
        localStateIo: io({
          [PATHS.markerPath]: JSON.stringify({
            state: 'running',
            at: 400_000,
            failedStarts: 2,
            rejectedVersion: '1.27.9',
            autoRollbackAt: 900_000,
          }),
          [PATHS.receiptsPath]: JSON.stringify([{ id: 'r1', text: 'updated to 1.28.0', at: 500_000 }]),
        }),
      }),
      fetchImpl,
      socketFactory: factory,
      flags: { host: undefined, port: undefined, token: undefined, json: false },
    });

    const text = result.lines.join('\n');
    expect(text).toContain('uptime:   10m 0s');
    expect(text).toContain('2 consecutive start attempts');
    expect(text).toContain('rejected: 1.27.9');
    expect(text).toContain('rollback: an automatic rollback is in force');
    expect(text).toContain('updated to 1.28.0');
  });

  test('for a remote daemon those lines say they cannot be read from here', async () => {
    const { fetchImpl } = fakeFetch(HEALTHY_ROUTES);
    const { factory } = fakeSocketFactory({ ok: true, body: { sessions: [] } });

    const result = await runStatusCommand({
      ...baseDeps(),
      fetchImpl,
      socketFactory: factory,
      flags: { host: '10.0.0.7', port: undefined, token: 'other', json: false },
    });

    expect(result.lines.join('\n')).toContain('run this command on that machine');
  });

  test('an unreachable daemon is the one failure that fails the command', async () => {
    const fetchImpl: DaemonFetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const { factory } = fakeSocketFactory({ ok: true, body: { sessions: [] } });

    const result = await runStatusCommand({
      ...baseDeps(),
      fetchImpl,
      socketFactory: factory,
      flags: { host: undefined, port: undefined, token: undefined, json: false },
    });

    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('could not reach');
    expect(result.lines.join('\n')).toContain('service-status');
  });

  test('one broken sub-question is a line, not a failed command', async () => {
    const { fetchImpl } = fakeFetch(HEALTHY_ROUTES, { missing: ['/api/channels/status'] });
    const { factory } = fakeSocketFactory({ ok: false, status: 404 });

    const result = await runStatusCommand({
      ...baseDeps(),
      fetchImpl,
      socketFactory: factory,
      flags: { host: undefined, port: undefined, token: undefined, json: false },
    });

    expect(result.exitCode).toBe(0);
    const text = result.lines.join('\n');
    expect(text).toContain('channels: could not read');
    expect(text).toContain('sessions: could not read');
    expect(text).toContain('does not know the verb sessions.hosted.list');
  });

  test('a missing operator token is refused with the fix, not attempted anonymously', async () => {
    const { fetchImpl, calls } = fakeFetch(HEALTHY_ROUTES);
    const { factory } = fakeSocketFactory({ ok: true, body: { sessions: [] } });

    const result = await runStatusCommand({
      ...baseDeps({ readToken: () => undefined }),
      fetchImpl,
      socketFactory: factory,
      flags: { host: undefined, port: undefined, token: undefined, json: false },
    });

    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('no operator token');
    expect(calls).toEqual([]);
  });

  test('--json is one document carrying every part', async () => {
    const { fetchImpl } = fakeFetch(HEALTHY_ROUTES);
    const { factory } = fakeSocketFactory({ ok: true, body: { sessions: [{ id: 'a' }] } });

    const result = await runStatusCommand({
      ...baseDeps(),
      fetchImpl,
      socketFactory: factory,
      flags: { host: undefined, port: undefined, token: undefined, json: true },
    });

    expect(result.lines.length).toBe(1);
    const parsed = JSON.parse(result.lines[0] as string) as {
      ok: boolean;
      data: Record<string, unknown>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data['isLocal']).toBe(true);
    expect((parsed.data['identity'] as { version: string }).version).toBe('1.28.0');
    expect((parsed.data['hostedSessions'] as { count: number }).count).toBe(1);
    expect(parsed.data['cluster']).toBeDefined();
  });

  test('the hosted-session count comes from the ws-only verb, by name', async () => {
    const { fetchImpl } = fakeFetch(HEALTHY_ROUTES);
    const { factory, methodIds } = fakeSocketFactory({ ok: true, body: { sessions: [] } });

    await runStatusCommand({
      ...baseDeps(),
      fetchImpl,
      socketFactory: factory,
      flags: { host: undefined, port: undefined, token: undefined, json: false },
    });

    expect(methodIds).toEqual(['sessions.hosted.list']);
  });
});

describe('update reports what the daemon knows about its own updates', () => {
  test('names the version and the rollback state', async () => {
    const { fetchImpl } = fakeFetch({ '/status': { status: 'running', version: '1.28.0' } });

    const result = await runUpdateCommand({
      ...baseDeps({
        localStateIo: io({
          [PATHS.markerPath]: JSON.stringify({
            state: 'running', at: 400_000, failedStarts: 0, rejectedVersion: '1.27.9', autoRollbackAt: 1,
          }),
          [PATHS.receiptsPath]: JSON.stringify([{ id: 'r', text: 'swapped in 1.28.0', at: 2 }]),
        }),
      }),
      fetchImpl,
      flags: { host: undefined, port: undefined, token: undefined, json: false, check: false },
    });

    expect(result.exitCode).toBe(0);
    const text = result.lines.join('\n');
    expect(text).toContain('1.28.0');
    expect(text).toContain('rejected: 1.27.9');
    expect(text).toContain('swapped in 1.28.0');
  });

  test('--check states the gap honestly instead of calling a verb that does not exist', async () => {
    const { fetchImpl, calls } = fakeFetch({ '/status': { status: 'running', version: '1.28.0' } });

    const result = await runUpdateCommand({
      ...baseDeps(),
      fetchImpl,
      flags: { host: undefined, port: undefined, token: undefined, json: false, check: true },
    });

    expect(result.exitCode).toBe(0);
    const text = result.lines.join('\n');
    expect(text).toContain('publishes no verb to trigger an update check early');
    expect(text).toContain('only reads status');
    expect(text).toContain('require a configured update artifact and host policy');
    expect(text).not.toContain('restart-service');
    expect(text).not.toContain('checks once an hour');
    // Nothing was invented: only the identity call was made.
    expect(calls).toEqual(['/status']);
  });

  test('--json says plainly that no check verb is available', async () => {
    const { fetchImpl } = fakeFetch({ '/status': { status: 'running', version: '1.28.0' } });

    const result = await runUpdateCommand({
      ...baseDeps(),
      fetchImpl,
      flags: { host: undefined, port: undefined, token: undefined, json: true, check: true },
    });

    const parsed = JSON.parse(result.lines[0] as string) as { data: Record<string, unknown> };
    expect(parsed.data['checkRequested']).toBe(true);
    expect(parsed.data['checkVerbAvailable']).toBe(false);
  });

  test('an unreachable daemon fails with the reason', async () => {
    const fetchImpl: DaemonFetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await runUpdateCommand({
      ...baseDeps(),
      fetchImpl,
      flags: { host: undefined, port: undefined, token: undefined, json: false, check: false },
    });
    expect(result.exitCode).toBe(1);
  });
});
