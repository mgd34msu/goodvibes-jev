import { describe, expect, test } from 'bun:test';
import {
  STAKES_BANDS,
  assertBand,
  readChoice,
  readScore,
  readYesNo,
  type ChoiceResponse,
  type ScoreResponse,
  type YesNoBand,
} from '../src/index.ts';

const BAND: YesNoBand = { yes: { actAt: 0.8, confirmAt: 0.6 }, no: { actAt: 0.8, confirmAt: 0.6 } };
const noul = (p: number) => ({ type: 'noul', noul: p }) as const;

describe('readYesNo', () => {
  test.each([
    [1, 'yes', 'act'],
    [0.8, 'yes', 'act'],
    [0.79, 'yes', 'confirm'],
    [0.6, 'yes', 'confirm'],
    [0.59, 'uncertain', 'escalate'],
    [0.5, 'uncertain', 'escalate'],
    [0.41, 'uncertain', 'escalate'],
    [0.4, 'no', 'confirm'],
    [0.21, 'no', 'confirm'],
    [0.2, 'no', 'act'],
    [0, 'no', 'act'],
  ] as const)('p=%d reads %s / %s', (p, verdict, outcome) => {
    const reading = readYesNo(noul(p), BAND);
    expect(reading).toEqual({ kind: 'yes-no', probability: p, verdict, outcome });
  });

  test('a critical band never acts, even at certainty', () => {
    expect(readYesNo(noul(1), STAKES_BANDS.critical.yesNo)).toMatchObject({ verdict: 'yes', outcome: 'confirm' });
    expect(readYesNo(noul(0), STAKES_BANDS.critical.yesNo)).toMatchObject({ verdict: 'no', outcome: 'confirm' });
    expect(readYesNo(noul(0.5), STAKES_BANDS.critical.yesNo)).toMatchObject({ outcome: 'escalate' });
  });

  test.each([
    ['sides overlap', { yes: { actAt: 0.8, confirmAt: 0.4 }, no: { actAt: 0.8, confirmAt: 0.4 } }],
    ['act inside confirm', { yes: { actAt: 0.7, confirmAt: 0.8 }, no: { actAt: 0.8, confirmAt: 0.7 } }],
    ['outside [0, 1]', { yes: { actAt: 1.2, confirmAt: 0.7 }, no: { actAt: 0.9, confirmAt: 0.7 } }],
  ])('rejects a malformed band: %s', (_label, band) => {
    expect(() => assertBand(band)).toThrow(RangeError);
  });
});

describe('readChoice', () => {
  const answer = (choiceLabel: 'check_balance' | 'approve_transfer', confidence: number): ChoiceResponse<{
    check_balance: null;
    approve_transfer: null;
  }> => ({
    type: 'choice',
    choice: choiceLabel,
    confidence,
    probabilities: { check_balance: 0, approve_transfer: 0 },
  });
  const band = {
    actAt: 0.6,
    confirmAt: 0.6,
    perOption: { approve_transfer: { actAt: 0.85, confirmAt: 0.6 } },
  };

  test('low-stakes option acts at the general floor', () => {
    expect(readChoice(answer('check_balance', 0.6), band).outcome).toBe('act');
    expect(readChoice(answer('check_balance', 0.59), band).outcome).toBe('escalate');
  });

  test('a high-stakes option uses its own stricter band', () => {
    expect(readChoice(answer('approve_transfer', 0.85), band).outcome).toBe('act');
    expect(readChoice(answer('approve_transfer', 0.84), band).outcome).toBe('confirm');
    expect(readChoice(answer('approve_transfer', 0.59), band).outcome).toBe('escalate');
  });

  test('carries the choice and its probabilities', () => {
    const reading = readChoice(answer('check_balance', 0.9), band);
    expect(reading).toMatchObject({ kind: 'choice', choice: 'check_balance', confidence: 0.9 });
  });
});

describe('readScore', () => {
  const answer = (score: number, confidence: number, probabilities: number[]): ScoreResponse =>
    ({
      type: 'score',
      score,
      confidence,
      legend: {},
      probabilities: Object.fromEntries(probabilities.map((p, i) => [String(i), p])),
    }) as unknown as ScoreResponse;

  test('nearest level, normalized position and outcome', () => {
    const reading = readScore(answer(1.43, 0.35, [0, 0.57, 0.43]), { actAt: 0.7, confirmAt: 0.4 });
    expect(reading).toMatchObject({ kind: 'score', score: 1.43, level: 1, confidence: 0.35, outcome: 'escalate' });
    expect(reading.normalized).toBeCloseTo(0.715);
    expect(reading.probabilities).toEqual([0, 0.57, 0.43]);
  });

  test.each([
    [0.7, 'act'],
    [0.69, 'confirm'],
    [0.4, 'confirm'],
    [0.39, 'escalate'],
  ] as const)('confidence %d is %s', (confidence, outcome) => {
    expect(readScore(answer(2, confidence, [0, 0, 1]), { actAt: 0.7, confirmAt: 0.4 }).outcome).toBe(outcome);
  });

  test('rounds half up to the next level and clamps to the rubric', () => {
    expect(readScore(answer(1.5, 1, [0, 0.5, 0.5]), { actAt: 0.5, confirmAt: 0.5 }).level).toBe(2);
    expect(readScore(answer(2, 1, [0, 0, 1]), { actAt: 0.5, confirmAt: 0.5 }).level).toBe(2);
  });
});

describe('stakes table', () => {
  test('every default band is well formed and stricter as stakes rise', () => {
    const order = ['low', 'medium', 'high', 'critical'] as const;
    for (const stakes of order) {
      assertBand(STAKES_BANDS[stakes].yesNo);
      assertBand(STAKES_BANDS[stakes].confidence);
    }
    for (let i = 1; i < order.length; i++) {
      const lower = STAKES_BANDS[order[i - 1]!].confidence;
      const higher = STAKES_BANDS[order[i]!].confidence;
      expect(higher.confirmAt).toBeGreaterThanOrEqual(lower.confirmAt);
      expect(higher.actAt === null || (lower.actAt !== null && higher.actAt >= lower.actAt)).toBe(true);
    }
  });

  test('a confidence band cannot confirm above where it acts', () => {
    expect(() => assertBand({ actAt: 0.5, confirmAt: 0.7 })).toThrow(RangeError);
  });
});
