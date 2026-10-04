import { describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundleBrowserEntrypoint } from './_helpers/browser-bundle.ts';
import {
  createOperatorNativeWorkExecutionClient,
  getOperatorWorkLedgerProject,
  nativeWorkExecutionIdentitySchema,
  nativeWorkExecutionRequestSchema,
  nativeWorkExecutionSnapshotSchema,
  type NativeWorkExecutionIdentity,
  type NativeWorkExecutionSnapshot,
  type NativeWorkExecutionExecutionSnapshot,
} from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client';
import { createOperatorRemoteClient, type OperatorRemoteClient } from '../operator-sdk/src/client-core.js';
import { CONTRACT_STATUSES } from '../sdk/src/events/contract.js';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { createHttpTransport, firstJsonSchemaFailure } from '../transport-http/src/index.js';
import { buildOperatorContract } from '../sdk/src/platform/control-plane/operator-contract.js';

const projectId = 'native-client-project';
const operations = ['start', 'status', 'cancel', 'resume'] as const;
function identity(): NativeWorkExecutionIdentity {
  return { workId: 'work-1', attemptId: 'attempt-1', expectedRevision: { work: 1, criteria: 2, attempt: 3 } };
}
function snapshot(): NativeWorkExecutionExecutionSnapshot {
  return { kind: 'execution', projectId, ...identity(), currentRevision: { work: 1, criteria: 2, attempt: 3 }, currentAttempt: true,
    stale: false, state: 'launch-claimed', recovery: 'available', receipt: { contractId: 'contract-1', ownerAgentId: 'owner-1' },
    progress: { status: 'running', sessionMode: false, semanticState: null, stage: null, retrying: false,
      units: { total: 2, passed: 1, failed: 0 }, criteria: { total: 3, met: 1, unmet: 1, unshown: 1 } } };
}
function fixture(value: () => unknown | Promise<unknown> = snapshot) {
  const calls: Array<{ method: string; input: Record<string, unknown> | undefined; signal: AbortSignal | undefined }> = [];
  const invoke: OperatorRemoteClient['invoke'] = async <T>(method: string, input?: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
    calls.push({ method, input, signal: options?.signal });
    return await value() as T;
  };
  return { client: createOperatorNativeWorkExecutionClient({ invoke }, projectId), calls };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('native execution transport-only contract', () => {
  test('all four descriptors require fresh admin identity and both scopes with identical strict POST bodies', () => {
    const catalog = new GatewayMethodCatalog();
    for (const operation of operations) {
      const descriptor = catalog.get(`workLedger.execution.${operation}`)!;
      expect(descriptor.access).toBe('admin');
      expect(descriptor.scopes).toEqual(['read:work-ledger', 'write:fleet']);
      expect(descriptor.metadata?.['requiresFreshOperatorAuth']).toBe(true);
      expect(descriptor.http).toEqual({ method: 'POST', path: `/api/work-ledger/execution/${operation}` });
      expect(firstJsonSchemaFailure(descriptor.inputSchema!, { projectId, ...identity() })).toBeUndefined();
      expect(firstJsonSchemaFailure(descriptor.outputSchema!, snapshot())).toBeUndefined();
      expect(firstJsonSchemaFailure(descriptor.inputSchema!, { projectId, ...identity(), authority: {} })).toBeDefined();
      expect(firstJsonSchemaFailure(descriptor.outputSchema!, { ...snapshot(), source: 'private' })).toBeDefined();
    }
  });

  test('bounded IDs, safe revisions, and canonical contract statuses are shared by wire and descriptors', () => {
    for (const status of CONTRACT_STATUSES) {
      const value = snapshot(); value.progress!.status = status;
      expect(nativeWorkExecutionSnapshotSchema.safeParse(value).success).toBe(true);
    }
    for (const bad of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '1', null]) {
      expect(nativeWorkExecutionRequestSchema.safeParse({ projectId, ...identity(), expectedRevision: { work: bad, criteria: 0, attempt: 0 } }).success).toBe(false);
      const value = snapshot() as unknown as { progress: { units: { total: unknown }; criteria: { met: unknown } } };
      value.progress.units.total = bad; value.progress.criteria.met = bad;
      expect(nativeWorkExecutionSnapshotSchema.safeParse(value).success).toBe(false);
    }
    expect(nativeWorkExecutionRequestSchema.safeParse({ projectId, ...identity(), expectedRevision: { work: 0, criteria: Number.MAX_SAFE_INTEGER, attempt: 0 } }).success).toBe(true);
    for (const bad of ['', 'x'.repeat(201), null, 1]) {
      expect(nativeWorkExecutionRequestSchema.safeParse({ ...identity(), projectId: bad }).success).toBe(false);
      expect(nativeWorkExecutionIdentitySchema.safeParse({ ...identity(), workId: bad }).success).toBe(false);
      expect(nativeWorkExecutionIdentitySchema.safeParse({ ...identity(), attemptId: bad }).success).toBe(false);
    }
    const prepared = { ...snapshot(), state: 'prepared', receipt: null, progress: null, currentRevision: null, currentAttempt: false };
    expect(nativeWorkExecutionSnapshotSchema.safeParse(prepared).success).toBe(true);
    const unknownStatus = snapshot(); (unknownStatus.progress as { status: string }).status = 'complete';
    expect(nativeWorkExecutionSnapshotSchema.safeParse(unknownStatus).success).toBe(false);
  });

  test('the public package subpath is browser-safe and excludes host/authority imports', async () => {
    const path = join(import.meta.dir, '../sdk/src/platform/workflow/work-ledger/native-execution-client.ts');
    const bundled = await bundleBrowserEntrypoint(path);
    expect(bundled).not.toContain('createNativeWorkExecution');
    expect(bundled).not.toContain('captureJevDecisionContext');
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8'));
    expect(manifest.exports['./sdk/platform/workflow/work-ledger/native-execution-client']).toEqual({
      bun: './sdk/src/platform/workflow/work-ledger/native-execution-client.ts',
      types: './sdk/dist/platform/workflow/work-ledger/native-execution-client.d.ts',
      import: './sdk/dist/platform/workflow/work-ledger/native-execution-client.js',
    });
    for (const barrel of ['../sdk/src/platform/workflow/work-ledger/index.ts', '../operator-sdk/src/index.ts']) {
      expect(readFileSync(join(import.meta.dir, barrel), 'utf8')).not.toContain('native-execution-client');
    }
  });
});

describe('native execution operator client', () => {
  test('reuses the authenticated operator HTTP transport and exact catalog paths without legacy lookup', async () => {
    const requests: Request[] = [];
    const transport = createHttpTransport({
      baseUrl: 'http://127.0.0.1:9', authToken: 'synthetic-existing-token',
      fetch: async (input, init) => {
        const request = new Request(input, init); requests.push(request);
        return Response.json(new URL(request.url).pathname.endsWith('/project') ? { projectId } : snapshot());
      },
    });
    const remote = createOperatorRemoteClient(transport, buildOperatorContract(new GatewayMethodCatalog()));
    expect(await getOperatorWorkLedgerProject(remote)).toBe(projectId);
    const client = createOperatorNativeWorkExecutionClient(remote, projectId);
    for (const operation of operations) expect(await client[operation](identity())).toEqual(snapshot());
    expect(requests.map(request => new URL(request.url).pathname)).toEqual(['/api/work-ledger/project', ...operations.map(operation => `/api/work-ledger/execution/${operation}`)]);
    expect(requests[0]?.method).toBe('GET');
    for (const request of requests) expect(request.headers.get('authorization')).toBe('Bearer synthetic-existing-token');
    for (const request of requests.slice(1)) {
      expect(request.method).toBe('POST'); expect(await request.json()).toEqual({ projectId, ...identity() });
    }
    client.dispose(); expect(requests).toHaveLength(5);
  });

  test('uses only invoke, sends existing attempt identity, and returns a detached strict projection', async () => {
    const response = snapshot(); const f = fixture(() => response);
    expect(Object.keys(f.client).sort()).toEqual(['cancel', 'dispose', 'resume', 'start', 'status']);
    expect(Object.isFrozen(f.client)).toBe(true);
    for (const operation of operations) {
      const result = await f.client[operation](identity());
      expect(result).toEqual(response);
      expect(result).not.toBe(response);
      expect(result.kind).toBe('execution');
      if (result.kind !== 'execution') throw new Error('Expected a native execution projection');
      expect(result.progress).not.toBe(response.progress);
    }
    expect(f.calls.map(call => call.method)).toEqual(operations.map(operation => `workLedger.execution.${operation}`));
    for (const call of f.calls) {
      expect(call.input).toEqual({ projectId, ...identity() });
      expect(call.signal).toBeInstanceOf(AbortSignal);
    }
    f.client.dispose(); expect(f.calls).toHaveLength(4);
  });

  test('rejects invalid input and injected authority before invoking the transport', async () => {
    const f = fixture();
    for (const field of ['projectId', 'root', 'source', 'action', 'authority', 'session', 'decisionContext']) {
      await expect(f.client.start({ ...identity(), [field]: 'injected' } as NativeWorkExecutionIdentity)).rejects.toMatchObject({ code: 'invalid_request' });
    }
    for (const input of [null, {}, { ...identity(), expectedRevision: { ...identity().expectedRevision, ledger: 1 } },
      { ...identity(), workId: '' }, { ...identity(), attemptId: 'x'.repeat(201) },
      { ...identity(), expectedRevision: { work: 0, criteria: -1, attempt: 0 } }]) {
      await expect(f.client.resume(input as NativeWorkExecutionIdentity)).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(f.calls).toHaveLength(0);
    expect(() => createOperatorNativeWorkExecutionClient({ invoke: async <T>() => snapshot() as T }, '')).toThrow('invalid_request');
    f.client.dispose();
  });

  test('rejects identity mismatch on every operation; only status/cancel preserve different admitted revisions', async () => {
    for (const operation of operations) {
      for (const field of ['projectId', 'workId', 'attemptId']) {
        const f = fixture(() => ({ ...snapshot(), [field]: 'another-identity' }));
        await expect(f.client[operation](identity())).rejects.toMatchObject({ code: 'invalid_response' }); f.client.dispose();
      }
      const value = snapshot(); value.expectedRevision = { work: 10, criteria: 11, attempt: 12 };
      const f = fixture(() => value);
      if (operation === 'status' || operation === 'cancel') expect((await f.client[operation](identity())).expectedRevision).toEqual(value.expectedRevision);
      else await expect(f.client[operation](identity())).rejects.toMatchObject({ code: 'invalid_response' });
      f.client.dispose();
    }
  });

  test('strict nested response schemas reject raw source/output/auth/context, missing fields, and oversized responses', async () => {
    const invalid = [
      { ...snapshot(), source: {} },
      { ...snapshot(), progress: { ...snapshot().progress, output: 'private' } },
      { ...snapshot(), receipt: { ...snapshot().receipt, auth: 'private' } },
      { ...snapshot(), currentRevision: { work: 1, criteria: 2, attempt: 3, decisionContext: {} } },
      { ...snapshot(), progress: { ...snapshot().progress, units: { total: 1, passed: 0, failed: 0, source: 'private' } } },
      { ...snapshot(), progress: { ...snapshot().progress, criteria: { total: 1, met: 0, unmet: 0, unshown: -1 } } },
      { ...snapshot(), progress: { ...snapshot().progress, stage: 'x'.repeat(201) } },
      { ...snapshot(), progress: undefined },
      { ...snapshot(), extra: 'x'.repeat(20_000) },
      null,
    ];
    for (const response of invalid) {
      const f = fixture(() => response);
      await expect(f.client.status(identity())).rejects.toMatchObject({ code: 'invalid_response' });
      expect(f.calls).toHaveLength(1); f.client.dispose();
    }
  });

  test('request revision is captured before caller mutation and cannot be changed by transport mutation', async () => {
    const input = identity();
    const invoke: OperatorRemoteClient['invoke'] = async <T>(_method: string, request?: Record<string, unknown>) => {
      expect(request).toEqual({ projectId, ...identity() });
      (request!['expectedRevision'] as { work: number }).work = 100;
      const response = snapshot(); response.expectedRevision.work = 100;
      return response as T;
    };
    const client = createOperatorNativeWorkExecutionClient({ invoke }, projectId);
    const pending = client.start(input); input.expectedRevision.work = 100;
    await expect(pending).rejects.toMatchObject({ code: 'invalid_response' }); client.dispose();
  });

  test('operator failures and codes propagate unchanged without retries or successful cancellation guesses', async () => {
    for (const operation of operations) {
      for (const code of ['UNAUTHORIZED', 'FORBIDDEN', 'NATIVE_WORK_STALE', 'NATIVE_WORK_RECOVERY_REQUIRED', 'CONNECTION_LOST']) {
        const error = Object.assign(new Error('synthetic operator failure'), { code, status: 503 });
        const f = fixture(() => { throw error; });
        await expect(f.client[operation](identity())).rejects.toBe(error);
        await Promise.resolve(); expect(f.calls).toHaveLength(1); f.client.dispose();
      }
    }
  });
});

describe('native work host project discovery', () => {
  test('requires fresh read-scoped admin authority and exposes only strict selected project identity', () => {
    const descriptor = new GatewayMethodCatalog().get('workLedger.project')!;
    expect(descriptor.http).toEqual({ method: 'GET', path: '/api/work-ledger/project' });
    expect(descriptor.access).toBe('admin'); expect(descriptor.scopes).toEqual(['read:work-ledger']);
    expect(descriptor.metadata?.['requiresFreshOperatorAuth']).toBe(true);
    expect(firstJsonSchemaFailure(descriptor.inputSchema!, {})).toBeUndefined();
    expect(firstJsonSchemaFailure(descriptor.inputSchema!, { projectId })).toBeDefined();
    expect(firstJsonSchemaFailure(descriptor.outputSchema!, { projectId })).toBeUndefined();
    expect(firstJsonSchemaFailure(descriptor.outputSchema!, { projectId, allowedActions: ['start'] })).toBeDefined();
  });

  test('invalid or oversized discovery is rejected and operator failures retain codes', async () => {
    for (const response of [null, {}, { projectId: '' }, { projectId: 'x'.repeat(201) }, { projectId, authority: {} }, { projectId, source: 'x'.repeat(20_000) }]) {
      const invoke: OperatorRemoteClient['invoke'] = async <T>() => response as T;
      await expect(getOperatorWorkLedgerProject({ invoke })).rejects.toMatchObject({ code: 'invalid_response' });
    }
    const error = Object.assign(new Error('synthetic forbidden'), { code: 'FORBIDDEN', status: 403 }); let calls = 0;
    const invoke: OperatorRemoteClient['invoke'] = async () => { calls++; throw error; };
    await expect(getOperatorWorkLedgerProject({ invoke })).rejects.toBe(error); expect(calls).toBe(1);
  });

  test('discovery abort stops local transport and rejects late or reentrant completion', async () => {
    const gate = deferred<unknown>(); let signal: AbortSignal | undefined; let calls = 0;
    const invoke: OperatorRemoteClient['invoke'] = async <T>(method: string, input?: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
      expect(method).toBe('workLedger.project'); expect(input).toEqual({}); calls++; signal = options?.signal;
      return await gate.promise as T;
    };
    const controller = new AbortController(); const remove = spyOn(controller.signal, 'removeEventListener');
    const pending = getOperatorWorkLedgerProject({ invoke }, { signal: controller.signal });
    await Promise.resolve(); controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' }); expect(signal?.aborted).toBe(true);
    gate.resolve({ projectId }); await Promise.resolve(); expect(calls).toBe(1); expect(remove).toHaveBeenCalledTimes(1);
    await expect(getOperatorWorkLedgerProject({ invoke }, { signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' }); expect(calls).toBe(1);
    remove.mockRestore();
    const reentrant = new AbortController();
    const response = Object.defineProperty({}, 'projectId', { get() { reentrant.abort(); return projectId; }, enumerable: true });
    await expect(getOperatorWorkLedgerProject({ invoke: async <T>() => response as T }, { signal: reentrant.signal })).rejects.toMatchObject({ code: 'aborted' });
  });
});

describe('native execution client local lifecycle', () => {
  test('pre-abort/dispose never launches, and dispose does not call server cancellation', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await expect(f.client.start(identity(), { signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' });
    const pending = f.client.start(identity()); f.client.dispose(); f.client.dispose();
    await expect(pending).rejects.toMatchObject({ code: 'disposed' });
    for (const operation of operations) await expect(f.client[operation](identity())).rejects.toMatchObject({ code: 'disposed' });
    expect(f.calls).toHaveLength(0);
  });

  test('abort rejects a hung transport promptly, cleans listeners, and cannot accept its late receipt', async () => {
    const gate = deferred<unknown>(); const f = fixture(() => gate.promise);
    const controller = new AbortController(); const remove = spyOn(controller.signal, 'removeEventListener');
    const pending = f.client.start(identity(), { signal: controller.signal });
    await Promise.resolve(); expect(f.calls).toHaveLength(1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(f.calls[0]?.signal?.aborted).toBe(true); expect(remove).toHaveBeenCalledTimes(1);
    gate.resolve(snapshot()); await Promise.resolve();
    expect(f.calls).toHaveLength(1); f.client.dispose(); remove.mockRestore();
  });

  test('dispose aborts all pending transports, owns late rejections, and never disposes the shared client', async () => {
    const gates = operations.map(() => deferred<unknown>()); let calls = 0;
    const f = fixture(() => gates[calls++]!.promise);
    const pending = operations.map(operation => f.client[operation](identity()).catch(error => error));
    await Promise.resolve(); expect(f.calls).toHaveLength(4);
    f.client.dispose();
    for (const result of pending) expect(await result).toMatchObject({ code: 'disposed' });
    expect(f.calls.every(call => call.signal?.aborted)).toBe(true);
    gates[0]!.resolve(snapshot()); gates[1]!.reject(new Error('late connection loss'));
    gates[2]!.resolve(snapshot()); gates[3]!.reject(new Error('late connection loss'));
    await Promise.resolve(); expect(f.calls).toHaveLength(4);
  });

  test('a completed operation detaches external abort and leaves subsequent requests usable', async () => {
    const f = fixture(); const controller = new AbortController(); const remove = spyOn(controller.signal, 'removeEventListener');
    expect(await f.client.status(identity(), { signal: controller.signal })).toEqual(snapshot());
    expect(remove).toHaveBeenCalledTimes(1); controller.abort();
    expect(f.calls[0]?.signal?.aborted).toBe(false);
    expect(await f.client.status(identity())).toEqual(snapshot()); f.client.dispose(); remove.mockRestore();
  });

  test('reentrant disposal during invoke or response validation fences otherwise successful results', async () => {
    const f = fixture(() => { f.client.dispose(); return snapshot(); });
    await expect(f.client.start(identity())).rejects.toMatchObject({ code: 'disposed' });
    const response = snapshot();
    const g = fixture(() => Object.defineProperty(response, 'stale', { get() { g.client.dispose(); return false; }, enumerable: true }));
    await expect(g.client.status(identity())).rejects.toMatchObject({ code: 'disposed' });
    expect(g.calls).toHaveLength(1);
  });
});

describe('native admission intent projections', () => {
  const common = () => ({ projectId, ...identity(), currentRevision: { work: 1, criteria: 2, attempt: 3 }, currentAttempt: true, stale: false });
  test('intent branches carry no fake receipt, progress, decision or authority', async () => {
    const observations = [
      { kind: 'pending-intent', ...common(), state: 'admitting', recovery: 'pending' },
      { kind: 'pending-intent', ...common(), state: 'refused', recovery: 'required' },
      { kind: 'prevented-before-admission', ...common(), state: 'cancelled', recovery: 'cancelled' },
    ] satisfies readonly NativeWorkExecutionSnapshot[];
    for (const value of observations) {
      expect(nativeWorkExecutionSnapshotSchema.safeParse(value).success).toBe(true);
      for (const extra of [{ receipt: null }, { progress: null }, { decision: {} }, { authorityId: 'forged' }])
        expect(nativeWorkExecutionSnapshotSchema.safeParse({ ...value, ...extra }).success).toBe(false);
      const f = fixture(() => value); expect(await f.client.status(identity())).toEqual(value); f.client.dispose();
    }
  });
  test('start and resume preserve identity checks for intent results too', async () => {
    const f = fixture(() => ({ kind: 'prevented-before-admission', ...common(), expectedRevision: { work: 9, criteria: 2, attempt: 3 }, state: 'cancelled', recovery: 'cancelled' }));
    await expect(f.client.start(identity())).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(f.client.resume(identity())).rejects.toMatchObject({ code: 'invalid_response' });
    expect((await f.client.cancel(identity())).kind).toBe('prevented-before-admission'); f.client.dispose();
  });
});

test('generated typed IO preserves literal intent discrimination', async () => {
  const { renderType } = await import('../scripts/foundation-io-render.js');
  const output = new GatewayMethodCatalog().get('workLedger.execution.status')!.outputSchema!;
  const rendered = renderType(output);
  for (const kind of ['execution', 'pending-intent', 'prevented-before-admission']) expect(rendered).toContain(JSON.stringify(kind));
  expect(firstJsonSchemaFailure(output, { kind: 'pending-intent', projectId, ...identity(), currentRevision: null,
    currentAttempt: false, stale: true, state: 'admitting', recovery: 'required', receipt: null })).toBeDefined();
});
