import { afterEach, describe, expect, test } from 'bun:test';
import { Orchestrator, type OrchestratorOptions } from '../sdk/src/platform/core/orchestrator.js';
import { ConversationManager } from '../sdk/src/platform/core/conversation.js';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.js';
import type { ConfigManager } from '../sdk/src/platform/config/manager.js';
import type { PermissionManager } from '../sdk/src/platform/permissions/manager.js';
import type { ModelDefinition, ProviderRegistry } from '../sdk/src/platform/providers/registry.js';
import type { ChatRequest, LLMProvider } from '../sdk/src/platform/providers/interface.js';
import { UNKNOWN_MODEL_PRICING } from '../sdk/src/platform/providers/model-pricing.js';
import { PLAN_MODE_INSTRUCTION_MARKER } from '../sdk/src/platform/permissions/plan-mode-instructions.js';
import { useCoreReadings } from './_helpers/core-readings.ts';

useCoreReadings({ intent: 'chat', needsPlan: false, risk: 0 });
const orchestrators: Orchestrator[] = [];
afterEach(() => { for (const orchestrator of orchestrators.splice(0)) orchestrator.dispose(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function fixture(getSystemPrompt: NonNullable<OrchestratorOptions['getSystemPrompt']>) {
  const conversation = new ConversationManager();
  const requests: ChatRequest[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const model: ModelDefinition = {
    id: 'test', registryKey: 'test:test', displayName: 'Test', description: 'test', provider: 'test',
    contextWindow: 0, selectable: true,
    capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false },
  };
  const provider: LLMProvider = {
    name: 'test', models: ['test'],
    chat: async (request) => {
      requests.push(request);
      return { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
    },
  };
  const providerRegistry = {
    getCurrentModel: () => model, getForModel: () => provider,
    getContextWindowForModel: () => 0,
    getKnownContextWindowForModel: () => 0,
    getTokenLimitsForModel: () => ({ maxOutputTokens: 200 }),
    reconcileObservedContextWindow: () => {}, resolveModelPricing: () => UNKNOWN_MODEL_PRICING,
  } as unknown as ProviderRegistry;
  const configManager = {
    get: (key: string) => key === 'behavior.autoCompactThreshold' ? 0 : false,
    getCategory: () => ({}), getWorkingDirectory: () => '.',
  } as unknown as ConfigManager;
  const orchestrator = new Orchestrator({
    conversation, toolRegistry: new ToolRegistry(), getViewportHeight: () => 10, scrollToEnd: () => {},
    permissionManager: { getMode: () => 'plan' } as unknown as PermissionManager,
    getSystemPrompt: (signal) => { signals.push(signal); return getSystemPrompt(signal); },
    services: {
      agentManager: { list: () => [], spawn: () => { throw new Error('unexpected agent spawn'); } },
      contractRunner: { list: () => [] }, contractIntake: { intake: async () => ({ kind: 'turn' }) },
    },
  });
  orchestrator.setCoreServices({ configManager, providerRegistry });
  orchestrators.push(orchestrator);
  return { orchestrator, conversation, requests, signals };
}

describe('Orchestrator async prompt lifecycle wiring', () => {
  test('preserves plan-mode instructions around an asynchronous prompt', async () => {
    const f = fixture(async () => 'reviewed memory');
    await f.orchestrator.handleUserInput('hello');
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.systemPrompt).toContain('reviewed memory');
    expect(f.requests[0]?.systemPrompt).toContain(PLAN_MODE_INSTRUCTION_MARKER);
    expect(f.signals[0]).toBe(f.requests[0]?.signal);
    expect(f.signals[0]).toBeInstanceOf(AbortSignal);
  });

  test('abort releases an uncooperative prompt and a queued turn gets a fresh signal', async () => {
    const pending = deferred<string>();
    const entered = deferred<void>();
    let reads = 0;
    const f = fixture(() => { reads++; entered.resolve(); return reads === 1 ? pending.promise : 'new turn memory'; });
    const first = f.orchestrator.handleUserInput('first turn');
    await entered.promise;
    await f.orchestrator.handleUserInput('second turn');
    f.orchestrator.abort();
    await first;
    pending.resolve('stale turn memory');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.systemPrompt).toContain('new turn memory');
    expect(f.requests[0]?.systemPrompt).not.toContain('stale turn memory');
    expect(f.signals[0]?.aborted).toBe(true);
    expect(f.signals[1]).not.toBe(f.signals[0]);
  });

  test('dispose cancels pending reads and does not start queued or later user turns', async () => {
    const pending = deferred<string>();
    const entered = deferred<void>();
    let reads = 0;
    const f = fixture(() => { reads++; entered.resolve(); return pending.promise; });
    const first = f.orchestrator.handleUserInput('first turn');
    await entered.promise;
    await f.orchestrator.handleUserInput('queued turn');
    f.orchestrator.dispose();
    await first;
    pending.resolve('stale memory');
    await f.orchestrator.handleUserInput('after disposal');
    expect(reads).toBe(1);
    expect(f.requests).toHaveLength(0);
  });

  test('a user turn interrupts a pending follow-up and its batch resumes with fresh memory', async () => {
    const pending = deferred<string>();
    const entered = deferred<void>();
    let reads = 0;
    const f = fixture(() => { reads++; entered.resolve(); return reads === 1 ? pending.promise : `fresh memory ${reads}`; });
    f.orchestrator.enqueueConversationFollowUp({ key: 'build', summary: 'Build completed' });
    await entered.promise;
    await f.orchestrator.handleUserInput('new user turn');
    await new Promise<void>((resolve) => setImmediate(resolve));
    pending.resolve('stale follow-up memory');
    expect(f.requests).toHaveLength(2);
    expect(f.requests[0]?.systemPrompt).toContain('fresh memory 2');
    expect(f.requests[1]?.systemPrompt).toContain('fresh memory 3');
    expect(JSON.stringify(f.requests[1]?.messages)).toContain('Build completed');
    expect(f.signals[0]?.aborted).toBe(true);
    expect(new Set(f.signals).size).toBe(3);
  });
});
