/**
 * The Jev checks on a plan (docs/design/contract-runner.md section 3.4), run
 * after the code checks pass, all concurrently: each criterion traces to the
 * user's words, no stated requirement is missing, each criterion is checkable
 * and not only about agent layout, each unit's role, and no unit narrows the
 * scope it serves. The readings are folded here, in code, into plan problems
 * and criterion dispositions.
 */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import type { EntryType, JudgmentPort, YesNoReading } from '@goodvibes-jev/judgment';
import type { PlanCheck } from '../../events/contract.js';
import { criterionShape } from './batteries/criterion-shape.js';
import { criterionTrace, traceClaim } from './batteries/criterion-trace.js';
import { planCoverage } from './batteries/plan-coverage.js';
import { saysYesAtAct } from './batteries/request-shape.js';
import { unitShape, VERIFICATION_ROLES, type UnitShapeRole } from './batteries/unit-shape.js';
import { findParallelGroup, planUnits, type ContractPlan, type PlannedStatedCriterion, type PlannedUnit, type PlanProblem } from './plan-schema.js';
import type { CriterionDisposition, RequestShape } from './types.js';

/** Decision-log sites, one per check. */
export const PLAN_CHECK_SITES = {
  'criterion-trace': 'contract.plan-checks.criterion-trace',
  'plan-coverage': 'contract.plan-checks.plan-coverage',
  'criterion-shape': 'contract.plan-checks.criterion-shape',
  'unit-shape': 'contract.plan-checks.unit-shape',
} as const satisfies Partial<Record<PlanCheck, string>>;

export type JevPlanCheck = keyof typeof PLAN_CHECK_SITES;

/** The disposition reason for a topology-only criterion the plan cannot satisfy (section 3.4). */
export const EXCLUDED_TOPOLOGY_REASON = 'requires an agent arrangement this plan does not use';

/** A criterion code does not judge, and why. */
export interface CriterionDispositionRuling {
  readonly disposition: Exclude<CriterionDisposition, 'judged'>;
  readonly reason: string;
}

/** One Jev check's result, as CONTRACT_PLAN_CHECKED reports it. */
export interface PlanCheckReport {
  readonly check: JevPlanCheck;
  readonly passed: boolean;
  readonly problems: readonly PlanProblem[];
  readonly decisionIds: readonly string[];
}

export interface PlanCheckUsage {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Every Jev check folded into one verdict on the plan. */
export interface PlanVerdict {
  readonly problems: readonly PlanProblem[];
  /** Criteria that are not judged, by id; every other criterion is judged. */
  readonly dispositions: ReadonlyMap<string, CriterionDispositionRuling>;
  readonly reports: readonly PlanCheckReport[];
  readonly decisionIds: readonly string[];
  readonly usage: PlanCheckUsage;
}

export interface PlanCheckOptions {
  readonly signal?: AbortSignal | undefined;
}

type Usage = { readonly inputTokens: number; readonly outputTokens: number };

/** What one check's reads produced before folding. */
interface CheckOutput {
  readonly problems: PlanProblem[];
  readonly decisionIds: string[];
  readonly usages: Usage[];
}

function emptyOutput(): CheckOutput {
  return { problems: [], decisionIds: [], usages: [] };
}

function record(output: CheckOutput, decisionId: string | undefined, usage: Usage | undefined): void {
  if (decisionId !== undefined) output.decisionIds.push(decisionId);
  if (usage !== undefined) output.usages.push(usage);
}

function callOptions(site: string, options: PlanCheckOptions): { readonly site: string; readonly signal?: AbortSignal } {
  return { site, ...(options.signal === undefined ? {} : { signal: options.signal }) };
}

/** A yes/no reading that clears only on a no at act. */
function clearsOnlyOnNoAtAct(reading: YesNoReading): boolean {
  return !(reading.verdict === 'no' && reading.outcome === 'act');
}

// ── Criteria trace to the user's words ────────────────────────────────────────

function traceProblemMessage(criterion: PlannedStatedCriterion, fidelity: string): string {
  switch (fidelity) {
    case 'fabricated':
      return `The quote for ${criterion.id} is not in the user's request; quote their exact words.`;
    case 'contradicted':
      return `Criterion ${criterion.id} ("${criterion.text}") goes against what the user's request says; restate it as the user asked.`;
    case 'unsupported':
      return `Criterion ${criterion.id} ("${criterion.text}") is not something the user's request asks for; remove it, or tie it to what the user said.`;
    default:
      return `It is not clear that the user's request asks for criterion ${criterion.id} ("${criterion.text}"); restate it closer to the user's words.`;
  }
}

async function checkTrace(port: JudgmentPort, plan: ContractPlan, ask: string, options: PlanCheckOptions): Promise<CheckOutput> {
  const output = emptyOutput();
  const site = PLAN_CHECK_SITES['criterion-trace'];
  const results = await Promise.all(plan.criteria.map(async (criterion) => ({
    criterion,
    result: await criterionTrace.check(port, traceClaim(criterion.text), ask, criterion.quote, callOptions(site, options)),
  })));
  for (const { criterion, result } of results) {
    record(output, result.decisionId, result.usage);
    const traced = result.fidelity === 'supported' && result.outcome === 'act';
    result.recordAction(traced ? 'traced' : 'repair: untraced');
    if (!traced) output.problems.push({ code: 'untraced', targetId: criterion.id, message: traceProblemMessage(criterion, result.fidelity) });
  }
  return output;
}

// ── No stated requirement missing ─────────────────────────────────────────────

async function checkCoverage(port: JudgmentPort, plan: ContractPlan, ask: string, options: PlanCheckOptions): Promise<CheckOutput> {
  const output = emptyOutput();
  const run = await planCoverage.run(port, { request: ask, criteria: plan.criteria.map((criterion) => criterion.text) }, callOptions(PLAN_CHECK_SITES['plan-coverage'], options));
  record(output, run.result.decisionId, run.result.usage);
  const reading = run.readings.uncovered_requirement;
  const problem = clearsOnlyOnNoAtAct(reading);
  run.recordAction(problem ? 'repair: uncovered requirement' : 'covered');
  if (problem) {
    output.problems.push({
      code: 'uncovered-requirement',
      message: reading.verdict === 'yes'
        ? "The user's request states a requirement, limit or preference that no contract criterion covers; add a criterion for each one, quoting the user's words."
        : "It is not clear that the contract criteria cover everything the user's request states; make sure every requirement, limit and preference in the request has its own criterion.",
    });
  }
  return output;
}

// ── Criterion is checkable and not topology-only ──────────────────────────────

/** The disposition a topology-only criterion gets: met by the plan's parallel group when it honours a parallel request, else excluded. */
function topologyRuling(plan: ContractPlan, shape: RequestShape): CriterionDispositionRuling {
  const parallel = saysYesAtAct(shape.requests_parallel_agents) ? findParallelGroup(plan) : undefined;
  return parallel === undefined
    ? { disposition: 'excluded', reason: EXCLUDED_TOPOLOGY_REASON }
    : { disposition: 'met-by-structure', reason: `met by the plan's structure: group ${parallel.id} runs its units in parallel` };
}

async function readCriterionShapes(
  port: JudgmentPort,
  plan: ContractPlan,
  ask: string,
  shape: RequestShape,
  options: PlanCheckOptions,
): Promise<CheckOutput & { readonly dispositions: Map<string, CriterionDispositionRuling> }> {
  const output = { ...emptyOutput(), dispositions: new Map<string, CriterionDispositionRuling>() };
  const site = PLAN_CHECK_SITES['criterion-shape'];
  const runs = await Promise.all(plan.criteria.map(async (criterion) => ({
    criterion,
    run: await criterionShape.run(port, { request: ask, criterion: criterion.text }, callOptions(site, options)),
  })));
  for (const { criterion, run } of runs) {
    record(output, run.result.decisionId, run.result.usage);
    const { checkable, topology_only: topologyOnly } = run.readings;
    // A topology-only criterion is met or missed by the plan's shape, so it is
    // never judged; that it cannot be checked from the work is expected.
    if (topologyOnly.verdict === 'yes' && topologyOnly.outcome === 'act') {
      const ruling = topologyRuling(plan, shape);
      output.dispositions.set(criterion.id, ruling);
      run.recordAction(ruling.disposition);
      continue;
    }
    const notCheckable = checkable.verdict === 'no' && checkable.outcome !== 'escalate';
    run.recordAction(notCheckable ? 'repair: not checkable' : 'judged');
    if (notCheckable) {
      output.problems.push({
        code: 'not-checkable',
        targetId: criterion.id,
        message: `Criterion ${criterion.id} ("${criterion.text}") cannot be confirmed or refuted from the finished work; restate it as something its files, output or a command can show.`,
      });
    }
  }
  return output;
}

// ── Unit role and scope ───────────────────────────────────────────────────────

/** Whether Jev's role reading agrees with the planner's role field. Integration units read as implement. */
function roleAgrees(planned: string, read: UnitShapeRole): boolean {
  if (read === 'implement') return planned === 'implement' || planned === 'integration';
  return planned === read;
}

/** The state `contract.unit-shape` reads for one unit. */
export function unitShapeState(plan: ContractPlan, unit: PlannedUnit): EntryType {
  const served = new Set(unit.criteria.flatMap((criterion) => criterion.serves));
  return {
    goal: plan.goal,
    criteria: plan.criteria.filter((criterion) => served.has(criterion.id)).map((criterion) => criterion.text),
    unit: { title: unit.title, goal: unit.goal, brief: unit.brief, criteria: unit.criteria.map((criterion) => criterion.text) },
    otherUnits: planUnits(plan).filter((other) => other !== unit).map((other) => ({ title: other.title, goal: other.goal })),
  };
}

async function checkUnits(port: JudgmentPort, plan: ContractPlan, options: PlanCheckOptions): Promise<CheckOutput> {
  const output = emptyOutput();
  const site = PLAN_CHECK_SITES['unit-shape'];
  const runs = await Promise.all(planUnits(plan).map(async (unit) => ({
    unit,
    run: await unitShape.run(port, unitShapeState(plan, unit), callOptions(site, options)),
  })));
  for (const { unit, run } of runs) {
    record(output, run.result.decisionId, run.result.usage);
    const { role, narrows } = run.readings;
    const found: PlanProblem[] = [];
    if (role.outcome === 'act' && VERIFICATION_ROLES.includes(role.choice)) {
      found.push({
        code: 'verification-unit',
        targetId: unit.id,
        message: `Unit ${unit.id} ("${unit.title}") only ${role.choice === 'review' ? 'reviews' : role.choice === 'test' ? 'tests' : 'verifies'} other units' work. Every unit's work is checked as it goes, so remove it and put what it would check into the criteria of the unit it would check (for example "the tests for X pass").`,
      });
    } else if (role.outcome === 'act' && !roleAgrees(unit.role, role.choice)) {
      found.push({
        code: 'role-mismatch',
        targetId: unit.id,
        message: `Unit ${unit.id} ("${unit.title}") has role "${unit.role}", but its brief reads as ${role.choice} work; make the role and the brief agree.`,
      });
    }
    if (clearsOnlyOnNoAtAct(narrows)) {
      found.push({
        code: 'narrows',
        targetId: unit.id,
        message: narrows.verdict === 'yes'
          ? `Unit ${unit.id} ("${unit.title}") does less than the criteria it serves require (fewer items, a smaller area or a weaker standard), and no other unit makes up the difference; widen it or add the missing work.`
          : `It is not clear that unit ${unit.id} ("${unit.title}") does all that the criteria it serves require; state its full scope in its brief and criteria.`,
      });
    }
    run.recordAction(found.length === 0 ? 'unit accepted' : `repair: ${found.map((entry) => entry.code).join(', ')}`);
    output.problems.push(...found);
  }
  return output;
}

// ── Folding ───────────────────────────────────────────────────────────────────

function report(check: JevPlanCheck, output: CheckOutput): PlanCheckReport {
  return { check, passed: output.problems.length === 0, problems: output.problems, decisionIds: output.decisionIds };
}

function totalUsage(outputs: readonly CheckOutput[]): PlanCheckUsage {
  const usages = outputs.flatMap((output) => output.usages);
  return {
    calls: usages.length,
    inputTokens: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
    outputTokens: usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
  };
}

/** The port every plan check reads through. */
function planCheckPort(): JudgmentPort {
  return judgmentPort('contract.plan-checks');
}

/**
 * Runs every Jev plan check concurrently and folds the readings into problems
 * and dispositions. Call it only on a plan whose code checks passed.
 */
export async function runPlanChecks(plan: ContractPlan, ask: string, shape: RequestShape, options: PlanCheckOptions = {}): Promise<PlanVerdict> {
  const port = planCheckPort();
  const [trace, coverage, shapes, units] = await Promise.all([
    checkTrace(port, plan, ask, options),
    checkCoverage(port, plan, ask, options),
    readCriterionShapes(port, plan, ask, shape, options),
    checkUnits(port, plan, options),
  ]);
  const outputs = [trace, coverage, shapes, units];
  const reports = [
    report('criterion-trace', trace),
    report('plan-coverage', coverage),
    report('criterion-shape', shapes),
    report('unit-shape', units),
  ];
  return {
    problems: reports.flatMap((entry) => entry.problems),
    dispositions: shapes.dispositions,
    reports,
    decisionIds: outputs.flatMap((output) => output.decisionIds),
    usage: totalUsage(outputs),
  };
}

/**
 * Only the dispositions, for a plan the owner approved as it stands: the
 * owner settles the plan's problems, but which criteria are topology-only is
 * still read, since those are never judged.
 */
export async function readCriterionDispositions(
  plan: ContractPlan,
  ask: string,
  shape: RequestShape,
  options: PlanCheckOptions = {},
): Promise<{ readonly dispositions: ReadonlyMap<string, CriterionDispositionRuling>; readonly decisionIds: readonly string[]; readonly usage: PlanCheckUsage }> {
  const shapes = await readCriterionShapes(planCheckPort(), plan, ask, shape, options);
  return { dispositions: shapes.dispositions, decisionIds: shapes.decisionIds, usage: totalUsage([shapes]) };
}
