import { expect, test } from 'bun:test';
import {
  calibrate, createSystemOnePort, formatReport, PINNED_MODEL, SqliteDecisionLog, truthOf, withDecisionLog,
  type JudgmentPort,
} from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { nativeIntakeCoverage, validateNativeRequirementProposal } from '../sdk/src/platform/workflow/work-ledger/native-intake-decisions.js';

const COMPLETE = 'Add JSON export.';
const DUPLICATE = 'A: Keep logs. B: Keep logs.';
const NEGATIVE = 'Add JSON export. Do not delete CSV.';
const endpoint = { kind: 'test', baseURL: 'http://calibration.test' };

function authoredCoverage(completeProbability: number, omittedProbability: number) {
  const probabilities = new Map<string, ReadonlyMap<string, number>>([
    [COMPLETE, new Map([['part_0', completeProbability]])],
    [DUPLICATE, new Map([['part_0', 0.01], ['part_1', omittedProbability]])],
    [NEGATIVE, new Map([['part_0', 0.01], ['part_1', omittedProbability]])],
  ]);
  return fakePort((name, question, state) => {
    if (state === null || typeof state !== 'object' || Array.isArray(state)
      || typeof state.input !== 'string' || question.type !== 'noul') {
      throw new Error('Unexpected coverage calibration request');
    }
    const probability = probabilities.get(state.input)?.get(name);
    if (probability === undefined) throw new Error('Unauthored coverage calibration question');
    return noulAnswer(probability);
  });
}

async function runCalibration(port: JudgmentPort) {
  return calibrate(port, [nativeIntakeCoverage], { endpoint });
}

test.each([0.45, 0.5, 0.55])('unsettled complete selection at %p receives no false credit', async probability => {
  const authored = authoredCoverage(probability, 0.99);
  const report = await runCalibration(authored.port);
  expect(report.decisions).toHaveLength(1);
  const decision = report.decisions[0];
  if (!decision) throw new Error('Missing calibration decision');
  expect(decision.checks[0]).toMatchObject({
    fixture: 'complete exact request', aspect: 'omitted', expected: 'false', got: 'uncertain',
    correct: false, outcome: 'escalate', answers: ['false', 'true'],
  });
  expect(decision).toMatchObject({ accuracyFloor: 0.95, accuracy: 2 / 3, passed: false,
    outcomes: { act: 2, confirm: 0, escalate: 1 }, automaticAccuracy: 1 });
  expect(report.passed).toBe(false);
  expect(authored.requests).toHaveLength(3);
  expect(formatReport(report)).toContain('MISS complete exact request [omitted] expected false got uncertain');
});

test.each([0.45, 0.5, 0.55])('unsettled actual omission at %p receives no true credit', async probability => {
  const authored = authoredCoverage(0.01, probability);
  const report = await runCalibration(authored.port);
  const decision = report.decisions[0];
  if (!decision) throw new Error('Missing calibration decision');
  expect(decision.checks.slice(1)).toEqual([
    expect.objectContaining({ expected: 'true', got: 'uncertain', correct: false, outcome: 'escalate' }),
    expect.objectContaining({ expected: 'true', got: 'uncertain', correct: false, outcome: 'escalate' }),
  ]);
  expect(decision).toMatchObject({ accuracy: 1 / 3, passed: false,
    outcomes: { act: 1, confirm: 0, escalate: 2 }, automaticAccuracy: 1 });
});

test('definite yes and no retain original fixture truth, model, floor and automatic report', async () => {
  const authored = authoredCoverage(0.01, 0.99);
  const report = await runCalibration(authored.port);
  const decision = report.decisions[0];
  if (!decision) throw new Error('Missing calibration decision');
  expect(decision.checks.map(check => [check.expected, check.got, check.correct])).toEqual([
    ['false', 'false', true], ['true', 'true', true], ['true', 'true', true],
  ]);
  expect(decision).toMatchObject({ version: 1, model: PINNED_MODEL, accuracyFloor: 0.95,
    accuracy: 1, passed: true, outcomes: { act: 3, confirm: 0, escalate: 0 }, automaticAccuracy: 1 });
  expect(nativeIntakeCoverage.fixtureCount).toBe(3);
  expect(authored.requests.every(request => request.context?.site === 'calibration')).toBe(true);
  expect(authored.requests.map(request => Object.keys(request.questions))).toEqual([
    ['part_0'], ['part_0', 'part_1'], ['part_0', 'part_1'],
  ]);
});

test('definite opposite answers stay incorrect without changing their original action outcomes', async () => {
  const report = await runCalibration(authoredCoverage(0.99, 0.01).port);
  const decision = report.decisions[0];
  if (!decision) throw new Error('Missing calibration decision');
  expect(decision.checks.map(check => [check.expected, check.got, check.correct])).toEqual([
    ['false', 'true', false], ['true', 'false', false], ['true', 'false', false],
  ]);
  expect(decision).toMatchObject({ accuracy: 0, passed: false,
    outcomes: { act: 3, confirm: 0, escalate: 0 }, automaticAccuracy: 0 });
});

test('definite confirmation readings retain confirmation metadata and never become automatic', async () => {
  const report = await runCalibration(authoredCoverage(0.25, 0.65).port);
  const decision = report.decisions[0];
  if (!decision) throw new Error('Missing calibration decision');
  expect(decision.checks.map(check => [check.got, check.correct, check.outcome])).toEqual([
    ['false', true, 'confirm'], ['true', true, 'confirm'], ['true', true, 'confirm'],
  ]);
  expect(decision).toMatchObject({ accuracy: 1, passed: true,
    outcomes: { act: 0, confirm: 3, escalate: 0 }, automaticAccuracy: null });
});

test('calibration truth records retain the unresolved result and untouched native answer', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const authored = authoredCoverage(0.55, 0.99);
  const report = await calibrate(withDecisionLog(authored.port, log), [nativeIntakeCoverage], { endpoint, log });
  const decision = report.decisions[0];
  if (!decision) throw new Error('Missing calibration decision');
  expect(decision).toMatchObject({ truthRecorded: 3, passed: false, accuracy: 2 / 3 });
  const entries = log.query({ site: 'calibration', status: 'answered' });
  expect(entries).toHaveLength(3);
  const complete = entries.find(entry => entry.context.fixture === 'complete exact request');
  if (!complete) throw new Error('Missing recorded complete fixture');
  expect(complete).toMatchObject({ requestedModel: PINNED_MODEL, model: PINNED_MODEL,
    answers: { part_0: { type: 'noul', noul: 0.55 } } });
  expect(truthOf(complete)).toEqual({ source: 'fixture', checks: [decision.checks[0]] });
  expect(decision.checks[0]).toMatchObject({ expected: 'false', got: 'uncertain', correct: false });
});

test.each(['missing', 'malformed'] as const)('canonical %s answer fails calibration without manufacturing false', async kind => {
  let requests = 0;
  const port = createSystemOnePort({
    endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic-fixture' },
    model: PINNED_MODEL, timeoutMs: 1_000, retry: {},
    fetch: async () => {
      requests++;
      return Response.json({ model: PINNED_MODEL,
        answers: kind === 'missing' ? {} : { part_0: { type: 'noul', noul: null } },
        usage: { input_tokens: 1, output_tokens: 1 } });
    },
  });
  const report = await runCalibration(port);
  const decision = report.decisions[0];
  if (!decision) throw new Error('Missing calibration decision');
  expect(requests).toBe(1);
  expect(decision).toMatchObject({ accuracy: 0, passed: false, checks: [],
    outcomes: { act: 0, confirm: 0, escalate: 0 }, automaticAccuracy: null });
  expect(decision.error).toContain('answer');
  expect(report.passed).toBe(false);
});

test.each([0.55, 0.25])('live coverage at %p remains held independently of calibration scoring', async probability => {
  const authored = authoredCoverage(probability, 0.99);
  const requirements = validateNativeRequirementProposal(COMPLETE, 'fixture', {
    sourceRevision: 'fixture', spans: [{ partId: 'input', start: 0, end: COMPLETE.length }],
  });
  const result = await nativeIntakeCoverage.read(authored.port, { text: COMPLETE, requirements });
  expect(result.settled).toBe(false);
  expect(result.parts[0]?.reading).toMatchObject({ probability,
    verdict: probability === 0.55 ? 'uncertain' : 'no',
    outcome: probability === 0.55 ? 'escalate' : 'confirm' });
  expect(authored.requests).toHaveLength(1);
});
