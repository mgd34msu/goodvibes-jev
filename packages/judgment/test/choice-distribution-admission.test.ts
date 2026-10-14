import { expect, test } from 'bun:test';
import { checkAnswers, createSystemOnePort, JudgmentError, readChoice, SqliteDecisionLog, withDecisionLog } from '../src/index.ts';

const questions = { pick: { type: 'choice', instructions: 'Choose', criteria: { a: null, b: null, c: null } } } as const;
const answer = (probabilities: Record<string, number>, confidence = 0.42, choice = 'a') => ({
  type: 'choice' as const, choice, confidence, probabilities,
});
function transport(value: unknown) {
  return createSystemOnePort({ model: 'jev-1.13.0', timeoutMs: 1000, endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'fixture' },
    retry: { backoffInitialMs: 1, backoffMaxMs: 1 },
    fetch: async () => Response.json({ model: 'jev-1.13.0', answers: { pick: value }, usage: { input_tokens: 1, output_tokens: 1 } }),
  });
}

test.each([
  { a: 0.6, b: 0.39, c: 0 },
  { a: 0.6, b: 0.4, c: 0 },
  { a: 0.6, b: 0.41, c: 0 },
])('bounded approximate totals retain the exact answer through transport, readings and the log: %j', async probabilities => {
  const raw = { type: 'choice' as const, choice: 'a' as const, confidence: 0.42, probabilities };
  using log = new SqliteDecisionLog(':memory:');
  const result = await withDecisionLog(transport(raw), log).ask({ state: 'fixture', questions });
  expect(result.answers.pick).toEqual(raw);
  const entry = log.query({ status: 'answered' })[0];
  if (entry?.status !== 'answered') throw new Error('Expected an answered decision log entry');
  expect(entry.answers).toEqual({ pick: raw });
  expect(readChoice(result.answers.pick, { actAt: 0.8, confirmAt: 0.5 })).toEqual({
    kind: 'choice', choice: 'a', confidence: 0.42, probabilities, outcome: 'escalate',
  });
});

test.each([
  ['below lower bound', answer({ a: 0.6, b: 0.389999, c: 0 })],
  ['above upper bound', answer({ a: 0.6, b: 0.410001, c: 0 })],
  ['zero mass', answer({ a: 0, b: 0, c: 0 })],
  ['excess mass', answer({ a: 1, b: 1, c: 1 })],
  ['missing offered probability', answer({ a: 0.6, b: 0.39 })],
  ['nonfinite probability', answer({ a: Number.NaN, b: 0.39, c: 0 })],
  ['infinite probability', answer({ a: Number.POSITIVE_INFINITY, b: 0.39, c: 0 })],
  ['negative probability', answer({ a: 0.6, b: 0.41, c: -0.01 })],
  ['probability above one', answer({ a: 1.001, b: 0, c: 0 })],
  ['nonfinite confidence', answer({ a: 0.6, b: 0.39, c: 0 }, Number.NaN)],
  ['confidence above one', answer({ a: 0.6, b: 0.39, c: 0 }, 1.001)],
  ['negative confidence', answer({ a: 0.6, b: 0.39, c: 0 }, -0.001)],
  ['unoffered choice', answer({ a: 0.6, b: 0.39, c: 0 }, 0.42, 'other')],
  ['nonmaximal choice in approximate total', answer({ a: 0.39, b: 0.6, c: 0 })],
] as const)('%s remains invalid and never acquires an answered log entry', async (_name, raw) => {
  expect(() => checkAnswers(questions, { pick: raw })).toThrow(JudgmentError);
  using log = new SqliteDecisionLog(':memory:');
  await expect(withDecisionLog(transport(raw), log).ask({ state: 'fixture', questions })).rejects.toMatchObject({ kind: 'invalid-response' });
  expect(log.query({ status: 'answered' })).toEqual([]);
  expect(log.query({ status: 'failed' })).toHaveLength(1);
});

test('a selected .14 still loses to .15 even when the total is exactly one', () => {
  const probabilities = { Tuesday: 0.14, Wednesday: 0.15, Thursday: 0.15, Friday: 0.14, Saturday: 0.14, Sunday: 0.14, Monday: 0.14 };
  const raw = answer(probabilities, 0.99, 'Tuesday');
  const request = { pick: { type: 'choice' as const, instructions: 'Weekday', criteria: Object.fromEntries(Object.keys(probabilities).map(key => [key, null])) } };
  expect(() => checkAnswers(request, { pick: raw })).toThrow('below the highest probability');
  expect(() => readChoice(raw, { actAt: 0.8, confirmAt: 0.5 })).toThrow(JudgmentError);
});

test('255 options do not widen the approximation allowance', () => {
  const criteria = Object.fromEntries(Array.from({ length: 255 }, (_, i) => [`option_${i}`, null]));
  const request = { pick: { type: 'choice' as const, instructions: 'Choose', criteria } };
  for (const total of [0.989999, 1.010001, 0.98, 1.02, 0.5, 1.5]) {
    const probabilities = Object.fromEntries(Object.keys(criteria).map(key => [key, total / 255]));
    const raw = answer(probabilities, 0.42, 'option_0');
    expect(() => checkAnswers(request, { pick: raw })).toThrow(JudgmentError);
    expect(() => readChoice(raw, { actAt: 0.8, confirmAt: 0.5 })).toThrow(JudgmentError);
  }
});

test('ties remain valid without changing the selected option', () => {
  const raw = answer({ a: 0.5, b: 0.5 }, 0.42, 'b');
  expect(readChoice(raw, { actAt: 0.8, confirmAt: 0.5 })).toMatchObject({ choice: 'b', probabilities: raw.probabilities, confidence: raw.confidence });
});

test('higher precision ties cannot claim hundredth rounding for missing probability mass', () => {
  expect(() => readChoice(answer({ a: 0.495, b: 0.495 }, 0.42, 'b'), { actAt: 0.8, confirmAt: 0.5 })).toThrow(JudgmentError);
});
