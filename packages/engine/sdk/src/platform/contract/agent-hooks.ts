/**
 * The seams the sub-agent loop (`runAgentTask`, agents/orchestrator-runner.ts)
 * calls for a contract-bound agent (docs/design/contract-runner.md section
 * 4.1), and the runner's side of them: the nudge loop (sections 4.2 to 4.7).
 *
 * The runner installs one implementation through `AgentOrchestrator`'s tool
 * dependencies; the loop calls it only for an agent whose record carries a
 * `contractUnitId`, so every other agent runs exactly as before.
 *
 * - A turn that wrote, edited or ran a command starts a mid-run check (when
 *   `contract.midRunChecks` is on). At most one check per unit is in flight: a
 *   turn end during a check asks for one more check after it.
 * - When the agent would complete, it is held. A completion check supersedes a
 *   mid-run check still in flight (that result is discarded) and runs with
 *   full evidence. The hold releases only on a pass; any other finding goes
 *   back to the agent as a nudge and it keeps working.
 * - A nudge reaches a held agent through its hold, a running agent through the
 *   message bus as a steer, and a stopped agent by waking it.
 *
 * Nothing here judges: the readings come from check.ts, and the mapping from
 * readings to outcomes is code there and in progress.ts.
 */
import type { AgentMessageBus } from '../agents/message-bus.js';
import type { AgentRecord } from '../tools/agent/index.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { applySeverities, applyUnitCheck, checkSettings, readUnmetSeverities, runUnitCheck, type DecidedCheck, type UnitCheckOutcome } from './check.js';
import type { ContractConfigReader } from './config.js';
import { collectUnitEvidence, type ContractTurnRecord } from './evidence.js';
import { createNudge, dispatchNudge, type NudgeTargetState } from './nudge.js';
import { describeStall } from './progress.js';
import { failureFromError, isAbortError, type ContractRun, type InFlightCheck, type UnitRuntime } from './run-context.js';
import { isTerminalUnitStatus, type CheckTrigger, type ContractFailureKind, type ContractUnit } from './types.js';
import { addJudgmentUsage } from './usage.js';
import type { UnitWatchdog } from './watchdog.js';

/**
 * What the completion hold returns. `release` lets the agent complete;
 * `continue` keeps its loop open and adds `message` (the nudge text, verbatim)
 * as the next user turn, and the loop reports `nudgeId` consumed once the
 * following model call succeeds.
 */
export type ContractHoldOutcome =
  | { readonly kind: 'release' }
  | { readonly kind: 'continue'; readonly message: string; readonly nudgeId: string };

export interface ContractAgentHooks {
  /**
   * After a turn's tool calls ran and their results joined the conversation.
   * Never awaited by the loop, and a throw is logged, not propagated.
   */
  onTurnEnd(record: AgentRecord, turn: ContractTurnRecord): void;
  /** When the agent would complete. The loop awaits it before finishing. */
  holdCompletion(record: AgentRecord): Promise<ContractHoldOutcome>;
}

// ── The runner's side ─────────────────────────────────────────────────────────

/** The tools whose use makes a turn worth a mid-run check (design 4.2). */
export const CHANGING_TOOLS: ReadonlySet<string> = new Set(['write', 'edit', 'exec']);

/** What the correction and completion steps (R.6) are asked to do; the runner calls them when a check needs more than a nudge. */
export interface UnitCheckEscalations {
  /** The unit stalled (4.8): route it to a planned fix, a fresh agent or the owner (5.1). Its hold stays until correction takes over. */
  unitStalled(run: ContractRun, unitId: string, check: DecidedCheck): Promise<void>;
  /** Unsettled readings reached `contract.evidenceNudgeLimit` (4.6): ask the owner to confirm (6.3). */
  unitAwaitsOwner(run: ContractRun, unitId: string, check: DecidedCheck): Promise<void>;
}

export interface UnitCheckLoopDeps {
  readonly findRun: (contractId: string) => ContractRun | undefined;
  readonly agentManager: {
    getStatus(agentId: string): AgentRecord | null;
    wakeWithSteer(agentId: string, steer: string, options?: { readonly allowCompleted?: boolean }): { readonly woke: boolean; readonly reason: string };
  };
  readonly messageBus: Pick<AgentMessageBus, 'send'>;
  readonly configManager: ContractConfigReader;
  readonly runtimeBus: RuntimeEventBus;
  readonly watchdog: UnitWatchdog;
  readonly escalations: UnitCheckEscalations;
  readonly failContract: (run: ContractRun, kind: ContractFailureKind, reason: string) => void;
  /** A unit reached passed (or held-merge): the group may be done. */
  readonly unitPassed: (run: ContractRun, unit: ContractUnit) => void;
  /** Gives the unit a fresh agent with its brief, "Previous checks" and `firstTurn` after them. */
  readonly respawnUnit: (run: ContractRun, unit: ContractUnit, reason: string, firstTurn: string) => void;
}

export interface UnitCheckLoop {
  readonly hooks: ContractAgentHooks;
  /** Runs one check of a unit now. */
  runCheck(run: ContractRun, unit: ContractUnit, trigger: CheckTrigger): Promise<void>;
  /** Marks a check in flight as superseded and stops it. */
  supersede(runtime: UnitRuntime): void;
}

/** Statuses in which a unit's agent is working and a mid-run check may start. */
const WORKING: ReadonlySet<ContractUnit['status']> = new Set(['running', 'nudged']);

export function createUnitCheckLoop(deps: UnitCheckLoopDeps): UnitCheckLoop {
  function locate(record: AgentRecord): { readonly run: ContractRun; readonly unit: ContractUnit; readonly runtime: UnitRuntime } | null {
    if (record.contractId === undefined || record.contractUnitId === undefined) return null;
    const run = deps.findRun(record.contractId);
    if (run === undefined || run.terminal) return null;
    const unit = run.unit(record.contractUnitId);
    if (unit === undefined || unit.activeAgentId !== record.id) return null;
    return { run, unit, runtime: run.runtime(unit) };
  }

  function supersede(runtime: UnitRuntime): void {
    const check = runtime.check;
    if (check === null) return;
    check.superseded = true;
    check.abort.abort();
    runtime.check = null;
    runtime.recheckPending = false;
  }

  function onTurnEnd(record: AgentRecord, turn: ContractTurnRecord): void {
    const found = locate(record);
    if (found === null) return;
    const { run, unit, runtime } = found;
    runtime.turns.push(turn);
    if (turn.assistantText.trim().length > 0) runtime.lastAssistantText = turn.assistantText;
    deps.watchdog.touch(record.id);
    if (!turn.toolCalls.some((call) => CHANGING_TOOLS.has(call.name))) return;
    if (!run.env.config().midRunChecks || !WORKING.has(unit.status)) return;
    if (runtime.check !== null) {
      runtime.recheckPending = true;
      return;
    }
    void runCheck(run, unit, 'turn-end');
  }

  function holdCompletion(record: AgentRecord): Promise<ContractHoldOutcome> {
    const found = locate(record);
    if (found === null) return Promise.resolve({ kind: 'release' });
    const { run, unit, runtime } = found;
    if (!WORKING.has(unit.status) && unit.status !== 'checking') return Promise.resolve({ kind: 'release' });
    supersede(runtime);
    return new Promise<ContractHoldOutcome>((resolve) => {
      runtime.hold = { agentId: record.id, resolve };
      run.moveUnit(unit, 'held');
      void runCheck(run, unit, 'completion');
    });
  }

  /** Where the unit's agent is, for delivering a nudge (4.7). */
  function targetState(unit: ContractUnit, runtime: UnitRuntime): NudgeTargetState | 'stopped' {
    if (runtime.hold !== null) return 'held';
    const record = unit.activeAgentId === undefined ? null : deps.agentManager.getStatus(unit.activeAgentId);
    if (record === null) return 'gone';
    if (record.status === 'running' || record.status === 'pending') return 'running';
    if (record.status === 'failed') return 'failed';
    if (record.status === 'completed') return 'completed';
    return 'stopped';
  }

  async function runCheck(run: ContractRun, unit: ContractUnit, trigger: CheckTrigger): Promise<void> {
    const runtime = run.runtime(unit);
    const config = run.env.config();
    const check: InFlightCheck = { trigger, abort: new AbortController(), superseded: false };
    runtime.check = check;
    if (unit.status !== 'held') run.moveUnit(unit, 'checking');
    const signal = AbortSignal.any([runtime.abort.signal, check.abort.signal, run.abort.signal]);
    let outcome: UnitCheckOutcome;
    let output: string;
    try {
      const record = unit.activeAgentId === undefined ? null : deps.agentManager.getStatus(unit.activeAgentId);
      output = trigger === 'turn-end' ? runtime.lastAssistantText : (record?.fullOutput ?? runtime.lastAssistantText);
      const evidence = await collectUnitEvidence(run.contract, unit, trigger, {
        output,
        turns: runtime.turns,
        cwd: runtime.cwd,
        configManager: deps.configManager,
        runtimeBus: deps.runtimeBus,
      });
      if (check.superseded || signal.aborted) return;
      outcome = await runUnitCheck({ contract: run.contract, unit, trigger, evidence, settings: checkSettings(config), now: run.env.now(), signal });
    } catch (error) {
      if (runtime.check === check) runtime.check = null;
      if (check.superseded || isAbortError(error, signal) || run.terminal) return;
      const failure = failureFromError(error);
      deps.failContract(run, failure.kind, `the check of unit ${unit.id} could not run: ${failure.reason}`);
      return;
    }
    if (runtime.check === check) runtime.check = null;
    addJudgmentUsage(run.contract.judgmentUsage, outcome.usage);
    if (outcome.discarded) return;
    if (check.superseded || run.terminal || isTerminalUnitStatus(unit.status)) {
      outcome.recordAction(check.superseded ? 'discarded: superseded by the completion check' : 'discarded: the unit already ended');
      return;
    }
    record(run, unit, outcome);
    await act(run, unit, runtime, outcome, output);
    if (runtime.recheckPending && runtime.check === null && WORKING.has(unit.status)) {
      runtime.recheckPending = false;
      void runCheck(run, unit, 'turn-end');
    }
  }

  /** Applies a decided check to the tree and reports it. */
  function record(run: ContractRun, unit: ContractUnit, outcome: DecidedCheck): void {
    const { check } = outcome;
    applyUnitCheck(unit, outcome);
    for (const regression of outcome.regressions) {
      run.decide('regressed', regression.criterionId, `met at ${regression.metAtCheckId}, unmet at ${check.id}`, check.decisionIds);
      run.emit({ type: 'CONTRACT_CRITERION_REGRESSED', contractId: run.id, unitId: unit.id, criterionId: regression.criterionId, metAtCheckId: regression.metAtCheckId, checkId: check.id });
    }
    run.decide('checked', unit.id, `check ${check.id} (${check.trigger}): ${check.result}`, check.decisionIds);
    run.emit({
      type: 'CONTRACT_CHECKED',
      contractId: run.id,
      scope: 'unit',
      targetId: unit.id,
      checkId: check.id,
      trigger: check.trigger,
      result: check.result,
      criteria: [...outcome.readings].map(([criterionId, reading]) => ({ criterionId, verdict: reading.verdict, probabilityUnmet: reading.probabilityUnmet, outcome: reading.outcome })),
      goal: { verdict: check.goal.verdict, outcome: check.goal.outcome },
      quality: Object.entries(check.quality).map(([item, reading]) => ({ item: item as keyof typeof check.quality, verdict: reading.verdict, outcome: reading.outcome })),
      gates: (check.gates ?? []).map((gate) => ({ gate: gate.gate, passed: gate.passed, skipped: gate.skipped === true })),
      ...(check.claims === undefined ? {} : { claims: check.claims.kind }),
      decisionIds: check.decisionIds,
    });
  }

  async function act(run: ContractRun, unit: ContractUnit, runtime: UnitRuntime, outcome: DecidedCheck, output: string): Promise<void> {
    const { check } = outcome;
    if (check.result === 'recorded') {
      if (unit.status === 'checking') run.moveUnit(unit, 'running');
      outcome.recordAction('recorded');
      return;
    }
    if (check.result === 'nudge') {
      deliver(run, unit, runtime, outcome);
      return;
    }
    if (check.result === 'pass') {
      pass(run, unit, runtime, outcome, output);
      return;
    }
    try {
      if (check.result === 'stall') {
        run.decide('stalled', unit.id, describeStall(outcome.stall!), check.decisionIds);
        await deps.escalations.unitStalled(run, unit.id, outcome);
      } else {
        await deps.escalations.unitAwaitsOwner(run, unit.id, outcome);
      }
    } catch (error) {
      if (run.terminal) return;
      const failure = failureFromError(error);
      deps.failContract(run, failure.kind, `unit ${unit.id} could not be routed after check ${check.id}: ${failure.reason}`);
    }
  }

  function pass(run: ContractRun, unit: ContractUnit, runtime: UnitRuntime, outcome: DecidedCheck, output: string): void {
    unit.answer = output;
    outcome.recordAction('passed');
    // Worktree mode: the unit's branch still has to merge into the contract branch.
    run.moveUnit(unit, run.contract.isolation === 'worktree' ? 'held-merge' : 'passed');
    if (runtime.hold !== null) {
      run.releaseHold(unit);
    } else {
      // The agent already stopped (a turn-budget stop whose work passes, or an
      // agent that completed without a hold): its phase settles now.
      run.settle(unit, 'completed');
    }
    deps.unitPassed(run, unit);
  }

  function deliver(run: ContractRun, unit: ContractUnit, runtime: UnitRuntime, outcome: DecidedCheck): void {
    const { check } = outcome;
    const found = outcome.nudge;
    if (found === undefined) throw new Error(`check ${check.id} decided a nudge without its text`);
    const state = targetState(unit, runtime);
    if (state === 'stopped' || (check.trigger === 'turn-end' && state !== 'running')) {
      // A mid-run nudge for an agent that has since stopped: its next check (completion or failure) reads everything again.
      if (unit.status === 'checking') run.moveUnit(unit, 'running');
      outcome.recordAction('recorded: the agent stopped before a mid-run nudge could reach it');
      return;
    }
    const agentId = unit.activeAgentId!;
    const nudge = createNudge({
      unit,
      checkId: check.id,
      kinds: found.kinds,
      criterionIds: found.criterionIds,
      text: found.text,
      delivery: state === 'held' ? 'hold' : state === 'running' ? 'bus' : 'wake',
      agentId,
      at: run.env.now(),
    });
    unit.nudges.push(nudge);
    run.moveUnit(unit, 'nudged');
    run.decide('nudged', unit.id, `check ${check.id}: ${found.kinds.join(', ')} (${nudge.delivery})`, check.decisionIds);
    run.emit({ type: 'CONTRACT_NUDGED', contractId: run.id, unitId: unit.id, nudgeId: nudge.id, checkId: check.id, kinds: nudge.kinds, criterionIds: nudge.criterionIds, delivery: nudge.delivery, agentId });
    outcome.recordAction(`nudged (${nudge.delivery})`);
    if (state === 'gone') {
      deps.respawnUnit(run, unit, `the agent for unit ${unit.id} is gone; a fresh agent takes the nudge`, nudge.text);
    } else {
      const sent = dispatchNudge(nudge, state, { messageBus: deps.messageBus, agentManager: deps.agentManager, nudgeTtlMs: run.env.config().nudgeTtlMs });
      if (sent.kind === 'continue') run.releaseHold(unit, sent);
      else if (sent.kind === 'woke') run.decide('woke', unit.id, `woke ${agentId} from ${state} with nudge ${nudge.id}`, check.decisionIds);
      else if (sent.kind === 'undelivered') deps.respawnUnit(run, unit, `nudge ${nudge.id} could not reach ${agentId}: ${sent.reason}`, nudge.text);
    }
    if (outcome.unmetCriterionIds.length > 0) void readSeverities(run, unit, runtime, check.id, outcome.unmetCriterionIds);
  }

  /** Severity of the unmet criteria, read after the nudge went out so it never delays one. */
  async function readSeverities(run: ContractRun, unit: ContractUnit, runtime: UnitRuntime, checkId: string, criterionIds: readonly string[]): Promise<void> {
    try {
      const read = await readUnmetSeverities({ contract: run.contract, unit, criterionIds, signal: runtime.abort.signal });
      addJudgmentUsage(run.contract.judgmentUsage, read.usage);
      if (run.terminal) return;
      applySeverities(unit, checkId, read.severities);
    } catch (error) {
      if (isAbortError(error, runtime.abort.signal) || run.terminal) return;
      const failure = failureFromError(error);
      if (failure.kind === 'judgment-unavailable') {
        deps.failContract(run, failure.kind, `severity of unit ${unit.id}'s unmet criteria could not be read: ${failure.reason}`);
        return;
      }
      logger.warn('contract runner: severity reading did not complete', { contractId: run.id, unitId: unit.id, error: summarizeError(error) });
    }
  }

  return { hooks: { onTurnEnd, holdCompletion }, runCheck, supersede };
}
