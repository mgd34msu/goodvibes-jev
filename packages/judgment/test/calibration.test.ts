import { describe, expect, test } from 'bun:test';
import {
  BatteryRegistry,
  calibrate,
  confidenceBins,
  defineBattery,
  defineDispatch,
  formatReport,
  STAKES_BANDS,
  sweep,
  yesNo,
  type FixtureCheck,
  type NamedDecision,
} from '../src/index.ts';
import { choiceAnswer, fakePort, noulAnswer } from './fake-port.ts';

const header = { version: 1, description: 'test' };

const urgency = defineBattery({
  ...header,
  name: 'test.urgency',
  accuracyFloor: 0.75,
  items: { urgent: yesNo('Urgent?', STAKES_BANDS.medium.yesNo) },
  fixtures: [
    { name: 'outage', state: 'down now!', expect: { urgent: 'yes' } },
    { name: 'thanks', state: 'thanks!', expect: { urgent: 'no' } },
    { name: 'soon', state: 'whenever', expect: { urgent: 'no' } },
    { name: 'fire', state: 'fire!', expect: { urgent: 'yes' } },
  ],
});

const routing = defineDispatch({
  ...header,
  name: 'test.routing',
  accuracyFloor: 1,
  instructions: 'Team?',
  routes: { billing: null, technical: null },
  band: STAKES_BANDS.medium.confidence,
  fixtures: [
    { name: 'charge', state: 'charged twice', expect: 'billing' },
    { name: 'crash', state: 'app crashes', expect: 'technical' },
  ],
});

const broken: NamedDecision = {
  name: 'test.broken',
  version: 1,
  description: 'always fails to run',
  accuracyFloor: 0.5,
  fixtureCount: 1,
  async checkFixtures() {
    throw new Error('endpoint refused');
  },
};

// urgency: 'soon' is misread as yes; routing: both right.
const answers = (name: string, q: Parameters<typeof choiceAnswer>[0], state: unknown) => {
  if (name === 'urgent') return noulAnswer(state === 'down now!' || state === 'fire!' ? 0.95 : state === 'soon' || state === 'whenever' ? 0.62 : 0.1);
  return choiceAnswer(q, state === 'charged twice' ? 'billing' : 'technical', 0.9);
};

describe('calibrate', () => {
  test('scores every fixture, reports floors, outcomes and bins, and survives a decision that cannot run', async () => {
    const { port, requests } = fakePort(answers);
    const report = await calibrate(port, [urgency, routing, broken], {
      endpoint: { kind: 'hosted', baseURL: 'https://judge.test' },
      now: () => new Date('2026-09-26T00:00:00Z'),
    });
    expect(requests).toHaveLength(6);
    expect(requests.every((r) => r.context?.site === 'calibration')).toBe(true);
    const [u, d, b] = report.decisions;
    expect(u).toMatchObject({ name: 'test.urgency', model: 'jev-1.13.0', accuracy: 0.75, passed: true });
    expect(u!.outcomes).toEqual({ act: 3, confirm: 1, escalate: 0 });
    expect(u!.automaticAccuracy).toBe(1);
    expect(d).toMatchObject({ name: 'test.routing', accuracy: 1, passed: true });
    expect(b).toMatchObject({ name: 'test.broken', passed: false, error: 'Error: endpoint refused' });
    expect(report.passed).toBe(false);
    expect(formatReport(report)).toContain('MISS soon [urgent] expected no got yes');
  });

  test('--only runs just the named decisions and refuses unknown names', async () => {
    const { port } = fakePort(answers);
    const report = await calibrate(port, [urgency, routing], { endpoint: { kind: 'hosted', baseURL: 'x' }, only: ['test.routing'] });
    expect(report.decisions.map((d) => d.name)).toEqual(['test.routing']);
    expect(report.passed).toBe(true);
    expect(calibrate(port, [urgency], { endpoint: { kind: 'hosted', baseURL: 'x' }, only: ['nope'] })).rejects.toThrow(RangeError);
  });

  test('a registry of batteries and patterns calibrates alike', () => {
    const registry = new BatteryRegistry();
    registry.register(urgency);
    registry.register(routing);
    expect(registry.list().map((d) => d.fixtureCount)).toEqual([2, 4]);
  });
});

describe('bins and sweep', () => {
  const check = (signal: number, correct: boolean): FixtureCheck => ({
    fixture: 'f',
    aspect: 'a',
    expected: 'x',
    got: correct ? 'x' : 'y',
    correct,
    signal,
    outcome: 'act',
  });
  const checks = [check(0.99, true), check(0.97, true), check(0.9, true), check(0.72, false), check(0.66, true), check(0.4, false)];

  test('confidence bins count checks and accuracy per signal range', () => {
    const bins = confidenceBins(checks).filter((bin) => bin.checks > 0);
    expect(bins.map((bin) => [bin.from, bin.checks, bin.correct])).toEqual([
      [0, 1, 0],
      [0.6, 1, 1],
      [0.7, 1, 0],
      [0.9, 1, 1],
      [0.95, 2, 2],
    ]);
  });

  test('a sweep re-bands recorded checks without asking again', () => {
    expect(sweep(checks, [0.5, 0.8, 0.99, 1])).toEqual([
      { threshold: 0.5, automatic: 5 / 6, accuracy: 4 / 5 },
      { threshold: 0.8, automatic: 3 / 6, accuracy: 1 },
      { threshold: 0.99, automatic: 1 / 6, accuracy: 1 },
      { threshold: 1, automatic: 0, accuracy: null },
    ]);
  });
});
