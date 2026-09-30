/**
 * Adaptive Execution Planner.
 *
 * Reads execution strategy through Jev using risk, latency, and
 * capability inputs. Emits typed reason codes for every decision and
 * maintains an explicit override path that is logged in full.
 *
 * Commands: /plan mode auto|single|cohort|background|remote
 *           /plan explain
 *           /plan override <strategy>
 */

import { judgmentPort } from '@goodvibes-jev/engine/errors';
import type { CallOptions, Outcome } from '@goodvibes-jev/judgment';
import { assertJudgmentInput } from '../gate/judgment-input.js';
import { executionStrategy } from './batteries/planner.js';
import { logger } from '../utils/logger.js';
import {
  assemblePlanProposal,
  singleItemProposal,
  type PlanProposal,
  type PlanProposalIssue,
  type RawDecomposition,
} from './plan-proposal.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The five supported execution strategies.
 *
 * - `auto`      , planner selects the best strategy each turn
 * - `single`    , one LLM call, no parallelism or agents
 * - `cohort`    , fan-out to a coordinated agent cohort
 * - `background`, defer execution to a background task
 * - `remote`    , delegate to a remote provider/agent endpoint
 */
export type ExecutionStrategy = 'auto' | 'single' | 'cohort' | 'background' | 'remote';

/** All valid strategy names (including 'auto'). Exported for use in command handlers. */
export const VALID_STRATEGIES: ExecutionStrategy[] = ['auto', 'single', 'cohort', 'background', 'remote'];

/**
 * Typed reason codes emitted with every strategy decision.
 *
 * Each code maps to a human-readable explanation available via
 * `AdaptivePlanner.explainReasonCode()`.
 */
export type StrategyReasonCode =
  // Selection reasons; legacy codes remain readable for older event/history consumers.
  | 'JUDGMENT_SELECTED'
  | 'JUDGMENT_UNSETTLED'
  | 'PINNED_MODE'
  | 'OVERRIDE_IN_EFFECT'           // user override is active
  | 'HIGH_RISK_SINGLE_PREFERRED'   // risk score too high for parallelism
  | 'LOW_LATENCY_SINGLE'           // latency budget favours minimal hops
  | 'COHORT_CAPABLE'               // task classified as multi-agent suitable
  | 'BACKGROUND_DEFERRED'          // task suitable for async execution
  | 'REMOTE_CAPABLE'               // remote provider available and suitable
  | 'AUTO_FALLBACK_SINGLE'         // auto mode fell back to single (default)
  // Override reasons
  | 'USER_OVERRIDE'                // explicit user /plan override command
  | 'FLAG_DISABLED'                // adaptive planner feature is turned off in settings
  // Error reasons
  | 'INVALID_STRATEGY';            // unrecognised strategy name

/** Inputs used by the scorer to rank strategy candidates. */
export interface PlannerInputs {
  /** 0-1 risk score: 0 = safe, 1 = highly uncertain / destructive */
  riskScore: number;

  /**
   * Available wall-clock budget in milliseconds.
   * `Infinity` means no latency constraint.
   */
  latencyBudgetMs: number;

  /** Whether the task is classified as multi-step/project (cohort eligible). */
  isMultiStep: boolean;

  /** Whether a remote agent endpoint is currently available. */
  remoteAvailable: boolean;

  /** Whether the task can be safely deferred to a background queue. */
  backgroundEligible: boolean;

  /** Free-form task description (used for logging and explain output). */
  taskDescription?: string | undefined;
}

/** A ranked strategy candidate produced by the scorer. */
export interface StrategyCandidate {
  strategy: ExecutionStrategy;
  score: number;       // higher = preferred
  reasonCode: StrategyReasonCode;
}

/**
 * The outcome of the deterministic "does this task warrant decomposition?"
 * gate. This is a semantic projection of the existing strategy selection,
 * `decompose` is simply `selected !== 'single'`, so every existing reason
 * code and the `/plan explain` output stay authoritative. No new scoring
 * logic lives here.
 */
export interface DecompositionGate {
  decompose: boolean;
  strategy: ExecutionStrategy;
  reasonCode: StrategyReasonCode;
}

/** The outcome of a planner selection pass. */
export interface PlannerDecision {
  /** The strategy that was ultimately selected. */
  selected: ExecutionStrategy;

  /** Primary reason code for the selection. */
  reasonCode: StrategyReasonCode;

  /** Full ranked list of all evaluated candidates. */
  candidates: StrategyCandidate[];

  /** Whether a user override was in effect when this decision was made. */
  overrideActive: boolean;

  /** Unix timestamp (ms) of this decision. */
  timestamp: number;

  /** Snapshot of inputs used for this decision. */
  inputs: PlannerInputs;
  /** Present for automatic choices, so history carries the reading and its band. */
  outcome?: Outcome;
  decisionId?: string | undefined;
}

// ---------------------------------------------------------------------------
// Reason code explanations
// ---------------------------------------------------------------------------

const REASON_EXPLANATIONS: Record<StrategyReasonCode, string> = {
  JUDGMENT_SELECTED: 'The recorded execution-strategy reading selected this available strategy.',
  JUDGMENT_UNSETTLED: 'The execution-strategy reading did not settle. No strategy was authorized.',
  PINNED_MODE: 'The owner explicitly pinned this strategy with /plan mode.',
  OVERRIDE_IN_EFFECT:
    'A user-supplied /plan override is in effect. The planner\'s automatic '
    + 'selection is bypassed until the override is cleared.',
  HIGH_RISK_SINGLE_PREFERRED:
    'The task risk score exceeds the threshold for parallel execution (>0.7). '
    + 'Single-agent execution is preferred to limit blast radius.',
  LOW_LATENCY_SINGLE:
    'The latency budget is tight (<5 s). Single-call execution avoids '
    + 'coordination overhead.',
  COHORT_CAPABLE:
    'The task is classified as multi-step and the risk score is low enough '
    + 'for coordinated agent fan-out.',
  BACKGROUND_DEFERRED:
    'The task is eligible for background execution: no latency constraint '
    + 'and backgroundEligible is true.',
  REMOTE_CAPABLE:
    'A remote agent endpoint is available and the task is not high risk.',
  AUTO_FALLBACK_SINGLE:
    'Auto mode found no strong signal for parallelism; defaulting to single.',
  USER_OVERRIDE:
    'The strategy was set explicitly by the user via /plan override.',
  FLAG_DISABLED:
    'The adaptive execution planner is turned off (see the planner.adaptive setting); using single.',
  INVALID_STRATEGY:
    'The supplied strategy name is not recognised. No change was made.',
};

/** An automatic choice that cannot authorize execution, without a guessed fallback. */
export class PlannerJudgmentError extends Error {
  override readonly name = 'PlannerJudgmentError';
  constructor(readonly reason: 'unsettled' | 'unavailable-strategy') {
    super(reason === 'unsettled'
      ? 'The execution strategy reading did not settle; an owner decision is required.'
      : 'The execution strategy reading selected an unavailable capability; no work was started.');
  }
}

// ---------------------------------------------------------------------------
// AdaptivePlanner
// ---------------------------------------------------------------------------

export class AdaptivePlanner {
  /** Current user override, or null when the planner runs freely. */
  private overrideStrategy: ExecutionStrategy | null = null;

  /** Current operating mode (default: auto). */
  private mode: ExecutionStrategy = 'auto';

  /** Audit log of all decisions, capped at MAX_HISTORY entries. */
  private history: PlannerDecision[] = [];
  private static readonly MAX_HISTORY = 100;

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Select the best execution strategy for the given inputs.
   *
   * - If a user override is active, it is returned immediately with reason
   *   `OVERRIDE_IN_EFFECT`.
   * - If mode is not `auto`, the mode itself is returned (as a pinned choice).
   * - Otherwise a registered reading selects a strategy; uncertainty holds the work.
   *
   * The decision is appended to the history log.
   */
  async select(inputs: PlannerInputs, options: CallOptions = {}): Promise<PlannerDecision> {
    options.signal?.throwIfAborted();
    const validated = this._validateInputs(inputs);
    // Materialize once before preflight; later reads must not revisit caller getters.
    assertJudgmentInput({ task: validated.taskDescription ?? '' });
    const ts = Date.now();
    // Use validated inputs from here on
    // eslint-disable-next-line no-param-reassign
    inputs = validated;

    // User override takes absolute precedence
    if (this.overrideStrategy !== null) {
      const decision: PlannerDecision = {
        selected: this.overrideStrategy,
        reasonCode: 'OVERRIDE_IN_EFFECT',
        candidates: [{ strategy: this.overrideStrategy, score: 100, reasonCode: 'USER_OVERRIDE' }],
        overrideActive: true,
        timestamp: ts,
        inputs,
      };
      this._appendHistory(decision);
      logger.debug('[AdaptivePlanner] override in effect', { strategy: this.overrideStrategy });
      return decision;
    }

    // Pinned mode (not auto)
    if (this.mode !== 'auto') {
      const score = 100;
      const reasonCode: StrategyReasonCode = 'PINNED_MODE';
      const decision: PlannerDecision = {
        selected: this.mode,
        reasonCode,
        candidates: [{ strategy: this.mode, score, reasonCode }],
        overrideActive: false,
        timestamp: ts,
        inputs,
      };
      this._appendHistory(decision);
      return decision;
    }

    const run = await executionStrategy.run(judgmentPort('engine.core.planner'), {
      task: inputs.taskDescription ?? '',
      riskScore: inputs.riskScore,
      latencyBudgetMs: Number.isFinite(inputs.latencyBudgetMs) ? inputs.latencyBudgetMs : 'unbounded',
      isMultiStep: inputs.isMultiStep,
      remoteAvailable: inputs.remoteAvailable,
      backgroundEligible: inputs.backgroundEligible,
    }, { site: 'engine.core.planner', ...options });
    options.signal?.throwIfAborted();
    // An owner override that arrived during a slow reading supersedes it.
    if (this.overrideStrategy !== null || this.mode !== 'auto') {
      run.recordAction('superseded by owner strategy change');
      return this.select(inputs, options);
    }
    const reading = run.readings.strategy;
    const available = reading.choice !== 'remote' || inputs.remoteAvailable;
    const canRun = available && (reading.choice !== 'background' || inputs.backgroundEligible);
    const settled = reading.outcome === 'act' && canRun;
    const candidates: StrategyCandidate[] = (['single', 'cohort', 'background', 'remote'] as const)
      .map((strategy) => ({ strategy, score: reading.probabilities[strategy] * 100, reasonCode: 'JUDGMENT_SELECTED' as const }))
      .sort((a, b) => b.score - a.score);
    const decision: PlannerDecision = {
      selected: settled ? reading.choice : 'auto',
      reasonCode: settled ? 'JUDGMENT_SELECTED' : 'JUDGMENT_UNSETTLED',
      candidates,
      overrideActive: false,
      timestamp: ts,
      inputs,
      outcome: reading.outcome,
      decisionId: run.result.decisionId,
    };
    run.recordAction(settled ? `selected ${reading.choice}` : `held: ${canRun ? reading.outcome : 'unavailable capability'}`);
    this._appendHistory(decision);
    if (!settled) throw new PlannerJudgmentError(canRun ? 'unsettled' : 'unavailable-strategy');
    logger.debug('[AdaptivePlanner] judgment selected', { strategy: reading.choice, outcome: reading.outcome, decisionId: run.result.decisionId });
    return decision;
  }

  /**
   * Deterministic gate: does this task warrant decomposition into a
   * multi-phase workstream, or is a single-item workstream the honest
   * answer?
   *
   * This calls the existing `select()` pipeline, no new scoring logic, and
   * projects the result: `decompose` is `selected !== 'single'`. Because it
   * goes through `select()`, the decision is appended to the same audit
   * history as every other planner call, and `/plan explain` / `/plan
   * status` remain authoritative for it.
   */
  async shouldDecompose(inputs: PlannerInputs, options: CallOptions = {}): Promise<DecompositionGate> {
    const decision = await this.select(inputs, options);
    return {
      decompose: decision.selected !== 'single',
      strategy: decision.selected,
      reasonCode: decision.reasonCode,
    };
  }

  /**
   * Produce a typed `PlanProposal` for the given inputs.
   *
   * `AdaptivePlanner` never spawns a planning agent and never performs LLM
   * decomposition itself, it only gates (via `shouldDecompose`) and
   * validates/assembles (via `assemblePlanProposal`, in `plan-proposal.ts`).
   * The raw decomposition, if any, is expected to come from a planning
   * agent that the ORCHESTRATION ENGINE spawns and hands back here.
   *
   * - If the gate says decomposition is not warranted, or no raw
   *   decomposition is available yet, this returns the honest single-item
   *   fallback (`singleItemProposal`), never a partially-assembled guess.
   * - Otherwise it validates `raw` via `assemblePlanProposal`, which never
   *   throws: malformed decompositions degrade to an honest partial result
   *   plus a list of `issues`.
   *
   * Returns the `gate` alongside the proposal so callers (the engine, or the
   * TUI) can show WHY a proposal was or wasn't decomposed, reusing
   * `AdaptivePlanner.explainReasonCode`.
   */
  async proposeWorkstream(
    inputs: PlannerInputs,
    raw?: RawDecomposition,
    options: CallOptions = {},
  ): Promise<{ proposal: PlanProposal; gate: DecompositionGate; issues: PlanProposalIssue[] }> {
    const gate = await this.shouldDecompose(inputs, options);
    const task = inputs.taskDescription ?? '';
    if (gate.decompose && raw) {
      const { proposal, issues } = assemblePlanProposal(task, gate.strategy, raw);
      return { proposal, gate, issues };
    }
    return { proposal: singleItemProposal(task), gate, issues: [] };
  }

  /**
   * Set the operating mode for future calls to `select()`.
   *
   * Setting to `'auto'` clears any pinned mode (but does NOT clear a user
   * override, use `clearOverride()` for that).
   */
  setMode(mode: ExecutionStrategy): void {
    this.mode = mode;
    logger.info('[AdaptivePlanner] mode set', { mode });
  }

  /** Get the current operating mode. */
  getMode(): ExecutionStrategy {
    return this.mode;
  }

  /**
   * Apply an explicit user override. Overrides are stronger than mode: even
   * in `auto` mode the override strategy is always returned until cleared.
   *
   * Returns `false` with reason `INVALID_STRATEGY` if the strategy name is
   * not recognised.
   */
  override(
    strategy: string,
  ): { ok: true; strategy: ExecutionStrategy } | { ok: false; reasonCode: StrategyReasonCode } {
    if (!VALID_STRATEGIES.includes(strategy as ExecutionStrategy)) {
      logger.warn('[AdaptivePlanner] invalid override strategy', { strategy });
      return { ok: false, reasonCode: 'INVALID_STRATEGY' };
    }
    const s = strategy as ExecutionStrategy;
    this.overrideStrategy = s === 'auto' ? null : s;
    logger.info('[AdaptivePlanner] user override applied', { strategy: s });
    return { ok: true, strategy: s };
  }

  /** Clear any active user override. */
  clearOverride(): void {
    this.overrideStrategy = null;
    logger.info('[AdaptivePlanner] user override cleared');
  }

  /** Whether a user override is currently active. */
  hasOverride(): boolean {
    return this.overrideStrategy !== null;
  }

  /** Return the active override strategy, or null. */
  getOverride(): ExecutionStrategy | null {
    return this.overrideStrategy;
  }

  /**
   * Return a human-readable explanation of the most recent decision, or of
   * a specific reason code.
   */
  explain(reasonCode?: StrategyReasonCode): string {
    if (reasonCode) {
      return REASON_EXPLANATIONS[reasonCode] ?? `Unknown reason code: ${reasonCode}`;
    }
    const last = this.history[this.history.length - 1];
    if (!last) return 'No decisions have been made yet.';
    return this._formatDecisionExplanation(last);
  }

  /** Return the full static explanation for a reason code. */
  static explainReasonCode(code: StrategyReasonCode): string {
    return REASON_EXPLANATIONS[code] ?? `Unknown reason code: ${code}`;
  }

  /** Return the N most recent decisions (default: 20). */
  getHistory(limit = 20): PlannerDecision[] {
    return this.history.slice(-limit);
  }

  /** Return the most recent decision, or null. */
  getLatest(): PlannerDecision | null {
    return this.history[this.history.length - 1] ?? null;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Validate and clamp PlannerInputs to safe ranges.
   * Logs a debug warning if any value is out of range.
   */
  private _validateInputs(inputs: PlannerInputs): PlannerInputs {
    const out = { ...inputs };
    if (isNaN(out.riskScore) || out.riskScore < 0 || out.riskScore > 1) {
      logger.debug('[AdaptivePlanner] riskScore out of range, clamping', { riskScore: out.riskScore });
      out.riskScore = isNaN(out.riskScore) ? 0 : Math.max(0, Math.min(1, out.riskScore));
    }
    if (out.latencyBudgetMs < 0) {
      logger.debug('[AdaptivePlanner] latencyBudgetMs negative, clamping to 0', { latencyBudgetMs: out.latencyBudgetMs });
      out.latencyBudgetMs = 0;
    }
    return out;
  }

  private _appendHistory(decision: PlannerDecision): void {
    this.history.push(decision);
    if (this.history.length > AdaptivePlanner.MAX_HISTORY) {
      this.history.shift();
    }
  }

  private _formatDecisionExplanation(decision: PlannerDecision): string {
    const ts = new Date(decision.timestamp).toISOString();
    const override = decision.overrideActive ? ' [USER OVERRIDE]' : '';
    const lines = [
      `Strategy: ${decision.selected.toUpperCase()}${override}`,
      `Reason:   ${decision.reasonCode}`,
      `          ${REASON_EXPLANATIONS[decision.reasonCode]}`,
      `At:       ${ts}`,
      '',
      'Candidate rankings:',
      ...decision.candidates.map(
        (c) => `  ${String(c.score).padStart(3)}  ${c.strategy.padEnd(12)} ${c.reasonCode}`,
      ),
    ];
    const inputs = decision.inputs;
    lines.push(
      '',
      'Inputs:',
      `  riskScore:         ${inputs.riskScore.toFixed(2)}`,
      `  latencyBudgetMs:   ${inputs.latencyBudgetMs === Infinity ? '∞' : inputs.latencyBudgetMs}`,
      `  isMultiStep:       ${inputs.isMultiStep}`,
      `  remoteAvailable:   ${inputs.remoteAvailable}`,
      `  backgroundEligible: ${inputs.backgroundEligible}`,
    );
    if (inputs.taskDescription) {
      lines.push(`  task:              ${inputs.taskDescription.slice(0, 80)}`);
    }
    return lines.join('\n');
  }
}
