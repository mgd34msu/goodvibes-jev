import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundleBrowserEntrypoint } from './_helpers/browser-bundle.ts';
import {
  createOperatorNativeWorkSubmissionClient,
  NATIVE_WORK_SUBMISSION_MAX_REQUEST_BYTES,
  NATIVE_WORK_SUBMISSION_MAX_RESPONSE_BYTES,
  nativeWorkSubmissionRequestSchema,
  nativeWorkSubmissionLookupRequestSchema,
  nativeWorkSubmissionReceiptSchema,
  nativeWorkSubmissionResultSchema,
  nativeWorkSubmissionLookupResultSchema,
  type NativeWorkSubmissionRequest,
  type NativeWorkSubmissionReceipt,
} from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-submission-client';
import { createOperatorRemoteClient, type OperatorRemoteClient } from '../operator-sdk/src/client-core.js';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { buildOperatorContract } from '../sdk/src/platform/control-plane/operator-contract.js';
import { createHttpTransport, firstJsonSchemaFailure } from '../transport-http/src/index.js';

const projectId = 'native-submission-project';
function input(): NativeWorkSubmissionRequest {
  return { requestId: 'request-1', inputId: 'input-1', expectedRevision: 0,
    goal: '  Build café e\u0301 🧭\r\n', criteria: ['  first\n', 'duplicate', 'duplicate', 'é', 'e\u0301', '\tlast  '] };
}
function receipt(request = input()): NativeWorkSubmissionReceipt {
  return { projectId, requestId: request.requestId, inputId: request.inputId, ledgerRevision: 1,
    workId: 'work-1', attemptId: 'attempt-1', expectedRevision: { work: 1, criteria: 1, attempt: 1 },
    source: { version: 1, sourceId: 'source-1', sourceRevision: 'a'.repeat(64), sessionId: 'session-1' },
    goal: request.goal, criteria: [...request.criteria] };
}
function submitted(request = input(), replayed = false) { return { kind: 'submitted' as const, replayed, receipt: receipt(request) }; }
function fixture(value: () => unknown | Promise<unknown> = submitted) {
  const calls: Array<{ method: string; input: Record<string, unknown> | undefined; signal: AbortSignal | undefined }> = [];
  const invoke: OperatorRemoteClient['invoke'] = async <T>(method: string, request?: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
    calls.push({ method, input: request, signal: options?.signal });
    return await value() as T;
  };
  return { client: createOperatorNativeWorkSubmissionClient({ invoke }, projectId), calls };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe('native submission transport contract', () => {
  test('both descriptors require dedicated scopes and fresh admin auth with strict host-owned boundaries', () => {
    const catalog = new GatewayMethodCatalog();
    for (const [method, path, request, result] of [
      ['workLedger.submit', '/api/work-ledger/submissions', input(), submitted()],
      ['workLedger.submission.get', '/api/work-ledger/submissions/get', { requestId: 'request-1' }, { kind: 'found', receipt: receipt() }],
    ] as const) {
      const descriptor = catalog.get(method)!;
      expect(descriptor.access).toBe('admin');
      expect(descriptor.scopes).toEqual(['read:work-ledger', 'write:work-ledger']);
      expect(descriptor.metadata?.['requiresFreshOperatorAuth']).toBe(true);
      expect(descriptor.http).toEqual({ method: 'POST', path });
      expect(firstJsonSchemaFailure(descriptor.inputSchema!, request)).toBeUndefined();
      expect(firstJsonSchemaFailure(descriptor.outputSchema!, result)).toBeUndefined();
      for (const field of ['projectId', 'actorId', 'sourceId', 'sessionId', 'authority', 'source', 'criteriaMode', 'modelCriteria']) {
        expect(firstJsonSchemaFailure(descriptor.inputSchema!, { ...request, [field]: 'injected' })).toBeDefined();
      }
      expect(firstJsonSchemaFailure(descriptor.outputSchema!, { ...result, execution: {} })).toBeDefined();
    }
    const descriptor = catalog.get('workLedger.submit')!;
    expect(firstJsonSchemaFailure(descriptor.inputSchema!, { ...input(), goal: ' \n\t' })).toBeDefined();
  });

  test('preserves Unicode, whitespace, duplicate order, and exact complete escaped UTF-8 request size', () => {
    expect(nativeWorkSubmissionRequestSchema.parse(input())).toEqual(input());
    expect(nativeWorkSubmissionReceiptSchema.parse(receipt())).toEqual(receipt());
    const boundary = { ...input(), goal: 'g', criteria: [...Array<string>(13).fill('x'.repeat(19_000)), 'x'] };
    boundary.criteria[13] = 'x'.repeat(1 + NATIVE_WORK_SUBMISSION_MAX_REQUEST_BYTES - bytes(boundary));
    expect(bytes(boundary)).toBe(NATIVE_WORK_SUBMISSION_MAX_REQUEST_BYTES);
    expect(nativeWorkSubmissionRequestSchema.safeParse(boundary).success).toBe(true);
    boundary.criteria[13] += 'x';
    expect(nativeWorkSubmissionRequestSchema.safeParse(boundary).success).toBe(false);
    for (const text of ['🧭'.repeat(10_000), '\u0001'.repeat(20_000)]) {
      const oversized = { ...input(), criteria: Array<string>(7).fill(text) };
      expect(bytes(oversized)).toBeGreaterThan(NATIVE_WORK_SUBMISSION_MAX_REQUEST_BYTES);
      expect(nativeWorkSubmissionRequestSchema.safeParse(oversized).success).toBe(false);
    }
  });

  test('rejects blank text, invalid counts, unsafe revisions and excess nested fields without coercion', () => {
    for (const value of ['', ' \t\r\n', '\u00a0', 'x'.repeat(20_001), null, 1]) {
      expect(nativeWorkSubmissionRequestSchema.safeParse({ ...input(), goal: value }).success).toBe(false);
      expect(nativeWorkSubmissionRequestSchema.safeParse({ ...input(), criteria: [value] }).success).toBe(false);
    }
    for (const value of [[], Array<string>(101).fill('criterion'), 'one', null]) {
      expect(nativeWorkSubmissionRequestSchema.safeParse({ ...input(), criteria: value }).success).toBe(false);
    }
    for (const expectedRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '1', null]) {
      expect(nativeWorkSubmissionRequestSchema.safeParse({ ...input(), expectedRevision }).success).toBe(false);
    }
    expect(nativeWorkSubmissionRequestSchema.safeParse({ ...input(), expectedRevision: Number.MAX_SAFE_INTEGER }).success).toBe(true);
    expect(nativeWorkSubmissionLookupRequestSchema.safeParse({ requestId: 'request-1', projectId }).success).toBe(false);
    expect(nativeWorkSubmissionReceiptSchema.safeParse({ ...receipt(), source: { ...receipt().source, authority: {} } }).success).toBe(false);
    expect(nativeWorkSubmissionLookupResultSchema.safeParse({ kind: 'not-found', receipt: receipt() }).success).toBe(false);
    expect(nativeWorkSubmissionResultSchema.safeParse({ ...submitted(), progress: {} }).success).toBe(false);
    const oversized = submitted(); oversized.receipt.criteria = Array<string>(100).fill('x'.repeat(20_000));
    expect(bytes(oversized)).toBeGreaterThan(NATIVE_WORK_SUBMISSION_MAX_RESPONSE_BYTES);
    expect(nativeWorkSubmissionResultSchema.safeParse(oversized).success).toBe(false);
  });

  test('the narrow public client subpath bundles for browser with no host or execution authority', async () => {
    const bundled = await bundleBrowserEntrypoint(join(import.meta.dir, '../sdk/src/platform/workflow/work-ledger/native-submission-client.ts'));
    for (const hostSymbol of ['createNativeWorkExecution', 'captureJevDecisionContext', 'captureNativeContractSource', 'createWorkLedgerService']) expect(bundled).not.toContain(hostSymbol);
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8'));
    expect(manifest.exports['./sdk/platform/workflow/work-ledger/native-submission-client']).toEqual({
      bun: './sdk/src/platform/workflow/work-ledger/native-submission-client.ts',
      types: './sdk/dist/platform/workflow/work-ledger/native-submission-client.d.ts',
      import: './sdk/dist/platform/workflow/work-ledger/native-submission-client.js',
    });
    for (const barrel of ['../sdk/src/platform/workflow/work-ledger/index.ts', '../operator-sdk/src/index.ts']) {
      expect(readFileSync(join(import.meta.dir, barrel), 'utf8')).not.toContain('native-submission-client');
    }
  });
});

describe('native submission operator client', () => {
  test('uses selected authenticated HTTP transport, exact POST bodies, and explicit receipt lookup', async () => {
    const requests: Request[] = [];
    const transport = createHttpTransport({ baseUrl: 'http://127.0.0.1:9', authToken: 'synthetic-existing-token',
      fetch: async (url, init) => {
        const request = new Request(url, init); requests.push(request);
        return Response.json(new URL(request.url).pathname.endsWith('/get') ? { kind: 'found', receipt: receipt() } : submitted());
      } });
    const remote = createOperatorRemoteClient(transport, buildOperatorContract(new GatewayMethodCatalog()));
    const client = createOperatorNativeWorkSubmissionClient(remote, projectId);
    expect(await client.submit(input())).toEqual(submitted());
    expect(await client.get({ requestId: 'request-1' })).toEqual({ kind: 'found', receipt: receipt() });
    expect(requests.map(request => new URL(request.url).pathname)).toEqual(['/api/work-ledger/submissions', '/api/work-ledger/submissions/get']);
    for (const request of requests) {
      expect(request.method).toBe('POST'); expect(request.headers.get('authorization')).toBe('Bearer synthetic-existing-token');
    }
    expect(await requests[0]!.json()).toEqual(input());
    expect(await requests[1]!.json()).toEqual({ requestId: 'request-1' });
    client.dispose(); expect(requests).toHaveLength(2);
  });

  test('returns detached exact submit/replay receipts without any execution call or implicit retry', async () => {
    const response = submitted(input(), true); const f = fixture(() => response);
    const result = await f.client.submit(input());
    expect(result).toEqual(response); expect(result.receipt).not.toBe(response.receipt);
    expect(result.receipt.criteria).not.toBe(response.receipt.criteria);
    expect(Object.keys(f.client).sort()).toEqual(['dispose', 'get', 'submit']); expect(Object.isFrozen(f.client)).toBe(true);
    expect(f.calls.map(call => call.method)).toEqual(['workLedger.submit']);
    f.client.dispose(); expect(f.calls).toHaveLength(1);
    const missing = fixture(() => ({ kind: 'not-found' }));
    expect(await missing.client.get({ requestId: 'request-1' })).toEqual({ kind: 'not-found' }); missing.client.dispose();
  });

  test('rejects injected host fields and excessive complete input before invoking transport', async () => {
    const f = fixture();
    for (const field of ['projectId', 'actorId', 'workId', 'attemptId', 'sessionId', 'sourceId', 'authority', 'modelCriteria', 'criteriaMode']) {
      await expect(f.client.submit({ ...input(), [field]: 'injected' } as NativeWorkSubmissionRequest)).rejects.toMatchObject({ code: 'invalid_request' });
    }
    await expect(f.client.submit({ ...input(), criteria: Array<string>(100).fill('x'.repeat(20_000)) })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(f.client.get({ requestId: '', projectId } as { requestId: string })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.calls).toHaveLength(0); f.client.dispose();
    expect(() => createOperatorNativeWorkSubmissionClient({ invoke: async <T>() => submitted() as T }, '')).toThrow('invalid_request');
  });

  test('pins host and request identity for submit/get and exact input content for submit', async () => {
    for (const operation of ['submit', 'get'] as const) {
      for (const field of ['projectId', 'requestId']) {
        const bad = { ...receipt(), [field]: 'different' };
        const f = fixture(() => operation === 'submit' ? { ...submitted(), receipt: bad } : { kind: 'found', receipt: bad });
        await expect(operation === 'submit' ? f.client.submit(input()) : f.client.get({ requestId: 'request-1' })).rejects.toMatchObject({ code: 'invalid_response' });
        f.client.dispose();
      }
    }
    for (const changed of [{ inputId: 'different' }, { goal: input().goal.trim() }, { criteria: [...input().criteria].reverse() }, { criteria: [...new Set(input().criteria)] }]) {
      const f = fixture(() => ({ ...submitted(), receipt: { ...receipt(), ...changed } }));
      await expect(f.client.submit(input())).rejects.toMatchObject({ code: 'invalid_response' }); f.client.dispose();
    }
  });

  test('captures input before caller changes and protects validation against transport mutation', async () => {
    const original = input();
    const invoke: OperatorRemoteClient['invoke'] = async <T>(_method: string, request?: Record<string, unknown>) => {
      expect(request).toEqual(input());
      (request!['criteria'] as string[])[0] = 'changed by transport';
      return submitted(request as NativeWorkSubmissionRequest) as T;
    };
    const client = createOperatorNativeWorkSubmissionClient({ invoke }, projectId);
    const pending = client.submit(original); original.criteria[0] = 'changed by caller';
    await expect(pending).rejects.toMatchObject({ code: 'invalid_response' }); client.dispose();
  });

  test('rejects raw execution/output/auth fields, malformed nested receipts, and oversized responses', async () => {
    for (const response of [null, { kind: 'not-found' }, { ...submitted(), execution: {} },
      { ...submitted(), receipt: { ...receipt(), expectedRevision: { ...receipt().expectedRevision, ledger: 1 } } },
      { ...submitted(), receipt: { ...receipt(), source: { ...receipt().source, auth: 'private' } } },
      { ...submitted(), receipt: { ...receipt(), goal: undefined } },
      { ...submitted(), receipt: { ...receipt(), criteria: Array<string>(100).fill('x'.repeat(20_000)) } }]) {
      const f = fixture(() => response);
      await expect(f.client.submit(input())).rejects.toMatchObject({ code: 'invalid_response' }); f.client.dispose();
    }
  });

  test('lost responses propagate unchanged; recovery is caller-directed lookup with stable request ID', async () => {
    const error = Object.assign(new Error('response lost after persistence'), { code: 'CONNECTION_LOST' });
    let next: unknown = error;
    const f = fixture(() => { if (next === error) throw error; return next; });
    await expect(f.client.submit(input())).rejects.toBe(error);
    await Promise.resolve(); expect(f.calls).toHaveLength(1);
    next = { kind: 'found', receipt: receipt() };
    expect(await f.client.get({ requestId: input().requestId })).toEqual({ kind: 'found', receipt: receipt() });
    expect(f.calls.map(call => call.method)).toEqual(['workLedger.submit', 'workLedger.submission.get']); f.client.dispose();
  });

  test('abort/disposal detach promptly even if transport ignores signals; late results cannot become success', async () => {
    for (const mode of ['abort', 'dispose'] as const) {
      const pending = deferred<unknown>(); const f = fixture(() => pending.promise); const controller = new AbortController();
      const result = f.client.submit(input(), { signal: controller.signal });
      await Promise.resolve(); expect(f.calls).toHaveLength(1);
      if (mode === 'abort') controller.abort(); else f.client.dispose();
      await expect(result).rejects.toMatchObject({ code: mode === 'abort' ? 'aborted' : 'disposed', message: expect.stringContaining('server outcome is unknown') });
      expect(f.calls[0]!.signal!.aborted).toBe(true);
      pending.resolve(submitted()); await Promise.resolve();
      expect(f.calls).toHaveLength(1); f.client.dispose();
    }
  });

  test('pre-abort and same-turn disposal prevent invoke; disposal does not dispose shared operator', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await expect(f.client.submit(input(), { signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' });
    const pending = f.client.submit(input()); f.client.dispose();
    await expect(pending).rejects.toMatchObject({ code: 'disposed' });
    await expect(f.client.get({ requestId: 'request-1' })).rejects.toMatchObject({ code: 'disposed' });
    expect(f.calls).toHaveLength(0);
  });

  test('reentrant abort/disposal and late transport rejection stay fenced', async () => {
    for (const mode of ['abort', 'dispose'] as const) {
      const controller = new AbortController(); const pending = deferred<unknown>();
      const f = fixture(() => { if (mode === 'abort') controller.abort(); else f.client.dispose(); return pending.promise; });
      await expect(f.client.submit(input(), { signal: controller.signal })).rejects.toMatchObject({ code: mode === 'abort' ? 'aborted' : 'disposed' });
      pending.reject(new Error('late transport failure')); await Promise.resolve(); f.client.dispose();
      expect(f.calls).toHaveLength(1);
    }
  });
});
