/** Literal declaration syntax must not be hidden by an ordinary outer label. */
import { expect, test } from 'bun:test';
import { assertJudgmentInput, judgmentInputCardProblem, snapshotJudgmentEvidence, JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.ts';

test('repeated screening keeps credential modes and changed input distinct', () => {
  const credential = 'password=synthetic-mode-check';
  expect(judgmentInputCardProblem(credential)).toBeUndefined();
  expect(() => assertJudgmentInput(credential)).toThrow(JudgmentInputError);
  const redacted = 'password=[REDACTED]';
  expect(() => snapshotJudgmentEvidence(redacted)).not.toThrow();
  expect(() => assertJudgmentInput(redacted)).toThrow(JudgmentInputError);
  const input = { content: 'ordinary review text '.repeat(80_000) };
  assertJudgmentInput(input);
  assertJudgmentInput(input);
  input.content += ' password=synthetic-late-value';
  expect(() => assertJudgmentInput(input)).toThrow(JudgmentInputError);
});

for (const text of [
  '- Jo: password=synthetic-secret',
  'note: apiKey=synthetic-secret',
  '--note --password synthetic-secret',
  'note: --password=synthetic-secret',
  '"outer": "apiKey": "synthetic-secret"',
  'first: second: third: password=synthetic-secret',
  '--outer --middle --password synthetic-secret',
]) {
  test(`overlapping declared credential is refused: ${text}`, () => {
    expect(() => assertJudgmentInput(text)).toThrow(JudgmentInputError);
  });
}
for (const text of [
  'note: password reset guide',
  'note: ordinary=value',
  '- Jo: discusses password security',
  'note: password=goodvibes://secrets/fixture',
  '--note --password goodvibes://secrets/fixture',
  'outer: middle: apiKey=goodvibes://secrets/fixture',
]) {
  test(`ordinary prose and stored references remain admitted: ${text}`, () => {
    expect(() => assertJudgmentInput(text)).not.toThrow();
  });
}
test('bounded long label chains and long values retain late declaration screening', () => {
  const labelChain = 'label: '.repeat(30_000);
  const longValue = `ordinary: ${'x'.repeat(300_000)} `;
  const started = performance.now();
  for (const prefix of [labelChain, longValue]) {
    expect(() => assertJudgmentInput(prefix + 'password=synthetic-secret')).toThrow(JudgmentInputError);
    expect(() => assertJudgmentInput(prefix + 'password=goodvibes://secrets/fixture')).not.toThrow();
  }
  // A generous regression guard below the existing whole-input limit, not a
  // raised limit or a data-dependent short circuit around the privacy scan.
  expect(performance.now() - started).toBeLessThan(5_000);
});
