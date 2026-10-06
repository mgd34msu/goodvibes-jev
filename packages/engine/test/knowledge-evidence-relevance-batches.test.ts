import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { prepareAnswerEvidenceRelevanceBatches } from '../sdk/src/platform/knowledge/semantic/evidence-ranking/batch.js';
import { prepareAnswerEvidenceRelevance, KnowledgeEvidenceRelevanceHeldError,
  type AnswerEvidenceCandidate, type EvidenceRelevanceHoldReason } from '../sdk/src/platform/knowledge/semantic/evidence-ranking/reader.js';

let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
const query = 'Which reference describes the television features?';
function candidate(index: number, large = false): AnswerEvidenceCandidate {
  return { reference: `candidate-${index}`, kind: 'source', title: `Reference ${index}`,
    text: large ? `${'x'.repeat(128 * 1024)}\nLate qualifier ${index}.` : `Complete evidence ${index}.` };
}
function readings(value: (reference: string) => number = () => 0.97) {
  const fake = fakePort((_name, _question, state) => noulAnswer(value((state as { candidate: { reference: string } }).candidate.reference)));
  installJudgmentPort(fake.port); return fake;
}
async function held(work: Promise<unknown>, reason: EvidenceRelevanceHoldReason) {
  let error: unknown; try { await work; } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(KnowledgeEvidenceRelevanceHeldError);
  expect((error as KnowledgeEvidenceRelevanceHeldError).reason).toBe(reason);
}

describe('complete-candidate bounded relevance batches', () => {
  test('reads a real candidate and 32 complete 128 KiB decoys without a corpus-sized request', async () => {
    const candidates = [candidate(1), ...Array.from({ length: 32 }, (_, index) => candidate(index + 2, true))];
    const fake = readings((reference) => reference === 'candidate-1' ? 0.99 : 0.01);
    const plan = await prepareAnswerEvidenceRelevanceBatches({ query, candidates });
    expect(plan.accepted.map((entry) => entry.reference)).toEqual(['candidate-1']);
    expect(plan.rejected).toHaveLength(32); expect(fake.requests).toHaveLength(33);
    for (const [index, request] of fake.requests.entries()) {
      expect((request.state as unknown as { candidate: AnswerEvidenceCandidate }).candidate.text).toBe(candidates[index]!.text);
      expect(JSON.stringify(request.state).length).toBeLessThan(160_000);
    }
    expect(plan.model).toBe('jev-1.13.0'); expect(plan.requestedModel).toBe('jev-1.13.0');
    expect(plan.inputHash).toHaveLength(64); expect(Object.isFrozen(plan.accepted)).toBe(true);
  });
  test('considers candidates beyond the unchanged 100-candidate per-reader boundary', async () => {
    const candidates = Array.from({ length: 105 }, (_, index) => candidate(index + 1));
    const fake = readings((reference) => reference === 'candidate-105' ? 0.99 : 0.01);
    const plan = await prepareAnswerEvidenceRelevanceBatches({ query, candidates });
    expect(plan.accepted.map((entry) => entry.reference)).toEqual(['candidate-105']);
    expect(plan.rejected).toHaveLength(104); expect(fake.requests).toHaveLength(105);
  });
  test('partitioning preserves exact request state, references, probabilities and global tie order', async () => {
    const candidates = [candidate(8, true), candidate(2, true), candidate(4, true)];
    const subjects = [{ title: 'Television', kind: 'ha_device', aliases: ['Display'], identity: { model: 'TV-EU' } }];
    const fake = readings((reference) => reference === 'candidate-8' ? 0.82 : 0.97);
    const batched = await prepareAnswerEvidenceRelevanceBatches({ query, candidates, subjects });
    const states = fake.requests.map((request) => request.state);
    const independent = [];
    for (const entry of candidates) independent.push(await prepareAnswerEvidenceRelevance({ query, candidates: [entry], subjects }));
    expect(fake.requests.slice(3).map((request) => request.state)).toEqual(states);
    expect(batched.accepted.map(({ reference, probability }) => [reference, probability])).toEqual([
      ['candidate-2', 0.97], ['candidate-4', 0.97], ['candidate-8', 0.82],
    ]);
    expect(independent.flatMap((plan) => plan.accepted).sort((a, b) => b.probability - a.probability)).toEqual([...batched.accepted]);
  });
  test('a protected final candidate blocks every earlier batch before any transmission', async () => {
    const fake = readings();
    const candidates = Array.from({ length: 102 }, (_, index) => candidate(index + 1));
    candidates.push({ ...candidate(103, true), text: `${'x'.repeat(128 * 1024)}\nAuthorization: Bearer synthetic-fixture` });
    await expect(prepareAnswerEvidenceRelevanceBatches({ query, candidates })).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(0);
  });
  test('late malformed and duplicate candidates hold before any earlier batch runs', async () => {
    const fake = readings();
    await held(prepareAnswerEvidenceRelevanceBatches({ query, candidates: [candidate(1, true), candidate(2, true), candidate(1)] }), 'malformed');
    await held(prepareAnswerEvidenceRelevanceBatches({ query, candidates: [candidate(1, true),
      { ...candidate(2), extra: 'not part of this DTO' } as AnswerEvidenceCandidate] }), 'malformed');
    expect(fake.requests).toHaveLength(0);
  });
  test('one oversized complete candidate holds without clipping or raising the reader limit', async () => {
    const fake = readings();
    await held(prepareAnswerEvidenceRelevanceBatches({ query, candidates: [candidate(1), { ...candidate(2), text: 'x'.repeat(160_000) }] }), 'budget');
    expect(fake.requests).toHaveLength(0);
  });
  test('candidate and envelope accessors never execute during corpus preparation', async () => {
    const fake = readings(); let invoked = 0;
    const second = { ...candidate(2), get text() { invoked++; return 'unsafe'; } };
    await expect(prepareAnswerEvidenceRelevanceBatches({ query, candidates: [candidate(1, true), second] })).rejects.toBeInstanceOf(JudgmentInputError);
    await expect(prepareAnswerEvidenceRelevanceBatches({ query, get candidates() { invoked++; return []; } })).rejects.toBeInstanceOf(JudgmentInputError);
    const candidates = [candidate(1), candidate(2)];
    Object.defineProperty(candidates, '1', { get() { invoked++; return candidate(2); } });
    await expect(prepareAnswerEvidenceRelevanceBatches({ query, candidates })).rejects.toBeInstanceOf(JudgmentInputError);
    expect(invoked).toBe(0); expect(fake.requests).toHaveLength(0);
  });
  test('mutating a later input cannot alter its captured complete meaning', async () => {
    const first = candidate(1, true), second = candidate(2, true); const fake = readings();
    installJudgmentPort({ ...fake.port, async ask(request) {
      (second as { text: string }).text = 'MUTATED'; return fake.port.ask(request);
    } });
    await prepareAnswerEvidenceRelevanceBatches({ query, candidates: [first, second] });
    expect((fake.requests[1]!.state as unknown as { candidate: AnswerEvidenceCandidate }).candidate.text).toContain('Late qualifier 2.');
  });
  test('different actual or requested models across batches cannot supply one ranking', async () => {
    for (const field of ['model', 'requestedModel'] as const) {
      const fake = readings(); let index = 0;
      installJudgmentPort({ ...fake.port, async ask(request) { return { ...await fake.port.ask(request), [field]: `model-${++index}` }; } });
      await held(prepareAnswerEvidenceRelevanceBatches({ query, candidates: [candidate(1, true), candidate(2, true)] }), 'stale');
    }
  });
  test('reconfiguration and caller stale guards prevent dispatching a later batch', async () => {
    const fake = readings();
    installJudgmentPort({ ...fake.port, async ask(request) {
      const result = await fake.port.ask(request); installJudgmentPort(fakePort(() => noulAnswer(0.99)).port); return result;
    } });
    await held(prepareAnswerEvidenceRelevanceBatches({ query, candidates: [candidate(1, true), candidate(2, true)] }), 'stale');
    expect(fake.requests).toHaveLength(1);
    const guarded = readings(); let stale = false;
    installJudgmentPort({ ...guarded.port, async ask(request) { stale = true; return guarded.port.ask(request); } });
    await held(prepareAnswerEvidenceRelevanceBatches({ query, candidates: [candidate(1), candidate(2), candidate(3), candidate(4)] },
      { assertCurrent() { if (stale) throw new KnowledgeEvidenceRelevanceHeldError('stale'); } }), 'stale');
    expect(guarded.requests).toHaveLength(1);
  });
  test('a late uncertain or unavailable reading never returns a partial earlier success', async () => {
    readings((reference) => reference === 'candidate-2' ? 0.6 : 0.99);
    await held(prepareAnswerEvidenceRelevanceBatches({ query, candidates: [candidate(1, true), candidate(2, true)] }), 'unsettled');
    const fake = readings(); let count = 0;
    installJudgmentPort({ ...fake.port, async ask(request) { if (++count === 2) throw new Error('synthetic unavailable'); return fake.port.ask(request); } });
    await held(prepareAnswerEvidenceRelevanceBatches({ query, candidates: [candidate(1, true), candidate(2, true)] }), 'unavailable');
  });
  test('one shared deadline aborts ignored-signal readers and prevents later dispatch', async () => {
    const fake = readings(); let signal: AbortSignal | undefined, count = 0;
    installJudgmentPort({ ...fake.port, async ask(request) { signal = request.signal; count++; return new Promise(() => {}); } });
    await held(prepareAnswerEvidenceRelevanceBatches({ query, candidates: [candidate(1), candidate(2)] }, { timeoutMs: 30 }), 'budget');
    expect(signal?.aborted).toBe(true); expect(count).toBe(2);
    const controller = new AbortController();
    const work = prepareAnswerEvidenceRelevanceBatches({ query, candidates: [candidate(1)] }, { signal: controller.signal });
    controller.abort(); await held(work, 'aborted'); expect(signal?.aborted).toBe(true);
  });
  test('deadline is not renewed at a later batch', async () => {
    const fake = readings(); let count = 0;
    installJudgmentPort({ ...fake.port, async ask(request) {
      count++; await new Promise((resolve) => setTimeout(resolve, 20)); return fake.port.ask(request);
    } });
    await held(prepareAnswerEvidenceRelevanceBatches({ query, candidates: [candidate(1, true), candidate(2, true), candidate(3, true)] }, { timeoutMs: 35 }), 'budget');
    expect(count).toBeLessThan(3);
  });
  test('missing ports are held and empty requests need none', async () => {
    await held(prepareAnswerEvidenceRelevanceBatches({ query, candidates: [candidate(1)] }), 'unconfigured');
    expect((await prepareAnswerEvidenceRelevanceBatches({ query, candidates: [] })).accepted).toEqual([]);
    expect((await prepareAnswerEvidenceRelevanceBatches({ query: ' ', candidates: [candidate(1)] })).accepted).toEqual([]);
  });
});
