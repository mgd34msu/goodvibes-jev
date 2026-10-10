import { describe, expect, test } from 'bun:test';
import { fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { localRecipeFit, routeReadiness } from '../../sdk/src/platform/routing/batteries/model-readiness.js';
import { registry } from '../../sdk/src/platform/routing/judgment-registry.js';
import { localRecipeFitFrom, modelReadinessFlagFrom, routeReadinessFrom, type ModelReadinessHeldOutcome } from '../../sdk/src/platform/routing/model-readiness.js';

type RouteScoreName = typeof routeReadiness.composite.dimensions[number]['reading'];
async function routeRun(levels: Partial<Record<RouteScoreName, number>> = {}) {
  const { port } = fakePort((name, question) => question.type === 'noul'
    ? noulAnswer(name === 'cloudTransfer' ? 0.05 : 0.95)
    : scoreAnswer(question, levels[name as RouteScoreName] ?? 4));
  const run = await routeReadiness.run(port, { route: 'facts are provided by the caller' });
  return { ...run, result: { ...run.result, decisionId: 'route-decision', requestId: 'route-request' } };
}

async function fitRun(fit = 4, memory = 2) {
  const { port } = fakePort((name, question) => scoreAnswer(question, name === 'fit' ? fit : memory));
  return localRecipeFit.run(port, { recipe: 'recipe facts', hardware: 'OS facts', detection: 'actual detection' });
}

describe('canonical model-readiness batteries', () => {
  test('each canonical name is registered exactly once', () => {
    expect(registry.list().filter((decision) => decision.name === routeReadiness.name)).toEqual([routeReadiness]);
    expect(registry.list().filter((decision) => decision.name === localRecipeFit.name)).toEqual([localRecipeFit]);
    expect(routeReadiness.name).toBe('agent.models.route-readiness');
    expect(localRecipeFit.name).toBe('agent.models.local-recipe-fit');
  });

  test('six independent scores and two independent yes/no questions', () => {
    expect(routeReadiness.composite.dimensions.map(({ id }) => id)).toEqual(['latency', 'context-window', 'tool-support', 'vision', 'cost', 'privacy']);
    for (const { reading } of routeReadiness.composite.dimensions) expect(routeReadiness.items[reading].kind).toBe('score');
    expect(routeReadiness.items.cloudTransfer.kind).toBe('yes-no');
    expect(routeReadiness.items.exampleVision.kind).toBe('yes-no');
    expect(localRecipeFit.items.fit.kind).toBe('score');
    expect(localRecipeFit.items.memoryAdequacy.kind).toBe('score');
  });

  test('calibration fixtures cover every question and alternate hosting/capability facts', () => {
    const routeCovered = new Set(routeReadiness.fixtures.flatMap((fixture) => Object.keys(fixture.expect)));
    expect([...routeCovered].sort()).toEqual(Object.keys(routeReadiness.items).sort());
    const localCovered = new Set(localRecipeFit.fixtures.flatMap((fixture) => Object.keys(fixture.expect)));
    expect([...localCovered].sort()).toEqual(Object.keys(localRecipeFit.items).sort());
    expect(routeReadiness.fixtures.some((fixture) => fixture.name.includes('proxy'))).toBe(true);
    expect(routeReadiness.fixtures.some((fixture) => fixture.name.includes('without a vision keyword'))).toBe(true);
  });
});

describe('route-readiness composition', () => {
  test('uses the battery’s sole weights and retains model/request/decision provenance', async () => {
    const run = await routeRun({ latency: 2, contextWindow: 3, toolSupport: 4, vision: 1, cost: 3, privacy: 4 });
    const result = routeReadinessFrom(run);
    const expected = routeReadiness.composite.dimensions.reduce((sum, dimension) => sum + dimension.weight * run.readings[dimension.reading].normalized, 0)
      / routeReadiness.composite.dimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
    expect(result.normalized).toBe(expected);
    expect(result.score).toBe(Math.round(expected * 100));
    expect(result.outcome).toBe('ready');
    expect(result.level).toBe('good');
    expect(result.confidence).toBe(0.9);
    expect(result.decisionId).toBe('route-decision');
    expect(result.provenance).toEqual({ battery: routeReadiness.name, version: routeReadiness.version, decisionId: 'route-decision', requestId: 'route-request', requestedModel: 'jev-1.13.0', model: 'jev-1.13.0' });
    expect(result.cloudTransfer.value).toBe(false);
    expect(result.dimensions.every((dimension) => dimension.outcome === 'ready')).toBe(true);
  });

  test('a well-supported poor score is zero; a missing run is unknown', async () => {
    const run = await routeRun({ latency: 0, contextWindow: 0, toolSupport: 0, vision: 0, cost: 0, privacy: 0 });
    expect(routeReadinessFrom(run)).toMatchObject({ score: 0, level: 'risky', outcome: 'ready' });
    expect(routeReadinessFrom(null)).toMatchObject({ score: null, level: null, confidence: null, outcome: 'unavailable' });
  });

  test('missing dimensions are held rather than dropped from the denominator', async () => {
    const run = await routeRun();
    const result = routeReadinessFrom({ ...run, readings: { latency: run.readings.latency, cloudTransfer: run.readings.cloudTransfer } });
    expect(result).toMatchObject({ score: null, normalized: null, level: null, outcome: 'held' });
    expect(result.dimensions.find(({ id }) => id === 'context-window')?.score).toBeNull();
  });

  test('non-acting and falsely acting low-confidence dimensions cannot contribute', async () => {
    const run = await routeRun();
    for (const outcome of ['confirm', 'escalate', 'act'] as const) {
      const result = routeReadinessFrom({ ...run, readings: { ...run.readings, latency: { ...run.readings.latency, outcome, confidence: 0.5 } } });
      expect(result).toMatchObject({ score: null, level: null, outcome: 'held' });
      expect(result.dimensions[0]).toMatchObject({ score: null, confidence: 0.5 });
    }
  });

  test('a high-confidence held reading remains held', async () => {
    const run = await routeRun();
    const result = routeReadinessFrom({ ...run, readings: { ...run.readings, latency: { ...run.readings.latency, outcome: 'confirm', confidence: 0.99 } } });
    expect(result.score).toBeNull();
    expect(result.outcome).toBe('held');
  });

  test('invalid numbers and probability distributions never become a score', async () => {
    const run = await routeRun();
    for (const latency of [
      { ...run.readings.latency, normalized: Number.NaN },
      { ...run.readings.latency, confidence: Number.POSITIVE_INFINITY },
      { ...run.readings.latency, normalized: 1.1 },
      { ...run.readings.latency, probabilities: [0, 0, 0, 0, 0] },
    ]) {
      expect(routeReadinessFrom({ ...run, readings: { ...run.readings, latency } })).toMatchObject({ score: null, level: null, outcome: 'held' });
    }
  });

  test('uncertain or missing cloud-transfer judgment gates privacy and aggregate', async () => {
    const run = await routeRun();
    const cloudTransfer = { kind: 'yes-no', probability: 0.5, verdict: 'uncertain', outcome: 'escalate' } as const;
    const uncertain = routeReadinessFrom({ ...run, readings: { ...run.readings, cloudTransfer } });
    expect(uncertain.score).toBeNull();
    expect(uncertain.cloudTransfer.value).toBeNull();
    expect(uncertain.dimensions.find(({ id }) => id === 'privacy')).toMatchObject({ score: null, outcome: 'held' });
    expect(uncertain.dimensions.find(({ id }) => id === 'cost')?.score).toBe(100);
    const { port } = fakePort((_name, question) => scoreAnswer(question, 4));
    const subset = await routeReadiness.run(port, {}, { only: routeReadiness.composite.dimensions.map(({ reading }) => reading) });
    expect(routeReadinessFrom(subset)).toMatchObject({ score: null, outcome: 'held' });
  });

  test('settled yes and no cloud-transfer readings are facts, not hardcoded privacy penalties', async () => {
    const run = await routeRun();
    const cloudTransfer = { ...run.readings.cloudTransfer, probability: 0.95, verdict: 'yes' } as const;
    expect(routeReadinessFrom({ ...run, readings: { ...run.readings, cloudTransfer } })).toMatchObject({ score: 100, outcome: 'ready', cloudTransfer: { value: true } });
  });

  test('preserves every explicit non-answer without a fabricated score', () => {
    const outcomes: readonly ModelReadinessHeldOutcome[] = ['held', 'rejected', 'deferred', 'unavailable'];
    for (const outcome of outcomes) {
      const input = { outcome, decisionId: 'failed-decision', reason: 'This attempt cannot supply a usable reading.' };
      expect(routeReadinessFrom(input)).toMatchObject({ score: null, normalized: null, level: null, outcome, decisionId: 'failed-decision' });
      expect(localRecipeFitFrom(input)).toMatchObject({ score: null, normalized: null, level: null, memoryTier: null, outcome, decisionId: 'failed-decision' });
      expect(modelReadinessFlagFrom(input, 'exampleVision')).toMatchObject({ value: null, probability: null, outcome, decisionId: 'failed-decision' });
    }
  });
});

describe('independent example-vision readings', () => {
  test('each example is asked separately and an uncertain answer stays nullable', async () => {
    const { port, requests } = fakePort((_name, _question, state) => noulAnswer(JSON.stringify(state).includes('image-capable') ? 0.95 : 0.5));
    const image = await routeReadiness.run(port, { exampleModel: 'image-capable model' }, { only: ['exampleVision'] });
    const unknown = await routeReadiness.run(port, { exampleModel: 'unfamiliar model' }, { only: ['exampleVision'] });
    expect(requests).toHaveLength(2);
    expect(Object.keys(requests[0]!.questions)).toEqual(['exampleVision']);
    expect(modelReadinessFlagFrom(image, 'exampleVision')).toMatchObject({ value: true, outcome: 'ready' });
    expect(modelReadinessFlagFrom(unknown, 'exampleVision')).toMatchObject({ value: null, outcome: 'held' });
    expect(routeReadinessFrom(image).score).toBeNull();
  });

  test('inconsistent yes/no side cannot masquerade as settled', async () => {
    const run = await routeRun();
    const exampleVision = { ...run.readings.exampleVision, probability: 0.01, verdict: 'yes', outcome: 'act' } as const;
    expect(modelReadinessFlagFrom({ ...run, readings: { exampleVision } }, 'exampleVision')).toMatchObject({ value: null, outcome: 'held' });
  });
});

describe('local-recipe fit and memory adequacy', () => {
  test('fit comes solely from its reading; memory labels come from the memory rubric', async () => {
    for (const [memory, memoryTier] of localRecipeFit.composite.memoryTiers.entries()) {
      expect(localRecipeFitFrom(await fitRun(3, memory))).toMatchObject({ score: 75, normalized: 0.75, level: 'good', memoryTier, outcome: 'ready' });
    }
  });

  test('held memory gates both fit score and memory tier', async () => {
    const run = await fitRun();
    const result = localRecipeFitFrom({ ...run, readings: { ...run.readings, memoryAdequacy: { ...run.readings.memoryAdequacy, outcome: 'confirm', confidence: 0.6 } } });
    expect(result).toMatchObject({ score: null, level: null, memoryTier: null, outcome: 'held', confidence: 0.6 });
    expect(result.fit.score).toBe(100);
  });

  test('a missing fit or memory reading produces no aggregate', async () => {
    const run = await fitRun();
    expect(localRecipeFitFrom({ ...run, readings: { fit: run.readings.fit } })).toMatchObject({ score: null, memoryTier: null, outcome: 'held' });
    expect(localRecipeFitFrom({ ...run, readings: { memoryAdequacy: run.readings.memoryAdequacy } })).toMatchObject({ score: null, memoryTier: null, outcome: 'held' });
  });
});
