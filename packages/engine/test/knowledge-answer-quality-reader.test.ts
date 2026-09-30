import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { verifyKnowledgeAnswer, KnowledgeAnswerQualityHeldError, type AnswerVerificationInput } from '../sdk/src/platform/knowledge/semantic/answer-verification/reader.js';
import { answerCandidateQuality, answerEvidenceSufficiency, answerCandidatePreference } from '../sdk/src/platform/knowledge/semantic/answer-verification/batteries.js';
import { registry } from '../sdk/src/platform/knowledge/semantic/answer-verification/judgment-registry.js';

let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
const input = (): AnswerVerificationInput => ({ query: 'How many ports does AC-7 have?',
  evidence: [{ reference: 'evidence-1', title: 'AC-7 manual', text: 'AC-7 has four HDMI ports.' }],
  candidates: [{ id: 'generated', text: 'AC-7 has four HDMI ports. [ref:evidence-1]' }, { id: 'rendered', text: 'HDMI ports: four.' }],
});
function readings(options: { enough?: number; complete?: number; fidelity?: 'supported' | 'contradicted' | 'unsupported'; confidence?: number; preference?: 'generated' | 'rendered'; generatedFidelity?: 'supported' | 'contradicted' | 'unsupported' } = {}) {
  const fake = fakePort((name, question, state) => {
    if (name === 'enough') return noulAnswer(options.enough ?? 0.99);
    if (name === 'complete') return noulAnswer(options.complete ?? 0.99);
    if (name === 'fidelity') return choiceAnswer(question, (state as { candidate: { id: string } }).candidate.id === 'generated'
      ? options.generatedFidelity ?? options.fidelity ?? 'supported' : options.fidelity ?? 'supported', options.confidence ?? 0.97);
    if (name === 'preferred') return choiceAnswer(question, options.preference ?? 'generated', 0.97);
    throw new Error('Unexpected answer quality question');
  }); installJudgmentPort(fake.port); return fake;
}
async function held(promise: Promise<unknown>, reason: KnowledgeAnswerQualityHeldError['reason']) {
  const error = await promise.catch((value: unknown) => value);
  expect(error).toBeInstanceOf(KnowledgeAnswerQualityHeldError);
  expect((error as KnowledgeAnswerQualityHeldError).reason).toBe(reason);
}

describe('answer fidelity, sufficiency and confidence readings', () => {
  test('registers versioned fixture-bearing batteries', () => {
    expect(registry.list()).toHaveLength(3);
    for (const battery of registry.list()) { expect(battery.version).toBe(1); expect(battery.accuracyFloor).toBeGreaterThanOrEqual(0.9); }
  });
  test('display confidence is the supported fidelity probability on the stated 0–100 scale', async () => {
    const fake = readings({ confidence: 0.91, preference: 'rendered' });
    const result = await verifyKnowledgeAnswer(input());
    expect(result.candidate?.id).toBe('rendered'); expect(result.confidence).toBe(91);
    expect(result.quality.status).toBe('verified'); expect(result.quality.fidelity?.probability).toBe(0.91);
    expect(result.quality.decisionIds).toEqual([]); expect(fake.requests).toHaveLength(4);
  });
  test('a single decisive fact can be sufficient despite small counts', async () => {
    readings(); const result = await verifyKnowledgeAnswer({ ...input(), candidates: input().candidates.slice(0, 1) });
    expect(result.quality.evidenceSufficient?.verdict).toBe('yes'); expect(result.quality.status).toBe('verified');
  });
  test('many keyword families cannot overrule an insufficient-evidence reading', async () => {
    readings({ enough: 0.01, complete: 0.01 });
    const result = await verifyKnowledgeAnswer({ ...input(), query: 'What is the warranty?',
      evidence: [{ reference: 'evidence-1', text: 'HDMI USB HDR Wi-Fi Bluetooth audio speakers game VRR HDMI2.1. Warranty is not provided.' }],
    });
    expect(result.quality.status).toBe('partial'); expect(result.confidence).toBe(97);
    expect(result.quality.evidenceSufficient?.verdict).toBe('no'); expect(result.quality.answerComplete?.verdict).toBe('no');
  });
  test('a settled contradicted generation can only yield an independently supported candidate', async () => {
    const fake = readings({ generatedFidelity: 'contradicted' }); const result = await verifyKnowledgeAnswer(input());
    expect(result.candidate?.id).toBe('rendered'); expect(fake.requests.some((request) => 'preferred' in request.questions)).toBe(false);
  });
  test('unsupported candidates return an honest no-selection result', async () => {
    readings({ fidelity: 'unsupported' }); const result = await verifyKnowledgeAnswer(input());
    expect(result.candidate).toBeUndefined(); expect(result.confidence).toBe(0); expect(result.quality.status).toBe('unsupported');
  });
  test('uncertainty does not fall back to the other candidate or confidence points', async () => {
    readings({ confidence: 0.8 }); await held(verifyKnowledgeAnswer(input()), 'uncertain');
    readings({ enough: 0.5 }); await held(verifyKnowledgeAnswer(input()), 'uncertain');
  });
  test('absent and failed ports report unavailable distinctly', async () => {
    await held(verifyKnowledgeAnswer(input()), 'unavailable');
    const fake = readings(); installJudgmentPort({ ...fake.port, async ask() { throw new Error('offline'); } });
    await held(verifyKnowledgeAnswer(input()), 'unavailable');
  });
  test('no extracted evidence never authorizes a candidate or spends on a port', async () => {
    const fake = readings(); const result = await verifyKnowledgeAnswer({ ...input(), evidence: [], candidates: [{ id: 'rendered', text: 'No evidence available.' }] });
    expect(result.quality.status).toBe('no-evidence'); expect(result.confidence).toBe(0); expect(result.candidate).toBeUndefined(); expect(fake.requests).toHaveLength(0);
  });
  test('a protected later candidate blocks all requests before transmission', async () => {
    const fake = readings();
    await expect(verifyKnowledgeAnswer({ ...input(), candidates: [input().candidates[0]!, { id: 'rendered', text: 'Authorization: Bearer synthetic-protected' }] })).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(0);
  });
  test('citation labels must belong to the supplied reference set', async () => {
    const fake = readings(); await held(verifyKnowledgeAnswer({ ...input(), candidates: [{ id: 'generated', text: 'Four ports [ref:evidence-99]' }] }), 'malformed');
    expect(fake.requests).toHaveLength(0);
  });
  test('incomplete and malformed citation markers cannot evade structural validation', async () => {
    const fake = readings();
    for (const marker of ['[ref:', '[ref:evidence-1', '[ref:evidence-01]', '[ref:evidence-1 trailing]']) {
      await held(verifyKnowledgeAnswer({ ...input(), candidates: [{ id: 'generated', text: `Four ports ${marker}` }] }), 'malformed');
    }
    expect(fake.requests).toHaveLength(0);
  });
  test('malformed choice probabilities cannot produce a confident answer', async () => {
    const fake = readings(); installJudgmentPort({ ...fake.port, async ask(request) {
      const response = await fake.port.ask(request); if (!('fidelity' in request.questions)) return response;
      return { ...response, answers: { ...response.answers, fidelity: { type: 'choice', choice: 'supported', confidence: NaN, probabilities: { supported: 1, contradicted: 0, unsupported: 0 } } } } as typeof response;
    } }); await held(verifyKnowledgeAnswer(input()), 'malformed');
  });
  test('deadline bounds a port that ignores cancellation and prevents preference calls', async () => {
    const fake = readings(); const released = Promise.withResolvers<void>();
    installJudgmentPort({ ...fake.port, async ask(request) { await released.promise; return fake.port.ask(request); } });
    await held(verifyKnowledgeAnswer(input(), { timeoutMs: 5 }), 'budget'); released.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(fake.requests.some((request) => 'preferred' in request.questions)).toBe(false);
  });
  test('pre-aborted verification acquires no port', async () => {
    const fake = readings(); const controller = new AbortController(); controller.abort();
    await held(verifyKnowledgeAnswer(input(), { signal: controller.signal }), 'aborted'); expect(fake.requests).toHaveLength(0);
  });
  test('request and selected answer snapshots are immutable across caller mutation', async () => {
    const fake = readings(); const started = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
    installJudgmentPort({ ...fake.port, async ask(request) { started.resolve(); await released.promise; return fake.port.ask(request); } });
    const candidate = input(); const pending = verifyKnowledgeAnswer(candidate); await started.promise;
    Object.assign(candidate.candidates[0]!, { text: 'Caller mutated after read started.' }); released.resolve();
    const result = await pending; expect(result.candidate?.text).toContain('four HDMI ports'); expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(fake.requests)).not.toContain('Caller mutated');
  });
  test('sparse evidence arrays hold rather than producing unvalidated nulls', async () => {
    const fake = readings(); const candidate = input();
    await held(verifyKnowledgeAnswer({ ...candidate, evidence: [{ ...candidate.evidence[0]!, facts: Array<string>(2) }] }), 'malformed');
    expect(fake.requests).toHaveLength(0);
  });
  test('actual decision IDs are retained without inventing IDs for unlogged readings', async () => {
    const fake = readings(); let counter = 0;
    installJudgmentPort({ ...fake.port, async ask(request) { return { ...await fake.port.ask(request), decisionId: `synthetic-decision-${++counter}` }; } });
    const result = await verifyKnowledgeAnswer(input());
    expect(result.quality.decisionIds).toHaveLength(4);
    expect(new Set(result.quality.decisionIds).size).toBe(4);
  });

  test('labelled positive, partial, conflicting and unsupported fixtures exercise registered gate plumbing', async () => {
    for (const battery of [answerCandidateQuality, answerEvidenceSufficiency, answerCandidatePreference]) {
      const port = fakePort((name, question, state) => {
        const fixture = battery.fixtures.find((fixture) => JSON.stringify(fixture.state) === JSON.stringify(state));
        if (!fixture) throw new Error('Unknown labelled fixture');
        const expected = (fixture.expect as Record<string, string>)[name];
        return question.type === 'choice' ? choiceAnswer(question, expected!, 0.99) : noulAnswer(expected === 'yes' ? 0.99 : 0.01);
      });
      const checks = await battery.checkFixtures(port.port);
      expect(checks.every((check) => check.correct)).toBe(true);
    }
  });

});
