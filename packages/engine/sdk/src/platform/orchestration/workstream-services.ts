// ---------------------------------------------------------------------------
// workstream-services.ts, one OrchestrationEngine instance, plus the
// command-facing facade a surface drives it through.
//
// Why a facade and not the bare engine: createOrchestrationEngine() is a pure
// construction call with no auto-start and NO concept of a not-yet-launched
// "proposal" a human can review and edit before anything is spent, its only
// creation entry point, createWorkstream(), immediately materializes a real,
// ticking-eligible Workstream. A surface's workstream command needs a
// create -> propose -> approve -> launch flow: render the plan before spending
// anything, the same shape a plan approval step has.
//
// Launching an approved draft starts a contract
// (docs/design/contract-runner.md 10.4): a multi-item draft through
// `runner.startFromPlan` with the draft's items as the drafted units, a
// single-item draft through `runner.start` with the item's task as the ask.
// The draft is a draft of a contract plan; the engine below keeps running and
// resuming workstreams it already holds, and the surface reads it for status.
//
// So WorkstreamDraft is FACADE state, held on this module's instance
// (constructed once, threaded onto the caller's command context), never a
// module-level ambient global. Durability is facade-owned too: the facade
// journals every draft to disk through workstream-draft-store.ts (a drafts/
// subdirectory ALONGSIDE the engine's own workstream snapshots) and reloads
// them at construction, so a create / reshape / approve done before a restart
// is still here to launch afterward. The engine gains no draft concept. A
// journal write that fails degrades to in-memory-only for that one draft,
// never a crash, and the store never resurrects a launched draft (its snapshot
// is removed the moment its contract starts).
// ---------------------------------------------------------------------------

import {
  createOrchestrationEngine,
  type CreateWorkstreamInput,
  type OrchestrationEngine,
} from './engine.js';
export type { OrchestrationEngine } from './engine.js';
import { draftFromProposal } from './proposal-workstream.js';
import type { PhaseSpec, WorkItemSpec, WorkstreamIsolation } from './types.js';
import { getContractCommitScope, type ContractCommitScope } from '../contract/config.js';
import type { ContractRunner } from '../contract/runner.js';
import type { DraftedPlan } from '../contract/types.js';
import { AdaptivePlanner, type PlannerInputs } from '../core/adaptive-planner.js';
import {
  decomposeGoal,
  type DecompositionServiceConfig,
  type DecomposeGoalResult,
} from '../core/plan-decomposition.js';
import type { PlanProposal } from '../core/plan-proposal.js';
import { createAgentManagerDecompositionRunner } from '../agents/planner-decomposition-runner.js';
import type { ConfigManager } from '../config/manager.js';
import type { AgentManager } from '../tools/agent/index.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { calcSessionCost, isModelPriced } from '../providers/session-cost.js';
import { editItemBrief, moveItemInSpec, removeItemFromSpec } from './workstream-draft-edits.js';
import { createWorkstreamDraftStore, formatWorkstreamDraftReclaim } from './workstream-draft-store.js';
import { logger } from '../utils/logger.js';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { requestRisk } from '../routing/batteries/request.js';
import { requestState } from '../routing/request-reading.js';
import type { RemoteSupervisor } from '../runtime/remote/supervisor.js';
import type { RuntimeStore } from '../runtime/store/index.js';

export interface WorkstreamServicesDeps {
  readonly agentManager: Pick<AgentManager, 'spawn' | 'getStatus' | 'cancel' | 'registerCancellationSignal' | 'releaseCancellationSignal'>;
  readonly configManager: Pick<ConfigManager, 'get' | 'getCategory'>;
  readonly adaptivePlanner: AdaptivePlanner;
  readonly runtimeBus: RuntimeEventBus;
  readonly projectRoot: string;
  /** Starts the contract an approved draft launches as (design 10.4). */
  readonly contractRunner: Pick<ContractRunner, 'start' | 'startFromPlan'>;
  /** The session a launched contract belongs to: a fixed id, or read at launch time. */
  readonly sessionId: string | (() => string);
  /** Reports the remote runner sessions; the planner's remoteAvailable input is read from it for each draft. */
  readonly remoteSupervisor: Pick<RemoteSupervisor, 'getSnapshot'>;
  /** The runtime store the remote supervisor reads its connections from. */
  readonly runtimeStore: RuntimeStore;
}

// WorkstreamDraft + WorkstreamDraftProvenance live in workstream-draft-types.ts
// (so the durable store can persist them without an import cycle) and are
// re-exported here so a caller can import them from either place.
export type { WorkstreamDraft, WorkstreamDraftProvenance } from './workstream-draft-types.js';
import type { WorkstreamDraft, WorkstreamDraftProvenance } from './workstream-draft-types.js';

/** `ctx.session.workstreamEngine`'s real shape: the live engine plus the draft-proposal bookkeeping the engine itself has no concept of. */
export interface WorkstreamCommandService {
  readonly engine: OrchestrationEngine;
  /** Spawn a bounded read-only planning agent to decompose the goal (with automatic heuristic fallback), then hold the draft. Async because the planning agent is real. `isolation` omitted ⇒ the launched contract uses the runner's default isolation (StartContractInput.isolation). */
  proposeDraft(task: string, isolation?: WorkstreamIsolation): Promise<WorkstreamDraft>;
  getDraft(id: string): WorkstreamDraft | undefined;
  listDrafts(): WorkstreamDraft[];
  /** Re-derive a held draft's spec + decomposition from a new task string. Clears any prior approval, an edit must be re-approved. `isolation` omitted ⇒ keeps the draft's current choice (an edit that only changes the task text must not silently reset isolation back to shared). */
  editDraft(id: string, task: string, isolation?: WorkstreamIsolation): Promise<WorkstreamDraft | undefined>;
  /**
   * Plan-review-gate item edits over a held draft's launchable spec (see
   * workstream-draft-edits.ts). Each returns the updated draft on success,
   * `{ error }` with an honest user-facing reason on a bad reference/argument,
   * or `undefined` when no draft with that id is held. Every successful edit
   * clears approval, a reshaped plan must be re-approved before launch.
   */
  editItem(id: string, itemRef: string, brief: string): WorkstreamDraft | { error: string } | undefined;
  removeItem(id: string, itemRef: string): WorkstreamDraft | { error: string } | undefined;
  moveItem(id: string, itemRef: string, toPosition: number): WorkstreamDraft | { error: string } | undefined;
  approveDraft(id: string): WorkstreamDraft | undefined;
  removeDraft(id: string): boolean;
  /** Start an approved draft's contract (a multi-item draft through runner.startFromPlan, a single-item draft through runner.start), then drop the draft. Returns the contract's id and its owner agent's id; null when the draft is missing or not approved. */
  launchDraft(id: string): { contractId: string; ownerAgentId: string } | null;
}

export interface WorkstreamServices {
  readonly orchestrationEngine: OrchestrationEngine;
  readonly workstreamCommands: WorkstreamCommandService;
}

/** The decision site the task's risk reading is logged under. */
const TASK_RISK_SITE = 'orchestration.workstream.task-risk';

/** Remote transport states in which a runner can take work. */
const REMOTE_READY_STATES: ReadonlySet<string> = new Set(['connected', 'syncing']);

/** Where the planner inputs other than the task itself come from. */
interface PlannerInputSources {
  readonly remoteSupervisor: Pick<RemoteSupervisor, 'getSnapshot'>;
  readonly runtimeStore: RuntimeStore;
}

/**
 * The AdaptivePlanner inputs for a workstream task. Only the risk decides the
 * decomposition gate (above 0.7 the planner picks single and the draft stays
 * one item); the others pick which non-single strategy is recorded and show
 * in /plan explain.
 *  - riskScore: `routing.request-risk` (routing/batteries/request.ts) read
 *    over the task as a planner brief: how costly a wrong or careless result
 *    would be, on four levels. The planner takes a 0-1 score, so the reading's
 *    probability-weighted position on those levels (`normalized`) is used as
 *    is; an unsure reading spreads across levels and lands between them.
 *    A missing judgment port throws, so the draft is not proposed.
 *  - latencyBudgetMs: no wall-clock budget exists for a workstream. A draft
 *    is reviewed and approved before anything runs, and there is no latency
 *    setting in config, so the budget is unbounded.
 *  - isMultiStep: `/workstream create` is a multi-step authoring surface.
 *  - remoteAvailable: the remote supervisor reports a runner whose transport
 *    is connected or syncing and whose heartbeat is fresh.
 *  - backgroundEligible: a launched draft always runs in the background: the
 *    contract runner's start returns at once and runs or queues the contract
 *    (contract.maxActiveContracts, FIFO), with no queue cap to refuse it.
 */
async function buildPlannerInputs(task: string, sources: PlannerInputSources): Promise<PlannerInputs> {
  const run = await requestRisk.run(
    judgmentPort(TASK_RISK_SITE),
    requestState({ purpose: 'planner', brief: task }),
    { site: TASK_RISK_SITE },
  );
  const riskScore = run.readings.risk.normalized;
  run.recordAction(`planner riskScore ${riskScore.toFixed(2)}`);
  return {
    riskScore,
    latencyBudgetMs: Number.POSITIVE_INFINITY,
    isMultiStep: true,
    remoteAvailable: remoteRunnerAvailable(sources),
    backgroundEligible: true,
    taskDescription: task,
  };
}

/** Whether a remote runner is connected (or syncing) with a fresh heartbeat. */
function remoteRunnerAvailable(sources: PlannerInputSources): boolean {
  const snapshot = sources.remoteSupervisor.getSnapshot(sources.runtimeStore);
  return snapshot.sessions.some((session) =>
    REMOTE_READY_STATES.has(session.transportState) && session.heartbeat.status === 'fresh');
}

/**
 * Read the planner decomposition config (mode + bounds) from the config
 * manager, defensively defaulting anything missing or invalid. Real config
 * always supplies the DEFAULT_CONFIG values; these fallbacks matter only for a
 * partially-stubbed config manager, and guarantee finite positive bounds so a
 * planning-agent poll can never loop forever on a NaN deadline.
 */
function readDecompositionConfig(configManager: Pick<ConfigManager, 'get'>): DecompositionServiceConfig {
  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
  return {
    mode: configManager.get('planner.decomposition') === 'heuristic' ? 'heuristic' : 'agent',
    bounds: {
      maxTurns: num(configManager.get('planner.maxTurns'), 6),
      tokenCeiling: num(configManager.get('planner.tokenCeiling'), 120_000),
      wallTimeoutMs: num(configManager.get('planner.wallTimeoutMs'), 60_000),
    },
  };
}

/** Honest cost estimator: prices the planning agent's tokens only when the
 *  session's default model is one we actually have pricing for; otherwise the
 *  render falls back to a raw token count. Never throws. */
function makeCostEstimator(configManager: Pick<ConfigManager, 'get'>): (usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number | undefined; cacheWriteTokens?: number | undefined }) => number | undefined {
  return (usage) => {
    try {
      const model = configManager.get('provider.model') as unknown as string | undefined;
      if (!model || !isModelPriced(model)) return undefined;
      return calcSessionCost(usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0, model);
    } catch {
      return undefined;
    }
  };
}

function toProvenance(result: DecomposeGoalResult): WorkstreamDraftProvenance {
  const p = result.proposal;
  const kind: WorkstreamDraftProvenance['kind'] =
    result.outcome.kind === 'agent' ? 'agent'
      : result.outcome.kind === 'heuristic-configured' ? 'heuristic-configured'
        : result.outcome.kind === 'gate-declined' ? 'gate-declined'
          : 'fallback';
  return {
    kind,
    itemCount: p.workItems.length,
    ...(p.agentCostUsd !== undefined ? { agentCostUsd: p.agentCostUsd } : {}),
    ...(p.agentUsage ? { agentTokens: p.agentUsage.totalTokens } : {}),
    ...(p.elapsedMs !== undefined ? { elapsedMs: p.elapsedMs } : {}),
    ...(p.fallbackReason ? { fallbackReason: p.fallbackReason } : {}),
  };
}

/**
 * The draft's phase: one engineer phase whose capacity is the item count. It
 * is what the draft render shows; a launched draft runs as a contract, whose
 * planner places the units in groups.
 */
function draftPhases(commitScope: ContractCommitScope, capacity: number): PhaseSpec[] {
  return [{ role: 'engineer', capacity: Math.max(1, capacity), kind: 'engineer', gate: { scope: commitScope, gates: [] } }];
}

/** A multi-item draft's items as a drafted plan: one unit per item, its task the unit's brief. */
function draftedPlanFromSpec(goal: string, spec: CreateWorkstreamInput): DraftedPlan {
  return {
    goal,
    units: spec.items.map((item, index) => ({
      id: item.id ?? `item-${index + 1}`,
      title: item.title,
      brief: item.task,
      dependsOn: [...(item.dependsOn ?? [])],
      ...(item.files !== undefined && item.files.length > 0 ? { files: [...item.files] } : {}),
      ...(item.attempts !== undefined ? { attempts: item.attempts } : {}),
    })),
  };
}

function createWorkstreamCommandService(
  engine: OrchestrationEngine,
  adaptivePlanner: AdaptivePlanner,
  configManager: Pick<ConfigManager, 'get' | 'getCategory'>,
  agentManager: Pick<AgentManager, 'spawn' | 'getStatus' | 'cancel'>,
  projectRoot: string,
  contractRunner: Pick<ContractRunner, 'start' | 'startFromPlan'>,
  sessionId: string | (() => string),
  plannerSources: PlannerInputSources,
): WorkstreamCommandService {
  const drafts = new Map<string, WorkstreamDraft>();

  // The facade's draft journal (workstream-draft-store.ts). Load every persisted
  // proposal at construction so a create/reshape/approve done before a restart
  // is still here to launch afterward, the plan-review gate survives restart,
  // exactly as the live-workstream snapshots do via resumeAllFromDisk().
  // Reclaiming an abandoned draft deletes a plan the user once wrote, so it is
  // never done silently: the store reaps at load and on a throttled save, and
  // every reap that actually removed something reports a content-free count
  // here. Without this hook the store recorded the reclaim on itself and
  // nothing ever read it, which is deletion the user has no way to notice.
  const store = createWorkstreamDraftStore(projectRoot, {
    onReclaim: (summary) => {
      logger.info(formatWorkstreamDraftReclaim(summary), {
        projectRoot,
        expired: summary.expired,
        overCap: summary.overCap,
        unreadable: summary.unreadable,
      });
    },
  });
  for (const persisted of store.loadAll()) drafts.set(persisted.id, persisted);

  /**
   * Run the decomposition service: it spawns a bounded, read-only planning
   * agent (which surfaces in the fleet like any agent, kill/steer reach it,
   * and a kill lands as a 'cancelled' fallback) and validates its structured
   * output, or falls back to the heuristic single-item path on any failure.
   * The returned proposal is engine-agnostic; the launchable `spec` is still
   * derived by `buildSpec` (see below).
   */
  async function decompose(task: string): Promise<DecomposeGoalResult> {
    const runner = createAgentManagerDecompositionRunner({ agentManager });
    return decomposeGoal(
      { goal: task, workingDir: projectRoot, constraints: {} },
      adaptivePlanner,
      await buildPlannerInputs(task, plannerSources),
      readDecompositionConfig(configManager),
      runner,
      { estimateCostUsd: makeCostEstimator(configManager) },
    );
  }

  /**
   * Derive the draft's spec from the decomposition proposal. The rendered
   * draft shows THIS spec, and launchDraft builds the contract from it, so the
   * preview, the edits and the launch are always the same plan.
   *  - A MULTI-ITEM proposal: one item per proposal item (its brief the item's
   *    task, dependencies, likely files and attempts carried), checked for
   *    dangling dependencies and cycles (draftFromProposal throws on either).
   *  - A SINGLE-ITEM proposal (the heuristic single-item path, a gate-decline,
   *    or an agent that returned one item): one item whose task is the goal.
   */
  function buildSpec(task: string, proposal: PlanProposal): CreateWorkstreamInput {
    const commitScope = getContractCommitScope(configManager);
    if (proposal.workItems.length > 1) {
      const plan = draftFromProposal(proposal);
      const items: WorkItemSpec[] = plan.units.map((unit) => ({
        id: unit.id,
        title: unit.title,
        task: unit.brief,
        ...(unit.dependsOn.length > 0 ? { dependsOn: [...unit.dependsOn] } : {}),
        ...(unit.files !== undefined ? { files: [...unit.files] } : {}),
        ...(unit.attempts !== undefined ? { attempts: unit.attempts } : {}),
      }));
      return {
        title: proposal.task,
        phases: draftPhases(commitScope, items.length),
        items,
        provenance: {
          ...(proposal.decomposedBy ? { decomposedBy: proposal.decomposedBy } : {}),
          proposalId: proposal.id,
          strategy: proposal.strategy,
          ...(proposal.agentCostUsd !== undefined ? { agentCostUsd: proposal.agentCostUsd } : {}),
          ...(proposal.elapsedMs !== undefined ? { elapsedMs: proposal.elapsedMs } : {}),
        },
      };
    }
    return {
      title: task,
      phases: draftPhases(commitScope, 1),
      items: [{ id: `item-${crypto.randomUUID().slice(0, 8)}`, title: task, task }],
    };
  }

  /**
   * Apply a pure item edit (workstream-draft-edits.ts) to a held draft's spec.
   * Threads the three outcomes straight through: `undefined` (no such draft) so
   * the command layer can print its not-found message, `{ error }`
   * (a bad reference/argument) verbatim, or the mutated draft. A successful edit
   * clears approval, a reshaped plan must be re-approved before it can launch.
   */
  function applyItemEdit(
    id: string,
    edit: (spec: CreateWorkstreamInput) => import('./workstream-draft-edits.js').DraftEditResult,
  ): WorkstreamDraft | { error: string } | undefined {
    const draft = drafts.get(id);
    if (!draft) return undefined;
    const result = edit(draft.spec);
    if ('error' in result) return { error: result.error };
    draft.spec = result.spec;
    draft.approved = false;
    store.save(draft);
    return draft;
  }

  /**
   * Start an approved draft's contract (design 10.4). A multi-item draft is a
   * drafted plan: its items become the units (task as brief), the planner
   * writes only their criteria, and every plan check runs. A single-item draft
   * is an ask: the item's task starts the contract.
   */
  function startDraftContract(draft: WorkstreamDraft): ReturnType<ContractRunner['start']> {
    const spec = draft.spec;
    const launch = {
      sessionId: typeof sessionId === 'function' ? sessionId() : sessionId,
      origin: 'proposal' as const,
      projectRoot,
      ...(spec.isolation !== undefined ? { isolation: spec.isolation } : {}),
      ...(spec.budget !== undefined ? { budget: spec.budget } : {}),
    };
    if (spec.items.length > 1) {
      return contractRunner.startFromPlan({ ...launch, ask: draft.task, draft: draftedPlanFromSpec(draft.task, spec) });
    }
    return contractRunner.start({ ...launch, ask: spec.items[0]?.task ?? draft.task });
  }

  return {
    engine,
    async proposeDraft(task: string, isolation?: WorkstreamIsolation): Promise<WorkstreamDraft> {
      const result = await decompose(task);
      const spec = buildSpec(task, result.proposal);
      const draft: WorkstreamDraft = {
        id: `wsd_${crypto.randomUUID().slice(0, 8)}`,
        task,
        spec: isolation ? { ...spec, isolation } : spec,
        gate: result.gate,
        proposal: result.proposal,
        provenance: toProvenance(result),
        approved: false,
        createdAt: Date.now(),
      };
      drafts.set(draft.id, draft);
      store.save(draft);
      return draft;
    },
    getDraft: (id) => drafts.get(id),
    listDrafts: () => Array.from(drafts.values()).sort((a, b) => a.createdAt - b.createdAt),
    async editDraft(id, task, isolation) {
      const draft = drafts.get(id);
      if (!draft) return undefined;
      const result = await decompose(task);
      const nextIsolation = isolation ?? draft.spec.isolation;
      draft.task = task;
      draft.spec = { ...buildSpec(task, result.proposal), isolation: nextIsolation };
      draft.proposal = result.proposal;
      draft.provenance = toProvenance(result);
      draft.approved = false;
      store.save(draft);
      return draft;
    },
    editItem: (id, itemRef, brief) => applyItemEdit(id, (spec) => editItemBrief(spec, itemRef, brief)),
    removeItem: (id, itemRef) => applyItemEdit(id, (spec) => removeItemFromSpec(spec, itemRef)),
    moveItem: (id, itemRef, toPosition) => applyItemEdit(id, (spec) => moveItemInSpec(spec, itemRef, toPosition)),
    approveDraft(id) {
      const draft = drafts.get(id);
      if (!draft) return undefined;
      draft.approved = true;
      store.save(draft); // approval must survive restart too, a resumed approved draft launches straight away
      return draft;
    },
    removeDraft(id) {
      store.remove(id);
      return drafts.delete(id);
    },
    launchDraft(id) {
      const draft = drafts.get(id);
      if (!draft || !draft.approved) return null;
      const started = startDraftContract(draft);
      drafts.delete(id);
      store.remove(id); // launched: the contract store now owns it, so drop the draft snapshot
      return { contractId: started.contract.id, ownerAgentId: started.owner.id };
    },
  };
}

/**
 * Constructs one OrchestrationEngine instance and its command-facing facade.
 * `persist` and `createWorktree` are left at the engine's own defaults:
 * journal-backed snapshots under .goodvibes/orchestration/ (so resumeAllFromDisk
 * below has something to resume) and a plain AgentWorktree(projectRoot). The
 * engine keeps the workstreams it already holds (resumed below, read by the
 * surface's status, kill and insert-phase commands and the fleet); a launched
 * draft starts a contract instead, and a draft's `isolation` is handed to it.
 */
export function createWorkstreamServices(deps: WorkstreamServicesDeps): WorkstreamServices {
  const orchestrationEngine = createOrchestrationEngine({
    agentManager: deps.agentManager,
    configManager: deps.configManager,
    runtimeBus: deps.runtimeBus,
    projectRoot: deps.projectRoot,
    priceUsage: (model, usage) => {
      const modelId = model ?? 'unknown';
      if (!isModelPriced(modelId)) return null;
      return calcSessionCost(usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, modelId);
    },
  });
  // Honest resume: a prior process's still-in-flight workstreams pick back up
  // (and reappear in the fleet tree) instead of silently vanishing on
  // restart. Never throws, persistence.ts guards every read/parse and
  // quarantines an unrecognized snapshot rather than propagating.
  orchestrationEngine.resumeAllFromDisk();
  const workstreamCommands = createWorkstreamCommandService(
    orchestrationEngine,
    deps.adaptivePlanner,
    deps.configManager,
    deps.agentManager,
    deps.projectRoot,
    deps.contractRunner,
    deps.sessionId,
    { remoteSupervisor: deps.remoteSupervisor, runtimeStore: deps.runtimeStore },
  );
  return { orchestrationEngine, workstreamCommands };
}
