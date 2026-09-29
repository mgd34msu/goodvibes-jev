/**
 * One unit check (contract/check.ts) through the fake judgment port: every
 * row of the outcome table (design 4.6), the readings-to-verdicts mapping at
 * the band edges (4.5), the stall rule applied to a nudge, severities, and a
 * missing port failing loudly.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readYesNo, STAKES_BANDS } from '@goodvibes-jev/judgment';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { DELIVERABLE_JUDGES, deliverableVerdict } from '../../sdk/src/platform/contract/batteries/deliverable-judge.js';
import { GROUP_JUDGES, groupVerdict } from '../../sdk/src/platform/contract/batteries/group-judge.js';
import { UNIT_JUDGE_BANDS, UNIT_JUDGES, criterionVerdict as unitJudgeVerdict } from '../../sdk/src/platform/contract/batteries/unit-judge.js';
import { MID_RUN_QUALITY_ITEMS, UNIT_QUALITY_BAND, midRunNudgeItems, qualityVerdict as unitQualityVerdict } from '../../sdk/src/platform/contract/batteries/unit-quality.js';
import { registry } from '../../sdk/src/platform/contract/judgment-registry.js';
import { QUALITY_ITEMS, type QualityItem } from '../../sdk/src/platform/contract/types.js';
import {
  applySeverities,
  applyUnitCheck,
  criterionVerdict,
  qualityVerdict,
  readUnmetSeverities,
  runUnitCheck,
  unitMustWrite,
  type CheckSettings,
  type DecidedCheck,
  type UnitCheckInput,
} from '../../sdk/src/platform/contract/check.js';
import type { UnitEvidence } from '../../sdk/src/platform/contract/evidence.js';
import type { ContractUnit, RequestShape, UnitCheck } from '../../sdk/src/platform/contract/types.js';
import { checkPort, MET, UNMET, type CheckAnswers } from './check-port.js';
import { makeContract, makeCriterion, makeUnit } from './fixtures.js';

const SETTINGS: CheckSettings = { acceptanceStakes: 'high', evidenceNudgeLimit: 2, stallLimit: 3, maxNudgesPerUnit: 12 };

function evidence(overrides: Partial<UnitEvidence> = {}): UnitEvidence {
  return {
    output: 'Implemented the parser and its tests.',
    changedPaths: ['src/parser.ts'],
    diff: '+++ b/src/parser.ts\n+export function parse() {}',
    omitted: [],
    claims: { claimedPaths: ['src/parser.ts'], foundPaths: ['src/parser.ts'], missingPaths: [], changesDetected: true, kind: 'files_verified', verified: true, summary: '1/1 claimed paths found on disk; kind: files_verified' },
    gates: [{ gate: 'typecheck', passed: true, output: '', durationMs: 5, skipped: false }],
    commands: [{ command: 'bun test', success: true, head: '3 pass' }],
    ...overrides,
  };
}

function twoCriterionUnit(overrides: Partial<ContractUnit> = {}): ContractUnit {
  return makeUnit({
    criteria: [
      makeCriterion({ id: 'u1.c1', text: 'parse accepts ISO dates', origin: 'derived', serves: ['c1'], quote: undefined }),
      makeCriterion({ id: 'u1.c2', text: 'parse rejects empty input with an error', origin: 'derived', serves: ['c1'], quote: undefined }),
    ],
    status: 'held',
    ...overrides,
  });
}

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  previous = installJudgmentPort(undefined);
});
afterEach(() => {
  installJudgmentPort(previous);
});

async function check(answers: CheckAnswers, input: Partial<UnitCheckInput> = {}): Promise<DecidedCheck> {
  const port = checkPort(answers);
  installJudgmentPort(port.port);
  const outcome = await runUnitCheck({
    contract: makeContract(),
    unit: twoCriterionUnit(),
    trigger: 'completion',
    evidence: evidence(),
    settings: SETTINGS,
    now: 2_000,
    ...input,
  });
  if (outcome.discarded) throw new Error('check was discarded');
  return outcome;
}

describe('readings to verdicts at the band edges (4.5)', () => {
  const high = (p: number) => criterionVerdict(readYesNo({ type: 'noul', noul: p }, UNIT_JUDGE_BANDS.high));
  const critical = (p: number) => criterionVerdict(readYesNo({ type: 'noul', noul: p }, UNIT_JUDGE_BANDS.critical));

  test('leaning fails is unmet at any outcome', () => {
    expect(high(0.75)).toBe('unmet'); // yes at act
    expect(high(0.6)).toBe('unmet'); // yes at confirm
    expect(high(0.59)).toBe('unmet'); // leans yes, below the yes band: escalate
    expect(high(0.5)).toBe('unmet'); // a tie leans yes
  });

  test('met needs a no at act; a weaker no or an unsettled lean to no is unshown', () => {
    expect(high(0.15)).toBe('met'); // 1 - p = 0.85, the high act threshold
    expect(high(0.16)).toBe('unshown'); // no at confirm
    expect(high(0.3)).toBe('unshown'); // 1 - p = 0.7, the high confirm threshold
    expect(high(0.31)).toBe('unshown'); // below confirm on the no side: escalate
    expect(high(0.49)).toBe('unshown');
  });

  test('under critical stakes no reading alone passes a criterion', () => {
    expect(critical(0.01)).toBe('unshown');
    expect(critical(0.6)).toBe('unmet');
  });

  test('quality items: a lean to yes is a problem, a no at act is clean, anything else unshown', () => {
    const quality = (p: number) => qualityVerdict(readYesNo({ type: 'noul', noul: p }, UNIT_QUALITY_BAND));
    expect(quality(0.55)).toBe('problem');
    expect(quality(0.75)).toBe('problem');
    expect(quality(0.15)).toBe('clean');
    expect(quality(0.2)).toBe('unshown');
    expect(quality(0.45)).toBe('unshown');
  });

  test('the declared bands are the design bands', () => {
    expect(UNIT_JUDGE_BANDS.high).toEqual({ yes: STAKES_BANDS.medium.confidence, no: STAKES_BANDS.high.confidence });
    expect(UNIT_JUDGE_BANDS.critical).toEqual({ yes: STAKES_BANDS.medium.confidence, no: STAKES_BANDS.critical.confidence });
  });

  test('the mappings are declared beside the bands, and the group and deliverable judges reuse the unit mapping', () => {
    expect(criterionVerdict).toBe(unitJudgeVerdict);
    expect(qualityVerdict).toBe(unitQualityVerdict);
    expect(groupVerdict).toBe(unitJudgeVerdict);
    expect(deliverableVerdict).toBe(unitJudgeVerdict);
  });

  test('each acceptance-stakes instance of the three judges is its own registered decision', () => {
    const judges = [UNIT_JUDGES, GROUP_JUDGES, DELIVERABLE_JUDGES];
    expect(judges.map((byStakes) => [byStakes.high.name, byStakes.critical.name])).toEqual([
      ['contract.unit-judge', 'contract.unit-judge.critical'],
      ['contract.group-judge', 'contract.group-judge.critical'],
      ['contract.deliverable-judge', 'contract.deliverable-judge.critical'],
    ]);
    for (const byStakes of judges) {
      expect(registry.get(byStakes.high.name)).toBe(byStakes.high);
      expect(registry.get(byStakes.critical.name)).toBe(byStakes.critical);
      expect(byStakes.critical.fixtureCount).toBe(byStakes.high.fixtureCount);
    }
  });

  test('the mid-run rule: only items marked mid-run, read yes at act', () => {
    const at = (p: number) => readYesNo({ type: 'noul', noul: p }, UNIT_QUALITY_BAND);
    const readings = (problems: Partial<Record<QualityItem, number>>) =>
      Object.fromEntries(QUALITY_ITEMS.map((item) => [item, at(problems[item] ?? 0.05)])) as Record<QualityItem, ReturnType<typeof at>>;
    expect([...MID_RUN_QUALITY_ITEMS]).toEqual(['tests_weakened', 'breaks_existing', 'out_of_scope']);
    expect(midRunNudgeItems(readings({ tests_weakened: 0.9, out_of_scope: 0.8, placeholder: 0.95 }))).toEqual(['tests_weakened', 'out_of_scope']);
    // A problem below act (a yes at confirm, a lean to yes that escalates) waits for the finished check.
    expect(midRunNudgeItems(readings({ breaks_existing: 0.65, out_of_scope: 0.55 }))).toEqual([]);
    expect(midRunNudgeItems(readings({}))).toEqual([]);
  });

  test('a check uses the band the acceptance stakes choose', async () => {
    const high = await check({ criteria: [0.1, 0.1] });
    expect(high.check.result).toBe('pass');
    const critical = await check({ criteria: [0.1, 0.1], goal: 0.1 }, { settings: { ...SETTINGS, acceptanceStakes: 'critical' } });
    expect([...critical.verdicts.values()]).toEqual(['unshown', 'unshown']);
    expect(critical.check.result).toBe('nudge');
  });
});

describe('check outcomes, in table order (4.6)', () => {
  test('row 1: a unit cancelled while its check ran is discarded', async () => {
    const unit = twoCriterionUnit();
    const port = checkPort({}, () => {
      unit.status = 'cancelled';
    });
    installJudgmentPort(port.port);
    const outcome = await runUnitCheck({ contract: makeContract(), unit, trigger: 'completion', evidence: evidence(), settings: SETTINGS, now: 1 });
    expect(outcome.discarded).toBe(true);
    expect(outcome.usage.calls).toBe(2);
  });

  test('row 1: an aborted check is discarded', async () => {
    const controller = new AbortController();
    const port = checkPort({}, () => controller.abort());
    installJudgmentPort(port.port);
    const outcome = await runUnitCheck({ contract: makeContract(), unit: twoCriterionUnit(), trigger: 'completion', evidence: evidence(), settings: SETTINGS, now: 1, signal: controller.signal });
    expect(outcome.discarded).toBe(true);
  });

  describe('row 2: turn-end', () => {
    const midRun = { trigger: 'turn-end' as const, evidence: evidence({ claims: undefined, gates: undefined }) };

    test('unmet criteria and non-mid-run problems are recorded, not nudged', async () => {
      const outcome = await check({ criteria: [UNMET, MET], quality: { placeholder: UNMET } }, midRun);
      expect(outcome.check.result).toBe('recorded');
      expect(outcome.check.problems).toEqual(['unmet', 'quality']);
      expect(outcome.nudge).toBeUndefined();
    });

    test('a mid-run quality item at act is nudged, alone', async () => {
      const outcome = await check({ criteria: [UNMET, MET], quality: { tests_weakened: UNMET } }, midRun);
      expect(outcome.check.result).toBe('nudge');
      expect(outcome.nudge?.kinds).toEqual(['quality']);
      expect(outcome.nudge?.text).toContain('Existing tests or checks were deleted');
      expect(outcome.nudge?.text).not.toContain('Not met:');
    });

    test('a mid-run quality item below act is only recorded', async () => {
      const outcome = await check({ quality: { out_of_scope: 0.65 } }, midRun);
      expect(outcome.check.qualityProblems).toEqual(['out_of_scope']);
      expect(outcome.check.result).toBe('recorded');
    });

    test('a regression is nudged mid-run', async () => {
      const unit = twoCriterionUnit();
      unit.criteria[0]!.readings.push({ checkId: 'u1.k1', at: 1, probabilityUnmet: MET, verdict: 'met', outcome: 'act', decisionId: undefined });
      unit.checks.push(recordedCheck('u1.k1', 'completion', 'nudge', ['unmet']));
      const outcome = await check({ criteria: [UNMET, MET] }, { ...midRun, unit });
      expect(outcome.check.result).toBe('nudge');
      expect(outcome.nudge?.kinds).toEqual(['regression']);
      expect(outcome.nudge?.criterionIds).toEqual(['u1.c1']);
      expect(outcome.regressions).toEqual([{ criterionId: 'u1.c1', metAtCheckId: 'u1.k1' }]);
    });

    test('nothing wrong is recorded', async () => {
      expect((await check({}, midRun)).check.result).toBe('recorded');
    });
  });

  test('row 3: a failing gate nudges even when every reading is met', async () => {
    const outcome = await check({}, { evidence: evidence({ gates: [{ gate: 'typecheck', passed: false, output: 'src/parser.ts(3,1): error TS2304', durationMs: 5, skipped: false }] }) });
    expect(outcome.check.result).toBe('nudge');
    expect(outcome.nudge?.kinds).toEqual(['gate']);
    expect(outcome.nudge?.text).toContain('Gate failures:\n- typecheck:\n  src/parser.ts(3,1): error TS2304');
  });

  test('row 3: a skipped gate never fails the unit', async () => {
    const outcome = await check({}, { evidence: evidence({ gates: [{ gate: 'lint', passed: true, output: 'Skipped: no ESLint config found', durationMs: 0, skipped: true }] }) });
    expect(outcome.check.result).toBe('pass');
  });

  test('row 4: unverified claims nudge with the missing paths', async () => {
    const claims = { claimedPaths: ['src/a.ts'], foundPaths: [], missingPaths: ['src/a.ts'], changesDetected: false, kind: 'unverified' as const, verified: false, summary: 'missing' };
    const outcome = await check({}, { evidence: evidence({ claims }) });
    expect(outcome.check.result).toBe('nudge');
    expect(outcome.nudge?.kinds).toEqual(['claims']);
    expect(outcome.nudge?.text).toContain('- src/a.ts (claimed as created or modified; not present)');
  });

  test('row 4: no claims and no changes nudges a unit that must write, not one that reads', async () => {
    const claims = { claimedPaths: [], foundPaths: [], missingPaths: [], changesDetected: false, kind: 'unverifiable_no_claims' as const, verified: false, summary: 'none' };
    const noWork = evidence({ claims, changedPaths: [], diff: '' });
    const writer = await check({}, { evidence: noWork });
    expect(writer.nudge?.kinds).toEqual(['claims']);
    expect(writer.nudge?.text).toContain('No changed files were found');
    const researcher = await check({}, { evidence: noWork, unit: twoCriterionUnit({ role: 'research' }) });
    expect(researcher.check.result).toBe('pass');
    const withChanges = await check({}, { evidence: evidence({ claims }) });
    expect(withChanges.check.result).toBe('pass');
  });

  test('row 4: a request that forbids writing means no unit must write', () => {
    const forbids: RequestShape['forbids_writing'] = { verdict: 'yes', probability: 0.9, outcome: 'act' };
    const shape = { forbids_writing: forbids } as unknown as RequestShape;
    expect(unitMustWrite(makeContract({ shape }), { role: 'implement' })).toBe(false);
    expect(unitMustWrite(makeContract(), { role: 'integration' })).toBe(true);
    expect(unitMustWrite(makeContract(), { role: 'design' })).toBe(false);
    // Only a yes at act forbids writing: a yes below act leaves the unit writing.
    const unsure = { forbids_writing: { verdict: 'yes', probability: 0.7, outcome: 'confirm' } } as unknown as RequestShape;
    expect(unitMustWrite(makeContract({ shape: unsure }), { role: 'implement' })).toBe(true);
  });

  test('row 5: an unmet criterion nudges', async () => {
    const outcome = await check({ criteria: [MET, UNMET] });
    expect(outcome.check.result).toBe('nudge');
    expect(outcome.nudge?.kinds).toEqual(['unmet']);
    expect(outcome.nudge?.criterionIds).toEqual(['u1.c2']);
    expect(outcome.unmetCriterionIds).toEqual(['u1.c2']);
  });

  test('row 5: an unmet goal nudges with the goal line', async () => {
    const outcome = await check({ goal: UNMET });
    expect(outcome.nudge?.kinds).toEqual(['unmet']);
    expect(outcome.nudge?.text).toContain('Goal: The work as a whole does not yet do what the unit is for: Parse every documented input form');
  });

  test('row 5: a quality problem nudges', async () => {
    const outcome = await check({ quality: { hidden_failure: UNMET } });
    expect(outcome.nudge?.kinds).toEqual(['quality']);
  });

  test('rows 3 to 5 together: every applicable kind, with the unshown ones listed too', async () => {
    const outcome = await check(
      { criteria: [UNMET, 0.3], quality: { placeholder: UNMET } },
      { evidence: evidence({ gates: [{ gate: 'test', passed: false, output: '1 fail', durationMs: 1, skipped: false }] }) },
    );
    expect(outcome.nudge?.kinds).toEqual(['unmet', 'unshown', 'quality', 'gate']);
    expect(outcome.nudge?.criterionIds).toEqual(['u1.c1', 'u1.c2']);
  });

  test('row 6: unshown readings below the evidence limit ask for evidence', async () => {
    const unit = twoCriterionUnit();
    unit.checks.push(recordedCheck('u1.k1', 'completion', 'nudge', ['unshown']));
    const outcome = await check({ criteria: [MET, 0.3] }, { unit });
    expect(outcome.check.result).toBe('nudge');
    expect(outcome.nudge?.kinds).toEqual(['unshown']);
    expect(outcome.nudge?.text).toContain('Not shown (show evidence');
  });

  test('row 6: an unshown quality item or goal is asked for too', async () => {
    const outcome = await check({ goal: 0.3, quality: { tests_weakened: 0.3 } });
    expect(outcome.nudge?.kinds).toEqual(['unshown']);
    expect(outcome.nudge?.text).toContain('- [goal] Parse every documented input form');
    expect(outcome.nudge?.text).toContain('- [quality] Show that no existing test or check was deleted, skipped or loosened.');
  });

  test('row 7: at the evidence limit the owner is asked to confirm', async () => {
    const unit = twoCriterionUnit();
    unit.checks.push(recordedCheck('u1.k1', 'completion', 'nudge', ['unshown']));
    unit.checks.push(recordedCheck('u1.k2', 'turn-end', 'recorded', ['unshown']));
    unit.checks.push(recordedCheck('u1.k3', 'completion', 'nudge', ['unshown']));
    const outcome = await check({ criteria: [MET, 0.3] }, { unit });
    expect(outcome.check.result).toBe('await-owner');
    expect(outcome.nudge).toBeUndefined();
  });

  test('row 8: everything met, clean, gated and verified passes', async () => {
    const outcome = await check({});
    expect(outcome.check.result).toBe('pass');
    expect(outcome.check.problems).toEqual([]);
    expect(outcome.nudge).toBeUndefined();
    expect([...outcome.verdicts.values()]).toEqual(['met', 'met']);
  });

  test('a nudge that would stall the unit is a stall instead, and still carries its text', async () => {
    const unit = twoCriterionUnit();
    for (const n of [1, 2, 3]) {
      unit.checks.push(recordedCheck(`u1.k${n}`, 'completion', 'nudge', ['unmet']));
      unit.criteria[0]!.readings.push({ checkId: `u1.k${n}`, at: n, probabilityUnmet: MET, verdict: 'met', outcome: 'act', decisionId: undefined });
      unit.criteria[1]!.readings.push({ checkId: `u1.k${n}`, at: n, probabilityUnmet: UNMET, verdict: 'unmet', outcome: 'act', decisionId: undefined });
    }
    const outcome = await check({ criteria: [MET, UNMET] }, { unit });
    expect(outcome.check.result).toBe('stall');
    expect(outcome.stall).toEqual({ kind: 'no-progress', checks: 3 });
    expect(outcome.nudge?.kinds).toEqual(['unmet']);
  });
});

describe('the check record and applying it', () => {
  test('records readings, verdicts, goal, quality, decision ids and an evidence digest', async () => {
    const outcome = await check({ criteria: [MET, UNMET] });
    expect(outcome.check.id).toBe('u1.k1');
    expect(outcome.check.trigger).toBe('completion');
    expect(outcome.check.goal).toEqual({ probabilityUnmet: MET, verdict: 'met', outcome: 'act' });
    expect(outcome.check.quality.placeholder).toEqual({ verdict: 'no', outcome: 'act' });
    expect(outcome.check.claims?.kind).toBe('files_verified');
    expect(outcome.check.evidenceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.readings.get('u1.c2')).toEqual({ checkId: 'u1.k1', at: 2_000, probabilityUnmet: UNMET, verdict: 'unmet', outcome: 'act', decisionId: undefined });
    expect(outcome.usage).toEqual({ calls: 2, inputTokens: 2, outputTokens: 2 });
  });

  test('excluded and met-by-structure criteria are never judged', async () => {
    const unit = twoCriterionUnit();
    unit.criteria.push(makeCriterion({ id: 'u1.c3', disposition: 'excluded', origin: 'derived', serves: ['c1'], quote: undefined }));
    const port = checkPort({});
    installJudgmentPort(port.port);
    const outcome = await runUnitCheck({ contract: makeContract(), unit, trigger: 'completion', evidence: evidence(), settings: SETTINGS, now: 1 });
    const judgeRequest = port.requests.find((request) => 'goal' in request.questions)!;
    expect(Object.keys(judgeRequest.questions).sort()).toEqual(['criterion_0', 'criterion_1', 'goal']);
    expect(outcome.discarded === false && outcome.readings.has('u1.c3')).toBe(false);
  });

  test('applyUnitCheck appends readings, sets statuses, appends the check and adds touched paths', async () => {
    const unit = twoCriterionUnit({ touchedPaths: ['README.md'] });
    const outcome = await check({ criteria: [MET, UNMET] }, { unit, evidence: evidence({ changedPaths: ['src/parser.ts', 'README.md'] }) });
    applyUnitCheck(unit, outcome);
    expect(unit.criteria.map((criterion) => criterion.status)).toEqual(['met', 'unmet']);
    expect(unit.criteria[1]!.readings).toHaveLength(1);
    expect(unit.checks.map((c) => c.id)).toEqual(['u1.k1']);
    expect(unit.touchedPaths).toEqual(['README.md', 'src/parser.ts']);
  });

  test('a missing judgment port throws the port error; there is no other path', async () => {
    installJudgmentPort(undefined);
    await expect(runUnitCheck({ contract: makeContract(), unit: twoCriterionUnit(), trigger: 'completion', evidence: evidence(), settings: SETTINGS, now: 1 })).rejects.toBeInstanceOf(JudgmentPortMissingError);
  });
});

describe('severity of unmet criteria', () => {
  test('severities at act are recorded on the check readings and shown from the next nudge on', async () => {
    const unit = twoCriterionUnit();
    const first = await check({ criteria: [MET, UNMET] }, { unit });
    expect(first.nudge?.text).toContain('- [u1.c2] parse rejects empty input with an error\n');
    applyUnitCheck(unit, first);
    const port = checkPort({ severity: { choice: 'critical', confidence: 0.9 } });
    installJudgmentPort(port.port);
    const { severities, usage } = await readUnmetSeverities({ contract: makeContract(), unit, criterionIds: first.unmetCriterionIds });
    expect(severities.get('u1.c2')?.severity).toBe('critical');
    expect(usage.calls).toBe(1);
    expect(port.requests[0]!.state).toEqual({ request: makeContract().ask, goal: unit.goal, criterion: 'parse rejects empty input with an error' });
    applySeverities(unit, 'u1.k1', severities);
    expect(unit.criteria[1]!.readings[0]!.severity).toBe('critical');

    const second = await check({ criteria: [MET, UNMET] }, { unit });
    expect(second.nudge?.text).toContain('- [u1.c2] parse rejects empty input with an error (critical)');
  });

  test('the severity reading is named on the criterion reading whether or not it settled', () => {
    const unit = twoCriterionUnit();
    unit.criteria[0]!.readings.push({ checkId: 'u1.k1', at: 1, probabilityUnmet: 0.9, verdict: 'unmet', outcome: 'act', decisionId: 'judge-1' });
    unit.criteria[1]!.readings.push({ checkId: 'u1.k1', at: 1, probabilityUnmet: 0.9, verdict: 'unmet', outcome: 'act', decisionId: 'judge-1' });
    applySeverities(unit, 'u1.k1', new Map([
      ['u1.c1', { severity: undefined, decisionId: 'severity-1' }],
      ['u1.c2', { severity: 'major', decisionId: 'severity-2' }],
    ]));
    expect(unit.criteria[0]!.readings[0]).toMatchObject({ severityDecisionId: 'severity-1' });
    expect(unit.criteria[0]!.readings[0]!.severity).toBeUndefined();
    expect(unit.criteria[1]!.readings[0]).toMatchObject({ severity: 'major', severityDecisionId: 'severity-2' });
  });

  test('a severity below act stays unknown', async () => {
    const port = checkPort({ severity: { choice: 'minor', confidence: 0.4 } });
    installJudgmentPort(port.port);
    const { severities } = await readUnmetSeverities({ contract: makeContract(), unit: twoCriterionUnit(), criterionIds: ['u1.c1'] });
    expect(severities.get('u1.c1')?.severity).toBeUndefined();
  });
});

function recordedCheck(id: string, trigger: UnitCheck['trigger'], result: UnitCheck['result'], problems: UnitCheck['problems']): UnitCheck {
  const clean = { verdict: 'no' as const, outcome: 'act' as const };
  return {
    id,
    at: 1,
    trigger,
    goal: { probabilityUnmet: MET, verdict: 'met', outcome: 'act' },
    quality: { placeholder: clean, tests_weakened: clean, breaks_existing: clean, out_of_scope: clean, hidden_failure: clean, unsupported_claims: clean },
    result,
    problems,
    qualityProblems: [],
    decisionIds: [],
    evidenceDigest: 'x',
  };
}
