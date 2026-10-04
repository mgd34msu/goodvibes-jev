import type { OperatorNativeWorkExecutionClient, NativeWorkExecutionSnapshot } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client';
import { expect, test } from 'bun:test';
import { NativeConversationIntakeControls, type NativeConversationIntakeSelection } from '../../runtime/native-conversation-intake.ts';
import { captureNativeConversationInput } from '../../runtime/native-conversation-input.ts';
import { routeNativeConversationInput } from '../../runtime/native-conversation-ingress.ts';
import type { NativeIntakeJournalBinding, NativeIntakeJournalRecord, NativeIntakeExecutionIntent } from '../../runtime/native-conversation-intake-journal.ts';
import type { NativeConversationIntakeCaptureRequest, NativeConversationIntakeResult, OperatorNativeConversationIntakeClient, NativeConversationTurnPermit } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client';

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
  return { controls: create(), create, client, execution, executions, journal, calls, captures, records, server, ids: () => ids, disposed: () => disposed,
    setOutcome(value: typeof outcome) { outcome = value; }, replaceHost() { identity = 'different-host'; }, replacePrincipal() { principal = 'different-paired-principal'; } };
}

test('captures exact original text before trim, references and image expansion', () => {
  const source = captureNativeConversationInput('  Use !@a.ts @folder [TEXT: p1, 9 lines] [IMAGE: img1, clip, 2KB]\r\n ');
  expect(source.text.startsWith('  ')).toBe(true); expect(source.text.endsWith('\r\n ')).toBe(true);
  expect(source.unsupportedSources.map(ref => ref.kind)).toEqual(['context', 'image', 'file', 'context']);
  expect(Object.isFrozen(source)).toBe(true);
});
test('persists and confirms exact identity before capture; claims settled turn without execution', async () => {
  const f = fixture(); const result = await f.controls.submit(original);
  expect(f.calls).toEqual(['principal', 'read', 'save', 'confirm', 'capture', 'confirm', 'admit', 'claim', 'bind']);
  expect(f.captures).toEqual([{ requestId: 'id-1', inputId: 'id-2', ...original }]); expect(result?.turnReady).toBe(true);
  expect(result?.result?.kind).toBe('turn'); expect(f.disposed()).toBe(1);
});
test('failed persistence forbids capture; failed dispatch durability forbids turn', async () => {
  const f = fixture(); f.journal.save = async () => { throw new Error('disk failure'); };
  expect((await f.controls.submit(original))?.status).toBe('unknown'); expect(f.captures).toHaveLength(0);
  const g = fixture(); g.journal.claimTurn = async () => { throw new Error('published-indeterminate'); };
  expect((await g.controls.submit(original))?.turnReady).toBeUndefined();
});
test('lost capture response reuses original identity and gets before exact replay', async () => {
  const f = fixture(); const capture = f.client.capture; let lost = true;
  f.client.capture = async request => { if (lost) { lost = false; f.calls.push('lost'); throw new Error('transport'); } return capture(request); };
  await f.controls.submit(original); const restarted = f.create(); const state = await restarted.retry();
  expect(f.calls.indexOf('get')).toBeLessThan(f.calls.indexOf('capture')); expect(f.ids()).toBe(2); expect(state?.turnReady).toBe(true);
  expect(f.captures[0]).toEqual({ requestId: 'id-1', inputId: 'id-2', ...original });
});
test('restart and status never redispatch a claimed settled turn', async () => {
  const f = fixture(); await f.controls.submit(original); f.calls.length = 0;
  const restarted = f.create(); expect((await restarted.status())?.turnReady).toBeUndefined();
  expect((await restarted.retry())?.turnReady).toBeUndefined(); expect(f.calls).not.toContain('admit'); expect(f.ids()).toBe(2);
});
test('processing cannot re-admit or fall through and only explicit resume advances', async () => {
  const f = fixture(); f.setOutcome('processing'); await f.controls.submit(original); f.calls.length = 0;
  expect((await f.controls.retry())?.result?.kind).toBe('processing');
  expect((await f.controls.submit({ ...original, text: 'new text' }))?.status).toBe('unknown'); expect(f.ids()).toBe(2);
  expect(f.calls).not.toContain('admit'); expect(f.calls).not.toContain('resume'); f.setOutcome('turn');
  expect((await f.controls.resume())?.turnReady).toBe(true); expect(f.calls).toContain('resume');
});
test('blocked and refused are unchanged under retry, resume and cancel', async () => {
  for (const kind of ['blocked', 'refused'] as const) {
    const f = fixture(); f.setOutcome(kind); await f.controls.submit(original); f.calls.length = 0;
    for (const action of ['retry', 'resume', 'cancel'] as const) expect((await f.controls[action]())?.result?.kind).toBe(kind);
    expect(f.calls.filter(call => ['capture', 'admit', 'resume', 'cancel', 'claim'].includes(call))).toEqual([]);
  }
});
test('intentional identical input after terminal result gets a fresh logical identity', async () => {
  const f = fixture(); await f.controls.submit(original); await f.controls.submit(original);
  expect(f.ids()).toBe(4); expect(f.captures.map(request => request.inputId)).toEqual(['id-2', 'id-4']);
});
test('work result starts its exact native target and cannot dispatch an ordinary turn', async () => {
  const f = fixture(); f.setOutcome('work'); let dispatches = 0; const lines: string[] = [];
  await routeNativeConversationInput({ intake: f.controls, source: original, notify: line => lines.push(line), dispatch: async () => { dispatches++; } });
  expect(dispatches).toBe(0); expect(lines.join('\n')).toContain('real-work'); expect(f.calls).not.toContain('claim'); expect(f.calls).toContain('execution-start');
  expect(f.calls.indexOf('execution-intent')).toBeLessThan(f.calls.indexOf('execution-start'));
});
test('unavailable and unsupported sources never have a legacy fallback', async () => {
  let dispatched = 0; const notices: string[] = [];
  await routeNativeConversationInput({ intake: undefined, source: original, notify: line => notices.push(line), dispatch: async () => { dispatched++; } });
  expect(dispatched).toBe(0); expect(notices.join(' ')).toContain('No ordinary turn');
  const f = fixture(); f.setOutcome('blocked'); await routeNativeConversationInput({ intake: f.controls, source: captureNativeConversationInput('Use @file'), notify: () => {}, dispatch: async () => { dispatched++; } });
  expect(dispatched).toBe(0); expect(f.captures[0]?.unsupportedSources).toEqual([{ kind: 'context', label: '@file' }]);
});
test('host change while capture is pending discards stale result and claim', async () => {
  const f = fixture(); let resolve!: (value: NativeConversationIntakeResult) => void;
  f.client.capture = async () => new Promise(done => { resolve = done; }); const pending = f.controls.submit(original);
  for (let n = 0; n < 30; n++) await Promise.resolve(); f.replaceHost();
  resolve({ kind: 'captured', projectId: 'project', requestId: 'id-1', sourceRef: { version: 1, inputId: 'id-2', sourceId: 'source', sourceRevision: 'r1', sessionId: 'host-session' } });
  expect(await pending).toBeUndefined(); expect(f.calls).not.toContain('admit'); expect(f.calls).not.toContain('claim');
});
test('another principal cannot recover or replay the earlier input', async () => {
  const f = fixture(); await f.controls.submit(original); f.replacePrincipal(); f.calls.length = 0;
  expect((await f.controls.retry())?.status).toBe('unavailable'); expect(f.calls).not.toContain('get'); expect(f.ids()).toBe(2);
});

test('explicit cancel interrupts the local wait, looks up its durable input and cancels without stale dispatch', async () => {
  const f = fixture(); let finish!: (result: NativeConversationIntakeResult) => void;
  f.client.admit = async () => { f.calls.push('held-admit'); return new Promise(resolve => { finish = resolve; }); };
  const pending = f.controls.submit(original); for (let n = 0; n < 40; n++) await Promise.resolve();
  expect(f.calls).toContain('held-admit');
  const cancelled = await f.controls.cancel(); expect(cancelled?.result?.kind).toBe('cancelled');
  expect(f.calls.slice(-4)).toEqual(['read', 'get', 'confirm', 'cancel']);
  finish({ kind: 'turn', projectId: 'project', requestId: 'id-1', sourceRef: { version: 1, inputId: 'id-2', sourceId: 'source-id-2', sourceRevision: 'r1', sessionId: 'host-session' }, route: 'answer', text: original.text });
  expect(await pending).toBeUndefined(); expect(f.calls).not.toContain('claim'); expect(f.ids()).toBe(2);
});

test('explicit retry repairs a pre-publication storage failure using the same source and identities', async () => {
  const f = fixture(); const save = f.journal.save; let failing = true;
  f.journal.save = async (...args) => { if (failing) throw new Error('temporary storage failure'); await save(...args); };
  expect((await f.controls.submit(original))?.status).toBe('unknown'); expect(f.captures).toHaveLength(0); expect(f.ids()).toBe(2);
  expect((await f.controls.status())?.status).toBe('unknown'); expect(f.captures).toHaveLength(0);
  failing = false; f.calls.length = 0;
  expect((await f.controls.retry())?.turnReady).toBe(true);
  expect(f.calls.indexOf('get')).toBeLessThan(f.calls.indexOf('save'));
  expect(f.calls.indexOf('save')).toBeLessThan(f.calls.indexOf('capture'));
  expect(f.captures).toEqual([{ requestId: 'id-1', inputId: 'id-2', ...original }]); expect(f.ids()).toBe(2);
});
test('published-indeterminate save is confirmed in place on explicit retry without rewriting source', async () => {
  const f = fixture(); const save = f.journal.save; let saves = 0;
  f.journal.save = async (...args) => { saves++; await save(...args); throw new Error('published-indeterminate'); };
  await f.controls.submit(original); expect(f.captures).toHaveLength(0);
  expect((await f.controls.retry())?.turnReady).toBe(true); expect(saves).toBe(1); expect(f.ids()).toBe(2);
});

test('execution dispatch intent is durable before start and a lost acknowledgement reconciles without duplicate start', async () => {
  const f = fixture(); f.setOutcome('work'); const start = f.execution.start;
  f.execution.start = async target => { const result = await start(target); throw new Error('lost acknowledgement'); };
  const state = await f.controls.submit(original);
  expect(state?.execution?.snapshot?.kind).toBe('pending-intent');
  expect(f.calls.filter(call => call === 'execution-start')).toHaveLength(1);
  const record = [...f.records.values()][0]!;
  expect(record.execution).toEqual({ sourceRevision: 'r1', target: { workId: 'real-work', attemptId: 'real-attempt', expectedRevision: { work: 1, criteria: 1, attempt: 1 } } });
  const restarted = f.create(); await restarted.status(); await restarted.retry(); await restarted.resume();
  expect(f.calls.filter(call => call === 'execution-start')).toHaveLength(1); expect(f.ids()).toBe(2);
});
test('execution intent persistence failure prevents every execution request', async () => {
  const f = fixture(); f.setOutcome('work'); f.journal.saveExecutionIntent = async () => { throw new Error('disk failure'); };
  expect((await f.controls.submit(original))?.status).toBe('unknown');
  expect(f.calls.filter(call => call.startsWith('execution-'))).toEqual([]);
});
test('unresolved dispatch blocks new source; restart status is read-only and explicit retry reuses exact intent', async () => {
  const f = fixture(); f.setOutcome('work'); const start = f.execution.start;
  f.execution.start = async () => { f.calls.push('failed-start'); throw new Error('lost before persistence'); };
  await f.controls.submit(original); const before = f.ids();
  expect((await f.controls.submit({ ...original, text: 'new source' }))?.message).toContain('unresolved dispatch'); expect(f.ids()).toBe(before);
  const restarted = f.create(); f.calls.length = 0; await restarted.status();
  expect(f.calls).not.toContain('execution-intent'); expect(f.calls).not.toContain('failed-start');
  f.execution.start = start; expect((await restarted.retry())?.execution?.snapshot?.kind).toBe('pending-intent');
  expect(f.captures).toHaveLength(1); expect(f.ids()).toBe(2);
});
