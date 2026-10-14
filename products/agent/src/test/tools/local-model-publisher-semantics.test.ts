import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { EntryType, JudgmentPort, Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { CommandContext } from '../../input/command-registry.ts';
import { localStackFor, normalizeLocalBaseUrl } from '../../tools/agent-harness-local-model-url.ts';
import { localModelDetection, localModelServerFacts, localModelServerEndpoints, localModelServerHealthMap, readLocalModelDetection } from '../../tools/agent-harness-local-model-endpoints.ts';
import { readLocalServingBoolean, readLocalServingStatus, readLocalResourcePressure, readLocalServingSchemaStatus } from '../../tools/agent-harness-local-model-readings.ts';
import { withModelReadingSource } from '../../tools/agent-harness-model-reading-source.ts';
import { captureLocalModelRegistry } from '../../tools/agent-harness-local-model-endpoints.ts';
import { runLocalModelServerSmoke } from '../../tools/agent-harness-local-model-smoke.ts';
import { readLocalServerIdentity, localServerIdentity, localServerIdentityDefinition, localServingStatus, localResourcePressure, localServingSchemaStatus, routingRegistry } from '@goodvibes-jev/engine/sdk/platform/routing';
import { booleanValue } from '@goodvibes-jev/engine/sdk/platform/tools';
import { gateJudgmentRegistry } from '@goodvibes-jev/engine/sdk/platform/gate';
import { ProviderRegistry, OpenAICompatProvider } from '@goodvibes-jev/engine/sdk/platform/providers';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner, researchScreeningFixture } from '../helpers/research-screening.ts';

afterAll(cleanupResearchScreeningFixtures);
const nativeRoots: string[] = [];
afterAll(() => { for (const root of nativeRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected authored fixture record.');
  return Object.fromEntries(Object.entries(value));
}

function readings(overrides: {
  stack?: 'ollama' | 'llama.cpp' | 'vllm' | 'openai-compatible' | 'not-local' | 'llamacpp';
  status?: 'ready' | 'blocked' | 'attention' | 'unknown';
  pressure?: 'low' | 'moderate' | 'high' | 'unknown';
  boolean?: 'true' | 'false' | 'neither'; certified?: boolean; certificationProbability?: number; confidence?: number;
} = {}) {
  return fakePort((name: string, question: Question, state: EntryType) => {
    if (name === 'kind') return choiceAnswer(question, 'other', 0.999);
    if (name === 'identifying' || name === 'lineHasCredential' || name === 'spanIsCredential' || name === 'credentialRemains') return noulAnswer(0.001);
    const confidence = overrides.confidence ?? 0.999;
    if (name === 'route') {
      const input = record(state);
      return choiceAnswer(question, input.evidence_kind === 'probe' ? 'llamacpp' : overrides.stack === 'llama.cpp' ? 'llamacpp' : overrides.stack ?? 'llamacpp', confidence);
    }
    if (name === 'status') return choiceAnswer(question, overrides.status ?? 'blocked', confidence);
    if (name === 'pressure') return choiceAnswer(question, overrides.pressure ?? 'low', confidence);
    if (name === 'boolean_value') return choiceAnswer(question, overrides.boolean ?? 'false', confidence);
    if (name === 'certified') return noulAnswer(overrides.certificationProbability ?? (overrides.certified ? 0.999 : 0.001));
    throw new Error(`Unexpected local model fixture question ${name}`);
  });
}

function fixture() {
  const provider = { id: 'synthetic-local', baseURL: 'http://127.0.0.1:8080/v1',
    description: 'Synthetic local llama-server', undisplayedTail: 'Complete original provider context' };
  const model = { providerId: 'synthetic-local', registryKey: 'synthetic-local:synthetic-model', modelId: 'synthetic-model',
    baseURL: 'http://127.0.0.1:8080/v1', description: 'Synthetic llama-server route' };
  const diagnostic = { providerId: 'synthetic-local', baseUrl: 'http://127.0.0.1:8080/v1', stack: 'llama.cpp',
    status: 'healthy', loadedModels: ['synthetic-model'], toolSupport: 'supported', resourcePressure: 'critical',
    schemaStatus: 'certified', summary: 'Synthetic publisher observation', undisplayedTail: 'Complete original diagnostic context' } satisfies Record<string, unknown>;
  const snapshot = { servers: [diagnostic] };
  const producer: { getSnapshot(): unknown } = { getSnapshot() { if (this !== producer) throw new Error('Snapshot receiver lost.'); return snapshot; } };
  const providers = [provider], models = [model];
  const registry = { listProviders: () => providers, listModels: () => models };
  const api = { listProviderIds: () => ['synthetic-local'] };
  const platform = { readModels: { models: { servingDiagnostics: producer } } };
  const context = { provider: { providerRegistry: registry }, clients: { providerApi: api }, platform } as unknown as CommandContext;
  return { context, provider, model, diagnostic, snapshot, producer, registry, api, platform, providers, models };
}

/** Keep the native registry's private model state and original list methods,
 * while registering only the adapter authored for this fixture. The base
 * constructor otherwise adds the entire hosted provider/model catalog before
 * the one-provider smoke can resolve its exact bound-address target. */
class NativeFixtureProviderRegistry extends ProviderRegistry {
  // Derived fields initialize after the base constructor. Only its automatic
  // builtin registrations are skipped; subsequent registrations stay native.
  private fixtureReady = true;
  override register(provider: Parameters<ProviderRegistry['register']>[0]): void {
    if (this.fixtureReady) super.register(provider);
  }
}

function nativeRegistryFixture() {
  const root = mkdtempSync(join(tmpdir(), 'local-model-native-registry-')); nativeRoots.push(root);
  type Options = ConstructorParameters<typeof ProviderRegistry>[0];
  const registry = new NativeFixtureProviderRegistry({
    configManager: { get: () => undefined, getCategory: () => ({}), getControlPlaneConfigDir: () => root } as Options['configManager'],
    subscriptionManager: { get: () => null, getPending: () => null, saveSubscription() { throw new Error('Unexpected subscription write in native local registry fixture.'); }, resolveAccessToken: async () => null } satisfies Options['subscriptionManager'],
    capabilityRegistry: { getCapability: () => ({}), getRouteExplanation: () => ({ accepted: true }), invalidate: () => {} } as unknown as Options['capabilityRegistry'],
    cacheHitTracker: { record: () => {} } as unknown as Options['cacheHitTracker'],
    favoritesStore: { load: async () => ({ pinned: [], history: [] }) } as Options['favoritesStore'],
    benchmarkStore: { getBenchmarks: () => undefined, getKnownBenchmarks: () => undefined, readBenchmarks: () => undefined,
      getTopBenchmarkModelIds: () => [], benchmarksSettled: () => Promise.resolve() } as unknown as Options['benchmarkStore'],
    secretsManager: {} as Options['secretsManager'], serviceRegistry: {} as Options['serviceRegistry'], featureFlags: null, runtimeBus: null,
  });
  const adapter = new OpenAICompatProvider({ name: 'synthetic-native-local', baseURL: 'http://0.0.0.0:19876/v1',
    apiKey: 'synthetic-adapter-private-value', defaultModel: 'synthetic-native-model', models: ['synthetic-native-model'],
    modelListing: 'none', authConfigured: true });
  registry.register(adapter);
  const context = { provider: { providerRegistry: registry }, clients: {}, platform: {} } as unknown as CommandContext;
  return { registry, adapter, context };
}

type PolicyKind = 'boolean' | 'status' | 'pressure' | 'schema' | 'identity';
function policyCase(kind: PolicyKind) {
  const sourceOwner = ordinaryResearchOwner(), diagnostic = fixture().diagnostic;
  switch (kind) {
    case 'boolean': return { decision: booleanValue, registry: gateJudgmentRegistry, method: 'run', question: 'boolean_value', confidence: 0.8,
      bandOwner: booleanValue.items.boolean_value, bandKey: 'band', band: booleanValue.items.boolean_value.band,
      invoke: () => readLocalServingBoolean('supported', 'toolSupport', diagnostic, { sourceOwner }) };
    case 'status': return { decision: localServingStatus, registry: routingRegistry, method: 'run', question: 'status', confidence: 0.8,
      bandOwner: localServingStatus.items.status, bandKey: 'band', band: localServingStatus.items.status.band,
      invoke: () => readLocalServingStatus('healthy', diagnostic, { sourceOwner }) };
    case 'pressure': return { decision: localResourcePressure, registry: routingRegistry, method: 'run', question: 'pressure', confidence: 0.8,
      bandOwner: localResourcePressure.items.pressure, bandKey: 'band', band: localResourcePressure.items.pressure.band,
      invoke: () => readLocalResourcePressure('critical', diagnostic, { sourceOwner }) };
    case 'schema': return { decision: localServingSchemaStatus, registry: routingRegistry, method: 'run', question: 'certified', confidence: 0.8,
      bandOwner: localServingSchemaStatus.items.certified.band, bandKey: 'yes', band: localServingSchemaStatus.items.certified.band.yes,
      invoke: () => readLocalServingSchemaStatus('certified', diagnostic, { sourceOwner }) };
    case 'identity': return { decision: localServerIdentity, registry: routingRegistry, method: 'route', question: 'route', confidence: 0.575,
      bandOwner: localServerIdentityDefinition, bandKey: 'band', band: localServerIdentityDefinition.band,
      invoke: () => localStackFor('Synthetic local llama-server', { sourceOwner }, diagnostic) };
  }
}

describe('Local model publisher wording and native discovery', () => {
  test('native boolean values and exact JSON literals need no reader or source owner', async () => {
    const port = readings(); installJudgmentPort(port.port);
    for (const [value, expected] of [[true, true], [false, false], ['true', true], ['false', false], [1, null]] as const)
      expect(await readLocalServingBoolean(value, 'supportsTools', { value }, {})).toBe(expected);
    expect(port.requests).toHaveLength(0);
  });

  test('an asynchronous ownership callback cannot authorize even a native literal', async () => {
    const port = readings(); installJudgmentPort(port.port);
    await expect(readLocalServingBoolean(true, 'supportsTools', { value: true }, { assertCurrent: async () => {} })).rejects.toThrow();
    expect(port.requests).toHaveLength(0);
  });

  test('a non-void ownership result holds without invoking a borrowed then accessor', async () => {
    const port = readings(); installJudgmentPort(port.port);
    let thenReads = 0;
    const foreign = Object.defineProperty({}, 'then', { get() { thenReads++; throw new Error('Borrowed then accessor invoked.'); } });
    await expect(readLocalServingBoolean(true, 'supportsTools', { value: true }, { assertCurrent: () => foreign })).rejects.toThrow();
    expect(thenReads).toBe(0);
    expect(port.requests).toHaveLength(0);
  });

  test('the actual ProviderRegistry and native adapter yield owned metadata while runtime credentials remain local', () => {
    const f = nativeRegistryFixture(), port = readings(); installJudgmentPort(port.port);
    const captured = captureLocalModelRegistry(f.context);
    captured.assertCurrent();
    const provider = captured.data.providers.map(record).find(value => value.name === f.adapter.name);
    expect(provider?.baseURL).toBe('http://0.0.0.0:19876/v1');
    expect(provider?.isConfigured).toBe(true);
    expect(f.registry.listProviders()).toContain(f.adapter);
    expect(JSON.stringify(captured.data)).not.toContain('synthetic-adapter-private-value');
    expect(Object.hasOwn(provider ?? {}, 'apiKey')).toBe(false);
    expect(port.requests).toHaveLength(0);
  });

  test('direct smoke accepts real native provider metadata and preserves the existing bind-address refusal without a server probe', async () => {
    const f = nativeRegistryFixture(), port = readings({ stack: 'openai-compatible' }); installJudgmentPort(port.port);
    const result = await runLocalModelServerSmoke(f.context, { modelRouteId: 'http://0.0.0.0:19876/v1' }, { sourceOwner: ordinaryResearchOwner() });
    expect(result.status).toBe('blocked');
    expect(result.endpointCount).toBe(1);
    const endpoint = record((result.endpoints as readonly unknown[])[0]);
    expect(endpoint.networkScope).toBe('bind-all-host');
    expect(JSON.stringify(port.requests)).not.toContain('synthetic-adapter-private-value');
  });

  test.each((['providers', 'models', 'provider IDs'] as const).flatMap(slot =>
    (['indexed accessor', 'hidden field', 'borrowed iterator'] as const).map(layout => ({ slot, layout }))))
  ('$slot with $layout is refused before semantic dispatch or a smoke probe', async ({ slot, layout }) => {
    const f = fixture(), port = readings(); installJudgmentPort(port.port);
    const arrays = { providers: [f.provider], models: [f.model], providerIds: ['synthetic-local'] };
    f.registry.listProviders = () => arrays.providers;
    f.registry.listModels = () => arrays.models;
    f.api.listProviderIds = () => arrays.providerIds;
    const original: unknown[] = slot === 'providers' ? arrays.providers : slot === 'models' ? arrays.models : arrays.providerIds;
    let borrowedInvocations = 0, probes = 0;
    if (layout === 'indexed accessor') Object.defineProperty(original, '0', { configurable: true, enumerable: true,
      get() { borrowedInvocations++; throw new Error('Borrowed array element getter invoked.'); } });
    else if (layout === 'hidden field') Object.defineProperty(original, 'undisplayedSource', {
      value: 'Complete hidden source must not be dropped by metadata projection.', configurable: true, enumerable: false });
    else Object.defineProperty(original, Symbol.iterator, { configurable: true,
      value() { borrowedInvocations++; throw new Error('Borrowed array iterator invoked.'); } });
    const nativeFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true,
      value() { probes++; throw new Error('Malformed source must not reach a server probe.'); } });
    try {
      await expect(runLocalModelServerSmoke(f.context, { modelRouteId: 'http://127.0.0.1:8080/v1' }, { sourceOwner: ordinaryResearchOwner() })).rejects.toThrow();
      expect(borrowedInvocations).toBe(0); expect(probes).toBe(0); expect(port.requests).toHaveLength(0);
    } finally { if (nativeFetch) Object.defineProperty(globalThis, 'fetch', nativeFetch); else Reflect.deleteProperty(globalThis, 'fetch'); }
  });

  test.each(['providers', 'models', 'provider IDs'] as const)('retained original %s array layout cannot acquire a hidden source after capture', slot => {
    const f = fixture(), providerIds = ['synthetic-local']; f.api.listProviderIds = () => providerIds;
    const captured = captureLocalModelRegistry(f.context); captured.assertCurrent();
    const original: unknown[] = slot === 'providers' ? f.providers : slot === 'models' ? f.models : providerIds;
    Object.defineProperty(original, 'undisplayedSource', { value: 'New hidden publisher source', enumerable: false });
    expect(() => captured.assertCurrent()).toThrow();
  });

  test.each(['method', 'metadata', 'registration'] as const)('retained native adapter ownership rejects actual %s retirement', mode => {
    const f = nativeRegistryFixture(), captured = captureLocalModelRegistry(f.context);
    if (mode === 'method') Object.defineProperty(f.adapter, 'isConfigured', { value: () => true, configurable: true });
    else if (mode === 'metadata') Object.defineProperty(f.adapter, 'baseURL', { value: 'http://127.0.0.1:29876/v1' });
    else f.registry.register(new OpenAICompatProvider({ name: f.adapter.name, baseURL: 'http://0.0.0.0:19876/v1',
      apiKey: 'different-synthetic-private-value', defaultModel: 'synthetic-native-model', models: ['synthetic-native-model'], modelListing: 'none', authConfigured: true }));
    expect(() => captured.assertCurrent()).toThrow();
  });

  test.each(['cancel', 'adapter method', 'adapter registration'] as const)('direct native smoke rejects pending %s retirement and drains its original transport', async mode => {
    const f = nativeRegistryFixture(), base = readings({ stack: 'openai-compatible' });
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const tails: Array<ReturnType<JudgmentPort['ask']>> = [];
    let waiting = false;
    const port: JudgmentPort = { model: base.port.model, ask(request) {
      const tail = (async () => { if (!waiting) { waiting = true; entered.resolve(); await release.promise; } return base.port.ask(request); })();
      tails.push(tail); return tail;
    } };
    installJudgmentPort(port);
    const cancel = new AbortController();
    const pending = runLocalModelServerSmoke(f.context, { modelRouteId: 'http://0.0.0.0:19876/v1' }, { signal: cancel.signal, sourceOwner: ordinaryResearchOwner() })
      .then(() => undefined, (error: unknown) => error);
    const timer = setTimeout(() => entered.reject(new Error('Native smoke control did not enter its reading.')), 2_000);
    try {
      await entered.promise;
      if (mode === 'cancel') cancel.abort();
      else if (mode === 'adapter method') Object.defineProperty(f.adapter, 'isConfigured', { value: () => true });
      else f.registry.register(new OpenAICompatProvider({ name: f.adapter.name, baseURL: 'http://0.0.0.0:19876/v1',
        apiKey: '', defaultModel: 'synthetic-native-model', models: ['synthetic-native-model'], modelListing: 'none', authConfigured: true }));
      release.resolve(); expect(await pending).toBeInstanceOf(Error);
      expect(JSON.stringify(base.requests)).not.toContain('synthetic-adapter-private-value');
    } finally { clearTimeout(timer); cancel.abort(); release.resolve(); await pending; await Promise.allSettled(tails); }
  });

  test.each(['boolean', 'detection', 'health'] as const)('retained %s guards survive legitimate nested source receipt cleanup', async mode => {
    const f = fixture(), port = readings(); installJudgmentPort(port.port);
    const guards: Array<() => void> = [];
    const options = { sourceOwner: ordinaryResearchOwner(), retainCurrent: (guard: () => void): void => { guards.push(guard); } };
    const result = await withModelReadingSource({ scope: 'synthetic outer inspection' }, options, async (_captured, scoped): Promise<unknown> => {
      if (mode === 'boolean') return readLocalServingBoolean('supported', 'toolSupport', f.diagnostic, scoped);
      if (mode === 'detection') return readLocalModelDetection(f.context, scoped);
      return localModelServerHealthMap(f.context, false, scoped);
    });
    expect(result).toBeDefined();
    expect(guards.length).toBeGreaterThan(0);
    expect(() => { for (const guard of guards) guard(); }).not.toThrow();
  });

  test('free capability words obey the canonical boolean reading instead of a synonym table', async () => {
    const port = readings({ boolean: 'false' }); installJudgmentPort(port.port);
    expect(await readLocalServingBoolean('supported', 'toolSupport', { toolSupport: 'supported', extra: 'original tail' }, { sourceOwner: ordinaryResearchOwner() })).toBe(false);
    expect(JSON.stringify(port.requests)).toContain('original tail');
    expect(port.requests.some(request => Object.hasOwn(request.questions, 'boolean_value'))).toBe(true);
  });

  test('numeric-looking free strings are not silently turned into booleans', async () => {
    const port = readings({ boolean: 'neither' }); installJudgmentPort(port.port);
    expect(await readLocalServingBoolean('1', 'toolSupport', { toolSupport: '1' }, { sourceOwner: ordinaryResearchOwner() })).toBeNull();
  });

  test('loaded models alone cannot prove a server is ready', async () => {
    const port = readings({ status: 'unknown' }); installJudgmentPort(port.port);
    expect(await readLocalServingStatus('', { loadedModels: ['synthetic-model'], loadedModelCount: 1 }, { sourceOwner: ordinaryResearchOwner() })).toBe('unknown');
  });

  test('status and pressure use the complete record and accept the canonical opposed choices', async () => {
    const port = readings({ status: 'blocked', pressure: 'low' }); installJudgmentPort(port.port);
    const source = { status: 'healthy', pressure: 'critical', description: 'Complete original opposed evidence' };
    const options = { sourceOwner: ordinaryResearchOwner() };
    expect(await readLocalServingStatus(source.status, source, options)).toBe('blocked');
    expect(await readLocalResourcePressure(source.pressure, source, options)).toBe('low');
    expect(JSON.stringify(port.requests)).toContain(source.description);
  });

  test('unsettled positive publisher readings retain unknown capability and readiness', async () => {
    const port = readings({ status: 'ready', pressure: 'low', boolean: 'true', certified: true, confidence: 0.5 }); installJudgmentPort(port.port);
    const options = { sourceOwner: ordinaryResearchOwner() };
    expect(await readLocalServingStatus('healthy', { status: 'healthy' }, options)).toBe('unknown');
    expect(await readLocalResourcePressure('normal', { pressure: 'normal' }, options)).toBe('unknown');
    expect(await readLocalServingBoolean('enabled', 'toolSupport', { toolSupport: 'enabled' }, options)).toBeNull();
    const uncertain = fakePort((name, question) => name === 'certified' ? noulAnswer(0.5) : choiceAnswer(question, 'other', 0.999));
    installJudgmentPort(uncertain.port);
    expect(await readLocalServingSchemaStatus('verified', { schemaStatus: 'verified' }, options)).toBe(false);
  });

  test('startup facts use native private URL grammar and defer server wording without any port', () => {
    const f = fixture(), port = fakePort(() => { throw new Error('Startup obtained a hosted reading.'); }); installJudgmentPort(port.port);
    const facts = localModelServerFacts(f.context, true), detection = localModelDetection(f.context);
    expect(facts.endpointCount).toBe(1);
    expect(facts.endpoints[0]?.stack).toBeNull();
    expect(detection.stacks).toEqual([]);
    expect(detection.modelRoutes).toEqual(['synthetic-local:synthetic-model']);
    expect(port.requests).toHaveLength(0);
    expect(normalizeLocalBaseUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080/v1');
    expect(normalizeLocalBaseUrl('https://public.example/v1')).toBeNull();
  });

  test('explicit diagnostic attachment awaits all canonical readings and preserves native endpoint/model identities', async () => {
    const f = fixture(), port = readings(); installJudgmentPort(port.port);
    const result = await localModelServerHealthMap(f.context, true, { sourceOwner: ordinaryResearchOwner() });
    const endpoint = result.endpoints[0], diagnostics = endpoint?.servingDiagnostics;
    expect(result.liveProbe).toBe('not-run');
    expect(result.daemonDiagnostics.matchedEndpointCount).toBe(1);
    expect(endpoint?.baseUrl).toBe('http://127.0.0.1:8080/v1');
    expect(endpoint?.modelRoutes).toEqual(['synthetic-local:synthetic-model']);
    expect(diagnostics?.status).toBe('blocked');
    expect(diagnostics?.resourcePressure).toBe('low');
    expect(diagnostics?.toolSupport).toBe(false);
    expect(diagnostics?.schemaStatus).toBe('legacy');
    expect(diagnostics?.loadedModels).toEqual(['synthetic-model']);
    const sent = JSON.stringify(port.requests);
    expect(sent).toContain(f.provider.undisplayedTail);
    expect(sent).toContain(f.diagnostic.undisplayedTail);
  });

  test.each([69, 70, 89, 90])('numeric pressure %i keeps the original deterministic bands and does not ask a word question', async percent => {
    const f = fixture(), port = readings(); installJudgmentPort(port.port);
    const { resourcePressure: _words, ...numeric } = f.diagnostic;
    const snapshot = { servers: [{ ...numeric, memoryUsagePercent: percent }] };
    f.producer.getSnapshot = function () { return snapshot; };
    const endpoints = await localModelServerEndpoints(f.context, true, { sourceOwner: ordinaryResearchOwner() });
    expect(endpoints[0]?.servingDiagnostics?.resourcePressure).toBe(percent >= 90 ? 'high' : percent >= 70 ? 'moderate' : 'low');
    expect(port.requests.some(request => Object.hasOwn(request.questions, 'pressure'))).toBe(false);
  });

  test('native Map diagnostics keep all publisher fields and their original keyed identity', async () => {
    const f = fixture(), port = readings(); installJudgmentPort(port.port);
    const snapshot = new Map([['native-diagnostic', f.diagnostic]]);
    f.producer.getSnapshot = function () { if (this !== f.producer) throw new Error('Native Map receiver lost.'); return snapshot; };
    const result = await localModelServerHealthMap(f.context, true, { sourceOwner: ordinaryResearchOwner() });
    expect(result.daemonDiagnostics.matchedEndpointCount).toBe(1);
    expect(result.endpoints[0]?.servingDiagnostics?.status).toBe('blocked');
    expect(JSON.stringify(port.requests)).toContain(f.diagnostic.undisplayedTail);
    expect(snapshot.get('native-diagnostic')).toBe(f.diagnostic);
  });

  test('registry dispatch excludes hosted Ollama and maps the canonical llama.cpp choice', async () => {
    const port = readings({ stack: 'not-local' }); installJudgmentPort(port.port);
    const options = { sourceOwner: ordinaryResearchOwner() };
    expect(await localStackFor('Ollama Cloud', options, { baseURL: 'https://cloud.example/v1', description: 'Hosted Ollama Cloud' })).toBeNull();
    const local = readings({ stack: 'llamacpp' }); installJudgmentPort(local.port);
    expect(await localStackFor('Local llama-server', options, { baseURL: 'http://127.0.0.1:8080/v1' })).toBe('llama.cpp');
    expect(local.requests).toHaveLength(1);
  });

  test('explicit registry detection uses full native original evidence and settled stack results', async () => {
    const f = fixture(), port = readings({ stack: 'vllm' }); installJudgmentPort(port.port);
    const detection = await readLocalModelDetection(f.context, { sourceOwner: ordinaryResearchOwner() });
    expect(detection.stacks).toEqual(['vllm']);
    expect(detection.providerIds).toEqual(['synthetic-local']);
    expect(detection.modelRoutes).toEqual(['synthetic-local:synthetic-model']);
    expect(JSON.stringify(port.requests)).toContain(f.provider.undisplayedTail);
  });

  test('a proxied native registry method is refused without invoking its apply trap', async () => {
    const f = fixture(), port = readings(); installJudgmentPort(port.port);
    let invocations = 0;
    f.registry.listProviders = new Proxy(f.registry.listProviders, { apply() { invocations++; return f.providers; } });
    await expect(readLocalModelDetection(f.context, { sourceOwner: ordinaryResearchOwner() })).rejects.toThrow('method unavailable');
    expect(invocations).toBe(0);
    expect(port.requests).toHaveLength(0);
  });

  test('a proxied native diagnostic method is refused without invoking its apply trap', async () => {
    const f = fixture(), port = readings(); installJudgmentPort(port.port);
    let invocations = 0;
    f.producer.getSnapshot = new Proxy(f.producer.getSnapshot, { apply() { invocations++; return f.snapshot; } });
    const result = await localModelServerHealthMap(f.context, true, { sourceOwner: ordinaryResearchOwner() });
    expect(result.daemonDiagnostics.status).toBe('read-model-error');
    expect(result.daemonDiagnostics.recordCount).toBe(0);
    expect(invocations).toBe(0);
  });

  test('the existing probe reader preserves its specific software route after registry support is added', async () => {
    const port = readings(); installJudgmentPort(port.port);
    expect(await readLocalServerIdentity({ port: 8081, headers: { server: 'llama.cpp' }, modelIds: ['synthetic-model'] }, 'synthetic.local-probe')).toBe('llamacpp');
  });

  test('a source owner that holds ordinary screening prevents semantic transport of a complete record', async () => {
    const port = readings(); installJudgmentPort(port.port);
    const source = researchScreeningFixture({ complete: 0 });
    await expect(localStackFor('Synthetic local server', { sourceOwner: source.owner }, { description: 'Synthetic local server', hiddenTail: 'Complete screened source' })).rejects.toThrow();
    expect(port.requests).toHaveLength(0);
  });

  test('borrowed snapshot accessors are refused without invocation', async () => {
    const f = fixture(); let invoked = 0;
    Object.defineProperty(f.producer, 'getSnapshot', { configurable: true, get() { invoked++; return () => f.snapshot; } });
    const port = readings(); installJudgmentPort(port.port);
    const result = await localModelServerHealthMap(f.context, true, { sourceOwner: ordinaryResearchOwner() });
    expect(result.daemonDiagnostics.status).toBe('read-model-error');
    expect(result.endpoints[0]?.servingDiagnostics).toBeUndefined();
    expect(invoked).toBe(0);
  });

  test.each(['cancel', 'source change', 'snapshot method', 'producer replacement', 'provider registration', 'port retirement', 'caller replacement'] as const)
  ('%s during a native reading prevents late diagnostic publication', async mode => {
    const f = fixture(), base = readings();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let waiting = false;
    const tails: Array<ReturnType<JudgmentPort['ask']>> = [];
    const port: JudgmentPort = { model: base.port.model, ask(request) {
      const tail = (async () => {
        if (!waiting && request.context?.battery === 'agent.local-model.serving-status') {
          waiting = true; entered.resolve(); await release.promise;
        }
        return base.port.ask(request);
      })();
      tails.push(tail); return tail;
    } };
    installJudgmentPort(port);
    const cancel = new AbortController(), options = { signal: cancel.signal, sourceOwner: ordinaryResearchOwner(), assertCurrent: () => {} };
    const pending = localModelServerHealthMap(f.context, true, options).then(() => undefined, (error: unknown) => error);
    const timer = setTimeout(() => entered.reject(new Error('Fixture did not enter a reading.')), 2_000);
    try {
      await entered.promise;
      if (mode === 'cancel') cancel.abort();
      else if (mode === 'source change') f.diagnostic.undisplayedTail = 'Changed undisplayed original';
      else if (mode === 'snapshot method') f.producer.getSnapshot = () => f.snapshot;
      else if (mode === 'producer replacement') f.platform.readModels.models.servingDiagnostics = { getSnapshot: () => f.snapshot };
      else if (mode === 'provider registration') f.providers[0] = { ...f.provider };
      else if (mode === 'port retirement') installJudgmentPort(readings().port);
      else options.assertCurrent = () => {};
      release.resolve();
      expect(await pending).toBeInstanceOf(Error);
    } finally { clearTimeout(timer); cancel.abort(); release.resolve(); await pending; await Promise.allSettled(tails); }
  });

  test.each(['source', 'port', 'caller'] as const)('retained guards reject %s retirement after a diagnostic return', async mode => {
    const f = fixture(), port = readings(); installJudgmentPort(port.port);
    const guards: Array<() => void> = [], options = { sourceOwner: ordinaryResearchOwner(), retainCurrent: (guard: () => void): void => { guards.push(guard); }, assertCurrent: () => {} };
    await localModelServerHealthMap(f.context, true, options);
    guards.forEach(guard => guard());
    if (mode === 'source') f.diagnostic.undisplayedTail = 'Changed after native return';
    else if (mode === 'port') installJudgmentPort(readings().port);
    else options.assertCurrent = () => {};
    expect(() => guards.forEach(guard => guard())).toThrow();
  });

  test.each(['boolean', 'status', 'pressure', 'schema', 'identity'] as const)
  ('%s refuses a replaced native callable before invoking it or acquiring source privacy readings', async kind => {
    const f = policyCase(kind), port = readings(); installJudgmentPort(port.port);
    const original = Object.getOwnPropertyDescriptor(f.decision, f.method); let invoked = 0;
    Object.defineProperty(f.decision, f.method, { configurable: true, writable: true, enumerable: original?.enumerable ?? true,
      value() { invoked++; throw new Error('Replaced canonical callable must not be invoked.'); } });
    try { await expect(f.invoke()).rejects.toThrow(); expect(invoked).toBe(0); expect(port.requests).toHaveLength(0); }
    finally { if (original) Object.defineProperty(f.decision, f.method, original); else Reflect.deleteProperty(f.decision, f.method); }
  });

  test.each(['boolean', 'status', 'pressure', 'schema'] as const)
  ('%s cannot substitute deep-equal published items for the original items retained by run', async kind => {
    const f = policyCase(kind), port = readings({ confidence: 0.8, certificationProbability: 0.8 }); installJudgmentPort(port.port);
    const original = Object.getOwnPropertyDescriptor(f.decision, 'items');
    if (!original || !('value' in original)) throw new Error('Expected native battery items.');
    Object.defineProperty(f.decision, 'items', { ...original, value: JSON.parse(JSON.stringify(original.value)) });
    try { await expect(f.invoke()).rejects.toThrow(); expect(port.requests).toHaveLength(0); }
    finally { Object.defineProperty(f.decision, 'items', original); }
  });

  test('published items replacement cannot hide retirement of the closed original shared high band', async () => {
    const f = policyCase('status'), port = readings({ status: 'ready', confidence: 0.8 }); installJudgmentPort(port.port);
    const items = Object.getOwnPropertyDescriptor(localServingStatus, 'items'), actAt = Object.getOwnPropertyDescriptor(f.band, 'actAt');
    if (!items || !actAt || !('value' in items)) throw new Error('Expected original native policy descriptors.');
    Object.defineProperty(localServingStatus, 'items', { ...items, value: JSON.parse(JSON.stringify(items.value)) });
    Object.defineProperty(f.band, 'actAt', { ...actAt, value: 0.75 });
    try { await expect(f.invoke()).rejects.toThrow(); expect(port.requests).toHaveLength(0); }
    finally { Object.defineProperty(f.band, 'actAt', actAt); Object.defineProperty(localServingStatus, 'items', items); }
  });

  test.each(['boolean', 'status', 'pressure', 'schema', 'identity'] as const)
  ('%s cannot replace the original band with equal values before a reader starts', async kind => {
    const f = policyCase(kind), port = readings(); installJudgmentPort(port.port);
    const original = Object.getOwnPropertyDescriptor(f.bandOwner, f.bandKey);
    if (!original) throw new Error('Expected native band slot.');
    if (!original.configurable && 'writable' in original && !original.writable) {
      expect(Reflect.defineProperty(f.bandOwner, f.bandKey, { value: JSON.parse(JSON.stringify(f.band)) })).toBe(false);
      expect(Object.getOwnPropertyDescriptor(f.bandOwner, f.bandKey)?.value).toBe(f.band);
      expect(port.requests).toHaveLength(0);
      return;
    }
    Object.defineProperty(f.bandOwner, f.bandKey, { ...original, value: JSON.parse(JSON.stringify(f.band)) });
    try { await expect(f.invoke()).rejects.toThrow(); expect(port.requests).toHaveLength(0); }
    finally { Object.defineProperty(f.bandOwner, f.bandKey, original); }
  });

  test.each((['boolean', 'status', 'pressure', 'schema', 'identity'] as const).flatMap(kind =>
    (['band', 'equal band replacement', 'callable', 'registry method'] as const).map(mode => ({ kind, mode }))))
  ('$kind rejects pending $mode retirement before any late reading can become acting', async ({ kind, mode }) => {
    const fixtureCase = policyCase(kind), base = readings({ confidence: fixtureCase.confidence, certificationProbability: 0.8 });
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const tails: Array<ReturnType<JudgmentPort['ask']>> = [];
    const port: JudgmentPort = { model: base.port.model, ask(request) {
      const tail = (async () => {
        if (Object.hasOwn(request.questions, fixtureCase.question)) { entered.resolve(); await release.promise; }
        return base.port.ask(request);
      })();
      tails.push(tail); return tail;
    } };
    installJudgmentPort(port);
    let delivered: unknown;
    const pending = fixtureCase.invoke().then(value => { delivered = value; return undefined; }, (error: unknown) => error);
    const timer = setTimeout(() => entered.reject(new Error('Policy control did not enter its canonical question.')), 2_000);
    const owner = mode === 'band' ? fixtureCase.band : mode === 'equal band replacement' ? fixtureCase.bandOwner
      : mode === 'callable' ? fixtureCase.decision : fixtureCase.registry;
    const key = mode === 'band' ? 'actAt' : mode === 'equal band replacement' ? fixtureCase.bandKey
      : mode === 'callable' ? fixtureCase.method : 'get';
    const original = Object.getOwnPropertyDescriptor(owner, key);
    const nativeGet = fixtureCase.registry.get;
    try {
      await entered.promise;
      const value: unknown = mode === 'band' ? (kind === 'identity' ? 0.56 : 0.75)
        : mode === 'equal band replacement' ? JSON.parse(JSON.stringify(fixtureCase.band))
          : mode === 'registry method' ? function(this: unknown, name: string) { return Reflect.apply(nativeGet, this, [name]); }
            : () => { throw new Error('Retired canonical callable must never be invoked.'); };
      if (original && !original.configurable && 'writable' in original && !original.writable) {
        expect(Reflect.defineProperty(owner, key, { value })).toBe(false);
        expect(Object.getOwnPropertyDescriptor(owner, key)?.value).toBe(original.value);
        release.resolve();
        expect(await pending).toBeUndefined();
        expect(kind).toBe('identity'); expect(delivered).toBeNull();
        return;
      }
      Object.defineProperty(owner, key, { value, configurable: true, writable: true, enumerable: original?.enumerable ?? true });
      release.resolve();
      expect(await pending).toBeInstanceOf(Error);
    } finally {
      clearTimeout(timer); release.resolve(); await pending; await Promise.allSettled(tails);
      if (original) Object.defineProperty(owner, key, original); else Reflect.deleteProperty(owner, key);
    }
  });
});
