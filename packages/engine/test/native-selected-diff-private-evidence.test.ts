/** Selected hunks remain immutable private evidence through real native consumers. */
import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort, type JudgmentRequest, type Questions } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { buildContractPlannerRequest } from '../sdk/src/platform/contract/planner.js';
import { buildUnitBrief } from '../sdk/src/platform/contract/brief.js';
import { buildFixPlannerRequest } from '../sdk/src/platform/contract/fix-plan.js';
import { captureNativeContractSource, nativeContractSourceData, nativeContractSourceForAdmission, nativeSourceCriteria } from '../sdk/src/platform/contract/native-source.js';
import { canonicalNativeConversationContinuation, type NativeConversationContinuation } from '../sdk/src/platform/workflow/work-ledger/native-continuation-context.js';
import { NATIVE_SELECTED_DIFF_MAX_BYTES, nativeSelectedDiffSelector, type NativeSelectedDiffContext } from '../sdk/src/platform/workflow/work-ledger/native-diff-context.js';
import { decideNativeIntake, readNativeIntakeRoute, validateNativeRequirementProposal } from '../sdk/src/platform/workflow/work-ledger/native-intake-decisions.js';
import { createNativeRequirementProposer } from '../sdk/src/platform/workflow/work-ledger/native-intake-proposer.js';
import { autonomousSourceEvidence, captureAutonomousSource, type AutonomousToolSource } from '../sdk/src/platform/permissions/autonomous.js';
import { createOperatorNativeConversationIntakeClient } from '../sdk/src/platform/workflow/work-ledger/native-intake-client.js';
import { readNativeConversationTurnActionSource, readNativeConversationTurnSelectedDiffContext, withNativeConversationTurn } from '../sdk/src/platform/core/native-turn-scope.js';
import { Orchestrator, type OrchestratorOptions } from '../sdk/src/platform/core/orchestrator.js';
import { ConversationManager } from '../sdk/src/platform/core/conversation.js';
import type { OrchestratorCoreServices } from '../sdk/src/platform/core/orchestrator-runtime.js';
import { UNKNOWN_MODEL_PRICING } from '../sdk/src/platform/providers/model-pricing.js';
import type { OperatorRemoteClient } from '../operator-sdk/src/client-core.js';
import type { ToolCall, ToolResult } from '../sdk/src/platform/types/tools.js';
import { runAgentTask, type AgentOrchestratorRunContext } from '../sdk/src/platform/agents/orchestrator-runner.js';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.js';
import type { AgentRecord } from '../sdk/src/platform/tools/agent/manager.js';
import type { LLMProvider } from '../sdk/src/platform/providers/interface.js';
import type { ConversationMessageSnapshot } from '../sdk/src/platform/core/conversation.js';
import type { FeatureFlagManager } from '../sdk/src/platform/runtime/feature-flags/manager.js';
import { withRetry } from '../sdk/src/platform/utils/retry.js';
import { snapshotJudgmentInput } from '../sdk/src/platform/gate/judgment-input.js';
import { nativeSelectedDiffEvidence } from '../sdk/src/platform/workflow/work-ledger/native-diff-evidence.js';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { gateReadingsPort, forgetGateReadings } from './_helpers/gate-readings.ts';
import { PermissionManager, type PermissionConfigReader } from '../sdk/src/platform/permissions/manager.js';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.js';
import { AppError } from '../sdk/src/platform/types/errors.js';
import { makeContract } from './contract/fixtures.js';
import { shapeOf } from './contract/plan-support.js';
import { useFailureReadings } from './_helpers/failure-readings.ts';

useFailureReadings([['Native provider source changed before retry', { category: 'unknown' }]]);
const text = '  Fix this hunk. 🌻\r\n';
const privateLine = 'private selected hunk evidence';
const numericProtocolDigest = '4111111111111111' + 'a'.repeat(48);
const diff = `diff --git a/src/private.ts b/src/private.ts\nindex abcdef0..abcdef1 100644\n--- a/src/private.ts\n+++ b/src/private.ts\n@@ -1 +1 @@\n-old\n+${privateLine}\n`;
function selectedDiff(): NativeSelectedDiffContext {
  return { kind: 'session', revision: numericProtocolDigest, fileIndex: 2, hunkIndex: 3, unifiedDiff: diff,
    provenance: { kind: 'session', sessionId: 'hosted-owned', baselineCheckpointId: 'checkpoint-before', latestCheckpointId: 'checkpoint-after' } };
}
function continuation(selected = selectedDiff()): NativeConversationContinuation {
  const sessionId = 'hosted-owned'; const messages = [{ role: 'assistant' as const, content: 'Previous discussion.' }];
  return { sessionId, messages, selectedDiff: selected, revision: createHash('sha256').update(canonicalNativeConversationContinuation(sessionId, messages, selected)).digest('hex') };
}
function source(context = continuation()) {
  return { sourceId: 'source', sourceRevision: 'source-revision', inputRevision: 'input-revision', criteriaId: 'criteria', criteriaRevision: '1', goal: text, criteria: [text], continuation: context };
}
function contract() {
  const nativeSource = captureNativeContractSource(source());
  return makeContract({ goal: nativeSource.goal, criteria: nativeSourceCriteria(nativeSource), nativeSource, shape: shapeOf() });
}

test('native source binds every selected diff byte and provenance field while preserving only original requirements', () => {
  const original = source(); const captured = captureNativeContractSource(original);
  expect(captured.goal).toBe(text); expect(captured.criteria).toEqual([text]);
  const selected = captured.continuation!.selectedDiff!;
  expect(selected).toEqual(selectedDiff()); expect(Object.isFrozen(selected)).toBe(true); expect(Object.isFrozen(selected.provenance)).toBe(true);
  if (original.continuation.selectedDiff?.kind === 'session') original.continuation.selectedDiff.provenance.latestCheckpointId = 'caller-mutation';
  if (selected.kind === 'session') expect(selected.provenance.latestCheckpointId).toBe('checkpoint-after');
  const projection = nativeContractSourceData(captured);
  projection.continuation!.selectedDiff!.unifiedDiff = diff.replace(privateLine, 'projection mutation');
  expect(captured.continuation!.selectedDiff!.unifiedDiff).toBe(diff);
  for (const changed of [
    { ...selectedDiff(), unifiedDiff: diff.replace(privateLine, 'changed evidence') },
    { ...selectedDiff(), fileIndex: 7 },
    { ...selectedDiff(), revision: 'b'.repeat(64) },
    { ...selectedDiff(), provenance: { kind: 'session', sessionId: 'hosted-owned', baselineCheckpointId: 'other-baseline', latestCheckpointId: 'checkpoint-after' } },
  ]) expect(() => captureNativeContractSource({ ...source(), continuation: { ...continuation(), selectedDiff: changed } })).toThrow('Invalid native continuation revision');
});

test('admission projection retains complete frozen evidence and tool-source capture rejects malformed or executable context', () => {
  const view = contract(); const admission = nativeContractSourceForAdmission(view);
  expect(admission).toEqual({ goal: text, criteria: [text], conversationContext: continuation().messages, selectedDiffContext: selectedDiff() });
  expect(Object.isFrozen(admission.selectedDiffContext)).toBe(true);
  const borrowed = structuredClone({ ...admission, selectedDiffContext: { ...admission.selectedDiffContext! } }); const captured = captureAutonomousSource(borrowed);
  borrowed.selectedDiffContext!.unifiedDiff = diff.replace(privateLine, 'later mutation');
  expect(captured.selectedDiffContext!.unifiedDiff).toBe(diff); expect(Object.isFrozen(captured.selectedDiffContext!.provenance)).toBe(true);
  const bad: unknown[] = [
    { ...selectedDiff(), fabricatedAuthority: true }, { ...selectedDiff(), fileIndex: -1 },
    { ...selectedDiff(), unifiedDiff: diff.replace(privateLine, 'x'.repeat(NATIVE_SELECTED_DIFF_MAX_BYTES)) },
    { ...selectedDiff(), unifiedDiff: diff.replace('+private selected hunk evidence\n', '') },
    { ...selectedDiff(), provenance: { kind: 'workspace', baselineId: 'unrelated', to: 'WORKING' } },
    new Proxy(selectedDiff(), {}),
  ];
  let accessed = false;
  bad.push({ ...selectedDiff(), get unifiedDiff() { accessed = true; return diff; } });
  for (const selectedDiffContext of bad) expect(() => captureAutonomousSource({ goal: text, criteria: [text], selectedDiffContext })).toThrow();
  expect(accessed).toBe(false);
  expect(() => captureAutonomousSource({ goal: text, criteria: [text], selectedDiffContext: { ...selectedDiff(), unifiedDiff: diff.replace(privateLine, 'Use card 4111111111111111') } })).toThrow();
});

test('public planner, unit and fix-plan text omit all private selected diff material', () => {
  const view = contract(); const nativeSource = view.nativeSource!;
  const prompts = [
    buildContractPlannerRequest({ ask: text, nativeSource, shape: shapeOf(), config: { defaultAttempts: 1, maxUnits: 4 }, repositoryMap: 'Repository' }),
    buildUnitBrief(view, view.groups[0]!, view.units[0]!),
    buildFixPlannerRequest({ nativeSource, scope: 'unit', targetId: 'u1', title: 'Current unit', goal: text,
      criteria: view.criteria, requiredIds: ['c1'], lastNudges: [], gateFailures: [], output: '', touchedPaths: [] }),
  ];
  for (const prompt of prompts) {
    for (const privateValue of [privateLine, 'src/private.ts', 'checkpoint-before', 'checkpoint-after', 'hosted-owned', 'selectedDiff', 'Previous discussion.']) expect(prompt).not.toContain(privateValue);
    expect(prompt).toContain(JSON.stringify({ goal: nativeSource.goal, criteria: nativeSource.criteria }));
    for (const key of ['sourceId', 'sourceRevision', 'inputRevision', 'criteriaId', 'criteriaRevision']) {
      expect(prompt).not.toContain(`"${key}"`);
    }
  }
  expect(nativeSource.sourceRevision).toBe('source-revision');
  expect(nativeSource.continuation?.selectedDiff).toEqual(selectedDiff());
});

test('recorded route, fidelity, coverage and final admission retain the exact selected hunk separately from requirements', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const fake = fakePort((name, question) => name === 'route' ? choiceAnswer(question, 'contract', 0.99)
    : name === 'relation' ? choiceAnswer(question, 'supports', 0.99)
    : name.startsWith('part_') ? noulAnswer(0.01) : choiceAnswer(question, 'act', 0.99));
  const read = { text, sourceRevision: 'source-1', continuation: continuation(), port: withDecisionLog(fake.port, log), decisionLog: log,
    binding: { sourceId: 'source', inputRevision: 'source-1', actionId: 'intake', actionRevision: 'routing-1', authorityId: 'owner', authorityRevision: 'authority-1', scopeId: 'project', scopeRevision: 'scope-1' }, assertCurrent() {} };
  const routeEvidence = await readNativeIntakeRoute(read);
  const requirements = validateNativeRequirementProposal(text, 'source-1', { sourceRevision: 'source-1', spans: [{ partId: 'input', start: 0, end: text.length }] });
  const result = await decideNativeIntake({ ...read, routeEvidence, requirements, allowAct: true, continuations: [], conditions: [] });
  expect(result.route).toBe('work'); expect(result.requirements!.criteria).toEqual([text]); expect(result.autonomous.decision.outcome).toBe('act');
  expect(fake.requests).toHaveLength(4);
  for (const request of fake.requests) expect(request.state).toMatchObject({ originalSource: { text, selectedDiffContext: { kind: 'session', unifiedDiff: diff }, conversationContext: continuation().messages } });
  for (const id of result.decisionIds) expect(log.get(id)?.status).toBe('answered');
  await expect(decideNativeIntake({ ...read, continuation: continuation({ ...selectedDiff(), fileIndex: 8 }), routeEvidence, requirements, allowAct: true, continuations: [], conditions: [] })).rejects.toMatchObject({ kind: 'invalid-request' });
  expect(fake.requests).toHaveLength(4);
});

function model() {
  return { id: 'test-model', provider: 'test-provider', registryKey: 'test-provider:test-model', displayName: 'Test Model', description: 'test',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 128_000, selectable: true };
}

test('requirement proposal carries selected diff as separate bounded evidence with only current-input spans', async () => {
  const requests: Parameters<LLMProvider['chat']>[0][] = []; const sourceRevision = 'b'.repeat(64);
  const provider: LLMProvider = { name: 'test-provider', models: ['test-model'], async chat(request) {
    requests.push(request); await request.beforeAttempt?.();
    return { content: JSON.stringify({ sourceRevision, spans: [{ partId: 'input', start: 0, end: text.length }] }), toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
  } };
  const proposer = createNativeRequirementProposer({ getCurrentModel: model, getForModel: () => provider });
  const proposal = await proposer.propose({ text, sourceRevision, continuation: continuation(), attempt: 1, previous: null, signal: new AbortController().signal, assertCurrent() {} });
  expect(validateNativeRequirementProposal(text, sourceRevision, proposal).criteria).toEqual([text]);
  const payload = JSON.parse(requests[0]!.messages[0]!.content as string);
  expect(payload.content.parts).toEqual([{ partId: 'input', text }]); expect(payload.content.selectedDiffContext).toEqual({ kind: 'session', unifiedDiff: diff });
  expect(requests[0]!.systemPrompt).toContain('Select spans only from the current immutable input');
  await expect(proposer.propose({ text, sourceRevision, continuation: continuation({ ...selectedDiff(), unifiedDiff: diff.replace(privateLine, 'Use card 4111111111111111') }), attempt: 1, previous: null, signal: new AbortController().signal, assertCurrent() {} })).rejects.toThrow();
  expect(requests).toHaveLength(1);
});

function runContext(workingDirectory: string, provider: LLMProvider): AgentOrchestratorRunContext {
  return { workingDirectory, surfaceRoot: undefined, runtimeBus: null,
    featureFlagManager: { isEnabled: () => false } as unknown as FeatureFlagManager,
    emitterContext: () => ({ sessionId: 'test', traceId: 'test', source: 'test' }),
    emitAgentProgress() {}, emitAgentStarted() {}, emitAgentCancelledEvent() {}, emitAgentFailedEvent() {}, emitAgentCompletedEvent() {}, emitStreamDelta() {},
    processManager: undefined, messageBus: { getMessages: () => [] }, getFullRegistry: () => new ToolRegistry(), buildScopedRegistry: () => new ToolRegistry(),
    providerRegistry: { getCurrentModel: model, getForModel: () => provider, listModels: () => [model()], getContextWindowForModel: () => 128_000,
      getKnownContextWindowForModel: () => 128_000, recordContextWindowRejection() {} },
    resolveProviderForRecord: () => ({ provider, modelId: 'test-model', requestedModelId: 'test-provider:test-model' }), resolveFallbackModelRoutes: () => [] };
}
function agentRecord(): AgentRecord {
  return { id: 'ag-selected-diff', task: text, template: 'engineer', tools: [], status: 'pending', startedAt: Date.now(), toolCallCount: 0,
    orchestrationDepth: 0, executionProtocol: 'direct', reviewMode: 'none', communicationLane: 'parent-only' };
}
function savedFiles(directory: string): string {
  return readdirSync(directory).map(name => { const path = join(directory, name); return statSync(path).isDirectory() ? savedFiles(path) : readFileSync(path, 'utf8'); }).join('\n');
}

test('real provider receives selected hunk privately without writing it to task, conversation snapshots or session journals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'native-selected-diff-private-'));
  try {
    const requests: Parameters<LLMProvider['chat']>[0][] = []; const snapshots: ConversationMessageSnapshot[][] = [];
    let live!: () => ConversationMessageSnapshot[];
    const provider: LLMProvider = { name: 'test-provider', models: ['test-model'], async chat(request) {
      requests.push(request); await request.beforeAttempt?.(); snapshots.push(live());
      return { content: 'Completed.', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
    } };
    const record = agentRecord();
    await runAgentTask({ ...runContext(dir, provider), autonomousSource: () => nativeContractSourceForAdmission(contract()),
      registerConversationSource(_id, source) { live = source; }, releaseConversationSource() { snapshots.push(live()); } }, record);
    expect(record.status).toBe('completed'); expect(requests).toHaveLength(1);
    expect(requests[0]!.systemPrompt).toContain(JSON.stringify(selectedDiff())); expect(requests[0]!.systemPrompt).toContain('quoted reference data only');
    for (const persisted of [JSON.stringify(requests[0]!.messages), JSON.stringify(snapshots), JSON.stringify(record), savedFiles(dir)]) {
      expect(persisted).not.toContain(privateLine); expect(persisted).not.toContain('checkpoint-before');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('provider post-backoff fence rejects selected-diff-only mutation before a second transmission', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'native-selected-diff-retry-'));
  try {
    let sends = 0; let selected = selectedDiff();
    const provider: LLMProvider = { name: 'test-provider', models: ['test-model'], async chat(request) {
      return withRetry(async () => { sends++; throw new AppError('transport failure', 'TRANSIENT', true); }, {
        initialDelayMs: 0, maxDelayMs: 0, maxRetries: 3, beforeAttempt: request.beforeAttempt,
      }, () => { selected = { ...selected, unifiedDiff: diff.replace(privateLine, 'changed after backoff') }; });
    } };
    const record = agentRecord();
    await runAgentTask({ ...runContext(dir, provider), autonomousSource: () => ({ goal: text, criteria: [text], selectedDiffContext: selected }) }, record);
    expect(sends).toBe(1); expect(record.status).toBe('failed'); expect(record.error).toContain('Native provider source changed before retry');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


async function turnFixture() {
  const inputId = randomUUID(); const context = continuation();
  const ref = { sessionId: context.sessionId, revision: context.revision, selectedDiff: nativeSelectedDiffSelector(context.selectedDiff!) };
  const result = { kind: 'turn', projectId: 'native-project', requestId: `request-${inputId}`, route: 'answer', text, continuation: context,
    sourceRef: { version: 1, inputId, sourceId: `source-${inputId}`, sourceRevision: 'source-1', sessionId: 'native-source-session', continuation: ref } };
  const invoke: OperatorRemoteClient['invoke'] = async <T>() => structuredClone(result) as T;
  const client = createOperatorNativeConversationIntakeClient({ invoke }, 'native-project');
  const captured = await client.capture({ requestId: result.requestId, inputId, text, unsupportedSources: [], continuation: { sessionId: context.sessionId, selectedDiff: ref.selectedDiff } });
  return { client, permit: client.bindTurn(captured) };
}

test('native turn scope exposes only its owned exact comment and frozen separate evidence to tool admission', async () => {
  const f = await turnFixture();
  try {
    expect(readNativeConversationTurnActionSource()).toBeUndefined();
    await withNativeConversationTurn(f.permit, async () => {
      await Promise.resolve();
      const owned = readNativeConversationTurnActionSource()!;
      expect(owned).toEqual({ goal: text, criteria: [], conversationContext: continuation().messages, selectedDiffContext: selectedDiff() });
      expect(Object.isFrozen(owned)).toBe(true); expect(Object.isFrozen(owned.selectedDiffContext!.provenance)).toBe(true);
      expect(readNativeConversationTurnSelectedDiffContext()).toEqual(selectedDiff());
      expect(captureAutonomousSource(owned).criteria).toEqual([]);
    });
    expect(readNativeConversationTurnSelectedDiffContext()).toBeUndefined();
  } finally { f.client.dispose(); }
});

test('real hosted native turn provider and tool admission retain private selected diff without altering exact user text', async () => {
  const f = await turnFixture(); const conversation = new ConversationManager();
  const requests: Parameters<LLMProvider['chat']>[0][] = []; const sources: AutonomousToolSource[] = [];
  const provider: LLMProvider = { name: 'test-provider', models: ['test-model'], async chat(request) {
    await request.beforeAttempt?.(); requests.push(request);
    return { content: requests.length === 1 ? '' : 'Completed.',
      toolCalls: requests.length === 1 ? [{ id: 'read-1', name: 'read', arguments: { path: 'src/private.ts' } }] : [],
      stopReason: requests.length === 1 ? 'tool_call' : 'completed', usage: { inputTokens: 1, outputTokens: 1 } };
  } };
  const configManager = { get: (key: string) => key === 'behavior.notifyOnComplete' ? false : key === 'agents.contextCompactThreshold' ? 0.85 : undefined,
    getCategory: () => ({}), getWorkingDirectory: () => '/fixture' } as OrchestratorCoreServices['configManager'];
  const providerRegistry = { getCurrentModel: model, getForModel: () => provider, getContextWindowForModel: () => 0, getKnownContextWindowForModel: () => null,
    getTokenLimitsForModel: () => ({ maxOutputTokens: 1024, maxToolResultTokens: 10_000, maxToolCalls: 10, maxReasoningTokens: 0 }),
    recordContextWindowRejection() {}, reconcileObservedContextWindow() {}, resolveModelPricing: () => UNKNOWN_MODEL_PRICING } as unknown as OrchestratorCoreServices['providerRegistry'];
  const instance = new Orchestrator({ conversation, getViewportHeight: () => 0, scrollToEnd() {}, toolRegistry: new ToolRegistry(),
    permissionManager: { getMode: () => 'prompt' } as OrchestratorOptions['permissionManager'],
    services: { agentManager: { list: () => [], spawn() { throw new Error('No legacy spawn'); } }, contractRunner: { list: () => [] },
      contractIntake: { async intake() { throw new Error('No legacy intake'); } } } });
  instance.setCoreServices({ configManager, providerRegistry }); instance.bindNativeConversationProject('native-project');
  const internal = instance as unknown as { runTurnReconcile(): Promise<void>; executeToolCalls(turnId: string, calls: ToolCall[], sourceOf: () => AutonomousToolSource): Promise<ToolResult[]> };
  internal.runTurnReconcile = async () => {};
  internal.executeToolCalls = async (_id, calls, sourceOf) => { sources.push(captureAutonomousSource(sourceOf())); return calls.map(call => ({ callId: call.id, success: true, output: 'Read complete.' })); };
  try {
    await instance.handleUserInput(text, undefined, { nativeConversationTurnPermit: f.permit });
    expect(requests).toHaveLength(2); expect(sources).toHaveLength(1);
    for (const request of requests) {
      expect(request.systemPrompt).toContain(JSON.stringify(selectedDiff()));
      expect(JSON.stringify(request.messages)).not.toContain(privateLine);
    }
    expect(sources[0]).toEqual({ goal: text, criteria: [], conversationContext: continuation().messages, selectedDiffContext: selectedDiff() });
    expect(conversation.getMessagesForLLM().filter(message => message.role === 'user').map(message => message.content)).toEqual([text]);
    expect(JSON.stringify(conversation.getMessagesForLLM())).not.toContain(privateLine);
  } finally { instance.dispose(); f.client.dispose(); }
});


test('protocol digests retain private identity without triggering card scans while real diff material still refuses', () => {
  expect(() => snapshotJudgmentInput(numericProtocolDigest)).toThrow();
  const original = { goal: text, criteria: [text], selectedDiffContext: selectedDiff() };
  const captured = captureAutonomousSource(original);
  expect(captured.selectedDiffContext!.revision).toBe(numericProtocolDigest);
  const evidence = autonomousSourceEvidence(captured);
  expect(evidence.selectedDiffContext).toEqual({ kind: 'session', unifiedDiff: diff });
  expect(() => snapshotJudgmentInput(evidence)).not.toThrow();
  expect(nativeSelectedDiffEvidence({ kind: 'workspace', baselineId: 'wcp_mgxxabcd_aaaaaaaa', revision: numericProtocolDigest,
    fileIndex: 0, hunkIndex: 0, unifiedDiff: diff, provenance: { kind: 'workspace', baselineId: 'wcp_mgxxabcd_aaaaaaaa', to: 'WORKING' } }))
    .toEqual({ kind: 'workspace', unifiedDiff: diff });
  for (const material of ['4111111111111111', 'api_key=private-inline-value']) {
    expect(() => nativeSelectedDiffEvidence({ ...selectedDiff(), unifiedDiff: diff.replace(privateLine, material) })).toThrow();
    expect(() => captureAutonomousSource({ ...original, selectedDiffContext: { ...selectedDiff(), unifiedDiff: diff.replace(privateLine, material) } })).toThrow();
  }
  const selected = selectedDiff();
  if (selected.kind !== 'session') throw new Error('Expected session fixture');
  const hostedId = 'hosted-aaaaaaaa-aaaa-4aaa-8111-111111111112';
  expect(() => snapshotJudgmentInput(hostedId)).toThrow();
  expect(() => nativeSelectedDiffEvidence({ ...selected, provenance: { ...selected.provenance, sessionId: hostedId } })).not.toThrow();
  expect(() => nativeSelectedDiffEvidence({ ...selected, provenance: { ...selected.provenance, latestCheckpointId: '4111111111111111' } })).toThrow();
});


test('real tool admission accepts protocol-only numeric evidence and fences identity-only mutation', async () => {
  for (const mutate of [false, true]) {
    forgetGateReadings();
    using log = new SqliteDecisionLog(':memory:');
    const gate = gateReadingsPort(); const requests: JudgmentRequest<Questions>[] = [];
    let selected = selectedDiff();
    const semantic = fakePort((_name, question) => choiceAnswer(question, 'act', 0.99));
    const port: JudgmentPort = { model: gate.port.model, async ask(request) {
      request.beforeAttempt?.();
      if ('disposition' in request.questions) {
        requests.push(request as JudgmentRequest<Questions>);
        const result = await semantic.port.ask(request);
        if (mutate) selected = { ...selected, revision: 'b'.repeat(64) };
        return result;
      }
      return gate.port.ask(request);
    } };
    const previous = installJudgmentPort(withDecisionLog(port, log));
    const config = { getAutonomousSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} }, autoApprove: false, directory: '/synthetic' }),
      isAutoApproveEnabled: () => false, getWorkingDirectory: () => '/synthetic', getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }) } as PermissionConfigReader;
    const manager = new PermissionManager(undefined, config, new PolicyRuntimeState());
    try {
      const pending = manager.admitAutonomous('numeric-native-call', 'read', { files: [{ path: 'file.ts' }] }, {
        sourceOf: () => ({ goal: text, criteria: [text], selectedDiffContext: selected }),
      });
      if (mutate) await expect(pending).rejects.toThrow('changed');
      else expect((await pending).result.autonomousDecision?.outcome).toBe('act');
      expect(requests).toHaveLength(1);
      const json = JSON.stringify(requests[0]!.state);
      expect(json).toContain(privateLine); expect(json).not.toContain(numericProtocolDigest);
    } finally { installJudgmentPort(previous); forgetGateReadings(); }
  }
});
