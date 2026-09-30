import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { prepareAnswerEvidenceRelevance, KnowledgeEvidenceRelevanceHeldError, type AnswerEvidenceCandidate, type EvidenceRelevanceHoldReason } from '../sdk/src/platform/knowledge/semantic/evidence-ranking/reader.js';
import { answerEvidenceRelevance } from '../sdk/src/platform/knowledge/semantic/evidence-ranking/battery.js';
import { registry } from '../sdk/src/platform/knowledge/semantic/evidence-ranking/judgment-registry.js';
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
function candidate(reference = 'candidate-1', kind: 'source' | 'node' = 'source'): AnswerEvidenceCandidate {
  return { reference, kind, title: 'AC-7', text: 'The AC-7 has four network ports and does not support Bluetooth.' };
}
function input(candidates = [candidate()]) { return { query: 'How many wired ports does AC-7 have?', candidates }; }
function readings(probability: (state: unknown) => number = () => 0.97) {
  const fake = fakePort((_name, _question, state) => noulAnswer(probability(state))); installJudgmentPort(fake.port); return fake;
}
async function held(work: Promise<unknown>, reason: EvidenceRelevanceHoldReason) {
  let error: unknown; try { await work; } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(KnowledgeEvidenceRelevanceHeldError); expect((error as KnowledgeEvidenceRelevanceHeldError).reason).toBe(reason);
}
describe('initial evidence relevance reading foundation', () => {
  test('registers contrary-to-keyword and kind-boost fixtures without claiming live calibration', () => {
    expect(registry.list().map((item) => item.name)).toEqual([answerEvidenceRelevance.name]);
    expect(answerEvidenceRelevance.accuracyFloor).toBe(0.9);
    const names = answerEvidenceRelevance.fixtures.map((fixture) => fixture.name).join(' ');
    for (const word of ['paraphrase', 'keyword', 'kind', 'negative', 'variant', 'instructions', 'quantity']) expect(names).toContain(word);
    expect(answerEvidenceRelevance.fixtures.some((fixture) => fixture.expect.useful === 'yes')).toBe(true);
    expect(answerEvidenceRelevance.fixtures.some((fixture) => fixture.expect.useful === 'no')).toBe(true);
  });
  test('uses actual probabilities, preserves tie order and exact opaque references, never fixed kind points', async () => {
    const candidates = [candidate('candidate-8', 'node'), candidate('candidate-2', 'node'), candidate('candidate-4')];
    readings((state) => (state as { candidate: { reference: string } }).candidate.reference === 'candidate-8' ? 0.82 : 0.97);
    const result = await prepareAnswerEvidenceRelevance(input(candidates));
    expect(result.accepted.map(({ reference }) => reference)).toEqual(['candidate-2', 'candidate-4', 'candidate-8']);
    expect(result.accepted.map(({ probability }) => probability)).toEqual([0.97, 0.97, 0.82]);
    expect(result.inputHash).toHaveLength(64); expect(Object.isFrozen(result.accepted)).toBe(true); expect(Object.isFrozen(result.accepted[0])).toBe(true);
    expect(result.model).toBe('jev-1.13.0'); expect(result.accepted[0]!.decisionId).toBeUndefined();
  });
  test('a fact-kind keyword-stuffed candidate can lose to an entity with real support', async () => {
    const high = { ...candidate('candidate-1', 'node'), nodeKind: 'fact', text: 'Official AC-7 network ports specifications. Buy now.' };
    const low = { ...candidate('candidate-2', 'node'), nodeKind: 'knowledge_entity' };
    readings((state) => (state as { candidate: { nodeKind: string } }).candidate.nodeKind === 'fact' ? 0.01 : 0.99);
    const result = await prepareAnswerEvidenceRelevance(input([high, low]));
    expect(result.accepted.map(({ reference }) => reference)).toEqual(['candidate-2']); expect(result.rejected[0]!.reference).toBe('candidate-1');
  });
  test('settled rejection returns no evidence while uncertainty holds the complete pass', async () => {
    readings(() => 0.01); expect((await prepareAnswerEvidenceRelevance(input())).accepted).toEqual([]);
    readings((state) => (state as { candidate: { reference: string } }).candidate.reference === 'candidate-2' ? 0.6 : 0.99);
    await held(prepareAnswerEvidenceRelevance(input([candidate(), candidate('candidate-2')])), 'unsettled');
  });
  test('the medium-stakes act boundary is explicit and never rescales a malformed percentage', async () => {
    readings(() => 0.75); expect((await prepareAnswerEvidenceRelevance(input())).accepted[0]!.probability).toBe(0.75);
    readings(() => 0.74999); await held(prepareAnswerEvidenceRelevance(input()), 'unsettled');
    for (const bad of [95, -1, NaN, Infinity]) { readings(() => bad); await held(prepareAnswerEvidenceRelevance(input()), 'malformed'); }
  });
  test('preserves full meaning, numeric and boolean values, and real decision IDs', async () => {
    const fake = readings(); installJudgmentPort({ ...fake.port, async ask(request) { return { ...await fake.port.ask(request), decisionId: 'actual-decision' }; } });
    const selected = { ...candidate(), text: `${'Context. '.repeat(700)}Standby is twelve hours only; active use lasts two hours.`,
      facts: [{ title: 'Ports', value: 4 }, { title: 'Bluetooth', value: false, evidence: 'No Bluetooth support.' }] };
    const result = await prepareAnswerEvidenceRelevance(input([selected]));
    const state = fake.requests[0]!.state as { candidate: typeof selected };
    expect(state.candidate.text).toBe(selected.text); expect(state.candidate.facts[0]!.value).toBe(4); expect(state.candidate.facts[1]!.value).toBe(false);
    expect(result.accepted[0]!.decisionId).toBe('actual-decision');
  });
  test('all selected content is preflighted before budget checks or the first transmission', async () => {
    const fake = readings();
    await expect(prepareAnswerEvidenceRelevance(input([candidate(), { ...candidate('candidate-2'), text: `${'Ordinary content. '.repeat(11_000)} Authorization: Bearer synthetic` }]))).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(0);
  });
  test('getters are refused without execution and caller-controlled references cannot bypass guards', async () => {
    const fake = readings(); let invoked = 0;
    const item = { ...candidate(), get text() { invoked++; return 'unsafe'; } };
    await expect(prepareAnswerEvidenceRelevance(input([item]))).rejects.toBeInstanceOf(JudgmentInputError);
    expect(invoked).toBe(0); expect(fake.requests).toHaveLength(0);
    await expect(prepareAnswerEvidenceRelevance(input([candidate('candidate-4111111111111111')]))).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(0);
  });
  test('duplicate references, extra record fields and oversized complete input are held without clipping', async () => {
    const fake = readings();
    await held(prepareAnswerEvidenceRelevance(input([candidate(), candidate()])), 'malformed');
    await held(prepareAnswerEvidenceRelevance(input([{ ...candidate(), metadata: { ignored: 'not part of the DTO' } } as AnswerEvidenceCandidate])), 'malformed');
    await held(prepareAnswerEvidenceRelevance(input([{ ...candidate(), text: 'x'.repeat(161_000) }])), 'budget');
    expect(fake.requests).toHaveLength(0);
  });
  test('request state is deeply immutable and input mutation cannot change later reads', async () => {
    const first = candidate(), second = candidate('candidate-2'); const candidates = [first, second];
    const fake = readings(); let checked = false;
    installJudgmentPort({ ...fake.port, async ask(request) {
      if (!checked) { checked = true; (second as { text: string }).text = 'MUTATED'; }
      const state = request.state as { candidate: { text: string } };
      expect(Object.isFrozen(state)).toBe(true); expect(Object.isFrozen(state.candidate)).toBe(true);
      expect(state.candidate.text).not.toBe('MUTATED'); return fake.port.ask(request);
    } });
    await prepareAnswerEvidenceRelevance(input(candidates)); expect(fake.requests).toHaveLength(2);
  });
  test('missing and unavailable ports are not confused with a settled no', async () => {
    await held(prepareAnswerEvidenceRelevance(input()), 'unconfigured');
    const fake = readings(); installJudgmentPort({ ...fake.port, ask: async () => { throw new Error('backend unavailable'); } });
    await held(prepareAnswerEvidenceRelevance(input()), 'unavailable');
  });
  test('empty query or candidates requires no semantic port', async () => {
    expect((await prepareAnswerEvidenceRelevance(input([]))).accepted).toEqual([]);
    expect((await prepareAnswerEvidenceRelevance({ ...input(), query: '   ' })).accepted).toEqual([]);
  });
  test('mixed actual models cannot supply comparable ranking probabilities', async () => {
    const fake = readings(); let index = 0;
    installJudgmentPort({ ...fake.port, async ask(request) { return { ...await fake.port.ask(request), model: `model-${++index}` }; } });
    await held(prepareAnswerEvidenceRelevance(input([candidate(), candidate('candidate-2')])), 'stale');
  });
  test('reconfiguration during a reading cannot silently reuse a prior port result', async () => {
    const fake = readings();
    installJudgmentPort({ ...fake.port, async ask(request) {
      const result = await fake.port.ask(request);
      installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
      return result;
    } });
    await held(prepareAnswerEvidenceRelevance(input()), 'stale');
  });
  test('total deadline and cancellation settle even when a port ignores its signal', async () => {
    const fake = readings(); installJudgmentPort({ ...fake.port, ask: async () => new Promise(() => {}) });
    await held(prepareAnswerEvidenceRelevance(input(), { timeoutMs: 10 }), 'budget');
    const controller = new AbortController(); const work = prepareAnswerEvidenceRelevance(input(), { signal: controller.signal }); controller.abort();
    await held(work, 'aborted');
  });
  test('concurrency stays bounded and every selected candidate is read exactly once', async () => {
    const fake = readings(); let active = 0, maximum = 0;
    installJudgmentPort({ ...fake.port, async ask(request) { active++; maximum = Math.max(maximum, active); await new Promise((resolve) => setTimeout(resolve, 2)); const result = await fake.port.ask(request); active--; return result; } });
    const candidates = Array.from({ length: 25 }, (_, index) => candidate(`candidate-${index + 1}`));
    const result = await prepareAnswerEvidenceRelevance(input(candidates));
    expect(maximum).toBeLessThanOrEqual(4); expect(result.accepted).toHaveLength(25); expect(fake.requests).toHaveLength(25);
  });
});
