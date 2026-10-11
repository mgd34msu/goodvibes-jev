/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Phase-runner (see CHANGELOG 0.38.0), runs one WorkItem through one Phase:
 * spawn the agent, await its outcome, run gates and the claim check, commit,
 * clean up.
 *
 * A contract unit's item (docs/design/contract-runner.md sections 6.1 and
 * 7.5) differs in three ways:
 * - its agent is spawned bound to the unit, with the unit brief verbatim and
 *   the route, tool contract and template the item carries;
 * - its outcome is the contract runner's settlement, not the agent's terminal
 *   event: the runner holds the agent at completion until every criterion
 *   reads met, and decides what a failure means (a turn-budget stop is woken,
 *   a transport failure is requeued, anything else fails the unit), so the
 *   phase runner neither retries it nor reads its error;
 * - gates and claim verification do not run here: the runner's completion
 *   check already ran both, and a unit cannot pass without them.
 *
 * Every other item runs as before: gates, the phantom-work claim check, and
 * one bounded respawn when Jev reads a spawn-time failure as transient.
 *
 * Shared-tree note: without worktree isolation every agent runs in the ONE
 * shared `projectRoot`; AgentWorktree is used only for its
 * commitWorkingTree/merge/cleanup surface. In worktree mode the engine hands
 * the item's own worktree in `itemWorktree`, the agent runs there, and the
 * engine's integration lane owns merge-back and cleanup.
 */
import type { AgentManager, AgentRecord } from '../tools/agent/manager.js';
import type { ConfigManager } from '../config/manager.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { AgentWorktree, type CommitWorkingTreeResult } from '../agents/worktree.js';
import { parseCompletionReport, type CompletionReport } from '../agents/completion-report.js';
import { verifyUnitClaims } from '../contract/claims.js';
import { contractUnitSpawn } from './contract-binding.js';
import { runContractGates } from '../contract/gates.js';
import { getContractTransportRetryDelayMs, getContractTransportRetryLimit } from '../contract/config.js';
import { readFailure } from '@goodvibes-jev/engine/errors';
import { logger } from '../utils/logger.js';
import type { CancellationRegistry } from './cancellation.js';
import { excludeUntouchedLaunchResidue, snapshotDirtyTree, type DirtyLaunchSnapshot } from './dirty-guard.js';
import { classifyBookkeepingFailure, type BookkeepingFailureReading } from './bookkeeping.js';
import { mergeWorkItemUsage } from './types.js';
import type { UnitRoute } from '../contract/types.js';
import type { CommitExclusion, GateOutcome, Phase, PhaseCommitOutcome, PhaseResult, PriceProvenanceFn, WorkItem, WorkItemUsage, Workstream } from './types.js';

/** Narrow structural pick, testable with stubs, mirrors AgentManagerLike (contract/types.ts). */
export type PhaseRunnerAgentManagerLike = Pick<
  AgentManager,
  'spawn' | 'getStatus' | 'cancel' | 'registerCancellationSignal' | 'releaseCancellationSignal'
> & Partial<Pick<AgentManager, 'join'>>;

/** Structural pick of AgentWorktree's surface: the worktree operations a phase needs (merge, cleanup, commit, head), so tests can pass a stub. */
export interface WorktreeOps {
  merge(agentId: string): Promise<boolean>;
  cleanup(agentId: string): Promise<void>;
  commitWorkingTree(message: string, paths?: string[]): Promise<CommitWorkingTreeResult>;
  currentHead(): Promise<string | null>;
}

/**
 * The minimal surface of an item's IsolatedWorktree (worktree.ts) that the
 * phase-runner needs in `worktree` isolation mode: the on-disk `path` (used as
 * the spawned agent's working directory) and a scoped `commit` onto the item
 * branch. Notably NOT merge/cleanup, in worktree mode the item worktree
 * persists across the item's phases and the engine's sequential integration
 * lane owns the merge-back and cleanup, so a phase NEVER merges to base or
 * removes the worktree.
 */
export interface PhaseItemWorktree {
  readonly path: string;
  commit(message: string, paths?: string[]): Promise<CommitWorkingTreeResult>;
}

/** What a contract unit's phase settled as, as the contract runner decides it. */
export type ContractUnitOutcome = 'completed' | 'failed' | 'cancelled';

/**
 * The contract runner's side of a contract unit's phase: resolves once the
 * runner has settled the unit's current agent. `signal` aborts when the engine
 * kills or requeues the item, and the settlement then resolves `cancelled`.
 */
export interface ContractUnitSettlement {
  autonomousPort?(item: WorkItem): import('../tools/agent/contract-binding.js').ContractActionPort | undefined;
  /** Source ownership is borrowed only by this real native member, never reconstructed from its brief. */
  autonomousSource?(item: WorkItem): (() => import('../permissions/autonomous.js').AutonomousToolSource) | undefined;
  /** Wrap the actual executor invocation after all AgentManager spawning hooks. */
  withCurrentExecution?(item: WorkItem, execute: () => Promise<void>): Promise<void>;
  settle(item: WorkItem, agentId: string, signal: AbortSignal): Promise<ContractUnitOutcome>;
  /**
   * Asked before a contract unit's phase spawns an agent. After a restart, a
   * unit whose agent was held, checked, nudged or waiting on its owner has no
   * agent, and the runner decides what its phase does: spawn one (with a
   * revised brief and route, when given), or settle with no agent, as when a
   * check after the restart passed the work the earlier agent left. `signal`
   * aborts when the engine kills or requeues the item, and the decision is
   * then `cancelled`.
   */
  beforeSpawn(item: WorkItem, signal: AbortSignal): Promise<ContractPreSpawn>;
}

/** What a contract unit's phase does before it spawns: spawn an agent, or settle with none. */
export type ContractPreSpawn =
  | { readonly kind: 'spawn'; readonly task?: string | undefined; readonly route?: UnitRoute | undefined }
  | { readonly kind: 'settled'; readonly outcome: ContractUnitOutcome };

export interface PhaseRunnerDeps {
  readonly prepareInputAuthority?: import('../contract/group-runner.js').ContractEngineInput['prepareInputAuthority'];
  readonly agentManager: PhaseRunnerAgentManagerLike;
  readonly configManager: Pick<ConfigManager, 'get' | 'getCategory'> & Partial<Pick<ConfigManager, 'getConfigurationIncarnation' | 'onDidChangeIncarnation'>>;
  readonly runtimeBus: RuntimeEventBus;
  readonly projectRoot: string;
  readonly sessionId: string;
  readonly createWorktree?: (() => WorktreeOps) | undefined;
  readonly cancellation: CancellationRegistry;
  /** Engine-owned phase signal, registered before worktree setup or any spawn callback. */
  readonly cancellationSignal?: AbortSignal | undefined;
  /** Engine lifetime and request ownership, retained through final publication. */
  readonly assertBookkeepingCurrent?: (() => void) | undefined;
  readonly priceUsage?: ((model: string | undefined, usage: WorkItemUsage) => number | null) | undefined;
  /** Provenance for the same resolution priceUsage prices with, stamped onto the committed usage record at pricing time. */
  readonly priceProvenance?: PriceProvenanceFn | undefined;
  readonly skipClaimVerification?: boolean | undefined;
  /** Settles contract unit items; a contract item cannot run without it. */
  readonly contractUnitSettlement?: ContractUnitSettlement | undefined;
  /** Called synchronously right after the agent is spawned, before any await. */
  readonly onAgentSpawned?: ((agentId: string) => void) | undefined;
  /**
   * The dirty-tree snapshot taken synchronously at engine launch (see
   * CHANGELOG 0.38.0 and dirty-guard.ts). Absent (undefined) degrades to
   * today's behavior: no exclusion, every candidate path is committed.
   */
  readonly launchDirtySnapshot?: DirtyLaunchSnapshot | undefined;
  /**
   * Present ONLY in `worktree` isolation mode: this item's dedicated worktree
   * (created by the engine at first claim). When set, the phase's scoped commit
   * lands on the item branch INSIDE this worktree (not the shared projectRoot),
   * and the spawned agent runs with its working directory set to the worktree
   * path. Absent ⇒ shared mode, every existing behavior unchanged.
   */
  readonly itemWorktree?: PhaseItemWorktree | undefined;
}

export interface PhaseRunOutcome {
  readonly result: PhaseResult;
  readonly bookkeeping?: BookkeepingFailureReading | undefined;
  readonly agentStatus: 'completed' | 'failed' | 'cancelled';
}

function templateForPhase(phase: Phase): 'engineer' | 'general' {
  return phase.kind === 'gate' ? 'general' : 'engineer';
}

function buildPhaseTask(item: WorkItem, phase: Phase, priorReports: readonly PhaseResult[]): string {
  const priorContext = priorReports.length > 0
    ? `\n\nPrior phase reports for this work item:\n${priorReports.map((r) => `- ${r.phaseId}: ${r.report.summary}`).join('\n')}`
    : '';
  if (phase.kind === 'gate') {
    return `Assess the following work item's changes against its constraints and report findings. Do not modify files.\n\nWork item: ${item.title}\n${item.task}${priorContext}`;
  }
  return `${item.task}${priorContext}`;
}

function genericReport(summary: string): CompletionReport {
  return { version: 1, archetype: 'generic', summary, result: summary };
}

/**
 * A spawn-time failure worth one bounded respawn: Jev reads the error as a
 * transient network fault or as failing before any response came back.
 */
async function isTransportFailure(error: string): Promise<boolean> {
  if (error.trim().length === 0) return false;
  const reading = await readFailure({ message: error }, 'orchestration.phase-runner.transport-retry');
  return reading.transientNetwork || reading.beforeResponse;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

type AgentOutcome = { status: 'completed' | 'failed' | 'cancelled'; record: AgentRecord | null };

/** Subscribe before spawn: terminal events may be emitted reentrantly from spawn listeners. */
function observeAgentTermination(runtimeBus: RuntimeEventBus, agentManager: PhaseRunnerAgentManagerLike): {
  wait(agentId: string, signal: AbortSignal): Promise<AgentOutcome>;
  dispose(): void;
} {
  const terminal = new Map<string, AgentOutcome['status']>();
  let notify: (() => void) | undefined;
  let removeAbort: (() => void) | undefined;
  const unsubscribe = runtimeBus.onDomain('agents', (envelope) => {
    const event = envelope.payload as { type: string; agentId?: string };
    if (!event.agentId) return;
    if (event.type !== 'AGENT_COMPLETED' && event.type !== 'AGENT_FAILED' && event.type !== 'AGENT_CANCELLED') return;
    terminal.set(event.agentId, event.type === 'AGENT_COMPLETED' ? 'completed' : event.type === 'AGENT_CANCELLED' ? 'cancelled' : 'failed');
    notify?.();
  });
  return {
    wait: (agentId, signal) => new Promise((resolve) => {
      notify = () => {
        const status = signal.aborted ? 'cancelled' : terminal.get(agentId);
        if (status) resolve({ status, record: agentManager.getStatus(agentId) });
      };
      signal.addEventListener('abort', notify, { once: true });
      const onAbort = notify;
      removeAbort = () => signal.removeEventListener('abort', onAbort);
      notify();
    }),
    dispose: () => {
      unsubscribe();
      removeAbort?.();
      notify = undefined;
    },
  };
}

/**
 * One agent's usage as a work item usage record, priced when a pricer is
 * given (a throwing pricer leaves it unpriced, never a made-up cost).
 */
export function usageFromRecord(
  record: AgentRecord | null,
  priceUsage: PhaseRunnerDeps['priceUsage'],
  priceProvenance: PhaseRunnerDeps['priceProvenance'],
): WorkItemUsage {
  const u = record?.usage;
  const base = {
    inputTokens: u?.inputTokens ?? 0,
    outputTokens: u?.outputTokens ?? 0,
    cacheReadTokens: u?.cacheReadTokens ?? 0,
    cacheWriteTokens: u?.cacheWriteTokens ?? 0,
    reasoningTokens: u?.reasoningTokens,
    llmCallCount: u?.llmCallCount ?? 0,
    turnCount: u?.turnCount ?? 0,
    toolCallCount: record?.toolCallCount ?? 0,
  };
  let costUsd: number | null = null;
  let costState: WorkItemUsage['costState'] = 'unpriced';
  let provenance: ReturnType<PriceProvenanceFn> = null;
  if (u && priceUsage) {
    try {
      const priced = priceUsage(record?.model, { ...base, costUsd: null, costState: 'unpriced' });
      if (priced !== null) {
        costUsd = priced;
        costState = 'priced';
        // Same resolution instant as the dollars, never re-derived later.
        provenance = priceProvenance?.(record?.model) ?? null;
      }
    } catch {
      // stays unpriced, never fabricate a cost from a throwing pricer.
    }
  }
  return {
    ...base,
    costUsd,
    costState,
    ...(provenance ? { costSource: provenance.source, pricingAsOf: provenance.asOf } : {}),
  };
}

/**
 * Combines a new phase's usage into a work item's running total. Single-source
 * cost (never independently re-priced here). Thin alias over the canonical
 * {@link mergeWorkItemUsage} (types.ts) so the phase-runner, the engine, and
 * the fleet rollup adapters all fold usage through exactly one implementation.
 */
export function mergeUsage(a: WorkItemUsage, b: WorkItemUsage): WorkItemUsage {
  return mergeWorkItemUsage(a, b);
}

/** Phase kinds whose agents change files, so their reported claims are checked against what changed. */
const WRITING_PHASE_KINDS: ReadonlySet<Phase['kind']> = new Set(['engineer', 'integrate']);

/** The paths a phase changed: the item worktree's own changes, or the shared tree's less untouched launch residue. */
function phaseChangedPaths(deps: Pick<PhaseRunnerDeps, 'projectRoot' | 'itemWorktree' | 'launchDirtySnapshot'>): readonly string[] {
  const cwd = deps.itemWorktree?.path ?? deps.projectRoot;
  const dirty = [...snapshotDirtyTree(cwd).keys()];
  if (deps.itemWorktree !== undefined || deps.launchDirtySnapshot === undefined) return dirty;
  return excludeUntouchedLaunchResidue(cwd, dirty, deps.launchDirtySnapshot).included;
}

/** Quality gates (global-config-driven) + phase-required-gate assertion + phantom guard, for an item that is not a contract unit. */
async function evaluateGate(
  workstream: Workstream,
  phase: Phase,
  report: CompletionReport | null,
  deps: PhaseRunnerDeps,
): Promise<GateOutcome> {
  const results = [...await runContractGates({
    configManager: deps.configManager,
    // Worktree mode: the configured quality gates run INSIDE the item's
    // isolated worktree, the same tree the claim check reads, so gates
    // (typecheck, lint, test) see the item's isolated changes. Shared mode runs
    // them in the project root.
    cwd: deps.itemWorktree?.path ?? deps.projectRoot,
    runtimeBus: deps.runtimeBus,
    sessionId: deps.sessionId,
    contractId: workstream.id,
    targetId: workstream.id,
  })];

  const ranNames = new Set(results.map((r) => r.gate));
  const missingRequired = phase.gate.gates.filter((name) => !ranNames.has(name));
  for (const name of missingRequired) {
    results.push({ gate: name, passed: false, output: 'required gate is not configured/enabled', durationMs: 0 });
  }

  if (!deps.skipClaimVerification) {
    // Whether claims are checked is the phase's kind, not the agent's own
    // report. Worktree mode: the agent's files landed in the item's OWN
    // worktree, not the shared projectRoot, so claims are checked there, or
    // every real change would be falsely flagged as phantom work.
    const verification = verifyUnitClaims(report, {
      cwd: deps.itemWorktree?.path ?? deps.projectRoot,
      mustWrite: WRITING_PHASE_KINDS.has(phase.kind),
      changedPaths: phaseChangedPaths(deps),
    });
    if (verification.kind === 'unverified' || verification.kind === 'unverifiable_no_claims') {
      results.push({ gate: 'phantom-work-guard', passed: false, output: verification.summary, durationMs: 0 });
    }
  }

  return { passed: results.every((r) => r.passed), results };
}

/** Post-gate scoped-commit result: the residue exclusion (if any) plus an honest commit outcome. */
interface CommitPhaseWorkResult {
  readonly exclusion?: CommitExclusion | undefined;
  readonly commit: PhaseCommitOutcome;
  readonly bookkeeping?: BookkeepingFailureReading | undefined;
}

/**
 * Runs the POST-gate scoped-commit + merge for a passed phase and reports its
 * outcome HONESTLY rather than swallowing failures. The gate has already
 * decided the phase passed; this step only records the changes, so its result
 * is bookkeeping: a failure surfaces to the engine as a warning on a passed
 * item only after a settled negative reading. A positive reading fails the
 * item; an unresolved reading holds it. Never a silent no-op that lets the
 * fleet imply a commit happened when it did not.
 */
async function commitPhaseWork(
  item: WorkItem,
  phase: Phase,
  agentId: string,
  worktree: WorktreeOps,
  deps: PhaseRunnerDeps,
): Promise<CommitPhaseWorkResult> {
  if (phase.gate.scope === 'off') {
    return { commit: { status: 'skipped', reason: 'commit disabled for this phase (gate scope: off)' } };
  }

  let paths = phase.gate.scope === 'scoped' ? item.touchedPaths : undefined;
  let exclusion: CommitExclusion | undefined;

  // Worktree mode: the item commits onto its own branch INSIDE its dedicated
  // worktree, which the engine created fresh (and therefore clean) at claim.
  // The launch-dirty snapshot is taken against the SHARED projectRoot, so it
  // has nothing to say about a just-created worktree, a fresh worktree starts
  // clean, so its launch-dirty residue is trivially empty. Skip the residue
  // exclusion entirely and commit straight onto the item branch; NO merge to
  // base (the sequential integration lane owns that at item termination).
  if (deps.itemWorktree) {
    try {
      const result = await deps.itemWorktree.commit(`orchestration: ${item.title}, ${phase.kind} phase`, paths);
      const ignoredNote = result.skippedIgnored.length > 0
        ? `${result.skippedIgnored.length} ignored path${result.skippedIgnored.length === 1 ? '' : 's'} skipped`
        : undefined;
      if (result.hash === null) {
        return { commit: { status: 'skipped', reason: ignoredNote ? `nothing to stage (${ignoredNote})` : 'nothing to stage' } };
      }
      return { commit: { status: 'committed', hash: result.hash, ...(ignoredNote ? { reason: ignoredNote } : {}) } };
    } catch (error) {
      const bookkeeping = await readCommitFailure(error, item, phase, deps);
      return { commit: failureOutcome(bookkeeping), bookkeeping };
    }
  }

  if (paths && paths.length > 0 && deps.launchDirtySnapshot) {
    const launchSnapshot = deps.launchDirtySnapshot;
    if (launchSnapshot.size > 0) {
      const { included, excluded } = excludeUntouchedLaunchResidue(deps.projectRoot, paths, launchSnapshot);
      if (excluded.length > 0) {
        exclusion = { excludedPaths: excluded, skipped: included.length === 0 };
        if (included.length === 0) {
          // Every candidate path is untouched launch-dirty residue, an
          // honest "nothing this phase did needs committing", not a silent
          // no-op AND not a fallback to sweeping the whole working tree.
          logger.info('orchestration phase-runner: scoped commit skipped, every candidate path is untouched launch-dirty residue', {
            itemId: item.id,
            phaseId: phase.id,
            excludedPaths: excluded,
          });
          return { exclusion, commit: { status: 'skipped', reason: 'every candidate path was untouched launch-dirty residue' } };
        }
        logger.info('orchestration phase-runner: excluded untouched launch-dirty residue from scoped commit', {
          itemId: item.id,
          phaseId: phase.id,
          excludedPaths: excluded,
        });
        paths = [...included];
      }
    }
  }

  try {
    const result = await worktree.commitWorkingTree(`orchestration: ${item.title}, ${phase.kind} phase`, paths);
    await worktree.merge(agentId);
    const ignoredNote = result.skippedIgnored.length > 0
      ? `${result.skippedIgnored.length} ignored path${result.skippedIgnored.length === 1 ? '' : 's'} skipped`
      : undefined;
    if (result.hash === null) {
      // A null hash is "nothing was staged", an honest skip, not a landed commit.
      return { exclusion, commit: { status: 'skipped', reason: ignoredNote ? `nothing to stage (${ignoredNote})` : 'nothing to stage' } };
    }
    return {
      exclusion,
      commit: { status: 'committed', hash: result.hash, ...(ignoredNote ? { reason: ignoredNote } : {}) },
    };
  } catch (error) {
    const bookkeeping = await readCommitFailure(error, item, phase, deps);
    return { exclusion, commit: failureOutcome(bookkeeping), bookkeeping };
  }
}

function failureOutcome(reading: BookkeepingFailureReading): PhaseCommitOutcome {
  return { status: 'failed', reason: reading.reason, classification: reading.classification,
    ...(reading.classification === 'held' ? {} : { negating: reading.classification === 'negating' }) };
}

function currentFailureOutcome(commit: PhaseCommitOutcome | undefined, reading: BookkeepingFailureReading | undefined): PhaseCommitOutcome | undefined {
  if (!reading || !commit) return commit;
  try { reading.assertCurrent(); return commit; }
  catch { return { status: 'failed', reason: commit.reason, classification: 'held' }; }
}

async function readCommitFailure(error: unknown, item: WorkItem, phase: Phase, deps: PhaseRunnerDeps): Promise<BookkeepingFailureReading> {
  let release: (() => void) | undefined;
  try {
    const config = deps.configManager;
    const readIncarnation = config.getConfigurationIncarnation;
    const watchIncarnation = config.onDidChangeIncarnation;
    const get = config.get, getCategory = config.getCategory;
    const incarnation = readIncarnation?.call(config);
    const controller = new AbortController();
    release = watchIncarnation?.call(config, () => controller.abort());
    const itemWorktree = deps.itemWorktree;
    const task = item.task, phaseId = item.currentPhaseId;
    return await classifyBookkeepingFailure(error, {
      signal: AbortSignal.any([controller.signal, ...(deps.cancellationSignal ? [deps.cancellationSignal] : [])]),
      assertCurrent: () => {
        deps.assertBookkeepingCurrent?.();
        if (deps.configManager !== config || config.getConfigurationIncarnation !== readIncarnation
          || config.onDidChangeIncarnation !== watchIncarnation || config.get !== get || config.getCategory !== getCategory
          || readIncarnation?.call(config) !== incarnation
          || deps.itemWorktree !== itemWorktree || item.task !== task || item.currentPhaseId !== phaseId
          || phase.id !== phaseId) throw new Error('Repository failure request retired.');
      },
    });
  } catch {
    return { classification: 'held', reason: 'Commit or merge failed; repository reading ownership is unavailable.',
      assertCurrent: () => { throw new Error('Repository failure request retired.'); } };
  } finally {
    // A broken lifetime release must not replace the original action failure.
    try { release?.(); } catch { /* Reading remains subject to its captured owner. */ }
  }
}

/**
 * A contract unit's phase that the runner settled before any agent ran (a
 * check after a restart passed the work an earlier agent left, or the unit
 * ended while it waited): `completed` commits the item's work as a passing
 * phase does; `failed` and `cancelled` end the phase with no agent.
 */
async function settleWithoutAgent(
  item: WorkItem,
  phase: Phase,
  outcome: ContractUnitOutcome,
  startedAt: number,
  worktree: WorktreeOps,
  deps: PhaseRunnerDeps,
): Promise<PhaseRunOutcome> {
  const base = { itemId: item.id, phaseId: phase.id, agentId: '', startedAt, usage: usageFromRecord(null, deps.priceUsage, deps.priceProvenance) };
  if (outcome !== 'completed') {
    const summary = outcome === 'cancelled' ? 'cancelled by operator' : 'the contract runner failed the unit before an agent ran';
    return { agentStatus: outcome, result: { ...base, report: genericReport(summary), gate: { passed: false, results: [] }, completedAt: Date.now() } };
  }
  const committed = await commitPhaseWork(item, phase, '', worktree, deps);
  const settledCommit = currentFailureOutcome(committed.commit, committed.bookkeeping);
  return {
    agentStatus: deps.cancellationSignal?.aborted ? 'cancelled' : 'completed',
    bookkeeping: committed.bookkeeping,
    result: {
      ...base,
      report: genericReport('checked and passed by the contract runner after a restart; no agent ran this phase'),
      gate: { passed: true, results: [] },
      completedAt: Date.now(),
      ...(committed.exclusion ? { commitExclusion: committed.exclusion } : {}),
      ...(settledCommit ? { commit: settledCommit } : {}),
    },
  };
}

/** Runs one WorkItem through one Phase to completion (or cancellation/failure). Recurses (bounded by transportRetryLimit) on a transport-classified spawn failure. */
export async function runPhase(
  workstream: Workstream,
  item: WorkItem,
  phase: Phase,
  priorReports: readonly PhaseResult[],
  deps: PhaseRunnerDeps,
): Promise<PhaseRunOutcome> {
  // Own the cancellation registration before invoking callbacks: spawn and
  // beforeSpawn can synchronously re-enter kill/requeue/dispose.
  const signal = deps.cancellationSignal ?? deps.cancellation.start(item.id);
  try {
    return await runPhaseWithSignal(workstream, item, phase, priorReports, { ...deps, cancellationSignal: signal });
  } finally {
    if (deps.cancellationSignal === undefined) deps.cancellation.release(item.id, signal);
  }
}

async function runPhaseWithSignal(
  workstream: Workstream,
  item: WorkItem,
  phase: Phase,
  priorReports: readonly PhaseResult[],
  deps: PhaseRunnerDeps & { readonly cancellationSignal: AbortSignal },
): Promise<PhaseRunOutcome> {
  const startedAt = Date.now();
  const signal = deps.cancellationSignal;
  const createWorktree = deps.createWorktree ?? (() => new AgentWorktree(deps.projectRoot));
  const worktree = createWorktree();
  if (signal.aborted) return settleWithoutAgent(item, phase, 'cancelled', startedAt, worktree, deps);

  // A contract unit's item spawns its agent bound to the unit, with the unit
  // brief (item.task) verbatim, the route's model and the item's tool contract.
  if (contractUnitSpawn(item)) {
    if (!deps.contractUnitSettlement) throw new Error(`work item ${item.id} is a contract unit, but the engine has no contract unit settlement`);
    const decided = await deps.contractUnitSettlement.beforeSpawn(item, signal);
    if (signal.aborted) return settleWithoutAgent(item, phase, 'cancelled', startedAt, worktree, deps);
    if (decided.kind === 'settled') return settleWithoutAgent(item, phase, decided.outcome, startedAt, worktree, deps);
    if (decided.task !== undefined && decided.task.trim().length > 0) item.task = decided.task;
    // The engine owns the item: the unit's next agent runs on the runner's route.
    if (decided.route !== undefined) Object.assign(item, { route: decided.route });
  }
  const unitSpawn = contractUnitSpawn(item);
  const autonomousSource = deps.contractUnitSettlement?.autonomousSource?.(item);
  const autonomousPort = deps.contractUnitSettlement?.autonomousPort?.(item);
  const inputReadAuthority = deps.prepareInputAuthority && deps.itemWorktree
    ? await deps.prepareInputAuthority({ path: deps.itemWorktree.path, branch: item.worktreeBranch ?? '' }, signal)
    : undefined;
  if (deps.prepareInputAuthority && !deps.itemWorktree) throw new Error('captured contract member requires its isolated workspace');
  if (signal.aborted) return settleWithoutAgent(item, phase, 'cancelled', startedAt, worktree, deps);
  const termination = observeAgentTermination(deps.runtimeBus, deps.agentManager);
  let record: AgentRecord | undefined;
  let outcome: AgentOutcome;
  let receivedOutcome = false;
  try {
    record = deps.agentManager.spawn({
      mode: 'spawn',
      task: unitSpawn ? item.task : buildPhaseTask(item, phase, priorReports),
      template: templateForPhase(phase),
      outsideContract: true,
      ...unitSpawn?.input,
      // An isolated item's tools run inside its own worktree.
      ...(deps.itemWorktree ? { workingDirectory: deps.itemWorktree.path } : {}),
    } as Parameters<PhaseRunnerAgentManagerLike['spawn']>[0], unitSpawn === null ? undefined : {
      ...unitSpawn.binding,
      ...(autonomousSource === undefined ? {} : { autonomousSource }),
      ...(autonomousPort === undefined ? {} : { autonomousPort }),
      ...(inputReadAuthority ? { inputReadAuthority } : {}),
      ...(deps.contractUnitSettlement?.withCurrentExecution === undefined ? {} : {
        withCurrentExecution: (execute: () => Promise<void>) => deps.contractUnitSettlement!.withCurrentExecution!(item, execute),
      }),
    });

    record.workItemId = item.id;
    if (!signal.aborted) item.agentId = record.id;
    item.allAgentIds.push(record.id);
    item.branch ??= `agent/${item.id}`;
    deps.agentManager.registerCancellationSignal(record.id, signal);
    deps.onAgentSpawned?.(record.id);
    // kill/requeue may have run inside spawn, before the id was available.
    if (signal.aborted) deps.agentManager.cancel(record.id, 'kill');

    if (signal.aborted) {
      outcome = { status: 'cancelled', record: deps.agentManager.getStatus(record.id) };
    } else if (unitSpawn) {
      if (!deps.contractUnitSettlement) throw new Error(`work item ${item.id} is a contract unit, but the engine has no contract unit settlement`);
      const status = await deps.contractUnitSettlement.settle(item, record.id, signal);
      outcome = { status, record: deps.agentManager.getStatus(record.id) };
    } else {
      outcome = await termination.wait(record.id, signal);
    }
    receivedOutcome = true;
  } catch (error) {
    if (record) deps.agentManager.cancel(record.id, 'kill');
    throw error;
  } finally {
    termination.dispose();
    if (record) {
      try {
        // Terminal events and contract verdicts are semantic outcomes, never
        // proof that the executor's asynchronous finally has finished.
        if (deps.agentManager.join) await deps.agentManager.join(record.id);
      } finally {
        deps.agentManager.releaseCancellationSignal(record.id, signal);
        if (!receivedOutcome) await worktree.cleanup(record.id).catch(() => undefined);
      }
    }
  }
  if (signal.aborted) outcome = { status: 'cancelled', record: deps.agentManager.getStatus(record.id) };
  const usage = usageFromRecord(outcome.record, deps.priceUsage, deps.priceProvenance);

  if (outcome.status === 'cancelled') {
    await worktree.cleanup(record.id).catch(() => undefined);
    return {
      agentStatus: 'cancelled',
      result: {
        itemId: item.id,
        phaseId: phase.id,
        agentId: record.id,
        report: genericReport('cancelled by operator'),
        gate: { passed: false, results: [] },
        startedAt,
        completedAt: Date.now(),
        usage,
      },
    };
  }

  if (outcome.status === 'failed') {
    // A contract unit's failures are the runner's to read and retry (design 4.9).
    const retryLimit = unitSpawn ? 0 : getContractTransportRetryLimit(deps.configManager);
    if (item.transportRetryCount < retryLimit && await isTransportFailure(outcome.record?.error ?? '')) {
      item.transportRetryCount += 1;
      await worktree.cleanup(record.id).catch(() => undefined);
      await sleep(getContractTransportRetryDelayMs(deps.configManager));
      return runPhase(workstream, item, phase, priorReports, deps);
    }
    await worktree.cleanup(record.id).catch(() => undefined);
    return {
      agentStatus: 'failed',
      result: {
        itemId: item.id,
        phaseId: phase.id,
        agentId: record.id,
        report: genericReport(outcome.record?.error ?? 'agent failed'),
        gate: { passed: false, results: [] },
        startedAt,
        completedAt: Date.now(),
        usage,
      },
    };
  }

  const parsed = parseCompletionReport(outcome.record?.fullOutput ?? '');
  const report = parsed ?? genericReport(outcome.record?.fullOutput ?? '');

  // The files a report names, whatever the agent called its archetype.
  const named = parsed as Partial<Record<'filesCreated' | 'filesModified' | 'filesDeleted', unknown>> | null;
  for (const list of [named?.filesCreated, named?.filesModified, named?.filesDeleted]) {
    if (!Array.isArray(list)) continue;
    for (const path of list) if (typeof path === 'string' && !item.touchedPaths.includes(path)) item.touchedPaths.push(path);
  }

  // A contract unit only settles completed after its completion check passed,
  // which ran the gates and verified the claims; they are not run twice.
  const gate: GateOutcome = unitSpawn ? { passed: true, results: [] } : await evaluateGate(workstream, phase, parsed, deps);

  let commitExclusion: CommitExclusion | undefined;
  let commit: PhaseCommitOutcome | undefined;
  let bookkeeping: BookkeepingFailureReading | undefined;
  if (gate.passed) {
    const committed = await commitPhaseWork(item, phase, record.id, worktree, deps);
    commitExclusion = committed.exclusion;
    commit = committed.commit;
    bookkeeping = committed.bookkeeping;
  }
  // In worktree mode the item worktree persists across phases (the engine's
  // integration lane owns its teardown), so only the shared-mode transient
  // worktree gets cleaned up here.
  if (!deps.itemWorktree) {
    await worktree.cleanup(record.id).catch(() => undefined);
  }

  commit = currentFailureOutcome(commit, bookkeeping);
  return {
    agentStatus: signal.aborted ? 'cancelled' : 'completed',
    bookkeeping,
    result: {
      itemId: item.id,
      phaseId: phase.id,
      agentId: record.id,
      report,
      gate,
      startedAt,
      completedAt: Date.now(),
      usage,
      ...(commitExclusion ? { commitExclusion } : {}),
      ...(commit ? { commit } : {}),
    },
  };
}
