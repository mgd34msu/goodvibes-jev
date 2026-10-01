/**
 * A cancel seen while the runner waits to retry a failed chat ends the run as
 * cancelled: AGENT_CANCELLED and the orchestration cancelled event, never
 * AGENT_FAILED. Drives the real turn loop (`runAgentTask`) with a scripted
 * provider whose first chat fails with a network or rate-limit error; the
 * record is cancelled while the retry wait is pending. The waits (5s and 60s)
 * are shortened by a setTimeout wrapper for the duration of each test.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAgentTask, type AgentOrchestratorRunContext } from '../sdk/src/platform/agents/orchestrator-runner.js';
import { AgentMessageBus } from '../sdk/src/platform/agents/message-bus.js';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.js';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.js';
import type { AgentRecord } from '../sdk/src/platform/tools/agent/manager.js';
import type { ChatResponse, LLMProvider } from '../sdk/src/platform/providers/interface.js';
import type { ModelDefinition } from '../sdk/src/platform/providers/registry-types.js';
import { useFailureReadings } from './_helpers/failure-readings.ts';

const NETWORK_WORDING = 'socket hang up while streaming the reply';
const RATE_LIMIT_WORDING = 'Rate limit reached for requests per minute';

useFailureReadings([
  [NETWORK_WORDING, { category: 'network', transientNetwork: true, beforeResponse: true }],
  [RATE_LIMIT_WORDING, { category: 'rate_limit', rateLimited: true }],
]);

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

interface Emitted {
  readonly cancelled: string[];
  readonly failed: string[];
  readonly completed: string[];
}

function makeContext(workingDirectory: string, provider: LLMProvider, emitted: Emitted): AgentOrchestratorRunContext {
  return {
    workingDirectory,
    surfaceRoot: undefined,
    runtimeBus: new RuntimeEventBus(),
    featureFlagManager: null,
    emitterContext: () => ({ sessionId: 'test-session', traceId: 'test-trace', source: 'test' }),
    emitAgentProgress: () => {},
    emitAgentStarted: () => {},
    emitAgentCancelledEvent: (id) => { emitted.cancelled.push(id); },
    emitAgentFailedEvent: (id) => { emitted.failed.push(id); },
    emitAgentCompletedEvent: (id) => { emitted.completed.push(id); },
    emitStreamDelta: () => {},
    processManager: undefined,
    messageBus: new AgentMessageBus(),
    knowledgeService: undefined,
    memoryRegistry: undefined,
    archetypeLoader: undefined,
    providerOptimizer: undefined,
    providerRegistry: {
      getCurrentModel: () => FAKE_MODEL,
      getForModel: () => provider,
      listModels: () => [FAKE_MODEL],
      getContextWindowForModel: () => 0,
      getKnownContextWindowForModel: () => 0,
      recordContextWindowRejection: () => {},
    },
    getFullRegistry: () => new ToolRegistry(),
    buildScopedRegistry: (_allowedNames, fullRegistry) => fullRegistry,
    resolveProviderForRecord: (_registry, _record, currentModel) => ({ provider, modelId: currentModel.id, requestedModelId: currentModel.registryKey }),
    resolveFallbackModelRoutes: () => [],
  };
}

function makeRecord(id: string): AgentRecord {
  return {
    id,
    task: 'do work',
    template: 'engineer',
    tools: [],
    status: 'pending',
    startedAt: Date.now(),
    toolCallCount: 0,
    orchestrationDepth: 0,
    executionProtocol: 'direct',
    reviewMode: 'none',
    communicationLane: 'parent-only',
  };
}

/** A provider whose first chat cancels the record and fails with `wording`; a second chat would complete. */
function cancellingProvider(record: AgentRecord, wording: string): { provider: LLMProvider; calls: () => number } {
  let calls = 0;
  const provider: LLMProvider = {
    name: 'fake',
    models: ['fake-model'],
    async chat(): Promise<ChatResponse> {
      calls += 1;
      if (calls === 1) {
        // The operator cancels while this call is failing; the runner sees it after the retry wait.
        (record as { status: string }).status = 'cancelled';
        throw new Error(wording);
      }
      return { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
    },
  };
  return { provider, calls: () => calls };
}

const realSetTimeout = globalThis.setTimeout;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'retry-cancel-'));
  // Retry waits are 5s to 60s; run them at once so the test sees the post-wait check.
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
    realSetTimeout(handler as () => void, (delay ?? 0) >= 5_000 ? 0 : delay, ...args)) as unknown as typeof setTimeout; // the wrapper has no promisify member
});
afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  rmSync(dir, { recursive: true, force: true });
});

describe('a cancel during a retry wait', () => {
  test.each([
    ['network retry', NETWORK_WORDING],
    ['rate-limit retry', RATE_LIMIT_WORDING],
  ])('during the %s ends the run cancelled, with no failure event', async (_label, wording) => {
    const record = makeRecord(`ag-${wording.length}`);
    const { provider, calls } = cancellingProvider(record, wording);
    const emitted: Emitted = { cancelled: [], failed: [], completed: [] };

    await runAgentTask(makeContext(dir, provider, emitted), record);

    expect(calls()).toBe(1);
    expect(record.status).toBe('cancelled');
    expect(record.completedAt).toBeNumber();
    expect(emitted.cancelled).toEqual([record.id]);
    expect(emitted.failed).toEqual([]);
    expect(emitted.completed).toEqual([]);
  });
});
