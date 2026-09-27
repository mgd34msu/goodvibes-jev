/**
 * The nudge text (contract/nudge.ts, design 4.7) against golden files: every
 * section in its fixed order, empty sections left out, met criteria restated
 * as binding. Also the "Previous checks" section, nudge records and delivery.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildNudge,
  buildPreviousChecks,
  checkNumberOf,
  createNudge,
  dispatchNudge,
  latestSeverity,
  nudgeDeliveryFor,
  type NudgeFindings,
  type NudgeTransport,
} from '../../sdk/src/platform/contract/nudge.js';
import type { ContractUnit, CriterionVerdict } from '../../sdk/src/platform/contract/types.js';
import { makeCriterion, makeUnit } from './fixtures.js';

const golden = (name: string): string => readFileSync(join(import.meta.dir, 'golden', `${name}.txt`), 'utf-8').replace(/\n$/, '');

function unit(): ContractUnit {
  const criterion = (id: string, text: string) => makeCriterion({ id, text, origin: 'derived', serves: ['c1'], quote: undefined });
  return makeUnit({
    title: 'Date parser',
    goal: 'parseDate reads every documented date form',
    criteria: [
      criterion('u1.c1', 'parseDate accepts ISO 8601 dates'),
      criterion('u1.c2', 'parseDate accepts RFC 2822 dates'),
      criterion('u1.c3', 'parseDate throws a RangeError naming the input on anything else'),
      criterion('u1.c4', 'The parser tests pass'),
      criterion('u1.c5', 'parseDate is exported from src/index.ts'),
      makeCriterion({ id: 'u1.c6', text: 'One agent per date form', disposition: 'excluded', origin: 'derived', serves: ['c2'], quote: undefined }),
    ],
  });
}

function findings(overrides: Partial<NudgeFindings>): NudgeFindings {
  return {
    checkNumber: 3,
    kinds: [],
    verdicts: new Map(),
    regressions: [],
    goalVerdict: 'met',
    qualityProblems: [],
    qualityUnshown: [],
    failedGates: [],
    ...overrides,
  };
}

const verdicts = (entries: Readonly<Record<string, CriterionVerdict>>) => new Map(Object.entries(entries));

describe('nudge text golden files', () => {
  test('every section, in order, with severities where known and met criteria restated', () => {
    const subject = unit();
    subject.criteria[1]!.readings.push({ checkId: 'u1.k2', at: 1, probabilityUnmet: 0.9, verdict: 'unmet', outcome: 'act', severity: 'major', decisionId: undefined });
    const text = buildNudge(subject, findings({
      kinds: ['unmet', 'unshown', 'regression', 'quality', 'gate', 'claims'],
      verdicts: verdicts({ 'u1.c1': 'unmet', 'u1.c2': 'unmet', 'u1.c3': 'unmet', 'u1.c4': 'unshown', 'u1.c5': 'met' }),
      regressions: [{ criterionId: 'u1.c3', metAtCheckId: 'u1.k2' }],
      goalVerdict: 'unmet',
      qualityProblems: ['placeholder', 'hidden_failure'],
      qualityUnshown: ['tests_weakened'],
      failedGates: [{ gate: 'typecheck', passed: false, output: 'src/date.ts(4,3): error TS2322: Type string is not assignable to type Date.\nFound 1 error.', durationMs: 900 }],
      claims: { missingPaths: ['src/date-rfc.ts'], noChanges: false },
    }));
    expect(text).toBe(golden('nudge-every-section'));
  });

  test('empty sections are left out, and nothing met means no met list', () => {
    const text = buildNudge(unit(), findings({
      checkNumber: 1,
      kinds: ['unshown'],
      verdicts: verdicts({ 'u1.c1': 'unshown', 'u1.c2': 'unshown', 'u1.c3': 'unshown', 'u1.c4': 'unshown', 'u1.c5': 'unshown' }),
      goalVerdict: 'unshown',
    }));
    expect(text).toBe(golden('nudge-evidence-only'));
  });

  test('a mid-run regression names only the regression, and restates every met criterion', () => {
    const text = buildNudge(unit(), findings({
      checkNumber: 4,
      kinds: ['regression'],
      verdicts: verdicts({ 'u1.c1': 'met', 'u1.c2': 'unmet', 'u1.c3': 'met', 'u1.c4': 'unshown', 'u1.c5': 'met' }),
      regressions: [{ criterionId: 'u1.c2', metAtCheckId: 'u1.k3' }],
    }));
    expect(text).toBe(golden('nudge-regression'));
  });

  test('a unit that must write but changed nothing', () => {
    const text = buildNudge(unit(), findings({
      checkNumber: 1,
      kinds: ['unmet', 'claims'],
      verdicts: verdicts({ 'u1.c1': 'unmet', 'u1.c2': 'unmet', 'u1.c3': 'unmet', 'u1.c4': 'unmet', 'u1.c5': 'unmet' }),
      goalVerdict: 'unmet',
      claims: { missingPaths: [], noChanges: true },
    }));
    expect(text).toBe(golden('nudge-no-changes'));
  });

  test('a gate failure shows only the last 40 lines of its output', () => {
    const output = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join('\n');
    const text = buildNudge(unit(), findings({ kinds: ['gate'], failedGates: [{ gate: 'test', passed: false, output, durationMs: 1 }] }));
    expect(text).toContain('- test:\n  line 21\n');
    expect(text).not.toContain('line 20\n');
    expect(text).toContain('  line 60');
  });
});

describe('previous checks', () => {
  test('the latest verdict of each judged criterion, with severity on unmet ones', () => {
    const subject = unit();
    subject.checks.push({} as ContractUnit['checks'][number]);
    const read = (index: number, checkId: string, verdict: CriterionVerdict, severity?: 'critical' | 'major' | 'minor') =>
      subject.criteria[index]!.readings.push({ checkId, at: 1, probabilityUnmet: 0.5, verdict, outcome: 'act', severity, decisionId: undefined });
    read(0, 'u1.k1', 'met');
    read(1, 'u1.k1', 'unmet', 'critical');
    read(1, 'u1.k2', 'unmet');
    read(2, 'u1.k2', 'unshown');
    read(3, 'u1.k2', 'met');
    expect(buildPreviousChecks(subject)).toBe(golden('previous-checks'));
  });

  test('empty before any check', () => {
    expect(buildPreviousChecks(unit())).toBe('');
  });
});

describe('helpers', () => {
  test('check numbers come from check ids', () => {
    expect(checkNumberOf('u1.k12')).toBe(12);
    expect(checkNumberOf('g1.f2.u3.k1')).toBe(1);
    expect(() => checkNumberOf('u1')).toThrow(RangeError);
  });

  test('the latest known severity is reused', () => {
    const criterion = makeCriterion({ id: 'x', readings: [
      { checkId: 'u1.k1', at: 1, probabilityUnmet: 0.9, verdict: 'unmet', outcome: 'act', severity: 'minor', decisionId: undefined },
      { checkId: 'u1.k2', at: 2, probabilityUnmet: 0.9, verdict: 'unmet', outcome: 'act', decisionId: undefined },
    ] });
    expect(latestSeverity(criterion)).toBe('minor');
  });

  test('nudge records are numbered per unit', () => {
    const subject = unit();
    const nudge = createNudge({ unit: subject, checkId: 'u1.k1', kinds: ['unmet'], criterionIds: ['u1.c1'], text: 't', delivery: 'hold', agentId: 'a1', at: 5 });
    expect(nudge).toEqual({ id: 'u1.n1', checkId: 'u1.k1', at: 5, kinds: ['unmet'], criterionIds: ['u1.c1'], text: 't', delivery: 'hold', agentId: 'a1' });
    subject.nudges.push(nudge);
    expect(createNudge({ unit: subject, checkId: 'u1.k2', kinds: [], criterionIds: [], text: '', delivery: 'bus', agentId: 'a1', at: 6 }).id).toBe('u1.n2');
  });
});

describe('delivery', () => {
  function transport(sendOk = true, wake = { woke: true, reason: 'woke' }) {
    const sent: unknown[] = [];
    const woken: unknown[] = [];
    const value: NudgeTransport = {
      messageBus: { send: (...args: unknown[]) => { sent.push(args); return sendOk; } } as unknown as NudgeTransport['messageBus'],
      agentManager: { wakeWithSteer: (...args: unknown[]) => { woken.push(args); return wake; } },
      nudgeTtlMs: 300_000,
    };
    return { value, sent, woken };
  }
  const nudge = createNudge({ unit: unit(), checkId: 'u1.k1', kinds: ['unmet'], criterionIds: [], text: 'fix it', delivery: 'hold', agentId: 'agent-1', at: 1 });

  test('each agent state has its delivery path', () => {
    expect(nudgeDeliveryFor('held')).toBe('hold');
    expect(nudgeDeliveryFor('running')).toBe('bus');
    expect(nudgeDeliveryFor('failed')).toBe('wake');
    expect(nudgeDeliveryFor('completed')).toBe('wake');
    expect(nudgeDeliveryFor('gone')).toBe('respawn');
  });

  test('a held agent continues with the nudge as its next user turn', () => {
    const t = transport();
    expect(dispatchNudge(nudge, 'held', t.value)).toEqual({ kind: 'continue', message: 'fix it', nudgeId: 'u1.n1' });
    expect(t.sent).toEqual([]);
  });

  test('a running agent gets a steer from the contract runner with the nudge id and ttl', () => {
    const t = transport();
    expect(dispatchNudge(nudge, 'running', t.value)).toEqual({ kind: 'sent' });
    expect(t.sent).toEqual([['contract-runner', 'agent-1', 'fix it', { kind: 'steer', ttlMs: 300_000, id: 'u1.n1' }]]);
    expect(dispatchNudge(nudge, 'running', transport(false).value)).toEqual({ kind: 'undelivered', reason: 'the message bus refused the nudge' });
  });

  test('a failed agent is woken; a completed one only with allowCompleted', () => {
    const t = transport();
    expect(dispatchNudge(nudge, 'failed', t.value)).toEqual({ kind: 'woke' });
    expect(dispatchNudge(nudge, 'completed', t.value)).toEqual({ kind: 'woke' });
    expect(t.woken).toEqual([['agent-1', 'fix it', undefined], ['agent-1', 'fix it', { allowCompleted: true }]]);
    expect(dispatchNudge(nudge, 'failed', transport(true, { woke: false, reason: 'unknown-agent' }).value)).toEqual({ kind: 'undelivered', reason: 'unknown-agent' });
  });
});
