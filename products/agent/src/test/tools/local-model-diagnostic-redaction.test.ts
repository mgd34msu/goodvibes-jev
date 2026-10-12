import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { CommandContext } from '../../input/command-registry.ts';
import { localModelCookbook, readLocalModelCookbook } from '../../tools/agent-harness-local-model-cookbook.ts';
import { localModelServerEndpoints, localModelServerHealthMap } from '../../tools/agent-harness-local-model-endpoints.ts';
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { cleanupResearchScreeningFixtures, researchScreeningFixture } from '../helpers/research-screening.ts';
import { cliRedactionAnswer } from '../helpers/cli-redaction-readings.ts';
import { localRecipeFit, routeReadiness } from '@goodvibes-jev/engine/sdk/platform/routing';
import { localModelRecipes } from '../../tools/agent-harness-local-model-cookbook.ts';

afterAll(cleanupResearchScreeningFixtures);

function localDiagnosticReadings() {
  const fields = new Set(['servers', 'providerId', 'baseUrl', 'status', 'summary', 'resourceSummary', 'publicationGuarantee', 'startRoute', 'provenance']);
  const knownSources = new Set<string>();
  const owner = researchScreeningFixture({ beforeProposal: async source => {
    for (const part of source.parts) {
      try { knownSources.add(JSON.stringify(JSON.parse(part))); }
      catch { /* Framed fragments cannot authorize a complete readiness state. */ }
    }
  } });
  const authoredRecipes = localModelRecipes();
  const questions = new Map([...Object.entries(localRecipeFit.items), ...Object.entries(routeReadiness.items)]
    .map(([name, item]) => [name, JSON.stringify(item.question)]));
  const exactKeys = (state: Record<string, unknown>, keys: readonly string[]) => JSON.stringify(Object.keys(state).sort()) === JSON.stringify([...keys].sort());
  const recipeMatches = (value: unknown) => authoredRecipes.some(recipe => JSON.stringify(value) === JSON.stringify(recipe));
  const supportedReadinessState = (name: string, state: unknown): boolean => {
    if (!knownSources.has(JSON.stringify(state)) || state === null || typeof state !== 'object' || Array.isArray(state)) return false;
    const input = state as Record<string, unknown>;
    if (name === 'fit' || name === 'memoryAdequacy') return exactKeys(input, ['recipe', 'hardware', 'detection', 'rubric']) && recipeMatches(input.recipe);
    if (name === 'exampleVision' && Object.hasOwn(input, 'exampleModel')) {
      if (!exactKeys(input, ['exampleModel', 'rubric'])) return false;
      const example = input.exampleModel as { id?: unknown; facts?: unknown } | null;
      return example !== null && typeof example === 'object' && exactKeys(example, ['id', 'facts']) && authoredRecipes.some(recipe =>
        recipe.modelExamples.includes(example.id as string) && JSON.stringify(example.facts) === JSON.stringify({ advertisedCapabilities: null, recipeRequirements: recipe.hardware }));
    }
    return exactKeys(input, ['subject', 'rubric', 'detected', 'benchmarkEvidence', 'localFit', 'exampleVision', 'provider', 'capabilities', 'contextWindow', 'measuredLatency', 'cost']) && recipeMatches(input.subject);
  };
  const readings = fakePort((name, question, state) => {
    if (name === 'kind' && state !== null && typeof state === 'object' && !Array.isArray(state) && typeof state.field === 'string' && fields.has(state.field)) return choiceAnswer(question, 'other', 0.999);
    if (name === 'route' && question.type === 'choice' && Object.hasOwn(question.criteria, 'not-local')) return choiceAnswer(question, 'ollama', 0.999);
    if (name === 'status' && question.type === 'choice' && Object.hasOwn(question.criteria, 'ready')) return choiceAnswer(question, 'ready', 0.999);
    if (questions.get(name) === JSON.stringify(question)) {
      if (!supportedReadinessState(name, state)) throw new Error('Unexpected complete recipe readiness fixture state.');
      if (question.type === 'score') return scoreAnswer(question, 0, 0.5);
      if (name === 'cloudTransfer' || name === 'exampleVision') return noulAnswer(0.5);
    }
    if (question.type === 'score') throw new Error('Unauthored recipe score fixture question.');
    if (name === 'identifying') return noulAnswer(0.001);
    return cliRedactionAnswer(name, question, state);
  });
  return { ...readings, sourceOwner: owner.owner };
}

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

function fixture() {
  let reads = 0;
  const snapshot = { servers: [{ providerId: 'ollama-fixture', baseUrl: 'http://127.0.0.1:11434/v1', status: 'ready',
    summary: 'password=local-diagnostic-private-fixture', resourceSummary: 'password=resource-private-fixture',
    publicationGuarantee: 'password=publication-private-fixture', startRoute: 'password=start-private-fixture',
    provenance: ['password=provenance-private-fixture'] }] };
  const provider = { id: 'ollama-fixture', baseURL: 'http://127.0.0.1:11434/v1' };
  const context = {
    provider: { providerRegistry: { listModels: () => [], listProviders: () => [provider] } },
    clients: { providerApi: { listProviderIds: () => ['ollama-fixture'] } },
    platform: { configManager: { get: () => undefined }, artifactStore: { list: () => [] },
      readModels: { models: { servingDiagnostics: { getSnapshot() { reads++; return snapshot; } } } } },
  } as unknown as CommandContext;
  return { context, snapshot, reads: () => reads };
}

describe('local model serving diagnostic shared redaction', () => {
  test('startup cookbook reads mechanical facts without diagnostics or a reading port', () => {
    const f = fixture();
    const result = localModelCookbook(f.context, true);
    expect(f.reads()).toBe(0);
    expect(result.enrichment).toBe('deferred');
    expect(JSON.stringify(result)).toContain('http://127.0.0.1:11434/v1');
    expect(JSON.stringify(result)).not.toContain('local-diagnostic-private-fixture');
    expect(JSON.stringify(result)).not.toContain('servingDiagnostics');
  });

  test('explicit inspection awaits the public redactor for all diagnostic prose before returning', async () => {
    const f = fixture(), readings = localDiagnosticReadings(); installJudgmentPort(readings.port);
    const original = JSON.stringify(f.snapshot);
    const assertCurrent = () => { if (JSON.stringify(f.snapshot) !== original) throw new Error('Fixture diagnostic source changed.'); };
    const result = await readLocalModelCookbook(f.context, true, { assertCurrent, sourceOwner: readings.sourceOwner });
    const serialized = JSON.stringify(result);
    expect(f.reads()).toBeGreaterThan(0);
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).toContain('published-read-model');
    expect(serialized).not.toContain('private-fixture');
    expect(JSON.stringify(readings.requests)).not.toContain('private-fixture');
    expect(JSON.stringify(f.snapshot)).toBe(original);
  });

  test.each(['cancel', 'source replacement', 'port retirement'] as const)('%s during redaction prevents a diagnostic outcome', async mode => {
    const f = fixture(), readings = localDiagnosticReadings();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const ask = readings.port.ask.bind(readings.port);
    const tails: Array<ReturnType<typeof ask>> = [];
    readings.port.ask = request => {
      const tail = (async () => { entered.resolve(); await release.promise; return ask(request); })();
      tails.push(tail); return tail;
    };
    installJudgmentPort(readings.port);
    const cancel = new AbortController(), original = JSON.stringify(f.snapshot);
    const assertCurrent = () => { if (JSON.stringify(f.snapshot) !== original) throw new Error('Fixture diagnostic source changed.'); };
    const pending = (mode === 'port retirement' ? localModelServerEndpoints(f.context, true, { signal: cancel.signal, assertCurrent, sourceOwner: readings.sourceOwner })
      : localModelServerHealthMap(f.context, true, { signal: cancel.signal, assertCurrent, sourceOwner: readings.sourceOwner }))
      .then(() => undefined, (error: unknown) => error);
    const timer = setTimeout(() => entered.reject(new Error('Diagnostic control did not enter a reading.')), 2_000);
    try {
      await entered.promise;
      if (mode === 'cancel') cancel.abort();
      else if (mode === 'source replacement') f.snapshot.servers[0]!.summary = 'A newer safe observation.';
      else installJudgmentPort(localDiagnosticReadings().port);
      release.resolve();
      expect(await pending).toBeInstanceOf(Error);
      expect(JSON.stringify(readings.requests)).not.toContain('private-fixture');
    } finally { clearTimeout(timer); cancel.abort(); release.resolve(); await pending; await Promise.allSettled(tails); }
  });
});
