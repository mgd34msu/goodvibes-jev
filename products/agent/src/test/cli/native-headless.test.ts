import { describe, expect, test } from 'bun:test';
import type { OperatorNativeWorkExecutionClient, NativeWorkExecutionSnapshot } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client';
import type { NativeConversationIntakeCaptureRequest, NativeConversationIntakeResult, OperatorNativeConversationIntakeClient, NativeConversationTurnPermit } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client';
import { NativeConversationIntakeControls, type NativeConversationIntakeSelection } from '../../runtime/native-conversation-intake.ts';
import type { NativeIntakeJournalBinding, NativeIntakeJournalRecord, NativeIntakeExecutionIntent } from '../../runtime/native-conversation-intake-journal.ts';
import { executeNativeHeadless as agentExecute, writeNativeHeadlessResult } from '../../cli/native-headless.ts';
import { executeNativeHeadless as tuiExecute } from '../../../../tui/src/cli/native-headless.ts';
const original = { text: '  Explain the answer\r\n界 e\u0301 😀  ', unsupportedSources: [] };
function fixture() {
  let identity = 'selected'; let principal = 'paired'; let ids = 0; let disposed = 0;
  const records = new Map<string, NativeIntakeJournalRecord>(); const calls: string[] = []; const captures: NativeConversationIntakeCaptureRequest[] = [];
  const server = new Map<string, NativeConversationIntakeResult>();
  let outcome: 'turn' | 'processing' | 'blocked' | 'refused' | 'work' = 'turn';
  const common = (request: NativeConversationIntakeCaptureRequest) => ({ projectId: 'project', requestId: request.requestId,
    sourceRef: { version: 1 as const, inputId: request.inputId, sourceId: `source-${request.inputId}`, sourceRevision: 'r1', sessionId: 'host-session' } });
  const settled = (request: NativeConversationIntakeCaptureRequest): NativeConversationIntakeResult => {
    const c = common(request);
    if (outcome === 'turn') return { kind: 'turn', ...c, route: 'answer', text: request.text };
    if (outcome === 'processing') return { kind: 'processing', ...c, stage: 'routing', recovery: 'required' };
    if (outcome === 'blocked') return { kind: 'blocked', ...c, reason: 'unsupported-source', recovery: 'required' };
    if (outcome === 'refused') return { kind: 'refused', ...c, reason: 'semantic' };
    return { kind: 'work', ...c, receipt: { projectId: c.projectId, requestId: c.requestId, inputId: request.inputId, ledgerRevision: 3, workId: 'real-work', attemptId: 'real-attempt', expectedRevision: { work: 1, criteria: 1, attempt: 1 }, source: { version: 2, sourceId: c.sourceRef.sourceId, sourceRevision: 'r1', sessionId: c.sourceRef.sessionId, offsetEncoding: 'utf16', proposalRevision: 'p1', spans: [{ partId: 'input', start: 0, end: request.text.length }], admissionDecisionId: 'admit-proof', judgmentDecisionIds: ['judgment'] }, goal: request.text, criteria: [request.text] } };
  };
  const client: OperatorNativeConversationIntakeClient = {
    async capture(request) { calls.push('capture'); captures.push(structuredClone(request)); const result: NativeConversationIntakeResult = { kind: 'captured', ...common(request) }; server.set(request.inputId, result); return result; },
    async get({ inputId }) { calls.push('get'); return server.get(inputId) ?? { kind: 'not-found' }; },
    async admit({ inputId }) { calls.push('admit'); const result = settled(captures.find(request => request.inputId === inputId)!); server.set(inputId, result); return result; },
    async resume({ inputId }) { calls.push('resume'); const result = settled(captures.find(request => request.inputId === inputId)!); server.set(inputId, result); return result; },
    async cancel({ inputId }) { calls.push('cancel'); const result: NativeConversationIntakeResult = { kind: 'cancelled', ...common(captures.find(request => request.inputId === inputId)!) }; server.set(inputId, result); return result; },
    bindTurn() { calls.push('bind'); return Object.freeze({}) as NativeConversationTurnPermit; },
    dispose() {},
  };
  const executions = new Map<string, NativeWorkExecutionSnapshot>();
  const execution: OperatorNativeWorkExecutionClient = {
    async status(target) { calls.push('execution-status'); const current = executions.get(target.attemptId); if (!current) throw { code: 'NATIVE_EXECUTION_NOT_FOUND' }; return current; },
    async start(target) { calls.push('execution-start'); const snapshot: NativeWorkExecutionSnapshot = { kind: 'pending-intent', projectId: 'project', ...target, currentRevision: { ...target.expectedRevision }, currentAttempt: true, stale: false, state: 'admitting', recovery: 'pending' }; executions.set(target.attemptId, snapshot); return snapshot; },
    async resume() { throw new Error('Unexpected automatic execution resume'); }, async cancel() { throw new Error('Unexpected automatic execution cancel'); }, dispose() {},
  };
  const key = (binding: NativeIntakeJournalBinding) => JSON.stringify(binding);
  const journal = {
    async read(binding: NativeIntakeJournalBinding) { calls.push('read'); return structuredClone(records.get(key(binding))); },
    async save(binding: NativeIntakeJournalBinding, command: NativeConversationIntakeCaptureRequest, expected: string | null) {
      calls.push('save'); if ((records.get(key(binding))?.command.requestId ?? null) !== expected) throw new Error('conflict');
      records.set(key(binding), structuredClone({ binding, command }));
    },
    async confirm(binding: NativeIntakeJournalBinding, command: NativeConversationIntakeCaptureRequest) { calls.push('confirm'); if (JSON.stringify(records.get(key(binding))?.command) !== JSON.stringify(command)) throw new Error('conflict'); },
    async saveExecutionIntent(binding: NativeIntakeJournalBinding, command: NativeConversationIntakeCaptureRequest, intent: NativeIntakeExecutionIntent) {
      calls.push('execution-intent'); const record = records.get(key(binding));
      if (!record || record.command.requestId !== command.requestId || record.dispatch) throw new Error('conflict');
      if (record.execution && JSON.stringify(record.execution) !== JSON.stringify(intent)) throw new Error('conflict');
      records.set(key(binding), { ...record, execution: structuredClone(intent) });
    },
    async claimTurn(binding: NativeIntakeJournalBinding, command: NativeConversationIntakeCaptureRequest, sourceRevision: string) {
      calls.push('claim'); const record = records.get(key(binding)); if (record?.command.requestId !== command.requestId) throw new Error('conflict');
      if (record.dispatch) return false; records.set(key(binding), { ...record, dispatch: { sourceRevision } }); return true;
    },
  };
  const select = (): NativeConversationIntakeSelection => ({ available: true, identity, endpoint: 'https://native.invalid', projectId: 'project', workspace: '/workspace', journal,
    bind: () => ({ client, execution, readPrincipal: async () => { calls.push('principal'); return principal; }, dispose: () => { disposed++; } }) });
  const create = () => new NativeConversationIntakeControls(select, () => `id-${++ids}`);
  return { select, controls: create(), create, client, execution, executions, journal, calls, captures, records, server, ids: () => ids, disposed: () => disposed,
    setOutcome(value: typeof outcome) { outcome = value; }, replaceHost() { identity = 'different-host'; }, replacePrincipal() { principal = 'different-paired-principal'; } };
}


for (const [product, execute] of [['agent', agentExecute], ['tui', tuiExecute]] as const) describe(`${product} invocation ownership`, () => {
  function setup() {
    const f = fixture(); const controller = new AbortController(); let turns = 0;
    const options = { mode: 'submit' as const, prompt: original.text, signal: controller.signal, select: f.select,
      resolveHost: () => { throw new Error('Injected selection must be used'); },
      runTurn: async () => { turns++; return { exitCode: 0, response: 'answer', stopReason: 'complete' }; },
    };
    return { f, controller, options, turns: () => turns };
  }
  test('a fresh turn uses the exact admitted text and never exposes its permit', async () => {
    const h = setup(); const result = await execute(h.options);
    expect(result.exitCode).toBe(0); expect(h.turns()).toBe(1);
    expect(h.f.captures[0]?.text).toBe(original.text);
    const lines: string[] = []; writeNativeHeadlessResult(result, 'json', line => lines.push(line));
    expect(lines).toHaveLength(1); expect(JSON.parse(lines[0]!).native.result.text).toBe(original.text);
    expect(lines[0]).not.toContain('turnPermit'); expect(lines[0]).not.toContain('turnReady');
  });
  test('a signal during awaited turn cleanup exits 130 without losing the completed response', async () => {
    const h = setup();
    const result = await execute({ ...h.options, runTurn: async () => {
      await Promise.resolve(); h.controller.abort();
      return { exitCode: 0, response: 'completed answer', stopReason: 'complete' };
    } });
    expect(result.exitCode).toBe(130); expect(result.response).toBe('completed answer');
    expect(result.stopReason).toBe('complete'); expect(result.native?.result?.kind).toBe('turn');
    expect(h.f.calls).not.toContain('cancel'); expect(h.f.calls).not.toContain('execution-cancel');
  });
  test('SIGINT during owned capture cancels only its exact durable input', async () => {
    const h = setup(); const capture = h.f.client.capture;
    h.f.client.capture = async request => { await capture(request); h.controller.abort(); throw new Error('ack lost'); };
    const result = await execute(h.options);
    expect(result.exitCode).toBe(130); expect(result.native?.result?.kind).toBe('cancelled');
    expect(h.f.captures).toHaveLength(1); expect(h.f.calls.filter(call => ['capture', 'get', 'cancel', 'admit'].includes(call))).toEqual(['capture', 'get', 'cancel']);
    expect(h.turns()).toBe(0);
  });
  test('SIGINT during a new submit lookup never cancels an older unresolved input', async () => {
    const h = setup(); h.f.setOutcome('processing'); await h.f.controls.submit(original); h.f.calls.length = 0;
    const get = h.f.client.get; h.f.client.get = async request => { h.controller.abort(); return get(request); };
    expect((await execute(h.options)).exitCode).toBe(130);
    expect(h.f.calls).not.toContain('cancel'); expect(h.f.calls).not.toContain('execution-cancel'); expect(h.f.captures).toHaveLength(1);
  });
  test('SIGINT during retry or status never cancels a previous invocation', async () => {
    for (const mode of ['retry', 'status'] as const) {
      const h = setup(); h.f.setOutcome('processing'); await h.f.controls.submit(original); h.f.calls.length = 0;
      const get = h.f.client.get; h.f.client.get = async request => { h.controller.abort(); return get(request); };
      expect((await execute({ ...h.options, mode, prompt: undefined })).exitCode).toBe(130);
      expect(h.f.calls).not.toContain('cancel'); expect(h.turns()).toBe(0);
    }
  });
  test('SIGINT during owned execution start cancels the saved exact work attempt', async () => {
    const h = setup(); h.f.setOutcome('work'); const start = h.f.execution.start;
    h.f.execution.start = async target => { const snapshot = await start(target); h.controller.abort(); throw new Error('ack lost'); };
    h.f.execution.cancel = async target => { h.f.calls.push('execution-cancel'); expect(target).toEqual({ workId: 'real-work', attemptId: 'real-attempt', expectedRevision: { work: 1, criteria: 1, attempt: 1 } }); return h.f.executions.get(target.attemptId)!; };
    const result = await execute(h.options);
    expect(result.exitCode).toBe(130); expect(result.native?.execution?.action).toBe('cancel');
    expect(h.f.calls.filter(call => call === 'execution-cancel')).toHaveLength(1); expect(h.turns()).toBe(0);
  });
  test('explicit cancellation after restart targets only the durable admitted work', async () => {
    const h = setup(); h.f.setOutcome('work'); await execute(h.options); h.f.calls.length = 0;
    h.f.execution.cancel = async target => { h.f.calls.push('execution-cancel'); return h.f.executions.get(target.attemptId)!; };
    const result = await execute({ ...h.options, mode: 'cancel', prompt: undefined });
    expect(result.exitCode).toBe(0); expect(result.native?.execution?.action).toBe('cancel');
    expect(h.f.calls.filter(call => call === 'execution-cancel')).toHaveLength(1); expect(h.f.calls).not.toContain('execution-start');
    expect(h.turns()).toBe(0);
  });
  test('changed principal or journal identity refuses automatic cancellation', async () => {
    for (const change of ['principal', 'journal'] as const) {
      const h = setup(); const capture = h.f.client.capture;
      h.f.client.capture = async request => { await capture(request);
        if (change === 'principal') h.f.replacePrincipal(); else h.f.records.clear();
        h.controller.abort(); throw new Error('ack lost'); };
      expect((await execute(h.options)).exitCode).toBe(130); expect(h.f.calls).not.toContain('cancel'); expect(h.turns()).toBe(0);
    }
  });
  test('status is read-only and retry never automatically resumes processing', async () => {
    const h = setup(); h.f.setOutcome('processing'); await h.f.controls.submit(original); h.f.calls.length = 0;
    const records = JSON.stringify([...h.f.records]);
    expect((await execute({ ...h.options, mode: 'status', prompt: undefined })).exitCode).toBe(0);
    expect((await execute({ ...h.options, mode: 'retry', prompt: undefined })).exitCode).toBe(3);
    expect(h.f.calls).not.toContain('resume'); expect(h.f.calls).not.toContain('save'); expect(h.f.calls).not.toContain('admit');
    expect(JSON.stringify([...h.f.records])).toBe(records); expect(h.turns()).toBe(0);
  });
});
