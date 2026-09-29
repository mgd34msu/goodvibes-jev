/**
 * Correction when nudging stalls (docs/design/contract-runner.md section 5):
 * stall routing, planned-fix groups and fresh agents, for units, groups and
 * the deliverable.
 *
 * Routing a stall (5.1), in code around one Jev reading:
 * - the fix rounds and fresh agents spent reach `contract.maxFixRounds`: the
 *   owner decides (`fix-rounds-exhausted`), without asking Jev;
 * - a merge conflict goes to a planned fix, without asking Jev;
 * - a session-mode contract (6.6) cannot delegate, so a planned fix or a fresh
 *   agent is not possible: the owner decides;
 * - otherwise `contract.stall-route` reads split, fresh or owner; a reading
 *   below act goes to the owner.
 *
 * A planned fix (5.2) is ordinary contract structure: the planning model plans
 * one `fix` group, code and Jev check it, and it runs through the same engine
 * with the same nudge loop. When it passes, the target is checked again
 * (`fix-passed`) against its own criteria. In worktree mode a unit's own work
 * merges into the contract branch before its fix group starts, so the fix
 * builds on it; its re-check then reads the contract branch, limited to the
 * files the unit and its fixes touched.
 */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import type { StallRoute } from '../../events/contract.js';
import type { WorkItem } from '../orchestration/types.js';
import { stallRoute } from './batteries/stall-route.js';
import { emptyJudgmentUsage, meteredPort, type DecidedCheck } from './check.js';
import { readContractConfig } from './config.js';
import { headAndTail } from './evidence.js';
import { failedGates } from './gates.js';
import { buildFixGroup, buildFixPlannerPrompt, buildFixPlannerRequest, buildFreshGroup, validateFixPlan, type FixBrief, type FixScope } from './fix-plan.js';
import { NUDGE_GATE_TAIL_LINES } from './nudge.js';
import { runUnitShapeChecks } from './plan-checks.js';
import { renderContractPlan, type ContractPlan, type PlanProblem } from './plan-schema.js';
import { readPlannerBounds } from './planner.js';
import { describeStall, detectStall, standingOf, type StallReason } from './progress.js';
import { failureFromError, isAbortError, type ContractRun } from './run-context.js';
import type { Escalations, Rejudge } from './escalation.js';
import type { StepContext } from './steps.js';
import type { ContractGroup, ContractUnit, Criterion, UnitCheck } from './types.js';
import { addJudgmentUsage } from './usage.js';

/** The decision site stall routes are logged under. */
export const STALL_ROUTE_SITE = 'contract.stall-route';

/** Why a session-mode contract cannot take a planned fix or a fresh agent. */
export const SESSION_NO_DELEGATION_NOTE = 'You asked for this work to be done without delegating, so it cannot be split into planned fixes or handed to a fresh agent.';

/** The last nudges and checks a stall reading sees. */
const STALL_NUDGES = 3;
const STALL_CHECKS = 6;
/** Characters of the agent's last report a stall reading or a fix plan sees. */
const OUTPUT_CAP_CHARS = 4_000;

/** What a failed group or deliverable check found, for correction. */
export interface TargetFinding {
  readonly unmet: readonly string[];
  readonly unshown: readonly string[];
  readonly gates: UnitCheck['gates'];
  readonly output: string;
  readonly decisionIds: readonly string[];
}

export interface Correction {
  unitStalled(run: ContractRun, unitId: string, check: DecidedCheck): Promise<void>;
  unitMergeConflict(run: ContractRun, unitId: string, files: readonly string[]): Promise<void>;
  /** A group check did not pass: a planned fix, or the owner. */
  groupFailed(run: ContractRun, groupId: string, finding: TargetFinding): Promise<void>;
  /** The deliverable check did not pass: a planned fix, or the owner. */
  deliverableFailed(run: ContractRun, finding: TargetFinding): Promise<void>;
  /** A fix group passed its group check: check its target again. */
  fixGroupPassed(run: ContractRun, groupId: string): Promise<void>;
}

/** One line per check: each criterion's verdict at that check. */
export function checkSummaries(criteria: readonly Criterion[], checks: readonly UnitCheck[]): string[] {
  return checks.filter((check) => check.trigger !== 'turn-end').slice(-STALL_CHECKS).map((check) => {
    const verdicts = criteria.flatMap((criterion) => {
      const reading = criterion.readings.find((candidate) => candidate.checkId === check.id);
      return reading === undefined ? [] : [`${criterion.id} ${reading.verdict}`];
    });
    const gates = failedGates(check.gates).map((gate) => `gate ${gate.gate} failed`);
    return `${check.id.split('.').at(-1)}: ${[...verdicts, ...gates].join(', ') || check.result}`;
  });
}

/** Failing gates, each with the tail of its output, for a fix plan. */
function gateFailureLines(gates: UnitCheck['gates']): string[] {
  return failedGates(gates).map((gate) => `${gate.gate}:\n${gate.output.split('\n').slice(-NUDGE_GATE_TAIL_LINES).join('\n')}`);
}

function engineItem(run: ContractRun, itemId: string): WorkItem | undefined {
  for (const workstream of run.engine?.listWorkstreams() ?? []) {
    const item = workstream.items.find((candidate) => candidate.id === itemId);
    if (item !== undefined) return item;
  }
  return undefined;
}

/** How a unit's item integration into the contract branch ended. */
type Integration = { readonly kind: 'merged' } | { readonly kind: 'conflict'; readonly branch: string; readonly files: readonly string[] } | { readonly kind: 'ended' };

export function createCorrection(context: StepContext, escalations: Pick<Escalations, 'raise'> & Rejudge): Correction {
  const config = () => readContractConfig(context.configManager);

  async function readRoute(run: ContractRun, state: Record<string, unknown>): Promise<{ readonly route: StallRoute; readonly act: boolean; readonly decisionId: string | undefined; recordAction(action: string): void }> {
    const usage = emptyJudgmentUsage();
    try {
      const read = await stallRoute.run(meteredPort(judgmentPort(STALL_ROUTE_SITE), usage), state as Parameters<typeof stallRoute.run>[1], { site: STALL_ROUTE_SITE, signal: run.abort.signal });
      const reading = read.readings.route;
      return { route: reading.choice, act: reading.outcome === 'act', decisionId: read.result.decisionId, recordAction: (action) => read.recordAction(action) };
    } finally {
      addJudgmentUsage(run.contract.judgmentUsage, usage);
    }
  }

  function stalled(run: ContractRun, scope: FixScope, targetId: string, route: StallRoute, unmet: readonly string[], reason: string, decisionId?: string): void {
    run.emit({ type: 'CONTRACT_STALLED', contractId: run.id, scope, targetId, route, unmetCriterionIds: unmet, reason, ...(decisionId === undefined ? {} : { decisionId }) });
  }

  // ── Stopping a unit's agent for correction ──────────────────────────────────

  /** Moves the unit into `fixing` and stops its agent: a held agent is released, a running one killed. */
  function stopForFix(run: ContractRun, unit: ContractUnit): void {
    run.moveUnit(unit, 'fixing');
    const runtime = run.runtime(unit);
    if (runtime.hold !== null) {
      run.releaseHold(unit);
      return;
    }
    const agentId = unit.activeAgentId;
    const status = agentId === undefined ? undefined : context.getStatus(agentId)?.status;
    if (agentId !== undefined && (status === 'running' || status === 'pending')) {
      runtime.expectedCancels.add(agentId);
      context.agentManager.cancel(agentId, 'kill');
    }
  }

  /**
   * Worktree mode: the unit's item phase settles as completed, so its work is
   * committed on its branch and merges into the contract branch; resolves when
   * the merge landed or conflicted. Shared mode, or an item already settled:
   * resolves at once.
   */
  async function integrateUnit(run: ContractRun, unit: ContractUnit): Promise<Integration> {
    const runtime = run.runtime(unit);
    const engine = run.engine;
    if (run.contract.isolation !== 'worktree' || engine === null) return { kind: 'merged' };
    const done = (item: WorkItem | undefined): Integration | null => {
      if (item === undefined || item.state === 'failed') return { kind: 'ended' };
      if (item.mergeState === 'merged') return { kind: 'merged' };
      if (item.mergeState === 'conflict') return { kind: 'conflict', branch: item.worktreeBranch ?? item.branch ?? unit.id, files: item.conflictFiles ?? [] };
      return null;
    };
    const outcome = await new Promise<Integration>((resolve) => {
      const unsubscribe = engine.on((event) => {
        if (!('itemId' in event) || event.itemId !== unit.id) return;
        const settled = done(engineItem(run, unit.id));
        if (settled === null) return;
        unsubscribe();
        run.abort.signal.removeEventListener('abort', onAbort);
        resolve(settled);
      });
      function onAbort(): void {
        unsubscribe();
        resolve({ kind: 'ended' });
      }
      run.abort.signal.addEventListener('abort', onAbort, { once: true });
      const now = runtime.settlement === null ? done(engineItem(run, unit.id)) : null;
      if (now !== null) {
        unsubscribe();
        run.abort.signal.removeEventListener('abort', onAbort);
        resolve(now);
        return;
      }
      run.settle(unit, 'completed');
    });
    // The item worktree is gone once merged: checks of this unit read the contract branch from now on.
    if (run.contract.worktreePath !== undefined) runtime.cwd = run.contract.worktreePath;
    return outcome;
  }

  // ── Planned fixes ─────────────────────────────────────────────────────────────

  async function checkFixPlan(run: ContractRun, brief: FixBrief, output: string): Promise<{ readonly group?: ReturnType<typeof validateFixPlan>['group']; readonly plan?: ContractPlan; readonly problems: readonly PlanProblem[]; readonly decisionIds: readonly string[] }> {
    const checked = validateFixPlan(output, brief, config());
    if (checked.problems.length > 0 || checked.group === undefined || checked.plan === undefined) return { ...checked, decisionIds: [] };
    // The unit checks read each fix unit against the criteria it serves: the target's.
    const shaped: ContractPlan = {
      goal: brief.goal,
      criteria: brief.criteria.map((criterion) => ({ id: criterion.id, text: criterion.text, quote: undefined })),
      groups: [checked.group],
    };
    const jev = await runUnitShapeChecks(shaped, { signal: run.abort.signal });
    addJudgmentUsage(run.contract.judgmentUsage, jev.usage);
    return { group: checked.group, plan: checked.plan, problems: jev.problems, decisionIds: jev.decisionIds };
  }

  /**
   * Plans, checks and starts a fix group for the target. Problems left after
   * `contract.planRepairLimit` repairs go to the owner; a planner that cannot
   * run fails the contract with `planning`.
   */
  async function planFix(run: ContractRun, brief: FixBrief, round: number): Promise<void> {
    const { contract } = run;
    const route = await context.routeSelector({ purpose: 'planner', contract: run.view() });
    let repair: { problems: readonly PlanProblem[]; previousPlan: string } | undefined;
    for (let attempt = 0; ; attempt += 1) {
      const result = await context.decompositionRunner.run({
        goal: contract.ask,
        workingDir: contract.worktreePath ?? contract.projectRoot,
        systemPrompt: buildFixPlannerPrompt(),
        userPrompt: buildFixPlannerRequest(brief, repair),
        bounds: readPlannerBounds(context.configManager),
        attempt: attempt === 0 ? 'initial' : 'repair',
        route,
        signal: run.abort.signal,
      });
      if (result.agentId !== undefined) contract.plannerAgentIds.push(result.agentId);
      if (run.terminal) return;
      if (result.status !== 'completed') {
        run.control.fail('planning', `the fix for ${brief.scope} ${brief.targetId} could not be planned: the planner agent ${result.status === 'cancelled' ? 'was stopped' : 'failed'}${result.detail === undefined ? '' : `: ${result.detail}`}`);
        return;
      }
      const checked = await checkFixPlan(run, brief, result.output);
      if (run.terminal) return;
      if (checked.problems.length === 0 && checked.group !== undefined) {
        const { group, units } = buildFixGroup(brief, round, checked.group);
        startFixGroup(run, brief, round, group, units, checked.decisionIds, route);
        return;
      }
      if (attempt >= config().planRepairLimit) {
        escalations.raise(run, {
          scope: brief.scope,
          targetId: brief.targetId,
          reason: 'stalled',
          unmetCriterionIds: brief.requiredIds,
          decisionIds: checked.decisionIds,
          note: `A planned fix could not be made to pass its checks: ${checked.problems.map((entry) => entry.message).join(' ')}`,
        });
        return;
      }
      repair = { problems: checked.problems, previousPlan: checked.plan === undefined ? result.output : renderContractPlan(checked.plan) };
    }
  }

  function startFixGroup(
    run: ContractRun,
    brief: FixBrief,
    round: number,
    group: ContractGroup,
    units: ContractUnit[],
    decisionIds: readonly string[],
    route?: Parameters<ContractRun['decide']>[4],
  ): void {
    run.contract.groups.push(group);
    run.contract.units.push(...units);
    run.decide('fix-planned', brief.targetId, `round ${round}: group ${group.id} with ${units.length} unit${units.length === 1 ? '' : 's'} (${units.map((unit) => unit.id).join(', ')})`, decisionIds, route);
    run.emit({ type: 'CONTRACT_FIX_PLANNED', contractId: run.id, scope: brief.scope, targetId: brief.targetId, groupId: group.id, unitIds: units.map((unit) => unit.id), round });
    context.groups().startGroupNow(run, group.id);
  }

  // ── Briefs for the fix planner ────────────────────────────────────────────────

  function judged(criteria: readonly Criterion[]): Criterion[] {
    return criteria.filter((criterion) => criterion.disposition === 'judged');
  }

  function unitBrief(run: ContractRun, unit: ContractUnit, conflict?: FixBrief['conflict']): FixBrief {
    const criteria = judged(unit.criteria);
    const record = unit.activeAgentId === undefined ? null : context.getStatus(unit.activeAgentId);
    return {
      scope: 'unit',
      targetId: unit.id,
      title: unit.title,
      goal: unit.goal,
      criteria,
      requiredIds: criteria.filter((criterion) => criterion.status !== 'met').map((criterion) => criterion.id),
      lastNudges: unit.nudges.slice(-STALL_NUDGES).map((nudge) => nudge.text),
      gateFailures: gateFailureLines(unit.checks.at(-1)?.gates),
      output: headAndTail(record?.fullOutput ?? unit.answer ?? run.runtime(unit).lastAssistantText, OUTPUT_CAP_CHARS),
      touchedPaths: unit.touchedPaths,
      ...(conflict === undefined ? {} : { conflict }),
    };
  }

  function targetBrief(run: ContractRun, scope: 'group' | 'deliverable', targetId: string, finding: TargetFinding): FixBrief {
    const { contract } = run;
    const group = scope === 'group' ? run.group(targetId) : undefined;
    const target = group === undefined
      ? { id: contract.id, title: contract.goal, goal: contract.goal, criteria: judged(contract.criteria), units: contract.units }
      : { id: group.id, title: group.title, goal: group.goal, criteria: judged(group.criteria), units: contract.units.filter((unit) => unit.groupId === group.id) };
    return {
      scope,
      targetId: target.id,
      title: target.title,
      goal: target.goal,
      criteria: target.criteria,
      requiredIds: [...finding.unmet, ...finding.unshown],
      lastNudges: [],
      gateFailures: gateFailureLines(finding.gates),
      output: headAndTail(finding.output, OUTPUT_CAP_CHARS),
      touchedPaths: [...new Set(target.units.flatMap((unit) => unit.touchedPaths))],
    };
  }

  // ── Units ─────────────────────────────────────────────────────────────────────

  async function splitUnit(run: ContractRun, unit: ContractUnit, conflict?: FixBrief['conflict']): Promise<void> {
    if (unit.status !== 'fixing') stopForFix(run, unit);
    unit.fixRounds += 1;
    const round = unit.fixRounds;
    const integration = await integrateUnit(run, unit);
    if (run.terminal) return;
    const merged = integration.kind === 'conflict' ? { branch: integration.branch, files: integration.files } : conflict;
    await planFix(run, unitBrief(run, unit, merged), round);
  }

  /** Whether the unit's own work item already closed, so no agent can run for it again (worktree mode, after its work merged). */
  function itemClosed(run: ContractRun, unit: ContractUnit): boolean {
    const item = engineItem(run, unit.id);
    return item !== undefined && (item.state === 'passed' || item.state === 'failed');
  }

  async function freshUnit(run: ContractRun, unit: ContractUnit, reason: string, decisionIds: readonly string[]): Promise<void> {
    unit.freshAgents += 1;
    const route = await context.routeSelector({ purpose: 'fresh-unit', contract: run.view(), unit: structuredClone(unit) });
    if (run.terminal) return;
    unit.route = route;
    run.decide('fresh-agent', unit.id, reason, decisionIds, route);
    if (itemClosed(run, unit)) {
      if (unit.status !== 'fixing') stopForFix(run, unit);
      unit.fixRounds += 1;
      const { group, units } = buildFreshGroup(unit, unit.fixRounds);
      startFixGroup(run, { scope: 'unit', targetId: unit.id, title: unit.title, goal: unit.goal, criteria: [], requiredIds: [], lastNudges: [], gateFailures: [], output: '', touchedPaths: [] }, unit.fixRounds, group, units, decisionIds, route);
      return;
    }
    // The requeued item takes the unit's new route.
    context.groups().requeueUnit(run, unit, `fresh agent: ${reason}`, 'fresh-unit');
  }

  function toOwner(run: ContractRun, scope: FixScope, targetId: string, reason: 'stalled' | 'fix-rounds-exhausted', unmet: readonly string[], unshown: readonly string[], decisionIds: readonly string[], note?: string): void {
    escalations.raise(run, { scope, targetId, reason, unmetCriterionIds: unmet, unshownCriterionIds: unshown, decisionIds, ...(note === undefined ? {} : { note }) });
  }

  function exhausted(run: ContractRun, spent: number): boolean {
    return spent >= config().maxFixRounds;
  }

  async function unitStalled(run: ContractRun, unitId: string, check: DecidedCheck): Promise<void> {
    const unit = run.unit(unitId);
    if (unit === undefined || run.terminal) return;
    const unmet = [...check.verdicts].filter(([, verdict]) => verdict === 'unmet').map(([id]) => id);
    const unshown = [...check.verdicts].filter(([, verdict]) => verdict === 'unshown').map(([id]) => id);
    const why = check.stall === undefined ? `check ${check.check.id} did not pass after the unit's own agent finished` : describeStall(check.stall);
    if (run.contract.sessionMode === true) {
      stalled(run, 'unit', unit.id, 'owner', unmet, `${why}; ${SESSION_NO_DELEGATION_NOTE}`);
      check.recordAction('stalled: to the owner (session mode)');
      toOwner(run, 'unit', unit.id, 'stalled', unmet, unshown, check.check.decisionIds, SESSION_NO_DELEGATION_NOTE);
      return;
    }
    if (exhausted(run, unit.fixRounds + unit.freshAgents)) {
      stalled(run, 'unit', unit.id, 'owner', unmet, `${why}; ${unit.fixRounds + unit.freshAgents} fix rounds and fresh agents spent`);
      check.recordAction('stalled: fix rounds exhausted, to the owner');
      toOwner(run, 'unit', unit.id, 'fix-rounds-exhausted', unmet, unshown, check.check.decisionIds);
      return;
    }
    const record = unit.activeAgentId === undefined ? null : context.getStatus(unit.activeAgentId);
    const judgedCriteria = judged(unit.criteria);
    const read = await readRoute(run, {
      unit: { goal: unit.goal, criteria: judgedCriteria.map((criterion) => `${criterion.id} ${criterion.text}`) },
      unmet,
      unshown,
      lastNudges: unit.nudges.slice(-STALL_NUDGES).map((nudge) => nudge.text),
      checks: checkSummaries(judgedCriteria, unit.checks),
      lastOutput: headAndTail(record?.fullOutput ?? run.runtime(unit).lastAssistantText, OUTPUT_CAP_CHARS),
    });
    if (run.terminal) return;
    const route: StallRoute = read.act ? read.route : 'owner';
    const decisionIds = [...check.check.decisionIds, ...(read.decisionId === undefined ? [] : [read.decisionId])];
    stalled(run, 'unit', unit.id, route, unmet, read.act ? why : `${why}; the route read ${read.route} below act`, read.decisionId);
    read.recordAction(`route ${route}`);
    check.recordAction(`stalled: ${route}`);
    if (route === 'split') await splitUnit(run, unit);
    else if (route === 'fresh') await freshUnit(run, unit, why, decisionIds);
    else toOwner(run, 'unit', unit.id, 'stalled', unmet, unshown, decisionIds);
  }

  async function unitMergeConflict(run: ContractRun, unitId: string, files: readonly string[]): Promise<void> {
    const unit = run.unit(unitId);
    // A unit already being fixed merged for its fix; its fix planning reads the conflict itself.
    if (unit === undefined || run.terminal || unit.status === 'fixing') return;
    const item = engineItem(run, unit.id);
    const conflict = { branch: item?.worktreeBranch ?? item?.branch ?? unit.id, files };
    const unmet = judged(unit.criteria).filter((criterion) => criterion.status !== 'met').map((criterion) => criterion.id);
    const why = `its branch conflicts with the contract branch in ${files.join(', ') || 'unknown files'}`;
    if (exhausted(run, unit.fixRounds + unit.freshAgents)) {
      stalled(run, 'unit', unit.id, 'owner', unmet, `${why}; fix rounds exhausted`);
      toOwner(run, 'unit', unit.id, 'fix-rounds-exhausted', unmet, [], [], `Its branch ${conflict.branch} conflicts with the contract branch in: ${files.join(', ')}.`);
      return;
    }
    stalled(run, 'unit', unit.id, 'split', unmet, why);
    run.runtime(unit).cwd = run.contract.worktreePath ?? run.contract.projectRoot;
    stopForFix(run, unit);
    unit.fixRounds += 1;
    await planFix(run, unitBrief(run, unit, conflict), unit.fixRounds);
  }

  // ── Groups and the deliverable ────────────────────────────────────────────────

  /** A group or the deliverable whose check did not pass: a planned fix, unless its rounds are spent or it stalled. */
  async function targetFailed(run: ContractRun, scope: 'group' | 'deliverable', target: { readonly id: string; readonly goal: string; readonly criteria: readonly Criterion[]; readonly checks: readonly UnitCheck[]; fixRounds: number }, finding: TargetFinding): Promise<void> {
    const unmet = finding.unmet;
    if (run.contract.sessionMode === true) {
      stalled(run, scope, target.id, 'owner', unmet, SESSION_NO_DELEGATION_NOTE);
      toOwner(run, scope, target.id, 'stalled', unmet, finding.unshown, finding.decisionIds, SESSION_NO_DELEGATION_NOTE);
      return;
    }
    if (exhausted(run, target.fixRounds)) {
      stalled(run, scope, target.id, 'owner', unmet, `${target.fixRounds} fix rounds spent`);
      toOwner(run, scope, target.id, 'fix-rounds-exhausted', unmet, finding.unshown, finding.decisionIds);
      return;
    }
    const stall: StallReason | null = target.checks.length === 0
      ? null
      : detectStall({ criteria: [...target.criteria], checks: target.checks.slice(0, -1), nudges: [] }, standingOf({ criteria: [...target.criteria] }, target.checks.at(-1)!), [], { stallLimit: config().stallLimit, maxNudgesPerUnit: Number.POSITIVE_INFINITY });
    let route: StallRoute = 'split';
    let decisionId: string | undefined;
    let reason = 'the check did not pass';
    if (stall !== null) {
      reason = describeStall(stall);
      const judgedCriteria = judged(target.criteria);
      const read = await readRoute(run, {
        unit: { goal: target.goal, criteria: judgedCriteria.map((criterion) => `${criterion.id} ${criterion.text}`) },
        unmet,
        unshown: finding.unshown,
        lastNudges: [],
        checks: checkSummaries(judgedCriteria, target.checks),
        lastOutput: headAndTail(finding.output, OUTPUT_CAP_CHARS),
      });
      if (run.terminal) return;
      decisionId = read.decisionId;
      // A group has no agent of its own: a fresh start is a new planned fix.
      route = !read.act || read.route === 'owner' ? 'owner' : 'split';
      read.recordAction(`route ${route}${read.route === 'fresh' ? ' (a fresh start for a group is a new planned fix)' : ''}`);
    }
    stalled(run, scope, target.id, route, unmet, reason, decisionId);
    const decisionIds = [...finding.decisionIds, ...(decisionId === undefined ? [] : [decisionId])];
    if (route === 'owner') {
      toOwner(run, scope, target.id, 'stalled', unmet, finding.unshown, decisionIds);
      return;
    }
    target.fixRounds += 1;
    if (scope === 'group') {
      const group = run.group(target.id);
      if (group !== undefined) run.moveGroup(group, 'fixing');
    } else {
      run.moveContract('fixing');
    }
    await planFix(run, targetBrief(run, scope, target.id, finding), target.fixRounds);
  }

  async function groupFailed(run: ContractRun, groupId: string, finding: TargetFinding): Promise<void> {
    const group = run.group(groupId);
    if (group === undefined || run.terminal) return;
    await targetFailed(run, 'group', group, finding);
  }

  async function deliverableFailed(run: ContractRun, finding: TargetFinding): Promise<void> {
    if (run.terminal) return;
    const { contract } = run;
    await targetFailed(run, 'deliverable', { id: contract.id, goal: contract.goal, criteria: contract.criteria, checks: contract.checks, get fixRounds() { return contract.fixRounds; }, set fixRounds(value: number) { contract.fixRounds = value; } }, finding);
  }

  async function fixGroupPassed(run: ContractRun, groupId: string): Promise<void> {
    const group = run.group(groupId);
    const repairs = group?.repairs;
    if (group === undefined || repairs === undefined || run.terminal) return;
    if (repairs.scope === 'unit') {
      const unit = run.unit(repairs.targetId);
      if (unit === undefined || unit.status !== 'fixing') return;
      const fixed = run.contract.units.filter((candidate) => candidate.groupId === groupId);
      const runtime = run.runtime(unit);
      // The re-check reads the unit's own files and those its fixes changed, nothing a sibling did.
      runtime.evidencePaths = new Set([...unit.touchedPaths, ...fixed.flatMap((candidate) => candidate.touchedPaths)]);
      const record = unit.activeAgentId === undefined ? null : context.getStatus(unit.activeAgentId);
      const own = record?.fullOutput ?? unit.answer ?? runtime.lastAssistantText;
      const output = [own, `Planned fix ${group.id}:`, ...fixed.map((candidate) => `- ${candidate.id} "${candidate.title}": ${candidate.answer?.trim() || '(no answer recorded)'}`)].join('\n');
      await context.checks().runCheck(run, unit, 'fix-passed', output);
      return;
    }
    if (repairs.scope === 'group') {
      await escalations.rejudgeGroup(run, repairs.targetId);
      return;
    }
    await escalations.rejudgeDeliverable(run);
  }

  return {
    unitStalled: (run, unitId, check) => guarded(run, `unit ${unitId}'s stall could not be routed`, () => unitStalled(run, unitId, check)),
    unitMergeConflict: (run, unitId, files) => guarded(run, `unit ${unitId}'s merge conflict could not be routed`, () => unitMergeConflict(run, unitId, files)),
    groupFailed: (run, groupId, finding) => guarded(run, `group ${groupId}'s failed check could not be routed`, () => groupFailed(run, groupId, finding)),
    deliverableFailed: (run, finding) => guarded(run, "the deliverable's failed check could not be routed", () => deliverableFailed(run, finding)),
    fixGroupPassed: (run, groupId) => guarded(run, `fix group ${groupId}'s target could not be checked again`, () => fixGroupPassed(run, groupId)),
  };
}

/** Runs a correction or completion step; an error (a Jev outage, a planner that cannot run) fails the contract with what it was doing. */
export async function guarded(run: ContractRun, what: string, step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch (error) {
    if (run.terminal || isAbortError(error, run.abort.signal)) return;
    const failure = failureFromError(error);
    run.control.fail(failure.kind, `${what}: ${failure.reason}`);
  }
}

