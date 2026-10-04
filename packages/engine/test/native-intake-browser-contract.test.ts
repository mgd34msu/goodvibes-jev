import { expect, test } from 'bun:test';
import { createScopedBrowserSdk } from '../sdk/src/browser-scoped.js';
import type { NativeConversationIntakeResult } from '../sdk/src/platform/workflow/work-ledger/native-intake-wire.js';
const method = 'workLedger.intake.admit';
const routes = { [method]: { method: 'POST', path: '/api/work-ledger/intake/admit' } };
const request = { inputId: 'input-1', sourceRevision: 'source-revision-1' };
const common = { projectId: 'project-1', requestId: 'request-1', sourceRef: { version: 1 as const, ...request, sourceId: 'source-1', sessionId: 'session-1' } };
test('scoped typed browser intake preserves routing, recovery and work distinctions', async () => {
  for (const snapshot of [
    { kind: 'captured', ...common },
    { kind: 'processing', ...common, stage: 'routing', recovery: 'pending' },
    { kind: 'turn', ...common, route: 'converse', text: 'Hello' },
    { kind: 'blocked', ...common, reason: 'missing-context', recovery: 'required' },
    { kind: 'refused', ...common, reason: 'semantic' },
    { kind: 'cancelled', ...common },
    { kind: 'work', ...common, receipt: { projectId: common.projectId, requestId: common.requestId, inputId: request.inputId,
      ledgerRevision: 1, workId: 'work-1', attemptId: 'attempt-1', expectedRevision: { work: 1, criteria: 1, attempt: 1 },
      source: { version: 2, sourceId: common.sourceRef.sourceId, sourceRevision: request.sourceRevision, sessionId: common.sourceRef.sessionId,
        offsetEncoding: 'utf16', proposalRevision: 'proposal-1', spans: [{ partId: 'input', start: 0, end: 4 }], admissionDecisionId: 'decision-1', judgmentDecisionIds: ['decision-1'] }, goal: 'Goal', criteria: ['Goal'] } },
  ] satisfies readonly NativeConversationIntakeResult[]) {
    const sdk = createScopedBrowserSdk(routes, [], { baseUrl: 'https://native-fixture.invalid', fetch: async () => new Response(JSON.stringify(snapshot), { headers: { 'Content-Type': 'application/json' } }) });
    const result = await sdk.operator.invoke(method, request);
    expect(result).toEqual(snapshot);
    if (result.kind === 'work') { expect(result.receipt.source.version).toBe(2); expect(result.receipt.source.offsetEncoding).toBe('utf16'); }
    else if (result.kind === 'turn') expect(result.route).toBe('converse');
    else expect('receipt' in result).toBe(false);
  }
});
