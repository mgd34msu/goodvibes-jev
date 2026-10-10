import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { OpenAICompatProvider, OllamaProvider } from '@goodvibes-jev/engine/sdk/platform/providers';
import { routingRegistry, routeReadiness } from '@goodvibes-jev/engine/sdk/platform/routing';
import { SOURCE_SCREENING_LIMITS, type ProtectedSourceOwner } from '@goodvibes-jev/engine/sdk/platform/security';
import { ToolRegistry, assertCurrentToolExecution } from '@goodvibes-jev/engine/sdk/platform/tools';
import { PermissionManager, type PermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { JudgmentError, SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { PolicyRuntimeState } from '@/runtime/index.ts';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { createAgentModelsTool, registerAgentModelsTool, isModelsReadinessCall } from '../../tools/agent-models-tool.ts';
import { createHarnessCatalogInputProjector } from '../../tools/agent-harness-catalog-ingress.ts';
import { localModelCookbook, localModelRecipes } from '../../tools/agent-harness-local-model-cookbook.ts';
import { localRecipeReadinessScore } from '../../tools/agent-harness-model-readiness.ts';
import { modelReadingOptions, withModelReadingContext, withModelReadingSource } from '../../tools/agent-harness-model-reading-source.ts';
import type { LocalModelBenchmarkEvidence } from '../../tools/agent-harness-model-routing-types.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner, researchScreeningFixture, exactSensitiveSpans } from '../helpers/research-screening.ts';

type ToolExecuteOptions = NonNullable<Parameters<Tool['execute']>[1]>;
type Json = Record<string, unknown>;
const record = (value: unknown): Json => value !== null && typeof value === 'object' ? value as Json : {};
const rows = (value: unknown): Json[] => Array.isArray(value) ? value.map(record) : [];
const body = (result: { output?: unknown }): Json => record(JSON.parse(String(result.output)));
const routeId = 'ollama-local:opaque-model';
const recordedAt = '2026-10-09T12:00:00.000Z';
let previous: ReturnType<typeof installJudgmentPort>;
const restores: Array<() => void> = [];
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { for (const restore of restores.splice(0).reverse()) restore(); installJudgmentPort(previous); });
afterAll(cleanupResearchScreeningFixtures);

function fixture(owner: ProtectedSourceOwner = ordinaryResearchOwner(), registry = new ToolRegistry()) {
  const effects: string[] = [];
  const models: Json[] = [{ registryKey: routeId, modelId: 'opaque-model', providerId: 'ollama-local', displayName: 'Opaque fixture',
    contextWindow: 4096, capabilities: { toolCalling: true, multimodal: true }, tier: 'premium', benchmark: { compositeScore: 0.99 },
    available: true, isConfigured: true }];
  const providers: Json[] = [{ id: 'ollama-local', baseUrl: 'https://inference.example.invalid/v1',
    hosting: 'Third-party cloud receives every prompt.', isConfigured: true, isAvailable: true }];
  const health: { routes: Json[] } = { routes: [{ providerId: 'ollama-local', modelRouteId: routeId, status: 'healthy', avgLatencyMs: 18_000,
    lastCheckedAt: recordedAt, lastSuccessAt: recordedAt, isConfigured: true, isActive: true, recordId: 'synthetic-health' }] };
  const config: Json = {};
  const artifacts: Json[] = [];
  const providerApi = { listModels: async () => models, getFavorites: async () => ({ pinned: [] }),
    getCurrentModel: async () => models[0]!, listProviderIds: () => ['ollama-local'],
    setModel: async () => { effects.push('setModel'); }, refreshModels: async () => { effects.push('refreshModels'); } };
  const providerRegistry = { listModels: () => models, listProviders: () => providers,
    getKnownContextWindowForModel: (model: Json): number | null => typeof model.contextWindow === 'number' ? model.contextWindow : null,
    getContextWindowForModel: (model: Json): number | null => typeof model.contextWindow === 'number' ? model.contextWindow : null };
  const context = { extensions: {}, workspace: {}, ops: {}, clients: { providerApi }, provider: { providerRegistry },
    platform: { config: {}, configManager: { get: (key: string) => config[key], set: () => { effects.push('setConfig'); } },
      artifactStore: { list: () => artifacts }, readModels: { providerHealth: health } },
    session: { runtime: { sessionId: 'readiness-session', model: routeId, provider: 'ollama-local' } },
  } as unknown as CommandContext;
  const commands = new CommandRegistry();
  commands.register({ name: 'model', description: 'Change the selected model', handler: () => { effects.push('model'); } });
  bindAgentResearchSourceOwner(registry, owner);
  const deps = { commandRegistry: commands, commandContext: context, toolRegistry: registry };
  return { registry, commands, context, models, providers, health, artifacts, config, providerApi, providerRegistry, effects,
    tool: createAgentModelsTool(deps), deps };
}

function readings(options: { route?: number; confidence?: number; transfer?: number; fits?: Record<string, number>; memory?: number } = {}) {
  return fakePort((name, question, state) => {
    // Explicit catalog result keeps this readiness control independent of search semantics.
    if (name === 'match') return noulAnswer(record(record(state).candidate).name === `model:${routeId}` ? 0.99 : 0.01);
    if (question.type === 'score') {
      const recipe = record(record(state).recipe).id;
      const level = name === 'memoryAdequacy' ? options.memory ?? 2 : name === 'fit' ? (typeof recipe === 'string' ? options.fits?.[recipe] : undefined) ?? 4 : options.route ?? 4;
      return scoreAnswer(question, level, options.confidence ?? 0.99);
    }
    if (question.type === 'choice') return choiceAnswer(question, name === 'disposition' ? 'act' : name === 'kind' ? 'read' : name === 'hazard' ? 'none' : 'generic', 0.999);
    return noulAnswer(name === 'cloudTransfer' ? options.transfer ?? 0.99 : name === 'exampleVision' ? 0.99 : 0.001);
  });
}

function suspended() {
  let start!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  return { start, release, started, gate };
}
const routeArgs = { action: 'route', modelRouteId: routeId, includeParameters: true };
const dimension = (readiness: unknown, id: string): Json => rows(record(readiness).dimensions).find(value => value.id === id)!;
const proposals = (calls: readonly { path: string; body: Record<string, unknown> }[]) => calls.filter(call => call.path === '/v1/chat/completions');

// All local HTTP calls in this file are scripted source-screening fixtures. No
// provider inference, downloads, installations, model-server launches or live probes.
describe('real models readiness consumers', () => {
  test('route and status use canonical counter-table scores and expose exact hosted provenance', async () => {
    const f = fixture();
    const fake = readings({ route: 0 });
    using log = new SqliteDecisionLog(':memory:');
    installJudgmentPort(withDecisionLog(fake.port, log));
    const direct = body(await f.tool.execute(routeArgs));
    expect(direct.readiness).toMatchObject({ score: 0, level: 'risky', outcome: 'ready', cloudTransfer: { value: true } });
    expect(record(direct.readiness).provenance).toMatchObject({ battery: routeReadiness.name, version: routeReadiness.version, model: 'jev-1.13.0' });
    expect(typeof record(direct.readiness).decisionId).toBe('string');
    expect(rows(record(direct.readiness).dimensions)).toHaveLength(6);
    expect(rows(record(direct.readiness).dimensions).every((value: Json) => value.score === 0 && value.outcome === 'ready')).toBe(true);
    installJudgmentPort(fake.port);
    const status = body(await f.tool.execute({ action: 'status', query: 'opaque-model', includeParameters: true }));
    expect(rows(status.models)[0]!.readinessScore).toBe(0);
    expect(record(record(status.current).currentModel).readinessScore).toBe(0);
    expect(rows(status.models)[0]!.contextWindow).toBe(4096);
    expect(f.effects).toEqual([]);
    const requests = fake.requests.filter(request => request.context?.site === 'agent.models.route-readiness');
    expect(requests.length).toBeGreaterThan(0);
    expect(Object.keys(requests[0]!.questions)).toEqual(['latency', 'contextWindow', 'toolSupport', 'vision', 'cost', 'privacy', 'cloudTransfer']);
    expect(requests.every(request => request.context?.battery === routeReadiness.name)).toBe(true);
  });

  test('counter-table local fit and memory readings drive the real local view without fabricating recipe readiness', async () => {
    const f = fixture();
    const fake = readings({ fits: { ollama: 0, 'llama-cpp': 1, vllm: 4, 'openai-compatible-local': 2 }, memory: 0 });
    installJudgmentPort(fake.port);
    const output = body(await f.tool.execute({ action: 'local', includeParameters: true }));
    const cookbook = record(output.localCookbook);
    expect(rows(cookbook.recipes).map((recipe: Json) => recipe.id)).toEqual(['vllm', 'openai-compatible-local', 'llama-cpp', 'ollama']);
    expect(rows(cookbook.recipes).map((recipe: Json) => recipe.fitScore)).toEqual([100, 50, 25, 0]);
    expect(rows(cookbook.recipes).every((recipe: Json) => record(recipe.fitReading).memoryTier === 'constrained')).toBe(true);
    expect(rows(cookbook.recipes).every((recipe: Json) => recipe.readinessScore === null && record(recipe.readiness).outcome === 'deferred')).toBe(true);
    expect(cookbook.recommendation).toBeNull();
    expect(f.effects).toEqual([]);
    expect(fake.requests.filter(request => request.context?.battery === 'agent.models.local-recipe-fit')).toHaveLength(4);
  });

  test('local-looking hosted provider names never substitute for transfer evidence or private URL validation', async () => {
    const f = fixture(); const fake = readings({ route: 4, transfer: 0.99 }); installJudgmentPort(fake.port);
    const route = body(await f.tool.execute(routeArgs));
    expect(route.readiness).toMatchObject({ score: 100, cloudTransfer: { value: true, outcome: 'ready' } });
    expect(route.available).toBe(true); expect(route.configured).toBe(true);
    expect(record(route.readiness).providerHealth).toMatchObject({ isConfigured: true, isActive: true });
    expect(f.providers[0]!.baseUrl).toBe('https://inference.example.invalid/v1');
    const local = body(await f.tool.execute({ action: 'local', includeParameters: true }));
    expect(rows(record(record(local.localCookbook).localServerHealth).endpoints).every(endpoint => !String(endpoint.baseUrl).includes('inference.example.invalid'))).toBe(true);
    const state = record(fake.requests.find(request => record(request.state).measuredLatency)!.state);
    expect(record(state.provider).hosting).toContain('Third-party cloud');
    expect(f.context.session.runtime.model).toBe(routeId); expect(f.effects).toEqual([]);
  });

  test.each(['missing', 'failed', 'unrelated-route', 'unrelated-provider', 'provider-only', 'no-timestamp'] as const)('%s latency stays unknown despite perfect quality and rubric scores', async kind => {
    const f = fixture();
    if (kind === 'missing') f.health.routes = [];
    if (kind === 'failed') { f.health.routes[0]!.status = 'failed'; delete f.health.routes[0]!.lastSuccessAt; }
    if (kind === 'unrelated-route') f.health.routes[0]!.modelRouteId = 'ollama-local:different-model';
    if (kind === 'unrelated-provider') f.health.routes[0]!.providerId = 'unrelated-provider';
    if (kind === 'provider-only') delete f.health.routes[0]!.modelRouteId;
    if (kind === 'no-timestamp') { delete f.health.routes[0]!.lastCheckedAt; delete f.health.routes[0]!.lastSuccessAt; }
    const fake = readings({ route: 4 }); installJudgmentPort(fake.port);
    const route = body(await f.tool.execute(routeArgs));
    expect(route.readinessScore).toBeNull();
    expect(dimension(route.readiness, 'latency')).toMatchObject({ score: null, outcome: 'deferred' });
    expect(record(fake.requests[0]!.state).measuredLatency).toBeNull();
    expect(f.effects).toEqual([]);
  });

  test('missing context and capability evidence stays unknown without invented numeric fallbacks', async () => {
    const f = fixture(); f.models[0]!.contextWindow = null; f.models[0]!.capabilities = {}; delete f.models[0]!.tier;
    installJudgmentPort(readings().port);
    const route = body(await f.tool.execute(routeArgs));
    for (const id of ['context-window', 'tool-support', 'vision', 'cost']) expect(dimension(route.readiness, id)).toMatchObject({ score: null, outcome: 'deferred' });
    expect(route.readinessScore).toBeNull();
  });

  test('a registry-disproved context window remains unknown after protected source projection', async () => {
    const f = fixture(); f.providerRegistry.getKnownContextWindowForModel = () => null; installJudgmentPort(readings().port);
    const route = body(await f.tool.execute(routeArgs));
    expect(route.contextWindow).toBeNull(); expect(dimension(route.readiness, 'context-window').score).toBeNull();
  });

  test('unknown and misleading vision example names each remain unknown even when a reader guesses yes', async () => {
    const recipe = { ...localModelRecipes()[0]!, modelExamples: ['opaque-family', 'vision-vl-multimodal-text-only'] };
    const fake = readings(); installJudgmentPort(fake.port);
    const fit = { score: 100, level: 'strong', outcome: 'ready', confidence: 0.99, decisionId: null, provenance: null, memoryTier: 'large', reasons: [] } as const;
    const result = await localRecipeReadinessScore(recipe, fit, false, {} as LocalModelBenchmarkEvidence, { sourceOwner: ordinaryResearchOwner() });
    expect(result.exampleVision).toHaveLength(2);
    expect(result.exampleVision?.every(example => record(example).value === null && record(example).outcome === 'deferred')).toBe(true);
    expect(result.score).toBeNull();
    const examples = fake.requests.filter(request => request.context?.site === 'agent.models.example-vision');
    expect(examples.map(request => record(record(request.state).exampleModel).id)).toEqual(recipe.modelExamples);
    expect(examples.every(request => Object.keys(request.questions).join(',') === 'exampleVision')).toBe(true);
  });

  test('synchronous startup cookbook acquires no judgment port and publishes no settled winner or invented fit', () => {
    const f = fixture();
    const before = localModelCookbook(f.context, true);
    expect(before).not.toBeInstanceOf(Promise);
    expect(before).toMatchObject({ enrichment: 'deferred', recommendation: null });
    expect(rows(record(before).recipes)).toHaveLength(4);
    expect(rows(record(before).recipes).every((recipe: Json) => recipe.fitScore === null && recipe.readinessScore === null)).toBe(true);
    const fake = readings(); installJudgmentPort(fake.port);
    const after = localModelCookbook(f.context, true);
    expect(record(record(after).hardwareProfile).memoryTier).toBeUndefined();
    expect(fake.requests).toHaveLength(0); expect(f.effects).toEqual([]);
  });

  test('high fit readings do not rewrite independent hardwareFit annotations', async () => {
    const f = fixture(); const before = rows(record(localModelCookbook(f.context, true)).recipes);
    installJudgmentPort(readings({ fits: { ollama: 4, 'llama-cpp': 4, vllm: 4, 'openai-compatible-local': 4 } }).port);
    const output = body(await f.tool.execute({ action: 'local', includeParameters: true }));
    for (const recipe of rows(record(output.localCookbook).recipes)) expect(recipe.hardwareFit).toBe(before.find((value: Json) => value.id === recipe.id)!.hardwareFit);
    expect(f.effects).toEqual([]);
  });

  test.each([0.5, 0.7])('low-confidence %s readings yield no score, tier, or recommended winner', async confidence => {
    const f = fixture(); installJudgmentPort(readings({ confidence }).port);
    const route = body(await f.tool.execute(routeArgs));
    expect(route.readiness).toMatchObject({ score: null, level: null, outcome: 'held' });
    const local = body(await f.tool.execute({ action: 'local', includeParameters: true }));
    expect(record(local.localCookbook).recommendation).toBeNull();
    expect(rows(record(local.localCookbook).recipes).every((recipe: Json) => recipe.fitScore === null && record(recipe.fitReading).memoryTier === null)).toBe(true);
    expect(f.effects).toEqual([]);
  });

  test('missing and rejected judgment remain failures instead of falling back to old scores', async () => {
    const f = fixture();
    await expect(f.tool.execute(routeArgs)).rejects.toBeInstanceOf(JudgmentPortMissingError);
    installJudgmentPort({ model: 'synthetic', ask: async () => { throw new JudgmentError('rejected', 'synthetic rejection'); } });
    await expect(f.tool.execute(routeArgs)).rejects.toThrow('synthetic rejection');
    expect(f.effects).toEqual([]);
  });

  test.each(['held', 'reject', 'revise'] as const)('a %s non-answer cannot become a readiness result or cookbook winner', async outcome => {
    const f = fixture(); installJudgmentPort({ model: 'synthetic', ask: async () => ({ outcome }) as never });
    await expect(f.tool.execute({ action: 'local', includeParameters: true })).rejects.toThrow();
    expect(f.effects).toEqual([]);
  });
});


describe('advisory readiness preserves independent facts and lifetimes', () => {
  test.each(['model-available', 'model-configured', 'provider-available', 'provider-configured', 'health-configured'] as const)('perfect scores cannot override %s false', async field => {
    const f = fixture();
    if (field === 'model-available') f.models[0]!.available = false;
    if (field === 'model-configured') f.models[0]!.isConfigured = false;
    if (field === 'provider-available') f.providers[0]!.isAvailable = false;
    if (field === 'provider-configured') f.providers[0]!.isConfigured = false;
    if (field === 'health-configured') f.health.routes[0]!.isConfigured = false;
    installJudgmentPort(readings().port);
    const result = body(await f.tool.execute(routeArgs));
    expect(result.readiness).toMatchObject({ score: null, level: null, outcome: 'unavailable' });
    expect(f.effects).toEqual([]); expect(f.context.session.runtime.model).toBe(routeId);
  });

  test('provider identity without endpoint or documentation does not establish privacy', async () => {
    const f = fixture(); delete f.providers[0]!.baseUrl; delete f.providers[0]!.hosting;
    installJudgmentPort(readings({ transfer: 0.01 }).port);
    const result = body(await f.tool.execute(routeArgs));
    expect(dimension(result.readiness, 'privacy')).toMatchObject({ score: null, normalized: null, outcome: 'deferred' });
    expect(record(result.readiness).cloudTransfer).toMatchObject({ value: null, probability: null, outcome: 'deferred' });
    expect(result.readinessScore).toBeNull();
  });

  test.each(['cancel', 'session', 'owner', 'provider-api', 'provider-api-method', 'provider-registry', 'provider-registry-method', 'provider-adapter', 'config', 'config-manager', 'config-value', 'artifact-store', 'artifact-content', 'read-model', 'read-model-content', 'model-content', 'port', 'port-ask', 'port-model', 'port-recorder', 'battery'] as const)('an awaited route read fences %s replacement before returning a result', async changed => {
    const f = fixture(); const wait = suspended(); const controller = new AbortController(); const fake = readings();
    const borrowed: JudgmentPort = { ...fake.port, ask: async request => {
      expect(request.signal).toBe(controller.signal); wait.start(); await wait.gate; return fake.port.ask(request);
    } };
    installJudgmentPort(borrowed);
    let delivered = 0;
    const pending = f.tool.execute(routeArgs, { signal: controller.signal }).then(result => { delivered++; return result; });
    await wait.started;
    const context = record(f.context);
    if (changed === 'cancel') controller.abort(new Error('synthetic cancellation'));
    if (changed === 'session') record(context.session).runtime = { ...record(record(context.session).runtime) };
    if (changed === 'owner') bindAgentResearchSourceOwner(f.registry, researchScreeningFixture().owner);
    if (changed === 'provider-api') record(context.clients).providerApi = { ...f.providerApi };
    if (changed === 'provider-api-method') f.providerApi.listModels = async () => f.models;
    if (changed === 'provider-registry') record(context.provider).providerRegistry = { ...f.providerRegistry };
    if (changed === 'provider-registry-method') f.providerRegistry.listProviders = () => f.providers;
    if (changed === 'provider-adapter') {
      const original = f.providers[0]!; f.providers[0] = { ...original };
      expect(f.providers[0]).toEqual(original); expect(f.providers[0]).not.toBe(original);
    }
    if (changed === 'config') record(context.platform).config = {};
    if (changed === 'config-manager') record(context.platform).configManager = { ...record(record(context.platform).configManager) };
    if (changed === 'config-value') f.config['helper.enabled'] = true;
    if (changed === 'artifact-store') record(context.platform).artifactStore = { list: () => f.artifacts };
    if (changed === 'artifact-content') f.artifacts.push({ id: 'late-artifact', kind: 'synthetic', createdAt: recordedAt });
    if (changed === 'read-model') record(record(context.platform).readModels).providerHealth = { ...f.health };
    if (changed === 'read-model-content') f.health.routes[0]!.avgLatencyMs = 1;
    if (changed === 'model-content') record(f.models[0]!.capabilities).multimodal = false;
    if (changed === 'port') installJudgmentPort(readings().port);
    if (changed === 'port-ask') borrowed.ask = async request => fake.port.ask(request);
    if (changed === 'port-model') record(borrowed).model = 'swapped-model';
    if (changed === 'port-recorder') record(borrowed).recorder = {};
    if (changed === 'battery') {
      const get = routingRegistry.get;
      routingRegistry.get = name => name === routeReadiness.name ? { ...routeReadiness } : get.call(routingRegistry, name);
      restores.push(() => { routingRegistry.get = get; });
    }
    wait.release(); await expect(pending).rejects.toThrow();
    expect(delivered).toBe(0); expect(fake.requests).toHaveLength(1); expect(f.effects).toEqual([]);
  });

  test.each(['cancel', 'owner', 'provider-api', 'config', 'artifact-store', 'read-model'] as const)('full-source screening fences %s loss before hosted readiness dispatch', async changed => {
    const wait = suspended();
    const screening = researchScreeningFixture({ beforeProposal: async source => {
      if (source.parts.some(part => part.includes('"registryModels"'))) { wait.start(); await wait.gate; }
    } });
    const f = fixture(screening.owner); const controller = new AbortController(); const fake = readings(); installJudgmentPort(fake.port);
    const pending = f.tool.execute(routeArgs, { signal: controller.signal });
    await wait.started;
    const context = record(f.context);
    if (changed === 'cancel') controller.abort();
    if (changed === 'owner') bindAgentResearchSourceOwner(f.registry, ordinaryResearchOwner());
    if (changed === 'provider-api') record(context.clients).providerApi = { ...f.providerApi };
    if (changed === 'config') record(context.platform).config = {};
    if (changed === 'artifact-store') record(context.platform).artifactStore = { list: () => [] };
    if (changed === 'read-model') record(context.platform).readModels = {};
    wait.release(); await expect(pending).rejects.toThrow(); expect(fake.requests).toHaveLength(0); expect(f.effects).toEqual([]);
  });

  test('late cancellation after an answer was computed still publishes no route result', async () => {
    const f = fixture(); const controller = new AbortController(); const fake = readings(); let answered = 0, delivered = 0;
    installJudgmentPort({ ...fake.port, ask: async request => {
      const answer = await fake.port.ask(request); answered++; controller.abort(); return answer;
    } });
    const pending = f.tool.execute(routeArgs, { signal: controller.signal }).then(result => { delivered++; return result; });
    await expect(pending).rejects.toThrow(); expect(answered).toBe(1); expect(delivered).toBe(0); expect(f.effects).toEqual([]);
  });

  test('models adapter retains the exact options capability across argument translation', async () => {
    const f = fixture(); const controller = new AbortController();
    const options = { signal: controller.signal };
    let observed: ToolExecuteOptions | undefined;
    const harness: Tool = { definition: { name: 'agent_harness', description: 'Synthetic downstream adapter', parameters: { type: 'object' } },
      execute: async (args, received) => { observed = received; expect(args).toMatchObject({ mode: 'model_route', modelRouteId: routeId }); return { success: true }; } };
    const tool = createAgentModelsTool({ ...f.deps, harnessTool: harness });
    expect((await tool.execute(routeArgs, options)).success).toBe(true); expect(observed).toBe(options);
  });

  test('registered models admission remains authentic through adapter translation and fences policy revocation', async () => {
    let revoked = false;
    const reader = { getAutonomousSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} }, autoApprove: revoked, directory: '/synthetic/readiness' }),
      isAutoApproveEnabled: () => revoked, getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }), getWorkingDirectory: () => '/synthetic/readiness' } as PermissionConfigReader;
    const manager = new PermissionManager(undefined, reader, new PolicyRuntimeState());
    const f = fixture(ordinaryResearchOwner(), new ToolRegistry(manager));
    registerAgentModelsTool(f.registry, f.commands, f.context);
    const registered = f.registry.list().find(tool => tool.definition.name === 'models')!;
    const execute = registered.execute;
    let originalArgs: Record<string, unknown> | undefined, originalOptions: ToolExecuteOptions | undefined;
    registered.execute = async (args, options) => {
      originalArgs = args; originalOptions = options; expect(assertCurrentToolExecution(args, options)).toBe(true); return execute(args, options);
    };
    const wait = suspended(); const fake = readings();
    using log = new SqliteDecisionLog(':memory:');
    installJudgmentPort(withDecisionLog({ ...fake.port, ask: async request => {
      if (request.context?.battery === routeReadiness.name) {
        expect(assertCurrentToolExecution(originalArgs!, originalOptions)).toBe(true); wait.start(); await wait.gate;
      }
      return fake.port.ask(request);
    } }, log));
    const call = await f.registry.prepareCall('authentic-readiness', 'models', routeArgs);
    const admission = await manager.admitAutonomous(call.callId, 'models', call.args, { sourceOf: () => ({ goal: 'Inspect synthetic readiness', criteria: ['Read only synthetic facts'] }),
      schemaRevision: call.schemaRevision, preparedCall: { registry: f.registry, call } });
    expect(admission.result.approved).toBe(true);
    const pending = f.registry.executePrepared(call, admission);
    await wait.started; revoked = true; wait.release(); await expect(pending).rejects.toThrow(); expect(f.effects).toEqual([]);
  });

  test('registered models tool revocation is fenced through the real rewritten caller', async () => {
    const f = fixture(); registerAgentModelsTool(f.registry, f.commands, f.context);
    const wait = suspended(); const fake = readings();
    installJudgmentPort({ ...fake.port, ask: async request => {
      if (request.context?.battery === routeReadiness.name) { wait.start(); await wait.gate; }
      return fake.port.ask(request);
    } });
    const pending = f.registry.execute('registered-readiness', 'models', routeArgs);
    await wait.started; f.registry.unregister('models'); wait.release(); await expect(pending).rejects.toThrow(); expect(f.effects).toEqual([]);
  });
});

describe('complete original model-readiness source protection', () => {
  test.each(['status', 'route', 'local'] as const)('%s screens complete original invocation before adapters omit metadata', async action => {
    const sensitive = 'synthetic-private-invocation';
    const screening = researchScreeningFixture({ spans: exactSensitiveSpans([sensitive]) });
    const f = fixture(screening.owner); const fake = readings(); installJudgmentPort(fake.port);
    const args = { action, modelRouteId: action === 'route' ? routeId : undefined,
      unusedNested: { ownerNote: sensitive }, includeParameters: false, limit: 1 };
    await expect(f.tool.execute(args)).rejects.toThrow();
    expect(JSON.stringify(proposals(screening.calls))).toContain(sensitive);
    expect(fake.requests).toHaveLength(0); expect(f.effects).toEqual([]);
  });

  test.each(['model', 'provider', 'health', 'artifact', 'config', 'beyond-display-limit'] as const)('full %s metadata is screened before display projection or any readiness reader', async field => {
    const sensitive = 'synthetic-private-metadata';
    const screening = researchScreeningFixture({ spans: exactSensitiveSpans([sensitive]) });
    const f = fixture(screening.owner); const fake = readings(); installJudgmentPort(fake.port);
    if (field === 'model') f.models[0]!.metadata = { hidden: sensitive };
    if (field === 'provider') f.providers[0]!.documentation = 'x'.repeat(700) + sensitive;
    if (field === 'health') f.health.routes[0]!.lastErrorMessage = 'x'.repeat(700) + sensitive;
    if (field === 'artifact') f.artifacts.push({ id: 'synthetic-artifact', metadata: { privateNote: sensitive } });
    if (field === 'config') f.config['helper.globalModel'] = { privateNote: sensitive };
    if (field === 'beyond-display-limit') {
      f.models.push(...Array.from({ length: 12 }, (_, index) => ({ ...f.models[0], registryKey: `other:${index}`, modelId: `other-${index}` })));
      f.models.at(-1)!.metadata = { undisplayed: sensitive };
    }
    await expect(f.tool.execute({ action: 'status', query: 'opaque-model', limit: 1, includeParameters: false })).rejects.toThrow();
    expect(JSON.stringify(proposals(screening.calls))).toContain(sensitive);
    expect(fake.requests).toHaveLength(0); expect(f.effects).toEqual([]);
  });

  test.each(['invocation', 'model', 'provider', 'health', 'artifact', 'config'] as const)('nested credentials in %s are held before that source reaches even local prescreen transport', async field => {
    const secret = 'synthetic-credential-never-transmitted';
    const screening = researchScreeningFixture(); const f = fixture(screening.owner); const fake = readings(); installJudgmentPort(fake.port);
    const credentials = { nested: { authorization: `Bearer ${secret}` } };
    const invocation: Json = { ...routeArgs };
    if (field === 'invocation') invocation.metadata = credentials;
    if (field === 'model') f.models[0]!.metadata = credentials;
    if (field === 'provider') f.providers[0]!.metadata = credentials;
    if (field === 'health') f.health.routes[0]!.metadata = credentials;
    if (field === 'artifact') f.artifacts.push({ id: 'credential-artifact', metadata: credentials });
    if (field === 'config') f.config['helper.globalModel'] = credentials;
    let consumed = 0;
    await expect(withModelReadingContext(f.context, invocation, modelReadingOptions(f.context, f.registry), async () => { consumed++; })).rejects.toThrow();
    expect(screening.calls).toHaveLength(0); expect(fake.requests).toHaveLength(0); expect(consumed).toBe(0);
    await expect(f.tool.execute(invocation)).rejects.toThrow();
    expect(JSON.stringify(screening.calls)).not.toContain(secret); expect(fake.requests).toHaveLength(0);
  });

  test.each(['accessor', 'proxy', 'toJSON', 'cycle', 'oversize', 'sparse-array', 'nonfinite'] as const)('malformed %s source is held without getter/proxy execution or prescreen transport', async kind => {
    const screening = researchScreeningFixture(); const fake = readings(); installJudgmentPort(fake.port);
    let touched = 0, consumed = 0;
    let source: unknown;
    if (kind === 'accessor') source = { hidden: { get value() { touched++; return 'private'; } } };
    if (kind === 'proxy') source = { hidden: new Proxy({}, { ownKeys() { touched++; return []; }, get() { touched++; return undefined; } }) };
    if (kind === 'toJSON') source = { toJSON() { touched++; return {}; } };
    if (kind === 'cycle') { const cyclic: Json = {}; cyclic.self = cyclic; source = cyclic; }
    if (kind === 'oversize') source = { hidden: 'x'.repeat(SOURCE_SCREENING_LIMITS.characters + 1) };
    if (kind === 'sparse-array') source = { metadata: new Array(100_001) };
    if (kind === 'nonfinite') source = { latencyMs: Number.POSITIVE_INFINITY };
    await expect(withModelReadingSource(source, { sourceOwner: screening.owner }, async () => { consumed++; })).rejects.toThrow();
    expect(touched).toBe(0); expect(consumed).toBe(0); expect(screening.calls).toHaveLength(0); expect(fake.requests).toHaveLength(0);
  });

  test.each(['get-action', 'get-nested', 'proxy', 'inherited'] as const)('actual adapter rejects %s invocation without executing traps or contacting any service', async kind => {
    const screening = researchScreeningFixture(); const f = fixture(screening.owner); const fake = readings(); installJudgmentPort(fake.port);
    let touched = 0;
    let args: Json = { ...routeArgs };
    if (kind === 'get-action') Object.defineProperty(args, 'action', { get() { touched++; return 'route'; } });
    if (kind === 'get-nested') args.metadata = { get privateNote() { touched++; return 'private'; } };
    if (kind === 'proxy') args = new Proxy(args, { get() { touched++; return undefined; }, ownKeys() { touched++; return []; } });
    if (kind === 'inherited') args = Object.assign(Object.create({ get action() { touched++; return 'route'; } }), { modelRouteId: routeId });
    await expect(f.tool.execute(args)).rejects.toThrow();
    expect(touched).toBe(0); expect(screening.calls).toHaveLength(0); expect(fake.requests).toHaveLength(0);
  });

  test.each(['model-accessor', 'model-proxy', 'provider-accessor', 'read-model-accessor', 'read-model-proxy'] as const)('complete %s metadata is captured before its getters or proxies can run', async kind => {
    const screening = researchScreeningFixture(); const f = fixture(screening.owner); const fake = readings(); installJudgmentPort(fake.port);
    let touched = 0;
    const getter = () => { touched++; return 'private'; };
    if (kind === 'model-accessor') Object.defineProperty(f.models[0], 'undisplayed', { get: getter });
    if (kind === 'model-proxy') f.models[0]!.metadata = new Proxy({}, { get() { touched++; return undefined; } });
    if (kind === 'provider-accessor') Object.defineProperty(f.providers[0], 'undisplayed', { get: getter });
    if (kind === 'read-model-accessor') Object.defineProperty(f.health.routes[0], 'undisplayed', { get: getter });
    if (kind === 'read-model-proxy') record(record(record(f.context).platform).readModels).providerHealth = new Proxy(f.health, { get() { touched++; return undefined; } });
    await expect((async () => withModelReadingContext(f.context, routeArgs, modelReadingOptions(f.context, f.registry), async () => {}))()).rejects.toThrow();
    expect(touched).toBe(0); expect(screening.calls).toHaveLength(0); expect(fake.requests).toHaveLength(0);
  });

  test.each(['changed-json', 'malformed-json', 'missing-part', 'extra-part'] as const)('%s projection cannot rewrite or release a source into judgment', async kind => {
    const screening = researchScreeningFixture(); const fake = readings(); installJudgmentPort(fake.port); let consumed = 0, released = 0;
    const owner: ProtectedSourceOwner = { ...screening.owner, project(receipt) {
      const original = screening.owner.project(receipt);
      return kind === 'changed-json' ? ['{"safe":"invented"}'] : kind === 'malformed-json' ? ['{'] : kind === 'missing-part' ? [] : [...original, '{}'];
    }, async release(handle) { released++; await screening.owner.release(handle); } };
    await expect(withModelReadingSource({ safe: 'original' }, { sourceOwner: owner }, async () => { consumed++; })).rejects.toThrow();
    expect(consumed).toBe(0); expect(fake.requests).toHaveLength(0); expect(released).toBe(1);
  });

  test('a held source-screening receipt does not dispatch readiness or invent a score', async () => {
    const screening = researchScreeningFixture({ complete: 0.5 }); const f = fixture(screening.owner); const fake = readings(); installJudgmentPort(fake.port);
    await expect(f.tool.execute(routeArgs)).rejects.toThrow(); expect(fake.requests).toHaveLength(0); expect(f.effects).toEqual([]);
  });

  test('full model data above the source bound is refused before local prescreen transport', async () => {
    const screening = researchScreeningFixture(); const f = fixture(screening.owner); const fake = readings(); installJudgmentPort(fake.port);
    f.models[0]!.metadata = { undisplayed: 'x'.repeat(SOURCE_SCREENING_LIMITS.characters + 1) };
    await expect((async () => withModelReadingContext(f.context, routeArgs, modelReadingOptions(f.context, f.registry), async () => {}))()).rejects.toThrow();
    expect(screening.calls).toHaveLength(0); expect(fake.requests).toHaveLength(0);
  });
});

test('a PAN-shaped numeric artifact timestamp fails closed without source transport, a score, or a raw-value error leak', async () => {
  // Deliberately Luhn-shaped numeric epoch. The global input gate must remain
  // strict even when the field happens to be a timestamp rather than a card.
  const timestamp = 1700000000004;
  const screening = researchScreeningFixture(); const f = fixture(screening.owner); const fake = readings(); installJudgmentPort(fake.port);
  f.artifacts.push({ id: 'synthetic-timestamp', createdAt: timestamp });
  let consumed = 0;
  let failure: unknown;
  try { await withModelReadingContext(f.context, routeArgs, modelReadingOptions(f.context, f.registry), async () => { consumed++; }); }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).not.toContain(String(timestamp));
  expect(consumed).toBe(0); expect(screening.calls).toHaveLength(0); expect(fake.requests).toHaveLength(0);
  await expect(f.tool.execute(routeArgs)).rejects.toThrow();
  expect(JSON.stringify(screening.calls)).not.toContain(String(timestamp)); expect(fake.requests).toHaveLength(0); expect(f.effects).toEqual([]);
});

test.each(['fit', 'exampleVision'] as const)('real local view cancels during %s before any result or queued recipe judgments', async phase => {
  const f = fixture(); const fake = readings(); const controller = new AbortController(); const wait = suspended();
  let dispatched = 0, delivered = 0;
  installJudgmentPort({ ...fake.port, ask: async request => {
    dispatched++;
    if (Object.hasOwn(request.questions, phase)) { wait.start(); await wait.gate; }
    return fake.port.ask(request);
  } });
  const pending = f.tool.execute({ action: 'local', includeParameters: true }, { signal: controller.signal }).then(result => { delivered++; return result; });
  await wait.started; const atCancellation = dispatched; controller.abort(); wait.release();
  await expect(pending).rejects.toThrow(); expect(delivered).toBe(0); expect(dispatched).toBe(atCancellation); expect(f.effects).toEqual([]);
});

test.each(['provider-api', 'provider-registry', 'config-manager'] as const)('service slot %s accessors never execute during source capture', async field => {
  const screening = researchScreeningFixture(); const f = fixture(screening.owner); const fake = readings(); installJudgmentPort(fake.port);
  let touched = 0, consumed = 0;
  const context = record(f.context);
  const [target, key, value]: [Json, string, unknown] = field === 'provider-api' ? [record(context.clients), 'providerApi', f.providerApi]
    : field === 'provider-registry' ? [record(context.provider), 'providerRegistry', f.providerRegistry]
    : [record(context.platform), 'configManager', record(context.platform).configManager];
  Object.defineProperty(target, key, { get() { touched++; return value; } });
  await expect((async () => withModelReadingContext(f.context, routeArgs, modelReadingOptions(f.context, f.registry), async () => { consumed++; }))()).rejects.toThrow();
  expect(touched).toBe(0); expect(consumed).toBe(0); expect(screening.calls).toHaveLength(0); expect(fake.requests).toHaveLength(0);
});

test.each(['completed', 'failed', 'missing-status', 'other-route', 'other-provider', 'missing-timestamp', 'numeric-string'] as const)('saved benchmark %s latency is used only with successful exact-route evidence', async kind => {
  const f = fixture(); f.health.routes = [];
  const evidence: Json = { registryKey: routeId, providerId: 'ollama-local', modelId: 'opaque-model', latencyMs: 20, status: 'completed' };
  if (kind === 'failed') evidence.status = 'failed';
  if (kind === 'numeric-string') evidence.latencyMs = '20';
  if (kind === 'missing-status') delete evidence.status;
  if (kind === 'other-route') evidence.registryKey = 'ollama-local:unrelated-model';
  if (kind === 'other-provider') evidence.providerId = 'other-provider';
  f.artifacts.push({ id: 'synthetic-benchmark', ...(kind === 'missing-timestamp' ? {} : { createdAt: 1700000000000 }), metadata: {
    purpose: 'agent-model-compare', benchmarkKind: 'local-model-route', candidateLatencyEvidence: [evidence],
  } });
  const fake = readings(); installJudgmentPort(fake.port);
  const route = body(await f.tool.execute(routeArgs));
  if (kind === 'completed') {
    expect(route.readiness).toMatchObject({ score: 100, outcome: 'ready' });
    expect(record(fake.requests[0]!.state).measuredLatency).toMatchObject({ registryKey: routeId, providerId: 'ollama-local', latencyMs: 20, status: 'completed' });
  } else {
    expect(route.readinessScore).toBeNull(); expect(dimension(route.readiness, 'latency').score).toBeNull();
    expect(record(fake.requests[0]!.state).measuredLatency).toBeNull();
  }
  expect(f.effects).toEqual([]);
});

test.each(['direct', 'nested', 'snapshot'] as const)('native %s Map provider health preserves exact-route successful latency', async kind => {
  const f = fixture(); const mapped = new Map([[routeId, f.health.routes[0]]]);
  record(record(record(f.context).platform).readModels).providerHealth = kind === 'direct' ? mapped : kind === 'nested' ? { routes: mapped } : { getSnapshot: () => mapped };
  const fake = readings(); installJudgmentPort(fake.port);
  const result = body(await f.tool.execute(routeArgs));
  expect(result.readiness).toMatchObject({ score: 100, outcome: 'ready' });
  expect(record(fake.requests[0]!.state).measuredLatency).toMatchObject({ routeId, milliseconds: 18_000, source: 'provider-health' });
  expect(f.effects).toEqual([]);
});

test.each(['proxy', 'own-accessor', 'overridden-entries', 'object-key'] as const)('unsafe native Map %s is refused before traps, conversion, or source transport', async kind => {
  const screening = researchScreeningFixture(); const f = fixture(screening.owner); const fake = readings(); installJudgmentPort(fake.port);
  let touched = 0;
  const mapped = new Map<unknown, unknown>([[routeId, f.health.routes[0]]]);
  let value: unknown = mapped;
  if (kind === 'proxy') value = new Proxy(mapped, { get() { touched++; return undefined; } });
  if (kind === 'own-accessor') Object.defineProperty(mapped, 'undisplayed', { get() { touched++; return 'private'; } });
  if (kind === 'overridden-entries') Object.defineProperty(mapped, 'entries', { value() { touched++; return [][Symbol.iterator](); } });
  if (kind === 'object-key') mapped.set({ toString() { touched++; return 'private'; } }, f.health.routes[0]);
  record(record(record(f.context).platform).readModels).providerHealth = { routes: value };
  await expect((async () => withModelReadingContext(f.context, routeArgs, modelReadingOptions(f.context, f.registry), async () => {}))()).rejects.toThrow();
  expect(touched).toBe(0); expect(screening.calls).toHaveLength(0); expect(fake.requests).toHaveLength(0);
});

test('mutating the original adapter options cannot substitute a fresh cancellation capability during a read', async () => {
  const f = fixture(); const fake = readings(); const wait = suspended(); const controller = new AbortController();
  const options: ToolExecuteOptions = { signal: controller.signal };
  installJudgmentPort({ ...fake.port, ask: async request => { wait.start(); await wait.gate; return fake.port.ask(request); } });
  let delivered = 0;
  const pending = f.tool.execute(routeArgs, options).then(result => { delivered++; return result; });
  await wait.started; record(options).signal = new AbortController().signal; wait.release();
  await expect(pending).rejects.toThrow(); expect(delivered).toBe(0); expect(f.effects).toEqual([]);
});

test.each(['signal', 'sourceOwner', 'assertCurrent'] as const)('mutating source reading options %s cannot authorize a pending result', async changed => {
  const wait = suspended(); const controller = new AbortController();
  const options = { sourceOwner: ordinaryResearchOwner(), signal: controller.signal, assertCurrent: () => {} };
  let delivered = 0;
  const pending = withModelReadingSource({ safe: 'source' }, options, async () => { wait.start(); await wait.gate; return 'result'; })
    .then(result => { delivered++; return result; });
  await wait.started;
  if (changed === 'signal') record(options).signal = new AbortController().signal;
  if (changed === 'sourceOwner') record(options).sourceOwner = researchScreeningFixture().owner;
  if (changed === 'assertCurrent') record(options).assertCurrent = () => {};
  wait.release(); await expect(pending).rejects.toThrow(); expect(delivered).toBe(0);
});

test.each(['invocation', 'model', 'provider', 'artifact'] as const)('non-enumerable %s credentials stay protected before source transport', async field => {
  const secret = 'synthetic-hidden-credential';
  const screening = researchScreeningFixture(); const f = fixture(screening.owner); const fake = readings(); installJudgmentPort(fake.port);
  const invocation: Json = { ...routeArgs };
  const artifact: Json = { id: 'hidden-artifact', metadata: {} };
  if (field === 'artifact') f.artifacts.push(artifact);
  const target = field === 'invocation' ? invocation : field === 'model' ? f.models[0]! : field === 'provider' ? f.providers[0]! : artifact;
  Object.defineProperty(target, 'undisplayed', { value: { nested: { authorization: `Bearer ${secret}` } }, enumerable: false });
  await expect(withModelReadingContext(f.context, invocation, modelReadingOptions(f.context, f.registry), async () => {})).rejects.toThrow();
  expect(screening.calls).toHaveLength(0); expect(fake.requests).toHaveLength(0);
  await expect(f.tool.execute(invocation)).rejects.toThrow();
  expect(JSON.stringify(screening.calls)).not.toContain(secret); expect(fake.requests).toHaveLength(0); expect(f.effects).toEqual([]);
});

test.each(['invocation', 'model', 'provider', 'artifact'] as const)('non-enumerable %s semantic metadata is screened completely', async field => {
  const sensitive = 'synthetic-hidden-private-note';
  const screening = researchScreeningFixture({ spans: exactSensitiveSpans([sensitive]) }); const f = fixture(screening.owner); const fake = readings(); installJudgmentPort(fake.port);
  const invocation: Json = { ...routeArgs };
  const artifact: Json = { id: 'hidden-artifact', metadata: {} };
  if (field === 'artifact') f.artifacts.push(artifact);
  const target = field === 'invocation' ? invocation : field === 'model' ? f.models[0]! : field === 'provider' ? f.providers[0]! : artifact;
  Object.defineProperty(target, 'undisplayed', { value: { nested: sensitive }, enumerable: false });
  await expect(f.tool.execute(invocation)).rejects.toThrow();
  expect(JSON.stringify(proposals(screening.calls))).toContain(sensitive); expect(fake.requests).toHaveLength(0); expect(f.effects).toEqual([]);
});

test.each(['invocation', 'model', 'provider', 'artifact'] as const)('late non-enumerable %s source mutation cannot publish a readiness result', async field => {
  const f = fixture(); const fake = readings(); const wait = suspended();
  const invocation: Json = { ...routeArgs };
  const artifact: Json = { id: 'hidden-artifact', metadata: {} };
  if (field === 'artifact') f.artifacts.push(artifact);
  const target = field === 'invocation' ? invocation : field === 'model' ? f.models[0]! : field === 'provider' ? f.providers[0]! : artifact;
  Object.defineProperty(target, 'undisplayed', { value: 'original', enumerable: false, writable: true });
  installJudgmentPort({ ...fake.port, ask: async request => { wait.start(); await wait.gate; return fake.port.ask(request); } });
  let delivered = 0;
  const pending = f.tool.execute(invocation).then(result => { delivered++; return result; });
  await wait.started; target.undisplayed = 'changed'; wait.release();
  await expect(pending).rejects.toThrow(); expect(delivered).toBe(0); expect(f.effects).toEqual([]);
});

test.each(['available', 'configured'] as const)('current model outside selectable catalog preserves its own %s false', async field => {
  const f = fixture(); const current: Json = { ...f.models[0], registryKey: 'ollama-local:current-only', modelId: 'current-only' };
  if (field === 'available') current.available = false;
  if (field === 'configured') { delete current.isConfigured; current.configured = false; }
  f.providerApi.getCurrentModel = async () => current;
  record(f.context.session.runtime).model = 'ollama-local:current-only';
  const fake = readings(); installJudgmentPort(fake.port);
  const result = body(await f.tool.execute({ action: 'status', query: 'opaque-model', includeParameters: true }));
  const model = record(record(result.current).currentModel);
  expect(model.modelId).toBe('current-only'); expect(model[field]).toBe(false);
  expect(model.readiness).toMatchObject({ score: null, outcome: 'unavailable' });
  expect(f.models.every(candidate => candidate.registryKey !== current.registryKey)).toBe(true); expect(f.effects).toEqual([]);
});

test.each(['session', 'runtime', 'clients', 'mcpApi', 'extensions', 'mcpRegistry'] as const)('real models facade rejects context %s accessors before getter effects', async field => {
  const screening = researchScreeningFixture(); const f = fixture(screening.owner); const fake = readings(); installJudgmentPort(fake.port);
  const context = record(f.context);
  const [target, key]: [Json, string] = field === 'runtime' ? [record(context.session), 'runtime']
    : field === 'mcpApi' ? [record(context.clients), 'mcpApi'] : field === 'mcpRegistry' ? [record(context.extensions), 'mcpRegistry'] : [context, field];
  const original = target[key]; let touched = 0;
  Object.defineProperty(target, key, { get() { touched++; return original; } });
  await expect(f.tool.execute(routeArgs)).rejects.toThrow();
  expect(touched).toBe(0); expect(fake.requests).toHaveLength(0); expect(screening.calls).toHaveLength(0); expect(f.effects).toEqual([]);
});

test.each(['session', 'clients', 'extensions', 'platform', 'provider'] as const)('real models facade rejects context %s proxies without running their traps', async field => {
  const f = fixture(); const fake = readings(); installJudgmentPort(fake.port); let touched = 0;
  const context = record(f.context), original = record(context[field]);
  context[field] = new Proxy(original, { get() { touched++; return undefined; }, getPrototypeOf() { touched++; return null; }, ownKeys() { touched++; return []; } });
  await expect(f.tool.execute(routeArgs)).rejects.toThrow();
  expect(touched).toBe(0); expect(fake.requests).toHaveLength(0); expect(f.effects).toEqual([]);
});

test.each(['runtime', 'mcpApi', 'providerApi', 'providerRegistry', 'configManager'] as const)('late context %s accessor replacement holds output without invoking the getter', async field => {
  const f = fixture(); const fake = readings(); const wait = suspended(); const context = record(f.context);
  const [target, key]: [Json, string] = field === 'runtime' ? [record(context.session), 'runtime']
    : field === 'mcpApi' || field === 'providerApi' ? [record(context.clients), field]
    : field === 'providerRegistry' ? [record(context.provider), field] : [record(context.platform), field];
  const original = target[key]; let touched = 0, delivered = 0;
  installJudgmentPort({ ...fake.port, ask: async request => { wait.start(); await wait.gate; return fake.port.ask(request); } });
  const pending = f.tool.execute(routeArgs).then(result => { delivered++; return result; });
  await wait.started; Object.defineProperty(target, key, { get() { touched++; return original; } }); wait.release();
  await expect(pending).rejects.toThrow(); expect(touched).toBe(0); expect(delivered).toBe(0); expect(f.effects).toEqual([]);
});

test('depth-30 shared source DAG is bounded before prescreen transport rather than expanded exponentially', async () => {
  const screening = researchScreeningFixture(); const fake = readings(); installJudgmentPort(fake.port);
  let source: Json = { ordinary: 'leaf' };
  for (let depth = 0; depth < 30; depth++) source = { left: source, right: source };
  const started = performance.now();
  await expect(withModelReadingSource(source, { sourceOwner: screening.owner }, async () => {})).rejects.toThrow();
  expect(performance.now() - started).toBeLessThan(2_000); expect(screening.calls).toHaveLength(0); expect(fake.requests).toHaveLength(0);
});

function pauseSourceRelease(original: ProtectedSourceOwner, selected: (source: string) => boolean) {
  const wait = suspended(), sources = new WeakMap<object, string>();
  const counts = { selected: 0 };
  const owner: ProtectedSourceOwner = { ...original,
    capture(parts) { const handle = original.capture(parts); sources.set(handle, parts.join('\n')); return handle; },
    async release(handle) {
      await original.release(handle);
      if (selected(sources.get(handle) ?? '')) { counts.selected++; if (counts.selected === 1) { wait.start(); await wait.gate; } }
    },
  };
  return { owner, wait, counts };
}

test.each(['cancel', 'owner', 'session'] as const)('real facade rechecks %s loss during awaited source release before publication', async changed => {
  const paused = pauseSourceRelease(ordinaryResearchOwner(), source => source.includes('"subject"') && source.includes('"measuredLatency"'));
  const f = fixture(paused.owner); const fake = readings(); installJudgmentPort(fake.port); const controller = new AbortController();
  let delivered = 0;
  const pending = f.tool.execute(routeArgs, { signal: controller.signal }).then(result => { delivered++; return result; });
  await paused.wait.started;
  if (changed === 'cancel') controller.abort();
  if (changed === 'owner') bindAgentResearchSourceOwner(f.registry, researchScreeningFixture().owner);
  if (changed === 'session') record(f.context.session.runtime).sessionId = 'replacement-session';
  paused.wait.release(); await expect(pending).rejects.toThrow();
  expect(delivered).toBe(0); expect(paused.counts.selected).toBe(1); expect(f.effects).toEqual([]);
});

test.each(['cancel', 'owner', 'authority', 'source'] as const)('source helper rechecks %s loss after releasing its receipt', async changed => {
  const paused = pauseSourceRelease(ordinaryResearchOwner(), () => true); const controller = new AbortController(); let revoked = false, delivered = 0;
  const source = { ordinary: 'original' };
  const options = { sourceOwner: paused.owner, signal: controller.signal, assertCurrent: () => { if (revoked) throw new Error('synthetic authority revoked'); } };
  const pending = withModelReadingSource(source, options, async () => 'result').then(result => { delivered++; return result; });
  await paused.wait.started;
  if (changed === 'cancel') controller.abort();
  if (changed === 'owner') record(options).sourceOwner = researchScreeningFixture().owner;
  if (changed === 'authority') revoked = true;
  if (changed === 'source') source.ordinary = 'changed';
  paused.wait.release(); await expect(pending).rejects.toThrow(); expect(delivered).toBe(0); expect(paused.counts.selected).toBe(1);
});

test('registered admission revocation during source release cannot publish a result', async () => {
  let revoked = false;
  const reader = { getAutonomousSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} }, autoApprove: revoked, directory: '/synthetic/readiness' }),
    isAutoApproveEnabled: () => revoked, getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }), getWorkingDirectory: () => '/synthetic/readiness' } as PermissionConfigReader;
  const manager = new PermissionManager(undefined, reader, new PolicyRuntimeState());
  const paused = pauseSourceRelease(ordinaryResearchOwner(), source => source.includes('"subject"') && source.includes('"measuredLatency"'));
  const f = fixture(paused.owner, new ToolRegistry(manager)); registerAgentModelsTool(f.registry, f.commands, f.context);
  const fake = readings(); using log = new SqliteDecisionLog(':memory:'); installJudgmentPort(withDecisionLog(fake.port, log));
  const call = await f.registry.prepareCall('release-readiness', 'models', routeArgs);
  const admission = await manager.admitAutonomous(call.callId, 'models', call.args, { sourceOf: () => ({ goal: 'Inspect synthetic readiness', criteria: ['Read only synthetic facts'] }),
    schemaRevision: call.schemaRevision, preparedCall: { registry: f.registry, call } });
  expect(admission.result.approved).toBe(true);
  let delivered = 0;
  const pending = f.registry.executePrepared(call, admission).then(result => { delivered++; return result; });
  await paused.wait.started; revoked = true; paused.wait.release();
  await expect(pending).rejects.toThrow(); expect(delivered).toBe(0); expect(paused.counts.selected).toBe(1); expect(f.effects).toEqual([]);
});

test('inherited execution signal accessor is rejected before any getter or source transport', async () => {
  const screening = researchScreeningFixture(); const f = fixture(screening.owner); const fake = readings(); installJudgmentPort(fake.port); let touched = 0;
  const options = Object.create({ get signal() { touched++; return new AbortController().signal; } }) as ToolExecuteOptions;
  await expect(f.tool.execute(routeArgs, options)).rejects.toThrow();
  expect(touched).toBe(0); expect(screening.calls).toHaveLength(0); expect(fake.requests).toHaveLength(0);
});

test('deleting an owned signal cannot reveal and invoke an inherited signal accessor during a read', async () => {
  const f = fixture(); const fake = readings(); const wait = suspended(); const controller = new AbortController(); let touched = 0, delivered = 0;
  const options = Object.create({ get signal() { touched++; return controller.signal; } }) as ToolExecuteOptions;
  Object.defineProperty(options, 'signal', { value: controller.signal, configurable: true, enumerable: true });
  installJudgmentPort({ ...fake.port, ask: async request => { wait.start(); await wait.gate; return fake.port.ask(request); } });
  const pending = f.tool.execute(routeArgs, options).then(result => { delivered++; return result; });
  await wait.started; delete record(options).signal; wait.release();
  await expect(pending).rejects.toThrow(); expect(touched).toBe(0); expect(delivered).toBe(0); expect(f.effects).toEqual([]);
});

test.each(['run', 'items', 'composite'] as const)('same-object battery %s replacement invalidates an awaited reading', async field => {
  const f = fixture(); const fake = readings(); const wait = suspended(); let delivered = 0;
  installJudgmentPort({ ...fake.port, ask: async request => { wait.start(); await wait.gate; return fake.port.ask(request); } });
  const pending = f.tool.execute(routeArgs).then(result => { delivered++; return result; });
  await wait.started;
  const original = record(routeReadiness)[field];
  restores.push(() => { record(routeReadiness)[field] = original; });
  if (field === 'run') record(routeReadiness).run = async () => { throw new Error('replacement must not run'); };
  else record(routeReadiness)[field] = { ...record(original), changedPolicy: true };
  wait.release(); await expect(pending).rejects.toThrow(); expect(delivered).toBe(0); expect(f.effects).toEqual([]);
});

test.each(['openai-compatible', 'ollama'] as const)('real %s provider adapter publishes safe readiness facts without reading credential internals or making provider calls', async kind => {
  const secret = 'synthetic-runtime-provider-key';
  const screening = researchScreeningFixture(); const f = fixture(screening.owner); const fake = readings(); installJudgmentPort(fake.port);
  let providerCalls = 0, inheritedModelsReads = 0;
  const options = { name: 'ollama-local', baseURL: kind === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'https://inference.example.invalid/v1',
    apiKey: secret, defaultHeaders: { Authorization: `Bearer ${secret}` }, defaultModel: 'opaque-model', models: ['opaque-model'],
    modelListing: 'none' as const, fetchLiveModels: async () => { providerCalls++; throw new Error('unexpected provider call'); } };
  const provider = kind === 'ollama' ? new OllamaProvider({ ...options, nativeFetch: async () => { providerCalls++; throw new Error('unexpected native call'); } }) : new OpenAICompatProvider(options);
  if (kind === 'openai-compatible') {
    const inherited = Object.create(Object.getPrototypeOf(provider));
    Object.defineProperty(inherited, 'models', { get() { inheritedModelsReads++; throw new Error('inherited models must remain unread'); } });
    Object.setPrototypeOf(provider, inherited);
  }
  record(f.providerRegistry).listProviders = () => [provider];
  const result = body(await f.tool.execute(routeArgs));
  expect(result.readiness).toMatchObject({ score: 100, outcome: 'ready' });
  expect(record(record(fake.requests[0]!.state).provider).baseURL).toBe(options.baseURL);
  expect(JSON.stringify(screening.calls)).not.toContain(secret); expect(JSON.stringify(fake.requests)).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain(secret); expect(providerCalls).toBe(0); expect(inheritedModelsReads).toBe(0); expect(f.effects).toEqual([]);
});

for (const phase of ['reading-source', 'final-projector'] as const) test.each(['port', 'model', 'ask', 'recorder', 'battery'] as const)(`${phase} release fences %s swap before a ready result can publish`, async changed => {
  const paused = pauseSourceRelease(ordinaryResearchOwner(), source => phase === 'reading-source'
    ? source.includes('"subject"') && source.includes('"measuredLatency"')
    : source.includes('"action":"route"') && !source.includes('"invocation"'));
  const f = fixture(paused.owner); const fake = readings(); const port: JudgmentPort = { ...fake.port }; installJudgmentPort(port);
  let delivered = 0;
  const pending = f.tool.execute(routeArgs).then(result => { delivered++; return result; });
  await paused.wait.started;
  if (changed === 'port') installJudgmentPort(readings().port);
  if (changed === 'model') record(port).model = 'replacement-model';
  if (changed === 'ask') port.ask = async request => fake.port.ask(request);
  if (changed === 'recorder') record(port).recorder = {};
  if (changed === 'battery') {
    const get = routingRegistry.get;
    routingRegistry.get = name => name === routeReadiness.name ? { ...routeReadiness } : get.call(routingRegistry, name);
    restores.push(() => { routingRegistry.get = get; });
  }
  paused.wait.release(); await expect(pending).rejects.toThrow();
  expect(delivered).toBe(0); expect(paused.counts.selected).toBe(1); expect(f.effects).toEqual([]);
});

test.each(['method', 'accessor'] as const)('late actual-provider isConfigured %s replacement is fenced before its side effects', async kind => {
  const f = fixture(); const fake = readings(); const wait = suspended();
  const provider = new OpenAICompatProvider({ name: 'ollama-local', baseURL: 'https://inference.example.invalid/v1', apiKey: 'synthetic-provider-key',
    defaultModel: 'opaque-model', models: ['opaque-model'], modelListing: 'none' });
  record(f.providerRegistry).listProviders = () => [provider];
  let touched = 0, delivered = 0;
  installJudgmentPort({ ...fake.port, ask: async request => { wait.start(); await wait.gate; return fake.port.ask(request); } });
  const pending = f.tool.execute(routeArgs).then(result => { delivered++; return result; });
  await wait.started;
  if (kind === 'method') record(provider).isConfigured = () => { touched++; return true; };
  else Object.defineProperty(provider, 'isConfigured', { get() { touched++; return () => true; } });
  wait.release(); await expect(pending).rejects.toThrow(); expect(touched).toBe(0); expect(delivered).toBe(0); expect(f.effects).toEqual([]);
});

test('late actual-provider equal-metadata object replacement is fenced before replacement isConfigured runs', async () => {
  const f = fixture(); const fake = readings(); const wait = suspended(); let touched = 0, delivered = 0;
  const options = { name: 'ollama-local', baseURL: 'https://inference.example.invalid/v1', apiKey: 'synthetic-provider-key',
    defaultModel: 'opaque-model', models: ['opaque-model'], modelListing: 'none' as const };
  const original = new OpenAICompatProvider(options), replacement = new OpenAICompatProvider(options);
  const adapters = [original]; record(f.providerRegistry).listProviders = () => adapters;
  replacement.isConfigured = () => { touched++; return true; };
  installJudgmentPort({ ...fake.port, ask: async request => { wait.start(); await wait.gate; return fake.port.ask(request); } });
  const pending = f.tool.execute(routeArgs).then(result => { delivered++; return result; });
  await wait.started;
  expect(replacement).not.toBe(original); expect(replacement.name).toBe(original.name);
  expect(record(replacement).baseURL).toBe(record(original).baseURL);
  adapters[0] = replacement;
  wait.release(); await expect(pending).rejects.toThrow();
  expect(touched).toBe(0); expect(delivered).toBe(0); expect(f.effects).toEqual([]);
});

test.each(['settled', 'rejected'] as const)('a later call may reuse original args after an earlier %s invocation retires its backend guards', async earlier => {
  const f = fixture(); const args = { ...routeArgs };
  if (earlier === 'settled') {
    installJudgmentPort(readings({ route: 0 }).port);
    expect(body(await f.tool.execute(args)).readinessScore).toBe(0);
  } else {
    installJudgmentPort({ model: 'synthetic', ask: async () => { throw new JudgmentError('rejected', 'synthetic rejection'); } });
    await expect(f.tool.execute(args)).rejects.toThrow();
  }
  const current = readings({ route: 4 }); installJudgmentPort(current.port);
  expect(body(await f.tool.execute(args)).readinessScore).toBe(100);
  expect(current.requests).toHaveLength(1); expect(f.effects).toEqual([]);
});

test('multi-model source above 40k screens every complete entry before exact-route judgment', async () => {
  const screening = researchScreeningFixture(); const f = fixture(screening.owner);
  const markers = Array.from({ length: 6 }, (_, index) => `complete-entry-${index}:` + 'x'.repeat(12_000) + `:end-entry-${index}`);
  f.models[0]!.metadata = { complete: markers[0] };
  for (let index = 1; index < markers.length; index++) f.models.push({ ...f.models[0], registryKey: `other:model-${index}`, modelId: `model-${index}`, metadata: { complete: markers[index] } });
  expect(JSON.stringify(f.models).length).toBeGreaterThan(SOURCE_SCREENING_LIMITS.characters);
  const fake = readings(); installJudgmentPort({ ...fake.port, ask: async request => {
    const screened = JSON.stringify(proposals(screening.calls));
    for (const marker of markers) expect(screened).toContain(marker);
    return fake.port.ask(request);
  } });
  const result = body(await f.tool.execute(routeArgs));
  expect(result.readiness).toMatchObject({ score: 100, outcome: 'ready' }); expect(fake.requests).toHaveLength(1);
  expect(proposals(screening.calls).length).toBeGreaterThan(2); expect(f.effects).toEqual([]);
});

test('sensitive semantic content in a later model batch blocks judgment and releases every captured handle', async () => {
  const sensitive = 'synthetic-sensitive-later-batch';
  const screening = researchScreeningFixture({ spans: exactSensitiveSpans([sensitive]) });
  const active = new Set<object>(); let captured = 0, released = 0;
  const owner: ProtectedSourceOwner = { ...screening.owner,
    capture(parts) { const handle = screening.owner.capture(parts); captured++; active.add(handle); return handle; },
    async release(handle) { released++; active.delete(handle); await screening.owner.release(handle); },
  };
  const f = fixture(owner); const fake = readings(); installJudgmentPort(fake.port);
  f.models[0]!.metadata = { complete: 'x'.repeat(12_000) };
  for (let index = 1; index < 6; index++) f.models.push({ ...f.models[0], registryKey: `other:model-${index}`, modelId: `model-${index}`,
    metadata: { complete: 'x'.repeat(12_000) + (index === 5 ? sensitive : `ordinary-${index}`) } });
  await expect(f.tool.execute(routeArgs)).rejects.toThrow();
  expect(JSON.stringify(proposals(screening.calls))).toContain(sensitive);
  expect(captured).toBeGreaterThan(2); expect(released).toBe(captured); expect(active.size).toBe(0);
  expect(fake.requests).toHaveLength(0); expect(f.effects).toEqual([]);
});

test.each(['ordinary', 'credential'] as const)('original model array extraMetadata with %s content is refused before source transport', async kind => {
  const screening = researchScreeningFixture(); const f = fixture(screening.owner); const fake = readings(); installJudgmentPort(fake.port);
  const marker = kind === 'credential' ? 'Bearer synthetic-array-credential' : 'ordinary-array-semantic-note';
  record(f.models).extraMetadata = kind === 'credential' ? { authorization: marker } : { note: marker };
  await expect(withModelReadingContext(f.context, routeArgs, modelReadingOptions(f.context, f.registry), async () => {})).rejects.toThrow();
  expect(screening.calls).toHaveLength(0); expect(fake.requests).toHaveLength(0);
  await expect(f.tool.execute(routeArgs)).rejects.toThrow();
  expect(JSON.stringify(screening.calls)).not.toContain(marker); expect(fake.requests).toHaveLength(0); expect(f.effects).toEqual([]);
});

test.each(['enumerable', 'hidden'] as const)('late %s model array extraMetadata mutation holds result even for ordinary text', async kind => {
  const f = fixture(); const fake = readings(); const wait = suspended(); let delivered = 0;
  installJudgmentPort({ ...fake.port, ask: async request => { wait.start(); await wait.gate; return fake.port.ask(request); } });
  const pending = f.tool.execute(routeArgs).then(result => { delivered++; return result; });
  await wait.started;
  Object.defineProperty(f.models, 'extraMetadata', { value: 'ordinary-late-array-note', enumerable: kind === 'enumerable' });
  wait.release(); await expect(pending).rejects.toThrow(); expect(delivered).toBe(0); expect(f.effects).toEqual([]);
});

test('a small sparse models array is refused rather than silently converted into null entries', async () => {
  const screening = researchScreeningFixture(); const f = fixture(screening.owner); const fake = readings(); installJudgmentPort(fake.port);
  f.models.length = 2;
  await expect(withModelReadingContext(f.context, routeArgs, modelReadingOptions(f.context, f.registry), async () => {})).rejects.toThrow();
  expect(screening.calls).toHaveLength(0); expect(fake.requests).toHaveLength(0);
});

test('registered final original-invocation release rechecks consumed admission before publishing readiness', async () => {
  let revoked = false;
  const reader = { getAutonomousSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} }, autoApprove: revoked, directory: '/synthetic/readiness' }),
    isAutoApproveEnabled: () => revoked, getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }), getWorkingDirectory: () => '/synthetic/readiness' } as PermissionConfigReader;
  const manager = new PermissionManager(undefined, reader, new PolicyRuntimeState());
  const paused = pauseSourceRelease(ordinaryResearchOwner(), source => source.includes('"action":"route"') && !source.includes('"invocation"'));
  const f = fixture(paused.owner, new ToolRegistry(manager)); registerAgentModelsTool(f.registry, f.commands, f.context);
  const fake = readings(); using log = new SqliteDecisionLog(':memory:'); installJudgmentPort(withDecisionLog(fake.port, log));
  const call = await f.registry.prepareCall('final-release-readiness', 'models', { ...routeArgs });
  const admission = await manager.admitAutonomous(call.callId, 'models', call.args, { sourceOf: () => ({ goal: 'Inspect synthetic readiness', criteria: ['Read only synthetic facts'] }),
    schemaRevision: call.schemaRevision, preparedCall: { registry: f.registry, call } });
  expect(admission.result.approved).toBe(true);
  let delivered = 0;
  const pending = f.registry.executePrepared(call, admission).then(result => { delivered++; return result; });
  await paused.wait.started; revoked = true; paused.wait.release();
  await expect(pending).rejects.toThrow(); expect(delivered).toBe(0); expect(paused.counts.selected).toBe(1); expect(f.effects).toEqual([]);
});

test.each(['model', 'ask', 'recorder'] as const)('late backend %s accessor replacement is rejected without invoking it', async field => {
  const f = fixture(); const fake = readings(); const wait = suspended(); let touched = 0, delivered = 0;
  const port: JudgmentPort = { ...fake.port, ask: async request => { wait.start(); await wait.gate; return fake.port.ask(request); } };
  installJudgmentPort(port);
  const original = record(port)[field];
  const pending = f.tool.execute(routeArgs).then(result => { delivered++; return result; });
  await wait.started; Object.defineProperty(port, field, { get() { touched++; return original; } }); wait.release();
  await expect(pending).rejects.toThrow(); expect(touched).toBe(0); expect(delivered).toBe(0); expect(f.effects).toEqual([]);
});

test('late backend prototype-proxy replacement is rejected without any traps', async () => {
  const f = fixture(); const fake = readings(); const wait = suspended(); let touched = 0, delivered = 0;
  const port: JudgmentPort = { ...fake.port, ask: async request => { wait.start(); await wait.gate; return fake.port.ask(request); } };
  installJudgmentPort(port);
  const pending = f.tool.execute(routeArgs).then(result => { delivered++; return result; });
  await wait.started;
  Object.setPrototypeOf(port, new Proxy(Object.prototype, { get() { touched++; return undefined; }, getPrototypeOf() { touched++; return null; }, getOwnPropertyDescriptor() { touched++; return undefined; } }));
  wait.release(); await expect(pending).rejects.toThrow(); expect(touched).toBe(0); expect(delivered).toBe(0); expect(f.effects).toEqual([]);
});

test('unchanged registered admission survives final release and publishes recorded readiness', async () => {
  const reader = { getAutonomousSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} }, autoApprove: false, directory: '/synthetic/readiness' }),
    isAutoApproveEnabled: () => false, getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }), getWorkingDirectory: () => '/synthetic/readiness' } as PermissionConfigReader;
  const manager = new PermissionManager(undefined, reader, new PolicyRuntimeState());
  const f = fixture(ordinaryResearchOwner(), new ToolRegistry(manager)); registerAgentModelsTool(f.registry, f.commands, f.context);
  const fake = readings(); using log = new SqliteDecisionLog(':memory:'); installJudgmentPort(withDecisionLog(fake.port, log));
  const call = await f.registry.prepareCall('positive-readiness', 'models', { ...routeArgs });
  const admission = await manager.admitAutonomous(call.callId, 'models', call.args, { sourceOf: () => ({ goal: 'Inspect synthetic readiness', criteria: ['Read only synthetic facts'] }),
    schemaRevision: call.schemaRevision, preparedCall: { registry: f.registry, call } });
  expect(admission.result.approved).toBe(true);
  const result = body(await f.registry.executePrepared(call, admission));
  expect(result.readiness).toMatchObject({ score: 100, outcome: 'ready' });
  expect(typeof record(result.readiness).decisionId).toBe('string'); expect(f.effects).toEqual([]);
});

for (const ingress of ['prepare', 'execute'] as const) test.each(['ordinary', 'credential'] as const)(`registered ${ingress} rejects hidden original %s data before product projection or source transport`, async kind => {
  const screening = researchScreeningFixture(); const f = fixture(screening.owner); const fake = readings(); installJudgmentPort(fake.port);
  const projector = createHarnessCatalogInputProjector(f.registry, undefined, isModelsReadinessCall, f.context); let projectionCalls = 0;
  f.registry.register(f.tool, { inputProjection: { project(request) { projectionCalls++; return projector.project(request); } } });
  const args = { ...routeArgs };
  Object.defineProperty(args, 'undisplayed', { enumerable: false, value: kind === 'credential' ? { authorization: 'Bearer synthetic-hidden-registered-key' } : { note: 'ordinary hidden semantic source' } });
  if (ingress === 'prepare') await expect(f.registry.prepareCall('hidden-registered-readiness', 'models', args)).rejects.toThrow();
  else await expect(f.registry.execute('hidden-registered-readiness', 'models', args)).rejects.toThrow();
  expect(projectionCalls).toBe(0); expect(screening.calls).toHaveLength(0); expect(fake.requests).toHaveLength(0); expect(f.effects).toEqual([]);
});

test('status never substitutes another provider current model just because model ids match', async () => {
  const f = fixture(); const actualRoute = 'other-host:opaque-model';
  const current: Json = { ...f.models[0], registryKey: actualRoute, providerId: 'other-host', contextWindow: 8192 };
  f.providerApi.getCurrentModel = async () => current;
  record(f.context.session.runtime).model = actualRoute; record(f.context.session.runtime).provider = 'other-host';
  f.providers.push({ id: 'other-host', baseUrl: 'https://other.example.invalid/v1', hosting: 'Third-party cloud', isConfigured: true, isAvailable: true });
  f.health.routes.push({ ...f.health.routes[0], providerId: 'other-host', modelRouteId: actualRoute });
  installJudgmentPort(readings().port);
  const output = body(await f.tool.execute({ action: 'status', includeParameters: true }));
  expect(record(record(output.current).currentModel)).toMatchObject({ registryKey: actualRoute, providerId: 'other-host', contextWindow: 8192, current: true });
  expect(f.effects).toEqual([]);
});

test('explicit current-route unavailable and unconfigured facts survive a contradictory selectable catalog', async () => {
  const f = fixture(); const current: Json = { ...f.models[0], available: false, isConfigured: false };
  f.providerApi.getCurrentModel = async () => current;
  installJudgmentPort(readings().port);
  const output = body(await f.tool.execute({ action: 'status', includeParameters: true }));
  const selected = record(record(output.current).currentModel);
  expect(selected).toMatchObject({ registryKey: routeId, available: false, configured: false });
  expect(selected.readiness).toMatchObject({ score: null, outcome: 'unavailable' });
  expect(f.models[0]).toMatchObject({ available: true, isConfigured: true }); expect(f.effects).toEqual([]);
});

test('read-model snapshot proxy is rejected before Promise detection invokes any traps', async () => {
  const screening = researchScreeningFixture(); const f = fixture(screening.owner); const fake = readings(); installJudgmentPort(fake.port);
  let touched = 0, consumed = 0;
  const snapshot = new Proxy(f.health, { get() { touched++; return undefined; }, getPrototypeOf() { touched++; return Object.prototype; },
    ownKeys() { touched++; return []; } });
  record(record(record(f.context).platform).readModels).providerHealth = { getSnapshot: () => snapshot };
  await expect((async () => withModelReadingContext(f.context, routeArgs, modelReadingOptions(f.context, f.registry), async () => { consumed++; }))()).rejects.toThrow();
  expect(touched).toBe(0); expect(consumed).toBe(0); expect(screening.calls).toHaveLength(0); expect(fake.requests).toHaveLength(0);
});

for (const method of ['recordReadings', 'recordAction'] as const) test.each(['method', 'accessor'] as const)(`late same-object recorder ${method} %s replacement is refused without effects`, async kind => {
  const f = fixture(); const fake = readings(); const wait = suspended(); let touched = 0, delivered = 0;
  using log = new SqliteDecisionLog(':memory:');
  const recorded = withDecisionLog(fake.port, log);
  installJudgmentPort({ ...recorded, ask: async request => { wait.start(); await wait.gate; return recorded.ask(request); } });
  const pending = f.tool.execute(routeArgs).then(result => { delivered++; return result; });
  await wait.started;
  const replacement = () => { touched++; };
  Object.defineProperty(recorded.recorder!, method, kind === 'method' ? { value: replacement } : { get() { touched++; return replacement; } });
  wait.release(); await expect(pending).rejects.toThrow();
  expect(touched).toBe(0); expect(delivered).toBe(0); expect(f.effects).toEqual([]);
});

test('reentrant cancellation inside source capture releases its returned handle exactly once', async () => {
  const original = ordinaryResearchOwner(); const controller = new AbortController();
  const active = new Set<object>(); let captured = 0, released = 0, screened = 0, consumed = 0;
  const owner: ProtectedSourceOwner = { ...original,
    capture(parts) { const handle = original.capture(parts); captured++; active.add(handle); controller.abort(); return handle; },
    screen(handle) { screened++; return original.screen(handle); },
    async release(handle) { released++; active.delete(handle); await original.release(handle); },
  };
  const fake = readings(); installJudgmentPort(fake.port);
  await expect(withModelReadingSource({ ordinary: 'fixture' }, { sourceOwner: owner, signal: controller.signal }, async () => { consumed++; })).rejects.toThrow();
  expect(captured).toBe(1); expect(released).toBe(1); expect(active.size).toBe(0); expect(screened).toBe(0); expect(consumed).toBe(0); expect(fake.requests).toHaveLength(0);
});

test('late shared source DAG is bounded while rechecking already-screened bytes', async () => {
  const wait = suspended(); const source: Json = { ordinary: 'fixture' }; let delivered = 0;
  const fake = readings(); installJudgmentPort(fake.port);
  const pending = withModelReadingSource(source, { sourceOwner: ordinaryResearchOwner() }, async () => { wait.start(); await wait.gate; })
    .then(result => { delivered++; return result; });
  await wait.started;
  let added: Json = { ordinary: 'leaf' };
  for (let depth = 0; depth < 30; depth++) added = { left: added, right: added };
  source.late = added;
  const started = performance.now(); wait.release();
  await expect(pending).rejects.toThrow(); expect(performance.now() - started).toBeLessThan(2_000);
  expect(delivered).toBe(0); expect(fake.requests).toHaveLength(0);
});

test.each(['unchanged', 'incarnation', 'method', 'accessor'] as const)('raw readiness guards supported config incarnation against %s without reading config secrets', async kind => {
  const f = fixture(); const fake = readings(); const wait = suspended(); let incarnation = 1, touched = 0, delivered = 0;
  const manager = record(record(f.context).platform).configManager;
  record(manager).getAutonomousPermissionSnapshot = () => ({ incarnation });
  Object.defineProperty(f.config, 'credentials', { get() { touched++; throw new Error('unrelated config secrets must remain unread'); } });
  installJudgmentPort({ ...fake.port, ask: async request => { wait.start(); await wait.gate; return fake.port.ask(request); } });
  const pending = f.tool.execute(routeArgs).then(result => { delivered++; return result; });
  await wait.started;
  if (kind === 'incarnation') incarnation += 2; // Same config values after an intervening change still retire the old capability.
  if (kind === 'method') record(manager).getAutonomousPermissionSnapshot = () => { touched++; return { incarnation }; };
  if (kind === 'accessor') Object.defineProperty(manager, 'getAutonomousPermissionSnapshot', { get() { touched++; return () => ({ incarnation }); } });
  wait.release();
  if (kind === 'unchanged') { expect(body(await pending).readiness).toMatchObject({ score: 100, outcome: 'ready' }); expect(delivered).toBe(1); }
  else { await expect(pending).rejects.toThrow(); expect(delivered).toBe(0); }
  expect(touched).toBe(0); expect(f.effects).toEqual([]);
});
