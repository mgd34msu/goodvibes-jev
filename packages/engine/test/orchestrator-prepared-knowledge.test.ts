import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bindJudgmentPortAuthority, failureReading, installJudgmentPort, JudgmentAuthorityRetiredError } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort, Questions } from '@goodvibes-jev/judgment';
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
import { OrchestratorObservationHeldError } from '../sdk/src/platform/agents/orchestrator-observations.js';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.js';
import { AgentMessageBus } from '../sdk/src/platform/agents/message-bus.js';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.js';
import type { LLMProvider } from '../sdk/src/platform/providers/interface.js';
import type { ModelDefinition } from '../sdk/src/platform/providers/registry-types.js';
import { revalidateProviderAttempt } from '../sdk/src/platform/providers/attempt-guard.js';
import { buildContractPlannerRequest } from '../sdk/src/platform/contract/planner.js';
import { shapeOf } from './contract/plan-support.js';
import { knowledgeScopeSelection } from '../sdk/src/platform/knowledge/batteries/scope-selection.js';
import { authoredErrorReadingsPort, errorText } from './_helpers/authored-error-readings.js';
import { fieldKind } from '../sdk/src/platform/utils/batteries/field-kind.js';
import { redactionCredential, residualCredential } from '../sdk/src/platform/utils/batteries/redaction.js';

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
  const staleMessage = new KnowledgeEvidenceRelevanceHeldError('stale').message;
  const diagnostic = authoredErrorReadingsPort({ parts: [[errorText(staleMessage)]], fields: { error: 'content' } },
    [
      { message: staleMessage, errorName: 'KnowledgeEvidenceRelevanceHeldError', reading: { category: 'unknown', connection: 'none' } },
      { message: staleMessage, errorName: 'ProviderAttemptDeniedError', reading: { category: 'unknown', connection: 'none' } },
    ]);
  const feature = fakePort((name, question, state) => {
    if (['false_blocker', 'unfinished', 'unsupported', 'unanswered', 'unnecessary_permission', 'implementation_presented', 'verification_claimed', 'criteria_altered', 'ineffective_fix', 'irrelevant_verification', 'weakened_criteria', 'missing_results', 'unresolved_conflict'].includes(name)) return noulAnswer(.01);
    if (name === 'included' && question.type === 'noul' && question.instructions === knowledgeScopeSelection.items.included.question.instructions) {
      const eligible = [summary, 'The release procedure has changed.'].map(sourceSummary => ({
        view: 'ordinary', candidate: { kind: 'source', content: { title: 'Release instructions', summary: sourceSummary,
          sourceType: 'document', tags: [], canonicalUri: 'manual://release-instructions', meaning: {} } }, related: [], associations: { outsideRequestedScope: false },
      }));
      if (!eligible.some(fixture => JSON.stringify(fixture) === JSON.stringify(state))) throw new Error('Unknown complete prepared-prompt scope fixture');
      return noulAnswer(0.99);
    }
    const candidate = (state as { candidate?: { title?: string; text?: string } }).candidate;
    if (name === 'useful') return noulAnswer(candidate?.title === 'Release instructions' ? probability : 0.01);
    if (name === 'excerptUseful') return noulAnswer(candidate?.text === summary ? 0.99 : 0.01);
    throw new Error(`Unexpected prepared prompt reading: ${name}`);
  });
  const requests: typeof feature.requests = [];
  const diagnosticQuestions = new Map<string, Questions>([
    [failureReading.name, {
      category: failureReading.items.category.question,
      billing: failureReading.items.billing.question,
      rate_limited: failureReading.items.rate_limited.question,
      context_exceeded: failureReading.items.context_exceeded.question,
      transient_network: failureReading.items.transient_network.question,
      provider_unusable: failureReading.items.provider_unusable.question,
      connection_failure: failureReading.items.connection_failure.question,
      before_response: failureReading.items.before_response.question,
    }],
    [fieldKind.name, { kind: fieldKind.items.kind.question }],
    [redactionCredential.name, {
      lineHasCredential: redactionCredential.items.lineHasCredential.question,
      spanIsCredential: redactionCredential.items.spanIsCredential.question,
    }],
    [residualCredential.name, { credentialRemains: residualCredential.items.credentialRemains.question }],
  ]);
  const port: JudgmentPort = { ...feature.port, async ask(request) {
    requests.push(request);
    const contract = diagnosticQuestions.get(request.context?.battery ?? '');
    if (contract) {
      const questions: Questions = request.questions;
      expect(questions).toEqual(contract);
      return diagnostic.port.ask(request);
    }
    return feature.port.ask(request);
  } };
  return { port, requests };
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
  test('a full repository planning request reaches the provider with its complete task', async () => {
    const { deps } = await fixture(), fake = readings();
    const task = nativePlannerTask() + '\n' + 'packages/engine/source.ts exports repositorySymbol\n'.repeat(40_000);
    const agent = { ...record(), template: 'planner', task };
    let received = '';
    const provider: LLMProvider = { name: 'fixture', models: ['fixture-model'], async chat(request) {
      received = String(request.messages.find(message => message.role === 'user')?.content);
      expect(request.systemPrompt).not.toContain(task);
      expect((request.systemPrompt ?? '').length).toBeLessThan(100_000);
      return { content: 'Review plan ready', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
    } };
    const previous = installJudgmentPort(fake.port);
    try {
      expect(task.length).toBeGreaterThan(1_000_000);
      await runAgentTask(runnerContext(deps, provider), agent);
      expect(agent.error).toBeUndefined();
      expect(agent.status).toBe('completed');
      expect(received).toBe(task);
    } finally { installJudgmentPort(previous); }
  });

  test('native planner knowledge reads preserve roots and derived repair context while protocol identity stays local', async () => {
    const { deps } = await fixture(); const agent = { ...record(), task: nativePlannerTask() }; const fake = readings();
    const previous = installJudgmentPort(fake.port);
    try {
      const prepared = await prepareOrchestratorPromptContext(agent, deps);
      const prompt = buildOrchestratorSystemPrompt(agent, undefined, prepared);
      for (const text of ['Deploy the exact release.', 'Preserve the release qualification.',
        'Keep the derived deployment instructions.', 'Restore the missing qualification.',
        'Previous plan retained the staging requirement.', 'Repository context: release package']) {
        expect(agent.task).toContain(text); expect(prompt).not.toContain(text);
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
      expect(buildLayeredOrchestratorSystemPrompt(agent, 0, deps)).not.toContain(agent.task);
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
        || request.context?.site === 'engine.knowledge.answer-excerpt-selection'
        || request.context?.site === knowledgeScopeSelection.name
        || request.context?.site === 'engine.agent.run-failure'
        || [fieldKind.name, redactionCredential.name, residualCredential.name].includes(request.context?.site ?? ''))).toBe(true);
    } finally { installJudgmentPort(previous); }
  });

  test('cancelling a pending failure diagnostic finishes the cancelled run without a failure publication', async () => {
    const { store, source, deps } = await fixture(); const agent = record(); const fake = readings();
    const controller = new AbortController(), entered = Promise.withResolvers<void>();
    let failures = 0, cancellations = 0, transmissions = 0;
    const provider: LLMProvider = { name: 'fixture', models: ['fixture-model'], async chat() {
      transmissions++; throw new Error('A stale preparation must never reach chat');
    } };
    const previous = installJudgmentPort({ ...fake.port, async ask(request) {
      if (request.context?.battery === redactionCredential.name) { entered.resolve(); return new Promise(() => {}); }
      return fake.port.ask(request);
    } });
    try {
      const pending = runAgentTask({ ...runnerContext(deps, provider), getCancellationSignal: () => controller.signal,
        emitAgentFailedEvent: () => { failures++; }, emitAgentCancelledEvent: () => { cancellations++; },
        async beforeProviderRequest() { await store.upsertSource({ ...source, summary: 'Changed before provider admission.' }); },
      }, agent);
      await entered.promise;
      agent.status = 'cancelled'; controller.abort();
      await pending;
      expect(agent.status).toBe('cancelled'); expect(agent.error).toBeUndefined();
      expect(failures).toBe(0); expect(cancellations).toBe(1); expect(transmissions).toBe(0);
    } finally { installJudgmentPort(previous); }
  });

  test('a provider correction during failure redaction cannot publish a diagnostic for the old input', async () => {
    const { store, source, deps } = await fixture(); const agent = record(); const fake = readings();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let failures = 0, transmissions = 0;
    const provider: LLMProvider = { name: 'fixture', models: ['fixture-model'], async chat() {
      transmissions++; throw new Error('A stale preparation must never reach chat');
    } };
    const previous = installJudgmentPort({ ...fake.port, async ask(request) {
      if (request.context?.battery === redactionCredential.name) { entered.resolve(); await release.promise; }
      return fake.port.ask(request);
    } });
    try {
      const pending = runAgentTask({ ...runnerContext(deps, provider), emitAgentFailedEvent: () => { failures++; },
        async beforeProviderRequest() { await store.upsertSource({ ...source, summary: 'Changed before provider admission.' }); },
      }, agent);
      const result = pending.then(() => undefined, (error: unknown) => error);
      await Promise.race([entered.promise, result.then(() => { throw new Error('Failure diagnostic settled before the controlled read'); })]);
      agent.provider = 'corrected-provider'; release.resolve();
      expect(await result).toBeInstanceOf(JudgmentAuthorityRetiredError);
      expect(agent.error).toBeUndefined(); expect(failures).toBe(0); expect(transmissions).toBe(0);
    } finally { release.resolve(); installJudgmentPort(previous); }
  });

  test('a config retirement during settlement drains once and ends as a native held run', async () => {
    const { deps } = await fixture(), agent = record(), fake = readings();
    let drains = 0, failures = 0, completions = 0;
    const provider: LLMProvider = { name: 'fixture', models: ['fixture-model'], async chat() {
      return { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
    } };
    const context = { ...runnerContext(deps, provider), emitAgentFailedEvent: () => { failures++; },
      emitAgentCompletedEvent: () => { completions++; }, async beforeRunSettlement() {
        drains++;
        Object.defineProperty(context, 'configManager', { configurable: true, value: { get: () => 5 } });
      } };
    const previous = installJudgmentPort(fake.port);
    try {
      await runAgentTask(context, agent);
      expect(drains).toBe(1); expect(failures).toBe(1); expect(completions).toBe(0);
      expect(agent.status).toBe('failed'); expect(agent.failureReason).toBe('semantic_observation_held');
      expect(agent.error).toBe(new OrchestratorObservationHeldError().message);
      expect(fake.requests.filter(request => request.context?.site === 'engine.agent.run-failure')).toHaveLength(0);
    } finally { installJudgmentPort(previous); }
  });

  test('an original held error uses fixed native wording after the same port retires', async () => {
    const { deps } = await fixture(), agent = record(), fake = readings();
    let current = true, failures = 0, transmissions = 0;
    bindJudgmentPortAuthority(fake.port, () => ({ identity: deps, assertCurrent() { if (!current) throw new Error('retired'); } }));
    const provider: LLMProvider = { name: 'fixture', models: ['fixture-model'], async chat() {
      transmissions++; throw new Error('A held run must never reach chat');
    } };
    const previous = installJudgmentPort(fake.port);
    try {
      await runAgentTask({ ...runnerContext(deps, provider), emitAgentFailedEvent: () => { failures++; }, async beforeProviderRequest() {
        current = false;
        const held = new OrchestratorObservationHeldError();
        held.message = 'password=UNTRUSTED_HELD_DIAGNOSTIC';
        throw held;
      } }, agent);
      expect(agent.status).toBe('failed'); expect(agent.failureReason).toBe('semantic_observation_held');
      expect(agent.error).toBe(new OrchestratorObservationHeldError().message);
      expect(failures).toBe(1); expect(transmissions).toBe(0);
      expect(fake.requests.filter(request => request.context?.site === 'engine.agent.run-failure')).toHaveLength(0);
      expect(JSON.stringify(fake.requests)).not.toContain('UNTRUSTED_HELD_DIAGNOSTIC');
    } finally { installJudgmentPort(previous); }
  });

  test('late settlement from an older run cannot fail a successor using the same record', async () => {
    const { deps } = await fixture(), agent = record(), fake = readings();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const nextEntered = Promise.withResolvers<void>(), nextRelease = Promise.withResolvers<void>();
    let failures = 0, completions = 0, disposedIndexes = 0, releasedViews = 0;
    let activeSource: Parameters<NonNullable<AgentOrchestratorRunContext['registerConversationSource']>>[1] | undefined;
    const shared: Pick<AgentOrchestratorRunContext, 'registerConversationSource' | 'releaseConversationSource' | 'codeIndex'> = {
      registerConversationSource(_id, source) { activeSource = source; },
      releaseConversationSource() { releasedViews++; activeSource = undefined; },
      codeIndex: { async prepare() {}, async search() { return []; },
        stats() { return { available: false, indexedChunks: 0, semanticRetrievalAvailable: false }; },
        dispose() { disposedIndexes++; } },
    };
    const oldProvider: LLMProvider = { name: 'fixture', models: ['fixture-model'], async chat() {
      entered.resolve(); await release.promise;
      return { content: 'old completion', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
    } };
    const nextProvider: LLMProvider = { name: 'fixture', models: ['fixture-model'], async chat() {
      nextEntered.resolve(); await nextRelease.promise;
      return { content: 'successor completion', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
    } };
    const previous = installJudgmentPort(fake.port);
    try {
      const pending = runAgentTask({ ...runnerContext(deps, oldProvider), ...shared, emitAgentFailedEvent: () => { failures++; } }, agent);
      const result = pending.then(() => undefined, (error: unknown) => error);
      await entered.promise;
      const successor = runAgentTask({ ...runnerContext(deps, nextProvider), ...shared, emitAgentCompletedEvent: () => { completions++; } }, agent);
      await nextEntered.promise;
      const successorSource = activeSource;
      const usage = agent.usage;
      if (usage === undefined) throw new Error('The active successor has not initialized its usage.');
      const successorUsage = { ...usage };
      release.resolve();
      expect(await result).toBeInstanceOf(OrchestratorObservationHeldError);
      expect(agent.status).toBe('running'); expect(activeSource).toBe(successorSource); expect(activeSource).toBeDefined();
      expect(agent.fullOutput).not.toBe('old completion'); expect(agent.usage).toEqual(successorUsage);
      expect(disposedIndexes).toBe(0); expect(releasedViews).toBe(0);
      nextRelease.resolve(); await successor;
      expect(agent.status).toBe('completed'); expect(agent.error).toBeUndefined();
      expect(agent.fullOutput).toBe('successor completion'); expect(failures).toBe(0); expect(completions).toBe(1);
      expect(disposedIndexes).toBe(1); expect(releasedViews).toBe(1); expect(activeSource).toBeUndefined();
    } finally { release.resolve(); nextRelease.resolve(); installJudgmentPort(previous); }
  });

  test('cancellation wins while a native held run awaits its single settlement', async () => {
    const { deps } = await fixture(), agent = record(), fake = readings();
    const controller = new AbortController(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let drains = 0, cancellations = 0, failures = 0;
    const provider: LLMProvider = { name: 'fixture', models: ['fixture-model'], async chat() { throw new Error('A held run must never reach chat'); } };
    const previous = installJudgmentPort(fake.port);
    try {
      const pending = runAgentTask({ ...runnerContext(deps, provider), getCancellationSignal: () => controller.signal,
        emitAgentCancelledEvent: () => { cancellations++; }, emitAgentFailedEvent: () => { failures++; },
        async beforeProviderRequest() { throw new OrchestratorObservationHeldError(); },
        async beforeRunSettlement() { drains++; entered.resolve(); await release.promise; },
      }, agent);
      await entered.promise;
      agent.status = 'cancelled'; controller.abort(); release.resolve(); await pending;
      expect(drains).toBe(1); expect(cancellations).toBe(1); expect(failures).toBe(0);
      expect(agent.status).toBe('cancelled'); expect(agent.error).toBeUndefined();
    } finally { release.resolve(); installJudgmentPort(previous); }
  });

  test('the original generation releases its shared sources after normal, failed and cancelled runs', async () => {
    const outcomes: readonly AgentRecord['status'][] = ['completed', 'failed', 'cancelled'];
    for (const outcome of outcomes) {
      const { deps } = await fixture(), agent = record(), fake = readings(), controller = new AbortController();
      let disposedIndexes = 0, releasedViews = 0;
      const provider: LLMProvider = { name: 'fixture', models: ['fixture-model'], async chat() {
        return { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
      } };
      const previous = installJudgmentPort(fake.port);
      try {
        await runAgentTask({ ...runnerContext(deps, provider), getCancellationSignal: () => controller.signal,
          releaseConversationSource() { releasedViews++; },
          codeIndex: { async prepare() {}, async search() { return []; },
            stats() { return { available: false, indexedChunks: 0, semanticRetrievalAvailable: false }; },
            dispose() { disposedIndexes++; } },
          async beforeProviderRequest() {
            if (outcome === 'completed') return;
            if (outcome === 'cancelled') { agent.status = 'cancelled'; controller.abort(); }
            throw new OrchestratorObservationHeldError();
          },
        }, agent);
        expect(agent.status).toBe(outcome); expect(disposedIndexes).toBe(1); expect(releasedViews).toBe(1);
      } finally { installJudgmentPort(previous); }
    }
  });
});
