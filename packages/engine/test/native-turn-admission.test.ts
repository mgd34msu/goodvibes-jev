import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createOperatorNativeConversationIntakeClient, readNativeConversationTurnPermit, revalidateNativeConversationTurnPermit, type NativeConversationIntakeResult, type NativeConversationTurnPermit } from '../sdk/src/platform/workflow/work-ledger/native-intake-client.js';
import type { OperatorRemoteClient } from '../operator-sdk/src/client-core.js';
import { admitNativeConversationTurn, failNativeConversationTurn, readNativeConversationTurnStatus, settleNativeConversationTurn, startNativeConversationTurn } from '../sdk/src/platform/core/native-turn-admission.js';
import { isNativeConversationTurn, markNativeConversationTurnEffectsPossible, withNativeConversationTurn } from '../sdk/src/platform/core/native-turn-scope.js';
import { ProviderError } from '../sdk/src/platform/types/errors.js';
import { Orchestrator, type OrchestratorOptions } from '../sdk/src/platform/core/orchestrator.js';
import { ConversationManager } from '../sdk/src/platform/core/conversation.js';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.js';
import type { OrchestratorCoreServices } from '../sdk/src/platform/core/orchestrator-runtime.js';
import type { LLMProvider } from '../sdk/src/platform/providers/interface.js';
import type { ModelDefinition } from '../sdk/src/platform/providers/registry-types.js';
import { UNKNOWN_MODEL_PRICING } from '../sdk/src/platform/providers/model-pricing.js';
import { createAgentTool } from '../sdk/src/platform/tools/agent/index.js';
import { createWorkflowTool } from '../sdk/src/platform/tools/workflow/index.js';
import { handleFinalResponseOutcome, prepareConversationForTurn } from '../sdk/src/platform/core/orchestrator-turn-helpers.js';

const text = '  Explain café e\u0301 🧭\r\n';
function fixture() {
  const inputId = randomUUID();
  let current: NativeConversationIntakeResult = { kind: 'turn', projectId: 'native-project', requestId: `request-${inputId}`,
    sourceRef: { version: 1, inputId, sourceId: `source-${inputId}`, sourceRevision: 'revision-1', sessionId: 'native-source-session' }, route: 'answer', text };
  const calls: string[] = [];
  const invoke: OperatorRemoteClient['invoke'] = async <T>(method: string) => { calls.push(method); return structuredClone(current) as T; };
  const client = createOperatorNativeConversationIntakeClient({ invoke }, 'native-project');
  return { client, calls, inputId, set(value: NativeConversationIntakeResult) { current = value; },
    async permit() { const result = await client.capture({ requestId: `request-${inputId}`, inputId, text, unsupportedSources: [] }); return client.bindTurn(result); } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

describe('native ordinary-turn permit', () => {
  test('only the issuing client capture/admit/resume results bind, never get/cancel, JSON or clones', async () => {
    const f = fixture();
    const source = await f.client.capture({ requestId: `request-${f.inputId}`, inputId: f.inputId, text, unsupportedSources: [] });
    const permit = f.client.bindTurn(source);
    expect(f.client.bindTurn(source)).toBe(permit);
    for (const forged of [structuredClone(source), JSON.parse(JSON.stringify(source)), { ...source }]) expect(() => f.client.bindTurn(forged)).toThrow('invalid_turn_permit');
    const other = fixture(); expect(() => other.client.bindTurn(source)).toThrow('invalid_turn_permit');
    const lookup = await f.client.get({ inputId: f.inputId });
    expect(() => f.client.bindTurn(lookup as NativeConversationIntakeResult)).toThrow('invalid_turn_permit');
    const cancelled = await f.client.cancel({ inputId: f.inputId, sourceRevision: 'revision-1' });
    expect(() => f.client.bindTurn(cancelled)).toThrow('invalid_turn_permit');
    for (const operation of ['admit', 'resume'] as const) {
      const result = await f.client[operation]({ inputId: f.inputId, sourceRevision: 'revision-1' });
      expect(readNativeConversationTurnPermit(f.client.bindTurn(result)).text).toBe(text);
    }
    for (const forged of [{}, { ...permit }, structuredClone(permit), JSON.parse(JSON.stringify(permit))]) expect(() => readNativeConversationTurnPermit(forged)).toThrow('invalid_turn_permit');
    f.client.dispose(); other.client.dispose();
    expect(readNativeConversationTurnPermit(permit).text).toBe(text);
    await revalidateNativeConversationTurnPermit(permit);
    expect(f.calls.at(-1)).toBe('workLedger.intake.get');
  });
  test('binding retains immutable exact source and refuses changed identity at delivery', async () => {
    const f = fixture(); const result = await f.client.capture({ requestId: `request-${f.inputId}`, inputId: f.inputId, text, unsupportedSources: [] });
    const permit = f.client.bindTurn(result);
    if (result.kind !== 'turn') throw new Error('fixture');
    result.text = 'mutated'; result.sourceRef.sourceId = 'mutated';
    expect(readNativeConversationTurnPermit(permit)).toMatchObject({ text, projectId: 'native-project', sourceRef: { sourceId: `source-${f.inputId}` } });
    expect(Object.isFrozen(readNativeConversationTurnPermit(permit).sourceRef)).toBe(true);
    expect(() => admitNativeConversationTurn(permit, text.trim())).toThrow('identity_mismatch');
    expect(() => admitNativeConversationTurn(permit, text, [{ type: 'text', text: 'changed' }])).toThrow('identity_mismatch');
    expect(() => admitNativeConversationTurn(permit, text, undefined, 'other-project')).toThrow('identity_mismatch');
    const source = readNativeConversationTurnPermit(permit);
    f.set({ ...source, kind: 'cancelled', sourceRef: { ...source.sourceRef } } as NativeConversationIntakeResult);
    await expect(revalidateNativeConversationTurnPermit(permit)).rejects.toThrow('invalid_turn_permit'); f.client.dispose();
  });
  test('logical input dedup survives queued, running and settled states; ambiguous failure cannot replay', async () => {
    const f = fixture(); const permit = await f.permit();
    const first = admitNativeConversationTurn(permit, text)!;
    expect(admitNativeConversationTurn(permit, text)).toBeNull();
    startNativeConversationTurn(first); expect(admitNativeConversationTurn(permit, text)).toBeNull();
    failNativeConversationTurn(first, true); expect(readNativeConversationTurnStatus(permit)).toBe('retryable');
    const replayResult = await f.client.resume({ inputId: f.inputId, sourceRevision: 'revision-1' });
    expect(() => admitNativeConversationTurn(f.client.bindTurn(replayResult), text)).toThrow('recovery_required');
    const retry = admitNativeConversationTurn(permit, text)!; startNativeConversationTurn(retry);
    settleNativeConversationTurn(first); expect(readNativeConversationTurnStatus(permit)).toBe('running');
    settleNativeConversationTurn(retry); expect(admitNativeConversationTurn(permit, text)).toBeNull();
    const ambiguous = fixture(); const bound = await ambiguous.permit(); const attempt = admitNativeConversationTurn(bound, text)!;
    startNativeConversationTurn(attempt); failNativeConversationTurn(attempt, false);
    expect(() => admitNativeConversationTurn(bound, text)).toThrow('recovery_required');
    f.client.dispose(); ambiguous.client.dispose();
  });
});

const model: ModelDefinition = { id: 'fixture', provider: 'fixture', registryKey: 'fixture:model', displayName: 'Fixture', description: '',
  capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false }, contextWindow: 0, selectable: true };
const finalResponse = () => ({ content: 'Answer', toolCalls: [], stopReason: 'completed' as const, usage: { inputTokens: 1, outputTokens: 1 } });
function orchestrator(chat: LLMProvider['chat'] = async () => finalResponse()) {
  const conversation = new ConversationManager(); const tools = new ToolRegistry();
  let intakeCalls = 0, spawned = 0, planReads = 0;
  const planManager = { getActive: () => { planReads++; throw new Error('legacy plan read'); } } as unknown as NonNullable<OrchestratorCoreServices['planManager']>;
  const configManager = { get: (key: string) => key === 'behavior.notifyOnComplete' ? false : key === 'agents.contextCompactThreshold' ? 0.85 : undefined,
    getCategory: () => ({}), getWorkingDirectory: () => '/fixture' } as OrchestratorCoreServices['configManager'];
  const providerRegistry = { getCurrentModel: () => model, getForModel: () => ({ name: 'fixture', models: [model], chat }),
    getContextWindowForModel: () => 0, getKnownContextWindowForModel: () => null,
    getTokenLimitsForModel: () => ({ maxOutputTokens: 1024, maxToolResultTokens: 10_000, maxToolCalls: 10, maxReasoningTokens: 0 }),
    recordContextWindowRejection: () => {}, reconcileObservedContextWindow: () => {}, resolveModelPricing: () => UNKNOWN_MODEL_PRICING,
  } as unknown as OrchestratorCoreServices['providerRegistry'];
  const instance = new Orchestrator({ conversation, getViewportHeight: () => 0, scrollToEnd: () => {}, toolRegistry: tools,
    permissionManager: { getMode: () => 'prompt' } as OrchestratorOptions['permissionManager'],
    services: { agentManager: { list: () => [], spawn: () => { spawned++; throw new Error('legacy spawn'); } }, contractRunner: { list: () => [] },
      contractIntake: { intake: async () => { intakeCalls++; return { kind: 'turn' }; } } } });
  instance.setCoreServices({ configManager, providerRegistry, planManager });
  // Post-turn compaction has independent tests; exercise the real admission,
  // preparation, provider loop, tool handlers, and terminal ownership here.
  (instance as unknown as { runTurnReconcile: () => Promise<void> }).runTurnReconcile = async () => {};
  instance.bindNativeConversationProject('native-project');
  return { instance, conversation, tools, counters: () => ({ intakeCalls, spawned, planReads }) };
}

describe('native ordinary turn through the real orchestrator', () => {
  test('queues authentic exact text once, suppresses all legacy intake/plan paths, and dedups settled delivery', async () => {
    const f = fixture(); const permit = await f.permit(); const gate = deferred<void>(); let calls = 0;
    const h = orchestrator(async () => { calls++; await gate.promise; return finalResponse(); });
    (h.instance as unknown as { isCompacting: boolean }).isCompacting = true;
    await h.instance.handleUserInput(text, undefined, { nativeConversationTurnPermit: permit });
    await h.instance.handleUserInput(text, undefined, { nativeConversationTurnPermit: permit });
    expect(h.instance.messageQueue).toHaveLength(1);
    expect(h.instance.editQueuedMessage(h.instance.messageQueue[0]!.id, 'changed')).toBe(false);
    expect(() => h.instance.bindNativeConversationProject('different')).toThrow('identity_mismatch');
    expect(calls).toBe(0);
    (h.instance as unknown as { isCompacting: boolean }).isCompacting = false;
    const drain = (h.instance as unknown as { drainMessageQueue: () => Promise<void> }).drainMessageQueue();
    for (let i = 0; i < 50 && calls === 0; i++) await Promise.resolve();
    expect(calls).toBe(1); expect(isNativeConversationTurn()).toBe(false);
    await h.instance.handleUserInput(text, undefined, { nativeConversationTurnPermit: permit });
    expect(h.instance.messageQueue).toHaveLength(0);
    gate.resolve(); await drain;
    await h.instance.handleUserInput(text, undefined, { nativeConversationTurnPermit: permit });
    expect(calls).toBe(1); expect(h.counters()).toEqual({ intakeCalls: 0, spawned: 0, planReads: 0 });
    expect(f.calls.filter(method => method.endsWith('.get'))).toHaveLength(1);
    expect(h.conversation.getMessagesForLLM().filter(message => message.role === 'user')).toHaveLength(1);
    h.instance.dispose(); f.client.dispose();
  });
  test('fake permit is rejected before queue mutation and stale queued authority fails before model/transcript', async () => {
    const f = fixture(); const permit = await f.permit(); let calls = 0; const h = orchestrator(async () => { calls++; return finalResponse(); });
    (h.instance as unknown as { isCompacting: boolean }).isCompacting = true;
    await expect(h.instance.handleUserInput(text, undefined, { nativeConversationTurnPermit: {} as NativeConversationTurnPermit })).rejects.toThrow('invalid_turn_permit');
    expect(h.instance.messageQueue).toHaveLength(0);
    await h.instance.handleUserInput(text, undefined, { nativeConversationTurnPermit: permit });
    const source = readNativeConversationTurnPermit(permit);
    f.set({ kind: 'cancelled', projectId: source.projectId, requestId: source.requestId, sourceRef: { ...source.sourceRef } });
    (h.instance as unknown as { isCompacting: boolean }).isCompacting = false;
    await expect((h.instance as unknown as { drainMessageQueue: () => Promise<void> }).drainMessageQueue()).rejects.toThrow('invalid_turn_permit');
    expect(calls).toBe(0); expect(h.conversation.getMessagesForLLM()).toHaveLength(0);
    expect(readNativeConversationTurnStatus(permit)).toBe('recovery_required');
    h.instance.dispose(); f.client.dispose();
  });
  test('scope blocks spawn/batch including outsideContract and workflow contract, but leaves unrelated calls alone', async () => {
    const f = fixture(); const permit = await f.permit(); let starts = 0;
    const agent = createAgentTool({ manager: { guardContractLeafSpawn: () => {}, list: () => [] }, messageBus: {}, configManager: {}, archetypeLoader: {},
      contractRunner: { start: () => { starts++; throw new Error('ordinary start reached'); } }, projectRoot: '/fixture', resolveSessionId: () => 'session' } as unknown as Parameters<typeof createAgentTool>[0]);
    const workflow = createWorkflowTool({} as Parameters<typeof createWorkflowTool>[0], { contractRunner: { start: () => { starts++; throw new Error('ordinary start reached'); } }, projectRoot: '/fixture', resolveSessionId: () => 'session' });
    await withNativeConversationTurn(permit, async () => {
      for (const args of [{ mode: 'spawn', task: 'work' }, { mode: 'spawn', task: 'work', outsideContract: true },
        { mode: 'batch-spawn', tasks: [{ task: 'work', outsideContract: true }] }]) expect((await agent.execute(args)).success).toBe(false);
      expect((await workflow.execute({ mode: 'start', definition: 'contract', task: 'work' })).success).toBe(false);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(isNativeConversationTurn()).toBe(true);
    });
    expect(starts).toBe(0); expect(isNativeConversationTurn()).toBe(false);
    await workflow.execute({ mode: 'start', definition: 'contract', task: 'work' }); expect(starts).toBe(1);
    f.client.dispose();
  });
  test('native helpers neither prime/classify nor read plans or schedule fallback spawning', async () => {
    const f = fixture(); const permit = await f.permit(); const conversation = new ConversationManager(); let timers = 0;
    const forbiddenPlan = new Proxy({}, { get() { throw new Error('legacy plan path'); } });
    await withNativeConversationTurn(permit, async () => {
      const prepared = await prepareConversationForTurn(conversation, { getCurrentModel: () => model }, text, undefined, 'session', forbiddenPlan as Parameters<typeof prepareConversationForTurn>[5]);
      expect(prepared).toBeNull();
      await handleFinalResponseOutcome({ conversation, response: finalResponse(), runtimeBus: null, providerRegistry: { getCurrentModel: () => model },
        planManager: forbiddenPlan, preTurnPlan: { awaitingPlan: true }, setAutoSpawnTimeout: () => { timers++; } } as unknown as Parameters<typeof handleFinalResponseOutcome>[0]);
    });
    expect(timers).toBe(0); f.client.dispose();
  });
  test('provider failover retains the same permit only with no possible effects; ambiguous failures stay closed', async () => {
    for (const effects of [false, true]) {
      const f = fixture(); const permit = await f.permit(); const h = orchestrator(); let attempts = 0;
      const internals = h.instance as unknown as { runTurnStream: () => Promise<void>; handleTurnError: () => Promise<void> };
      internals.runTurnStream = async () => {
        attempts++;
        if (attempts === 1) { if (effects) markNativeConversationTurnEffectsPossible(); throw new ProviderError('fixture failed', 503); }
      };
      internals.handleTurnError = async () => {
        // The event observer can decide synchronously before finalization.
        expect(h.instance.canRetryNativeConversationTurn(permit)).toBe(!effects);
      };
      await h.instance.handleUserInput(text, undefined, { nativeConversationTurnPermit: permit });
      expect(h.instance.canRetryNativeConversationTurn(permit)).toBe(!effects);
      if (effects) await expect(h.instance.handleUserInput(text, undefined, { nativeConversationTurnPermit: permit })).rejects.toThrow('recovery_required');
      else {
        await h.instance.handleUserInput(text, undefined, { nativeConversationTurnPermit: permit });
        expect(attempts).toBe(2); expect(readNativeConversationTurnStatus(permit)).toBe('settled');
      }
      h.instance.dispose(); f.client.dispose();
    }
  });
});
