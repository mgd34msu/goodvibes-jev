import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { EntryType, Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { composeTier, type RequestReading } from '../../sdk/src/platform/routing/request-reading.js';
import { createRoutePlanner, eligibleModels, NoRouteError, shortlistOrder, type RoutePlannerCatalog } from '../../sdk/src/platform/routing/route-planner.js';
import { ModelTierStore, modelTierFrom, type ModelFacts } from '../../sdk/src/platform/routing/model-tiers.js';
import { tierSearchOrder } from '../../sdk/src/platform/routing/tiers.js';
import type { ModelDefinition } from '../../sdk/src/platform/providers/registry-types.js';
import type { ResolvedModelPricing } from '../../sdk/src/platform/providers/model-pricing.js';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

const choice = (value: string, confidence: number, outcome: 'act' | 'confirm' | 'escalate') => ({ kind: 'choice' as const, choice: value, confidence, probabilities: {}, outcome });
const score = (level: number, outcome: 'act' | 'confirm' | 'escalate' = 'act') => ({ kind: 'score' as const, score: level, level, normalized: level / 3, confidence: 0.9, probabilities: [], outcome });

function readings(overrides: Partial<Record<keyof RequestReading['readings'], unknown>> = {}): RequestReading['readings'] {
  return {
    tier: choice('economy', 0.9, 'act'),
    intent: choice('code_change', 0.9, 'act'),
    difficulty: score(0),
    risk: score(0),
    domain: choice('software', 0.9, 'act'),
    language: choice('english', 0.99, 'act'),
    ...overrides,
  } as RequestReading['readings'];
}

describe('tier composition', () => {
  test('a confident tier reading stands when no floor raises it', () => {
    expect(composeTier(readings(), 'unit').tier).toBe('economy');
  });

  test('an unsure tier reading gives way to the difficulty level', () => {
    const composed = composeTier(readings({ tier: choice('economy', 0.4, 'escalate'), difficulty: score(3) }), 'unit');
    expect(composed.tier).toBe('premium');
    expect(composed.because).toContain('difficulty');
  });

  test('severe risk and the planner purpose raise the floor', () => {
    expect(composeTier(readings({ risk: score(3) }), 'unit').tier).toBe('premium');
    expect(composeTier(readings(), 'planner').tier).toBe('standard');
  });

  test('a non-English request with an unsure tier reading is not sent below standard', () => {
    expect(composeTier(readings({ tier: choice('economy', 0.7, 'confirm'), language: choice('german', 0.99, 'act') }), 'unit').tier).toBe('standard');
    expect(composeTier(readings({ language: choice('german', 0.99, 'act') }), 'unit').tier).toBe('economy');
  });

  test('tier search goes to the wanted tier, then higher, then lower', () => {
    expect(tierSearchOrder('standard')).toEqual(['standard', 'premium', 'economy']);
    expect(tierSearchOrder('premium')).toEqual(['premium', 'standard', 'economy']);
  });
});

describe('model tier composition', () => {
  const yes = { kind: 'yes-no' as const, probability: 0.95, verdict: 'yes' as const, outcome: 'act' as const };
  const no = { kind: 'yes-no' as const, probability: 0.05, verdict: 'no' as const, outcome: 'act' as const };
  const unsure = { kind: 'yes-no' as const, probability: 0.5, verdict: 'uncertain' as const, outcome: 'escalate' as const };
  test('frontier is premium, small is economy, clearly neither is standard, unsure is unsettled', () => {
    expect(modelTierFrom({ frontier: yes, small: no })).toBe('premium');
    expect(modelTierFrom({ frontier: no, small: yes })).toBe('economy');
    expect(modelTierFrom({ frontier: no, small: no })).toBe('standard');
    expect(modelTierFrom({ frontier: unsure, small: no })).toBeUndefined();
    expect(modelTierFrom({ frontier: yes, small: yes })).toBeUndefined();
  });
});

function def(provider: string, id: string, overrides: Partial<ModelDefinition> = {}): ModelDefinition {
  return {
    id,
    provider,
    registryKey: `${provider}:${id}`,
    displayName: id,
    description: id,
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 128_000,
    selectable: true,
    ...overrides,
  };
}

function catalogOf(models: ModelDefinition[], configured: string[], prices: Record<string, number> = {}): RoutePlannerCatalog {
  return {
    listModels: () => models,
    getConfiguredProviderIds: () => configured,
    getContextWindowForModel: (model) => model.contextWindow,
    resolveModelPricing: (ref): ResolvedModelPricing => (prices[ref] === undefined
      ? { status: 'unknown' }
      : { status: 'priced', source: 'catalog', rates: { inputPerMTok: prices[ref]!, outputPerMTok: prices[ref]! * 4 } }),
  };
}

/** Answers the request batteries, the tier questions and the model choice. */
function routingPort(options: { tier: string; frontier: (state: EntryType) => boolean; pick: string; fit?: (index: number) => number }) {
  return fakePort((name: string, question: Question, state: EntryType) => {
    if (name === 'tier__tier') return choiceAnswer(question, options.tier, 0.95);
    if (name === 'intent__intent') return choiceAnswer(question, 'code_change', 0.95);
    if (name === 'domain__domain') return choiceAnswer(question, 'software', 0.95);
    if (name === 'language__language') return choiceAnswer(question, 'english', 0.99);
    if (name === 'difficulty__difficulty' || name === 'risk__risk') return scoreAnswer(question, 1, 0.9);
    if (name === 'frontier') return noulAnswer(options.frontier(state) ? 0.95 : 0.05);
    if (name === 'small') return noulAnswer(options.frontier(state) ? 0.05 : 0.95);
    if (name === 'pick') return choiceAnswer(question, options.pick, 0.9);
    if (name.startsWith('fits_')) return noulAnswer(options.fit ? options.fit(Number(name.slice(5))) : 0.9);
    throw new Error(`unexpected question ${name}`);
  });
}

const isFlagship = (state: EntryType): boolean => JSON.stringify(state).includes('flagship');

describe('route planner', () => {
  const models = [
    def('alpha', 'flagship-1'),
    def('beta', 'flagship-2'),
    def('alpha', 'small-1'),
    def('gamma', 'flagship-3'),
    def('alpha', 'no-tools-flagship', { capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false } }),
  ];
  const prices = { 'alpha:flagship-1': 5, 'beta:flagship-2': 3, 'alpha:small-1': 0.1, 'gamma:flagship-3': 4 };

  test('only configured, healthy providers serving capable models are eligible', () => {
    const deps = {
      catalog: catalogOf(models, ['alpha', 'beta']),
      tiers: new ModelTierStore(),
      providerHealth: () => new Map([['beta', { status: 'auth_error' as const }]]),
    };
    expect(eligibleModels(deps).map((model) => model.registryKey)).toEqual(['alpha:flagship-1', 'alpha:small-1']);
  });

  test('picks the model the choice reads, with the other fitting same-tier models as fallbacks and a reason', async () => {
    const { port, requests } = routingPort({ tier: 'premium', frontier: isFlagship, pick: 'beta:flagship-2' });
    installJudgmentPort(port);
    const planner = createRoutePlanner({ catalog: catalogOf(models, ['alpha', 'beta']), tiers: new ModelTierStore() });
    const route = await planner.planRoute({ purpose: 'unit', brief: 'Redesign the lease fencing.' });
    expect(route.model).toBe('beta:flagship-2');
    expect(route.provider).toBe('beta');
    expect(route.modelId).toBe('flagship-2');
    expect(route.fallbackModels).toEqual(['alpha:flagship-1']);
    expect(route.tier).toBe('premium');
    expect(route.chosenTier).toBe('premium');
    expect(route.reason).toContain('tier premium');
    expect(route.reason).toContain('chose beta:flagship-2');
    // One request batteries fan-out, one tier reading per eligible model, one choice.
    expect(requests).toHaveLength(1 + 3 + 1);
    const choiceRequest = requests.at(-1)!;
    expect(Object.keys(choiceRequest.questions)).toContain('pick');
    expect(JSON.stringify(choiceRequest.state)).not.toContain('small-1');
  });

  test('tier readings are remembered, so a second plan reads only the request and the choice', async () => {
    const { port, requests } = routingPort({ tier: 'premium', frontier: isFlagship, pick: 'alpha:flagship-1' });
    installJudgmentPort(port);
    const planner = createRoutePlanner({ catalog: catalogOf(models, ['alpha', 'beta']), tiers: new ModelTierStore() });
    await planner.planRoute({ purpose: 'unit', brief: 'first' });
    const before = requests.length;
    await planner.planRoute({ purpose: 'unit', brief: 'second' });
    expect(requests.length - before).toBe(2);
  });

  test('when no model of the wanted tier is configured the next tier is used and the reason says so', async () => {
    const { port } = routingPort({ tier: 'economy', frontier: isFlagship, pick: 'alpha:flagship-1' });
    installJudgmentPort(port);
    const planner = createRoutePlanner({ catalog: catalogOf([def('alpha', 'flagship-1')], ['alpha'], prices), tiers: new ModelTierStore() });
    const route = await planner.planRoute({ purpose: 'unit', brief: 'fix a typo' });
    expect(route.tier).toBe('economy');
    expect(route.chosenTier).toBe('premium');
    expect(route.reason).toContain('no fitting economy model is configured');
  });

  test('a choice of none moves on, and no fitting model anywhere is an error', async () => {
    const { port } = routingPort({ tier: 'premium', frontier: isFlagship, pick: 'none', fit: () => 0.05 });
    installJudgmentPort(port);
    const planner = createRoutePlanner({ catalog: catalogOf(models, ['alpha']), tiers: new ModelTierStore() });
    await expect(planner.planRoute({ purpose: 'unit', brief: 'x' })).rejects.toBeInstanceOf(NoRouteError);
  });

  test('no eligible model is an error before any tier is read', async () => {
    const { port, requests } = routingPort({ tier: 'premium', frontier: isFlagship, pick: 'none' });
    installJudgmentPort(port);
    const planner = createRoutePlanner({ catalog: catalogOf(models, []), tiers: new ModelTierStore() });
    await expect(planner.planRoute({ purpose: 'unit', brief: 'x' })).rejects.toBeInstanceOf(NoRouteError);
    expect(requests).toHaveLength(1);
  });

  test('without a judgment port the planner fails rather than guessing', async () => {
    const planner = createRoutePlanner({ catalog: catalogOf(models, ['alpha']), tiers: new ModelTierStore() });
    await expect(planner.planRoute({ purpose: 'unit', brief: 'x' })).rejects.toBeInstanceOf(JudgmentPortMissingError);
  });
});

describe('shortlist order', () => {
  const facts = (key: string, input: number, benchmark: number | null): ModelFacts => ({ registryKey: key, id: key, name: key, provider: 'p', price: { input, output: input }, benchmark });
  test('premium reads the strongest published benchmark first, economy the cheapest', () => {
    const list = [facts('a', 1, 0.5), facts('b', 10, 0.8), facts('c', 0.1, null)];
    expect([...list].sort(shortlistOrder('premium')).map((f) => f.registryKey)).toEqual(['b', 'a', 'c']);
    expect([...list].sort(shortlistOrder('economy')).map((f) => f.registryKey)).toEqual(['c', 'a', 'b']);
  });
});
