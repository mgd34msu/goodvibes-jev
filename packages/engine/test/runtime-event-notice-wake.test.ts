/** A manager wake is a new execution of the same agent, not a replay of its old outcome. */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentManager, type AgentRecord } from '../sdk/src/platform/tools/agent/manager.js';
import { AgentMessageBus } from '../sdk/src/platform/agents/message-bus.js';
import { runAgentTask, type AgentOrchestratorRunContext } from '../sdk/src/platform/agents/orchestrator-runner.js';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.js';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.js';
import { emitAgentCompleted, emitAgentFailed, emitAgentRunning } from '../sdk/src/platform/runtime/emitters/agents.js';
import { registerHostRuntimeEvents, runtimeEventKey, runtimeEventOfNotice } from '../sdk/src/platform/runtime/bootstrap-runtime-events.js';
import type { AgentEvent } from '../sdk/src/events/agents.js';
import type { LLMProvider } from '../sdk/src/platform/providers/interface.js';
import type { ModelDefinition } from '../sdk/src/platform/providers/registry-types.js';
import type { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { waitFor } from './_helpers/test-timeout.js';

const MODEL: ModelDefinition = {
  id: 'fake', registryKey: 'fake:fake', provider: 'fake', displayName: 'Fake', description: 'Fixture',
  capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 0, selectable: true,
};

type TerminalAgentEvent = Extract<AgentEvent, { type: 'AGENT_FAILED' | 'AGENT_COMPLETED' }>;

function wakingAgent(outcome: 'failed' | 'completed') {
  const root = mkdtempSync(join(tmpdir(), 'notice-wake-'));
  const bus = new RuntimeEventBus();
  const messageBus = new AgentMessageBus();
  const events: TerminalAgentEvent[] = [];
  const lines: string[] = [];
  const runs: Promise<void>[] = [];
  let calls = 0;
  const provider: LLMProvider = { name: 'fake', models: ['fake'], chat: async () => {
    calls++;
    return { content: 'Done.', toolCalls: [], usage: { inputTokens: 10, outputTokens: 2 }, stopReason: 'completed' };
  } };
  const ctx = { sessionId: 'wake', traceId: 'wake', source: 'agent-orchestrator' };
  function context(limit: number): AgentOrchestratorRunContext {
    return {
      workingDirectory: root, runtimeBus: bus, featureFlagManager: null, messageBus,
      emitterContext: () => ctx, emitAgentProgress: () => {}, emitStreamDelta: () => {}, emitAgentCancelledEvent: () => {},
      emitAgentStarted: (agentId) => emitAgentRunning(bus, ctx, { agentId }),
      emitAgentFailedEvent: (agentId, error, durationMs) => emitAgentFailed(bus, ctx, { agentId, error, durationMs }),
      emitAgentCompletedEvent: (agentId, durationMs, output, toolCallsMade, usage) => emitAgentCompleted(bus, ctx, { agentId, durationMs, output, toolCallsMade, usage }),
      providerRegistry: {
        getCurrentModel: () => MODEL, getForModel: () => provider, listModels: () => [MODEL],
        getContextWindowForModel: () => 0, recordContextWindowRejection: () => {},
      },
      configManager: { get: ((key: string) => key === 'agents.maxTurns' ? limit : undefined) as ConfigManager['get'] },
      contractHooks: { onTurnEnd: () => {}, holdCompletion: async () => outcome === 'completed'
        ? { kind: 'release' } : { kind: 'continue', message: 'Keep working.', nudgeId: 'nudge' } },
      getFullRegistry: () => new ToolRegistry(), buildScopedRegistry: (_names, registry) => registry,
      resolveProviderForRecord: () => ({ provider, modelId: MODEL.id, requestedModelId: MODEL.registryKey }),
      resolveFallbackModelRoutes: () => [],
    };
  }
  const manager = new AgentManager({
    configManager: { get: () => null } as unknown as Pick<ConfigManager, 'get'>, messageBus,
    archetypeLoader: { loadArchetype: () => null },
    executor: { runAgent: (record: AgentRecord) => {
      const run = runAgentTask(context(runs.length + 1), record);
      runs.push(run);
      return run;
    } },
  });
  manager.setRuntimeBus(bus);
  const stopEvents = bus.onDomain('agents', ({ payload }) => {
    if (payload.type === 'AGENT_FAILED' || payload.type === 'AGENT_COMPLETED') events.push(payload);
  });
  const bridge = registerHostRuntimeEvents({
    runtimeBus: bus, domainDispatch: new Proxy({}, { get: () => () => {} }) as never,
    getSystemMessageRouter: () => ({ low: (text) => lines.push(text), high: (text) => lines.push(text), contract: (text) => lines.push(text) }),
    requestRender: () => {}, agentManager: manager, contractRunner: { get: () => null, list: () => [] },
  });
  return { manager, runs, events, lines, get calls() { return calls; }, stop() {
    stopEvents();
    for (const unsub of bridge.unsubs) unsub();
    if (bridge.agentStatusIntervalRef.value) clearInterval(bridge.agentStatusIntervalRef.value);
    rmSync(root, { recursive: true, force: true });
  } };
}

/** A history must append keyless items instead of coalescing them by an incomplete identity. */
function retained<T>(values: readonly T[], keyOf: (value: T) => string | undefined): T[] {
  const keyed = new Map<string, T>();
  const keyless: T[] = [];
  for (const value of values) {
    const key = keyOf(value);
    if (key === undefined) keyless.push(value);
    else keyed.set(key, value);
  }
  return [...keyed.values(), ...keyless];
}

for (const outcome of ['failed', 'completed'] as const) {
  describe(`real agent ${outcome} wake notices`, () => {
    test('retains both genuine outcomes when the manager reuses the same agent id', async () => {
      const h = wakingAgent(outcome);
      try {
        const record = h.manager.spawn({ mode: 'spawn', task: 'Check the parser', template: 'engineer', outsideContract: true }, { contractId: 'ctr-wake', contractUnitId: 'u1' });
        await h.runs[0];
        await waitFor(() => h.events.length === 1 && h.lines.length === 1);
        expect(record.status).toBe(outcome);
        expect(h.manager.wakeWithSteer(record.id, 'Try the parser again.', { allowCompleted: true }).woke).toBe(true);
        await h.runs[1];
        await waitFor(() => h.events.length === 2 && h.lines.length === 2);
        expect(record.status).toBe(outcome);
        expect(h.runs).toHaveLength(2);
        expect(h.calls).toBe(outcome === 'failed' ? 3 : 2);
        expect(h.events.map((event) => event.agentId)).toEqual([record.id, record.id]);
        const notices = h.lines.map((line) => runtimeEventOfNotice(line)!);
        expect(notices.map((notice) => notice.type)).toEqual(h.events.map((event) => event.type));
        // Before the fix both histories retain only one actual run.
        expect(retained(h.events, (event) => runtimeEventKey(event.type, event))).toHaveLength(2);
        expect(retained(notices, (notice) => notice.key)).toHaveLength(2);
        expect(notices.every((notice) => notice.key === undefined)).toBe(true);
        expect(h.events.every((event) => runtimeEventKey(event.type, event) === undefined)).toBe(true);
      } finally { h.stop(); }
    });
  });
}
