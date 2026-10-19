import { nativeContractSourceData } from './native-source.js';
import { agentBriefFidelity } from '../agents/brief-fidelity.js';
import { hasDerivedAcceptanceChecks } from './owned-source.js';
/**
 * The Jev checks on a plan (docs/design/contract-runner.md section 3.4), run
 * after the code checks pass, all concurrently: each criterion traces to the
 * user's words, no stated requirement is missing, each criterion is checkable
 * and not only about agent layout, each unit's role, and no unit narrows the
 * scope it serves. The readings are folded here, in code, into plan problems
 * and criterion dispositions.
 */
import { nativeContractPort, type NativeContractServices } from './native-decisions.js';
import type { Contract } from './types.js';
import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { assertJudgmentInput } from '../gate/judgment-input.js';
import { prepareJudgmentResult, retainStrictJudgmentJson } from '../gate/judgment-result.js';
import { type JudgmentPort, type YesNoReading } from '@goodvibes-jev/judgment';
import type { PlanCheck } from '../../events/contract.js';
import { criterionShape } from './batteries/criterion-shape.js';
import { criterionTrace, traceClaim } from './batteries/criterion-trace.js';
import { planCoverage, type CoveragePart } from './batteries/plan-coverage.js';
import { delegationForbidden, saysYesAtAct } from './batteries/request-shape.js';
import { unitShape, unitShapeInput, VERIFICATION_ROLES, type RequirementReading, type UnitShapeInput, type UnitShapeRole } from './batteries/unit-shape.js';
import { findParallelGroup, planUnits, type ContractPlan, type PlannedStatedCriterion, type PlannedUnit, type PlanProblem } from './plan-schema.js';
import type { CriterionDisposition, NativeContractSource, RequestShape } from './types.js';

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
  readonly originalSource?: import('../permissions/autonomous.js').AutonomousToolSource | undefined;
  readonly native?: { readonly contract: Contract; readonly services: NativeContractServices | undefined } | undefined;
  /** Native trace and coverage are exact structural checks, never model-generated requirements. */
  readonly nativeSource?: NativeContractSource | undefined;
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
    result: await criterionTrace.check(port, hasDerivedAcceptanceChecks(options.originalSource)
      ? `This derived acceptance check faithfully operationalizes the original goal without adding or narrowing requirements: ${criterion.text}`
      : traceClaim(criterion.text), ask, criterion.quote, callOptions(site, options)),
  })));
  for (const { criterion, result } of results) {
    record(output, result.decisionId, result.usage);
    const traced = result.fidelity === 'supported';
    result.recordAction(traced ? 'traced' : 'repair: untraced');
    if (!traced) output.problems.push({ code: 'untraced', targetId: criterion.id, message: traceProblemMessage(criterion, result.fidelity) });
  }
  return output;
}

// ── No stated requirement missing ─────────────────────────────────────────────

/** How a criterion is named in a problem message. */
const named = (criteria: readonly { readonly id: string; readonly text: string }[]): string =>
  criteria.map((criterion) => `${criterion.id} ("${criterion.text}")`).join(', ');

/** The planner's repair for one part of the request that did not clear. */
function coverageProblem(part: CoveragePart): PlanProblem {
  const sure = part.reading.verdict === 'yes';
  if (part.kind === 'unquoted') {
    return {
      code: 'uncovered-requirement',
      message: sure
        ? `The user's words "${part.words}" state a requirement, limit or preference that no contract criterion quotes; add a criterion for it, quoting those words.`
        : `It is not clear whether the user's words "${part.words}" state a requirement, limit or preference; if they do, add a criterion for it, quoting those words.`,
    };
  }
  const plural = part.criteria.length > 1;
  return {
    code: 'uncovered-requirement',
    targetId: part.criteria[0]!.id,
    message: sure
      ? `Contract ${plural ? 'criteria' : 'criterion'} ${named(part.criteria)} require${plural ? '' : 's'} less than the user's words "${part.words}" ask for; restate ${plural ? 'them' : 'it'} to require all of it, in the user's words.`
      : `It is not clear that contract ${plural ? 'criteria' : 'criterion'} ${named(part.criteria)} require${plural ? '' : 's'} all that the user's words "${part.words}" ask for; restate ${plural ? 'them' : 'it'} in the user's words.`,
  };
}

/** Rank the two answers; uncertainty alone is not a missing requirement. */
async function checkCoverage(port: JudgmentPort, plan: ContractPlan, ask: string, options: PlanCheckOptions): Promise<CheckOutput> {
  const output = emptyOutput();
  const run = await planCoverage.read(port, { request: ask, criteria: plan.criteria }, callOptions(PLAN_CHECK_SITES['plan-coverage'], options));
  record(output, run.decisionId, run.usage);
  const open = run.parts.filter((part) => part.reading.probability > 0.5);
  output.problems.push(...open.map(coverageProblem));
  run.recordAction(open.length > 0 ? `repair: uncovered requirement (${open.length} of ${run.parts.length} parts)` : `covered`);
  return output;
}

// ── Criterion is checkable and not topology-only ──────────────────────────────

/** The reason a solo criterion is met in session mode. */
export const SESSION_MODE_REASON = "met by the plan's structure: session mode, where the session does the work itself and no sub-agent is spawned";

/**
 * The disposition a topology-only criterion gets: met by structure when the
 * plan's arrangement is the one it asks for, else excluded. A criterion asking
 * for one agent to work alone (`solo` yes at act) is met when the contract
 * runs in session mode, under the runner's own rule (`delegationForbidden`,
 * section 6.6); any other is met by the plan's parallel group when the plan
 * honours a parallel request.
 */
function topologyRuling(plan: ContractPlan, shape: RequestShape, solo: YesNoReading): CriterionDispositionRuling {
  if (solo.verdict === 'yes' && solo.outcome === 'act' && delegationForbidden(shape)) return { disposition: 'met-by-structure', reason: SESSION_MODE_REASON };
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
    run: await criterionShape.run(port, { request: ask, criterion: criterion.text, ...(options.nativeSource === undefined ? options.originalSource ? { originalSource: { goal: options.originalSource.goal, criteria: [...options.originalSource.criteria] } } : {} : { nativeSource: nativeContractSourceData(options.nativeSource) }) }, callOptions(site, options)),
  })));
  for (const { criterion, run } of runs) {
    record(output, run.result.decisionId, run.result.usage);
    const { checkable, topology_only: topologyOnly, solo } = run.readings;
    // A topology-only criterion is met or missed by the plan's shape, so it is
    // never judged; that it cannot be checked from the work is expected.
    if (options.nativeSource === undefined && options.originalSource === undefined && topologyOnly.verdict === 'yes' && topologyOnly.outcome === 'act') {
      const ruling = topologyRuling(plan, shape, solo);
      output.dispositions.set(criterion.id, ruling);
      run.recordAction(ruling.disposition);
      continue;
    }
    const notCheckable = checkable.probability < 0.5;
    run.recordAction(notCheckable ? 'repair: not checkable' : 'judged');
    if (notCheckable) {
      output.problems.push({
        code: 'not-checkable',
        targetId: criterion.id,
        message: `Criterion ${criterion.id} ("${criterion.text}") has not been established as checkable from the finished work; restate it as something its files, output or a command can show.`,
      });
    }
  }
  return output;
}

// ── Unit role and scope ───────────────────────────────────────────────────────

/** Whether Jev's role reading agrees with the planner's role field. Integration units read as implement. */
function roleAgrees(planned: string, read: UnitShapeRole): boolean {
  if (read === 'implement') return planned === 'implement' || planned === 'integration';
  // Reviewing, testing and verifying existing work are valid read-only
  // deliverables. They use the research execution role, not a veto on review.
  if (VERIFICATION_ROLES.includes(read)) return planned === 'research';
  return planned === read;
}

/** What `contract.unit-shape` reads for one unit: the unit, the other units with their criteria, and the contract criteria it serves. */
export function unitShapeState(plan: ContractPlan, unit: PlannedUnit): UnitShapeInput {
  return unitShapeInput(plan.goal, plan.criteria, planUnits(plan), unit);
}

/** The planner's repair for a unit with requirements whose narrows reading leans yes. */
function narrowsProblem(unit: PlannedUnit, leaning: readonly RequirementReading[]): PlanProblem {
  const sure = leaning.some((entry) => entry.reading.verdict === 'yes');
  const plural = leaning.length > 1;
  const which = `contract ${plural ? 'criteria' : 'criterion'} ${named(leaning)}`;
  return {
    code: 'narrows',
    targetId: unit.id,
    message: sure
      ? `Unit ${unit.id} ("${unit.title}") does less than ${which} require${plural ? '' : 's'} (fewer items, a smaller area or a weaker standard), and no other unit does the rest; widen it to all that ${plural ? 'they require' : 'it requires'}, or add the missing work.`
      : `It is not clear that unit ${unit.id} ("${unit.title}") or another unit does all that ${which} require${plural ? '' : 's'}; state that full scope in the unit's brief and criteria.`,
  };
}

async function checkUnits(port: JudgmentPort, plan: ContractPlan, options: PlanCheckOptions): Promise<CheckOutput> {
  const output = emptyOutput();
  const site = PLAN_CHECK_SITES['unit-shape'];
  const runs = await Promise.all(planUnits(plan).map(async (unit) => ({
    unit,
    run: await unitShape.read(port, { ...unitShapeState(plan, unit), ...(options.nativeSource === undefined ? options.originalSource ? { originalSource: { goal: options.originalSource.goal, criteria: [...options.originalSource.criteria] } } : {} : { nativeSource: nativeContractSourceData(options.nativeSource) }) }, callOptions(site, options)),
  })));
  for (const { unit, run } of runs) {
    record(output, run.decisionId, run.usage);
    const { role, narrows } = run;
    const found: PlanProblem[] = [];
    if (role.outcome === 'act' && !roleAgrees(unit.role, role.choice)) {
      found.push({
        code: 'role-mismatch',
        targetId: unit.id,
        message: `Unit ${unit.id} ("${unit.title}") has role "${unit.role}", but the reading did not establish agreement with its brief; clarify the role and brief.`,
      });
    }
    const unresolved = narrows.filter((entry) => entry.reading.probability > 0.5);
    if (unresolved.length > 0) found.push(narrowsProblem(unit, unresolved));
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
function planCheckOwner(options: PlanCheckOptions, evidence: object) {
  const taskEvidence = options.native?.contract.taskEvidence;
  const original = retainStrictJudgmentJson({ ...evidence, originalSource: options.originalSource, taskEvidence });
  assertJudgmentInput(original.snapshot);
  const native = options.native, signal = options.signal, nativeSource = options.nativeSource, originalSource = options.originalSource;
  const owner = captureJudgmentPort('contract.plan-checks', { signal, prepareResultCapture: prepareJudgmentResult,
    assertCurrent() {
      original.assertCurrent();
      if (options.native?.contract.taskEvidence !== taskEvidence) throw new Error('Plan continuation evidence changed');
      if (options.native !== native || options.signal !== signal || options.nativeSource !== nativeSource || options.originalSource !== originalSource) throw new Error('Plan check ownership changed');
    } });
  return { assertCurrent: owner.assertCurrent,
    port: native === undefined ? owner.port : nativeContractPort(native.contract, native.services, owner.port, owner.signal) };
}

/** Check the actual generated plan, including when the planner broadens a
 * focused assignment. The original requirements remain fully binding. */
async function checkRepairContinuation(port: JudgmentPort, plan: ContractPlan, ask: string, options: PlanCheckOptions): Promise<CheckOutput> {
  const output = emptyOutput(), repairContext = options.native?.contract.taskEvidence;
  if (!repairContext?.includes('"kind":"completion-repair"')) return output;
  const run = await agentBriefFidelity.run(port, { request: ask, repairContext,
    assignments: planUnits(plan).map(unit => ({ task: [unit.title, unit.goal, unit.brief].join('\n') })) } as never,
    { ...callOptions(agentBriefFidelity.name, options), only: ['repair_restart'] });
  record(output, run.result.decisionId, run.result.usage);
  const accepted = run.readings.repair_restart.verdict === 'no' && run.readings.repair_restart.outcome === 'act';
  run.recordAction(accepted ? 'Continue only the remaining work while retaining completed results.' : 'Repair this plan before execution: account for reusable results and assign only the specific remaining work.');
  if (!accepted) output.problems.push({ code: 'uncovered-requirement', message: 'Completion repair is not a fresh task. Identify and preserve completed inspections, findings and artifacts; establish the specific remaining work from primary receipts and assign only that work. Do not replace the existing report or require a new full review without evidence that the affected work must be reopened.' });
  return output;
}

/**
 * Runs every Jev plan check concurrently and folds the readings into problems
 * and dispositions. Call it only on a plan whose code checks passed.
 */
export async function runPlanChecks(plan: ContractPlan, ask: string, shape: RequestShape, options: PlanCheckOptions = {}): Promise<PlanVerdict> {
  const owner = planCheckOwner(options, { plan, ask, shape });
  const port = owner.port;
  const derived = hasDerivedAcceptanceChecks(options.originalSource);
  const checkRootMeaning = options.nativeSource === undefined && (options.originalSource === undefined || derived);
  const [trace, coverage, shapes, units, continuation] = await Promise.all([
    checkRootMeaning ? checkTrace(port, plan, ask, options) : emptyOutput(),
    checkRootMeaning ? checkCoverage(port, plan, ask, options) : emptyOutput(),
    readCriterionShapes(port, plan, ask, shape, options),
    checkUnits(port, plan, options),
    checkRepairContinuation(port, plan, ask, options),
  ]);
  owner.assertCurrent();
  units.problems.push(...continuation.problems); units.decisionIds.push(...continuation.decisionIds); units.usages.push(...continuation.usages);
  if (derived && !plan.criteria.some(criterion => !shapes.dispositions.has(criterion.id))) {
    shapes.problems.push({ code: 'no-criteria', message: 'A goal-only source requires nonempty judged planner-derived acceptance checks; structural or absent checks cannot complete its goal.' });
  }
  const outputs = [trace, coverage, shapes, units];
  const reports = [
    ...(checkRootMeaning ? [report('criterion-trace', trace), report('plan-coverage', coverage)] : []),
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
 * Only the unit checks (role and scope), for a planned-fix group:
 * its criteria trace to criteria that already trace to the user, so
 * trace and coverage are not asked again.
 */
export async function runUnitShapeChecks(
  plan: ContractPlan,
  options: PlanCheckOptions = {},
): Promise<{ readonly problems: readonly PlanProblem[]; readonly decisionIds: readonly string[]; readonly usage: PlanCheckUsage }> {
  const owner = planCheckOwner(options, { plan });
  const units = await checkUnits(owner.port, plan, options);
  owner.assertCurrent();
  return { problems: units.problems, decisionIds: units.decisionIds, usage: totalUsage([units]) };
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
  const owner = planCheckOwner(options, { plan, ask, shape });
  const shapes = await readCriterionShapes(owner.port, plan, ask, shape, options);
  owner.assertCurrent();
  return { dispositions: shapes.dispositions, decisionIds: shapes.decisionIds, usage: totalUsage([shapes]) };
}
