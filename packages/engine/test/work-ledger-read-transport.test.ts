import { describe, expect, spyOn, test } from 'bun:test';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { registerWorkLedgerGatewayMethods } from '../sdk/src/platform/control-plane/routes/work-ledger.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../sdk/src/platform/daemon/control-plane.js';
import { dispatchGatewayRestRoutes } from '../daemon-sdk/src/gateway-rest-routes.js';
import { createOperatorSdk } from '../operator-sdk/src/client.js';
import type { OperatorRemoteClient } from '../operator-sdk/src/client-core.js';
import { createOperatorWorkLedgerReadClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/operator-read-client';
import { WorkLedgerAccessError, type WorkLedgerEvent } from '../sdk/src/platform/workflow/work-ledger/types.js';

function event(sequence: number): WorkLedgerEvent {
  return { sequence, type: 'create', actorId: 'fixture-owner', requestId: `request-${sequence}`, workId: `work-${sequence}`,
    attemptId: null, at: sequence,
    work: { id: `work-${sequence}`, title: 'Synthetic task', goal: 'Fixture only', criteria: ['Read safely'], revision: sequence,
      criteriaRevision: 1, reportedState: 'pending', currentAttemptId: null, createdAt: sequence, updatedAt: sequence },
    attempts: [], evidence: null, reason: null };
}
function fixture(count = 0) {
  const catalog = new GatewayMethodCatalog();
  const events = Array.from({ length: count }, (_, index) => event(index + 1));
  let closed = false;
  let revoked = false;
  let historyCalls = 0;
  let snapshotCalls = 0;
  let sessionRoles: readonly string[] = ['admin'];
  let token = 'synthetic-owner-token';
  let beforeHistory: (() => void) | undefined;
  const reader = {
    projectId: 'fixture-project',
    async readSnapshot() {
      snapshotCalls += 1;
      if (closed) throw new WorkLedgerAccessError('closed', 'closed');
      return { projectId: 'fixture-project', cursor: events.length, revision: events.length, works: [] as Array<{ work: WorkLedgerEvent['work']; attempt: null; verification: { state: 'unverified'; reason: string; evidence: null }; attention: [] }> };
    },
    subscribe() { return () => {}; },
    dispose() {},
    async history(after: number) { historyCalls += 1; beforeHistory?.(); return events.filter(item => item.sequence > after); },
  };
  registerWorkLedgerGatewayMethods(catalog, reader);
  const helper = new DaemonControlPlaneHelper({
    gatewayMethods: catalog, authToken: () => revoked ? null : token,
    controlPlaneGateway: { touchWebSocketClient() {} },
    userAuth: {
      validateSession: (value: string) => value === 'synthetic-reader-token' ? { username: 'reader' } : value === 'synthetic-admin-session' ? { username: 'session-user' } : null,
      getUser: (username: string) => ({ username, roles: username === 'reader' ? [] : sessionRoles }),
    },
  } as unknown as DaemonControlPlaneContext);
  const requests: Request[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init); requests.push(request);
    const response = await dispatchGatewayRestRoutes(request, {
      async invokeGatewayRestVerb({ req, methodId }) {
        const token = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
        const principal = helper.describeAuthenticatedPrincipal(token);
        if (!principal) return Response.json({ error: 'Unauthorized' }, { status: 401 });
        const result = await helper.invokeGatewayMethodCall({ authToken: token, methodId,
          query: Object.fromEntries(new URL(req.url).searchParams), context: principal });
        return Response.json(result.body, { status: result.status });
      },
    });
    return response ?? Response.json({ error: 'Not found' }, { status: 404 });
  };
  const sdk = (token = 'synthetic-owner-token') => createOperatorSdk({ baseUrl: 'http://127.0.0.1:1', authToken: token, fetch });
  return { catalog, helper, events, reader, requests, sdk, get historyCalls() { return historyCalls; },
    get snapshotCalls() { return snapshotCalls; },
    downgradeRole() { sessionRoles = []; }, rotateToken() { token = 'synthetic-replacement-token'; },
    revoke() { revoked = true; }, close() { closed = true; }, onHistory(fn: () => void) { beforeHistory = fn; } };
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check: () => boolean): Promise<void> {
  const until = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= until) throw new Error('Synthetic observation did not settle');
    await pause(10);
  }
}

describe('native ledger authenticated read transport', () => {
  test('owner auth reaches matching host; read-only user and unrelated scopes cannot read', async () => {
    const host = fixture();
    const reader = createOperatorWorkLedgerReadClient(host.sdk(), 'fixture-project');
    expect(await reader.readSnapshot()).toEqual({ projectId: 'fixture-project', cursor: 0, revision: 0, works: [] });
    expect(host.requests[0]?.headers.get('authorization')).toBe('Bearer synthetic-owner-token');
    await expect(createOperatorWorkLedgerReadClient(host.sdk('synthetic-reader-token'), 'fixture-project').readSnapshot()).rejects.toMatchObject({ status: 403 });
    const descriptor = host.catalog.get('workLedger.snapshot')!;
    expect(descriptor.scopes).toEqual(['read:work-ledger']);
    expect(host.helper.validateGatewayInvocation(descriptor, { admin: true, scopes: ['read:events', 'read:fleet', 'read:workspaces'] })?.status).toBe(403);
    await expect(host.catalog.invoke('workLedger.snapshot', { query: { projectId: 'fixture-project' }, context: { admin: true, scopes: ['read:work-ledger'] } })).rejects.toMatchObject({ status: 403 });
    reader.dispose();
  });
  test('rejects different project and identity/path injection before storage read', async () => {
    const host = fixture();
    await expect(createOperatorWorkLedgerReadClient(host.sdk(), 'other-project').readSnapshot()).rejects.toMatchObject({ status: 403 });
    await expect(host.sdk().invoke('workLedger.snapshot', { projectId: 'fixture-project', actorId: 'owner' })).rejects.toMatchObject({ status: 400 });
    await expect(host.sdk().invoke('workLedger.snapshot', { projectId: 'fixture-project', path: '/tmp/other.sqlite' })).rejects.toMatchObject({ status: 400 });
    expect(host.historyCalls).toBe(0);
  });
  test('fixed pages drain one pinned watermark despite concurrent growth', async () => {
    const host = fixture(205);
    host.onHistory(() => { host.events.push(event(host.events.length + 1)); });
    const reader = createOperatorWorkLedgerReadClient(host.sdk(), 'fixture-project');
    const history = await reader.history(0);
    expect(history).toHaveLength(205); expect(history.at(-1)?.sequence).toBe(205);
    expect(host.historyCalls).toBe(3);
    expect(host.requests.map(req => new URL(req.url).searchParams.get('throughSequence'))).toEqual([null, '205', '205']);
    expect(await reader.history(205)).toHaveLength(3);
    reader.dispose();
  });
  test('invalid/future cursors and oversized events are refusals, not partial success', async () => {
    const host = fixture(2); const reader = createOperatorWorkLedgerReadClient(host.sdk(), 'fixture-project');
    await expect(reader.history(-1)).rejects.toThrow('invalid history cursor');
    await expect(reader.history(10)).rejects.toMatchObject({ status: 400 });
    // A permitted work's bounded fields can still exceed the whole wire response bound.
    host.events[0]!.work.criteria = Array.from({ length: 100 }, () => 'x'.repeat(20_000));
    await expect(reader.history(0)).rejects.toMatchObject({ status: 413 });
    await expect(host.sdk().invoke('workLedger.history', { projectId: 'fixture-project', afterSequence: '1.5' })).rejects.toMatchObject({ status: 400 });
    reader.dispose();
  });
  test('revocation is rechecked per request and polling stops after denial', async () => {
    const host = fixture(); const unavailable: Error[] = []; const observed: number[] = [];
    const reader = createOperatorWorkLedgerReadClient(host.sdk(), 'fixture-project', { pollIntervalMs: 100, onUnavailable: e => unavailable.push(e) });
    reader.subscribe(snapshot => observed.push(snapshot.cursor));
    await pause(30); expect(observed).toEqual([0]);
    host.revoke(); await pause(140);
    expect(unavailable).toHaveLength(1); expect(unavailable[0]).toMatchObject({ status: 401 });
    const calls = host.requests.length; await pause(160); expect(host.requests).toHaveLength(calls);
    await expect(reader.readSnapshot()).rejects.toMatchObject({ status: 401 }); reader.dispose();
  });
  test('host closure is unavailable, never an empty ledger', async () => {
    const host = fixture(); host.close();
    await expect(createOperatorWorkLedgerReadClient(host.sdk(), 'fixture-project').readSnapshot()).rejects.toMatchObject({ status: 503 });
  });
});


describe('native ledger reader lifecycle', () => {
  test('dispose aborts pending reads and rejects late results exactly once', async () => {
    let finish!: (value: unknown) => void; let signal: AbortSignal | undefined;
    const invoke: OperatorRemoteClient['invoke'] = async <T>(_method: string, _input?: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
      signal = options?.signal;
      return await new Promise(resolve => { finish = resolve; }) as T;
    };
    const reader = createOperatorWorkLedgerReadClient({ invoke }, 'fixture-project');
    const pending = reader.readSnapshot(); reader.dispose(); reader.dispose();
    expect(signal?.aborted).toBe(true);
    finish({ projectId: 'fixture-project', cursor: 0, revision: 0, works: [] });
    await expect(pending).rejects.toThrow('disposed');
    expect(() => reader.subscribe(() => {})).toThrow('disposed');
  });
  test('unsubscribe cancels observation only, with no late callback; explicit reads remain usable', async () => {
    let finish!: (value: unknown) => void; let signal: AbortSignal | undefined; let calls = 0; const observed: number[] = [];
    const invoke: OperatorRemoteClient['invoke'] = async <T>(_method: string, _input?: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
      calls += 1; signal = options?.signal;
      if (calls === 1) return await new Promise(resolve => { finish = resolve; }) as T;
      return { projectId: 'fixture-project', cursor: 0, revision: 0, works: [] } as T;
    };
    const reader = createOperatorWorkLedgerReadClient({ invoke }, 'fixture-project', { pollIntervalMs: 100 });
    const detach = reader.subscribe(value => observed.push(value.cursor)); await pause(10); detach(); detach();
    expect(signal?.aborted).toBe(true); finish({ projectId: 'fixture-project', cursor: 0, revision: 0, works: [] });
    await pause(120); expect(observed).toEqual([]); expect(calls).toBe(1);
    expect((await reader.readSnapshot()).cursor).toBe(0); reader.dispose();
  });
  test('transient polling failure backs off then catches up the durable cursor', async () => {
    const host = fixture(); let calls = 0; const snapshots: number[] = []; const errors: Error[] = [];
    const sdk = host.sdk();
    const invoke: OperatorRemoteClient['invoke'] = async <T>(method: string, input?: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
      if (++calls === 1) throw new Error('synthetic offline');
      return sdk.invoke<T>(method, input, options);
    };
    const reader = createOperatorWorkLedgerReadClient({ invoke }, 'fixture-project', { pollIntervalMs: 100, onUnavailable: e => errors.push(e) });
    reader.subscribe(value => snapshots.push(value.cursor)); await pause(30);
    expect(errors).toHaveLength(1); expect(calls).toBe(1);
    host.events.push(event(1), event(2)); await pause(90); expect(calls).toBe(1);
    await pause(120); expect(snapshots).toEqual([2]); expect((await reader.history(0)).map(item => item.sequence)).toEqual([1, 2]); reader.dispose();
  });
  test('host mismatch, cursor gaps, and truncated pages never resolve as valid history', async () => {
    const invoke: OperatorRemoteClient['invoke'] = async <T>() => ({ projectId: 'fixture-project', afterSequence: 0,
      cursor: 2, throughSequence: 2, hasMore: false, events: [event(2)] }) as T;
    const reader = createOperatorWorkLedgerReadClient({ invoke }, 'fixture-project');
    await expect(reader.history(0)).rejects.toThrow('cursor gap'); reader.dispose();
    const wrong: OperatorRemoteClient['invoke'] = async <T>() => ({ projectId: 'other-project', cursor: 0, revision: 0, works: [] }) as T;
    const mismatched = createOperatorWorkLedgerReadClient({ invoke: wrong }, 'fixture-project');
    await expect(mismatched.readSnapshot()).rejects.toThrow('host project or cursor mismatch'); mismatched.dispose();
  });
  test('history aggregate cap rejects instead of returning a silently truncated prefix', async () => {
    const host = fixture(500);
    for (const item of host.events) item.work.goal = 'x'.repeat(20_000);
    const reader = createOperatorWorkLedgerReadClient(host.sdk(), 'fixture-project');
    await expect(reader.history(0)).rejects.toThrow('history catch-up exceeds the bounded read limit'); reader.dispose();
  });
});


test('a hung fetch is cancelled at the bounded timeout', async () => {
  let signal: AbortSignal | undefined;
  const invoke: OperatorRemoteClient['invoke'] = async <T>(_method: string, _input?: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
    signal = options?.signal;
    return await new Promise(() => {}) as T;
  };
  const reader = createOperatorWorkLedgerReadClient({ invoke }, 'fixture-project', { requestTimeoutMs: 100 });
  await expect(reader.readSnapshot()).rejects.toThrow('timed out');
  expect(signal?.aborted).toBe(true); reader.dispose();
});

test('schema integer cursors preserve numeric client IO generation', async () => {
  const { renderType } = await import('../scripts/foundation-io-render.js');
  expect(renderType({ type: 'integer', minimum: 0 })).toBe('number');
  expect(renderType({ type: 'array', items: { type: 'integer' } })).toBe('readonly number[]');
});


test('snapshots reject authority-bearing fields and oversized data', async () => {
  const host = fixture();
  host.reader.readSnapshot = async () => ({ projectId: 'fixture-project', revision: 0, cursor: 0, works: Array.from({ length: 100 }, () => ({
    work: event(1).work, attempt: null, verification: { state: 'unverified' as const, reason: 'x'.repeat(20_000), evidence: null }, attention: [],
  })) });
  const reader = createOperatorWorkLedgerReadClient(host.sdk(), 'fixture-project');
  await expect(reader.readSnapshot()).rejects.toMatchObject({ status: 413 });
  const authorityBearing = { projectId: 'fixture-project', cursor: 0, revision: 0, works: [{
    work: event(1).work, attempt: null, verification: { state: 'unverified' as const, reason: 'unverified', evidence: null },
    attention: [] as [], allowedActions: ['claim'],
  }] };
  host.reader.readSnapshot = async () => authorityBearing;
  await expect(reader.readSnapshot()).rejects.toMatchObject({ status: 503 }); reader.dispose();
});

test('two subscriptions using the same callback own independent leases', async () => {
  const host = fixture(); const snapshots: number[] = [];
  const reader = createOperatorWorkLedgerReadClient(host.sdk(), 'fixture-project', { pollIntervalMs: 100 });
  const listener = (snapshot: { cursor: number }) => snapshots.push(snapshot.cursor);
  const first = reader.subscribe(listener); const second = reader.subscribe(listener);
  first(); await pause(30); expect(snapshots).toEqual([0]);
  second(); const calls = host.requests.length; await pause(120); expect(host.requests).toHaveLength(calls);
  reader.dispose();
});


test('a timed-out observation reports unavailable, backs off, and resumes from durable state', async () => {
  const host = fixture(); const sdk = host.sdk();
  let calls = 0; const failures: Error[] = []; const cursors: number[] = [];
  const invoke: OperatorRemoteClient['invoke'] = async <T>(method: string, input?: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
    if (++calls === 1) return await new Promise(() => {}) as T;
    return sdk.invoke<T>(method, input, options);
  };
  const reader = createOperatorWorkLedgerReadClient({ invoke }, 'fixture-project', {
    requestTimeoutMs: 100, pollIntervalMs: 100, onUnavailable: error => failures.push(error),
  });
  const detach = reader.subscribe(snapshot => cursors.push(snapshot.cursor));
  try {
    await waitFor(() => failures.length > 0); expect(failures).toHaveLength(1); expect(failures[0]?.message).toContain('timed out');
    expect(calls).toBe(1); expect(cursors).toEqual([]);
    host.events.push(event(1), event(2));
    await waitFor(() => cursors.length > 0); expect(calls).toBe(2); expect(cursors).toEqual([2]);
    expect((await reader.history(0)).map(item => item.sequence)).toEqual([1, 2]);
  } finally { detach(); reader.dispose(); }
});


test.each(['subscription', 'unavailable'] as const)('async %s observer rejection after disposal stays isolated', async kind => {
  const host = fixture(); const sdk = host.sdk();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let observed = false;
  const unhandled: unknown[] = [];
  const record = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', record);
  const callback = async () => { observed = true; await gate; throw new Error('synthetic observer rejection'); };
  const invoke: OperatorRemoteClient['invoke'] = async <T>(method: string, input?: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
    if (kind === 'unavailable') throw new Error('synthetic offline');
    return sdk.invoke<T>(method, input, options);
  };
  const reader = createOperatorWorkLedgerReadClient({ invoke }, 'fixture-project', {
    pollIntervalMs: 100, ...(kind === 'unavailable' ? { onUnavailable: callback } : {}),
  });
  const detach = reader.subscribe(kind === 'subscription' ? callback : () => {});
  try {
    await waitFor(() => observed); detach(); reader.dispose(); release();
    await pause(30); expect(unhandled).toEqual([]);
  } finally { detach(); reader.dispose(); release(); process.off('unhandledRejection', record); }
});

test.each(['subscription', 'unavailable'] as const)('hostile %s thenable and reentrant disposal stay isolated', async kind => {
  const host = fixture(); const sdk = host.sdk(); let called = 0; let thenRead = 0;
  const invoke: OperatorRemoteClient['invoke'] = async <T>(method: string, input?: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
    if (kind === 'unavailable') throw new Error('synthetic offline');
    return sdk.invoke<T>(method, input, options);
  };
  const callback = () => {
    called += 1;
    return { get then() { thenRead += 1; reader.dispose(); throw new Error('synthetic hostile thenable'); } };
  };
  const reader = createOperatorWorkLedgerReadClient({ invoke }, 'fixture-project', {
    pollIntervalMs: 100, ...(kind === 'unavailable' ? { onUnavailable: callback } : {}),
  });
  reader.subscribe(kind === 'subscription' ? callback : () => {});
  await waitFor(() => thenRead > 0); await pause(120);
  expect(called).toBe(1); expect(thenRead).toBe(1);
  await expect(reader.readSnapshot()).rejects.toThrow('disposed'); reader.dispose();
});


function webSocketFixture(host: ReturnType<typeof fixture>, token = 'synthetic-owner-token') {
  const principal = host.helper.describeAuthenticatedPrincipal(token);
  if (!principal) throw new Error('Synthetic token did not authenticate');
  const responses: Array<{ status: number; ok: boolean }> = [];
  const socket = {
    data: { channel: 'control-plane' as const, clientId: 'synthetic-client', authToken: token,
      ...principal, authenticated: true, clientKind: 'web' as const, domains: [] },
    send(message: string) { responses.push(JSON.parse(message)); },
  };
  return {
    socket, responses,
    async call(methodId: string, extra: Record<string, unknown> = {}) {
      await host.helper.handleControlPlaneWebSocketMessage(
        socket as unknown as Parameters<typeof host.helper.handleControlPlaneWebSocketMessage>[0],
        JSON.stringify({ type: 'call', id: 'synthetic-request', methodId,
          query: { projectId: 'fixture-project', ...(methodId === 'workLedger.history' ? { afterSequence: 0 } : {}) }, ...extra }),
      );
      return responses.at(-1);
    },
  };
}

describe('fresh authorization on every ledger entry point', () => {
  test.each(['workLedger.snapshot', 'workLedger.history'])('%s reauthenticates existing WS after token revocation/rotation', async method => {
    for (const invalidate of ['revoke', 'rotateToken'] as const) {
      const host = fixture(); const ws = webSocketFixture(host);
      expect((await ws.call(method))?.status).toBe(200);
      const reads = host.snapshotCalls; const history = host.historyCalls;
      host[invalidate]();
      expect((await ws.call(method, { authToken: 'synthetic-replacement-token', principalId: 'shared-token', admin: true, scopes: ['*'] }))?.status).toBe(401);
      expect(host.snapshotCalls).toBe(reads); expect(host.historyCalls).toBe(history);
    }
  });
  test.each(['workLedger.snapshot', 'workLedger.history'])('%s rejects a current role downgrade despite cached WS admin', async method => {
    const host = fixture(); const ws = webSocketFixture(host, 'synthetic-admin-session');
    expect(ws.socket.data.admin).toBe(true); host.downgradeRole();
    expect((await ws.call(method))?.status).toBe(403);
    expect(host.snapshotCalls).toBe(0); expect(host.historyCalls).toBe(0);
  });
  test.each(['workLedger.snapshot', 'workLedger.history'])('%s never widens fresh or cached restricted scopes', async method => {
    const host = fixture(); const ws = webSocketFixture(host);
    ws.socket.data.scopes = ['read:events'];
    expect((await ws.call(method))?.status).toBe(403); expect(host.snapshotCalls).toBe(0);
    ws.socket.data.scopes = ['*'];
    const original = host.helper.describeAuthenticatedPrincipal.bind(host.helper);
    const fresh = spyOn(host.helper, 'describeAuthenticatedPrincipal').mockImplementation(token => {
      const principal = original(token); return principal ? { ...principal, scopes: ['read:events'] } : null;
    });
    try {
      expect((await ws.call(method))?.status).toBe(403); expect(host.snapshotCalls).toBe(0);
    } finally { fresh.mockRestore(); }
  });
  test.each(['workLedger.snapshot', 'workLedger.history'])('%s refuses missing token and forged payload authority before reads', async method => {
    const host = fixture(); const ws = webSocketFixture(host);
    ws.socket.data.authToken = '';
    expect((await ws.call(method, { authToken: 'synthetic-owner-token' }))?.status).toBe(401);
    ws.socket.data.authToken = 'synthetic-owner-token';
    expect((await ws.call(method, { body: { actorId: 'forged', authority: {}, context: { admin: true, scopes: ['*'] } } }))?.status).toBe(400);
    expect(host.snapshotCalls).toBe(0); expect(host.historyCalls).toBe(0);
  });
  test('only these two catalog methods opt into the new fresh-auth gate', () => {
    const host = fixture();
    expect(host.catalog.list().filter(method => method.metadata?.requiresFreshOperatorAuth === true).map(method => method.id).sort())
      .toEqual(['workLedger.history', 'workLedger.snapshot']);
  });
});


test.each(['readSnapshot', 'history'] as const)('%s fences disposal at the outer await boundary', async method => {
  const invoke: OperatorRemoteClient['invoke'] = async <T>() => (method === 'readSnapshot'
    ? { projectId: 'fixture-project', cursor: 0, revision: 0, works: [] }
    : { projectId: 'fixture-project', afterSequence: 0, cursor: 0, throughSequence: 0, hasMore: false, events: [] }) as T;
  const reader = createOperatorWorkLedgerReadClient({ invoke }, 'fixture-project');
  const pending = method === 'readSnapshot' ? reader.readSnapshot() : reader.history(0);
  await Promise.resolve(); await Promise.resolve();
  expect(Bun.inspect(pending)).toContain('<pending>');
  reader.dispose(); await expect(pending).rejects.toThrow('disposed');
});

test('unavailable observer mutation cannot turn terminal auth failure into retries', async () => {
  let calls = 0; let errors = 0;
  const invoke: OperatorRemoteClient['invoke'] = async <T>(): Promise<T> => {
    calls += 1; throw Object.assign(new Error('synthetic revoked token'), { status: 401 });
  };
  const reader = createOperatorWorkLedgerReadClient({ invoke }, 'fixture-project', {
    pollIntervalMs: 100, onUnavailable: error => { errors += 1; Object.assign(error, { status: 503 }); },
  });
  reader.subscribe(() => {});
  await waitFor(() => errors > 0); await pause(250);
  expect(calls).toBe(1); expect(errors).toBe(1); reader.dispose();
});

test('one observer cannot rewrite another observer snapshot', async () => {
  const host = fixture(1); const snapshots: number[] = [];
  const reader = createOperatorWorkLedgerReadClient(host.sdk(), 'fixture-project', { pollIntervalMs: 100 });
  reader.subscribe(snapshot => { Object.assign(snapshot, { cursor: 999, projectId: 'rewritten' }); });
  reader.subscribe(snapshot => snapshots.push(snapshot.cursor));
  await waitFor(() => snapshots.length > 0); expect(snapshots).toEqual([1]);
  expect((await reader.readSnapshot()).projectId).toBe('fixture-project'); reader.dispose();
});
