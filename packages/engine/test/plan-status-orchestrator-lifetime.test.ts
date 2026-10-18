import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { Orchestrator, type OrchestratorOptions } from '../sdk/src/platform/core/orchestrator.js';
import { ConversationManager } from '../sdk/src/platform/core/conversation.js';
import { ExecutionPlanManager } from '../sdk/src/platform/core/execution-plan.js';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.js';
import type { OrchestratorCoreServices } from '../sdk/src/platform/core/orchestrator-runtime.js';
import type { ModelDefinition } from '../sdk/src/platform/providers/registry-types.js';
import { UNKNOWN_MODEL_PRICING } from '../sdk/src/platform/providers/model-pricing.js';
import { coreReadingsPort } from './_helpers/core-readings.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const model: ModelDefinition = { id: 'fixture', provider: 'fixture', registryKey: 'fixture:model', displayName: 'Fixture', description: '',
  capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false }, contextWindow: 0, selectable: true };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'plan-orchestrator-')); roots.push(root);
  const conversation = new ConversationManager(), planManager = new ExecutionPlanManager(root), spawned: string[] = [];
  let enabled = true;
  const configManager = { get: (key: string) => key === 'behavior.notifyOnComplete' ? false
    : key === 'orchestration.recursionEnabled' ? enabled : key === 'fleet.maxSize' ? 10 : undefined,
    getCategory: () => ({}), getWorkingDirectory: () => root } as OrchestratorCoreServices['configManager'];
  const providerRegistry = { getCurrentModel: () => model, getForModel: () => ({ name: 'fixture', models: [model],
    chat: async () => ({ content: 'Plain answer', toolCalls: [], stopReason: 'completed', usage: { inputTokens: 1, outputTokens: 1 } }) }),
    getContextWindowForModel: () => 0, getKnownContextWindowForModel: () => null,
    getTokenLimitsForModel: () => ({ maxOutputTokens: 1024, maxToolResultTokens: 10_000, maxToolCalls: 10, maxReasoningTokens: 0 }),
    recordContextWindowRejection() {}, reconcileObservedContextWindow() {}, resolveModelPricing: () => UNKNOWN_MODEL_PRICING,
  } as unknown as OrchestratorCoreServices['providerRegistry'];
  const instance = new Orchestrator({ conversation, getViewportHeight: () => 0, scrollToEnd() {}, toolRegistry: new ToolRegistry(),
    permissionManager: { getMode: () => 'prompt' } as OrchestratorOptions['permissionManager'],
    sessionId: 'session',
    services: { agentManager: { list: () => [], spawn: (input) => { spawned.push(input.task ?? ''); return { id: 'agent' } as never; } }, contractRunner: { list: () => [] }, contractIntake: { intake: async () => ({ kind: 'turn' }) } } });
  instance.setCoreServices({ configManager, providerRegistry, planManager });
  // Leave the real turn loop and finalization intact. Compaction is unrelated.
  (instance as unknown as { runTurnReconcile: () => Promise<void> }).runTurnReconcile = async () => {};
  planManager.create('Existing plan', [{ description: 'Pending task', phase: 'Phase 1' }], 'session');
  return { instance, planManager, spawned, disable: () => { enabled = false; } };
}

test('a checked final response cannot start unreviewed plan work through a later timer', async () => {
  const previous = installJudgmentPort(coreReadingsPort().port), f = fixture();
  const realSetTimeout = globalThis.setTimeout;
  let autoSpawnTimers = 0;
  const spy = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === 5_000) autoSpawnTimers++;
    return realSetTimeout(fn, delay, ...args);
  }) as typeof setTimeout);
  try {
    await f.instance.handleUserInput('Give a plain answer');
    expect(f.instance.isTurnInFlight).toBe(false);
    expect(autoSpawnTimers).toBe(0);
    expect(f.spawned).toEqual([]);
    await f.instance.handleUserInput('Give another plain answer');
    expect(autoSpawnTimers).toBe(0);
    expect(f.spawned).toEqual([]);
  } finally { spy.mockRestore(); f.instance.dispose(); installJudgmentPort(previous); }
});
