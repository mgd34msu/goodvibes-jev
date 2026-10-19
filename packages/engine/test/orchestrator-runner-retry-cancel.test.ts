/**
 * A cancel seen while the runner waits to retry a failed chat ends the run as
 * cancelled: AGENT_CANCELLED and the orchestration cancelled event, never
 * AGENT_FAILED. Drives the real turn loop (`runAgentTask`) with a scripted
 * provider whose first chat fails with a network or rate-limit error; the
 * record is cancelled as the retry wait begins. Its owning signal must release
 * the wait immediately, without advancing a clock or changing retry timing.
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
const SERVICE_WORDING = 'OpenAI Codex API error: server_error: An error occurred while processing your request.';

useFailureReadings([
  [NETWORK_WORDING, { category: 'network', transientNetwork: true, beforeResponse: true }],
  [RATE_LIMIT_WORDING, { category: 'rate_limit', rateLimited: true }],
  [SERVICE_WORDING, { category: 'service' }],
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

/** A provider whose first chat fails; a second chat would complete. */
function failingProvider(wording: string): { provider: LLMProvider; calls: () => number } {
  let calls = 0;
  const provider: LLMProvider = {
    name: 'fake',
    models: ['fake-model'],
    async chat(): Promise<ChatResponse> {
      calls += 1;
      if (calls === 1) {
        throw new Error(wording);
      }
      return { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
    },
  };
  return { provider, calls: () => calls };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'retry-cancel-'));

});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('a cancel during a retry wait', () => {
  test.each([
    ['network retry', NETWORK_WORDING],
    ['rate-limit retry', RATE_LIMIT_WORDING],
    ['provider response retry', SERVICE_WORDING],
  ])('during the %s ends the run cancelled, with no failure event', async (_label, wording) => {
    const record = makeRecord(`ag-${wording.length}`);
    const { provider, calls } = failingProvider(wording);
    const emitted: Emitted = { cancelled: [], failed: [], completed: [] };

    const controller = new AbortController();
    const context: AgentOrchestratorRunContext = {
      ...makeContext(dir, provider, emitted),
      getCancellationSignal: () => controller.signal,
      emitAgentProgress: (_id, progress) => {
        if (progress.includes('retrying in')) {
          record.status = 'cancelled';
          controller.abort();
        }
      },
    };
    const started = Date.now();
    await runAgentTask(context, record);
    expect(Date.now() - started).toBeLessThan(2_000);

    expect(calls()).toBe(1);
    expect(record.status).toBe('cancelled');
    expect(record.completedAt).toBeNumber();
    expect(emitted.cancelled).toEqual([record.id]);
    expect(emitted.failed).toEqual([]);
    expect(emitted.completed).toEqual([]);
  });
});

test('a server error retries the same request without repeating completed tools', async () => {
  const record = { ...makeRecord('ag-service-recovery'), tools: ['read_progress'] };
  const controller = new AbortController();
  const registry = new ToolRegistry();
  let reads = 0;
  registry.register({ definition: { name: 'read_progress', description: 'Read source progress', parameters: { type: 'object' } },
    execute: async () => { reads++; return { success: true, output: 'already inspected source contents' }; } });
  const requests: unknown[] = [];
  const provider: LLMProvider = {
    name: 'fake', models: ['fake-model'],
    async chat(request) {
      requests.push(structuredClone(request.messages));
      if (requests.length === 1) return { content: '', toolCalls: [{ id: 'read-1', name: 'read_progress', arguments: {} }],
        usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'tool_call' };
      if (requests.length === 2) throw new Error(SERVICE_WORDING);
      record.status = 'cancelled';
      controller.abort();
      throw new Error('Stopped after observing the recovered request');
    },
  };
  const emitted: Emitted = { cancelled: [], failed: [], completed: [] };
  await runAgentTask({ ...makeContext(dir, provider, emitted), getCancellationSignal: () => controller.signal,
    getFullRegistry: () => registry }, record);
  expect(requests).toHaveLength(3);
  expect(requests[2]).toEqual(requests[1]);
  expect(JSON.stringify(requests[2])).toContain('already inspected source contents');
  expect(reads).toBe(1);
  expect(emitted.failed).toEqual([]);
}, 15_000);
