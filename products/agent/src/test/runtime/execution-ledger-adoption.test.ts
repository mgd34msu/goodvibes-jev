import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import type { JevDecision } from '@goodvibes-jev/judgment/decisions';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { executeToolCalls } from '@goodvibes-jev/engine/sdk/platform/core';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { AgentExecutionLedger, forgetLedgerArgRoles } from '@goodvibes-jev/engine/sdk/platform/gate/policy';
import { emitToolReceived, emitToolPermissioned, emitToolSucceeded, emitToolCancelled } from '@goodvibes-jev/engine/sdk/platform/runtime/emitters';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { getTestRuntimeServices, resetTestRuntimeServices } from '../helpers/runtime-services.ts';
import { AgentExecutionLedger as CompatibilityLedger } from '../../runtime/execution-ledger.ts';
import type { RuntimeServices } from '../../runtime/services.ts';
import { composeAgentPermissionManager } from '../../runtime/bootstrap-core.ts';
import { executionHistorySummary } from '../../tools/agent-harness-execution-history.ts';
import type { CommandContext } from '../../input/command-registry.ts';

const ctx = { sessionId: 'ledger-composition', traceId: 'ledger-composition', source: 'test' };
const decision: JevDecision = {
  schemaVersion: 1, decisionId: 'composition-decision', outcome: 'act', summary: 'Synthetic provenance',
  binding: { sourceId: 'source', inputRevision: '1', actionId: 'action', actionRevision: '1', authorityId: 'authority', authorityRevision: '1', scopeId: 'scope', scopeRevision: '1' },
  judgmentDecisionIds: ['reading'], evidence: [],
};
const call = { callId: 'call', turnId: 'turn', tool: 'read_local' };
let judgmentLog: SqliteDecisionLog;
let previous: ReturnType<typeof installJudgmentPort>;
let services: RuntimeServices | undefined;
// An imported helper's hooks belong to the first importing test file. Full
// suite order can therefore reuse this cached module without its reset hook.
// This file owns the fresh graph it disposes after each composition probe.
beforeEach(resetTestRuntimeServices);
function compose() {
  services = getTestRuntimeServices();
  forgetLedgerArgRoles();
  const fixture = fakePort((name, question, state) => {
    if (name === 'disposition') return choiceAnswer(question, 'act', 0.99);
    if (name === 'kind') return choiceAnswer(question, 'network', 0.99);
    const key = (state as { argument?: string }).argument;
    if (name === 'holds_credential') return noulAnswer(key === 'pat' ? 0.999 : 0.001);
    if (name === 'is_target') return noulAnswer(key === 'recipient' ? 0.999 : 0.001);
    if (name === 'family' || name === 'capability') return choiceAnswer(question, 'generic', 0.99);
    if (question.type === 'noul') return noulAnswer(0.001);
    throw new Error(`Unexpected fixture question: ${name}`);
  });
  judgmentLog = new SqliteDecisionLog(':memory:');
  previous = installJudgmentPort(withDecisionLog(fixture.port, judgmentLog));
  return { runtime: services, requests: fixture.requests };
}
afterEach(async () => {
  if (services) { await services.processManager.close(); services.dispose(); services = undefined; }
  resetTestRuntimeServices();
  installJudgmentPort(previous); judgmentLog[Symbol.dispose](); forgetLedgerArgRoles();
});

test('real Agent services construct the shared ledger and actual history consumes its Jev kind and target', async () => {
  const { runtime, requests } = compose();
  expect(runtime.executionLedger).toBeInstanceOf(AgentExecutionLedger);
  expect(CompatibilityLedger).toBe(AgentExecutionLedger);
  emitToolReceived(runtime.runtimeBus, ctx, { ...call, args: { recipient: 'public-fixture', pat: 'SYNTHETIC_AGENT_CREDENTIAL' } });
  emitToolPermissioned(runtime.runtimeBus, ctx, { ...call, approved: true, autonomousDecision: decision });
  emitToolSucceeded(runtime.runtimeBus, ctx, { ...call, durationMs: 19, result: { kind: 'text', byteSize: 2, preview: 'ok' } });
  await runtime.executionLedger.settled();
  const record = runtime.executionLedger.getSnapshot().records[0]!;
  expect(record).toEqual(expect.objectContaining({ routeKind: 'network', targetPreview: 'public-fixture', permissionApproved: true, status: 'succeeded', durationMs: 19 }));
  const summary = executionHistorySummary({ ops: { executionLedger: runtime.executionLedger }, workspace: { fileUndoManager: runtime.fileUndoManager } } as CommandContext, { includeParameters: true });
  expect(JSON.stringify(summary)).toContain('network');
  expect(record.autonomousDecision).toEqual(decision);
  expect(JSON.stringify(summary)).toContain('composition-decision');
  expect(JSON.stringify(summary)).toContain('public-fixture');
  expect(JSON.stringify([requests, record, summary])).not.toContain('SYNTHETIC_AGENT_CREDENTIAL');
  expect(requests[0]?.context?.battery).toBe('engine.gate.ledger-arg');
  expect(requests.at(-1)?.context?.battery).toBe('engine.gate.side-effect');
});

test('real Agent composition withholds declared credential input before model calls and preserves cancellation', async () => {
  const { runtime, requests } = compose();
  emitToolReceived(runtime.runtimeBus, ctx, { ...call, args: { apiKey: 'SYNTHETIC_DECLARED_CREDENTIAL' } });
  emitToolCancelled(runtime.runtimeBus, ctx, { ...call, reason: 'protected call cancelled' });
  await runtime.executionLedger.settled();
  expect(requests).toEqual([]);
  expect(runtime.executionLedger.getSnapshot().records[0]).toEqual(expect.objectContaining({ status: 'cancelled', tool: '[protected tool call]', argsPreview: '[redacted: protected input]' }));
  expect(JSON.stringify(runtime.executionLedger.getSnapshot())).not.toContain('SYNTHETIC_DECLARED_CREDENTIAL');
});

test('the real tool execution path combines the shared permission guard and ledger without an approval callback', async () => {
  const { runtime, requests } = compose();
  let executions = 0;
  const registry = new ToolRegistry();
  registry.register({
    definition: { name: 'read_local', description: 'Synthetic read-only fixture', parameters: { type: 'object', properties: { recipient: { type: 'string' } } } },
    async execute() { executions++; return { success: true, output: 'synthetic result' }; },
  });
  const results = await executeToolCalls({
    autonomousSource: () => ({ goal: 'Read the fixture target and record its execution history', criteria: ['Preserve the recorded tool decision'] }),
    toolRegistry: registry, permissionManager: composeAgentPermissionManager(runtime),
    hookDispatcher: null, runtimeBus: runtime.runtimeBus,
    sessionId: ctx.sessionId, emitterContext: () => ctx,
  }, 'live-turn', [{ id: 'live-call', name: 'read_local', arguments: { recipient: 'fixture-target' } }]);
  await runtime.executionLedger.settled();
  expect(executions).toBe(1); expect(results[0]?.success).toBe(true);
  expect(runtime.executionLedger.getSnapshot().records[0]).toEqual(expect.objectContaining({
    callId: 'live-call', turnId: 'live-turn', permissionApproved: true,
    status: 'succeeded', phase: 'TOOL_SUCCEEDED', routeKind: 'network', targetPreview: 'fixture-target',
    resultSummary: expect.objectContaining({ kind: 'text', preview: 'synthetic result' }),
  }));
  expect(requests.some((request) => request.context?.site === 'engine.gate.execution-ledger')).toBe(true);
});
