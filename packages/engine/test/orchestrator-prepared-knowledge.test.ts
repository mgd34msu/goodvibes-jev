import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import type { KnowledgeService } from '../sdk/src/platform/knowledge/service.js';
import { prepareKnowledgePromptPacket } from '../sdk/src/platform/knowledge/packet.js';
import { KnowledgeEvidenceRelevanceHeldError } from '../sdk/src/platform/knowledge/semantic/evidence-ranking/reader.js';
import type { AgentRecord } from '../sdk/src/platform/tools/agent/index.js';
import {
  assertOrchestratorKnowledgeCurrent, buildLayeredOrchestratorSystemPrompt,
  buildOrchestratorSystemPrompt, prepareOrchestratorPromptContext,
} from '../sdk/src/platform/agents/orchestrator-prompts.js';
import { runAgentTask, type AgentOrchestratorRunContext } from '../sdk/src/platform/agents/orchestrator-runner.js';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.js';
import { AgentMessageBus } from '../sdk/src/platform/agents/message-bus.js';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.js';
import type { LLMProvider } from '../sdk/src/platform/providers/interface.js';
import type { ModelDefinition } from '../sdk/src/platform/providers/registry-types.js';
import { revalidateProviderAttempt } from '../sdk/src/platform/providers/attempt-guard.js';
import { buildContractPlannerRequest } from '../sdk/src/platform/contract/planner.js';
import { shapeOf } from './contract/plan-support.js';

const roots: string[] = [];
const stores: KnowledgeStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const summary = 'Deploy the release through the staging environment first.';
function record(): AgentRecord {
  return { id: 'prepared-knowledge-agent', task: 'release the project', writeScope: ['src'],
    template: 'engineer', tools: [], status: 'pending', startedAt: 1, toolCallCount: 0,
    orchestrationDepth: 0, executionProtocol: 'direct', reviewMode: 'none', communicationLane: 'parent-only' };
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orchestrator-prepared-knowledge-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  stores.push(store);
  await store.init();
  const source = await store.upsertSource({ connectorId: 'manual', sourceType: 'document', status: 'indexed',
    title: 'Release instructions', summary, canonicalUri: 'manual://release-instructions', tags: [] });
  let preparations = 0;
  const context = { store, deferUsage: () => {}, emitIfReady: () => {} };
  const deps = { workingDirectory: root, knowledgeService: {
    async preparePromptPacket(...args: Parameters<KnowledgeService['preparePromptPacket']>) {
      preparations += 1;
      return prepareKnowledgePromptPacket(context, ...args);
    },
  } };
  return { store, source, deps, preparations: () => preparations };
}

function runnerContext(deps: Awaited<ReturnType<typeof fixture>>['deps'], provider: LLMProvider): AgentOrchestratorRunContext {
  const model: ModelDefinition = { id: 'fixture-model', provider: 'fixture', registryKey: 'fixture:fixture-model',
    displayName: 'Fixture', description: 'Authored test model', selectable: true, contextWindow: 0,
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false } };
  return { ...deps, runtimeBus: new RuntimeEventBus(), featureFlagManager: null,
    emitterContext: () => ({ sessionId: 'fixture-session', traceId: 'fixture-trace', source: 'fixture' }),
    emitAgentProgress: () => {}, emitAgentStarted: () => {}, emitAgentCancelledEvent: () => {},
    emitAgentFailedEvent: () => {}, emitAgentCompletedEvent: () => {}, emitStreamDelta: () => {},
    messageBus: new AgentMessageBus(),
    providerRegistry: { getCurrentModel: () => model, getForModel: () => provider, listModels: () => [model],
      getContextWindowForModel: () => 0, getKnownContextWindowForModel: () => 0, recordContextWindowRejection: () => {} },
    getFullRegistry: () => new ToolRegistry(), buildScopedRegistry: (_names, registry) => registry,
    resolveProviderForRecord: () => ({ provider, modelId: model.id, requestedModelId: model.registryKey }),
    resolveFallbackModelRoutes: () => [] };
}
function readings(probability = 0.99) {
  return fakePort((name, _question, state) => {
    const candidate = (state as { candidate?: { title?: string; text?: string } }).candidate;
    if (name === 'useful') return noulAnswer(candidate?.title === 'Release instructions' ? probability : 0.01);
    if (name === 'excerptUseful') return noulAnswer(candidate?.text === summary ? 0.99 : 0.01);
    throw new Error(`Unexpected prepared prompt reading: ${name}`);
  });
}

const nativeCriteriaId = 'criteria:d6b72d9f28026994604091a0bbac8dfa87467c68300f6960922429de420bbdfb';
function nativePlannerTask(field?: 'goal' | 'criterion' | 'unit' | 'repair', value = '') {
  const nativeSource = { sourceId: 'owned-native-source', sourceRevision: '1', inputRevision: 'owned-input',
    criteriaId: nativeCriteriaId, criteriaRevision: '1', goal: field === 'goal' ? value : 'Deploy the exact release.',
    criteria: [field === 'criterion' ? value : 'Preserve the release qualification.', 'Preserve the release qualification.'] };
  return buildContractPlannerRequest({ ask: 'Displayed request', nativeSource, shape: shapeOf(),
    config: { defaultAttempts: 1, maxUnits: 3 }, repositoryMap: 'Repository context: release package',
    proposedUnits: [{ task: field === 'unit' ? value : 'Keep the derived deployment instructions.', template: 'engineer' }],
    repair: { problems: [{ code: 'native-source-changed', message: field === 'repair' ? value : 'Restore the missing qualification.' }],
      previousPlan: 'Previous plan retained the staging requirement.' } });
}

describe('orchestrator prepared curated knowledge', () => {
  test('native planner knowledge reads preserve roots and derived repair context while protocol identity stays local', async () => {
    const { deps } = await fixture(); const agent = { ...record(), task: nativePlannerTask() }; const fake = readings();
    const previous = installJudgmentPort(fake.port);
    try {
      const prepared = await prepareOrchestratorPromptContext(agent, deps);
      const prompt = buildOrchestratorSystemPrompt(agent, undefined, prepared);
      for (const text of ['Deploy the exact release.', 'Preserve the release qualification.',
        'Keep the derived deployment instructions.', 'Restore the missing qualification.',
        'Previous plan retained the staging requirement.', 'Repository context: release package']) {
        expect(agent.task).toContain(text); expect(prompt).toContain(text);
        expect(JSON.stringify(fake.requests)).toContain(text);
      }
      expect(agent.task).toContain(JSON.stringify(['Preserve the release qualification.', 'Preserve the release qualification.']));
      expect(agent.task).not.toContain(nativeCriteriaId);
      for (const key of ['sourceId', 'sourceRevision', 'inputRevision', 'criteriaId', 'criteriaRevision']) {
        expect(agent.task).not.toContain(`"${key}"`);
      }
    } finally { installJudgmentPort(previous); }
  });

  for (const field of ['goal', 'criterion', 'unit', 'repair'] as const) {
    test(`native ${field} text remains protected before any knowledge reading`, async () => {
      const { deps } = await fixture(); const fake = readings(); const previous = installJudgmentPort(fake.port);
      try {
        for (const value of ['4111111111111111', nativeCriteriaId, 'password=owned-synthetic-secret']) {
          await expect(prepareOrchestratorPromptContext({ ...record(), task: nativePlannerTask(field, value) }, deps))
            .rejects.toMatchObject({ problem: value.startsWith('password=') ? 'credential-material' : 'card-material' });
          expect(fake.requests).toHaveLength(0);
        }
      } finally { installJudgmentPort(previous); }
    });
  }

  test('awaits one real preparation, then shares its handle across synchronous layout alternatives', async () => {
    const { deps, preparations } = await fixture(); const agent = record(); const fake = readings();
    const previous = installJudgmentPort(fake.port);
    try {
      expect(() => buildOrchestratorSystemPrompt(agent, undefined, deps)).toThrow(KnowledgeEvidenceRelevanceHeldError);
      const prepared = await prepareOrchestratorPromptContext(agent, deps);
      const requestCount = fake.requests.length;
      expect(requestCount).toBeGreaterThan(0);
      expect(buildOrchestratorSystemPrompt(agent, undefined, prepared)).toContain('Release instructions');
      expect(buildLayeredOrchestratorSystemPrompt(agent, 100_000, prepared)).toContain('Release instructions');
      expect(buildLayeredOrchestratorSystemPrompt(agent, 100, prepared)).toBeTruthy();
      assertOrchestratorKnowledgeCurrent(agent, prepared);
      expect(preparations()).toBe(1);
      expect(fake.requests).toHaveLength(requestCount);
    } finally { installJudgmentPort(previous); }
  });

  test('a later rebuild prepares changed evidence instead of reusing a stale prompt handle', async () => {
    const { store, source, deps, preparations } = await fixture(); const agent = record(); const fake = readings();
    const previous = installJudgmentPort(fake.port);
    try {
      const first = await prepareOrchestratorPromptContext(agent, deps);
      expect(buildOrchestratorSystemPrompt(agent, undefined, first)).toContain('Release instructions');
      await store.upsertSource({ ...source, summary: 'The release procedure has changed.' });
      expect(() => assertOrchestratorKnowledgeCurrent(agent, first)).toThrow(KnowledgeEvidenceRelevanceHeldError);
      expect(() => buildLayeredOrchestratorSystemPrompt(agent, 100_000, first)).toThrow(KnowledgeEvidenceRelevanceHeldError);
      const second = await prepareOrchestratorPromptContext(agent, deps);
      expect(buildOrchestratorSystemPrompt(agent, undefined, second)).toContain('Release instructions');
      expect(preparations()).toBe(2);
    } finally { installJudgmentPort(previous); }
  });

  test('task and write scope changes invalidate a prepared prompt at the transmission boundary', async () => {
    const { deps } = await fixture(); const agent = record(); const fake = readings();
    const previous = installJudgmentPort(fake.port);
    try {
      const prepared = await prepareOrchestratorPromptContext(agent, deps);
      agent.task = 'a different task';
      expect(() => assertOrchestratorKnowledgeCurrent(agent, prepared)).toThrow(KnowledgeEvidenceRelevanceHeldError);
      agent.task = 'release the project'; agent.writeScope = ['other'];
      expect(() => assertOrchestratorKnowledgeCurrent(agent, prepared)).toThrow(KnowledgeEvidenceRelevanceHeldError);
    } finally { installJudgmentPort(previous); }
  });

  test('a settled rejection renders without curated knowledge and emergency output needs no preparation', async () => {
    const { deps, preparations } = await fixture(); const agent = record(); const fake = readings(0.01);
    const previous = installJudgmentPort(fake.port);
    try {
      expect(buildLayeredOrchestratorSystemPrompt(agent, 0, deps)).toContain(agent.task);
      expect(preparations()).toBe(0); expect(fake.requests).toHaveLength(0);
      const prepared = await prepareOrchestratorPromptContext(agent, deps);
      const prompt = buildOrchestratorSystemPrompt(agent, undefined, prepared);
      expect(prompt).not.toContain('Release instructions');
      expect(prompt).not.toContain('Curated Project Knowledge');
      expect(preparations()).toBe(1); expect(fake.requests.length).toBeGreaterThan(0);
    } finally { installJudgmentPort(previous); }
  });

  test('owned cancellation reaches pending preparation even when a reader ignores its signal', async () => {
    const { deps } = await fixture(); const fake = readings(); const controller = new AbortController();
    let started!: () => void; const entered = new Promise<void>((resolve) => { started = resolve; });
    let readingSignal: AbortSignal | undefined;
    const previous = installJudgmentPort({ ...fake.port, async ask(request) {
      readingSignal = request.signal; started(); return new Promise(() => {});
    } });
    try {
      const pending = prepareOrchestratorPromptContext(record(), deps, controller.signal);
      await entered; controller.abort();
      await expect(pending).rejects.toMatchObject({ reason: 'aborted' });
      expect(readingSignal?.aborted).toBe(true);
    } finally { installJudgmentPort(previous); }
  });

  test('the real runner rejects stale knowledge after awaited provider admission before calling chat', async () => {
    const { store, source, deps, preparations } = await fixture(); const agent = record(); const fake = readings();
    let transmissions = 0;
    const provider: LLMProvider = { name: 'fixture', models: ['fixture-model'], async chat() {
      transmissions += 1; return { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
    } };
    const previous = installJudgmentPort(fake.port);
    try {
      const context = { ...runnerContext(deps, provider), async beforeProviderRequest() {
        await store.upsertSource({ ...source, summary: 'Changed during awaited provider admission.' });
      } };
      await runAgentTask(context, agent);
      expect(agent.status).toBe('failed'); expect(agent.error).toContain('stale');
      expect(transmissions).toBe(0); expect(preparations()).toBe(1);
    } finally { installJudgmentPort(previous); }
  });

  test('provider-internal retry checks reject stale knowledge without judging the hold or selecting a fallback', async () => {
    const { store, source, deps, preparations } = await fixture(); const agent = record(); const fake = readings();
    let transmissions = 0, enteredChat = 0;
    const provider: LLMProvider = { name: 'fixture', models: ['fixture-model'], async chat(request) {
      enteredChat += 1;
      expect(request.beforeAttempt).toBeDefined();
      await store.upsertSource({ ...source, summary: 'Changed before an internal provider attempt.' });
      await revalidateProviderAttempt(request.beforeAttempt!);
      transmissions += 1; return { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
    } };
    const previous = installJudgmentPort(fake.port);
    try {
      await runAgentTask(runnerContext(deps, provider), agent);
      expect(agent.status).toBe('failed'); expect(agent.error).toContain('stale');
      expect(enteredChat).toBe(1); expect(transmissions).toBe(0); expect(preparations()).toBe(1);
      expect(fake.requests.every((request) => request.context?.site === 'engine.knowledge.answer-evidence-relevance'
        || request.context?.site === 'engine.knowledge.answer-excerpt-selection')).toBe(true);
    } finally { installJudgmentPort(previous); }
  });
});
