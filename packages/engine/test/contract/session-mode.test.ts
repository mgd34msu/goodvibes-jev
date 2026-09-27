/**
 * Session mode (docs/design/contract-runner.md section 6.6): when the user
 * forbids delegation, the contract's one unit is done by the session's own
 * turn. The core turn loop (executeOrchestratorTurnLoop) is bound to the unit,
 * reports its tool rounds, is held where it would complete while the unit is
 * checked, and takes nudges as user messages, mid-run and at completion. No
 * sub-agent is spawned at any point.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { ConfigManager } from '../../sdk/src/platform/config/manager.js';
import type { HelperModel } from '../../sdk/src/platform/config/helper-model.js';
import { ConversationManager } from '../../sdk/src/platform/core/conversation.js';
import { executeOrchestratorTurnLoop, type OrchestratorTurnLoopContext } from '../../sdk/src/platform/core/orchestrator-turn-loop.js';
import type { ChatResponse, LLMProvider } from '../../sdk/src/platform/providers/interface.js';
import { UNKNOWN_MODEL_PRICING } from '../../sdk/src/platform/providers/model-pricing.js';
import type { ModelDefinition } from '../../sdk/src/platform/providers/registry-types.js';
import { ToolRegistry } from '../../sdk/src/platform/tools/registry.js';
import type { ToolCall, ToolResult } from '../../sdk/src/platform/types/tools.js';
import type { AnswerContext } from './plan-support.js';
import { eventsOf, makeHarness, oneUnitPlan, startContract, waitFor, type Harness } from './runner-support.js';
import { answers, contractOf, terminal } from './steps-support.js';

let harness: Harness | undefined;
afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

const MODEL: ModelDefinition = {
  id: 'fake-model',
  provider: 'fake',
  registryKey: 'fake:fake-model',
  displayName: 'Fake Model',
  description: 'test-only stub model',
  capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
  contextWindow: 0,
  selectable: true,
};

/** The user forbids delegation: the contract runs in session mode. */
function noDelegation(context: AnswerContext): unknown {
  return context.name === 'forbids_delegation' ? noulAnswer(0.97) : undefined;
}

/** One model reply: a tool round writing `file`, or a final answer. */
type Reply = { readonly write: string } | { readonly text: string };

function provider(replies: Reply[], seen: { requests: number }): LLMProvider {
  return {
    name: 'fake',
    models: ['fake-model'],
    async chat(): Promise<ChatResponse> {
      seen.requests += 1;
      const next = replies.shift();
      if (next === undefined) throw new Error('the model was called more times than scripted');
      if ('write' in next) {
        const call: ToolCall = { id: `call-${seen.requests}`, name: 'write', arguments: { files: [{ path: next.write, content: 'x' }] } };
        return { content: `writing ${next.write}`, toolCalls: [call], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'tool_call' };
      }
      return { content: next.text, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
    },
  };
}

/** The core turn loop's context for one session turn, bound to the harness's runner and bus. */
function turnContext(h: Harness, input: { readonly turnId: string; readonly model: LLMProvider; readonly executeToolCalls: OrchestratorTurnLoopContext['executeToolCalls'] }): { context: OrchestratorTurnLoopContext; conversation: ConversationManager } {
  const conversation = new ConversationManager();
  conversation.addUserMessage('Add a CSV parser module yourself; do not hand it to other agents.');
  const context: OrchestratorTurnLoopContext = {
    conversation,
    toolRegistry: new ToolRegistry(),
    getSystemPrompt: () => 'You are the goodvibes assistant.',
    getAbortSignal: () => undefined,
    hookDispatcher: null,
    requestRender: () => {},
    runtimeBus: h.bus,
    agentManager: h.manager,
    // The loop reads display and cache settings only; a stub reader over them.
    configManager: { get: (key: string) => (key === 'display.stream' ? false : undefined) } as unknown as Pick<ConfigManager, 'get'>,
    providerRegistry: {
      require: () => input.model,
      getCurrentModel: () => MODEL,
      getForModel: () => input.model,
      getTokenLimitsForModel: () => ({ maxOutputTokens: 4096, maxToolResultTokens: 50_000, maxToolCalls: 128, maxReasoningTokens: 16_384 }),
      getContextWindowForModel: () => 0,
      recordContextWindowRejection: () => {},
      reconcileObservedContextWindow: () => {},
      resolveModelPricing: () => UNKNOWN_MODEL_PRICING,
    },
    favoritesStore: undefined,
    cacheHitTracker: { getMetrics: () => ({ turns: 0, hitRate: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 0 }) },
    // The loop reads only the helper model's usage.
    helperModel: { getUsage: () => ({ calls: 0, inputTokens: 0, outputTokens: 0 }) } as unknown as HelperModel,
    sessionId: 'session-1',
    preTurnPlan: null,
    planManager: null,
    text: 'Add a CSV parser module yourself; do not hand it to other agents.',
    content: undefined,
    turnId: input.turnId,
    emitterContext: () => ({ sessionId: 'session-1', traceId: 'session-1:turn', source: 'test' }),
    executeToolCalls: input.executeToolCalls,
    checkContextWindowPreflight: async () => 'ok',
    normalizeUsage: (usage) => usage,
    estimateFreshTurnInputTokens: () => 0,
    getMessageQueueLength: () => 0,
    isReconciliationEnabled: () => true,
    setPendingToolCalls: () => {},
    setAutoSpawnTimeout: () => {},
    setStreamingActive: () => {},
    setStreamingInputTokens: () => {},
    addStreamingOutputTokens: () => {},
    setLastRequestInputTokens: () => {},
    setLastInputTokens: () => {},
    markTurnFailed: () => {},
    noteModelContextWindowWarning: () => {},
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    memoryRegistry: undefined,
    isPassiveKnowledgeInjectionEnabled: () => false,
    isPassiveCodeInjectionEnabled: () => false,
    getAlreadyInjectedKnowledgeIds: () => [],
    addInjectedKnowledgeIds: () => {},
    recordTurnKnowledgeInjection: () => {},
    nextTurnKnowledgeSequence: () => 1,
    contractHooks: h.runner.hooks(),
  };
  return { context, conversation };
}

/** Writes each call's files into the project, as the write tool would. */
function writer(root: string, before?: (round: number) => Promise<void>): OrchestratorTurnLoopContext['executeToolCalls'] {
  let round = 0;
  return async (_turnId, calls) => {
    round += 1;
    await before?.(round);
    return calls.map((call): ToolResult => {
      for (const file of (call.arguments as { files: { path: string }[] }).files) {
        mkdirSync(dirname(join(root, file.path)), { recursive: true });
        writeFileSync(join(root, file.path), `round ${round}\n`);
      }
      return { callId: call.id, success: true, output: 'written' };
    });
  };
}

async function sessionReady(h: Harness): Promise<string> {
  const { contract } = startContract(h, { origin: 'turn' });
  await waitFor(() => contractOf(h, contract.id).units[0]?.status === 'running', 'the session-mode unit to wait for the session', 15_000);
  return contract.id;
}

const userMessages = (conversation: ConversationManager): string[] => conversation.getMessagesForLLM()
  .filter((message) => message.role === 'user')
  .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)));

describe('session mode (6.6)', () => {
  test('the turn is held where it would complete, nudged as a user message, and completes once the unit passes; nothing is spawned', async () => {
    const h = makeHarness({ plan: oneUnitPlan(1), scripts: {}, port: answers(noDelegation) });
    harness = h;
    const contractId = await sessionReady(h);
    const contract = contractOf(h, contractId);
    expect(contract.sessionMode).toBe(true);
    expect(contract.isolation).toBe('shared');

    const seen = { requests: 0 };
    const model = provider([{ write: 'src/csv.ts' }, { text: '[unmet] a first try' }, { text: 'parser written' }], seen);
    const { context, conversation } = turnContext(h, { turnId: 'turn-1', model, executeToolCalls: writer(h.root) });
    await executeOrchestratorTurnLoop(context);
    await waitFor(() => terminal(h, contractId), 'the contract to end', 15_000);

    expect(seen.requests).toBe(3);
    const done = contractOf(h, contractId);
    expect(done.status).toBe('passed');
    const unit = done.units[0]!;
    expect(unit.agentIds).toEqual(['turn-1']);
    expect(unit.checks.filter((check) => check.trigger === 'completion').map((check) => check.result)).toEqual(['nudge', 'pass']);
    expect(unit.nudges).toHaveLength(1);
    expect(unit.nudges[0]).toMatchObject({ delivery: 'hold', agentId: 'turn-1' });
    expect(unit.nudges[0]!.consumedAt).toBeDefined();
    expect(unit.nudges[0]!.text).toStartWith(`Contract check ${unit.nudges[0]!.checkId.split('.k')[1]} on "CSV parser": the work does not pass yet.`);
    expect(userMessages(conversation)).toContain(unit.nudges[0]!.text);
    // The session did the work: no agent was spawned for the unit, only the owner record exists.
    expect(h.manager.list().map((record) => record.contractRole)).toEqual(['owner']);
    expect(eventsOf(h, 'CONTRACT_UNIT_SPAWNED')).toHaveLength(0);
    expect(done.answer).toBe('parser written');
    expect(done.commit?.status).toBe('committed');
  }, 20_000);

  test('a mid-run nudge reaches the turn at its next model call', async () => {
    let flagged = false;
    // The first tool round weakens a test: a mid-run quality problem at act.
    const weakened = (context: AnswerContext): unknown => {
      if (context.name !== 'tests_weakened') return undefined;
      const first = !flagged;
      flagged = true;
      return noulAnswer(first ? 0.97 : 0.03);
    };
    const h = makeHarness({ plan: oneUnitPlan(1), scripts: {}, port: answers(noDelegation, weakened) });
    harness = h;
    const contractId = await sessionReady(h);
    const seen = { requests: 0 };
    const model = provider([{ write: 'src/csv.test.ts' }, { write: 'src/csv.ts' }, { text: 'parser written' }], seen);
    // The second tool round waits for the first round's mid-run nudge to be queued.
    const executeToolCalls = writer(h.root, async (round) => {
      if (round === 2) await waitFor(() => contractOf(h, contractId).units[0]!.nudges.length === 1, 'the mid-run nudge');
    });
    const { context, conversation } = turnContext(h, { turnId: 'turn-7', model, executeToolCalls });
    await executeOrchestratorTurnLoop(context);
    await waitFor(() => terminal(h, contractId), 'the contract to end', 15_000);

    const unit = contractOf(h, contractId).units[0]!;
    expect(unit.nudges[0]).toMatchObject({ delivery: 'bus', agentId: 'turn-7', kinds: ['quality'] });
    expect(unit.nudges[0]!.consumedAt).toBeDefined();
    expect(userMessages(conversation).some((text) => text.includes('Existing tests or checks were deleted, skipped or loosened'))).toBe(true);
    expect(contractOf(h, contractId).status).toBe('passed');
    expect(h.manager.list().filter((record) => record.contractRole === 'unit')).toHaveLength(0);
  }, 20_000);

  test('a turn in a session with no session-mode contract runs as before', async () => {
    const h = makeHarness({ plan: oneUnitPlan(1), scripts: {} });
    harness = h;
    const seen = { requests: 0 };
    const { context } = turnContext(h, { turnId: 'turn-9', model: provider([{ text: 'hello' }], seen), executeToolCalls: writer(h.root) });
    await executeOrchestratorTurnLoop(context);
    expect(seen.requests).toBe(1);
    expect(h.runner.hooks().sessionTurn('session-1', 'turn-10')).toBeNull();
  });
});
