import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { installCatalogModelFacts } from '../../sdk/src/platform/providers/model-catalog-facts.ts';
import { BenchmarkStore, type BenchmarkEntry } from '../../sdk/src/platform/providers/model-benchmarks.ts';
import type { ModelDefinition } from '../../sdk/src/platform/providers/registry-types.ts';
import { createBenchmarkRoutePlanner, prepareRouteBenchmarks, routeBenchmarkFor } from '../../sdk/src/platform/runtime/contract-composition.ts';
import { createRoutePlanner, type RoutePlannerCatalog } from '../../sdk/src/platform/routing/route-planner.ts';
import { ModelTierStore } from '../../sdk/src/platform/routing/model-tiers.ts';
import { BENCHMARK_PREPARATION_ATTEMPTS, BENCHMARK_READ_CONCURRENCY, CHOICE_SHORTLIST } from '../../sdk/src/platform/routing/policy.ts';

const dirs: string[] = [];
const originalFetch = globalThis.fetch;
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); installCatalogModelFacts([]); });
afterEach(() => {
  installJudgmentPort(previous);
  installCatalogModelFacts([]);
  globalThis.fetch = originalFetch;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const canonical = 'balanced-model-3';
const alias = 'vendor/balanced-model-3-latest';
const entry: BenchmarkEntry = { modelId: canonical, name: 'Balanced Model 3', organization: 'vendor', benchmarks: { swe: 0.8, gpqa: 0.9 } };

function store(entries: BenchmarkEntry[] = [entry]): BenchmarkStore {
  const dir = mkdtempSync(join(tmpdir(), 'benchmark-routing-'));
  dirs.push(dir);
  const benchmarks = new BenchmarkStore({ dir });
  writeFileSync(benchmarks.getCachePath(), JSON.stringify({ version: 1, fetchedAt: Date.now(), ttlMs: 86_400_000, entries }));
  benchmarks.initBenchmarks();
  return benchmarks;
}

function model(id: string, provider = 'configured'): ModelDefinition {
  return {
    id, registryKey: `${provider}:${id}`, displayName: id, description: id, provider,
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 128_000, selectable: true,
  };
}

function catalog(models: ModelDefinition[]): RoutePlannerCatalog {
  return {
    listModels: () => models, getConfiguredProviderIds: () => ['configured'],
    getContextWindowForModel: (candidate) => candidate.contextWindow,
    resolveModelPricing: (ref) => ({ status: 'priced', source: 'catalog', rates: { inputPerMTok: ref.includes(alias) ? 5 : 0, outputPerMTok: 0 } }),
  };
}

function port() {
  return fakePort((name, question) => {
    if (name === 'tier__tier') return choiceAnswer(question, 'standard', 0.95);
    if (name === 'intent__intent') return choiceAnswer(question, 'code_change', 0.95);
    if (name === 'domain__domain') return choiceAnswer(question, 'software', 0.95);
    if (name === 'language__language') return choiceAnswer(question, 'english', 0.95);
    if (name === 'difficulty__difficulty' || name === 'risk__risk') return scoreAnswer(question, 1, 0.95);
    if (name === 'frontier' || name === 'small') return noulAnswer(0.05);
    if (name.startsWith('fits_')) return noulAnswer(0.95);
    if (name === 'pick' && question.type === 'choice') {
      const choices = Object.keys(question.criteria);
      return choiceAnswer(question, choices.includes(canonical) ? canonical : choices[0]!, 0.95);
    }
    throw new Error(`unexpected question ${name}`);
  });
}

function publishIdentity(ids = [alias, canonical], canonicalId = `vendor/${canonical}`): void {
  installCatalogModelFacts(ids.map(id => ({
    id, canonicalModelId: canonicalId, name: 'Balanced Model 3', provider: 'Configured', providerId: 'configured',
    providerEnvVars: [], pricing: null, tier: 'paid', modelType: 'chat',
  })));
}

test('published canonical aliases rank the first route without identity judgments', async () => {
  const benchmarks = store();
  const { port: judgment, requests } = port();
  installJudgmentPort(judgment);
  expect(routeBenchmarkFor(benchmarks)(model(alias))).toBeNull();
  publishIdentity();
  expect(routeBenchmarkFor(benchmarks)(model(alias))).toBeCloseTo(0.85);
  const candidates = [...Array.from({ length: CHOICE_SHORTLIST + 1 }, (_, index) => model(`cheap-${index}`)), model(alias)];
  const planner = createBenchmarkRoutePlanner({ catalog: catalog(candidates), tiers: new ModelTierStore() }, benchmarks);
  expect((await planner.planRoute({ brief: 'Implement a parser.', purpose: 'planner' })).model).toBe(`configured:${alias}`);
  expect(JSON.stringify(requests.at(-1)!.state)).toContain('"benchmark_composite":0.85');
  const before = requests.length;
  expect((await planner.planRoute({ brief: 'Implement a second parser.', purpose: 'planner' })).model).toBe(`configured:${alias}`);
  expect(requests.length - before).toBe(2); // Request interpretation and route choice.
  expect(requests.every(request => !Object.hasOwn(request.questions.pick?.type === 'choice' ? request.questions.pick.criteria : {}, canonical))).toBe(true);
});

test('unknown and ambiguous identities stay unscored without judgments or lexical guesses', async () => {
  const benchmarks = store();
  const { port: judgment, requests } = port();
  installJudgmentPort(judgment);
  await prepareRouteBenchmarks(benchmarks, [model(alias)]);
  expect(await benchmarks.readBenchmarks(alias)).toBeUndefined();
  publishIdentity();
  expect(await benchmarks.readBenchmarks(alias)).toEqual(entry);
  // The same published alias points at two different underlying models.
  installCatalogModelFacts(['one', 'two'].map(providerId => ({
    id: alias, canonicalModelId: `${providerId}/model`, name: 'Same Name', providerId, provider: providerId,
    providerEnvVars: [], pricing: null, tier: 'paid',
  })));
  expect(await benchmarks.readBenchmarks(alias)).toBeUndefined();
  expect(await benchmarks.readBenchmarks('balanced-model-4')).toBeUndefined();
  expect(requests).toHaveLength(0);
});

function gate(): { waiting: Promise<void>; release: () => void } {
  let release = (): void => {};
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  return { waiting, release };
}

function refreshWith(benchmarks: BenchmarkStore, entries: readonly BenchmarkEntry[]): Promise<void> {
  globalThis.fetch = Object.assign(async () => Response.json(entries.map((candidate) => ({
    id: candidate.modelId, name: candidate.name, organization: candidate.organization,
    swe: candidate.benchmarks.swe, gpqa: candidate.benchmarks.gpqa,
  }))), { preconnect: originalFetch.preconnect });
  return benchmarks.refreshBenchmarks();
}

test('local benchmark aliases use refreshed scores and do not retain earlier misses', async () => {
  publishIdentity();
  const benchmarks = store([]);
  expect(await benchmarks.readBenchmarks(alias)).toBeUndefined();
  await refreshWith(benchmarks, [entry]);
  expect(await benchmarks.readBenchmarks(alias)).toEqual(entry);
  await refreshWith(benchmarks, [{ ...entry, benchmarks: { swe: 0.4 } }]);
  expect(routeBenchmarkFor(benchmarks)(model(alias))).toBeCloseTo(0.4);
  const controller = new AbortController();
  controller.abort(new Error('cancelled lookup'));
  await expect(benchmarks.readBenchmarks(alias, undefined, controller.signal)).rejects.toThrow('cancelled lookup');
});

test('concurrent routes retain separate benchmark snapshots across a refresh', async () => {
  publishIdentity();
  const control = { ...entry, modelId: 'tiny-control', name: 'Tiny Control', benchmarks: { swe: 0.1 } };
  const benchmarks = store([entry, control]);
  const { port: judgment, requests } = port();
  const started = gate(), paused = gate();
  let firstChoice = true;
  installJudgmentPort({ ...judgment, ask: async request => {
    if (firstChoice && request.questions.pick?.type === 'choice' && `configured:${alias}` in request.questions.pick.criteria) {
      firstChoice = false; started.release(); await paused.waiting;
    }
    return judgment.ask(request);
  } });
  const planner = createBenchmarkRoutePlanner({
    catalog: { ...catalog([]), listModels: () => [model(alias), model(control.modelId)] }, tiers: new ModelTierStore(),
  }, benchmarks);
  const first = planner.planRoute({ brief: 'Implement the first parser.', purpose: 'planner' });
  await started.waiting;
  await refreshWith(benchmarks, [{ ...entry, benchmarks: { swe: 0.4 } }, control]);
  const second = await planner.planRoute({ brief: 'Implement the second parser.', purpose: 'planner' });
  paused.release();
  expect((await first).model).toBe(`configured:${alias}`);
  expect(second.model).toBe(`configured:${alias}`);
  const states = requests.filter(request => request.questions.pick?.type === 'choice').map(request => JSON.stringify(request.state));
  expect(states.some(state => state.includes('"benchmark_composite":0.85'))).toBe(true);
  expect(states.some(state => state.includes('"benchmark_composite":0.4'))).toBe(true);
});

test('preparation runs only for eligible models and finishes before facts are read', async () => {
  const { port: judgment } = port();
  installJudgmentPort(judgment);
  const wanted = model('wanted');
  const candidates = [wanted, model('unconfigured', 'other'), { ...model('hidden'), selectable: false },
    { ...model('no-tools'), capabilities: { ...wanted.capabilities, toolCalling: false } }];
  const events: string[] = [];
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const planner = createRoutePlanner({
    catalog: catalog(candidates), tiers: new ModelTierStore(),
    prepareBenchmarks: async (models) => { events.push(...models.map((candidate) => candidate.id)); await pending; events.push('ready'); },
    benchmarkFor: () => { events.push('facts'); return 0.8; },
  });
  const routing = planner.planRoute({ brief: 'Implement a parser.', purpose: 'planner' });
  for (let index = 0; index < 20 && events.length === 0; index++) await Promise.resolve();
  expect(events).toEqual(['wanted']);
  release();
  await routing;
  expect(events).toEqual(['wanted', 'ready', 'facts']);
});


test('an exact id avoids reading an unfamiliar display name', async () => {
  const benchmarks = store();
  const { port: judgment, requests } = port();
  installJudgmentPort(judgment);
  await prepareRouteBenchmarks(benchmarks, [{ ...model(canonical), displayName: 'Unfamiliar display label' }]);
  expect(requests).toHaveLength(0);
});


test('preparation bounds concurrency and cancellation stops queued readings', async () => {
  const controller = new AbortController();
  const reason = new Error('cancel route');
  let active = 0;
  let peak = 0;
  let calls = 0;
  const benchmarks = {
    getKnownBenchmarks: () => undefined,
    readBenchmarks: async (_name: string, _site?: string, signal?: AbortSignal) => {
      calls++; active++; peak = Math.max(peak, active);
      try { await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true })); }
      finally { active--; }
      return undefined;
    },
  };
  const pending = prepareRouteBenchmarks(benchmarks, Array.from({ length: BENCHMARK_READ_CONCURRENCY + 3 }, (_, index) => model(`model${index}`)), controller.signal);
  expect(peak).toBe(BENCHMARK_READ_CONCURRENCY);
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(calls).toBe(BENCHMARK_READ_CONCURRENCY);
  expect(active).toBe(0);
});


test('an already cancelled route issues no judgment requests', async () => {
  const { port: judgment, requests } = port();
  installJudgmentPort(judgment);
  const controller = new AbortController();
  const reason = new Error('cancelled before routing');
  controller.abort(reason);
  const planner = createRoutePlanner({ catalog: catalog([model(alias)]), tiers: new ModelTierStore() });
  await expect(planner.planRoute({ brief: 'Implement a parser.', purpose: 'planner', signal: controller.signal })).rejects.toBe(reason);
  expect(requests).toHaveLength(0);
});


test('continuous batch refresh refuses routing before facts and releases its subscription', async () => {
  const { port: judgment } = port();
  installJudgmentPort(judgment);
  let notify = (): void => {};
  let subscribed = false;
  let reads = 0;
  let facts = 0;
  const benchmarks = {
    getKnownBenchmarks: () => undefined,
    readBenchmarks: async () => { reads++; notify(); return entry; },
    onRefreshed: (callback: () => void) => {
      subscribed = true;
      notify = callback;
      return () => { subscribed = false; notify = () => {}; };
    },
  };
  const planner = createRoutePlanner({
    catalog: catalog([model(alias)]), tiers: new ModelTierStore(),
    benchmarkFor: () => { facts++; return null; },
    prepareBenchmarks: (models, signal) => prepareRouteBenchmarks(benchmarks, models, signal),
  });
  await expect(planner.planRoute({ brief: 'Implement a parser.', purpose: 'planner' })).rejects.toThrow('Benchmark leaderboard kept changing during route preparation');
  expect(reads).toBe(BENCHMARK_PREPARATION_ATTEMPTS);
  expect(facts).toBe(0);
  expect(subscribed).toBe(false);
});
