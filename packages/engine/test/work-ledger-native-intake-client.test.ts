import { describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundleBrowserEntrypoint } from './_helpers/browser-bundle.ts';
import {
  createOperatorNativeConversationIntakeClient, nativeConversationIntakeCaptureRequestSchema,
  nativeConversationIntakeResultSchema, nativeConversationIntakeLookupResultSchema, nativeConversationIntakeWorkReceiptSchema,
  type NativeConversationIntakeCaptureRequest, type NativeConversationIntakeWorkReceipt, type NativeConversationIntakeResult,
} from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client';
import { createOperatorRemoteClient, type OperatorRemoteClient } from '../operator-sdk/src/client-core.js';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { buildOperatorContract } from '../sdk/src/platform/control-plane/operator-contract.js';
import { createHttpTransport, firstJsonSchemaFailure } from '../transport-http/src/index.js';
const projectId = 'conversation-project';
const sourceRef = { version: 1 as const, inputId: 'input-1', sourceId: 'source-1', sourceRevision: 'revision-1', sessionId: 'session-1' };
function capture(): NativeConversationIntakeCaptureRequest { return { requestId: 'request-1', inputId: sourceRef.inputId, text: '  Build café e\u0301 🧭\r\n', unsupportedSources: [] }; }
const transition = () => ({ inputId: sourceRef.inputId, sourceRevision: sourceRef.sourceRevision });
const common = () => ({ projectId, requestId: capture().requestId, sourceRef: { ...sourceRef } });
const captured = (): NativeConversationIntakeResult => ({ kind: 'captured', ...common() });
function receipt(): NativeConversationIntakeWorkReceipt { return { projectId, requestId: capture().requestId, inputId: sourceRef.inputId, ledgerRevision: 1,
  workId: 'work-1', attemptId: 'attempt-1', expectedRevision: { work: 1, criteria: 1, attempt: 1 }, goal: capture().text, criteria: [capture().text],
  source: { version: 2, sourceId: sourceRef.sourceId, sourceRevision: sourceRef.sourceRevision, sessionId: sourceRef.sessionId,
    offsetEncoding: 'utf16', proposalRevision: 'proposal-1', spans: [{ partId: 'input', start: 0, end: capture().text.length }],
    admissionDecisionId: 'decision-1', judgmentDecisionIds: ['decision-1'] } }; }
const work = (): NativeConversationIntakeResult => ({ kind: 'work', ...common(), receipt: receipt() });
function fixture(value: () => unknown | Promise<unknown> = captured) {
  const calls: Array<{ method: string; input: Record<string, unknown> | undefined; signal: AbortSignal | undefined }> = [];
  const invoke: OperatorRemoteClient['invoke'] = async <T>(method: string, input?: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
    calls.push({ method, input, signal: options?.signal }); return await value() as T;
  };
  return { client: createOperatorNativeConversationIntakeClient({ invoke }, projectId), calls };
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const operations = ['capture', 'get', 'admit', 'resume', 'cancel'] as const;

describe('native conversation intake browser contract', () => {
  test('strict paired-owner descriptors expose all five POST operations and no caller authority', () => {
    const catalog = new GatewayMethodCatalog();
    for (const operation of operations) {
      const descriptor = catalog.get(`workLedger.intake.${operation}`)!;
      const request = operation === 'capture' ? capture() : operation === 'get' ? { inputId: sourceRef.inputId } : transition();
      expect(descriptor.access).toBe('admin'); expect(descriptor.scopes).toEqual(['read:work-ledger', 'write:work-ledger']);
      expect(descriptor.metadata?.['requiresFreshOperatorAuth']).toBe(true);
      expect(descriptor.http).toEqual({ method: 'POST', path: `/api/work-ledger/intake/${operation}` });
      expect(firstJsonSchemaFailure(descriptor.inputSchema!, request)).toBeUndefined();
      expect(firstJsonSchemaFailure(descriptor.outputSchema!, work())).toBeUndefined();
      for (const field of ['projectId', 'actorId', 'sessionId', 'sourceId', 'source', 'proofs', 'model', 'root', 'goal', 'criteria', 'authority'])
        expect(firstJsonSchemaFailure(descriptor.inputSchema!, { ...request, [field]: 'forged' })).toBeDefined();
    }
  });
  test('preserves exact Unicode and whitespace; disclosures required, bounded and strict', () => {
    expect(nativeConversationIntakeCaptureRequestSchema.parse(capture())).toEqual(capture());
    for (const text of ['', ' \t\r\n', 'x'.repeat(20_001), '🧭'.repeat(10_001)]) expect(nativeConversationIntakeCaptureRequestSchema.safeParse({ ...capture(), text }).success).toBe(false);
    expect(nativeConversationIntakeCaptureRequestSchema.safeParse({ ...capture(), text: '🧭'.repeat(10_000) }).success).toBe(true);
    for (const unsupportedSources of [undefined, null, Array(101).fill({ kind: 'image', label: 'one' }), [{ kind: 'image', label: 'one', url: 'injected' }]])
      expect(nativeConversationIntakeCaptureRequestSchema.safeParse({ ...capture(), unsupportedSources }).success).toBe(false);
    expect(nativeConversationIntakeCaptureRequestSchema.safeParse({ ...capture(), unsupportedSources: [{ kind: 'image', label: 'image-1' }, { kind: 'context', label: 'earlier message' }] }).success).toBe(true);
    // The largest valid escaped text/disclosure combination fits the complete request ceiling.
    expect(nativeConversationIntakeCaptureRequestSchema.safeParse({ ...capture(), text: '\u0001'.repeat(20_000), unsupportedSources: Array(100).fill({ kind: 'file', label: '\u0001'.repeat(200) }) }).success).toBe(true);
  });
  test('all public outcomes remain distinct, with exact immutable span provenance', () => {
    const results: NativeConversationIntakeResult[] = [captured(), work(), { kind: 'processing', ...common(), stage: 'checking', recovery: 'required' },
      { kind: 'turn', ...common(), route: 'answer', text: 'Source retained' }, { kind: 'blocked', ...common(), reason: 'unsupported-source', recovery: 'required' },
      { kind: 'refused', ...common(), reason: 'exhausted' }, { kind: 'cancelled', ...common() }];
    for (const result of results) { expect(nativeConversationIntakeResultSchema.parse(result)).toEqual(result); expect(nativeConversationIntakeResultSchema.safeParse({ ...result, execution: {} }).success).toBe(false); }
    expect(nativeConversationIntakeLookupResultSchema.parse({ kind: 'not-found' })).toEqual({ kind: 'not-found' });
    expect(nativeConversationIntakeResultSchema.safeParse({ kind: 'not-found' }).success).toBe(false);
    const original = receipt();
    for (const changed of [{ ...original, criteria: ['changed'] }, { ...original, source: { ...original.source, sessionId: 'different' } },
      { ...original, source: { ...original.source, decision: {} } }, { ...original, source: { ...original.source, version: 1 } }]) {
      expect(nativeConversationIntakeResultSchema.safeParse({ kind: 'work', ...common(), receipt: changed }).success).toBe(false);
    }
    const split = receipt(); const position = split.goal.indexOf('🧭'); split.criteria = [split.goal.slice(position + 1, position + 2)];
    split.source.spans = [{ partId: 'input', start: position + 1, end: position + 2 }];
    expect(nativeConversationIntakeWorkReceiptSchema.safeParse(split).success).toBe(false);
    const reordered = receipt(); reordered.criteria = ['Build', '  ']; reordered.source.spans = [{ partId: 'input', start: 2, end: 7 }, { partId: 'input', start: 0, end: 2 }];
    expect(nativeConversationIntakeWorkReceiptSchema.safeParse(reordered).success).toBe(false);
  });
  test('the explicit public client bundles for browsers without host or execution modules', async () => {
    const bundled = await bundleBrowserEntrypoint(join(import.meta.dir, '../sdk/src/platform/workflow/work-ledger/native-intake-client.ts'));
    for (const symbol of ['createNativeConversationIntakeHost', 'captureJevDecisionContext', 'createNativeWorkExecutionHost', 'createWorkLedgerService']) expect(bundled).not.toContain(symbol);
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8'));
    expect(manifest.exports['./sdk/platform/workflow/work-ledger/native-intake-client']).toEqual({ bun: './sdk/src/platform/workflow/work-ledger/native-intake-client.ts', types: './sdk/dist/platform/workflow/work-ledger/native-intake-client.d.ts', import: './sdk/dist/platform/workflow/work-ledger/native-intake-client.js' });
    for (const barrel of ['../sdk/src/platform/workflow/work-ledger/index.ts', '../operator-sdk/src/index.ts']) expect(readFileSync(join(import.meta.dir, barrel), 'utf8')).not.toContain('native-intake-client');
  });
});

describe('native conversation intake operator client', () => {
  test('authenticated HTTP carries only exact capture or source identities without implicit execution', async () => {
    const requests: Request[] = [];
    const transport = createHttpTransport({ baseUrl: 'http://127.0.0.1:9', authToken: 'synthetic-existing-token', fetch: async (url, init) => {
      requests.push(new Request(url, init)); return Response.json(captured());
    } });
    const remote = createOperatorRemoteClient(transport, buildOperatorContract(new GatewayMethodCatalog()));
    const client = createOperatorNativeConversationIntakeClient(remote, projectId);
    await client.capture(capture()); await client.get({ inputId: sourceRef.inputId }); await client.admit(transition()); await client.resume(transition()); await client.cancel(transition());
    expect(requests.map(request => new URL(request.url).pathname)).toEqual(operations.map(operation => `/api/work-ledger/intake/${operation}`));
    for (const request of requests) { expect(request.method).toBe('POST'); expect(request.headers.get('authorization')).toBe('Bearer synthetic-existing-token'); }
    expect(await requests[0]!.json()).toEqual(capture()); expect(await requests[1]!.json()).toEqual({ inputId: sourceRef.inputId });
    for (const request of requests.slice(2)) expect(await request.json()).toEqual(transition());
    client.dispose(); expect(requests).toHaveLength(5);
  });
  test('rejects malformed requests before transport and strict oversized responses after transport', async () => {
    const f = fixture();
    for (const field of ['projectId', 'source', 'proof', 'criteria', 'authority']) await expect(f.client.capture({ ...capture(), [field]: 'forged' } as NativeConversationIntakeCaptureRequest)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(f.client.admit({ ...transition(), sourceRevision: '' })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.calls).toHaveLength(0); f.client.dispose();
    for (const response of [null, { kind: 'not-found' }, { ...captured(), proof: {} }, { ...captured(), huge: 'x'.repeat(300_000) }]) {
      const bad = fixture(() => response); await expect(bad.client.capture(capture())).rejects.toMatchObject({ code: 'invalid_response' }); bad.client.dispose();
    }
  });
  test('pins selected project, request identity and source across responses and exact original work goal', async () => {
    for (const changed of [{ projectId: 'different' }, { requestId: 'different' }, { sourceRef: { ...sourceRef, inputId: 'different' } }]) {
      const f = fixture(() => ({ ...captured(), ...changed })); await expect(f.client.capture(capture())).rejects.toMatchObject({ code: 'invalid_response' }); f.client.dispose();
    }
    for (const field of ['sourceId', 'sourceRevision', 'sessionId']) {
      let value: unknown = captured(); const f = fixture(() => value); const returned = await f.client.capture(capture()); returned.sourceRef.sourceId = 'caller-mutated';
      value = { ...captured(), sourceRef: { ...sourceRef, [field]: 'different' } };
      await expect(f.client.get({ inputId: sourceRef.inputId })).rejects.toMatchObject({ code: 'invalid_response' }); f.client.dispose();
    }
    const stale = fixture(); await expect(stale.client.admit({ ...transition(), sourceRevision: 'other' })).rejects.toMatchObject({ code: 'invalid_response' }); stale.client.dispose();
    const changedTurn = fixture(() => ({ kind: 'turn', ...common(), route: 'answer', text: 'Changed original text' }));
    await expect(changedTurn.client.capture(capture())).rejects.toMatchObject({ code: 'invalid_response' }); changedTurn.client.dispose();
    const changed = receipt(); changed.goal = 'Other'; changed.criteria = ['Other']; changed.source.spans = [{ partId: 'input', start: 0, end: 5 }];
    const bad = fixture(() => ({ kind: 'work', ...common(), receipt: changed })); await expect(bad.client.capture(capture())).rejects.toMatchObject({ code: 'invalid_response' }); bad.client.dispose();
  });
  test('caller and transport mutation cannot change the request identity fence', async () => {
    const invoke: OperatorRemoteClient['invoke'] = async <T>(_method: string, input?: Record<string, unknown>) => { input!['inputId'] = 'mutated'; return { ...captured(), sourceRef: { ...sourceRef, inputId: 'mutated' } } as T; };
    const client = createOperatorNativeConversationIntakeClient({ invoke }, projectId); const original = capture(); const pending = client.capture(original); original.inputId = 'mutated';
    await expect(pending).rejects.toMatchObject({ code: 'invalid_response' }); client.dispose();
  });
  test('lost responses propagate unchanged; only explicit lookup or resume can recover', async () => {
    const error = new Error('response lost'); let value: unknown = error;
    const f = fixture(() => { if (value === error) throw error; return value; });
    await expect(f.client.admit(transition())).rejects.toBe(error); await Promise.resolve(); expect(f.calls).toHaveLength(1);
    const recovered = { kind: 'processing', ...common(), stage: 'waiting', recovery: 'required' } satisfies NativeConversationIntakeResult;
    value = recovered;
    expect(await f.client.get({ inputId: sourceRef.inputId })).toEqual(recovered); expect(f.calls.map(call => call.method)).toEqual(['workLedger.intake.admit', 'workLedger.intake.get']); f.client.dispose();
  });
  test('abort/dispose detach even when transports ignore signals and late failures stay observed', async () => {
    for (const mode of ['abort', 'dispose'] as const) {
      const pending = deferred<unknown>(); const f = fixture(() => pending.promise); const controller = new AbortController();
      const result = f.client.admit(transition(), { signal: controller.signal }); await Promise.resolve();
      if (mode === 'abort') controller.abort(); else f.client.dispose();
      await expect(result).rejects.toMatchObject({ code: mode === 'abort' ? 'aborted' : 'disposed' }); expect(f.calls[0]!.signal!.aborted).toBe(true);
      pending.reject(new Error('late transport rejection')); await Promise.resolve(); expect(f.calls).toHaveLength(1); f.client.dispose();
    }
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await expect(f.client.capture(capture(), { signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' });
    const pending = f.client.capture(capture()); f.client.dispose(); await expect(pending).rejects.toMatchObject({ code: 'disposed' }); expect(f.calls).toHaveLength(0);
  });
  test('request cleanup retains the original signal when callers mutate the options object', async () => {
    const pending = deferred<unknown>(); const f = fixture(() => pending.promise); const first = new AbortController(); const second = new AbortController();
    const remove = spyOn(first.signal, 'removeEventListener'); const options = { signal: first.signal };
    const result = f.client.capture(capture(), options); await Promise.resolve(); options.signal = second.signal;
    pending.resolve(captured()); expect(await result).toEqual(captured()); expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    remove.mockRestore(); f.client.dispose();
  });
  test('reentrant disposal during response validation cannot return success', async () => {
    const f = fixture(() => Object.defineProperty(captured(), 'requestId', { get() { f.client.dispose(); return capture().requestId; }, enumerable: true }));
    await expect(f.client.capture(capture())).rejects.toMatchObject({ code: 'disposed' }); expect(f.calls).toHaveLength(1);
  });
});
