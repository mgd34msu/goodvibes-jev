import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  actionOf,
  defineBattery,
  hashState,
  readingsOf,
  JudgmentError,
  SqliteDecisionLog,
  STAKES_BANDS,
  withDecisionLog,
  yesNo,
  type DecisionLog,
  type JudgmentPort,
} from '../src/index.ts';

const answering = (noulValue: number): JudgmentPort => ({
  model: 'jev-1.13.0',
  async ask(request) {
    const answers = Object.fromEntries(Object.keys(request.questions).map((name) => [name, { type: 'noul', noul: noulValue }]));
    return {
      answers: answers as never,
      requestedModel: request.model ?? 'jev-1.13.0',
      model: 'jev-1.13.0',
      usage: { inputTokens: 120, outputTokens: 9 },
      latencyMs: 42,
      requestId: 'req-ok',
    };
  },
});

const failing: JudgmentPort = {
  model: 'jev-1.13.0',
  async ask() {
    throw new JudgmentError('unavailable', 'System One answered HTTP 529', { status: 529, requestId: 'req-bad' });
  },
};

const battery = defineBattery({
  name: 'test.urgency',
  version: 3,
  description: 'Is the message urgent?',
  accuracyFloor: 0.9,
  items: { urgent: yesNo('Does the message convey urgency?', STAKES_BANDS.medium.yesNo) },
  fixtures: [{ name: 'urgent', state: 'Now!', expect: { urgent: 'yes' } }],
});

let clock = Date.parse('2026-09-26T00:00:00Z');
const tick = () => new Date((clock += 60_000));

describe('withDecisionLog + SqliteDecisionLog', () => {
  test('records an answered battery call with context, answers, readings and action', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const port = withDecisionLog(answering(0.93), log, tick);
    const run = await battery.run(port, { message: 'Payouts failing for 3 days' }, { site: 'intake.urgency' });
    run.recordAction('page-owner');
    expect(run.result.decisionId).toBeString();
    const entry = log.get(run.result.decisionId!)!;
    if (entry.status !== 'answered') throw new Error('expected an answered entry');
    expect(entry.context).toEqual({ battery: 'test.urgency', batteryVersion: 3, pattern: 'battery', site: 'intake.urgency' });
    expect(entry.requestedModel).toBe('jev-1.13.0');
    expect(entry.model).toBe('jev-1.13.0');
    expect(entry.stateHash).toBe(hashState({ message: 'Payouts failing for 3 days' }));
    expect(entry.answers).toEqual({ urgent: { type: 'noul', noul: 0.93 } });
    expect(readingsOf(entry)).toEqual({ urgent: { kind: 'yes-no', probability: 0.93, verdict: 'yes', outcome: 'act' } });
    expect(actionOf(entry)).toBe('page-owner');
    expect(entry.usage).toEqual({ inputTokens: 120, outputTokens: 9 });
    expect(entry.latencyMs).toBe(42);
    expect(entry.requestId).toBe('req-ok');
  });

  test('records a failed call and still throws it', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const port = withDecisionLog(failing, log, tick);
    const error = await battery.run(port, 'x').catch((e: unknown) => e);
    expect((error as JudgmentError).kind).toBe('unavailable');
    const [entry] = log.query({ status: 'failed' });
    if (entry?.status !== 'failed') throw new Error('expected a failed entry');
    expect(entry.error).toEqual({ kind: 'unavailable', message: 'System One answered HTTP 529' });
    expect(entry.requestedModel).toBe('jev-1.13.0');
    expect(entry.requestId).toBe('req-bad');
  });

  test('a log that cannot write fails the call as unrecorded', async () => {
    const broken: DecisionLog = {
      record(): never {
        throw new Error('disk full');
      },
      attach() {},
      get: () => undefined,
      query: () => [],
    };
    const error = await withDecisionLog(answering(0.5), broken).ask({ state: 'x', questions: { q: { type: 'noul', instructions: 'Q?' } } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JudgmentError);
    expect((error as JudgmentError).kind).toBe('unrecorded');
  });

  test('a readings write that fails surfaces as unrecorded', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const port = withDecisionLog(answering(0.9), log, tick);
    expect(() => port.recorder!.recordAction('no-such-id', 'x')).toThrow(JudgmentError);
  });

  test('equal states hash equally regardless of key order', () => {
    expect(hashState({ a: 1, b: { c: 2, d: 3 } })).toBe(hashState({ b: { d: 3, c: 2 }, a: 1 }));
    expect(hashState('x')).not.toBe(hashState('y'));
  });

  test('queries by battery, time range, outcome and failure, newest first', async () => {
    clock = Date.parse('2026-09-26T00:00:00Z');
    using log = new SqliteDecisionLog(':memory:');
    const port = withDecisionLog(answering(0.93), log, tick);
    const uncertain = withDecisionLog(answering(0.5), log, tick);
    await battery.run(port, 'one'); // 00:01, act
    await battery.run(uncertain, 'two'); // 00:02, escalate
    await port.ask({ state: 'raw', questions: { q: { type: 'noul', instructions: 'Q?' } } }); // 00:03, no battery
    await battery.run(withDecisionLog(failing, log, tick), 'three').catch(() => undefined); // 00:04, failed

    expect(log.query().map((e) => String(e.at))).toEqual([
      '2026-09-26T00:04:00.000Z',
      '2026-09-26T00:03:00.000Z',
      '2026-09-26T00:02:00.000Z',
      '2026-09-26T00:01:00.000Z',
    ]);
    expect(log.query({ battery: 'test.urgency' })).toHaveLength(3);
    expect(log.query({ outcome: 'escalate' }).map((e) => String(e.at))).toEqual(['2026-09-26T00:02:00.000Z']);
    expect(log.query({ outcome: 'act' }).map((e) => String(e.at))).toEqual(['2026-09-26T00:01:00.000Z']);
    expect(log.query({ since: '2026-09-26T00:02:00.000Z', until: '2026-09-26T00:04:00.000Z' })).toHaveLength(2);
    expect(log.query({ status: 'answered' })).toHaveLength(3);
    expect(log.query({ limit: 1 })).toHaveLength(1);
  });

  test('a log file persists across reopen', async () => {
    const path = `${process.env['TMPDIR'] ?? '/tmp'}/judgment-log-${Bun.randomUUIDv7()}.sqlite`;
    let id = '';
    {
      using log = new SqliteDecisionLog(path);
      id = (await battery.run(withDecisionLog(answering(0.9), log, tick), 'x')).result.decisionId!;
    }
    {
      using log = new SqliteDecisionLog(path);
      expect(log.get(id)?.context.battery).toBe('test.urgency');
    }
    for (const suffix of ['', '-wal', '-shm']) await Bun.file(path + suffix).delete().catch(() => undefined);
  });
});

describe('schema version', () => {
  test('a log file from another schema version is refused, not misread', () => {
    const path = `${process.env['TMPDIR'] ?? '/tmp'}/judgment-log-old-${Bun.randomUUIDv7()}.sqlite`;
    const old = new Database(path, { create: true });
    old.exec('CREATE TABLE decisions (id TEXT PRIMARY KEY)');
    old.close();
    expect(() => new SqliteDecisionLog(path)).toThrow(RangeError);
    for (const suffix of ['', '-wal', '-shm']) Bun.file(path + suffix).delete().catch(() => undefined);
  });
});
