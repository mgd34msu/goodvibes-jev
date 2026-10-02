import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { registerWorkLedgerGatewayMethods } from '../sdk/src/platform/control-plane/routes/work-ledger.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../sdk/src/platform/daemon/control-plane.js';
import { dispatchGatewayRestRoutes } from '../daemon-sdk/src/gateway-rest-routes.js';
import { createOperatorSdk } from '../operator-sdk/src/client.js';
import type { OperatorRemoteClient } from '../operator-sdk/src/client-core.js';
import { createOperatorWorkLedgerReadClient } from '../operator-sdk/src/work-ledger-read-client.js';
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
  let beforeHistory: (() => void) | undefined;
  const reader = {
    projectId: 'fixture-project',
    async readSnapshot() {
      if (closed) throw new WorkLedgerAccessError('closed', 'closed');
      return { projectId: 'fixture-project', cursor: events.length, revision: events.length, works: [] as Array<{ work: WorkLedgerEvent['work']; attempt: null; verification: { state: 'unverified'; reason: string; evidence: null }; attention: [] }> };
    },
    subscribe() { return () => {}; },
    dispose() {},
    async history(after: number) { historyCalls += 1; beforeHistory?.(); return events.filter(item => item.sequence > after); },
  };
  registerWorkLedgerGatewayMethods(catalog, reader);
  const helper = new DaemonControlPlaneHelper({
    gatewayMethods: catalog, authToken: () => revoked ? null : 'synthetic-owner-token',
    userAuth: {
      validateSession: (token: string) => token === 'synthetic-reader-token' ? { username: 'reader' } : null,
      getUser: () => ({ username: 'reader', roles: [] }),
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
    revoke() { revoked = true; }, close() { closed = true; }, onHistory(fn: () => void) { beforeHistory = fn; } };
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
