import { installJudgmentPort, judgmentPort } from '../errors/src/index.js';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { createCanonicalLiveCodeSource } from './_helpers/code-injection-readings.js';
/**
 * Orchestrator-runner integration: per-turn passive knowledge
 * injection wiring inside `runAgentTask`.
 *
 * Drives the REAL turn loop (`runAgentTask`) against a scripted fake LLMProvider and a
 * real `AgentMessageBus` (so `messageBus.send(..., {kind:'steer'})` exercises the exact
 * same drain path as orchestrator-runner-steer-drain.test.ts), with a fake memory
 * registry standing in for the SDK's MemoryRegistry (module-level retrieval behavior is
 * already covered by test/turn-knowledge-injection.test.ts). Covers the brief's
 * integration test matrix:
 *  - the systemPrompt sent to provider.chat on the turn a steer lands contains a block
 *    reflecting the steer, and a `knowledge_injection` session message + a
 *    record.turnInjections entry with a numeric tokenCost are recorded;
 *  - turn-1 baseline (spawn-time) injection ids are never duplicated in a later block;
 *  - the cheap re-retrieval guard: turns with no new input reuse the prior block and do
 *    NOT re-invoke the ranking pipeline (asserted via a getAll() call counter);
 *  - the compounding-regression guard: flag off (or a config budget of 0) produces a
 *    byte-identical systemPrompt across every turn, steer included;
 *  - the compaction-interaction guard: a tight context window never lets base+block
 *    exceed the same 85% threshold applyContextWindowAwareness enforces on the base.
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAgentTask, type AgentOrchestratorRunContext } from '../sdk/src/platform/agents/orchestrator-runner.js';
import { buildOrchestratorSystemPrompt, resolveSpawnKnowledgeInjections } from '../sdk/src/platform/agents/orchestrator-prompts.js';
import { AgentMessageBus } from '../sdk/src/platform/agents/message-bus.js';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.js';
import { createProcessRegistry } from '../sdk/src/platform/runtime/fleet/index.js';
import { createFeatureFlagManager } from '../sdk/src/platform/runtime/feature-flags/manager.js';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.js';
import { estimateConversationTokens, estimateTokens } from '../sdk/src/platform/core/context-compaction.js';
import { appendGoodVibesRuntimeAwarenessPrompt } from '../sdk/src/platform/tools/goodvibes-runtime/index.js';
import type { AgentRecord } from '../sdk/src/platform/tools/agent/manager.js';
import type { LLMProvider, ChatResponse, ProviderMessage } from '../sdk/src/platform/providers/interface.js';
import { ModelLimitsService } from '../sdk/src/platform/providers/model-limits.js';
import type { ModelDefinition } from '../sdk/src/platform/providers/registry-types.js';
import type { ProviderRegistry } from '../sdk/src/platform/providers/registry.js';
import type { MemoryRecord } from '../sdk/src/platform/state/memory-store.js';
import { DEFAULT_MEMORY_READINGS, useMemoryReadings } from './_helpers/memory-readings.ts';

// Knowledge ranking reads through the judgment port. The fake reads a record as
// relevant when it shares a word with the query (so the deployment-docs fillers
// match the frozen task and mem_ratelimit only matches after the rate-limiting
// steer), except mem_big, which reads as moderately relevant to anything
// (probability 0.6, score 114): above the default relevance floor (95, probability
// 0.5) but below the fillers (0.95), so it misses the spawn-time top 3 and only
// its size against the per-turn budget decides whether it is injected.
const MEM_BIG_SUMMARY = 'rate limiting uses a distributed token bucket';
useMemoryReadings({
  relevance: (task, writeScope, record) => (record.summary.startsWith(MEM_BIG_SUMMARY)
    ? { relevant: 0.6 }
    : DEFAULT_MEMORY_READINGS.relevance(task, writeScope, record)),
});

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeRecord(overrides: Partial<AgentRecord> & { id: string }): AgentRecord {
  return {
    task: 'update the deployment docs',
    template: 'engineer',
    tools: [],
    status: 'pending',
    startedAt: Date.now(),
    toolCallCount: 0,
    orchestrationDepth: 0,
    executionProtocol: 'direct',
    reviewMode: 'none',
    communicationLane: 'parent-only',
    ...overrides,
  };
}

function makeMemoryRecord(overrides: Partial<MemoryRecord> & { id: string }): MemoryRecord {
  return {
    scope: 'project',
    cls: 'fact',
    summary: 'a record',
    detail: undefined,
    tags: [],
    provenance: [],
    reviewState: 'fresh',
    confidence: 55,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/**
 * Three high-scoring, task-matching filler records. Spawn-time injection
 * (resolveSpawnKnowledgeInjections) has NO relevance floor and NO budget, it takes the
 * top-3 candidates the relevance reading does not rule out, so a lone record would otherwise be
 * trivially "the only candidate" and land in the spawn baseline regardless of
 * relevance. These fillers occupy that top-3 for a frozen task of
 * "update the deployment docs" so a record that does NOT match that task is reliably
 * excluded from the spawn baseline, letting tests isolate what per-turn retrieval adds.
 */
function makeDeploymentDocsFillers(): MemoryRecord[] {
  return [
    makeMemoryRecord({ id: 'mem_filler_1', summary: 'deployment docs: update the staging rollout checklist', tags: ['deploy'], reviewState: 'reviewed', confidence: 90 }),
    makeMemoryRecord({ id: 'mem_filler_2', summary: 'deployment docs: update the production rollback checklist', tags: ['deploy'], reviewState: 'reviewed', confidence: 88 }),
    makeMemoryRecord({ id: 'mem_filler_3', summary: 'deployment docs: update the canary release checklist', tags: ['deploy'], reviewState: 'reviewed', confidence: 86 }),
  ];
}

/** getAll() call count is the cheap, reliable proxy for "did retrieval actually run",
 *  selectKnowledgeForTaskScored calls registry.getAll() exactly once per invocation,
 *  spawn-time or per-turn, with or without a semanticCandidates method present. */
function makeCountingMemoryRegistry(records: MemoryRecord[]) {
  const counters = { getAllCalls: 0 };
  return {
    registry: {
      getAll: () => {
        counters.getAllCalls += 1;
        return records;
      },
      semanticCandidates: () => [],
      vectorStats: () => ({
        backend: 'sqlite-vec' as const,
        enabled: false,
        available: false,
        path: '',
        dimensions: 0,
        indexedRecords: 0,
        embeddingProviderId: 'none',
        embeddingProviderLabel: 'none',
      }),
    },
    counters,
  };
}

const FAKE_MODEL: ModelDefinition = {
  id: 'fake-model',
  provider: 'fake',
  registryKey: 'fake:fake-model',
  displayName: 'Fake Model',
  description: 'test-only stub model',
  capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
  contextWindow: 0, // 0 short-circuits context-window-awareness bookkeeping unless overridden per-test
  selectable: true,
};

function makeProviderRegistry(
  provider: LLMProvider,
  contextWindow = 0,
): Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel' | 'listModels' | 'getContextWindowForModel' | 'getKnownContextWindowForModel' | 'recordContextWindowRejection'> {
  return {
    getCurrentModel: () => FAKE_MODEL,
    getForModel: () => provider,
    listModels: () => [FAKE_MODEL],
    getContextWindowForModel: () => contextWindow,
    getKnownContextWindowForModel: () => contextWindow,
    recordContextWindowRejection: () => {},
  };
}

function makeContext(opts: {
  workingDirectory: string;
  runtimeBus: RuntimeEventBus;
  messageBus: Pick<AgentMessageBus, 'getMessages'>;
  provider: LLMProvider;
  contextWindow?: number;
  featureFlagManager?: AgentOrchestratorRunContext['featureFlagManager'];
  memoryRegistry?: AgentOrchestratorRunContext['memoryRegistry'];
  passiveKnowledgeInjectionBudgetTokens?: number;
  passiveKnowledgeInjectionRelevanceFloor?: number;
}): AgentOrchestratorRunContext {
  return {
    workingDirectory: opts.workingDirectory,
    surfaceRoot: undefined,
    runtimeBus: opts.runtimeBus,
    featureFlagManager: opts.featureFlagManager ?? null,
    emitterContext: () => ({ sessionId: 'test-session', traceId: 'test-trace', source: 'test' }),
    emitAgentProgress: () => {},
    emitAgentStarted: () => {},
    emitAgentCancelledEvent: () => {},
    emitAgentFailedEvent: () => {},
    emitAgentCompletedEvent: () => {},
    emitStreamDelta: () => {},
    processManager: undefined,
    messageBus: opts.messageBus,
    knowledgeService: undefined,
    memoryRegistry: opts.memoryRegistry,
    passiveKnowledgeInjectionBudgetTokens: opts.passiveKnowledgeInjectionBudgetTokens,
    passiveKnowledgeInjectionRelevanceFloor: opts.passiveKnowledgeInjectionRelevanceFloor,
    archetypeLoader: undefined,
    providerOptimizer: undefined,
    providerRegistry: makeProviderRegistry(opts.provider, opts.contextWindow ?? 0),
    getFullRegistry: () => new ToolRegistry(),
    buildScopedRegistry: (_allowedNames, fullRegistry) => fullRegistry,
    resolveProviderForRecord: (_registry, _record, currentModel) => ({
      provider: opts.provider,
      modelId: currentModel.id,
      requestedModelId: currentModel.registryKey,
    }),
    resolveFallbackModelRoutes: () => [],
  };
}

function makeRegistryDeps(record: AgentRecord, messageBus: Pick<AgentMessageBus, 'send'>) {
  return {
    agentManager: { list: () => [record], cancel: () => false },
    contractRunner: { list: () => [], cancel: () => false },
    processManager: { list: () => [], stop: () => false, getStatus: () => undefined },
    watcherRegistry: { list: () => [], stopWatcher: () => null },
    workflow: {
      workflowManager: { list: () => [], cancel: () => false },
      triggerManager: { list: () => [], remove: () => false, disable: () => false, enable: () => false },
      scheduleManager: { list: () => [], remove: () => false, disable: () => false, enable: () => false },
    },
    messageBus,
  };
}

/** These fixtures intentionally repeat a failed lookup while testing memory reuse.
 * Supply the canonical observation explicitly; absence must still hold real runs. */
async function withSettledRepeatStuck(work: () => Promise<void>): Promise<void> {
  const original = judgmentPort('test.orchestrator-repeat-stuck');
  const repeat = fakePort(() => noulAnswer(.99));
  const port: typeof original = {
    model: original.model,
    ...(original.recorder ? { recorder: original.recorder } : {}),
    ask(request) {
      return request.context?.battery === 'engine.agents.repeat-stuck'
        ? repeat.port.ask(request) : original.ask(request);
    },
  };
  const previous = installJudgmentPort(port);
  try { await work(); } finally { installJudgmentPort(previous); }
}

describe('orchestrator-runner: per-turn passive knowledge injection', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  test('a steer surfaces a record the frozen task alone would miss; records the turn, dedupes against the spawn baseline', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'turn-knowledge-'));
    const messageBus = new AgentMessageBus();
    const runtimeBus = new RuntimeEventBus();
    const record = makeRecord({ id: 'ag-turn-knowledge-1' });
    const registry = createProcessRegistry(makeRegistryDeps(record, messageBus));

    // Against the frozen task mem_ratelimit reads as not relevant, so spawn-time
    // selection and turn-1 per-turn retrieval (which queries the still-frozen task)
    // both leave it out. Only the steer's "rate limiting" makes it read as relevant,
    // clearing the floor.
    const { registry: memoryRegistry } = makeCountingMemoryRegistry([
      ...makeDeploymentDocsFillers(),
      makeMemoryRecord({
        id: 'mem_ratelimit',
        summary: 'rate limiting: token bucket, 100 requests per minute',
        tags: ['rate-limiting'],
        reviewState: 'fresh',
        confidence: 55,
      }),
    ]);

    const capturedSystemPrompts: string[] = [];
    let chatCallCount = 0;
    const provider: LLMProvider = {
      name: 'fake',
      models: ['fake-model'],
      async chat(request): Promise<ChatResponse> {
        chatCallCount += 1;
        capturedSystemPrompts.push(request.systemPrompt ?? '');
        if (chatCallCount === 1) {
          registry.steer(record.id, 'focus on rate limiting specifically');
          return { content: '', toolCalls: [{ id: 'call-1', name: 'nonexistent_tool', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'tool_call' };
        }
        return { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
      },
    };

    const context = makeContext({ workingDirectory: tmpDir, runtimeBus, messageBus, provider, memoryRegistry });
    await runAgentTask(context, record);
    await flushMicrotasks();

    expect(chatCallCount).toBe(2);
    expect(record.status).toBe('completed');

    // Turn 1: the frozen task never mentions rate limiting, the spawn-time baseline
    // (top-3 fillers) and turn-1 per-turn retrieval (same frozen query, below floor) both
    // leave mem_ratelimit out.
    expect(capturedSystemPrompts[0]).not.toContain('mem_ratelimit');

    // Turn 2: the steer's content flows into the derived query and surfaces the record.
    expect(capturedSystemPrompts[1]).toContain('mem_ratelimit');
    expect(capturedSystemPrompts[1]).toContain('Injected Project Knowledge');

    // Honest per-turn record: stored on AgentRecord.turnInjections AND the session
    // transcript, with a numeric, budget-consistent tokenCost.
    const injectedTurn = record.turnInjections?.find((entry) => entry.injectedIds.includes('mem_ratelimit'));
    expect(injectedTurn).toBeDefined();
    expect(injectedTurn?.turn).toBe(2);
    expect(typeof injectedTurn?.tokenCost).toBe('number');
    expect(injectedTurn!.tokenCost).toBeGreaterThan(0);
    expect(injectedTurn!.tokenCost).toBeLessThanOrEqual(injectedTurn!.budgetTokens);

    registry.dispose();
  });

  test('turns without new input reuse the prior block: the ranking pipeline is not re-invoked', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'turn-knowledge-reuse-'));
    const messageBus = new AgentMessageBus();
    const runtimeBus = new RuntimeEventBus();
    const record = makeRecord({ id: 'ag-turn-knowledge-2', task: 'fix the rate limiting bug' });
    const registry = createProcessRegistry(makeRegistryDeps(record, messageBus));

    const { registry: memoryRegistry, counters } = makeCountingMemoryRegistry([
      makeMemoryRecord({ id: 'mem_ratelimit', summary: 'rate limiting: token bucket, 100 requests per minute', tags: ['rate-limiting'], reviewState: 'reviewed', confidence: 80 }),
    ]);

    let chatCallCount = 0;
    // Snapshot the CUMULATIVE getAll() count at the moment each chat() call is made,
    // retrieval for a turn always runs (or is skipped) before that turn's chat call, so
    // this pins exactly which turns re-ran the ranking pipeline. Reading the counter only
    // after runAgentTask resolves (as the whole task loop has already finished by then)
    // would not distinguish "grew on turn 4" from "grew on turn 2".
    const getAllCallsAtChat: number[] = [];
    const provider: LLMProvider = {
      name: 'fake',
      models: ['fake-model'],
      async chat(): Promise<ChatResponse> {
        chatCallCount += 1;
        getAllCallsAtChat.push(counters.getAllCalls);
        if (chatCallCount < 3) {
          // Turns 1 and 2: a tool call, no steer, no new conversation input.
          return { content: '', toolCalls: [{ id: `call-${chatCallCount}`, name: 'nonexistent_tool', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'tool_call' };
        }
        if (chatCallCount === 3) {
          // Turn 3: a steer is queued mid-turn, it lands on the message bus AFTER this
          // chat call's own (already-made) retrieval decision, so it cannot affect turn
          // 3's own count; it becomes visible to turn 4's drain instead.
          registry.steer(record.id, 'also check the burst allowance');
          return { content: '', toolCalls: [{ id: 'call-3', name: 'nonexistent_tool', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'tool_call' };
        }
        return { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
      },
    };

    const context = makeContext({ workingDirectory: tmpDir, runtimeBus, messageBus, provider, memoryRegistry });
    await withSettledRepeatStuck(() => runAgentTask(context, record));
    await flushMicrotasks();

    expect(chatCallCount).toBe(4);
    expect(record.status).toBe('completed');
    // getAll() is called once for the spawn-time baseline (buildOrchestratorSystemPrompt)
    // and once for turn 1's per-turn retrieval (turn===1 counts as "new input"), both
    // BEFORE turn 1's chat call. Turns 2 and 3 have no new input, so the pipeline is not
    // re-invoked (count holds at 2). Turn 4 drains turn 3's steer at its own top, that
    // IS new input, so the count grows to 3 exactly there, not before.
    expect(getAllCallsAtChat).toEqual([2, 2, 2, 3]);

    registry.dispose();
  });

  test('flag disabled: base system prompt is byte-identical across every turn, steer included (no compounding)', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'turn-knowledge-flagoff-'));
    const messageBus = new AgentMessageBus();
    const runtimeBus = new RuntimeEventBus();
    const record = makeRecord({ id: 'ag-turn-knowledge-flagoff' });
    const registry = createProcessRegistry(makeRegistryDeps(record, messageBus));

    const { registry: memoryRegistry } = makeCountingMemoryRegistry([
      makeMemoryRecord({ id: 'mem_ratelimit', summary: 'rate limiting: token bucket, 100 requests per minute', tags: ['rate-limiting'], reviewState: 'reviewed', confidence: 90 }),
    ]);

    const featureFlagManager = createFeatureFlagManager();
    featureFlagManager.disable('agent-passive-knowledge-injection');

    const capturedSystemPrompts: string[] = [];
    let chatCallCount = 0;
    const provider: LLMProvider = {
      name: 'fake',
      models: ['fake-model'],
      async chat(request): Promise<ChatResponse> {
        chatCallCount += 1;
        capturedSystemPrompts.push(request.systemPrompt ?? '');
        if (chatCallCount === 1) {
          registry.steer(record.id, 'focus on rate limiting specifically');
          return { content: '', toolCalls: [{ id: 'call-1', name: 'nonexistent_tool', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'tool_call' };
        }
        return { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
      },
    };

    const context = makeContext({ workingDirectory: tmpDir, runtimeBus, messageBus, provider, memoryRegistry, featureFlagManager });
    await runAgentTask(context, record);
    await flushMicrotasks();

    expect(chatCallCount).toBe(2);
    // The spawn-time baseline (buildOrchestratorSystemPrompt, pre-existing/out-of-scope
    // for this per-turn injection feature) is unaffected by this flag and may still appear in both prompts, that is
    // fine and expected. What must hold, and is asserted here, is that turn 2's prompt is
    // BYTE-IDENTICAL to turn 1's (the steer changed nothing) and that no per-turn record
    // was ever produced.
    expect(capturedSystemPrompts[0]).toBe(capturedSystemPrompts[1]);
    expect(record.turnInjections ?? []).toEqual([]);

    registry.dispose();
  });

  test('config budget of 0 is a hard no-op even with the flag enabled and a matching steer', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'turn-knowledge-budget0-'));
    const messageBus = new AgentMessageBus();
    const runtimeBus = new RuntimeEventBus();
    const record = makeRecord({ id: 'ag-turn-knowledge-budget0' });
    const registry = createProcessRegistry(makeRegistryDeps(record, messageBus));

    const { registry: memoryRegistry } = makeCountingMemoryRegistry([
      makeMemoryRecord({ id: 'mem_ratelimit', summary: 'rate limiting: token bucket, 100 requests per minute', tags: ['rate-limiting'], reviewState: 'reviewed', confidence: 90 }),
    ]);

    const capturedSystemPrompts: string[] = [];
    let chatCallCount = 0;
    const provider: LLMProvider = {
      name: 'fake',
      models: ['fake-model'],
      async chat(request): Promise<ChatResponse> {
        chatCallCount += 1;
        capturedSystemPrompts.push(request.systemPrompt ?? '');
        if (chatCallCount === 1) {
          registry.steer(record.id, 'focus on rate limiting specifically');
          return { content: '', toolCalls: [{ id: 'call-1', name: 'nonexistent_tool', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'tool_call' };
        }
        return { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
      },
    };

    const context = makeContext({
      workingDirectory: tmpDir,
      runtimeBus,
      messageBus,
      provider,
      memoryRegistry,
      passiveKnowledgeInjectionBudgetTokens: 0,
    });
    await runAgentTask(context, record);
    await flushMicrotasks();

    expect(chatCallCount).toBe(2);
    // As in the flag-disabled test above: the spawn-time baseline is untouched by this
    // config knob (out of this per-turn injection feature's scope) and may appear in both; what matters is that the
    // two prompts are byte-identical and no per-turn record was produced.
    expect(capturedSystemPrompts[0]).toBe(capturedSystemPrompts[1]);
    expect(record.turnInjections ?? []).toEqual([]);

    registry.dispose();
  });

  test('compaction interaction: a tight context window never lets base+block exceed the 85% threshold', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'turn-knowledge-threshold-'));
    const messageBus = new AgentMessageBus();
    const runtimeBus = new RuntimeEventBus();
    // Reuse the "deployment docs" frozen task from the first test: the 3 fillers occupy
    // spawn-time's top-3 (mem_big reads at 0.6 against their 0.95, see the port set up
    // at the top of this file), so mem_big is excluded from the SPAWN baseline,
    // isolating this test to the PER-TURN budget mechanism alone. mem_big still clears
    // the default relevance floor (95, probability 0.5), so turn-1 per-turn retrieval
    // attempts to inject it; only its size against a tight budget is at stake.
    const record = makeRecord({ id: 'ag-turn-knowledge-threshold', task: 'update the deployment docs' });
    const { registry: memoryRegistry } = makeCountingMemoryRegistry([
      ...makeDeploymentDocsFillers(),
      // A summary long enough that its rendered block costs well over the ~40-token
      // headroom this test leaves for it.
      makeMemoryRecord({
        id: 'mem_big',
        summary: 'rate limiting uses a distributed token bucket with per-tenant quotas, burst allowance, sliding window reconciliation, and a Redis-backed counter that is synchronized across every regional edge node every five seconds',
        tags: ['rate-limiting'],
        reviewState: 'reviewed',
        confidence: 90,
      }),
    ]);

    // Measure the REAL base prompt's token cost first (same call runAgentTask makes
    // internally at systemPrompt = buildOrchestratorSystemPrompt(record, undefined, context)),
    // using the SAME memoryRegistry so the spawn-time baseline this computes (the 3
    // fillers) matches what the real run will produce, then pick a context window whose
    // 85% threshold sits only slightly above that, leaving a small but nonzero headroom
    // for a block, and no headroom at all for one that's too large to fit.
    const probeContext = makeContext({
      workingDirectory: tmpDir,
      runtimeBus,
      messageBus,
      provider: { name: 'probe', models: [], chat: async () => { throw new Error('unused'); } },
      memoryRegistry,
    });
    // NOTE: the actual chat() call wraps the composed systemPrompt in
    // appendGoodVibesRuntimeAwarenessPrompt(...) at the call site, a fixed-size runtime
    // notice appended AFTER every budget/threshold decision runs (pre-existing behavior,
    // unrelated to and unchanged by the per-turn knowledge injection feature: neither the old nor the new code counts this
    // suffix in applyContextWindowAwareness's own sysTokens estimate). Folding its cost
    // into the probe measurement here makes THIS TEST's wire-level "never exceeds
    // threshold" assertion honest, without changing what the runner itself measures.
    await resolveSpawnKnowledgeInjections(record, probeContext);
    const baseSystemPrompt = appendGoodVibesRuntimeAwarenessPrompt(buildOrchestratorSystemPrompt(record, undefined, probeContext));
    const baseTokens = estimateTokens(baseSystemPrompt);
    const initialMessageTokens = estimateConversationTokens([{ role: 'user', content: record.task } as ProviderMessage]);
    const tightWindow = Math.ceil((baseTokens + initialMessageTokens + 40) / 0.85); // ~40 tokens of headroom

    const processRegistry = createProcessRegistry(makeRegistryDeps(record, messageBus));
    const capturedSystemPrompts: string[] = [];
    let chatCallCount = 0;
    const provider: LLMProvider = {
      name: 'fake',
      models: ['fake-model'],
      async chat(request): Promise<ChatResponse> {
        chatCallCount += 1;
        capturedSystemPrompts.push(request.systemPrompt ?? '');
        return { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
      },
    };

    const context = makeContext({
      workingDirectory: tmpDir,
      runtimeBus,
      messageBus,
      provider,
      memoryRegistry,
      contextWindow: tightWindow,
      featureFlagManager: createFeatureFlagManager(),
    });
    await runAgentTask(context, record);
    await flushMicrotasks();

    expect(chatCallCount).toBe(1);
    // Whatever the runner decided to send, it must never exceed the same 85% threshold
    // applyContextWindowAwareness itself enforces, the block cannot silently push it over.
    const sentTokens = estimateTokens(capturedSystemPrompts[0]!) + estimateConversationTokens([{ role: 'user', content: record.task } as ProviderMessage]);
    expect(sentTokens).toBeLessThanOrEqual(Math.floor(tightWindow * 0.85));
    // The oversized record could not fit in ~40 tokens of headroom, so it must be absent
    // (and the top-3 fillers, having already been surfaced at spawn time, do not appear
    // a second time either, dedupe, not budget, explains their absence from any
    // per-turn block, but either way none of them re-inflate the prompt).
    expect(capturedSystemPrompts[0]).not.toContain('mem_big');

    processRegistry.dispose();
  });
  test.each(['fallback', 'accepted_floor', 'consensus'] as const)('real runner never trims history against a %s estimate', async (source) => {
    tmpDir = mkdtempSync(join(tmpdir(), 'runner-unknown-window-'));
    const messageBus = new AgentMessageBus();
    const runtimeBus = new RuntimeEventBus();
    const record = makeRecord({ id: `unknown-window-${source}`, task: 'Keep the original task and every earlier message: ' + 'context '.repeat(100) });
    const processRegistry = createProcessRegistry(makeRegistryDeps(record, messageBus));
    for (let i = 0; i < 14; i++) processRegistry.steer(record.id, `earlier-steer-${i}: retain this fact`);
    const requests: ProviderMessage[][] = [];
    const provider: LLMProvider = {
      name: 'fake', models: ['fake-model'],
      async chat(request) {
        requests.push(structuredClone(request.messages));
        return { content: 'done', toolCalls: [], usage: { inputTokens: 1000, outputTokens: 1 }, stopReason: 'completed' };
      },
    };
    const model: ModelDefinition = { ...FAKE_MODEL, contextWindow: 64,
      contextWindowProvenance: source === 'consensus' ? 'catalog' : source,
      ...(source === 'consensus' ? { contextWindowOrigin: { kind: 'consensus' as const, providers: 3, agreeing: 3 } } : {}),
    };
    const limits = new ModelLimitsService({ cachePath: join(tmpDir, 'no-limits.json') });
    const context = makeContext({ workingDirectory: tmpDir, runtimeBus, messageBus, provider, contextWindow: 64 });
    const realKnowledgeContext: AgentOrchestratorRunContext = { ...context, providerRegistry: {
      ...context.providerRegistry,
      getCurrentModel: () => model,
      listModels: () => [model],
      getContextWindowForModel: () => limits.getContextWindowForModel(model),
      getKnownContextWindowForModel: () => limits.getKnownContextWindowForModel(model),
    } };
    try {
      await runAgentTask(realKnowledgeContext, record);
      expect(record.status).toBe('completed');
      expect(requests).toHaveLength(1);
      const userMessages = requests[0]!.filter((message) => message.role === 'user').map((message) => message.content);
      expect(userMessages).toContain(record.task);
      for (let i = 0; i < 14; i++) expect(userMessages).toContain(`earlier-steer-${i}: retain this fact`);
    } finally { processRegistry.dispose(); }
  });

});

// Captured code generations are independently refreshed; memory retains its existing lifecycle.
test('captured same-line generations refresh without reranking memory and old attempts cannot reuse a released generation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'captured-injection-runner-'));
  try {
    const memory = makeCountingMemoryRegistry([]);
    const record = makeRecord({ id: 'captured-generation-runner' });
    const flags = createFeatureFlagManager(); flags.enable('agent-passive-code-injection');
    let generation = 0; let active = false; let disposed = false;
    const prompts: string[] = []; const reads: number[] = []; const attempts: (() => void | Promise<void>)[] = [];
    const provider: LLMProvider = { name: 'fake', models: ['fake-model'], async chat(request) {
      prompts.push(request.systemPrompt ?? ''); reads.push(memory.counters.getAllCalls);
      if (request.beforeAttempt) { attempts.push(request.beforeAttempt); await request.beforeAttempt(); }
      return { content: 'done', toolCalls: prompts.length < 2 ? [{ id: 'c', name: 'nonexistent_tool', arguments: {} }] : [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: prompts.length < 2 ? 'tool_call' : 'completed' };
    } };
    const base = makeContext({ workingDirectory: root, runtimeBus: new RuntimeEventBus(), messageBus: new AgentMessageBus(), provider, featureFlagManager: flags, memoryRegistry: memory.registry });
    const codeIndex: NonNullable<AgentOrchestratorRunContext['codeIndex']> = {
      prepare: async () => { generation++; active = true; },
      generation: () => active ? String(generation) : undefined,
      assertCurrent: async (expected) => { if (!active || (expected !== undefined && expected !== String(generation))) throw new Error('stale code generation'); },
      finishTurn: () => { active = false; }, dispose: () => { disposed = true; },
      rankForInjection: async (_query, hits) => ({ ranked: hits.map(hit => ({ hit, probability: 0.99 })), assertCurrent: async () => {} }),
      stats: () => ({ available: true, indexedChunks: 1, semanticRetrievalAvailable: true }),
      search: async () => [{ chunk: { chunkId: String(generation), path: 'same.ts', lang: 'typescript', symbol: `symbolGeneration${generation}`, kind: 'function', startLine: 1, endLine: 3, contentHash: String(generation), fileHash: String(generation), mtimeMs: generation }, distance: 0, similarity: 1, label: 'semantic' }],
    };
    await runAgentTask({ ...base, codeIndex, beforeProviderRequest: async () => {} }, record);
    expect(record.status).toBe('completed'); expect(generation).toBe(2); expect(disposed).toBe(true);
    expect(prompts[0]).toContain('symbolGeneration1'); expect(prompts[1]).toContain('symbolGeneration2'); expect(prompts[1]).not.toContain('symbolGeneration1');
    expect(reads[1]).toBe(reads[0]);
    const codeIds = record.turnInjections!.map(r => r.injectedIds[0]); expect(codeIds[0]).not.toBe(codeIds[1]);
    await expect(attempts[0]!()).rejects.toThrow('stale code generation');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ordinary captured runs attach fresh async provider retry admission even without native or prepared prompts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'captured-retry-runner-'));
  try {
    const record = makeRecord({ id: 'captured-retry-only' });
    let allowed = true; let attempts = 0;
    const provider: LLMProvider = { name: 'fake', models: ['fake-model'], async chat(request) {
      expect(request.beforeAttempt).toBeDefined();
      await request.beforeAttempt!(); attempts++;
      allowed = false;
      await expect(request.beforeAttempt!()).rejects.toThrow('original policy revoked');
      return { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
    } };
    const base = makeContext({ workingDirectory: root, runtimeBus: new RuntimeEventBus(), messageBus: new AgentMessageBus(), provider });
    await runAgentTask({ ...base, beforeProviderRequest: async () => { await Promise.resolve(); if (!allowed) throw new Error('original policy revoked'); } }, record);
    expect(attempts).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('captured code-disabled turns retain independent memory when no code budget remains', async () => {
  const root = mkdtempSync(join(tmpdir(), 'captured-memory-budget-'));
  try {
    let reads = 0; let budget = 800; let preparation = 0;
    const memoryRegistry = { ...makeCountingMemoryRegistry([]).registry, getAll: () => ++reads === 1 ? [] : [makeMemoryRecord({ id: 'retained-memory', summary: 'deployment docs use deployment templates', confidence: 90, reviewState: 'reviewed' })] };
    const record = makeRecord({ id: 'captured-memory-only' });
    const flags = createFeatureFlagManager(); flags.disable('agent-passive-code-injection');
    const prompts: string[] = [];
    const provider: LLMProvider = { name: 'fake', models: ['fake-model'], async chat(request) {
      prompts.push(request.systemPrompt ?? '');
      if (prompts.length === 1) budget = record.turnInjections![0]!.tokenCost;
      return { content: '', toolCalls: prompts.length < 2 ? [{ id: 'c', name: 'nonexistent_tool', arguments: {} }] : [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: prompts.length < 2 ? 'tool_call' : 'completed' };
    } };
    const base = makeContext({ workingDirectory: root, runtimeBus: new RuntimeEventBus(), messageBus: new AgentMessageBus(), provider, memoryRegistry, featureFlagManager: flags });
    await runAgentTask({ ...base, get passiveKnowledgeInjectionBudgetTokens() { return budget; }, codeIndex: {
      prepare: async () => { preparation++; }, stats: () => ({ available: false, indexedChunks: 0, semanticRetrievalAvailable: false }), search: async () => [],
    } }, record);
    expect(record.status).toBe('completed'); expect(prompts.length).toBe(2); expect(preparation).toBe(0); expect(reads).toBe(2);
    expect(prompts[0]).toContain('deployment docs use deployment templates'); expect(prompts[1]).toBe(prompts[0]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('disabling the global passive flag after a captured turn cannot reuse released code pointers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'captured-global-gate-'));
  try {
    const record = makeRecord({ id: 'captured-global-gate' });
    const flags = createFeatureFlagManager(); flags.enable('agent-passive-code-injection');
    let active = false; let prepares = 0;
    const prompts: string[] = [];
    const provider: LLMProvider = { name: 'fake', models: ['fake-model'], async chat(request) {
      prompts.push(request.systemPrompt ?? '');
      flags.disable('agent-passive-knowledge-injection');
      return { content: '', toolCalls: prompts.length < 2 ? [{ id: 'c', name: 'nonexistent_tool', arguments: {} }] : [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: prompts.length < 2 ? 'tool_call' : 'completed' };
    } };
    const base = makeContext({ workingDirectory: root, runtimeBus: new RuntimeEventBus(), messageBus: new AgentMessageBus(), provider, memoryRegistry: makeCountingMemoryRegistry([]).registry, featureFlagManager: flags });
    await runAgentTask({ ...base, codeIndex: {
      prepare: async () => { prepares++; active = true; }, generation: () => active ? 'generation-1' : undefined, finishTurn: () => { active = false; },
      rankForInjection: async (_query, hits) => ({ ranked: hits.map(hit => ({ hit, probability: 0.99 })), assertCurrent: async () => {} }),
      stats: () => ({ available: true, indexedChunks: 1, semanticRetrievalAvailable: true }),
      search: async () => [{ chunk: { chunkId: 'a', path: 'old.ts', lang: 'typescript', symbol: 'oldSymbol', kind: 'function', startLine: 1, endLine: 3, contentHash: 'old', fileHash: 'old', mtimeMs: 1 }, distance: 0, similarity: 1, label: 'semantic' }],
    } }, record);
    expect(record.status).toBe('completed'); expect(prepares).toBe(1);
    expect(prompts[0]).toContain('oldSymbol'); expect(prompts[1]).not.toContain('oldSymbol'); expect(prompts[1]).not.toContain('## Injected Code Context');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.each([false, true])('new-input zero-budget turn clears memory through later continuations (captured=%s)', async (captured) => {
  const root = mkdtempSync(join(tmpdir(), 'captured-memory-clear-'));
  const messageBus = new AgentMessageBus();
  const record = makeRecord({ id: `memory-clear-${captured}` });
  const processRegistry = createProcessRegistry(makeRegistryDeps(record, messageBus));
  try {
    let reads = 0;
    let budget = 800;
    let preparations = 0;
    const memoryRegistry = { ...makeCountingMemoryRegistry([]).registry, getAll: () => ++reads === 1 ? [] : [makeMemoryRecord({
      id: 'prior-deployment-memory', summary: 'deployment docs use deployment templates', confidence: 90, reviewState: 'reviewed',
    })] };
    const flags = createFeatureFlagManager();
    flags.disable('agent-passive-code-injection');
    const prompts: string[] = [];
    const provider: LLMProvider = { name: 'fake', models: ['fake-model'], async chat(request) {
      prompts.push(request.systemPrompt ?? '');
      if (prompts.length === 1) {
        budget = 0;
        processRegistry.steer(record.id, 'Now investigate the rate limiting behavior.');
      }
      const continuing = prompts.length < 3;
      return { content: '', toolCalls: continuing ? [{ id: `c${prompts.length}`, name: 'nonexistent_tool', arguments: {} }] : [],
        usage: { inputTokens: 1, outputTokens: 1 }, stopReason: continuing ? 'tool_call' : 'completed' };
    } };
    const base = makeContext({ workingDirectory: root, runtimeBus: new RuntimeEventBus(), messageBus, provider, memoryRegistry, featureFlagManager: flags });
    await withSettledRepeatStuck(() => runAgentTask({ ...base, get passiveKnowledgeInjectionBudgetTokens() { return budget; }, ...(captured ? { codeIndex: {
      prepare: async () => { preparations++; },
      stats: () => ({ available: false, indexedChunks: 0, semanticRetrievalAvailable: false }), search: async () => [],
    } } : {}) }, record));
    expect(record.status).toBe('completed');
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain('deployment docs use deployment templates');
    expect(prompts[1]).not.toContain('deployment docs use deployment templates');
    expect(prompts[2]).not.toContain('deployment docs use deployment templates');
    expect(reads).toBe(2);
    expect(preparations).toBe(0);
    expect(record.turnInjections).toHaveLength(1);
  } finally {
    processRegistry.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(['success', 'retry', 'continuation', 'policy-retry', 'file-continuation'] as const)('agent runner retains per-reading authority for code %s', async mode => {
  const root = mkdtempSync(join(tmpdir(), 'code-authority-runner-'));
  const live = await createCanonicalLiveCodeSource();
  try {
    installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
    let dispatched = 0;
    const flags = createFeatureFlagManager(); flags.enable('agent-passive-code-injection');
    const provider: LLMProvider = { name: 'fake', models: ['fake-model'], async chat(request) {
      dispatched++;
      expect(request.systemPrompt).toContain('backoff.ts');
      expect(request.beforeAttempt).toBeDefined();
      await request.beforeAttempt!();
      if (mode === 'success') return { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
    if (mode === 'policy-retry') live.deny();
      else if (mode === 'file-continuation') live.mutate();
      else installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
      if (mode === 'retry' || mode === 'policy-retry') await request.beforeAttempt!();
      return { content: '', toolCalls: [{ id: 'next', name: 'nonexistent_tool', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'tool_call' };
    } };
    const record = makeRecord({ id: `code-authority-${mode}` });
    const context = makeContext({ workingDirectory: root, runtimeBus: new RuntimeEventBus(), messageBus: new AgentMessageBus(), provider,
      memoryRegistry: makeCountingMemoryRegistry([]).registry, featureFlagManager: flags });
    await runAgentTask({ ...context, codeIndex: live.store, codeReadAccessFilter: live.readAccessFilter }, record);
    expect(record.status).toBe(mode === 'success' ? 'completed' : 'failed');
    expect(dispatched).toBe(1);
  } finally { live.dispose(); rmSync(root, { recursive: true, force: true }); }
});
