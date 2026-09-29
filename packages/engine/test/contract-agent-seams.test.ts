/**
 * The contract runner's agent-loop seams (docs/design/contract-runner.md
 * section 4.1): the completion hold and the turn-end hook in runAgentTask, the
 * mid-run nudge through the message bus, the wake of a stopped unit agent, and
 * the contract binding a spawn carries.
 *
 * Drives the real turn loop (orchestrator-runner.ts) against a scripted fake
 * provider, and the real AgentManager, AgentMessageBus and RuntimeEventBus.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAgentTask, type AgentOrchestratorRunContext } from '../sdk/src/platform/agents/orchestrator-runner.js';
import { AgentMessageBus } from '../sdk/src/platform/agents/message-bus.js';
import { TURN_BUDGET_EXHAUSTED } from '../sdk/src/platform/agents/turn-budget.js';
import { CIRCUIT_BREAKER_TRIPPED, CONSECUTIVE_ERROR_BREAK } from '../sdk/src/platform/core/circuit-breaker.js';
import type { ContractAgentHooks, ContractHoldOutcome } from '../sdk/src/platform/contract/agent-hooks.js';
import type { ContractTurnRecord } from '../sdk/src/platform/contract/evidence.js';
import { CONTRACT_RUNNER_AGENT_ID, dispatchNudge } from '../sdk/src/platform/contract/nudge.js';
import type { Nudge } from '../sdk/src/platform/contract/types.js';
import type { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.js';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.js';
import { AgentManager, type AgentRecord } from '../sdk/src/platform/tools/agent/manager.js';
import type { LLMProvider, ChatRequest, ChatResponse } from '../sdk/src/platform/providers/interface.js';
import type { ModelDefinition } from '../sdk/src/platform/providers/registry-types.js';
import type { ProviderRegistry } from '../sdk/src/platform/providers/registry.js';
import type { AgentEvent } from '../sdk/src/events/agents.js';
import { createOrchestrationEngine } from '../sdk/src/platform/orchestration/engine.js';
import type { PhaseRunnerAgentManagerLike } from '../sdk/src/platform/orchestration/phase-runner.js';
import type { AgentInput } from '../sdk/src/platform/tools/agent/schema.js';
import type { ContractUnitBinding } from '../sdk/src/platform/tools/agent/manager.js';
import { emitAgentCompleted } from '../sdk/src/platform/runtime/emitters/agents.js';
import type { CommunicationEvent } from '../sdk/src/events/communication.js';

type ConsumedEvent = Extract<CommunicationEvent, { type: 'COMMUNICATION_CONSUMED' }>;

const FAKE_MODEL: ModelDefinition = {
  id: 'fake-model',
  provider: 'fake',
  registryKey: 'fake:fake-model',
  displayName: 'Fake Model',
  description: 'test-only stub model',
  capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
  contextWindow: 0,
  selectable: true,
};

function reply(content: string, toolCalls: ChatResponse['toolCalls'] = []): ChatResponse {
  return {
    content,
    toolCalls,
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: toolCalls.length > 0 ? 'tool_call' : 'completed',
  };
}

/** A provider that answers each chat call from `script` in order and records every request. */
function scriptedProvider(script: Array<(request: ChatRequest) => ChatResponse>): LLMProvider & { readonly requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    name: 'fake',
    models: ['fake-model'],
    requests,
    async chat(request: ChatRequest): Promise<ChatResponse> {
      requests.push(request);
      const step = script[requests.length - 1];
      if (!step) throw new Error(`unscripted chat call ${requests.length}`);
      return step(request);
    },
  };
}

function userMessages(request: ChatRequest | undefined): string[] {
  return (request?.messages ?? [])
    .filter((message) => message.role === 'user' && typeof message.content === 'string')
    .map((message) => message.content as string);
}

function makeRecord(overrides: Partial<AgentRecord> & { id: string }): AgentRecord {
  return {
    task: 'implement the parser',
    template: 'engineer',
    tools: [],
    status: 'pending',
    startedAt: Date.now(),
    toolCallCount: 0,
    orchestrationDepth: 0,
    executionProtocol: 'direct',
    reviewMode: 'contract',
    communicationLane: 'parent-only',
    ...overrides,
  };
}

interface LoopTaps {
  readonly completed: string[];
  readonly failed: string[];
  readonly cancelled: string[];
}

function makeContext(opts: {
  workingDirectory: string;
  runtimeBus: RuntimeEventBus;
  messageBus: Pick<AgentMessageBus, 'getMessages'>;
  provider: LLMProvider;
  contractHooks?: ContractAgentHooks;
  configManager?: Pick<ConfigManager, 'get'>;
  taps?: LoopTaps;
}): AgentOrchestratorRunContext {
  const providerRegistry: Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel' | 'listModels' | 'getContextWindowForModel' | 'recordContextWindowRejection'> = {
    getCurrentModel: () => FAKE_MODEL,
    getForModel: () => opts.provider,
    listModels: () => [FAKE_MODEL],
    getContextWindowForModel: () => 0,
    recordContextWindowRejection: () => {},
  };
  return {
    workingDirectory: opts.workingDirectory,
    surfaceRoot: undefined,
    runtimeBus: opts.runtimeBus,
    featureFlagManager: null,
    emitterContext: () => ({ sessionId: 'test-session', traceId: 'test-trace', source: 'test' }),
    emitAgentProgress: () => {},
    emitAgentStarted: () => {},
    emitAgentCancelledEvent: (recordId) => { opts.taps?.cancelled.push(recordId); },
    emitAgentFailedEvent: (recordId) => { opts.taps?.failed.push(recordId); },
    emitAgentCompletedEvent: (recordId) => { opts.taps?.completed.push(recordId); },
    emitStreamDelta: () => {},
    messageBus: opts.messageBus,
    ...(opts.contractHooks ? { contractHooks: opts.contractHooks } : {}),
    ...(opts.configManager ? { configManager: opts.configManager } : {}),
    providerRegistry,
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

/** Hooks that answer each completion hold from `holds` in order and record every call. */
function scriptedHooks(holds: Array<(record: AgentRecord) => ContractHoldOutcome | Promise<ContractHoldOutcome>>): ContractAgentHooks & {
  readonly turns: ContractTurnRecord[];
  readonly holdCalls: string[];
} {
  const turns: ContractTurnRecord[] = [];
  const holdCalls: string[] = [];
  return {
    turns,
    holdCalls,
    onTurnEnd: (_record, turn) => { turns.push(turn); },
    holdCompletion: async (record) => {
      holdCalls.push(record.id);
      const step = holds[holdCalls.length - 1];
      if (!step) throw new Error(`unscripted hold ${holdCalls.length}`);
      return step(record);
    },
  };
}

function consumedEvents(runtimeBus: RuntimeEventBus): ConsumedEvent[] {
  const events: ConsumedEvent[] = [];
  runtimeBus.onDomain('communication', (envelope) => {
    if (envelope.payload.type === 'COMMUNICATION_CONSUMED') events.push(envelope.payload);
  });
  return events;
}

const NUDGE_TEXT = 'Contract check 1 on "Parser": the work does not pass yet. Fix what is listed, then finish your turn; it will be checked again.\n\nNot met:\n- [u1.c1] parse() rejects empty input';

let tmpDir: string | undefined;
function workDir(): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'contract-seams-'));
  return tmpDir;
}
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

describe('completion hold', () => {
  test('a held agent receives the continue message verbatim as a user turn and completes only on release', async () => {
    const runtimeBus = new RuntimeEventBus();
    const consumed = consumedEvents(runtimeBus);
    const taps: LoopTaps = { completed: [], failed: [], cancelled: [] };
    const provider = scriptedProvider([() => reply('first attempt'), () => reply('fixed attempt')]);
    const hooks = scriptedHooks([
      (record) => {
        // While held the agent has not completed: no completed event yet.
        expect(record.status).toBe('running');
        expect(taps.completed).toHaveLength(0);
        return { kind: 'continue', message: NUDGE_TEXT, nudgeId: 'u1.n1' };
      },
      () => ({ kind: 'release' }),
    ]);
    const record = makeRecord({ id: 'agent-held', contractId: 'ctr-00000001', contractRole: 'unit', contractUnitId: 'u1' });

    await runAgentTask(makeContext({ workingDirectory: workDir(), runtimeBus, messageBus: new AgentMessageBus(), provider, contractHooks: hooks, taps }), record);

    expect(provider.requests).toHaveLength(2);
    expect(userMessages(provider.requests[0])).not.toContain(NUDGE_TEXT);
    const secondTurnUser = userMessages(provider.requests[1]);
    expect(secondTurnUser.at(-1)).toBe(NUDGE_TEXT);
    expect(hooks.holdCalls).toEqual(['agent-held', 'agent-held']);
    expect(record.status).toBe('completed');
    expect(record.fullOutput).toBe('fixed attempt');
    expect(taps.completed).toEqual(['agent-held']);
    // The nudge is reported consumed once, after the turn it was added to got a response.
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({ messageId: 'u1.n1', agentId: 'agent-held', turn: 2 });
  });

  test('an agent with no contractUnitId is never held and its turns are never reported', async () => {
    const provider = scriptedProvider([
      () => reply('', [{ id: 'call-1', name: 'nonexistent_tool', arguments: {} }]),
      () => reply('done'),
    ]);
    const hooks = scriptedHooks([]);
    const record = makeRecord({ id: 'agent-free', reviewMode: 'none' });

    await runAgentTask(makeContext({ workingDirectory: workDir(), runtimeBus: new RuntimeEventBus(), messageBus: new AgentMessageBus(), provider, contractHooks: hooks }), record);

    expect(record.status).toBe('completed');
    expect(hooks.holdCalls).toHaveLength(0);
    expect(hooks.turns).toHaveLength(0);
  });

  test('a hold released while the runner cancels the unit ends the loop cancelled, never completed', async () => {
    const taps: LoopTaps = { completed: [], failed: [], cancelled: [] };
    const provider = scriptedProvider([() => reply('attempt')]);
    const hooks = scriptedHooks([
      (record) => {
        // The runner's cancel: release every pending hold, then cancel the agent, in one tick.
        const released: ContractHoldOutcome = { kind: 'release' };
        record.status = 'cancelled';
        return released;
      },
    ]);
    const record = makeRecord({ id: 'agent-cancel', contractId: 'ctr-00000001', contractRole: 'unit', contractUnitId: 'u1' });

    await runAgentTask(makeContext({ workingDirectory: workDir(), runtimeBus: new RuntimeEventBus(), messageBus: new AgentMessageBus(), provider, contractHooks: hooks, taps }), record);

    expect(record.status).toBe('cancelled');
    expect(taps.completed).toHaveLength(0);
    expect(taps.cancelled).toEqual(['agent-cancel']);
  });
});

describe('turn end', () => {
  test('each turn that ran tools reaches onTurnEnd with its calls, results in order, and assistant text', async () => {
    const provider = scriptedProvider([
      () => reply('checking the file', [{ id: 'call-1', name: 'nonexistent_tool', arguments: { path: 'src/a.ts' } }]),
      () => reply('done'),
    ]);
    const hooks = scriptedHooks([() => ({ kind: 'release' })]);
    const record = makeRecord({ id: 'agent-turns', contractId: 'ctr-00000001', contractRole: 'unit', contractUnitId: 'u1' });

    await runAgentTask(makeContext({ workingDirectory: workDir(), runtimeBus: new RuntimeEventBus(), messageBus: new AgentMessageBus(), provider, contractHooks: hooks }), record);

    expect(hooks.turns).toHaveLength(1);
    const [turn] = hooks.turns;
    expect(turn!.turn).toBe(1);
    expect(turn!.assistantText).toBe('checking the file');
    expect(turn!.toolCalls).toEqual([{ name: 'nonexistent_tool', arguments: { path: 'src/a.ts' } }]);
    expect(turn!.results).toHaveLength(1);
    expect(turn!.results[0]!.callId).toBe('call-1');
    expect(turn!.results[0]!.success).toBe(false);
    expect(record.status).toBe('completed');
  });

  test('a throwing onTurnEnd is logged and never breaks the loop', async () => {
    const provider = scriptedProvider([
      () => reply('', [{ id: 'call-1', name: 'nonexistent_tool', arguments: {} }]),
      () => reply('done'),
    ]);
    const hooks: ContractAgentHooks = {
      onTurnEnd: () => { throw new Error('observer failed'); },
      holdCompletion: async () => ({ kind: 'release' }),
    };
    const record = makeRecord({ id: 'agent-throw', contractId: 'ctr-00000001', contractRole: 'unit', contractUnitId: 'u1' });

    await runAgentTask(makeContext({ workingDirectory: workDir(), runtimeBus: new RuntimeEventBus(), messageBus: new AgentMessageBus(), provider, contractHooks: hooks }), record);

    expect(record.status).toBe('completed');
    expect(provider.requests).toHaveLength(2);
  });
});

describe('mid-run nudge through the bus', () => {
  test('a steer from contract-runner is drained verbatim at the next turn and its consumed event fires', async () => {
    const runtimeBus = new RuntimeEventBus();
    const consumed = consumedEvents(runtimeBus);
    const messageBus = new AgentMessageBus();
    messageBus.registerAgent({ agentId: CONTRACT_RUNNER_AGENT_ID, role: 'orchestrator' });
    const record = makeRecord({ id: 'agent-bus', contractId: 'ctr-00000001', contractRole: 'unit', contractUnitId: 'u1' });
    messageBus.registerAgent({ agentId: record.id, template: 'engineer', contractId: 'ctr-00000001' });
    const nudge: Nudge = {
      id: 'u1.n1',
      checkId: 'u1.k1',
      at: Date.now(),
      kinds: ['regression'],
      criterionIds: ['u1.c1'],
      text: NUDGE_TEXT,
      delivery: 'bus',
      agentId: record.id,
    };
    const provider = scriptedProvider([
      () => {
        // The runner's turn-end check nudges while this turn is in flight.
        const dispatched = dispatchNudge(nudge, 'running', {
          messageBus,
          agentManager: { wakeWithSteer: () => ({ woke: false, reason: 'not used' }) },
          nudgeTtlMs: 300_000,
        });
        expect(dispatched).toEqual({ kind: 'sent' });
        return reply('', [{ id: 'call-1', name: 'nonexistent_tool', arguments: {} }]);
      },
      () => reply('done'),
    ]);
    const hooks = scriptedHooks([() => ({ kind: 'release' })]);

    await runAgentTask(makeContext({ workingDirectory: workDir(), runtimeBus, messageBus, provider, contractHooks: hooks }), record);

    expect(userMessages(provider.requests[0])).not.toContain(NUDGE_TEXT);
    expect(userMessages(provider.requests[1])).toContain(NUDGE_TEXT);
    for (const content of userMessages(provider.requests[1])) expect(content).not.toContain('from contract-runner');
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({ messageId: 'u1.n1', agentId: record.id, turn: 2 });
  });
});

describe('waking a stopped unit agent', () => {
  function managerRunningLoop(opts: { provider: LLMProvider; hooks: ContractAgentHooks; runtimeBus: RuntimeEventBus; taps: LoopTaps; maxTurns: number; workingDirectory: string }) {
    const context = makeContext({
      workingDirectory: opts.workingDirectory,
      runtimeBus: opts.runtimeBus,
      messageBus: new AgentMessageBus(),
      provider: opts.provider,
      contractHooks: opts.hooks,
      configManager: { get: ((key: string) => (key === 'agents.maxTurns' ? opts.maxTurns : undefined)) as ConfigManager['get'] },
      taps: opts.taps,
    });
    const runs: Array<Promise<void>> = [];
    const manager = new AgentManager({
      configManager: { get: () => null } as unknown as Pick<ConfigManager, 'get'>,
      messageBus: { registerAgent() {} },
      archetypeLoader: { loadArchetype: () => null },
      executor: { runAgent: (record) => { const run = runAgentTask(context, record); runs.push(run); return run; } },
    });
    return { manager, runs };
  }

  test('a turn-budget failure after a held continue is woken with the nudge and completes', async () => {
    const taps: LoopTaps = { completed: [], failed: [], cancelled: [] };
    const provider = scriptedProvider([() => reply('first attempt'), () => reply('fixed attempt')]);
    const hooks = scriptedHooks([
      () => ({ kind: 'continue', message: 'not used: the budget ends the loop first', nudgeId: 'u1.n1' }),
      () => ({ kind: 'release' }),
    ]);
    const { manager, runs } = managerRunningLoop({ provider, hooks, runtimeBus: new RuntimeEventBus(), taps, maxTurns: 1, workingDirectory: workDir() });

    const record = manager.spawn({ mode: 'spawn', task: 'implement the parser', template: 'engineer', outsideContract: true }, { contractId: 'ctr-00000001', contractUnitId: 'u1' });
    await runs[0];

    // A continue on the budget's last turn lets the loop hit its limit and fail.
    expect(record.status).toBe('failed');
    expect(record.failureReason).toBe(TURN_BUDGET_EXHAUSTED);
    expect(taps.failed).toEqual([record.id]);
    expect(taps.completed).toHaveLength(0);

    const wake = manager.wakeWithSteer(record.id, NUDGE_TEXT);
    expect(wake.woke).toBe(true);
    await runs[1];

    expect(provider.requests).toHaveLength(2);
    expect(userMessages(provider.requests[1])).toContain(NUDGE_TEXT);
    expect(record.status).toBe('completed');
    expect(record.failureReason).toBeUndefined();
    expect(record.fullOutput).toBe('fixed attempt');
    expect(taps.completed).toEqual([record.id]);
  });

  test('a circuit-breaker stop fails the unit agent with the structured reason the runner wakes on, never holding it', async () => {
    const taps: LoopTaps = { completed: [], failed: [], cancelled: [] };
    const failingTurn = () => reply('', [{ id: 'call-x', name: 'nonexistent_tool', arguments: {} }]);
    const provider = scriptedProvider(Array.from({ length: CONSECUTIVE_ERROR_BREAK }, () => failingTurn));
    const hooks = scriptedHooks([]);
    const record = makeRecord({ id: 'agent-breaker', contractId: 'ctr-00000001', contractRole: 'unit', contractUnitId: 'u1' });

    await runAgentTask(makeContext({ workingDirectory: workDir(), runtimeBus: new RuntimeEventBus(), messageBus: new AgentMessageBus(), provider, contractHooks: hooks, taps }), record);

    expect(record.status).toBe('failed');
    expect(record.failureReason).toBe(CIRCUIT_BREAKER_TRIPPED);
    expect(hooks.holdCalls).toHaveLength(0);
    expect(hooks.turns).toHaveLength(CONSECUTIVE_ERROR_BREAK);
    expect(taps.failed).toEqual([record.id]);
  });

  test('a completed contract unit is woken only with allowCompleted, and reruns with the nudge', async () => {
    const taps: LoopTaps = { completed: [], failed: [], cancelled: [] };
    const provider = scriptedProvider([() => reply('first attempt'), () => reply('reworked attempt')]);
    const hooks = scriptedHooks([() => ({ kind: 'release' }), () => ({ kind: 'release' })]);
    const { manager, runs } = managerRunningLoop({ provider, hooks, runtimeBus: new RuntimeEventBus(), taps, maxTurns: 5, workingDirectory: workDir() });

    const record = manager.spawn({ mode: 'spawn', task: 'implement the parser', template: 'engineer', outsideContract: true }, { contractId: 'ctr-00000001', contractUnitId: 'u1' });
    await runs[0];
    expect(record.status).toBe('completed');

    expect(manager.wakeWithSteer(record.id, NUDGE_TEXT).woke).toBe(false);
    expect(runs).toHaveLength(1);

    const wake = manager.wakeWithSteer(record.id, NUDGE_TEXT, { allowCompleted: true });
    expect(wake).toEqual({ woke: true, reason: 're-triggered from completed state with steer' });
    await runs[1];

    expect(userMessages(provider.requests[1])).toContain(NUDGE_TEXT);
    expect(record.status).toBe('completed');
    expect(record.fullOutput).toBe('reworked attempt');
  });
});

describe('spawn contract binding', () => {
  test('a bound spawn stamps the unit fields, starts no contract, and announces them on AGENT_SPAWNING', async () => {
    const runtimeBus = new RuntimeEventBus();
    const spawning: Array<Extract<AgentEvent, { type: 'AGENT_SPAWNING' }>> = [];
    runtimeBus.onDomain('agents', (envelope) => {
      if (envelope.payload.type === 'AGENT_SPAWNING') spawning.push(envelope.payload);
    });
    const startForOwner = { calls: 0 };
    const manager = new AgentManager({
      configManager: { get: () => null } as unknown as Pick<ConfigManager, 'get'>,
      messageBus: { registerAgent() {} },
      archetypeLoader: { loadArchetype: () => null },
      executor: { runAgent: async () => {} },
      contractRunner: { startForOwner: () => { startForOwner.calls += 1; throw new Error('a bound or outside-contract spawn never starts a contract'); } },
    });
    manager.setRuntimeBus(runtimeBus);

    const bound = manager.spawn(
      { mode: 'spawn', task: 'unit brief', template: 'engineer' },
      { contractId: 'ctr-00000001', contractUnitId: 'u2', routeReason: 'tier: implementation' },
    );
    expect(bound).toMatchObject({
      contractId: 'ctr-00000001',
      contractRole: 'unit',
      contractUnitId: 'u2',
      routeReason: 'tier: implementation',
      reviewMode: 'contract',
    });
    expect(startForOwner.calls).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0)); // the bus delivers on a microtask
    expect(spawning.at(-1)).toMatchObject({ agentId: bound.id, contractId: 'ctr-00000001', contractRole: 'unit', contractUnitId: 'u2' });

    const outside = manager.spawn({ mode: 'spawn', task: 'side task', template: 'general', outsideContract: true });
    expect(outside.contractId).toBeUndefined();
    expect(outside.contractUnitId).toBeUndefined();
    expect(outside.reviewMode).toBe('none');
    expect(startForOwner.calls).toBe(0);
  });
});

describe('phase runner contract binding', () => {
  test('a contract work item spawns its agent bound to the unit, with the brief verbatim and the route and tool contract', async () => {
    const runtimeBus = new RuntimeEventBus();
    const spawns: Array<{ input: AgentInput; binding: ContractUnitBinding | undefined; record: AgentRecord }> = [];
    const settlements = new Map<string, (outcome: 'completed' | 'failed' | 'cancelled') => void>();
    const agentManager: PhaseRunnerAgentManagerLike = {
      spawn(input: AgentInput, binding?: ContractUnitBinding): AgentRecord {
        const record = makeRecord({ id: `agent-${spawns.length + 1}`, task: input.task ?? '', status: 'running' });
        spawns.push({ input, binding, record });
        return record;
      },
      getStatus: (id) => spawns.find((spawn) => spawn.record.id === id)?.record ?? null,
      cancel: () => true,
      registerCancellationSignal: () => {},
      releaseCancellationSignal: () => {},
    };
    const engine = createOrchestrationEngine({
      agentManager,
      configManager: {
        get: ((key: string) => (key === 'contract.transportRetryLimit' ? 0 : undefined)) as ConfigManager['get'],
        getCategory: (() => undefined) as unknown as ConfigManager['getCategory'],
      },
      runtimeBus,
      projectRoot: workDir(),
      createWorktree: () => ({
        merge: async () => true,
        cleanup: async () => {},
        commitWorkingTree: async () => ({ hash: null, skippedIgnored: [] }),
        currentHead: async () => null,
      }),
      persist: false,
      skipClaimVerification: true,
      // A contract item's phase waits on the runner's settlement, not on its agent's terminal event.
      contractUnitSettlement: {
        settle: (_item, agentId) => new Promise((resolve) => { settlements.set(agentId, resolve); }),
        beforeSpawn: async () => ({ kind: 'spawn' }),
      },
    });
    const route = { model: 'fake:fake-model', provider: 'fake', fallbackModels: ['fake:other-model'], reasoningEffort: 'high', reason: 'tier: implementation' };
    const ws = engine.createWorkstream({
      id: 'g1',
      title: 'Parser group',
      phases: [{ role: 'engineer', capacity: 2, kind: 'engineer', gate: { scope: 'off', gates: [] } }],
      items: [
        {
          id: 'u1', title: 'Parser', task: 'UNIT BRIEF: implement parse()',
          contractId: 'ctr-00000001', contractUnitId: 'u1', route,
          tools: ['read', 'edit'], restrictTools: true, template: 'integrator',
        },
        { id: 'plain', title: 'Plain item', task: 'plain task' },
      ],
    });
    // The item carries the spec's binding, copied rather than aliased.
    const item = ws.items.find((candidate) => candidate.id === 'u1')!;
    expect(item).toMatchObject({ contractId: 'ctr-00000001', contractUnitId: 'u1', route, tools: ['read', 'edit'], restrictTools: true, template: 'integrator' });
    expect(item.route).not.toBe(route);

    engine.start(ws.id);
    for (let i = 0; i < 20 && spawns.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(spawns).toHaveLength(2);

    const unit = spawns.find((spawn) => spawn.binding !== undefined)!;
    expect(unit.binding).toEqual({ contractId: 'ctr-00000001', contractUnitId: 'u1', routeReason: 'tier: implementation' });
    expect(unit.input).toMatchObject({
      task: 'UNIT BRIEF: implement parse()',
      template: 'integrator',
      tools: ['read', 'edit'],
      restrictTools: true,
      model: 'fake:fake-model',
      provider: 'fake',
      fallbackModels: ['fake:other-model'],
      reasoningEffort: 'high',
      outsideContract: true,
    });
    const plain = spawns.find((spawn) => spawn.binding === undefined)!;
    expect(plain.input.task).toBe('plain task');
    expect(plain.input.model).toBeUndefined();

    for (const spawn of spawns) {
      spawn.record.status = 'completed';
      emitAgentCompleted(runtimeBus, { sessionId: 'test', traceId: 'test', source: 'test' }, { agentId: spawn.record.id, durationMs: 1 });
    }
    // The plain item settles on its agent's completion; the unit only once the runner settles it.
    expect(settlements.has(unit.record.id)).toBe(true);
    settlements.get(unit.record.id)!('completed');
    for (let i = 0; i < 20 && engine.getWorkstream(ws.id)!.items.some((candidate) => candidate.state !== 'passed'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(engine.getWorkstream(ws.id)!.items.map((candidate) => candidate.state)).toEqual(['passed', 'passed']);
    engine.dispose();
  });
});
