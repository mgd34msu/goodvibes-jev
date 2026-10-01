/**
 * The observe analyses over a real SQLite decision log: accuracy against
 * confidence from truth notes, threshold sweeps over logged readings, drift
 * per window with the change flag, stuck questions, calls outside a
 * registered battery, judgment cost, and the judgment accuracy eval suite.
 */
import { describe, expect, test } from 'bun:test';
import {
  defineBattery,
  defineDispatch,
  readingsOf,
  SqliteDecisionLog,
  STAKES_BANDS,
  withDecisionLog,
  yesNo,
  type DecisionEntry,
  type DecisionTruth,
  type JudgmentPort,
} from '@goodvibes-jev/judgment';
import {
  analyzeDecisionLog,
  formatObserveReport,
  JUDGMENT_EVAL_SUITE,
  judgmentEvalScenarios,
  loggedReadings,
  outcomeShift,
} from '../sdk/src/platform/observe/index.ts';
import { EvalRunner } from '../sdk/src/platform/runtime/eval/runner.ts';
import { judgmentQualityScore } from '../sdk/src/platform/runtime/eval/scorecard.ts';

const urgency = defineBattery({
  name: 'test.observe.urgency',
  version: 2,
  description: 'Is the message urgent?',
  accuracyFloor: 0.9,
  items: { urgent: yesNo('Is the message urgent?', STAKES_BANDS.medium.yesNo) },
  fixtures: [
    { name: 'outage', state: 'down now', expect: { urgent: 'yes' } },
    { name: 'thanks', state: 'thanks', expect: { urgent: 'no' } },
  ],
});

const team = defineDispatch({
  name: 'test.observe.team',
  version: 1,
  description: 'Which team takes it?',
  accuracyFloor: 0.8,
  instructions: 'Which team takes it?',
  routes: { billing: null, technical: null },
  band: STAKES_BANDS.medium.confidence,
  fixtures: [{ name: 'charge', state: 'charged twice', expect: 'billing' }],
});

/** A port whose next answers, model and failure are set by the test. */
function scriptedPort() {
  const state = { noul: 0.95, model: 'jev-1.13.0', fail: false };
  const port: JudgmentPort = {
    get model() {
      return state.model;
    },
    async ask(request) {
      if (state.fail) throw new Error('endpoint down');
      const answers = Object.fromEntries(
        Object.entries(request.questions).map(([name, question]) => [
          name,
          question.type === 'noul'
            ? { type: 'noul', noul: state.noul }
            : { type: 'choice', choice: 'billing', confidence: 0.9, probabilities: { billing: 0.9, technical: 0.1 } },
        ]),
      );
      return { answers: answers as never, requestedModel: state.model, model: state.model, usage: { inputTokens: 100, outputTokens: 5 }, latencyMs: 20, requestId: undefined };
    },
  };
  return { port, state };
}

const DAY1 = Date.parse('2026-09-20T08:00:00Z');
const DAY2 = Date.parse('2026-09-21T08:00:00Z');

const truthFor = (source: DecisionTruth['source'], expected: 'yes' | 'no', got: 'yes' | 'no', signal: number, outcome: 'act' | 'confirm'): DecisionTruth => ({
  source,
  checks: [{ fixture: source, aspect: 'urgent', expected, got, correct: expected === got, signal, outcome, answers: ['no', 'yes'] }],
});

/** Twelve intake readings over two days (the second day weaker and on a new model), truth on five, two unregistered routing calls, one failure, two calibration calls. */
async function seededLog(): Promise<SqliteDecisionLog> {
  const log = new SqliteDecisionLog(':memory:');
  const { port: inner, state } = scriptedPort();
  let clock = DAY1;
  const port = withDecisionLog(inner, log, () => new Date((clock += 60_000)));
  const day1: string[] = [];
  for (let i = 0; i < 6; i++) day1.push((await urgency.run(port, `day1 ${i}`, { site: 'intake' })).result.decisionId!);
  clock = DAY2;
  state.noul = 0.65;
  state.model = 'jev-1.14.0';
  const day2: string[] = [];
  for (let i = 0; i < 6; i++) {
    const run = await urgency.run(port, `day2 ${i}`, { site: 'intake' });
    run.recordAction('held for the owner');
    day2.push(run.result.decisionId!);
  }
  for (const [index, id] of day1.slice(0, 4).entries()) log.attach(id, { kind: 'truth', truth: truthFor('fixture', index === 3 ? 'no' : 'yes', 'yes', 0.95, 'act') });
  log.attach(day2[0]!, { kind: 'truth', truth: truthFor('owner', 'no', 'yes', 0.65, 'confirm') });
  await team.route(port, 'refund please', { site: 'router' });
  await team.route(port, 'crash', { site: 'router' });
  state.fail = true;
  await expect(urgency.run(port, 'lost', { site: 'intake' })).rejects.toMatchObject({ kind: 'unavailable', message: 'the judgment provider could not answer' });
  const [failed] = log.query({ site: 'intake', status: 'failed' });
  expect(failed).toMatchObject({ context: { battery: urgency.name, site: 'intake' }, error: { kind: 'unavailable', message: 'the judgment provider could not answer' } });
  expect(JSON.stringify(failed)).not.toContain('endpoint down');
  state.fail = false;
  clock = DAY2 + 3_600_000;
  await urgency.checkFixtures(port);
  return log;
}

const registered = [{ name: urgency.name, accuracyFloor: urgency.accuracyFloor }];

describe('observe analyses over a decision log', () => {
  test('flattened readings carry the question, signal, outcome, answer and action', async () => {
    using log = await seededLog();
    const entry = log.query({ site: 'intake', status: 'answered' }).find((candidate) => readingsOf(candidate) !== undefined)!;
    const [reading] = loggedReadings([entry]);
    expect(reading).toMatchObject({ battery: 'test.observe.urgency', batteryVersion: 2, site: 'intake', question: 'urgent', kind: 'yes-no', outcome: 'confirm', answer: 'yes', action: 'held for the owner', model: 'jev-1.14.0' });
    expect(reading!.signal).toBeCloseTo(0.65, 10);
  });

  test('per-item positions fold into one question', () => {
    const entry = {
      id: 'x',
      at: '2026-09-20T00:00:00.000Z',
      status: 'answered',
      context: { battery: 'b' },
      model: 'm',
      notes: [{ kind: 'readings', readings: { '#3': { kind: 'yes-no', probability: 0.9, verdict: 'yes', outcome: 'act' }, criteria: [{ kind: 'yes-no', probability: 0.2, verdict: 'no', outcome: 'act' }] } }],
    } as unknown as DecisionEntry;
    expect(loggedReadings([entry]).map((reading) => reading.question)).toEqual(['[n]', 'criteria.[n]']);
  });

  test('accuracy against confidence comes from truth notes, with the registered floor', async () => {
    using log = await seededLog();
    const report = analyzeDecisionLog(log, { registered, excludeCalibration: true });
    expect(report.accuracy).toHaveLength(1);
    const [row] = report.accuracy;
    expect(row).toMatchObject({ battery: 'test.observe.urgency', checks: 5, correct: 3, accuracy: 0.6, automaticAccuracy: 0.75, sources: { fixture: 4, owner: 1, outcome: 0 }, accuracyFloor: 0.9, belowFloor: true });
    expect(row!.bins.filter((bin) => bin.checks > 0).map((bin) => [bin.from, bin.correct, bin.checks])).toEqual([[0.6, 0, 1], [0.95, 3, 4]]);
  });

  test('sweeps re-band logged readings at each threshold without calls', async () => {
    using log = await seededLog();
    const report = analyzeDecisionLog(log, { registered, excludeCalibration: true, thresholds: [0.6, 0.9] });
    const sweep = report.sweeps.find((row) => row.battery === 'test.observe.urgency')!;
    expect(sweep).toMatchObject({ readings: 12, truthChecks: 5 });
    expect(sweep.points).toEqual([
      { threshold: 0.6, automatic: 1, accuracy: 0.6 },
      { threshold: 0.9, automatic: 0.5, accuracy: 0.75 },
    ]);
  });

  test('drift compares day windows and flags the outcome mix, signal and model change', async () => {
    using log = await seededLog();
    const report = analyzeDecisionLog(log, { registered, excludeCalibration: true });
    const drift = report.drift.find((row) => row.battery === 'test.observe.urgency')!;
    expect(drift.changed).toBe(true);
    expect(drift.windows.map((window) => [window.from, window.readings, window.changed])).toEqual([
      ['2026-09-20T00:00:00.000Z', 6, false],
      ['2026-09-21T00:00:00.000Z', 6, true],
    ]);
    const second = drift.windows[1]!;
    expect(second.outcomeMix).toEqual({ act: 0, confirm: 1, escalate: 0 });
    expect(second.reasons).toEqual([
      'outcome mix moved 1.00 (at least 0.2)',
      'mean signal moved 0.30 (at least 0.1)',
      'answered by jev-1.14.0, not seen in the previous window',
    ]);
    expect(outcomeShift({ act: 0.5, confirm: 0.5, escalate: 0 }, { act: 0.4, confirm: 0.5, escalate: 0.1 })).toBeCloseTo(0.1, 10);
  });

  test('a window below the reading minimum is shown but never compared', async () => {
    using log = await seededLog();
    const report = analyzeDecisionLog(log, { registered, excludeCalibration: true, drift: { windowMs: 180_000 } });
    const drift = report.drift.find((row) => row.battery === 'test.observe.urgency')!;
    expect(drift.windows.some((window) => window.readings > 0 && window.readings < 5)).toBe(true);
    expect(drift.changed).toBe(false);
  });

  test('question discovery groups readings stuck in confirm or escalate by decision, site and question', async () => {
    using log = await seededLog();
    const report = analyzeDecisionLog(log, { registered, excludeCalibration: true });
    expect(report.stuck).toHaveLength(1);
    expect(report.stuck[0]).toMatchObject({
      battery: 'test.observe.urgency',
      site: 'intake',
      question: 'urgent',
      readings: 12,
      confirm: 6,
      escalate: 0,
      stuckShare: 0.5,
      actions: [{ action: 'held for the owner', count: 6 }],
    });
    expect(report.stuck[0]!.examples).toHaveLength(3);
  });

  test('calls outside a registered battery are named by decision and site', async () => {
    using log = await seededLog();
    const report = analyzeDecisionLog(log, { registered, excludeCalibration: true });
    expect(report.unregistered).toEqual([{ battery: 'test.observe.team', site: 'router', calls: 2, examples: expect.any(Array) }]);
    expect(analyzeDecisionLog(log).unregistered).toBeUndefined();
  });

  test('judgment cost prices calls through the attribution pricing, honestly unpriced for an unknown model', async () => {
    using log = await seededLog();
    const report = analyzeDecisionLog(log, {
      excludeCalibration: true,
      resolvePricing: (model) => (model === 'jev-1.13.0' ? { input: 1, output: 2 } : null),
    });
    const intake = report.cost.rows.find((row) => row.battery === 'test.observe.urgency')!;
    expect(intake).toMatchObject({ site: 'intake', calls: 13, failed: 1, inputTokens: 1200, outputTokens: 60, costState: 'estimated' });
    expect(intake.costUsd).toBeCloseTo((6 * (100 * 1 + 5 * 2)) / 1_000_000, 12);
    expect(report.cost).toMatchObject({ calls: 15, failed: 1, costState: 'estimated' });
  });

  test('calibration calls are read or left out on request, and the window bounds the entries', async () => {
    using log = await seededLog();
    expect(analyzeDecisionLog(log).entries).toBe(17);
    expect(analyzeDecisionLog(log, { excludeCalibration: true }).entries).toBe(15);
    const day1 = analyzeDecisionLog(log, { until: '2026-09-21T00:00:00.000Z' });
    expect(day1).toMatchObject({ entries: 6, window: { first: '2026-09-20T08:01:00.000Z', last: '2026-09-20T08:06:00.000Z' } });
    expect(analyzeDecisionLog(log, { limit: 3 }).truncated).toBe(true);
  });

  test('the text report prints every analysis', async () => {
    using log = await seededLog();
    const text = formatObserveReport(analyzeDecisionLog(log, { registered }), 'test.sqlite');
    for (const heading of ['Accuracy against confidence', 'Threshold sweeps', 'Drift per window', 'Question discovery', 'Calls outside a registered battery', 'Judgment cost']) {
      expect(text).toContain(`== ${heading}`);
    }
    expect(text).toContain('BELOW FLOOR');
    expect(text).toContain('CHANGED');
  });
});

describe('judgment accuracy in the eval harness', () => {
  test('quality sits at its floor exactly at the decision floor and scales to 100', () => {
    expect(judgmentQualityScore(0.9, 0.9)).toBeCloseTo(60, 10);
    expect(judgmentQualityScore(1, 0.9)).toBeCloseTo(100, 10);
    expect(judgmentQualityScore(0.95, 0.9)).toBeCloseTo(80, 10);
    expect(judgmentQualityScore(0.45, 0.9)).toBeCloseTo(30, 10);
    expect(judgmentQualityScore(1, 1)).toBe(100);
  });

  test('a decision below its floor fails the judgment suite; one above passes', async () => {
    using log = await seededLog();
    const report = analyzeDecisionLog(log, { registered });
    const scenarios = judgmentEvalScenarios(report.accuracy);
    expect(scenarios.map((scenario) => scenario.id)).toEqual(['judgment:test.observe.urgency']);
    const runner = new EvalRunner();
    const below = await runner.runSuite(JUDGMENT_EVAL_SUITE, scenarios);
    expect(below.passed).toBe(false);
    expect(below.results[0]!.scorecard.notes).toEqual([expect.stringContaining('quality')]);
    const above = await runner.runSuite(
      JUDGMENT_EVAL_SUITE,
      judgmentEvalScenarios([{ ...report.accuracy[0]!, accuracy: 0.95 }]),
    );
    expect(above.passed).toBe(true);
    expect(judgmentEvalScenarios([{ ...report.accuracy[0]!, accuracyFloor: undefined }])).toEqual([]);
  });
});
