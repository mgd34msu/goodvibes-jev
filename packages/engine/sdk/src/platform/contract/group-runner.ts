/**
 * Groups on the orchestration engine (docs/design/contract-runner.md sections
 * 6.1, 7.3 and 7.4): one engine per contract, a workstream per group started
 * once every group it depends on passed, and the engine's events translated
 * into the contract tree.
 *
 * - Before a group's workstream exists, every unit in it gets its route from
 *   the route selector (there is no default model), and in shared mode the
 *   group takes the shared-tree lock.
 * - When the engine spawns a unit's agent (`item-agent-spawned`), the unit
 *   records the agent, takes its baseline (the first time), and the spawn is
 *   reported with its route and purpose.
 * - A contract unit's phase waits on the runner's settlement, so a unit
 *   agent's failure is read by the runner, never by the phase runner.
 * - When every unit of a group passed (and, in worktree mode, merged into the
 *   contract branch), the group goes to the group step (R.6), which passes
 *   it through `RunControl.passGroup` or repairs it.
 * - A best-of-N unit (worktree mode) runs as attempt units, one per sibling
 *   the engine expands it into; when the siblings are all terminal the
 *   selection (best-of-n.ts) takes one, and the unit passes once that attempt
 *   merged. In shared mode the engine cannot run siblings apart, so the unit
 *   runs once and the decision says so.
 */
import { spawnSync } from 'node:child_process';
import type { CreateWorkstreamInput, OrchestrationEngine } from '../orchestration/engine.js';
import type { FleetCapacityFn } from '../orchestration/elastic-pool.js';
import type { ContractUnitSettlement } from '../orchestration/phase-runner.js';
import { snapshotDirtyTree } from '../orchestration/dirty-guard.js';
import type { AttemptJudge, OrchestrationEvent, WorkItem } from '../orchestration/types.js';
import { GitService } from '../git/service.js';
import type { AgentRecord } from '../tools/agent/index.js';
import { attemptUnitsFor, createContractAttemptJudge, selectAttempts, type AttemptSteps } from './best-of-n.js';
import { briefWithPreviousChecks, buildUnitBrief } from './brief.js';
import { failureFromError, isAbortError, type ContractRun, type SpawnPurpose } from './run-context.js';
import { isTerminalUnitStatus, type ContractFailureKind, type ContractGroup, type ContractRouteSelector, type ContractUnit } from './types.js';
import { rollUpContractUsage, type UsagePricing } from './usage.js';
import type { UnitWatchdog } from './watchdog.js';
import { acquireSharedTree, groupWorkstreamInput } from './workstreams.js';

/** What the runner hands `createEngine` for one contract. */
export interface ContractEngineInput {
  /** The contract's worktree in worktree mode, else the project root: where item phases run and integrate. */
  readonly projectRoot: string;
  /** The real project root: workstream snapshots stay there. */
  readonly stateRoot: string;
  /** The contract id: its snapshots get their own directory, since every contract names its groups g1, g2... */
  readonly stateNamespace: string;
  readonly contractUnitSettlement: ContractUnitSettlement;
  readonly fleetCapacity: FleetCapacityFn;
  /** The `contract.best-of-n` selector over this contract's attempts, for `fleet.attempts.judge` (design 6.2). */
  readonly judgeAttempts: AttemptJudge;
}

/** The group and deliverable steps (R.6) the runner hands work to. */
export interface GroupSteps extends AttemptSteps {
  /** Every unit of the group passed and merged: judge the group (6.4), then `run.control.passGroup` or repair it. */
  groupUnitsPassed(run: ContractRun, groupId: string): Promise<void>;
  /** Every group passed: judge the deliverable, commit and answer (6.4, 6.5), ending in `run.control.finishPassed`. */
  groupsPassed(run: ContractRun): Promise<void>;
  /** A unit's branch conflicted when it merged into the contract branch (7.4): route it to a planned fix (5.1). */
  unitMergeConflict(run: ContractRun, unitId: string, files: readonly string[]): Promise<void>;
  /** A planned-fix group passed: check its target (a unit, a group or the deliverable) again (5.2). */
  fixGroupPassed(run: ContractRun, groupId: string): Promise<void>;
}

export interface GroupRunnerDeps {
  readonly createEngine: (input: ContractEngineInput) => OrchestrationEngine;
  readonly fleetCapacity: FleetCapacityFn;
  readonly routeSelector: ContractRouteSelector;
  readonly getStatus: (agentId: string) => AgentRecord | null;
  readonly watchdog: UnitWatchdog;
  readonly settlement: ContractUnitSettlement;
  readonly steps: GroupSteps;
  readonly pricing: UsagePricing;
  readonly failContract: (run: ContractRun, kind: ContractFailureKind, reason: string) => void;
  readonly failUnit: (run: ContractRun, unit: ContractUnit, kind: ContractFailureKind, reason: string) => void;
}

export interface GroupRunner {
  /** Creates the contract's engine, moves it to running and starts every group that is ready. */
  startRun(run: ContractRun): void;
  /** A unit passed; its group may be done. */
  unitPassed(run: ContractRun, unit: ContractUnit): void;
  passGroup(run: ContractRun, groupId: string): void;
  /** Starts a group now, whatever it depends on: a planned-fix group added while the contract runs (5.2). */
  startGroupNow(run: ContractRun, groupId: string): void;
  /** Gives a unit a fresh agent: its brief with "Previous checks", and `firstTurn` after it when given. */
  requeueUnit(run: ContractRun, unit: ContractUnit, reason: string, purpose: SpawnPurpose, firstTurn?: string): void;
  /** Stops every unit agent still working, and the engine. */
  stopRun(run: ContractRun): void;
}

/** A unit's baseline in `cwd`: HEAD and the hashes of paths already dirty (design 4.3). Undefined outside git. */
export function takeBaseline(cwd: string): ContractUnit['baseline'] {
  if (!GitService.isGitRepo(cwd)) return undefined;
  const head = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf-8' });
  return {
    head: head.status === 0 ? head.stdout.trim() || null : null,
    dirty: Object.fromEntries(snapshotDirtyTree(cwd)),
  };
}

/** The engine item whose state is the unit's: its own, or for a best-of-N unit the attempt it took. */
function unitItemId(unit: ContractUnit): string | undefined {
  return unit.attemptUnits === undefined ? unit.id : unit.attemptSelection?.pickedId;
}

function engineItem(run: ContractRun, itemId: string): WorkItem | undefined {
  for (const workstream of run.engine?.listWorkstreams() ?? []) {
    const item = workstream.items.find((candidate) => candidate.id === itemId);
    if (item !== undefined) return item;
  }
  return undefined;
}

export function createGroupRunner(deps: GroupRunnerDeps): GroupRunner {
  function unitOfItem(run: ContractRun, itemId: string): ContractUnit | undefined {
    const item = engineItem(run, itemId);
    return run.unit(item?.contractUnitId ?? itemId);
  }

  function startRun(run: ContractRun): void {
    const { contract } = run;
    const engine = deps.createEngine({
      projectRoot: contract.worktreePath ?? contract.projectRoot,
      stateRoot: contract.projectRoot,
      stateNamespace: contract.id,
      contractUnitSettlement: deps.settlement,
      fleetCapacity: deps.fleetCapacity,
      judgeAttempts: createContractAttemptJudge(run),
    });
    run.engine = engine;
    run.unsubscribeEngine = engine.on((event) => onEngineEvent(run, event));
    // The deliverable's diff and the shared-mode commit are measured from here.
    contract.baseline ??= takeBaseline(contract.worktreePath ?? contract.projectRoot);
    run.moveContract('running');
    startReadyGroups(run);
  }

  function startReadyGroups(run: ContractRun): void {
    if (run.terminal) return;
    for (const group of run.contract.groups) {
      if (group.status !== 'pending' && group.status !== 'blocked') continue;
      if (run.startingGroups.has(group.id)) continue;
      const ready = group.dependsOn.every((id) => run.group(id)?.status === 'passed');
      if (ready) void startGroup(run, group);
    }
  }

  async function startGroup(run: ContractRun, group: ContractGroup): Promise<void> {
    const { contract } = run;
    run.startingGroups.add(group.id);
    try {
      const units = contract.units.filter((unit) => unit.groupId === group.id);
      // A fix group for a unit runs inside the unit's group, which already holds the shared tree.
      const inheritsTree = group.kind === 'fix' && group.repairs?.scope === 'unit';
      if (contract.isolation === 'shared' && !inheritsTree) {
        const release = await acquireSharedTree(contract.projectRoot, run.abort.signal);
        if (run.terminal) {
          release();
          return;
        }
        run.sharedTreeReleases.set(group.id, release);
      }
      for (const unit of units) {
        if (unit.route !== undefined) continue;
        unit.route = await deps.routeSelector({ purpose: unit.role === 'integration' ? 'integration' : 'unit', contract: run.view(), unit: structuredClone(unit) });
        if (run.terminal) return;
      }
      for (const unit of units) expandAttempts(run, unit);
      // Each attempt is its own try: the route selector picks its model too.
      for (const attempt of units.flatMap((unit) => unit.attemptUnits ?? [])) {
        if (attempt.route !== undefined) continue;
        attempt.route = await deps.routeSelector({ purpose: 'unit', contract: run.view(), unit: structuredClone(attempt) });
        if (run.terminal) return;
      }
      rollUpContractUsage(contract, deps.getStatus, deps.pricing);
      // The group check's diff is measured from here (6.4).
      group.baseline ??= takeBaseline(contract.worktreePath ?? contract.projectRoot);
      const input: CreateWorkstreamInput = groupWorkstreamInput(contract, group, run.env.config(), contract.usage);
      const engine = run.engine;
      if (engine === null) throw new Error(`contract ${contract.id} has no engine`);
      engine.createWorkstream(input);
      run.moveGroup(group, 'running');
      engine.start(group.id);
    } catch (error) {
      if (run.terminal || isAbortError(error, run.abort.signal)) return;
      const failure = failureFromError(error);
      deps.failContract(run, failure.kind, `group ${group.id} could not start: ${failure.reason}`);
    } finally {
      run.startingGroups.delete(group.id);
    }
  }

  /** A best-of-N unit gets its attempt units (worktree mode), or runs once in a shared tree. */
  function expandAttempts(run: ContractRun, unit: ContractUnit): void {
    if (unit.attempts <= 1 || unit.attemptUnits !== undefined) return;
    if (run.contract.isolation === 'worktree') {
      unit.attemptUnits = attemptUnitsFor(unit);
      return;
    }
    run.decide('attempts-reduced', unit.id, `unit ${unit.id} asks for ${unit.attempts} attempts, but attempts need worktree isolation to run apart; in the shared working tree it runs once`);
  }

  /** The plan unit an attempt unit belongs to. */
  function planUnitOf(run: ContractRun, unit: ContractUnit): ContractUnit | undefined {
    return unit.attemptOf === undefined ? undefined : run.unit(unit.attemptOf);
  }

  function unitSpawned(run: ContractRun, itemId: string, agentId: string): void {
    const item = engineItem(run, itemId);
    const unit = run.unit(item?.contractUnitId ?? itemId);
    if (unit === undefined || run.terminal) return;
    const runtime = run.runtime(unit);
    unit.agentIds.push(agentId);
    const planUnit = planUnitOf(run, unit);
    if (planUnit !== undefined) {
      // The plan unit's agents are its attempts' agents: its usage and the contract's count them once each.
      planUnit.agentIds.push(agentId);
      if (planUnit.status === 'pending' || planUnit.status === 'blocked') run.moveUnit(planUnit, 'running');
    }
    unit.activeAgentId = agentId;
    runtime.agentStartedAt = run.env.now();
    runtime.cwd = item?.worktreePath ?? run.contract.worktreePath ?? run.contract.projectRoot;
    unit.baseline ??= takeBaseline(runtime.cwd);
    const purpose = runtime.nextSpawnPurpose;
    runtime.nextSpawnPurpose = 'unit';
    run.moveUnit(unit, 'running');
    const route = unit.route;
    if (route === undefined) throw new Error(`unit ${unit.id} spawned without a route`);
    run.decide('spawned', unit.id, `agent ${agentId} (${purpose}): ${route.reason}`, [], route);
    run.emit({
      type: 'CONTRACT_UNIT_SPAWNED',
      contractId: run.id,
      unitId: unit.id,
      agentId,
      route: { model: route.model, provider: route.provider, ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }), reason: route.reason },
      purpose,
    });
    deps.watchdog.touch(agentId);
  }

  function markMerged(run: ContractRun, itemId: string): void {
    const unit = unitOfItem(run, itemId);
    if (unit === undefined || unit.status !== 'held-merge') return;
    run.moveUnit(unit, 'passed');
    unitPassed(run, unit);
    // The attempt a best-of-N unit took merged: the unit passes with it.
    const planUnit = planUnitOf(run, unit);
    if (planUnit?.attemptSelection?.pickedId === unit.id && planUnit.status === 'held-merge') {
      run.moveUnit(planUnit, 'passed');
      unitPassed(run, planUnit);
    }
  }

  /** A plan unit waiting on its attempts mirrors whether they are blocked. */
  function mirrorBlocked(run: ContractRun, unit: ContractUnit): void {
    const planUnit = planUnitOf(run, unit);
    if (planUnit === undefined) return;
    const attempts = planUnit.attemptUnits ?? [];
    if (planUnit.status === 'pending' && attempts.every((attempt) => attempt.status === 'blocked')) run.moveUnit(planUnit, 'blocked');
    else if (planUnit.status === 'blocked' && attempts.some((attempt) => attempt.status !== 'blocked')) run.moveUnit(planUnit, 'pending');
  }

  function attemptsReady(run: ContractRun, event: Extract<OrchestrationEvent, { type: 'attempts-ready' }>): void {
    void selectAttempts(run, event.groupId, {
      steps: deps.steps,
      failUnit: deps.failUnit,
      failContract: deps.failContract,
    }).catch((error: unknown) => stepFailed(run, `the attempts of group ${event.groupId} could not be selected`, error));
  }

  function onEngineEvent(run: ContractRun, event: OrchestrationEvent): void {
    if (run.terminal) return;
    switch (event.type) {
      case 'item-agent-spawned':
        unitSpawned(run, event.itemId, event.agentId);
        return;
      case 'item-blocked-dependency':
      case 'item-blocked-budget': {
        const unit = unitOfItem(run, event.itemId);
        if (unit?.status === 'pending') run.moveUnit(unit, 'blocked');
        if (unit !== undefined) mirrorBlocked(run, unit);
        return;
      }
      case 'item-dependency-cleared': {
        const unit = unitOfItem(run, event.itemId);
        if (unit?.status === 'blocked') run.moveUnit(unit, 'pending');
        if (unit !== undefined) mirrorBlocked(run, unit);
        return;
      }
      case 'attempts-ready':
        attemptsReady(run, event);
        return;
      case 'item-passed': {
        const unit = unitOfItem(run, event.itemId);
        if (unit !== undefined) unitPassed(run, unit);
        return;
      }
      case 'item-merged':
        markMerged(run, event.itemId);
        return;
      case 'item-worktree-removed':
        // A branch with nothing to merge integrates as an empty merge: no merged event, the worktree is just removed.
        if (engineItem(run, event.itemId)?.mergeState === 'merged') markMerged(run, event.itemId);
        return;
      case 'item-merge-conflict': {
        // The attempt a best-of-N unit took conflicted: the unit is what conflicts.
        const attempt = unitOfItem(run, event.itemId);
        const unit = attempt === undefined ? undefined : (planUnitOf(run, attempt) ?? attempt);
        if (unit === undefined) return;
        run.emit({ type: 'CONTRACT_MERGE_CONFLICT', contractId: run.id, unitId: unit.id, branch: event.branch, path: event.path, files: event.files });
        void deps.steps.unitMergeConflict(run, unit.id, event.files).catch((error: unknown) => stepFailed(run, `unit ${unit.id}'s merge conflict could not be routed`, error));
        return;
      }
      case 'item-failed': {
        // The engine failed an item the runner did not end (a worktree that
        // could not be set up, a spawn that threw): the unit fails with it.
        const unit = unitOfItem(run, event.itemId);
        if (unit !== undefined && !isTerminalUnitStatus(unit.status)) deps.failUnit(run, unit, 'other', `unit ${unit.id}'s work item failed: ${event.reason}`);
        return;
      }
      default:
        return;
    }
  }

  function stepFailed(run: ContractRun, what: string, error: unknown): void {
    if (run.terminal) return;
    const failure = failureFromError(error);
    deps.failContract(run, failure.kind, `${what}: ${failure.reason}`);
  }

  function unitPassed(run: ContractRun, unit: ContractUnit): void {
    const group = run.group(unit.groupId);
    if (group === undefined || group.status !== 'running' || run.settledGroups.has(group.id)) return;
    const units = run.contract.units.filter((candidate) => candidate.groupId === group.id);
    if (!units.every((candidate) => candidate.status === 'passed')) return;
    if (!units.every((candidate) => {
      const itemId = unitItemId(candidate);
      return itemId !== undefined && engineItem(run, itemId)?.state === 'passed';
    })) return;
    run.settledGroups.add(group.id);
    run.sharedTreeReleases.get(group.id)?.();
    run.sharedTreeReleases.delete(group.id);
    void deps.steps.groupUnitsPassed(run, group.id).catch((error: unknown) => stepFailed(run, `group ${group.id} could not be judged`, error));
  }

  function passGroup(run: ContractRun, groupId: string): void {
    const group = run.group(groupId);
    if (group === undefined || run.terminal) return;
    run.moveGroup(group, 'passed');
    run.decide('group-passed', group.id, `every unit of ${group.id} passed${group.criteria.length === 0 ? '' : ' and the group check passed'}`);
    if (group.kind === 'fix') {
      // A planned fix passed: its target is checked again; the target decides what runs next.
      void deps.steps.fixGroupPassed(run, group.id).catch((error: unknown) => stepFailed(run, `fix group ${group.id}'s target could not be checked again`, error));
      return;
    }
    if (run.contract.groups.every((candidate) => candidate.status === 'passed')) {
      void deps.steps.groupsPassed(run).catch((error: unknown) => stepFailed(run, 'the deliverable could not be judged', error));
      return;
    }
    startReadyGroups(run);
  }

  function requeueUnit(run: ContractRun, unit: ContractUnit, reason: string, purpose: SpawnPurpose, firstTurn?: string): void {
    const engine = run.engine;
    const group = run.group(unit.groupId);
    if (engine === null || group === undefined || run.terminal) return;
    const runtime = run.runtime(unit);
    const agentId = unit.activeAgentId;
    const record = agentId === undefined ? null : deps.getStatus(agentId);
    if (agentId !== undefined && (record?.status === 'running' || record?.status === 'pending')) runtime.expectedCancels.add(agentId);
    if (runtime.check !== null) {
      runtime.check.superseded = true;
      runtime.check.abort.abort();
      runtime.check = null;
    }
    runtime.recheckPending = false;
    run.releaseHold(unit);
    runtime.nextSpawnPurpose = purpose;
    if (agentId !== undefined) deps.watchdog.forget(agentId);
    run.moveUnit(unit, 'pending');
    const task = [briefWithPreviousChecks(buildUnitBrief(run.contract, group, unit), unit), firstTurn].filter((part): part is string => part !== undefined && part.length > 0).join('\n\n');
    if (!engine.requeueItem(unit.id, reason, task, unit.route)) deps.failUnit(run, unit, 'other', `unit ${unit.id} could not be given a fresh agent (${reason})`);
  }

  function stopRun(run: ContractRun): void {
    const engine = run.engine;
    if (engine !== null) {
      for (const workstream of engine.listWorkstreams()) {
        for (const item of workstream.items) {
          if (item.state === 'passed' || item.state === 'failed') continue;
          const unit = run.unit(item.contractUnitId ?? item.id);
          if (unit !== undefined && item.agentId !== undefined) run.runtime(unit).expectedCancels.add(item.agentId);
          engine.kill(item.id);
        }
      }
      run.unsubscribeEngine?.();
      run.unsubscribeEngine = null;
      engine.dispose();
    }
    for (const unit of run.allUnits()) {
      run.settle(unit, 'cancelled');
      if (unit.activeAgentId !== undefined) deps.watchdog.forget(unit.activeAgentId);
    }
    for (const release of run.sharedTreeReleases.values()) release();
    run.sharedTreeReleases.clear();
  }

  function startGroupNow(run: ContractRun, groupId: string): void {
    const group = run.group(groupId);
    if (group === undefined || run.terminal || run.startingGroups.has(group.id) || (group.status !== 'pending' && group.status !== 'blocked')) return;
    void startGroup(run, group);
  }

  return { startRun, unitPassed, passGroup, startGroupNow, requeueUnit, stopRun };
}
