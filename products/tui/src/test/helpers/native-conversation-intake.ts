import type { OperatorNativeWorkExecutionClient, NativeWorkExecutionSnapshot } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client';
import { NativeConversationIntakeControls, type NativeConversationIntakeSelection } from '../../runtime/native-conversation-intake.ts';
import type { NativeIntakeJournalBinding, NativeIntakeJournalRecord, NativeIntakeExecutionIntent } from '../../runtime/native-conversation-intake-journal.ts';
import type { NativeConversationIntakeCaptureRequest, NativeConversationIntakeResult, OperatorNativeConversationIntakeClient, NativeConversationTurnPermit } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client';

export function nativeConversationIntakeFixture() {
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
