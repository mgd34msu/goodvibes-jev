/**
 * One check of a unit (docs/design/contract-runner.md sections 4.4 to 4.6):
 * evidence in, Jev readings, an outcome out.
 *
 * Jev reads each criterion and the goal (`contract.unit-judge`) and the
 * quality items (`contract.unit-quality`) in two concurrent requests. Code
 * then maps each reading to a verdict by its band (4.5) and folds verdicts,
 * gate results and claim verification into the result (4.6), with regression
 * and stall rules from progress.ts. Gates and claims are deterministic inputs:
 * a failing gate or an unverified claim is a nudge whatever the readings say.
 * A pass is the only way a unit reaches `passed`, and it needs every judged
 * criterion and the goal read met at act, every quality item clean, gates
 * passed and claims verified.
 *
 * Unmet criteria get a severity reading (`contract.unmet-severity`) after the
 * nudge goes out, so it never delays one.
 */
import { hashState, leansYes, type JudgmentPort, type YesNoReading } from '@goodvibes-jev/judgment';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { UNIT_JUDGES } from './batteries/unit-judge.js';
import { MID_RUN_QUALITY_ITEMS, unitQuality } from './batteries/unit-quality.js';
import { unmetSeverity } from './batteries/unmet-severity.js';
import type { ContractAcceptanceStakes, ContractConfig } from './config.js';
import { judgeEvidence, judgeState, qualityState, type UnitEvidence } from './evidence.js';
import { failedGates } from './gates.js';
import { buildNudge, checkNumberOf, type NudgeFindings } from './nudge.js';
import {
  consecutiveUnsettledChecks,
  detectStall,
  findRegressions,
  standingOf,
  type Regression,
  type StallReason,
} from './progress.js';
import {
  QUALITY_ITEMS,
  type CheckResult,
  type CheckTrigger,
  type ContractUnit,
  type ContractView,
  type CriterionReading,
  type CriterionSeverity,
  type CriterionVerdict,
  type JudgmentUsage,
  type NudgeKind,
  type QualityItem,
  type UnitCheck,
  type YesNoVerdict,
} from './types.js';

/** Decision sites, as the decision log records them. */
export const CHECK_SITES = {
  judge: 'contract.check.unit-judge',
  quality: 'contract.check.unit-quality',
  severity: 'contract.check.unmet-severity',
} as const;

/** The settings a check reads. */
export interface CheckSettings {
  readonly acceptanceStakes: ContractAcceptanceStakes;
  readonly evidenceNudgeLimit: number;
  readonly stallLimit: number;
  readonly maxNudgesPerUnit: number;
}

export function checkSettings(config: ContractConfig): CheckSettings {
  const { acceptanceStakes, evidenceNudgeLimit, stallLimit, maxNudgesPerUnit } = config;
  return { acceptanceStakes, evidenceNudgeLimit, stallLimit, maxNudgesPerUnit };
}

// ── Readings to verdicts (4.5) ────────────────────────────────────────────────

/**
 * A criterion or goal verdict from its judge reading, where yes means it
 * fails. Leaning yes (the reading's likelier side is "fails") is unmet at any
 * outcome, including a reading too weak to settle in the band: failing closed
 * costs one nudge. Met needs a no at act; a weaker no, or a reading leaning no
 * that did not settle, is unshown.
 */
export function criterionVerdict(reading: YesNoReading): CriterionVerdict {
  if (reading.verdict === 'yes' || (reading.verdict === 'uncertain' && leansYes(reading.probability))) return 'unmet';
  return reading.verdict === 'no' && reading.outcome === 'act' ? 'met' : 'unshown';
}

export type QualityVerdict = 'problem' | 'clean' | 'unshown';

/** A quality item's verdict: a problem when it leans yes at any outcome, clean at a no at act, unshown otherwise. */
export function qualityVerdict(reading: YesNoReading): QualityVerdict {
  const verdict = criterionVerdict(reading);
  return verdict === 'unmet' ? 'problem' : verdict === 'met' ? 'clean' : 'unshown';
}

/** Whether a unit has to change files: implementation and integration units do, unless the request forbids writing. */
export function unitMustWrite(contract: Pick<ContractView, 'shape'>, unit: Pick<ContractUnit, 'role'>): boolean {
  const forbidsWriting = contract.shape?.forbids_writing;
  const writingForbidden = forbidsWriting?.verdict === 'yes' && forbidsWriting.outcome === 'act';
  return (unit.role === 'implement' || unit.role === 'integration') && !writingForbidden;
}

// ── Usage ─────────────────────────────────────────────────────────────────────

export function emptyJudgmentUsage(): JudgmentUsage {
  return { calls: 0, inputTokens: 0, outputTokens: 0 };
}

/** The port, counting every call's tokens into `usage` for the contract's judgment roll-up. */
export function meteredPort(port: JudgmentPort, usage: JudgmentUsage): JudgmentPort {
  return {
    model: port.model,
    ...(port.recorder === undefined ? {} : { recorder: port.recorder }),
    async ask(request) {
      const result = await port.ask(request);
      usage.calls += 1;
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      return result;
    },
  };
}

// ── One check ─────────────────────────────────────────────────────────────────

export interface UnitCheckInput {
  readonly contract: Pick<ContractView, 'shape'>;
  /** The unit as it stands before this check: its criteria's readings and its checks and nudges are the history. */
  readonly unit: ContractUnit;
  readonly trigger: CheckTrigger;
  readonly evidence: UnitEvidence;
  readonly settings: CheckSettings;
  readonly now: number;
  /** The runner's controller for the unit, aborted on cancel. */
  readonly signal?: AbortSignal | undefined;
}

/** The nudge a check calls for: its text, kinds and the criteria it names. */
export interface CheckNudge {
  readonly text: string;
  readonly kinds: readonly NudgeKind[];
  readonly criterionIds: readonly string[];
}

export interface DecidedCheck {
  readonly discarded: false;
  /** The check record, ready to append to the unit. */
  readonly check: UnitCheck;
  /** This check's reading of each judged criterion, by id. */
  readonly readings: ReadonlyMap<string, CriterionReading>;
  readonly verdicts: ReadonlyMap<string, CriterionVerdict>;
  readonly goalVerdict: CriterionVerdict;
  readonly regressions: readonly Regression[];
  /** Criteria read unmet (including regressed ones): the ones a severity reading is asked about. */
  readonly unmetCriterionIds: readonly string[];
  /** Present when the result is `nudge`, and when it is `stall` (the nudge that stalled). */
  readonly nudge?: CheckNudge | undefined;
  readonly stall?: StallReason | undefined;
  /** Every path the evidence showed changed, for the unit's touched paths. */
  readonly changedPaths: readonly string[];
  readonly usage: JudgmentUsage;
  /** Records what the runner did with this check's readings in the decision log. */
  recordAction(action: string): void;
}

/** A check whose unit was cancelled while it ran: its readings are dropped. */
export interface DiscardedCheck {
  readonly discarded: true;
  readonly usage: JudgmentUsage;
}

export type UnitCheckOutcome = DecidedCheck | DiscardedCheck;

/** The findings behind a check, before the result is chosen. */
interface Findings {
  readonly verdicts: ReadonlyMap<string, CriterionVerdict>;
  readonly goalVerdict: CriterionVerdict;
  readonly qualityVerdicts: Readonly<Record<QualityItem, QualityVerdict>>;
  readonly qualityProblems: readonly QualityItem[];
  readonly qualityUnshown: readonly QualityItem[];
  readonly regressions: readonly Regression[];
  readonly claimsFailed: boolean;
  readonly kinds: readonly NudgeKind[];
}

/** Kinds a finished check nudges on whatever else it finds (4.6 rows 3 to 5). */
const HARD_KINDS: ReadonlySet<NudgeKind> = new Set(['gate', 'claims', 'unmet', 'quality', 'regression']);

/** The problem kinds present, in the order NUDGE_KINDS lists them. */
function problemKinds(present: Readonly<Record<NudgeKind, boolean>>): NudgeKind[] {
  return (['unmet', 'unshown', 'regression', 'quality', 'gate', 'claims'] as const).filter((kind) => present[kind]);
}

function claimsFailed(input: UnitCheckInput): boolean {
  const claims = input.evidence.claims;
  if (claims === undefined) return false;
  if (claims.kind === 'unverified') return true;
  return claims.kind === 'unverifiable_no_claims' && input.evidence.changedPaths.length === 0 && unitMustWrite(input.contract, input.unit);
}

/** The result and the kinds it nudges on (4.6), before the stall rule. */
function chooseResult(
  input: UnitCheckInput,
  findings: Findings,
  qualityReadings: Readonly<Record<QualityItem, YesNoReading>>,
): { readonly result: CheckResult; readonly nudgeKinds: readonly NudgeKind[]; readonly nudgeQuality: readonly QualityItem[] } {
  if (input.trigger === 'turn-end') {
    const midRun = findings.qualityProblems.filter((item) => MID_RUN_QUALITY_ITEMS.has(item) && qualityReadings[item].outcome === 'act');
    const nudgeKinds = problemKinds({
      unmet: false, unshown: false, gate: false, claims: false,
      regression: findings.regressions.length > 0,
      quality: midRun.length > 0,
    });
    return { result: nudgeKinds.length > 0 ? 'nudge' : 'recorded', nudgeKinds, nudgeQuality: midRun };
  }
  if (findings.kinds.some((kind) => HARD_KINDS.has(kind))) {
    return { result: 'nudge', nudgeKinds: findings.kinds, nudgeQuality: findings.qualityProblems };
  }
  if (findings.kinds.includes('unshown')) {
    const underLimit = consecutiveUnsettledChecks(input.unit) < input.settings.evidenceNudgeLimit;
    return underLimit ? { result: 'nudge', nudgeKinds: ['unshown'], nudgeQuality: [] } : { result: 'await-owner', nudgeKinds: [], nudgeQuality: [] };
  }
  return { result: 'pass', nudgeKinds: [], nudgeQuality: [] };
}

/** The criteria a nudge names, for the given kinds. */
function nudgedCriteria(findings: Findings, kinds: readonly NudgeKind[]): string[] {
  const regressed = new Set(findings.regressions.map((regression) => regression.criterionId));
  return [...findings.verdicts].flatMap(([id, verdict]) => {
    if (verdict === 'unmet' && regressed.has(id)) return kinds.includes('regression') ? [id] : [];
    if (verdict === 'unmet') return kinds.includes('unmet') ? [id] : [];
    if (verdict === 'unshown') return kinds.includes('unshown') ? [id] : [];
    return [];
  });
}

/**
 * Runs one check: asks Jev, maps readings to verdicts, and decides the result
 * with the regression and stall rules. The unit is not changed; the runner
 * applies the outcome with {@link applyUnitCheck}. A missing judgment port
 * throws JudgmentPortMissingError, which fails the contract as
 * `judgment-unavailable`; there is no other path.
 */
export async function runUnitCheck(input: UnitCheckInput): Promise<UnitCheckOutcome> {
  const { unit, evidence, settings } = input;
  const usage = emptyJudgmentUsage();
  const judged = unit.criteria.filter((criterion) => criterion.disposition === 'judged');
  const signal = input.signal === undefined ? {} : { signal: input.signal };
  const [judgment, quality] = await Promise.all([
    UNIT_JUDGES[settings.acceptanceStakes].judge(
      meteredPort(judgmentPort(CHECK_SITES.judge), usage),
      { goal: unit.goal, criteria: judged.map((criterion) => criterion.text), output: evidence.output, evidence: judgeEvidence(evidence) },
      { ...signal, site: CHECK_SITES.judge },
    ),
    unitQuality.run(meteredPort(judgmentPort(CHECK_SITES.quality), usage), qualityState(unit, evidence), { ...signal, site: CHECK_SITES.quality }),
  ]);
  if (input.signal?.aborted === true || unit.status === 'cancelled') {
    judgment.recordAction('discarded: unit cancelled');
    quality.recordAction('discarded: unit cancelled');
    return { discarded: true, usage };
  }

  const checkId = `${unit.id}.k${unit.checks.length + 1}`;
  const verdicts = new Map(judged.map((criterion, index) => [criterion.id, criterionVerdict(judgment.criteria[index]!)]));
  const goalVerdict = criterionVerdict(judgment.goal);
  const qualityReadings = quality.readings as Readonly<Record<QualityItem, YesNoReading>>;
  const qualityVerdicts = Object.fromEntries(QUALITY_ITEMS.map((item) => [item, qualityVerdict(qualityReadings[item])])) as Record<QualityItem, QualityVerdict>;
  const qualityProblems = QUALITY_ITEMS.filter((item) => qualityVerdicts[item] === 'problem');
  const qualityUnshown = QUALITY_ITEMS.filter((item) => qualityVerdicts[item] === 'unshown');
  const regressions = findRegressions(unit, verdicts);
  const regressed = new Set(regressions.map((regression) => regression.criterionId));
  const failing = failedGates(evidence.gates);
  const claimsDidFail = claimsFailed(input);
  const kinds = problemKinds({
    unmet: goalVerdict === 'unmet' || [...verdicts].some(([id, verdict]) => verdict === 'unmet' && !regressed.has(id)),
    unshown: goalVerdict === 'unshown' || qualityUnshown.length > 0 || [...verdicts.values()].includes('unshown'),
    regression: regressions.length > 0,
    quality: qualityProblems.length > 0,
    gate: failing.length > 0,
    claims: claimsDidFail,
  });
  const findings: Findings = { verdicts, goalVerdict, qualityVerdicts, qualityProblems, qualityUnshown, regressions, claimsFailed: claimsDidFail, kinds };

  const chosen = chooseResult(input, findings, qualityReadings);
  const decisionIds = [judgment.decisionId, quality.result.decisionId].filter((id): id is string => id !== undefined);
  const baseCheck: UnitCheck = {
    id: checkId,
    at: input.now,
    trigger: input.trigger,
    ...(evidence.claims === undefined ? {} : { claims: { kind: evidence.claims.kind, summary: evidence.claims.summary } }),
    ...(evidence.gates === undefined ? {} : { gates: evidence.gates }),
    goal: { probabilityUnmet: judgment.goal.probability, verdict: goalVerdict, outcome: judgment.goal.outcome },
    quality: Object.fromEntries(QUALITY_ITEMS.map((item) => [item, { verdict: qualityReadings[item].verdict as YesNoVerdict, outcome: qualityReadings[item].outcome }])) as UnitCheck['quality'],
    result: chosen.result,
    problems: kinds,
    qualityProblems,
    decisionIds,
    evidenceDigest: hashState(judgeState(unit, evidence)),
  };

  let result = chosen.result;
  let stall: StallReason | undefined;
  if (result === 'nudge') {
    stall = detectStall(unit, standingOf({ criteria: withReadings(unit, checkId, verdicts) }, baseCheck), regressions, settings) ?? undefined;
    if (stall !== undefined) result = 'stall';
  }
  const check: UnitCheck = { ...baseCheck, result };

  let nudge: CheckNudge | undefined;
  if (chosen.nudgeKinds.length > 0) {
    const nudgeFindings: NudgeFindings = {
      checkNumber: checkNumberOf(checkId),
      kinds: chosen.nudgeKinds,
      verdicts,
      regressions,
      goalVerdict,
      qualityProblems: chosen.nudgeQuality,
      qualityUnshown,
      failedGates: failing,
      ...(evidence.claims === undefined ? {} : { claims: { missingPaths: evidence.claims.missingPaths, noChanges: evidence.claims.missingPaths.length === 0 && claimsDidFail } }),
    };
    nudge = { text: buildNudge(unit, nudgeFindings), kinds: chosen.nudgeKinds, criterionIds: nudgedCriteria(findings, chosen.nudgeKinds) };
  }

  const readings = new Map(judged.map((criterion, index): [string, CriterionReading] => {
    const reading = judgment.criteria[index]!;
    return [criterion.id, { checkId, at: input.now, probabilityUnmet: reading.probability, verdict: verdicts.get(criterion.id)!, outcome: reading.outcome, decisionId: judgment.decisionId }];
  }));
  const action = `check ${checkId}: ${result}`;
  judgment.recordAction(action);
  quality.recordAction(action);
  return {
    discarded: false,
    check,
    readings,
    verdicts,
    goalVerdict,
    regressions,
    unmetCriterionIds: [...verdicts].filter(([, verdict]) => verdict === 'unmet').map(([id]) => id),
    ...(nudge === undefined ? {} : { nudge }),
    ...(stall === undefined ? {} : { stall }),
    changedPaths: evidence.changedPaths,
    usage,
    recordAction: (runnerAction) => {
      judgment.recordAction(runnerAction);
      quality.recordAction(runnerAction);
    },
  };
}

/** The unit's criteria with this check's verdicts appended as readings, for the standing of a check not yet applied. */
function withReadings(unit: ContractUnit, checkId: string, verdicts: ReadonlyMap<string, CriterionVerdict>): ContractUnit['criteria'] {
  return unit.criteria.map((criterion) => {
    const verdict = verdicts.get(criterion.id);
    if (verdict === undefined) return criterion;
    return { ...criterion, readings: [...criterion.readings, { checkId, at: 0, probabilityUnmet: 0, verdict, outcome: 'act', decisionId: undefined }] };
  });
}

/**
 * Applies a decided check to the unit: appends each criterion's reading and
 * sets its status to this verdict, appends the check, and adds the changed
 * paths to the unit's touched paths.
 */
export function applyUnitCheck(unit: ContractUnit, outcome: DecidedCheck): void {
  for (const criterion of unit.criteria) {
    const reading = outcome.readings.get(criterion.id);
    if (reading === undefined) continue;
    criterion.readings.push(reading);
    criterion.status = reading.verdict;
  }
  unit.checks.push(outcome.check);
  const touched = new Set(unit.touchedPaths);
  for (const path of outcome.changedPaths) touched.add(path);
  unit.touchedPaths = [...touched];
}

// ── Severity of unmet criteria ────────────────────────────────────────────────

export interface SeverityReading {
  /** Only a reading at act is used; below act the severity stays unknown. */
  readonly severity: CriterionSeverity | undefined;
  readonly decisionId: string | undefined;
}

/**
 * Reads the severity of each unmet criterion, one request per criterion, all
 * concurrently. Run after the nudge is sent. The state is the person's words,
 * the unit's goal and the criterion.
 */
export async function readUnmetSeverities(input: {
  readonly contract: Pick<ContractView, 'ask'>;
  readonly unit: Pick<ContractUnit, 'goal' | 'criteria'>;
  readonly criterionIds: readonly string[];
  readonly signal?: AbortSignal | undefined;
}): Promise<{ readonly severities: ReadonlyMap<string, SeverityReading>; readonly usage: JudgmentUsage }> {
  const usage = emptyJudgmentUsage();
  const port = meteredPort(judgmentPort(CHECK_SITES.severity), usage);
  const criteria = input.unit.criteria.filter((criterion) => input.criterionIds.includes(criterion.id));
  const entries = await Promise.all(criteria.map(async (criterion): Promise<[string, SeverityReading]> => {
    const run = await unmetSeverity.run(
      port,
      { request: input.contract.ask, goal: input.unit.goal, criterion: criterion.text },
      { site: CHECK_SITES.severity, ...(input.signal === undefined ? {} : { signal: input.signal }) },
    );
    const reading = run.readings.severity;
    const severity = reading.outcome === 'act' ? reading.choice : undefined;
    run.recordAction(severity === undefined ? 'severity not settled; left unknown' : `severity ${severity} recorded on ${criterion.id}`);
    return [criterion.id, { severity, decisionId: run.result.decisionId }];
  }));
  return { severities: new Map(entries), usage };
}

/** Records severities on the readings of check `checkId`. */
export function applySeverities(unit: ContractUnit, checkId: string, severities: ReadonlyMap<string, SeverityReading>): void {
  for (const criterion of unit.criteria) {
    const severity = severities.get(criterion.id)?.severity;
    if (severity === undefined) continue;
    const index = criterion.readings.findIndex((reading) => reading.checkId === checkId);
    if (index !== -1) criterion.readings[index] = { ...criterion.readings[index]!, severity };
  }
}
