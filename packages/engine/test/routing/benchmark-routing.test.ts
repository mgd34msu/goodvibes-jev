import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { BenchmarkStore, type BenchmarkEntry } from '../../sdk/src/platform/providers/model-benchmarks.ts';
import type { ModelDefinition } from '../../sdk/src/platform/providers/registry-types.ts';
import { createBenchmarkRoutePlanner, prepareRouteBenchmarks, routeBenchmarkFor } from '../../sdk/src/platform/runtime/contract-composition.ts';
import { createRoutePlanner, type RoutePlannerCatalog } from '../../sdk/src/platform/routing/route-planner.ts';
import { ModelTierStore } from '../../sdk/src/platform/routing/model-tiers.ts';
import { BENCHMARK_PREPARATION_ATTEMPTS, BENCHMARK_READ_CONCURRENCY, CHOICE_SHORTLIST } from '../../sdk/src/platform/routing/policy.ts';

const dirs: string[] = [];
const originalFetch = globalThis.fetch;
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => {
  installJudgmentPort(previous);
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

test('the first cold route sorts by the read benchmark identity, and the warm route asks no identity again', async () => {
  const benchmarks = store();
  const { port: judgment, requests } = port();
  installJudgmentPort(judgment);
  const candidates = [...Array.from({ length: CHOICE_SHORTLIST + 1 }, (_, index) => model(`cheap-${String.fromCharCode(97 + index)}`)), model(alias)];
  expect(routeBenchmarkFor(benchmarks)(model(alias))).toBeNull();
  // Control: the old cold composition cannot even offer the stronger model
  // in its first shortlist; the free models occupy every choice slot.
  const cold = createRoutePlanner({ catalog: catalog(candidates), tiers: new ModelTierStore(), benchmarkFor: routeBenchmarkFor(benchmarks) });
  expect((await cold.planRoute({ brief: 'Implement a parser.', purpose: 'planner' })).model).not.toBe(`configured:${alias}`);
  expect(JSON.stringify(requests.at(-1)!.state)).not.toContain(alias);
  const planner = createBenchmarkRoutePlanner({
    catalog: catalog(candidates), tiers: new ModelTierStore(),
  }, benchmarks);
  expect((await planner.planRoute({ brief: 'Implement a parser.', purpose: 'planner' })).model).toBe(`configured:${alias}`);
  const choiceRequest = requests.at(-1)!;
  expect(Object.keys(choiceRequest.questions.pick!.type === 'choice' ? choiceRequest.questions.pick!.criteria : {})).toContain(`configured:${alias}`);
  expect(JSON.stringify(choiceRequest.state)).toContain('"benchmark_composite":0.85');
  const before = requests.length;
  expect((await planner.planRoute({ brief: 'Implement a second parser.', purpose: 'planner' })).model).toBe(`configured:${alias}`);
  expect(requests.length - before).toBe(2); // Request reading and choice, no identity or tier re-read.
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

test('a no-match or escalated identity stays unscored, with no lexical guess', async () => {
  for (const confidence of [0.95, 0.2]) {
    const benchmarks = store();
    const fake = fakePort((name, question) => name === 'pick' ? choiceAnswer(question, confidence === 0.95 ? 'none' : canonical, confidence) : noulAnswer(0.95));
    installJudgmentPort(fake.port);
    await prepareRouteBenchmarks(benchmarks, [model(alias)]);
    expect(routeBenchmarkFor(benchmarks)(model(alias))).toBeNull();
    await prepareRouteBenchmarks(benchmarks, [model(alias)]);
    expect(fake.requests).toHaveLength(1);
  }
});

test('an identity outage stops routing before tier and model choice instead of guessing a route', async () => {
  const { port: judgment, requests } = port();
  const failure = new Error('identity unavailable');
  installJudgmentPort({ ...judgment, ask: async (request) => {
    if (Object.hasOwn(request.questions, 'pick')) throw failure;
    return judgment.ask(request);
  } });
  const benchmarks = store();
  const planner = createBenchmarkRoutePlanner({
    catalog: catalog([model(alias)]), tiers: new ModelTierStore(),
  }, benchmarks);
  await expect(planner.planRoute({ brief: 'Implement a parser.', purpose: 'planner' })).rejects.toBe(failure);
  expect(requests).toHaveLength(1);
  expect(routeBenchmarkFor(benchmarks)(model(alias))).toBeNull();
});

test('a rejected identity can be retried and does not become a cached no-match', async () => {
  const benchmarks = store();
  const failure = new Error('temporary identity failure');
  const { port: judgment, requests } = port();
  installJudgmentPort({ ...judgment, ask: async () => { throw failure; } });
  await expect(prepareRouteBenchmarks(benchmarks, [model(alias)])).rejects.toBe(failure);
  installJudgmentPort(judgment);
  await prepareRouteBenchmarks(benchmarks, [model(alias)]);
  expect(routeBenchmarkFor(benchmarks)(model(alias))).toBeCloseTo(0.85);
  expect(requests).toHaveLength(1);
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

test('cancelling one route does not cancel another route waiting on the same identity', async () => {
  const benchmarks = store();
  const { port: judgment, requests } = port();
  let release: () => void = () => {};
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  installJudgmentPort({ ...judgment, ask: async (request) => { await waiting; return judgment.ask(request); } });
  const controller = new AbortController();
  const reason = new Error('only the first route was cancelled');
  const first = prepareRouteBenchmarks(benchmarks, [model(alias)], controller.signal);
  const second = prepareRouteBenchmarks(benchmarks, [model(alias)]);
  controller.abort(reason);
  await expect(first).rejects.toBe(reason);
  release();
  await second;
  expect(requests).toHaveLength(1);
  expect(routeBenchmarkFor(benchmarks)(model(alias))).toBeCloseTo(0.85);
});

function gate(): { waiting: Promise<void>; release: () => void } {
  let release = (): void => {};
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  return { waiting, release };
}

function refreshWith(benchmarks: BenchmarkStore, entries: readonly BenchmarkEntry[]): Promise<void> {
  // Never delegate to a real transport, including for an unexpected URL.
  globalThis.fetch = Object.assign(async () => Response.json(entries.map((candidate) => ({
    id: candidate.modelId, name: candidate.name, organization: candidate.organization,
    swe: candidate.benchmarks.swe, gpqa: candidate.benchmarks.gpqa,
  }))), { preconnect: originalFetch.preconnect });
  return benchmarks.refreshBenchmarks();
}

test('a route retries benchmark preparation when refresh replaces an awaited identity generation', async () => {
  const benchmarks = store();
  const { port: judgment, requests } = port();
  const started = gate();
  const paused = gate();
  let identityReads = 0;
  installJudgmentPort({ ...judgment, ask: async (request) => {
    if (request.questions.pick?.type === 'choice' && canonical in request.questions.pick.criteria) {
      identityReads++;
      if (identityReads === 1) { started.release(); await paused.waiting; }
    }
    return judgment.ask(request);
  } });
  const control = { ...entry, modelId: 'tiny-control', name: 'Tiny Control', benchmarks: { swe: 0.1 } };
  const planner = createBenchmarkRoutePlanner({
    catalog: catalog([model(alias), model(control.modelId)]), tiers: new ModelTierStore(),
  }, benchmarks);
  const routing = planner.planRoute({ brief: 'Implement a parser.', purpose: 'planner' });
  await started.waiting;
  await refreshWith(benchmarks, [{ ...entry, benchmarks: { swe: 0.4 } }, control]);
  paused.release();
  expect((await routing).model).toBe(`configured:${alias}`);
  expect(routeBenchmarkFor(benchmarks)(model(alias))).toBeCloseTo(0.4);
  expect(identityReads).toBe(2);
  expect(JSON.stringify(requests.at(-1)!.state)).toContain('"benchmark_composite":0.4');
});

test('a refresh retries the whole batch, including an alias prepared before another identity waited', async () => {
  const benchmarks = store();
  const { port: judgment } = port();
  installJudgmentPort(judgment);
  await prepareRouteBenchmarks(benchmarks, [model(alias)]);
  const otherAlias = 'vendor/balanced-model-3-alternate';
  const started = gate();
  const paused = gate();
  let identityReads = 0;
  installJudgmentPort({ ...judgment, ask: async (request) => {
    if (request.questions.pick?.type === 'choice' && canonical in request.questions.pick.criteria) {
      identityReads++;
      if (identityReads === 1) { started.release(); await paused.waiting; }
    }
    return judgment.ask(request);
  } });
  const planner = createBenchmarkRoutePlanner({
    catalog: catalog([model(alias), model(otherAlias)]), tiers: new ModelTierStore(),
  }, benchmarks);
  const routing = planner.planRoute({ brief: 'Implement a parser.', purpose: 'planner' });
  await started.waiting;
  await refreshWith(benchmarks, [{ ...entry, benchmarks: { swe: 0.4 } }]);
  paused.release();
  await routing;
  expect(routeBenchmarkFor(benchmarks)(model(alias))).toBeCloseTo(0.4);
  expect(routeBenchmarkFor(benchmarks)(model(otherAlias))).toBeCloseTo(0.4);
  expect(identityReads).toBe(3); // Old pending alias, its retry, and the earlier alias's retry.
});

for (const refreshedId of [canonical, 'balanced-model-4']) test(`readBenchmarks returns the current ${refreshedId} entry after an in-flight generation changes`, async () => {
  const benchmarks = store();
  const { port: judgment } = port();
  const started = gate();
  const paused = gate();
  let calls = 0;
  installJudgmentPort({ ...judgment, ask: async (request) => {
    if (++calls === 1) { started.release(); await paused.waiting; }
    return judgment.ask(request);
  } });
  const reading = benchmarks.readBenchmarks(alias);
  await started.waiting;
  await refreshWith(benchmarks, [{ ...entry, modelId: refreshedId, benchmarks: { swe: 0.4 } }]);
  paused.release();
  expect(await reading).toMatchObject({ modelId: refreshedId, benchmarks: { swe: 0.4 } });
  expect(benchmarks.getKnownBenchmarks(alias)?.benchmarks).toEqual({ swe: 0.4 });
  expect(calls).toBe(2);
});

test('an empty leaderboard does not cache an alias miss across a later refresh', async () => {
  const benchmarks = store([]);
  const { port: judgment, requests } = port();
  installJudgmentPort(judgment);
  await prepareRouteBenchmarks(benchmarks, [model(alias)]);
  expect(routeBenchmarkFor(benchmarks)(model(alias))).toBeNull();
  expect(requests).toHaveLength(0);
  await refreshWith(benchmarks, [entry]);
  await prepareRouteBenchmarks(benchmarks, [model(alias)]);
  expect(routeBenchmarkFor(benchmarks)(model(alias))).toBeCloseTo(0.85);
  expect(requests).toHaveLength(1);
});

test('cancelling one route during refresh preserves the shared reading and the other route retries', async () => {
  const benchmarks = store();
  const { port: judgment, requests } = port();
  const started = gate();
  const paused = gate();
  let calls = 0;
  installJudgmentPort({ ...judgment, ask: async (request) => {
    if (++calls === 1) { started.release(); await paused.waiting; }
    return judgment.ask(request);
  } });
  const controller = new AbortController();
  const reason = new Error('cancel the first route during refresh');
  const first = prepareRouteBenchmarks(benchmarks, [model(alias)], controller.signal);
  const second = prepareRouteBenchmarks(benchmarks, [model(alias)]);
  await started.waiting;
  await refreshWith(benchmarks, [{ ...entry, benchmarks: { swe: 0.4 } }]);
  controller.abort(reason);
  await expect(first).rejects.toBe(reason);
  paused.release();
  await second;
  expect(requests).toHaveLength(2);
  expect(routeBenchmarkFor(benchmarks)(model(alias))).toBeCloseTo(0.4);
});

test('continuous leaderboard churn refuses an identity after bounded attempts', async () => {
  const benchmarks = store();
  const { port: judgment, requests } = port();
  installJudgmentPort({ ...judgment, ask: async (request) => {
    await refreshWith(benchmarks, [entry]);
    return judgment.ask(request);
  } });
  await expect(benchmarks.readBenchmarks(alias)).rejects.toThrow('Benchmark leaderboard kept changing during identity preparation');
  expect(requests).toHaveLength(BENCHMARK_PREPARATION_ATTEMPTS);
  expect(routeBenchmarkFor(benchmarks)(model(alias))).toBeNull();
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

test('the composed planner retains its prepared snapshot across a refresh after unsubscribe', async () => {
  // Sweep the microtask boundary deterministically: offset 7 reproduced
  // unsubscribe -> refresh -> unscored alias -> weaker exact-id choice.
  for (let delay = 0; delay < 20; delay++) {
    const control = { ...entry, modelId: 'tiny-control', name: 'Tiny Control', benchmarks: { swe: 0.1 } };
    const benchmarks = store([entry, control]);
    const { port: judgment } = port();
    let started = false;
    let refreshing: Promise<void> = Promise.resolve();
    installJudgmentPort({ ...judgment, ask: async (request) => {
      if (!started && request.questions.pick?.type === 'choice' && canonical in request.questions.pick.criteria) {
        started = true;
        refreshing = (async () => {
          for (let index = 0; index < delay; index++) await Promise.resolve();
          await refreshWith(benchmarks, [{ ...entry, benchmarks: { swe: 0.4 } }, control]);
        })();
      }
      return judgment.ask(request);
    } });
    const planner = createBenchmarkRoutePlanner({
      catalog: catalog([model(alias), model(control.modelId)]), tiers: new ModelTierStore(),
    }, benchmarks);
    const result = await planner.planRoute({ brief: 'Implement a parser.', purpose: 'planner' });
    await refreshing;
    expect(result.model).toBe(`configured:${alias}`);
  }
});

test('concurrent composed plans keep separate snapshots when refresh falls between their preparations', async () => {
  let observedDifferentGenerations = false;
  for (const stagger of [0, 4, 8, 12, 16]) for (let delay = 0; delay < 30; delay++) {
    const control = { ...entry, modelId: 'tiny-control', name: 'Tiny Control', benchmarks: { swe: 0.1 } };
    const benchmarks = store([entry, control]);
    const { port: judgment, requests } = port();
    let started = false;
    let refreshing: Promise<void> = Promise.resolve();
    installJudgmentPort({ ...judgment, ask: async (request) => {
      if (!started && request.questions.pick?.type === 'choice' && canonical in request.questions.pick.criteria) {
        started = true;
        refreshing = (async () => {
          for (let index = 0; index < delay; index++) await Promise.resolve();
          await refreshWith(benchmarks, [{ ...entry, benchmarks: { swe: 0.4 } }, control]);
        })();
      }
      return judgment.ask(request);
    } });
    const controlModel = model(control.modelId);
    const planner = createBenchmarkRoutePlanner({
      // A catalog may rebuild definition objects on each read. A shared map
      // would let the second plan remove the first plan's alias fact.
      catalog: { ...catalog([]), listModels: () => [model(alias), controlModel] },
      tiers: new ModelTierStore(),
    }, benchmarks);
    const first = planner.planRoute({ brief: 'Implement the first parser.', purpose: 'planner' });
    for (let index = 0; index < stagger; index++) await Promise.resolve();
    const second = planner.planRoute({ brief: 'Implement the second parser.', purpose: 'planner' });
    const results = await Promise.all([first, second]);
    await refreshing;
    expect(results.map((result) => result.model)).toEqual([`configured:${alias}`, `configured:${alias}`]);
    const choices = requests.filter((request) => request.questions.pick?.type === 'choice'
      && `configured:${alias}` in request.questions.pick.criteria);
    expect(choices).toHaveLength(2);
    const states = choices.map((request) => JSON.stringify(request.state));
    if (states.some((state) => state.includes('"benchmark_composite":0.85'))
      && states.some((state) => state.includes('"benchmark_composite":0.4'))) observedDifferentGenerations = true;
  }
  expect(observedDifferentGenerations).toBe(true);
});
