import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  actionOf,
  calibrate,
  defineBattery,
  hashState,
  isoTime,
  noul,
  SqliteDecisionLog,
  STAKES_BANDS,
  toJson,
  truthOf,
  withDecisionLog,
  yesNo,
  type DecisionContext,
  type DecisionEntry,
  type DecisionId,
  type DecisionLog,
  type DecisionNote,
  type DecisionQuery,
  type FixtureCheck,
  type JudgmentPort,
  type JudgmentRequest,
  type NamedDecision,
  type NewDecisionEntry,
  type Questions,
} from '../src/index.ts';
import { fakePort, noulAnswer } from '../src/testing/fake-port.ts';

const endpoint = { kind: 'test', baseURL: 'http://calibration.test' };
const fixedNow = () => new Date('2026-10-01T00:00:00.000Z');
const name = 'test.attribution';
const questions = { q: noul('Is it urgent?') };
const context = { site: 'calibration', battery: name, fixture: 'shared' };
const boundedQuery = { site: 'calibration', status: 'answered', limit: 100_000 } as const;
const answering = () => fakePort(() => noulAnswer(0.95)).port;

const battery = defineBattery({
  name,
  version: 1,
  description: 'Calibration attribution regression',
  accuracyFloor: 1,
  items: { q: yesNo('Is it urgent?', STAKES_BANDS.medium.yesNo) },
  fixtures: [{ name: 'shared', state: 'urgent', expect: { q: 'yes' } }],
});

function check(fixture = 'shared', marker = 'yes'): FixtureCheck {
  return { fixture, aspect: 'q', expected: marker, got: marker, correct: true, signal: 0.95, outcome: 'act' };
}

function decision(run: NamedDecision['checkFixtures']): NamedDecision {
  return { name, version: 1, description: 'Calibration attribution regression', accuracyFloor: 1, fixtureCount: 1, checkFixtures: run };
}

function answered(callContext: DecisionContext = context): Extract<NewDecisionEntry, { status: 'answered' }> {
  return {
    at: isoTime(fixedNow()), context: callContext, stateHash: hashState('urgent'), questions: toJson(questions),
    requestedModel: 'jev-1.13.0', model: 'jev-1.13.0', status: 'answered', answers: { q: noulAnswer(0.95) },
    usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1, requestId: undefined,
  };
}

/** Opaque ids and insertion ordering deliberately have no lexical relationship. */
class OpaqueDecisionLog implements DecisionLog {
  readonly queries: DecisionQuery[] = [];
  readonly gets: string[] = [];
  readonly omittedFromWindow = new Set<string>();
  readonly #entries: DecisionEntry[] = [];
  readonly #ids: readonly string[];

  constructor(ids: readonly string[]) { this.#ids = ids; }

  record(entry: NewDecisionEntry): DecisionId {
    const raw = this.#ids[this.#entries.length];
    if (raw === undefined) throw new Error('test log ran out of ids');
    const id = raw as DecisionId;
    this.#entries.push(entry.status === 'answered' ? { ...entry, id, notes: [] } : { ...entry, id });
    return id;
  }

  attach(id: string, note: DecisionNote): void {
    const index = this.#entries.findIndex((entry) => entry.id === id);
    const entry = this.#entries[index];
    if (entry?.status !== 'answered') throw new RangeError('test log needs an answered entry');
    this.#entries[index] = { ...entry, notes: [...entry.notes, note] };
  }

  get(id: string): DecisionEntry | undefined {
    this.gets.push(id);
    return this.#entries.find((entry) => entry.id === id);
  }

  query(query: DecisionQuery = {}): readonly DecisionEntry[] {
    this.queries.push({ ...query });
    if (query.outcome !== undefined) throw new Error('outcome queries are not used by this test log');
    return [...this.#entries].reverse()
      .filter((entry) => !this.omittedFromWindow.has(entry.id)
        && (query.site === undefined || entry.context.site === query.site)
        && (query.battery === undefined || entry.context.battery === query.battery)
        && (query.status === undefined || entry.status === query.status)
        && (query.since === undefined || entry.at >= query.since)
        && (query.until === undefined || entry.at < query.until))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, query.limit ?? 1000);
  }
}

describe('calibration truth belongs to the returned calls of this run', () => {
  test('a current-only SQLite log retains prior truth and records a fresh call at the same timestamp', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const oldId = log.record(answered());
    const oldTruth = { source: 'owner', checks: [check('shared', 'earlier')] } as const;
    log.attach(oldId, { kind: 'truth', truth: oldTruth });

    const report = await calibrate(withDecisionLog(answering(), log, fixedNow), [battery], { endpoint, log });
    const entries = log.query();
    const fresh = entries.find((entry) => entry.id !== oldId)!;
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((entry) => entry.at)).size).toBe(1);
    expect(report.decisions[0]).toMatchObject({ passed: true, truthRecorded: 1 });
    expect(truthOf(fresh)).toEqual({ source: 'fixture', checks: report.decisions[0]!.checks });
    expect(truthOf(log.get(oldId)!)).toEqual(oldTruth);
  });

  test('mixed persisted legacy and generated ids with equal timestamps do not form a lexical watermark', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'calibration-mixed-ids-'));
    try {
      const path = join(dir, 'decisions.sqlite');
      using log = new SqliteDecisionLog(path);
      const currentId = log.record(answered());
      const legacyId = 'ffffffff-ffff-7fff-bfff-ffffffffffff';
      const db = new Database(path);
      try {
        db.query('INSERT INTO decisions (id, entry) VALUES (?, ?)').run(legacyId, JSON.stringify(answered()));
      } finally { db.close(); }

      const report = await calibrate(withDecisionLog(answering(), log, fixedNow), [battery], { endpoint, log });
      const entries = log.query();
      const fresh = entries.find((entry) => entry.id !== currentId && entry.id !== legacyId)!;
      expect(entries).toHaveLength(3);
      expect(new Set(entries.map((entry) => entry.at)).size).toBe(1);
      expect(report.decisions[0]).toMatchObject({ passed: true, truthRecorded: 1 });
      expect(truthOf(fresh)).toEqual({ source: 'fixture', checks: report.decisions[0]!.checks });
      expect(truthOf(log.get(currentId)!)).toBeUndefined();
      expect(truthOf(log.get(legacyId)!)).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('opaque nonmonotonic ids use identical bounded before/after queries and retain every fixture check', async () => {
    const log = new OpaqueDecisionLog(['z-before', 'a-current', 'm-current']);
    log.record(answered());
    const checks = [check('one'), { ...check('one'), aspect: 'second' }, check('two')];
    const run = decision(async (port) => {
      for (const fixture of ['one', 'two']) {
        await port.ask({ state: fixture, questions, context: { ...context, fixture } });
      }
      return checks;
    });
    const report = await calibrate(withDecisionLog(answering(), log, fixedNow), [run], { endpoint, log });

    expect(report.decisions[0]).toMatchObject({ passed: true, truthRecorded: 2 });
    expect(log.queries).toEqual([boundedQuery, boundedQuery]);
    expect(log.gets).toEqual([]);
    expect(truthOf(log.get('z-before')!)).toBeUndefined();
    expect(truthOf(log.get('a-current')!)).toEqual({ source: 'fixture', checks: checks.slice(0, 2) });
    expect(truthOf(log.get('m-current')!)).toEqual({ source: 'fixture', checks: checks.slice(2) });
  });

  test('a stale returned fixture id cannot replace old truth or claim an unreturned concurrent call', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const staleId = log.record(answered());
    const oldTruth = { source: 'owner', checks: [check('shared', 'old')] } as const;
    log.attach(staleId, { kind: 'truth', truth: oldTruth });
    const inner = answering();
    let unreturnedId = '';
    const port: JudgmentPort = {
      model: inner.model,
      async ask(request) {
        const result = await inner.ask(request);
        unreturnedId = log.record(answered());
        return { ...result, decisionId: staleId };
      },
    };
    const report = await calibrate(port, [battery], { endpoint, log });

    expect(report.decisions[0]).toMatchObject({ passed: true, truthRecorded: 0 });
    expect(truthOf(log.get(staleId)!)).toEqual(oldTruth);
    expect(truthOf(log.get(unreturnedId)!)).toBeUndefined();
  });

  test('overlapping runs of the same decision and fixture only attach their own returned calls', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const port = withDecisionLog(answering(), log, fixedNow);
    const bothStarted = Promise.withResolvers<void>();
    const bothRecorded = Promise.withResolvers<void>();
    const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const ids: string[] = [];
    let started = 0;
    let recorded = 0;
    const runs = [check('shared', 'first'), check('shared', 'second')].map((fixtureCheck, index) => decision(async (scoped) => {
      if (++started === 2) bothStarted.resolve();
      await bothStarted.promise;
      const result = await scoped.ask({ state: fixtureCheck.got, questions, context });
      ids[index] = result.decisionId!;
      if (++recorded === 2) bothRecorded.resolve();
      await release[index]!.promise;
      return [fixtureCheck];
    }));
    const pending = runs.map((run) => calibrate(port, [run], { endpoint, log }));
    try {
      await bothRecorded.promise;
      expect(new Set(ids).size).toBe(2);
      release[0]!.resolve();
      const first = await pending[0]!;
      expect(first.decisions[0]).toMatchObject({ passed: true, truthRecorded: 1 });
      expect(truthOf(log.get(ids[0]!)!)).toEqual({ source: 'fixture', checks: [check('shared', 'first')] });
      expect(truthOf(log.get(ids[1]!)!)).toBeUndefined();

      release[1]!.resolve();
      const second = await pending[1]!;
      expect(second.decisions[0]).toMatchObject({ passed: true, truthRecorded: 1 });
      expect(truthOf(log.get(ids[0]!)!)).toEqual({ source: 'fixture', checks: [check('shared', 'first')] });
      expect(truthOf(log.get(ids[1]!)!)).toEqual({ source: 'fixture', checks: [check('shared', 'second')] });
    } finally {
      for (const gate of release) gate.resolve();
      await Promise.all(pending);
    }
  });

  test('a recorded answer without a returned decisionId receives no fixture truth', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const recorded = withDecisionLog(answering(), log, fixedNow);
    const port: JudgmentPort = {
      model: recorded.model,
      async ask(request) {
        const { decisionId: _decisionId, ...result } = await recorded.ask(request);
        return result;
      },
    };
    const report = await calibrate(port, [battery], { endpoint, log });
    expect(report.decisions[0]).toMatchObject({ passed: true, truthRecorded: 0 });
    expect(log.query()).toHaveLength(1);
    expect(truthOf(log.query()[0]!)).toBeUndefined();
  });

  test('a returned id missing from the supplied log leaves existing fixture truth unchanged', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const staleId = log.record(answered());
    const inner = answering();
    const port: JudgmentPort = {
      model: inner.model,
      async ask(request) { return { ...await inner.ask(request), decisionId: 'missing-from-this-log' }; },
    };
    const report = await calibrate(port, [battery], { endpoint, log });
    expect(report.decisions[0]).toMatchObject({ passed: true, truthRecorded: 0 });
    expect(log.query()).toHaveLength(1);
    expect(truthOf(log.get(staleId)!)).toBeUndefined();
  });

  test('without a supplied log even a recording port keeps truthRecorded absent', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const report = await calibrate(withDecisionLog(answering(), log, fixedNow), [battery], { endpoint });
    expect(report.passed).toBe(true);
    expect(Object.hasOwn(report.decisions[0]!, 'truthRecorded')).toBe(false);
    expect(log.query()).toHaveLength(1);
    expect(truthOf(log.query()[0]!)).toBeUndefined();
  });

  test.each([true, false])('prefers an own battery call when present (%s), otherwise uses the returned delegated call', async (includeOwn) => {
    const log = new OpaqueDecisionLog(includeOwn ? ['own-call', 'helper-call'] : ['helper-call']);
    const run = decision(async (port) => {
      if (includeOwn) await port.ask({ state: 'own', questions, context });
      await port.ask({ state: 'helper', questions, context: { ...context, battery: 'test.helper' } });
      return [check()];
    });
    const report = await calibrate(withDecisionLog(answering(), log, fixedNow), [run], { endpoint, log });
    expect(report.decisions[0]).toMatchObject({ passed: true, truthRecorded: 1 });
    expect(truthOf(log.get(includeOwn ? 'own-call' : 'helper-call')!)).toEqual({ source: 'fixture', checks: [check()] });
    if (includeOwn) expect(truthOf(log.get('helper-call')!)).toBeUndefined();
  });

  test('repeated calls for one fixture use query recency rather than lexical id order', async () => {
    const log = new OpaqueDecisionLog(['z-first-call', 'a-latest-call']);
    const run = decision(async (port) => {
      await port.ask({ state: 'first', questions, context });
      await port.ask({ state: 'latest', questions, context });
      return [check()];
    });
    const report = await calibrate(withDecisionLog(answering(), log, fixedNow), [run], { endpoint, log });
    expect(report.decisions[0]).toMatchObject({ passed: true, truthRecorded: 1 });
    expect(truthOf(log.get('z-first-call')!)).toBeUndefined();
    expect(truthOf(log.get('a-latest-call')!)).toEqual({ source: 'fixture', checks: [check()] });
  });

  test.each(['site', 'status', 'fixture', 'missing-fixture'] as const)('a returned id still must match calibration %s', async (mismatch) => {
    using log = new SqliteDecisionLog(':memory:');
    const inner = answering();
    let id = '';
    const port: JudgmentPort = {
      model: inner.model,
      async ask(request) {
        const result = await inner.ask(request);
        const callContext = mismatch === 'missing-fixture' ? { site: 'calibration', battery: name }
          : { ...context, ...(mismatch === 'site' ? { site: 'production' } : {}), ...(mismatch === 'fixture' ? { fixture: 'another' } : {}) };
        const entry = answered(callContext);
        id = log.record(mismatch === 'status' ? { ...entry, status: 'failed', error: { kind: 'unavailable', message: 'test failure' } } : entry);
        return { ...result, decisionId: id };
      },
    };
    const report = await calibrate(port, [battery], { endpoint, log });
    expect(report.decisions[0]).toMatchObject({ passed: true, truthRecorded: 0 });
    expect(truthOf(log.get(id)!)).toBeUndefined();
  });

  test('a returned call absent from the bounded after window is not recovered through an unscoped get', async () => {
    const log = new OpaqueDecisionLog(['outside-window']);
    const run = decision(async (port) => {
      const result = await port.ask({ state: 'urgent', questions, context });
      // Model a bounded store query omitting this call, without allocating 100,000 filler rows.
      log.omittedFromWindow.add(result.decisionId!);
      return [check()];
    });
    const report = await calibrate(withDecisionLog(answering(), log, fixedNow), [run], { endpoint, log });
    expect(report.decisions[0]).toMatchObject({ passed: true, truthRecorded: 0 });
    expect(log.queries).toEqual([boundedQuery, boundedQuery]);
    expect(log.gets).toEqual([]);
    expect(truthOf(log.get('outside-window')!)).toBeUndefined();
  });

  test('the scoped port preserves class receivers, prototype metadata, recorder and the caller signal', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const inner = withDecisionLog(answering(), log, fixedNow);
    const controller = new AbortController();
    class ClassPort implements JudgmentPort {
      readonly #inner = inner;
      calls = 0;
      healthCalls = 0;
      get model() { return this.#inner.model; }
      get recorder() { return this.#inner.recorder!; }
      health() { this.healthCalls++; return this.#inner.health?.() ?? []; }
      ask<const Q extends Questions>(request: JudgmentRequest<Q>) {
        this.calls++;
        expect(request.signal).toBe(controller.signal);
        return this.#inner.ask(request);
      }
    }
    const port = new ClassPort();
    let id = '';
    const run = decision(async (scoped, options) => {
      expect(options?.signal).toBe(controller.signal);
      expect(scoped.model).toBe(port.model);
      expect(scoped.health?.()).toEqual([]);
      const result = await scoped.ask({ state: 'urgent', questions, context, signal: controller.signal });
      id = result.decisionId!;
      scoped.recorder!.recordAction(id, 'fixture action');
      return [check()];
    });
    const report = await calibrate(port, [run], { endpoint, log, signal: controller.signal });
    expect(report.decisions[0]).toMatchObject({ model: 'jev-1.13.0', passed: true, truthRecorded: 1 });
    expect(port.calls).toBe(1);
    expect(port.healthCalls).toBe(1);
    expect(actionOf(log.get(id)!)).toBe('fixture action');
    expect(truthOf(log.get(id)!)).toEqual({ source: 'fixture', checks: [check()] });
  });
});
