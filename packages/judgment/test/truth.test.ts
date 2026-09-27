import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import {
  calibrate,
  checkReading,
  defineBattery,
  defineDispatch,
  defineJudge,
  oneOf,
  rated,
  SqliteDecisionLog,
  STAKES_BANDS,
  truthOf,
  withDecisionLog,
  yesNo,
  type DecisionTruth,
} from '../src/index.ts';
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '../src/testing/fake-port.ts';

const dir = mkdtempSync(join(tmpdir(), 'judgment-truth-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const header = { version: 1, description: 'test' };

const urgency = defineBattery({
  ...header,
  name: 'test.urgency',
  accuracyFloor: 0.5,
  items: {
    urgent: yesNo('Urgent?', STAKES_BANDS.medium.yesNo),
    team: oneOf('Team?', { billing: null, technical: null }, STAKES_BANDS.medium.confidence),
    severity: rated('Severity?', ['low', 'high'], STAKES_BANDS.medium.confidence),
  },
  fixtures: [
    { name: 'outage', state: 'down now!', expect: { urgent: 'yes', team: 'technical', severity: 1 } },
    { name: 'invoice', state: 'invoice copy please', expect: { urgent: 'no', team: 'billing', severity: 0 } },
  ],
});

const answering = fakePort((_name, question) => {
  if (question.type === 'noul') return noulAnswer(0.9);
  if (question.type === 'choice') return choiceAnswer(question, 'technical', 0.8);
  return scoreAnswer(question, 1, 0.7);
});

describe('fixture checks carry their answer set', () => {
  test('a battery check lists every answer its question could conclude', async () => {
    const checks = await urgency.checkFixtures(answering.port);
    const byAspect = Object.fromEntries(checks.filter((check) => check.fixture === 'outage').map((check) => [check.aspect, check.answers]));
    expect(byAspect).toEqual({ urgent: ['no', 'yes'], team: ['billing', 'technical'], severity: ['0', '1'] });
    expect(checks.every((check) => check.question === undefined)).toBe(true);
  });

  test('checkReading can name the question when several aspects read one', () => {
    const check = checkReading('f', '#2', 'yes', { kind: 'yes-no', probability: 0.9, verdict: 'yes', outcome: 'act' }, 'keep');
    expect(check).toMatchObject({ aspect: '#2', question: 'keep', answers: ['no', 'yes'], correct: true });
  });

  test('a judge settles on pass or fail, per verdict and per criterion', async () => {
    const judge = defineJudge({
      ...header,
      name: 'test.judge',
      accuracyFloor: 0.5,
      band: STAKES_BANDS.medium.yesNo,
      fixtures: [{ name: 'ok', goal: 'say hi', criteria: ['greets'], output: 'hi', expect: { verdict: 'pass', unmet: [] } }],
    });
    const checks = await judge.checkFixtures(fakePort(() => noulAnswer(0.05)).port);
    expect(checks.map((check) => [check.aspect, check.question, check.answers])).toEqual([
      ['verdict', undefined, ['fail', 'pass']],
      ['criterion_0', 'criterion', ['fail', 'pass']],
    ]);
  });
});

describe('calibration calls carry their fixture, and calibrate records truth', () => {
  test('every calibration call names its fixture in the decision log', async () => {
    using log = new SqliteDecisionLog(':memory:');
    await urgency.checkFixtures(withDecisionLog(answering.port, log));
    const fixtures = log.query({ site: 'calibration' }).map((entry) => entry.context.fixture);
    expect(fixtures.sort()).toEqual(['invoice', 'outage']);
  });

  test('calibrate attaches each fixture checks to its call as fixture truth', async () => {
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
    using log = new SqliteDecisionLog(':memory:');
    const port = withDecisionLog(answering.port, log);
    const report = await calibrate(port, [urgency, routing], { endpoint: { kind: 'test', baseURL: 'http://x' }, log });
    expect(report.decisions.map((decision) => decision.truthRecorded)).toEqual([2, 2]);
    const truths = log.query({ site: 'calibration' }).map((entry) => [entry.context.battery, entry.context.fixture, truthOf(entry)] as const);
    const charge = truths.find(([battery, fixture]) => battery === 'test.routing' && fixture === 'charge')![2]!;
    expect(charge.source).toBe('fixture');
    expect(charge.checks).toEqual([expect.objectContaining({ aspect: 'route', expected: 'billing', got: 'technical', correct: false })]);
    const invoice = truths.find(([battery, fixture]) => battery === 'test.urgency' && fixture === 'invoice')![2]!;
    expect(invoice.checks.map((check) => check.aspect).sort()).toEqual(['severity', 'team', 'urgent']);
  });

  test('without a log, calibrate reports no truth count', async () => {
    const report = await calibrate(answering.port, [urgency], { endpoint: { kind: 'test', baseURL: 'http://x' } });
    expect(report.decisions[0]!.truthRecorded).toBeUndefined();
  });
});

describe('truth notes in the SQLite log', () => {
  const truth: DecisionTruth = {
    source: 'owner',
    checks: [{ fixture: 'owner correction', aspect: 'urgent', expected: 'no', got: 'yes', correct: false, signal: 0.9, outcome: 'act', answers: ['no', 'yes'] }],
  };

  test('a truth note round-trips beside readings and action', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const run = await urgency.run(withDecisionLog(answering.port, log), 'down now!', { site: 'intake' });
    run.recordAction('paged');
    log.attach(run.result.decisionId!, { kind: 'truth', truth });
    const entry = log.get(run.result.decisionId!)!;
    expect(truthOf(entry)).toEqual(truth);
    if (entry.status !== 'answered') throw new Error('expected answered');
    expect(entry.notes.map((note) => note.kind)).toEqual(['readings', 'action', 'truth']);
  });

  test('a version 2 log gains the truth column in place and keeps its rows', () => {
    const path = join(dir, 'v2.sqlite');
    const db = new Database(path, { create: true, strict: true });
    db.exec(`CREATE TABLE decisions (
      id TEXT PRIMARY KEY, entry TEXT NOT NULL,
      at TEXT GENERATED ALWAYS AS (json_extract(entry, '$.at')) VIRTUAL,
      status TEXT GENERATED ALWAYS AS (json_extract(entry, '$.status')) VIRTUAL,
      battery TEXT GENERATED ALWAYS AS (json_extract(entry, '$.context.battery')) VIRTUAL,
      site TEXT GENERATED ALWAYS AS (json_extract(entry, '$.context.site')) VIRTUAL,
      readings TEXT, action TEXT);
      PRAGMA user_version = 2;`);
    const entry = {
      at: '2026-09-01T00:00:00.000Z',
      context: { battery: 'test.urgency' },
      stateHash: 'h',
      questions: {},
      status: 'answered',
      requestedModel: 'm',
      model: 'm',
      answers: {},
      latencyMs: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    db.query('INSERT INTO decisions (id, entry, action) VALUES ($id, $entry, $action)').run({ id: 'old-1', entry: JSON.stringify(entry), action: 'kept' });
    db.close();

    using log = new SqliteDecisionLog(path);
    const [old] = log.query();
    expect<string | undefined>(old?.id).toBe('old-1');
    expect(truthOf(old!)).toBeUndefined();
    log.attach('old-1', { kind: 'truth', truth });
    expect(truthOf(log.get('old-1')!)).toEqual(truth);
    const version = new Database(path).query('PRAGMA user_version').get() as { user_version: number };
    expect(version.user_version).toBe(3);
  });

  test('a log at an unknown version is refused', () => {
    const path = join(dir, 'v1.sqlite');
    const db = new Database(path, { create: true });
    db.exec('CREATE TABLE decisions (id TEXT PRIMARY KEY); PRAGMA user_version = 1;');
    db.close();
    expect(() => new SqliteDecisionLog(path)).toThrow(/schema version 1/);
  });
});
