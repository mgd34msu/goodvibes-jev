/**
 * The contract runner (docs/design/contract-runner.md sections 1, 2.2, 6.5
 * and 7.3): `createContractRunner(deps)` owns every contract's lifecycle.
 *
 * - `start` creates the contract and its owner record (the record parents and
 *   surfaces wait on; it runs no model) and returns at once. The contract is
 *   shaped and planned (planner.ts), then its groups run on one orchestration
 *   engine per contract (group-runner.ts) with the full nudge loop
 *   (agent-hooks.ts, unit-failures.ts).
 * - At most `contract.maxActiveContracts` contracts are past `queued`; the
 *   rest wait in a FIFO queue and the oldest starts whenever one ends. A
 *   contract awaiting its owner keeps its slot.
 * - A contract ends passed, failed or cancelled. The owner record ends with
 *   it: its status, answer (`fullOutput`), status line (operator audience
 *   only), usage and tool-call totals are the contract's.
 *
 * Group and deliverable judging, stall routing, owner escalations and the
 * commit are the correction and completion steps (R.6), handed in as `steps`.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { ContractEvent } from '../../events/contract.js';
import type { AgentMessageBus } from '../agents/message-bus.js';
import { setAgentProgress } from '../agents/progress-audience.js';
import { IsolatedWorktree } from '../agents/worktree.js';
import type { DecompositionRunner } from '../core/plan-decomposition.js';
import type { OrchestrationEngine } from '../orchestration/engine.js';
import type { FleetCapacityFn } from '../orchestration/elastic-pool.js';
import type { ContractUnitOutcome, ContractUnitSettlement } from '../orchestration/phase-runner.js';
import { emptyWorkItemUsage, type PriceProvenanceFn } from '../orchestration/types.js';
import { emitAgentCancelled, emitAgentCompleted, emitAgentFailed } from '../runtime/emitters/index.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { AgentManager, AgentRecord } from '../tools/agent/index.js';
import { createUnitCheckLoop, type ContractAgentHooks, type UnitCheckEscalations } from './agent-hooks.js';
import { readContractConfig, type ContractConfigReader } from './config.js';
import { emitContractEvent } from './events.js';
import { createGroupRunner, type ContractEngineInput, type GroupSteps } from './group-runner.js';
import { CONTRACT_RUNNER_AGENT_ID } from './nudge.js';
import { planContract, shapeContract, type ContractPlannerDeps, type PlanningOutcome, type ShapeOutcome } from './planner.js';
import { ContractRun, failureFromError, type RunEnv } from './run-context.js';
import type { ContractStore } from './store.js';
import {
  CURRENT_CONTRACT_SCHEMA_VERSION,
  isTerminalContractStatus,
  newContractId,
  type Contract,
  type ContractFailureKind,
  type ContractRouteSelector,
  type ContractView,
  type StartContractInput,
} from './types.js';
import { createUnitFailureHandling } from './unit-failures.js';
import { contractAgentIds, ownerRecordUsage, rollUpContractUsage, type PriceUsageFn } from './usage.js';
import { createUnitWatchdog, type WatchedAgent } from './watchdog.js';

/** The correction and completion steps (R.6): what the runner hands a unit, group or contract to when a nudge is not the answer. */
export interface ContractSteps extends UnitCheckEscalations, GroupSteps {}

export interface ContractRunnerDeps {
  readonly agentManager: Pick<AgentManager, 'spawn' | 'getStatus' | 'list' | 'cancel' | 'wakeWithSteer'>;
  readonly messageBus: Pick<AgentMessageBus, 'send' | 'registerAgent'>;
  readonly runtimeBus: RuntimeEventBus;
  readonly configManager: ContractConfigReader;
  readonly projectRoot: string;
  /** Picks the model for the planner and every unit; required, there is no default model. */
  readonly routeSelector: ContractRouteSelector;
  /** Runs the read-only planner agent (agents/planner-decomposition-runner.ts). */
  readonly decompositionRunner: DecompositionRunner;
  /** One orchestration engine per contract. */
  readonly createEngine: (input: ContractEngineInput) => OrchestrationEngine;
  /** The fleet ceiling every contract's units share. */
  readonly fleetCapacity: FleetCapacityFn;
  readonly priceUsage: PriceUsageFn;
  readonly priceProvenance: PriceProvenanceFn;
  readonly store: ContractStore;
  readonly steps: ContractSteps;
  /** The repository summary the planner starts from; defaults to the repo_map tool. */
  readonly repositoryMap?: ((projectRoot: string) => Promise<string>) | undefined;
  readonly now?: (() => number) | undefined;
}

export interface StartedContract {
  readonly contract: ContractView;
  /** The owner record parents wait on (design 6.5). */
  readonly owner: AgentRecord;
}

export interface ContractRunner {
  /** Starts a contract from an ask. Returns at once with the contract and its owner agent record. */
  start(input: StartContractInput): StartedContract;
  get(contractId: string): ContractView | null;
  list(filter?: { readonly sessionId?: string | undefined; readonly includeTerminal?: boolean | undefined }): ContractView[];
  /** Stops a contract and everything it runs. False when it is unknown or already ended. */
  cancel(contractId: string, reason: string): boolean;
  importContract(snapshotJson: string, force?: boolean): boolean;
  serializeContract(contractId: string): string | null;
  /** Installed into AgentOrchestrator's tool dependencies and the core turn loop. */
  hooks(): ContractAgentHooks;
  on(listener: (event: ContractEvent) => void): () => void;
  dispose(): void;
}

/** `auto` isolation: a worktree when the root is a git repository with at least one commit, else the shared tree. */
export function resolveIsolation(setting: 'auto' | 'worktree' | 'shared', projectRoot: string): 'worktree' | 'shared' {
  if (setting !== 'auto') return setting;
  const head = spawnSync('git', ['-C', projectRoot, 'rev-parse', '--verify', '--quiet', 'HEAD'], { encoding: 'utf-8' });
  return head.status === 0 ? 'worktree' : 'shared';
}

function currentBranch(projectRoot: string): string {
  const head = spawnSync('git', ['-C', projectRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' });
  const branch = head.status === 0 ? head.stdout.trim() : '';
  return branch.length > 0 && branch !== 'HEAD' ? branch : 'main';
}

/** The count of distinct files the contract's units changed, as their checks recorded them. */
export function filesModified(contract: Pick<Contract, 'units'>): number {
  return new Set(contract.units.flatMap((unit) => unit.touchedPaths)).size;
}

export function createContractRunner(deps: ContractRunnerDeps): ContractRunner {
  const now = deps.now ?? Date.now;
  const listeners = new Set<(event: ContractEvent) => void>();
  const runs = new Map<string, ContractRun>();
  /** Contracts holding an active slot: admitted past the queue and not yet ended. */
  const admitted = new Set<string>();
  const queue: ContractRun[] = [];
  const pricing = { priceUsage: deps.priceUsage, priceProvenance: deps.priceProvenance };
  const getStatus = (agentId: string): AgentRecord | null => deps.agentManager.getStatus(agentId);
  let disposed = false;

  function emit(contract: Contract, event: ContractEvent): void {
    emitContractEvent(deps.runtimeBus, contract.sessionId, event);
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A listener cannot break the runner; the store and surfaces log their own faults.
      }
    }
  }

  function on(listener: (event: ContractEvent) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  const env: RunEnv = {
    now,
    config: () => readContractConfig(deps.configManager),
    emit,
    touchAgent: (agentId) => watchdog.touch(agentId),
  };

  deps.messageBus.registerAgent({ agentId: CONTRACT_RUNNER_AGENT_ID, role: 'orchestrator' });
  const detachStore = deps.store.attach(on);

  const settlement: ContractUnitSettlement = {
    settle(item, agentId, signal) {
      const run = item.contractId === undefined ? undefined : runs.get(item.contractId);
      const unit = item.contractUnitId === undefined ? undefined : run?.unit(item.contractUnitId);
      if (run === undefined || unit === undefined || run.terminal || signal.aborted) return Promise.resolve('cancelled');
      const runtime = run.runtime(unit);
      return new Promise<ContractUnitOutcome>((resolve) => {
        const entry = {
          agentId,
          resolve: (outcome: ContractUnitOutcome) => {
            signal.removeEventListener('abort', onAbort);
            resolve(outcome);
          },
        };
        function onAbort(): void {
          if (runtime.settlement === entry) runtime.settlement = null;
          resolve('cancelled');
        }
        signal.addEventListener('abort', onAbort, { once: true });
        runtime.settlement = entry;
      });
    },
  };

  function watched(): WatchedAgent[] {
    const agents: WatchedAgent[] = [];
    for (const run of runs.values()) {
      if (run.terminal) continue;
      for (const unit of run.allUnits()) {
        if (unit.activeAgentId === undefined || (unit.status !== 'running' && unit.status !== 'checking' && unit.status !== 'nudged')) continue;
        const status = getStatus(unit.activeAgentId)?.status;
        if (status !== 'running' && status !== 'pending') continue;
        agents.push({ contractId: run.id, unitId: unit.id, agentId: unit.activeAgentId, startedAt: run.runtime(unit).agentStartedAt });
      }
    }
    return agents;
  }

  const watchdog = createUnitWatchdog({
    runtimeBus: deps.runtimeBus,
    timeoutMs: () => env.config().heartbeatTimeoutMs,
    watched,
    onSilent: (agent, silentMs) => failures.onSilent(agent, silentMs),
    now,
  });

  const checks = createUnitCheckLoop({
    findRun: (contractId) => runs.get(contractId),
    agentManager: deps.agentManager,
    messageBus: deps.messageBus,
    configManager: deps.configManager,
    runtimeBus: deps.runtimeBus,
    watchdog,
    escalations: deps.steps,
    failContract: (run, kind, reason) => fail(run, kind, reason),
    unitPassed: (run, unit) => groups.unitPassed(run, unit),
    respawnUnit: (run, unit, reason, firstTurn) => groups.requeueUnit(run, unit, reason, 'resume', firstTurn),
  });

  const groups = createGroupRunner({
    createEngine: deps.createEngine,
    fleetCapacity: deps.fleetCapacity,
    routeSelector: deps.routeSelector,
    getStatus,
    watchdog,
    settlement,
    steps: deps.steps,
    pricing,
    failContract: (run, kind, reason) => fail(run, kind, reason),
    failUnit: (run, unit, kind, reason) => failures.failUnit(run, unit, kind, reason),
  });

  const failures = createUnitFailureHandling({
    runs: () => runs.values(),
    agentManager: deps.agentManager,
    runtimeBus: deps.runtimeBus,
    checks,
    failContract: (run, kind, reason) => fail(run, kind, reason),
    cancelContract: (run, reason) => cancelRun(run, reason),
    requeueUnit: (run, unit, reason, purpose, firstTurn) => groups.requeueUnit(run, unit, reason, purpose, firstTurn),
  });

  // ── The cap and queue (design 7.3) ──────────────────────────────────────────

  /** Takes a slot for the contract and starts it. */
  function admit(run: ContractRun): void {
    admitted.add(run.id);
    void activate(run);
  }

  function dequeue(): void {
    const cap = env.config().maxActiveContracts;
    while (queue.length > 0 && admitted.size < cap && !disposed) {
      const next = queue.shift()!;
      if (next.terminal) continue;
      next.decide('queued', next.id, 'a slot opened; starting');
      admit(next);
    }
  }

  // ── Starting ────────────────────────────────────────────────────────────────

  function ownerProgress(contract: Contract): string {
    return `Contract ${contract.id}: ${contract.status}`;
  }

  function start(input: StartContractInput): StartedContract {
    const config = env.config();
    const id = newContractId();
    const short = id.slice('ctr-'.length);
    const isolation = resolveIsolation(input.isolation ?? config.isolation, input.projectRoot);
    const owner = deps.agentManager.spawn(
      {
        mode: 'spawn',
        task: input.ask,
        template: 'orchestrator',
        outsideContract: true,
        ...(input.parentAgentId === undefined ? {} : { parentAgentId: input.parentAgentId }),
      },
      { contractId: id, contractRole: 'owner', progress: `Contract ${id}: queued` },
    );
    const contract: Contract = {
      id,
      schemaVersion: CURRENT_CONTRACT_SCHEMA_VERSION,
      sessionId: input.sessionId,
      origin: input.origin,
      ask: input.ask,
      ownerAgentId: owner.id,
      ...(input.parentAgentId === undefined ? {} : { parentAgentId: input.parentAgentId }),
      projectRoot: input.projectRoot,
      isolation,
      ...(isolation === 'worktree'
        ? { branch: `contract/${short}`, worktreePath: join(input.projectRoot, '.goodvibes', '.worktrees', 'contract', short), baseBranch: currentBranch(input.projectRoot) }
        : {}),
      ...(input.budget === undefined ? {} : { budget: input.budget }),
      goal: '',
      criteria: [],
      groups: [],
      units: [],
      status: 'queued',
      checks: [],
      fixRounds: 0,
      escalations: [],
      decisions: [],
      usage: emptyWorkItemUsage(),
      judgmentUsage: { calls: 0, inputTokens: 0, outputTokens: 0 },
      plannerAgentIds: [],
      createdAt: now(),
    };
    const run = new ContractRun(contract, env, {
      passGroup: (groupId) => groups.passGroup(run, groupId),
      finishPassed: (result) => finishPassed(run, result),
      fail: (kind, reason) => fail(run, kind, reason),
      cancel: (reason) => cancelRun(run, reason),
    }, input.proposedUnits);
    runs.set(id, run);
    deps.store.put(contract);
    run.decide('created', id, `origin ${input.origin}; ${isolation} isolation`);
    run.emit({ type: 'CONTRACT_CREATED', contractId: id, sessionId: input.sessionId, origin: input.origin, ask: input.ask, ownerAgentId: owner.id });
    if (admitted.size < config.maxActiveContracts) {
      admit(run);
    } else {
      queue.push(run);
      run.decide('queued', id, `${config.maxActiveContracts} contracts are active; waiting for a slot`);
    }
    return { contract: run.view(), owner };
  }

  function plannerDeps(run: ContractRun): ContractPlannerDeps {
    return {
      decompositionRunner: deps.decompositionRunner,
      routeSelector: deps.routeSelector,
      configManager: deps.configManager,
      emit: (event) => run.emit(event),
      ...(deps.repositoryMap === undefined ? {} : { repositoryMap: deps.repositoryMap }),
      now,
    };
  }

  /** Shapes and plans a contract, then runs its groups. */
  async function activate(run: ContractRun): Promise<void> {
    const { contract } = run;
    try {
      if (contract.isolation === 'worktree' && contract.worktreePath !== undefined && contract.branch !== undefined) {
        await new IsolatedWorktree(contract.projectRoot, contract.worktreePath, contract.branch, contract.baseBranch ?? 'main').create();
      }
      if (run.terminal) return;
      const shaped = await shapeContract(contract, plannerDeps(run), { signal: run.abort.signal });
      if (!proceed(run, shaped)) return;
      const planned = await planContract(contract, plannerDeps(run), { proposedUnits: run.proposedUnits, signal: run.abort.signal });
      if (!proceed(run, planned)) return;
      groups.startRun(run);
      updateOwnerProgress(run);
    } catch (error) {
      if (run.terminal) return;
      const failure = failureFromError(error);
      fail(run, failure.kind, `contract ${contract.id} could not start: ${failure.reason}`);
    }
  }

  /** Whether planning goes on after a shaping or planning outcome; settles the contract when it ended there. */
  function proceed(run: ContractRun, outcome: ShapeOutcome | PlanningOutcome): boolean {
    if (outcome.kind === 'shaped' || outcome.kind === 'accepted') return !run.terminal;
    if (outcome.kind === 'failed') settleEnded(run);
    if (outcome.kind === 'awaiting-owner') updateOwnerProgress(run);
    return false;
  }

  function updateOwnerProgress(run: ContractRun): void {
    const owner = getStatus(run.contract.ownerAgentId);
    if (owner !== null && owner.status === 'running') setAgentProgress(owner, ownerProgress(run.contract), 'operator');
  }

  // ── Ending ──────────────────────────────────────────────────────────────────

  /** Settles the owner record from the contract's terminal status and frees the slot. */
  function settleEnded(run: ContractRun): void {
    const { contract } = run;
    if (!isTerminalContractStatus(contract.status) || run.ownerSettled) return;
    run.ownerSettled = true;
    run.abort.abort();
    groups.stopRun(run);
    rollUpContractUsage(contract, getStatus, pricing);
    const owner = getStatus(contract.ownerAgentId);
    if (owner !== null) {
      const totals = ownerRecordUsage(contract, getStatus);
      owner.usage = totals.usage;
      owner.toolCallCount = totals.toolCallCount;
      owner.completedAt = now();
      const statusLine = contract.statusLine ?? `Contract ${contract.id} ${contract.status}${contract.error ? `: ${contract.error}` : ''}`;
      contract.statusLine = statusLine;
      setAgentProgress(owner, statusLine, 'operator');
      const ctx = { sessionId: contract.sessionId, traceId: `${contract.sessionId}:contract:${contract.id}:owner`, source: 'contract-runner', agentId: owner.id };
      const durationMs = Math.max(0, owner.completedAt - owner.startedAt);
      if (contract.status === 'passed') {
        owner.status = 'completed';
        owner.fullOutput = contract.answer ?? '';
        emitAgentCompleted(deps.runtimeBus, ctx, { agentId: owner.id, durationMs, output: owner.fullOutput, toolCallsMade: owner.toolCallCount, usage: owner.usage });
      } else if (contract.status === 'failed') {
        owner.status = 'failed';
        owner.error = contract.error ?? 'the contract failed';
        emitAgentFailed(deps.runtimeBus, ctx, { agentId: owner.id, durationMs, error: owner.error });
      } else {
        owner.status = 'cancelled';
        emitAgentCancelled(deps.runtimeBus, ctx, { agentId: owner.id, reason: contract.error ?? 'the contract was cancelled' });
      }
    }
    const index = queue.indexOf(run);
    if (index !== -1) queue.splice(index, 1);
    runs.delete(run.id);
    admitted.delete(run.id);
    dequeue();
  }

  function membersSettled(contract: Contract): boolean {
    return contractAgentIds(contract).every((agentId) => {
      const status = getStatus(agentId)?.status;
      return status === undefined || status === 'completed' || status === 'failed' || status === 'cancelled';
    });
  }

  function fail(run: ContractRun, kind: ContractFailureKind, reason: string): void {
    if (run.terminal) return;
    const { contract } = run;
    contract.failureKind = kind;
    contract.error = reason;
    contract.completedAt = now();
    run.moveContract('failed');
    run.endOpenUnits('cancelled', reason);
    run.abort.abort();
    groups.stopRun(run);
    contract.statusLine = `Contract ${contract.id} failed: ${reason}`;
    run.decide('failed', contract.id, reason);
    run.emit({ type: 'CONTRACT_FAILED', contractId: contract.id, reason, failureKind: kind, membersSettled: membersSettled(contract) });
    settleEnded(run);
  }

  function cancelRun(run: ContractRun, reason: string): boolean {
    if (run.terminal) return false;
    const { contract } = run;
    contract.error = reason;
    contract.completedAt = now();
    run.moveContract('cancelled');
    run.endOpenUnits('cancelled', reason);
    run.abort.abort();
    groups.stopRun(run);
    const count = filesModified(contract);
    const where = contract.isolation === 'worktree' && contract.branch !== undefined ? `on branch ${contract.branch}` : 'on disk';
    contract.statusLine = `Contract ${contract.id} cancelled; ${count} file${count === 1 ? '' : 's'} already modified ${where}`;
    run.decide('cancelled', contract.id, reason);
    run.emit({ type: 'CONTRACT_CANCELLED', contractId: contract.id, reason, filesModified: count });
    settleEnded(run);
    return true;
  }

  function finishPassed(run: ContractRun, result: { readonly answer: string; readonly statusLine: string }): void {
    if (run.terminal) return;
    const { contract } = run;
    const unmet = contract.units.filter((unit) => unit.status !== 'passed');
    if (unmet.length > 0) throw new Error(`contract ${contract.id} cannot pass while units ${unmet.map((unit) => unit.id).join(', ')} have not passed`);
    contract.answer = result.answer;
    contract.statusLine = result.statusLine;
    contract.completedAt = now();
    run.moveContract('passed');
    const judged = contract.criteria.filter((criterion) => criterion.disposition === 'judged');
    run.decide('passed', contract.id, result.statusLine);
    run.emit({
      type: 'CONTRACT_PASSED',
      contractId: contract.id,
      criteriaMet: judged.filter((criterion) => criterion.status === 'met').length,
      criteriaJudged: judged.length,
      excluded: contract.criteria.filter((criterion) => criterion.disposition === 'excluded').length,
      nudges: run.allUnits().reduce((total, unit) => total + unit.nudges.length, 0),
    });
    settleEnded(run);
  }

  // ── The API ─────────────────────────────────────────────────────────────────

  return {
    start,
    get: (contractId) => {
      const contract = deps.store.get(contractId);
      return contract === null ? null : structuredClone(contract);
    },
    list: (filter = {}) => deps.store.list()
      .filter((contract) => filter.sessionId === undefined || contract.sessionId === filter.sessionId)
      .filter((contract) => filter.includeTerminal === true || !isTerminalContractStatus(contract.status))
      .map((contract) => structuredClone(contract)),
    cancel: (contractId, reason) => {
      const run = runs.get(contractId);
      return run === undefined ? false : cancelRun(run, reason);
    },
    importContract: (snapshotJson, force = false) => deps.store.importContract(snapshotJson, force),
    serializeContract: (contractId) => deps.store.serialize(contractId),
    hooks: () => checks.hooks,
    on,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      watchdog.dispose();
      failures.dispose();
      for (const run of runs.values()) {
        run.abort.abort();
        run.unsubscribeEngine?.();
        run.engine?.dispose();
        for (const release of run.sharedTreeReleases.values()) release();
      }
      detachStore();
      listeners.clear();
    },
  };
}
