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
 * commit are the correction and completion steps (steps.ts). The owner's
 * replies to escalations arrive through `reply`.
 *
 * Session mode (design 6.6): when the user forbids delegation, the contract's
 * one unit is done by the session's own turns (the core turn loop binds its
 * turn to the unit and is held and nudged exactly as a sub-agent is); no
 * engine runs and no sub-agent is spawned.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ContractEvent } from '../../events/contract.js';
import type { AgentMessageBus } from '../agents/message-bus.js';
import { setAgentProgress } from '../agents/progress-audience.js';
import { IsolatedWorktree } from '../agents/worktree.js';
import type { DecompositionRunner } from '../core/plan-decomposition.js';
import type { OrchestrationEngine } from '../orchestration/engine.js';
import type { FleetCapacityFn } from '../orchestration/elastic-pool.js';
import type { ContractPreSpawn, ContractUnitOutcome, ContractUnitSettlement } from '../orchestration/phase-runner.js';
import { emptyWorkItemUsage, type PriceProvenanceFn } from '../orchestration/types.js';
import { emitAgentCancelled, emitAgentCompleted, emitAgentFailed } from '../runtime/emitters/index.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { AgentManager, AgentRecord } from '../tools/agent/index.js';
import { startContractOwner } from '../tools/agent/contract-binding.js';
import { delegationForbidden } from './batteries/request-shape.js';
import { createUnitCheckLoop, queueSessionNudge, type ContractSessionHooks } from './agent-hooks.js';
import { readContractConfig, type ContractConfigReader } from './config.js';
import { emitContractEvent } from './events.js';
import type { OwnerReplyOutcome } from './escalation.js';
import { createGroupRunner, takeBaseline, type ContractEngineInput } from './group-runner.js';
import { CONTRACT_RUNNER_AGENT_ID } from './nudge.js';
import { planContract, shapeContract, type ContractPlannerDeps, type PlanningOutcome, type ShapeOutcome } from './planner.js';
import { createContractPlanSync, type ExecutionPlans, type WorkPlanService } from './plan-sync.js';
import { createContractResume, type ResumeReport } from './resume.js';
import { numberDraft } from './draft-plan.js';
import { createContractFleetControls, type ContractFleetControls } from './fleet-controls.js';
import { ContractRun, failureFromError, type RunEnv } from './run-context.js';
import { createContractSteps, type ContractSteps } from './steps.js';
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
  type StartFromPlanInput,
} from './types.js';
import { createUnitFailureHandling } from './unit-failures.js';
import { contractAgentIds, ownerRecordUsage, rollUpContractUsage, type PriceUsageFn } from './usage.js';
import { createUnitWatchdog, type WatchedAgent } from './watchdog.js';

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
  /**
   * Individual correction and completion steps a host takes over (a surface
   * that answers attempt selections itself, a test); every other step is the
   * runner's own (steps.ts).
   */
  readonly steps?: Partial<ContractSteps> | undefined;
  /** The project work plan: each contract and unit as a task (design 6.5). Absent where the host has no project planning. */
  readonly workPlanService?: WorkPlanService | undefined;
  /** The execution plan: items a unit's agents worked on complete when the unit passes (design 6.5). */
  readonly planManager?: ExecutionPlans | undefined;
  /** The repository summary the planner starts from; defaults to the repo_map tool. */
  readonly repositoryMap?: ((projectRoot: string) => Promise<string>) | undefined;
  readonly now?: (() => number) | undefined;
}

export interface StartedContract {
  readonly contract: ContractView;
  /** The owner record parents wait on (design 6.5). */
  readonly owner: AgentRecord;
}

/** The session a contract gets when an agent spawn starts it with no conversation session (AgentManager's own event session). */
export const AGENT_MANAGER_SESSION_ID = 'agent-manager';

export interface ContractRunner {
  /** Starts a contract from an ask. Returns at once with the contract and its owner agent record. */
  start(input: StartContractInput): StartedContract;
  /**
   * Starts a contract from a plan drafted before it (a launched plan proposal
   * or workstream draft, design 10.4): the planner keeps the drafted units and
   * writes their criteria, and every plan check runs.
   */
  startFromPlan(input: StartFromPlanInput): StartedContract;
  /**
   * AgentManager.spawn's seam for a spawn that is not outside every contract
   * (design 10.3): the spawned record becomes the owner of a new contract whose
   * ask is its task. No executor runs for it.
   */
  startForOwner(ownerRecord: AgentRecord): StartedContract;
  get(contractId: string): ContractView | null;
  list(filter?: { readonly sessionId?: string | undefined; readonly includeTerminal?: boolean | undefined }): ContractView[];
  /** Stops a contract and everything it runs. False when it is unknown or already ended. */
  cancel(contractId: string, reason: string): boolean;
  /** An owner's free-text reply to an open escalation, read with the reply pattern (design 6.3). */
  reply(contractId: string, escalationId: string, text: string): Promise<OwnerReplyOutcome>;
  /**
   * At startup (design 7.2): every contract on disk that had not ended
   * resumes at the step it was on, or is reaped as a zombie when what it needs
   * to resume is gone. The active-contract cap applies.
   */
  resumeAll(): Promise<ResumeReport>;
  importContract(snapshotJson: string, force?: boolean): boolean;
  serializeContract(contractId: string): string | null;
  /** Installed into AgentOrchestrator's tool dependencies and the core turn loop. */
  hooks(): ContractSessionHooks;
  /** The fleet operator verbs' controller over every running contract's engine, with contract-qualified ids (design 8.3). */
  fleetControls(): ContractFleetControls;
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
  const planSync = createContractPlanSync({
    workPlanService: deps.workPlanService,
    planManager: deps.planManager,
    getContract: (contractId) => runs.get(contractId)?.contract ?? deps.store.get(contractId),
  });
  const detachPlanSync = on(planSync.onEvent);

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
    beforeSpawn(item, signal) {
      const run = item.contractId === undefined ? undefined : runs.get(item.contractId);
      const unit = item.contractUnitId === undefined ? undefined : run?.unit(item.contractUnitId);
      const cancelled: ContractPreSpawn = { kind: 'settled', outcome: 'cancelled' };
      if (run === undefined || unit === undefined || run.terminal || signal.aborted) return Promise.resolve(cancelled);
      const runtime = run.runtime(unit);
      const decided = runtime.preSpawn;
      if (decided === null) return Promise.resolve({ kind: 'spawn' });
      if (decided !== 'wait') {
        runtime.preSpawn = null;
        return Promise.resolve(decided);
      }
      // After a restart: the phase waits until a check, a respawn or the owner decides (design 7.2).
      return new Promise<ContractPreSpawn>((resolve) => {
        const entry = {
          resolve: (decision: ContractPreSpawn) => {
            signal.removeEventListener('abort', onAbort);
            resolve(decision);
          },
        };
        function onAbort(): void {
          if (runtime.spawnGate === entry) runtime.spawnGate = null;
          resolve(cancelled);
        }
        signal.addEventListener('abort', onAbort, { once: true });
        runtime.spawnGate = entry;
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

  const ownSteps = createContractSteps({
    agentManager: deps.agentManager,
    configManager: deps.configManager,
    runtimeBus: deps.runtimeBus,
    routeSelector: deps.routeSelector,
    decompositionRunner: deps.decompositionRunner,
    plannerDeps: (run) => plannerDeps(run),
    getStatus,
    groups: () => groups,
    checks: () => checks,
    continuePlanning: (run, outcome) => continuePlanning(run, outcome),
    ownerProgress: (run) => updateOwnerProgress(run),
  });
  const steps = { ...ownSteps, ...deps.steps };

  const checks = createUnitCheckLoop({
    findRun: (contractId) => runs.get(contractId),
    agentManager: deps.agentManager,
    messageBus: deps.messageBus,
    configManager: deps.configManager,
    runtimeBus: deps.runtimeBus,
    watchdog,
    escalations: steps,
    failContract: (run, kind, reason) => fail(run, kind, reason),
    unitPassed: (run, unit) => (run.contract.sessionMode === true ? sessionUnitPassed(run, unit) : groups.unitPassed(run, unit)),
    respawnUnit: (run, unit, reason, firstTurn) => {
      // Session mode has no agent to respawn: the nudge waits for the session's next turn.
      if (run.contract.sessionMode === true) queueSessionNudge(run, unit, firstTurn, unit.nudges.at(-1)?.id ?? '');
      else groups.requeueUnit(run, unit, reason, 'resume', firstTurn);
    },
    sessionUnit,
  });

  const groups = createGroupRunner({
    createEngine: deps.createEngine,
    fleetCapacity: deps.fleetCapacity,
    routeSelector: deps.routeSelector,
    getStatus,
    watchdog,
    settlement,
    steps,
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

  /** Takes a slot for the contract and starts it, or, for a resumed contract that waited, takes up its step. */
  function admit(run: ContractRun): void {
    admitted.add(run.id);
    void (run.contract.resumeFrom === undefined ? activate(run) : resume.continueResumed(run));
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
    const id = newContractId();
    return create(input, id, spawnOwner(input, id), {});
  }

  function startFromPlan(input: StartFromPlanInput): StartedContract {
    const { draft, ...rest } = input;
    const draftPlan = numberDraft(draft);
    const id = newContractId();
    return create(rest, id, spawnOwner(rest, id), { draftPlan });
  }

  function startForOwner(record: AgentRecord): StartedContract {
    if (record.contractId !== undefined) throw new Error(`agent ${record.id} already belongs to contract ${record.contractId}`);
    const id = newContractId();
    record.contractId = id;
    record.contractRole = 'owner';
    record.reviewMode = 'contract';
    startContractOwner(record, { contractId: id, contractRole: 'owner', progress: `Contract ${id}: queued` }, deps.runtimeBus);
    const input: StartContractInput = {
      ask: record.task,
      sessionId: AGENT_MANAGER_SESSION_ID,
      origin: 'agent-tool',
      projectRoot: record.workingDirectory ?? deps.projectRoot,
      ...(record.parentAgentId === undefined ? {} : { parentAgentId: record.parentAgentId }),
      ...(record.proposedUnits === undefined ? {} : { proposedUnits: record.proposedUnits }),
    };
    return create(input, id, record, {});
  }

  /** The owner record parents and surfaces wait on (design 6.5); it runs no executor. */
  function spawnOwner(input: Omit<StartContractInput, 'proposedUnits'>, id: string): AgentRecord {
    return deps.agentManager.spawn(
      {
        mode: 'spawn',
        task: input.ask,
        template: 'orchestrator',
        outsideContract: true,
        ...(input.parentAgentId === undefined ? {} : { parentAgentId: input.parentAgentId }),
      },
      { contractId: id, contractRole: 'owner', progress: `Contract ${id}: queued` },
    );
  }

  function create(
    input: Omit<StartContractInput, 'proposedUnits'> & Pick<StartContractInput, 'proposedUnits'>,
    id: string,
    owner: AgentRecord,
    extra: Pick<Contract, 'draftPlan'>,
  ): StartedContract {
    const config = env.config();
    const short = id.slice('ctr-'.length);
    const isolation = resolveIsolation(input.isolation ?? config.isolation, input.projectRoot);
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
      ...(input.proposedUnits === undefined ? {} : { proposedUnits: input.proposedUnits }),
      ...(extra.draftPlan === undefined ? {} : { draftPlan: extra.draftPlan }),
      createdAt: now(),
    };
    const run = newRun(contract);
    deps.store.put(contract);
    run.decide('created', id, `origin ${input.origin}; ${isolation} isolation${extra.draftPlan === undefined ? '' : `; ${extra.draftPlan.units.length} drafted units`}`);
    run.emit({ type: 'CONTRACT_CREATED', contractId: id, sessionId: input.sessionId, origin: input.origin, ask: input.ask, ownerAgentId: owner.id });
    if (admitted.size < config.maxActiveContracts) {
      admit(run);
    } else {
      queue.push(run);
      run.decide('queued', id, `${config.maxActiveContracts} contracts are active; waiting for a slot`);
    }
    return { contract: run.view(), owner };
  }

  /** A run of this runner for the contract, registered by id. */
  function newRun(contract: Contract): ContractRun {
    const run: ContractRun = new ContractRun(contract, env, {
      passGroup: (groupId) => groups.passGroup(run, groupId),
      finishPassed: (result) => finishPassed(run, result),
      fail: (kind, reason) => fail(run, kind, reason),
      cancel: (reason) => cancelRun(run, reason),
    }, contract.proposedUnits);
    runs.set(contract.id, run);
    return run;
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
      const shaped = await shapeContract(contract, plannerDeps(run), { signal: run.abort.signal });
      if (contract.shape !== undefined) settleSessionMode(run);
      if (!proceed(run, shaped)) return;
      const planned = await planContract(contract, plannerDeps(run), { proposedUnits: run.proposedUnits, signal: run.abort.signal });
      await continuePlanning(run, planned);
    } catch (error) {
      if (run.terminal) return;
      const failure = failureFromError(error);
      fail(run, failure.kind, `contract ${contract.id} could not start: ${failure.reason}`);
    }
  }

  /** Plans a shaped contract from the beginning (a restart stopped its planning), then runs the accepted plan. */
  async function replan(run: ContractRun): Promise<void> {
    try {
      const planned = await planContract(run.contract, plannerDeps(run), { proposedUnits: run.proposedUnits, signal: run.abort.signal });
      await continuePlanning(run, planned);
    } catch (error) {
      if (run.terminal) return;
      const failure = failureFromError(error);
      fail(run, failure.kind, `contract ${run.id} could not plan again: ${failure.reason}`);
    }
  }

  /**
   * The user forbade delegation (6.6): the session's own turns do the one
   * unit in the project's own tree, so the contract runs in shared mode with
   * no contract branch.
   */
  function settleSessionMode(run: ContractRun): void {
    const { contract } = run;
    if (contract.shape === undefined || !delegationForbidden(contract.shape) || contract.sessionMode === true) return;
    contract.sessionMode = true;
    contract.isolation = 'shared';
    contract.branch = undefined;
    contract.worktreePath = undefined;
    contract.baseBranch = undefined;
    run.decide('shaped', contract.id, 'session mode: the user does not allow delegating, so the session does the work and no sub-agent is spawned');
  }

  /** Whether planning goes on after a shaping or planning outcome; settles the contract when it ended there. */
  function proceed(run: ContractRun, outcome: ShapeOutcome | PlanningOutcome): boolean {
    if (outcome.kind === 'shaped' || outcome.kind === 'accepted') return !run.terminal;
    if (outcome.kind === 'failed') settleEnded(run);
    if (outcome.kind === 'awaiting-owner') updateOwnerProgress(run);
    return false;
  }

  /** After planning, or an owner reply that settled the shape or the plan: plan on, or start the accepted plan. */
  async function continuePlanning(run: ContractRun, outcome: ShapeOutcome | PlanningOutcome): Promise<void> {
    const { contract } = run;
    if (outcome.kind === 'shaped') {
      settleSessionMode(run);
      const planned = await planContract(contract, plannerDeps(run), { proposedUnits: run.proposedUnits, signal: run.abort.signal });
      await continuePlanning(run, planned);
      return;
    }
    if (!proceed(run, outcome)) return;
    if (contract.sessionMode === true) {
      startSession(run);
      updateOwnerProgress(run);
      return;
    }
    // A worktree made before a restart stopped planning is the contract's still.
    if (contract.isolation === 'worktree' && contract.worktreePath !== undefined && contract.branch !== undefined && !existsSync(contract.worktreePath)) {
      await new IsolatedWorktree(contract.projectRoot, contract.worktreePath, contract.branch, contract.baseBranch ?? 'main').create();
      if (run.terminal) return;
    }
    groups.startRun(run);
    updateOwnerProgress(run);
  }

  // ── Session mode (design 6.6) ───────────────────────────────────────────────

  /** A session-mode contract runs: its one unit waits for the session's next turn. */
  function startSession(run: ContractRun): void {
    const { contract } = run;
    contract.baseline ??= takeBaseline(contract.projectRoot);
    run.moveContract('running');
    for (const group of contract.groups) run.moveGroup(group, 'running');
    for (const unit of contract.units) run.moveUnit(unit, 'running');
    run.decide('spawned', contract.id, 'session mode: the session\'s next turn takes the work; no sub-agent is spawned');
  }

  /** The session-mode unit waiting for work in a session. */
  function sessionUnit(sessionId: string): { readonly run: ContractRun; readonly unit: ContractRun['contract']['units'][number] } | null {
    for (const run of runs.values()) {
      if (run.terminal || run.contract.sessionMode !== true || run.contract.sessionId !== sessionId) continue;
      const unit = run.contract.units.find((candidate) => candidate.status === 'running' || candidate.status === 'nudged');
      if (unit !== undefined) return { run, unit };
    }
    return null;
  }

  /** A session-mode unit passed: its group is judged, as a group whose units all passed. */
  function sessionUnitPassed(run: ContractRun, unit: ContractRun['contract']['units'][number]): void {
    const group = run.group(unit.groupId);
    if (group === undefined || group.status !== 'running' || run.settledGroups.has(group.id)) return;
    if (!run.contract.units.filter((candidate) => candidate.groupId === group.id).every((candidate) => candidate.status === 'passed')) return;
    run.settledGroups.add(group.id);
    void steps.groupUnitsPassed(run, group.id);
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

  /** Fails the contract. `settled` states the members settled (a zombie's agents did not survive the restart); otherwise it is read from their records. */
  function fail(run: ContractRun, kind: ContractFailureKind, reason: string, settled?: boolean): void {
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
    run.emit({ type: 'CONTRACT_FAILED', contractId: contract.id, reason, failureKind: kind, membersSettled: settled ?? membersSettled(contract) });
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

  // ── Resume (design 7.2) ─────────────────────────────────────────────────────

  const resume = createContractResume({
    store: deps.store,
    isLive: (contractId) => runs.has(contractId),
    adopt: (contract) => {
      deps.store.hold(contract);
      return newRun(contract);
    },
    hasSlot: () => admitted.size < env.config().maxActiveContracts,
    takeSlot: (run) => { admitted.add(run.id); },
    enqueue: (run) => { queue.push(run); },
    fail,
    groups,
    checks,
    steps,
    activate,
    plan: replan,
    sessionUnitPassed,
    ownerProgress: updateOwnerProgress,
  });

  const fleetControls = createContractFleetControls({
    runs: () => runs.values(),
    operatorPick: (run, unitId, attemptId) => steps.operatorPick(run, unitId, attemptId),
  });

  // ── The API ─────────────────────────────────────────────────────────────────

  return {
    start,
    startFromPlan,
    startForOwner,
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
    reply: async (contractId, escalationId, text) => {
      const run = runs.get(contractId);
      if (run === undefined || run.terminal) throw new Error(`contract ${contractId} is not running`);
      return steps.reply(run, escalationId, text);
    },
    resumeAll: () => resume.resumeAll(),
    importContract: (snapshotJson, force = false) => deps.store.importContract(snapshotJson, force),
    serializeContract: (contractId) => deps.store.serialize(contractId),
    hooks: () => checks.hooks,
    fleetControls: () => fleetControls,
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
      detachPlanSync();
      listeners.clear();
    },
  };
}
