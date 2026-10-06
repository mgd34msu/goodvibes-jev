import { pinContractInputAdmission } from './input-authority.js';
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
import { assertDurableCheckpoint, DurableContractAdmissions, DurableContractAdmissionError, durableKeyHash, durablePayloadRevision, freezeDurableRequest, parseDurableAdmission, type DurableContractAdmission, type DurableContractBoundary, type DurableContractKey, type DurableContractRequest, type DurableStartedContract } from './durable-admission.js';
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
import { captureContractInput, contractInputPath, materializeContractInput, assertContractInputView, assertContractExecutionView, prepareContractInputParent } from './input-snapshot.js';
import { planContract, shapeContract, type ContractPlannerDeps, type PlanningOutcome, type ShapeOutcome } from './planner.js';
import type { NativeContractDecisionHost, NativeContractServices } from './native-decisions.js';
import { bindNativeContractSource, captureNativeContractSource, nativeSourceCriteria } from './native-source.js';
import { createContractPlanSync, type ExecutionPlans, type WorkPlanService } from './plan-sync.js';
import { createContractResume, findZombieCause, type ResumeReport } from './resume.js';
import { numberDraft } from './draft-plan.js';
import { createContractFleetControls, type ContractFleetControls } from './fleet-controls.js';
import { ContractRun, failureFromError, type RunEnv } from './run-context.js';
import { createContractSteps, type ContractSteps, type ContractStepsWithReplies } from './steps.js';
import { deserializeContract, serializeContract, type ContractStore } from './store.js';
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
import { logger } from '../utils/logger.js';
import { nativeContractActionSource, nativeContractPort } from './native-decisions.js';
import type { DurableContractExecution } from './durable-admission.js';

export interface ContractRunnerDeps {
  readonly nativeDecisions?: NativeContractDecisionHost | undefined;
  /** Host ledger synchronization and live deterministic validation for native-bound launches. */
  readonly durableAdmission?: DurableContractBoundary | undefined;
  readonly agentManager: Pick<AgentManager, 'spawn' | 'getStatus' | 'list' | 'cancel' | 'wakeWithSteer'> & Partial<Pick<AgentManager, 'join'>>;
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
  readonly readAccessFilter?: import('../tools/shared/read-access.js').ReadAccessFilter | undefined;
  readonly repositoryMap?: ((projectRoot: string) => Promise<string>) | undefined;
  readonly now?: (() => number) | undefined;
}

export interface StartedContract {
  /** Actual admitted work and cleanup, independent of terminal record status. */
  readonly settled?: Promise<void> | undefined;
  readonly contract: ContractView;
  /** The owner record parents wait on (design 6.5). */
  readonly owner: AgentRecord;
}

/** An owned start certifies real drainage and captures cancellation by contract id. */
export interface OwnedStartedContract extends StartedContract {
  readonly settled: Promise<void>;
  cancel(reason: string): boolean;
}

/** The session a contract gets when an agent spawn starts it with no conversation session (AgentManager's own event session). */
export const AGENT_MANAGER_SESSION_ID = 'agent-manager';

export interface ContractRunner {
  /** Source-less legacy entry points/records must not activate approval fallback in a native owner. */
  readonly nativeMode?: boolean;
  /** Atomically bind a native attempt to one durable runner record. Exact replay never starts another execution. */
  startDurable(request: DurableContractRequest): Promise<DurableStartedContract>;
  /** Explicit restart of the same record, after fresh validation; never mint a second native attempt. */
  resumeDurable(key: DurableContractKey): Promise<DurableStartedContract>;
  /** Read-only durable receipt/checkpoint inspection; never loads execution or invokes admission. */
  inspectDurable?(key: DurableContractKey): DurableStartedContract | null;
  /** Non-executing drainage confirmation; a live foreign execution lease fails closed. */
  joinDurable?(key: DurableContractKey): Promise<void>;
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
  /** Checks owned-start prerequisites before AgentManager admits an owner record. */
  assertOwnedExecution(): void;
  /** Explicit capability for a scoped spawn; legacy custom runners may omit it. */
  startOwnedForOwner(ownerRecord: AgentRecord): OwnedStartedContract;
  /** Waits for the actual work admitted by this contract, after it ends. */
  join(contractId: string): Promise<void>;
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
  if (setting !== 'auto' && setting !== 'worktree' && setting !== 'shared') throw new Error('Invalid contract isolation');
  if (setting !== 'auto') return setting;
  const head = spawnSync('git', ['-C', projectRoot, 'rev-parse', '--verify', '--quiet', 'HEAD'], { encoding: 'utf-8' });
  return head.status === 0 ? 'worktree' : 'shared';
}

/**
 * What the contract branch is measured and merged against: the branch checked
 * out in the project root, or, on a detached HEAD, the commit HEAD names (a
 * branch name the root is not on would measure the work against the wrong
 * history, or against nothing).
 */
export function currentBase(projectRoot: string): string {
  const head = spawnSync('git', ['-C', projectRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' });
  const branch = head.status === 0 ? head.stdout.trim() : '';
  if (branch.length > 0 && branch !== 'HEAD') return branch;
  const commit = spawnSync('git', ['-C', projectRoot, 'rev-parse', 'HEAD'], { encoding: 'utf-8' });
  const hash = commit.status === 0 ? commit.stdout.trim() : '';
  if (hash.length === 0) throw new Error(`cannot read HEAD in ${projectRoot}: ${(commit.stderr ?? '').trim()}`);
  return hash;
}

/** The count of distinct files the contract's units changed, as their checks recorded them. */
export function filesModified(contract: Pick<Contract, 'units'>): number {
  return new Set(contract.units.flatMap((unit) => unit.touchedPaths)).size;
}

export function createContractRunner(deps: ContractRunnerDeps): ContractRunner {
  const now = deps.now ?? Date.now;
  const durableAdmissions = new DurableContractAdmissions(deps.store.projectRoot);
  const durableLeases = new Map<string, () => void>();
  const listeners = new Set<(event: ContractEvent) => void>();
  const runs = new Map<string, ContractRun>();
  const settlements = new Map<string, { readonly promise: Promise<void>; readonly resolve: () => void }>();
  const settling = new Set<string>();

  function reserveSettlement(contractId: string) {
    let entry = settlements.get(contractId);
    if (!entry) {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      entry = { promise, resolve };
      settlements.set(contractId, entry);
    }
    return entry;
  }

  // Separate from outward terminal events: an abort/status is never a join.
  function settleWork(run: ContractRun): void {
    if (settling.has(run.id)) return;
    settling.add(run.id);
    const entry = reserveSettlement(run.id);
    void (async () => {
      await run.work.join();
      await run.engine?.join?.();
      // Planning can publish its agent id while unwinding after cancellation.
      // Engine phases independently join unit executors before their cleanup.
      await Promise.all(contractAgentIds(run.contract).map((id) => deps.agentManager.join?.(id)));
      for (const release of run.sharedTreeReleases.values()) release();
      run.sharedTreeReleases.clear();
      durableLeases.get(run.id)?.();
      durableLeases.delete(run.id);
      entry.resolve();
      settlements.delete(run.id);
      settling.delete(run.id);
    })().catch((error: unknown) => {
      // A failed join cannot certify settlement. Retain the pending barrier.
      logger.warn('contract settlement could not be established', { contractId: run.id, error });
    });
  }
  /** Contracts holding an active slot: admitted past the queue and not yet ended. */
  const admitted = new Set<string>();
  const queue: ContractRun[] = [];
  const pricing = { priceUsage: deps.priceUsage, priceProvenance: deps.priceProvenance };
  const getStatus = (agentId: string): AgentRecord | null => deps.agentManager.getStatus(agentId);
  let disposed = false;

  function emit(contract: Contract, event: ContractEvent): void {
    const occurrence = emitContractEvent(deps.runtimeBus, contract.sessionId, event);
    for (const listener of listeners) {
      try {
        listener(occurrence);
      } catch {
        // A listener cannot break the runner; the store and surfaces log their own faults.
      }
    }
  }

  function on(listener: (event: ContractEvent) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  const native: NativeContractServices | undefined = deps.nativeDecisions === undefined ? undefined : { host: deps.nativeDecisions, changed: contract => { deps.store.put(contract); }, checkpoint: contract => { deps.store.put(contract); if (!deps.store.write(contract.id)) throw new Error('Native semantic checkpoint failed'); }, cancel: (contract, reason) => { const run = runs.get(contract.id); if (run !== undefined) cancelRun(run, reason); } };
  const env: RunEnv = {
    native,
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
    autonomousPort(item) {
      const run = item.contractId === undefined ? undefined : runs.get(item.contractId);
      return run?.contract.nativeSource === undefined ? undefined : port => nativeContractPort(run.contract, native, port, run.abort.signal);
    },
    autonomousSource(item) {
      const run = item.contractId === undefined ? undefined : runs.get(item.contractId);
      if (run === undefined || run.contract.nativeSource === undefined) return undefined;
      return nativeContractActionSource(run.contract, native, run.abort.signal);
    },
    withCurrentExecution(item, execute) {
      const run = item.contractId === undefined ? undefined : runs.get(item.contractId);
      if (run === undefined || run.terminal || run.abort.signal.aborted) return Promise.reject(new DurableContractAdmissionError('boundary'));
      if (run.contract.durableAdmission === undefined) return execute();
      return withCurrentDurableExecution(run, execute).catch((error: unknown) => {
        cancelRun(run, 'native execution binding is no longer current');
        throw error;
      });
    },
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
    native,
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
  const untrackedSteps = { ...ownSteps, ...deps.steps };
  // Every step, including host overrides, runs under the contract's real
  // lifetime. Reserve before calling it: steps can end the contract inline.
  const steps = Object.fromEntries(Object.entries(untrackedSteps).map(([key, step]) => [
    key,
    (run: ContractRun, ...args: unknown[]) => run.work.run(() =>
      ((run.contract.nativeSource === undefined ? step : ownSteps[key as keyof typeof ownSteps]) as (run: ContractRun, ...args: unknown[]) => Promise<unknown>)(run, ...args)),
  ])) as unknown as ContractStepsWithReplies;

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
    if (run.terminal || disposed) return;
    admitted.add(run.id);
    if (run.contract.durableAdmission !== undefined) {
      void launchDurable(run).catch(() => cancelRun(run, 'native admission is no longer current'));
    } else void run.work.run(() => run.contract.resumeFrom === undefined ? activate(run) : resume.continueResumed(run));
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

  function resolveExecution(input: StartContractInput, id: string): DurableContractExecution {
    const isolation = resolveIsolation(input.isolation ?? env.config().isolation, input.projectRoot);
    const short = id.slice('ctr-'.length);
    return isolation === 'shared' ? { isolation } : { isolation,
      branch: `contract/${short}`, worktreePath: join(input.projectRoot, '.goodvibes', '.worktrees', 'contract', short), baseBranch: currentBase(input.projectRoot) };
  }

  function captureStartInput(input: StartContractInput): StartContractInput {
    if (input.nativeSource === undefined && deps.nativeDecisions !== undefined) throw new Error('Native admission requires the complete original source snapshot');
    if (input.nativeSource !== undefined && deps.nativeDecisions === undefined) throw new Error('Native contract requires its authenticated semantic owner');
    return input.nativeSource === undefined ? input : { ...input, nativeSource: captureNativeContractSource(input.nativeSource) };
  }

  function durableResult(admission: DurableContractAdmission): DurableStartedContract {
    const contract = runs.get(admission.contractId)?.contract ?? deserializeContract(durableAdmissions.checkpoint(admission.key));
    if (contract === null || contract.durableAdmission?.payloadRevision !== admission.payloadRevision
      || contract.ownerAgentId !== admission.ownerAgentId) throw new DurableContractAdmissionError('checkpoint');
    assertDurableCheckpoint(contract, admission);
    const { input: _input, ...receipt } = admission;
    return { admission: Object.freeze(receipt), contract: structuredClone(contract), state: isTerminalContractStatus(contract.status)
      ? 'terminal' : contract.durableLaunchState ?? 'prepared' };
  }

  async function withCurrentDurableExecution(run: ContractRun, execute: () => Promise<void>, claimLaunch = false): Promise<void> {
    const admission = run.contract.durableAdmission;
    const boundary = deps.durableAdmission;
    if (admission === undefined || boundary === undefined) throw new DurableContractAdmissionError('boundary');
    let open = true;
    let invoked = false;
    let execution: Promise<void> | undefined;
    let boundaryFailed = false;
    let boundaryError: unknown;
    try {
      const boundaryResult = boundary.withCurrent(admission, (assertCurrent) => {
        if (!open || invoked || typeof assertCurrent !== 'function') throw new DurableContractAdmissionError('boundary');
        invoked = true;
        if (disposed || run.terminal || run.abort.signal.aborted) throw new DurableContractAdmissionError('boundary');
        if (claimLaunch) {
          run.contract.durableLaunchState = 'launch-claimed';
          if (!deps.store.write(run.id)) throw new DurableContractAdmissionError('checkpoint');
        }
        // Every borrowed/reentrant hook, including persistence and AgentManager's spawning events,
        // precedes this synchronous check. The host holds its ledger lock through invocation.
        assertDurableCheckpoint(run.contract, admission);
        const validity: unknown = assertCurrent();
        if (validity !== undefined) {
          void Promise.resolve(validity).catch(() => undefined);
          throw new DurableContractAdmissionError('boundary');
        }
        assertDurableCheckpoint(run.contract, admission);
        if (disposed || run.terminal || run.abort.signal.aborted) throw new DurableContractAdmissionError('boundary');
        execution = execute();
        // Observe rejection immediately even when the host's lock-release promise is still pending.
        void execution.catch(() => undefined);
      });
      if (boundaryResult === undefined) open = false;
      await boundaryResult;
      if (!invoked) throw new DurableContractAdmissionError('boundary');
    } catch (error) {
      boundaryFailed = true;
      boundaryError = error;
      cancelRun(run, 'native admission boundary failed');
    } finally { open = false; }
    if (boundaryFailed) {
      // Launch may already have entered an executor. Failed lock release/commit is not drainage.
      try { await execution; } catch { /* Preserve the boundary failure after actual executor cleanup. */ }
      throw boundaryError;
    }
    // Do not hold the ledger lock for an executor's entire lifetime.
    await execution;
  }

  function launchDurable(run: ContractRun): Promise<void> {
    return withCurrentDurableExecution(run, () => {
      void run.work.run(() => run.contract.resumeFrom === undefined ? activate(run) : resume.continueResumed(run));
      return Promise.resolve();
    }, true);
  }

  async function startDurable(request: DurableContractRequest): Promise<DurableStartedContract> {
    const frozen = freezeDurableRequest({ ...request, input: captureStartInput(request.input) });
    assertOwnedExecution();
    if (disposed) throw new Error('Contract runner is disposed');
    if (deps.durableAdmission === undefined) throw new DurableContractAdmissionError('boundary');
    // An immutable binding is already committed before the host boundary runs. Exact delivery
    // replay must remain readable even while that boundary waits for its ledger transaction.
    const committed = durableAdmissions.read(frozen.key);
    if (committed !== null) {
      if (committed.payloadRevision !== durablePayloadRevision(frozen)) throw new DurableContractAdmissionError('conflict');
      return durableResult(committed);
    }
    const release = await durableAdmissions.lock(frozen.key);
    try {
      if (disposed) throw new Error('Contract runner is disposed');
      const existing = durableAdmissions.read(frozen.key);
      if (existing !== null) {
        if (existing.payloadRevision !== durablePayloadRevision(frozen)) throw new DurableContractAdmissionError('conflict');
        return durableResult(existing);
      }
      // Never mint another binding if a compatibility checkpoint proves the receipt went missing.
      for (const storedId of deps.store.listStoredIds()) {
        const stored = deps.store.load(storedId);
        if (stored?.durableAdmission !== undefined && durableKeyHash(stored.durableAdmission.key) === durableKeyHash(frozen.key)) {
          throw new DurableContractAdmissionError('checkpoint');
        }
      }
      const lease = await durableAdmissions.lease(frozen.key);
      const id = newContractId();
      durableLeases.set(id, lease);
      try {
        const execution = resolveExecution(frozen.input, id);
        const owner = spawnOwner(frozen.input, id);
        const admission = parseDurableAdmission({ ...frozen, schemaVersion: 2, execution, contractId: id,
          ownerAgentId: owner.id, payloadRevision: durablePayloadRevision(frozen) });
        create(frozen.input, id, owner, { durableAdmission: admission }, true, true);
        const run = runs.get(id);
        if (run !== undefined && !run.terminal && !disposed) {
          if (admitted.size < env.config().maxActiveContracts) {
            admitted.add(id);
            try { await launchDurable(run); }
            catch (error) { cancelRun(run, 'native admission launch was not validated'); throw error; }
          } else {
            queue.push(run);
            run.decide('queued', id, 'waiting for an active-contract slot');
          }
        }
        return durableResult(admission);
      } catch (error) {
        const run = runs.get(id);
        if (run !== undefined) cancelRun(run, 'native admission could not start');
        else if (!settling.has(id)) { durableLeases.delete(id); lease(); }
        throw error;
      }
    } finally { release(); }
  }

  async function resumeDurable(key: DurableContractKey): Promise<DurableStartedContract> {
    assertOwnedExecution();
    if (disposed) throw new Error('Contract runner is disposed');
    if (deps.durableAdmission === undefined) throw new DurableContractAdmissionError('boundary');
    // Detach the key before lock acquisition can yield to caller code.
    const frozenKey = Object.freeze({ ...key });
    const release = await durableAdmissions.lock(frozenKey);
    try {
      if (disposed) throw new Error('Contract runner is disposed');
      const admission = durableAdmissions.read(frozenKey);
      if (admission === null) throw new DurableContractAdmissionError('missing');
      captureStartInput(admission.input);
      const result = durableResult(admission);
      if (runs.has(admission.contractId) || result.state === 'terminal') return result;
      // Old receipts remain inspectable/replayable, but their mutable checkpoint is
      // not evidence of the isolation/configuration originally selected at admission.
      if (admission.execution === undefined) throw new DurableContractAdmissionError('checkpoint');
      const lease = await durableAdmissions.lease(frozenKey);
      durableLeases.set(admission.contractId, lease);
      const contract = deserializeContract(durableAdmissions.checkpoint(admission.key));
      if (contract === null) { durableLeases.delete(admission.contractId); lease(); throw new DurableContractAdmissionError('checkpoint'); }
      try { assertDurableCheckpoint(contract, admission); }
      catch (error) { durableLeases.delete(admission.contractId); lease(); throw error; }
      deps.store.hold(contract);
      const run = newRun(contract);
      run.requireSettlement = true;
      resume.prepareNative(run);
      const zombie = findZombieCause(contract);
      if (zombie !== null) { fail(run, 'zombie', 'native contract checkpoint cannot resume', true); return durableResult(admission); }
      // Preserve the restart step even while queued. The persisted native binding never grants launch.
      contract.resumeFrom = contract.resumeFrom ?? contract.status;
      if (admitted.size < env.config().maxActiveContracts) {
        admitted.add(run.id);
        try { await launchDurable(run); }
        catch (error) { cancelRun(run, 'native admission resume was not validated'); throw error; }
      } else {
        if (contract.status !== 'queued') run.moveContract('queued');
        queue.push(run);
        run.decide('queued', run.id, 'waiting to resume a native contract');
      }
      return durableResult(admission);
    } finally { release(); }
  }

  function start(input: StartContractInput): StartedContract {
    if (disposed) throw new Error('Contract runner is disposed');
    const captured = captureStartInput(input);
    const id = newContractId();
    return create(captured, id, spawnOwner(captured, id), {});
  }

  function startFromPlan(input: StartFromPlanInput): StartedContract {
    if (disposed) throw new Error('Contract runner is disposed');
    const { draft, ...rest } = { ...input, ...captureStartInput(input) };
    const draftPlan = numberDraft(draft);
    const id = newContractId();
    return create(rest, id, spawnOwner(rest, id), { draftPlan });
  }

  function startForOwner(record: AgentRecord, requireSettlement = false): StartedContract {
    if (deps.nativeDecisions !== undefined) throw new Error('Native agent starts require source-bearing host admission');
    if (disposed) throw new Error('Contract runner is disposed');
    if (record.contractId !== undefined) throw new Error(`agent ${record.id} already belongs to contract ${record.contractId}`);
    const id = newContractId();
    record.contractId = id;
    record.contractRole = 'owner';
    record.reviewMode = 'contract';
    startContractOwner(record, { contractId: id, contractRole: 'owner', progress: `Contract ${id}: queued`, settled: reserveSettlement(id).promise }, deps.runtimeBus);
    const input: StartContractInput = {
      ask: record.task,
      sessionId: AGENT_MANAGER_SESSION_ID,
      origin: 'agent-tool',
      projectRoot: record.workingDirectory ?? deps.projectRoot,
      ...(record.parentAgentId === undefined ? {} : { parentAgentId: record.parentAgentId }),
      ...(record.proposedUnits === undefined ? {} : { proposedUnits: record.proposedUnits }),
    };
    return create(input, id, record, {}, requireSettlement);
  }

  function assertOwnedExecution(): void {
    if (disposed) throw new Error('Contract runner is disposed');
    if (typeof deps.agentManager.join !== 'function') throw new Error('Owned contract requires agent execution settlement');
  }

  function startOwnedForOwner(record: AgentRecord): OwnedStartedContract {
    assertOwnedExecution();
    const started = startForOwner(record, true);
    return {
      ...started,
      settled: started.settled!,
      cancel: (reason) => {
        const run = runs.get(started.contract.id);
        return run === undefined ? false : cancelRun(run, reason);
      },
    };
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
      { contractId: id, contractRole: 'owner', progress: `Contract ${id}: queued`, settled: reserveSettlement(id).promise },
    );
  }

  function create(
    input: Omit<StartContractInput, 'proposedUnits'> & Pick<StartContractInput, 'proposedUnits'>,
    id: string,
    owner: AgentRecord,
    extra: Pick<Contract, 'draftPlan' | 'durableAdmission'>,
    requireSettlement = false,
    deferAdmission = false,
  ): StartedContract {
    const config = env.config();
    const execution = extra.durableAdmission?.execution ?? resolveExecution(input, id);
    const isolation = execution.isolation;
    const contract: Contract = {
      id,
      ...(extra.durableAdmission === undefined ? {} : { durableAdmission: extra.durableAdmission, durableLaunchState: 'prepared' as const }),
      schemaVersion: CURRENT_CONTRACT_SCHEMA_VERSION,
      sessionId: input.sessionId,
      origin: input.origin,
      ask: input.ask,
      ownerAgentId: owner.id,
      ...(input.parentAgentId === undefined ? {} : { parentAgentId: input.parentAgentId }),
      projectRoot: input.projectRoot,
      ...execution,
      ...(input.budget === undefined ? {} : { budget: input.budget }),
      ...(input.nativeSource === undefined ? {} : { nativeSource: input.nativeSource }),
      goal: input.nativeSource?.goal ?? '',
      criteria: input.nativeSource === undefined ? [] : nativeSourceCriteria(input.nativeSource),
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
    bindNativeContractSource(contract);
    const run = newRun(contract);
    run.requireSettlement = requireSettlement;
    deps.store.put(contract);
    if (contract.durableAdmission !== undefined) {
      const checkpoint = serializeContract(contract, now());
      if (checkpoint === null) throw new DurableContractAdmissionError('checkpoint');
      durableAdmissions.write(contract.durableAdmission, checkpoint);
      if (!deps.store.write(id)) throw new DurableContractAdmissionError('checkpoint');
    }
    run.decide('created', id, `origin ${input.origin}; ${isolation} isolation${extra.draftPlan === undefined ? '' : `; ${extra.draftPlan.units.length} drafted units`}`);
    run.emit({ type: 'CONTRACT_CREATED', contractId: id, sessionId: input.sessionId, origin: input.origin, ask: input.ask, ownerAgentId: owner.id });
    if (owner.status === 'cancelled') cancelRun(run, 'the owner was cancelled during spawn');
    if (run.terminal || deferAdmission) {
      // Re-entrant creation/spawn listeners can stop the owner before admission.
    } else if (admitted.size < config.maxActiveContracts) {
      admit(run);
    } else {
      queue.push(run);
      run.decide('queued', id, `${config.maxActiveContracts} contracts are active; waiting for a slot`);
    }
    return { contract: run.view(), owner, settled: reserveSettlement(id).promise };
  }

  /** A run of this runner for the contract, registered by id. */
  function newRun(contract: Contract): ContractRun {
    const run: ContractRun = new ContractRun(contract, env, {
      passGroup: (groupId) => groups.passGroup(run, groupId),
      finishPassed: (result) => finishPassed(run, result),
      fail: (kind, reason) => fail(run, kind, reason),
      cancel: (reason) => cancelRun(run, reason),
    }, contract.proposedUnits);
    reserveSettlement(contract.id);
    runs.set(contract.id, run);
    return run;
  }

  function plannerDeps(run: ContractRun): ContractPlannerDeps {
    return {
      native,
      decompositionRunner: deps.decompositionRunner,
      routeSelector: deps.routeSelector,
      configManager: deps.configManager,
      emit: (event) => run.emit(event),
      ...(deps.repositoryMap === undefined ? {} : { repositoryMap: deps.repositoryMap }),
      readAccessFilter: deps.readAccessFilter,
      now,
    };
  }

  /** Admit one local generation before shaping, repository mapping or planner execution. */
  async function prepareInput(run: ContractRun): Promise<void> {
    const { contract } = run;
    if (contract.inputSnapshot !== undefined) {
      pinContractInputAdmission(contract, run.abort.signal);
      await assertContractInputView(contract.inputSnapshot, run.abort.signal);
      if (contract.isolation === 'worktree') assertContractExecutionView(contract.inputSnapshot, contract.worktreePath!, contract.branch!);
      return;
    }
    if (contract.isolation !== 'worktree') return;
    if (contract.schemaVersion < 2) throw new Error('legacy worktree contract has no recorded input receipt; manual recovery is required');
    const snapshot = await captureContractInput(contract.projectRoot, { signal: run.abort.signal });
    contract.inputSnapshot = snapshot;
    pinContractInputAdmission(contract, run.abort.signal);
    // Persist provenance before any workspace/model admission. Partial creation is retained and holds recovery.
    if (!deps.store.write(contract.id)) throw new Error('contract input receipt could not be persisted');
    run.abort.signal.throwIfAborted();
    const inputPath = contractInputPath(snapshot);
    await prepareContractInputParent(snapshot, inputPath);
    await prepareContractInputParent(snapshot, contract.worktreePath!);
    await new IsolatedWorktree(contract.projectRoot, inputPath, `contract-input/${snapshot.id}`, contract.baseBranch ?? 'main').create(snapshot.inputCommit, false);
    await materializeContractInput(snapshot, inputPath, run.abort.signal);
    run.abort.signal.throwIfAborted();
    await new IsolatedWorktree(contract.projectRoot, contract.worktreePath!, contract.branch!, contract.baseBranch ?? 'main').create(snapshot.inputCommit, false);
    await materializeContractInput(snapshot, contract.worktreePath!, run.abort.signal);
    run.decide('created', contract.id, `admitted local input generation ${snapshot.id}; captured ${snapshot.files.length} paths`);
  }

  /** Shapes and plans a contract, then runs its groups. */
  async function activate(run: ContractRun): Promise<void> {
    const { contract } = run;
    try {
      await prepareInput(run);
      if (run.terminal) return;
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
      await prepareInput(run);
      if (run.terminal) return;
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
    if (outcome.kind === 'cancelled' && run.contract.nativeSource !== undefined && !run.terminal) cancelRun(run, 'Native judgment was cancelled or superseded');
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
    if (contract.isolation === 'worktree' && (contract.inputSnapshot === undefined || contract.worktreePath === undefined || !existsSync(contract.worktreePath))) throw new Error('contract input workspace is missing; automatic recapture is not allowed');
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
    if (run.contract.nativeSource !== undefined) {
      if (run.contract.nativeProgress?.state !== 'refused') run.contract.nativeProgress = undefined;
      run.contract.nativeWaiting = undefined;
      for (const key of Object.keys(run.contract.nativeDecisions?.pending ?? {})) delete run.contract.nativeDecisions!.pending[key];
    }
    const { contract } = run;
    if (!isTerminalContractStatus(contract.status) || run.ownerSettled) return;
    run.ownerSettled = true;
    // A terminal native checkpoint must be durable before its execution lease can be released.
    if (!disposed && contract.durableAdmission !== undefined && !deps.store.write(run.id)) {
      logger.error('native contract terminal checkpoint failed; retaining execution lease', { contractId: run.id });
      // Do not make another runner eligible to resume an unpersisted cancellation.
      durableLeases.delete(run.id);
    }
    settleWork(run);
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
    nativeOnly: deps.nativeDecisions !== undefined,
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
    activate: (run) => run.work.run(() => activate(run)),
    plan: (run) => run.work.run(() => replan(run)),
    sessionUnitPassed,
    ownerProgress: updateOwnerProgress,
  });

  const fleetControls = createContractFleetControls({
    runs: () => runs.values(),
    operatorPick: (run, unitId, attemptId) => steps.operatorPick(run, unitId, attemptId),
  });

  // ── The API ─────────────────────────────────────────────────────────────────

  return {
    nativeMode: deps.nativeDecisions !== undefined,
    startDurable,
    resumeDurable,
    start,
    startFromPlan,
    startForOwner,
    startOwnedForOwner,
    assertOwnedExecution,
    inspectDurable(key) { const admission = durableAdmissions.read(key); return admission === null ? null : durableResult(admission); },
    async joinDurable(key) {
      const admission = durableAdmissions.read(key); if (!admission) throw new DurableContractAdmissionError('missing');
      await (settlements.get(admission.contractId)?.promise ?? Promise.resolve());
      // No status bit certifies drainage while another process still owns effects.
      const release = await durableAdmissions.lease(key);
      try { if (!isTerminalContractStatus(durableResult(admission).contract.status)) throw new DurableContractAdmissionError('checkpoint'); }
      finally { release(); }
    },
    join: (contractId) => settlements.get(contractId)?.promise ?? Promise.resolve(),
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
      if (run.contract.nativeSource !== undefined) throw new Error('Native contracts do not accept owner approval replies');
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
      // Disposal preserves a restart checkpoint; explicit cancel persists a
      // terminal outcome instead. Flush and detach writers before in-memory
      // cancellation can publish failed item states or late cleanup events.
      detachStore();
      detachPlanSync();
      for (const run of runs.values()) {
        run.unsubscribeEngine?.();
        run.unsubscribeEngine = null;
        run.engine?.dispose();
        run.abort.abort();
        for (const unit of run.allUnits()) {
          run.unitRuntimes.get(unit.id)?.abort.abort();
          run.releaseHold(unit);
        }
        groups.stopRun(run);
        settleWork(run);
      }
      listeners.clear();
    },
  };
}
