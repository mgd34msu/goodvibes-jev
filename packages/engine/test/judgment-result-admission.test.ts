import { describe, expect, test } from 'bun:test';
import { captureStrictJudgmentJson, prepareJudgmentResult, JudgmentResultAdmissionError } from '../sdk/src/platform/gate/judgment-result.ts';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.ts';
import { choice, noul, type JudgmentResult, type Questions } from '@goodvibes-jev/judgment';

const questions = () => ({ flag: noul('Does the synthetic statement hold?'), pick: choice('Pick the matching synthetic option.', { a: 'A', b: 'B' }) });
function response() {
  return { answers: { flag: { type: 'noul', noul: 0.4111111111111111 }, pick: { type: 'choice', choice: 'a', confidence: 0.9991234567890123, probabilities: { a: 0.8, b: 0.2 } } },
    requestedModel: 'jev-1.13.0', model: 'jev-1.13.0', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1, requestId: undefined,
  } satisfies JudgmentResult<Questions>;
}

describe('complete original judgment response admission', () => {
  test('retains exact protocol probabilities without rounding or treating their digits as text', () => {
    const original = response();
    const prepared = prepareJudgmentResult(questions());
    const admitted = prepared.capture(original);
    expect(admitted).toEqual(original);
    expect(admitted).not.toBe(original);
    expect(admitted.answers.flag.noul).toBe(0.4111111111111111);
    expect(admitted.answers.pick.confidence).toBe(0.9991234567890123);
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.answers.pick.probabilities)).toBe(true);
    original.answers.flag.noul = 0.9;
    expect(admitted.answers.flag.noul).toBe(0.4111111111111111);
  });

  test('screens unknown original response metadata instead of projecting it away', () => {
    const prepared = prepareJudgmentResult(questions());
    expect(() => prepared.capture({ ...response(), extra: 'Authorization: Bearer synthetic-fixture-secret' })).toThrow(JudgmentInputError);
    expect(() => prepared.capture({ ...response(), extra: 0.4111111111111111 })).toThrow(JudgmentInputError);
    expect(() => prepared.capture({ ...response(), answers: { ...response().answers, unknown: { type: 'noul', noul: 0.4111111111111111 } } })).toThrow(JudgmentInputError);
  });

  test('does not exempt extra numeric fields inside an otherwise valid answer', () => {
    const original = response();
    const answer = { ...original.answers.flag, sensitive: 0.4111111111111111 };
    expect(() => prepareJudgmentResult(questions()).capture({ ...original, answers: { ...original.answers, flag: answer } })).toThrow(JudgmentInputError);
  });

  test('refuses hidden fields, symbols and accessors before evaluating any original getter', () => {
    const prepared = prepareJudgmentResult(questions());
    for (const mode of ['hidden', 'symbol', 'getter']) {
      const original = response(); let reads = 0;
      if (mode === 'hidden') Object.defineProperty(original, 'hidden', { value: 'ordinary', enumerable: false });
      else if (mode === 'symbol') Object.defineProperty(original, Symbol('ordinary'), { value: 'ordinary', enumerable: true });
      else Object.defineProperty(original, 'decisionId', { enumerable: true, get() { reads++; return 'borrowed-id'; } });
      expect(() => prepared.capture(original)).toThrow(JudgmentResultAdmissionError);
      expect(reads).toBe(0);
    }
  });

  test('refuses cycles, sparse arrays and exotic objects in complete metadata', () => {
    const original = response();
    const cycle: { child?: unknown } = {}; cycle.child = cycle;
    for (const extra of [cycle, new Array(2), new Date(), new Map(), new Set(), new Proxy({}, {})]) {
      expect(() => prepareJudgmentResult(questions()).capture({ ...original, extra })).toThrow(JudgmentResultAdmissionError);
    }
  });

  test('validates every requested answer, distribution and option before admitting an envelope', () => {
    const base = response();
    const invalid = [
      { ...base, answers: {} },
      { ...base, answers: { ...base.answers, flag: { type: 'noul', noul: NaN } } },
      { ...base, answers: { ...base.answers, flag: { type: 'noul', noul: 2 } } },
      { ...base, answers: { ...base.answers, pick: { type: 'choice', choice: 'outside', confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } } } },
      { ...base, answers: { ...base.answers, pick: { type: 'choice', choice: 'a', confidence: 0.9, probabilities: { a: 0.8, b: 0.1 } } } },
      { ...base, answers: { ...base.answers, pick: { type: 'choice', choice: 'a', confidence: 0.9, probabilities: { a: 0.1, b: 0.9 } } } },
    ] satisfies readonly JudgmentResult<Questions>[];
    for (const result of invalid) expect(() => prepareJudgmentResult(questions()).capture(result)).toThrow(JudgmentResultAdmissionError);
  });

  test('fences schema mutation including a present undefined field', () => {
    const original = questions(); const prepared = prepareJudgmentResult(original);
    Object.defineProperty(original, 'unoffered', { value: undefined, enumerable: true });
    expect(() => prepared.assertCurrent()).toThrow(JudgmentResultAdmissionError);
    expect(() => prepared.capture(response())).toThrow(JudgmentResultAdmissionError);
    expect(Object.keys(prepared.questions)).toEqual(['flag', 'pick']);
  });

  test('retains a domain error adapter for malformed responses and stale schemas', () => {
    class DomainHeld extends Error { constructor(readonly reason: 'malformed' | 'stale') { super(reason); } }
    const source = questions(), prepared = prepareJudgmentResult(source, reason => new DomainHeld(reason));
    expect(() => prepared.capture({ ...response(), answers: {} })).toThrow(DomainHeld);
    Object.defineProperty(source, 'unoffered', { value: undefined, enumerable: true });
    try { prepared.assertCurrent(); throw new Error('Expected stale schema.'); } catch (error) {
      expect(error).toBeInstanceOf(DomainHeld); if (error instanceof DomainHeld) expect(error.reason).toBe('stale');
    }
    expect(() => captureStrictJudgmentJson(new Date(), reason => new DomainHeld(reason))).toThrow(DomainHeld);
  });
});
