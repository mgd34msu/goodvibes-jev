/**
 * manager.ts
 *
 * CompactionManager, orchestrates the full compaction lifecycle state machine.
 *
 * Responsibilities:
 * - Gate all compaction behind the `session-compaction` capability gate (behavior.compactionStrategy)
 * - Drive state transitions (idle → checking_threshold → strategy → boundary_commit → done/failed)
 * - Select and execute the appropriate compaction strategy
 * - Create boundary commits with lineage tracking
 * - Emit CompactionEvents at each transition
 * - Expose the resume repair pipeline
 * - Own the lifecycle of a compaction the session itself runs (`runLifecycle`):
 *   the orchestrator's conversation compaction goes through the session's
 *   manager, so every real compaction moves the state machine, emits the
 *   lifecycle events and leaves a boundary commit
 */

import { logger } from '../../utils/logger.js';
import type { RuntimeEventBus } from '../events/index.js';
import type { FeatureFlagManager } from '../feature-flags/manager.js';
import type { EmitterContext } from '../emitters/index.js';
import {
  applyTransition,
  selectStrategy,
  strategyToState,
} from './lifecycle.js';
import {
  runMicrocompact,
  runCollapse,
  runAutocompact,
  runReactive,
  createBoundaryCommit,
  validateBoundaryCommit,
} from './strategies/index.js';
import { runResumeRepair } from './resume-repair.js';
import type {
  BoundaryCommit,
  CompactionLifecycleResult,
  CompactionLifecycleState,
  CompactionStrategy,
  CompactionTrigger,
  StrategyInput,
  StrategyOutput,
} from './types.js';
import type { ResumeRepairResult } from './types.js';
import {
  emitCompactionCheck,
  emitCompactionDone,
  emitCompactionFailed,
  emitCompactionBoundaryCommit,
  emitCompactionMicrocompact,
  emitCompactionCollapse,
  emitCompactionAutocompact,
  emitCompactionReactive,
  emitCompactionQualityScore,
  emitCompactionStrategySwitch,
} from '../emitters/compaction.js';
import { computeQualityScore, escalateStrategy, LOW_QUALITY_THRESHOLD } from './quality-score.js';
import type { CompactionQualityScore } from './quality-score.js';
import type { ProviderMessage } from '../../providers/interface.js';
import { summarizeError } from '../../utils/error-display.js';

// ---------------------------------------------------------------------------
// Manager options
// ---------------------------------------------------------------------------

/** Options for constructing a CompactionManager. */
export interface CompactionManagerOptions {
  /** Session ID for event correlation. */
  sessionId: string;
  /** Runtime event bus for emitting CompactionEvents. */
  bus: RuntimeEventBus;
  /** Capability-gate manager, used to gate on `session-compaction`. */
  flags: FeatureFlagManager;
  /**
   * Model context window size (tokens). A function is read at each use, so a
   * session whose model changes keeps the window of the model in play.
   */
  contextWindow: number | (() => number);
  /** Threshold fraction at which compaction is triggered (default: 0.75). */
  thresholdFraction?: number | undefined;
}

/**
 * What a compaction the session ran applied, as `runLifecycle` records it in
 * the boundary commit.
 */
export interface SessionCompactionOutcome {
  /** The conversation as the compaction left it. */
  messages: ProviderMessage[];
  /** Estimated tokens after the compaction. */
  tokensAfter: number;
  /** Human-readable summary stored with the boundary commit. */
  summary: string;
  /** Warnings the compaction reported. */
  warnings?: string[] | undefined;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/**
 * CompactionManager, manages the full lifecycle of session context compaction.
 *
 * All compaction is gated behind the `session-compaction` capability gate.
 * When the flag is disabled, `compact()` is a no-op and returns the original
 * messages unchanged.
 *
 * Usage:
 * ```ts
 * const manager = createCompactionManager({ sessionId, bus, flags, contextWindow });
 * const result = await manager.compact({ messages, tokenCount: 45000, trigger: 'auto' });
 * ```
 */
export class CompactionManager {
  private readonly _sessionId: string;
  private readonly _bus: RuntimeEventBus;
  private readonly _flags: FeatureFlagManager;
  private readonly _readContextWindow: () => number;
  private readonly _thresholdFraction: number;

  /** Tail of the serialized lifecycle runs (one run at a time per session). */
  private _runChain: Promise<unknown> = Promise.resolve();

  /** Set by dispose(); a disposed manager starts no run and emits nothing. */
  private _disposed = false;

  /** Current state machine state. */
  private _state: CompactionLifecycleState = 'idle';

  /** Most recent boundary commit (null until first successful compaction). */
  private _lastCommit: BoundaryCommit | null = null;

  /** Emitter context used for all event emissions. */
  private readonly _ctx: EmitterContext;

  constructor(opts: CompactionManagerOptions) {
    this._sessionId = opts.sessionId;
    this._bus = opts.bus;
    this._flags = opts.flags;
    const window = opts.contextWindow;
    this._readContextWindow = typeof window === 'function' ? window : () => window;
    this._thresholdFraction = opts.thresholdFraction ?? 0.75;
    this._ctx = {
      sessionId: opts.sessionId,
      source: 'compaction-manager',
      traceId: crypto.randomUUID(),
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Returns the current lifecycle state. */
  get state(): CompactionLifecycleState {
    return this._state;
  }

  /** True once dispose() has run. */
  get disposed(): boolean {
    return this._disposed;
  }

  /** Model context window in play (tokens). */
  private get _contextWindow(): number {
    return this._readContextWindow();
  }

  /** Returns the most recent boundary commit, or null. */
  get lastCommit(): BoundaryCommit | null {
    return this._lastCommit;
  }

  /**
   * Options for a compaction run.
   */

  /**
   * Runs the compaction lifecycle for the given messages and trigger.
   *
   * If session compaction is off (behavior.compactionStrategy 'off'), returns the
   * original messages unchanged with no events emitted.
   *
   * @param opts - Run options.
   * @returns Lifecycle result, or null if gated/skipped.
   */
  async compact(opts: {
    messages: ProviderMessage[];
    tokenCount: number;
    trigger: CompactionTrigger;
    isPromptTooLong?: boolean | undefined;
  }): Promise<CompactionLifecycleResult | null> {
    // ── Capability gate ──────────────────────────────────────────────────────
    if (!this._flags.isEnabled('session-compaction')) {
      logger.debug('[CompactionManager] session compaction is off (behavior.compactionStrategy); skipping', {
        sessionId: this._sessionId,
      });
      return null;
    }

    const runStart = Date.now();
    const { messages, tokenCount, trigger, isPromptTooLong } = opts;
    const threshold = Math.floor(this._contextWindow * this._thresholdFraction);

    // ── Transition: idle → checking_threshold ────────────────────────────────
    this._transition('checking_threshold');

    emitCompactionCheck(this._bus, this._ctx, {
      sessionId: this._sessionId,
      tokenCount,
      threshold,
    });

    // ── Check threshold ──────────────────────────────────────────────────────
    if (trigger === 'auto' && !isPromptTooLong && tokenCount < threshold) {
      // Below threshold, go straight to done without compacting
      this._transition('done');
      this._transition('idle');
      logger.debug('[CompactionManager] below threshold; no compaction needed', {
        sessionId: this._sessionId,
        tokenCount,
        threshold,
      });
      return null;
    }

    // ── Select strategy ──────────────────────────────────────────────────────
    let strategy = selectStrategy({
      trigger,
      currentTokens: tokenCount,
      contextWindow: this._contextWindow,
      isPromptTooLong,
    });
    const strategyState = strategyToState(strategy);

    // ── Transition: checking_threshold → <strategy state> ────────────────────
    this._transition(strategyState);

    // ── Execute strategy ─────────────────────────────────────────────────────
    let strategyOutput: StrategyOutput;
    let qualityScore: CompactionQualityScore | null = null;
    let strategySwitchReason: string | null = null;

    const strategyInput: StrategyInput = {
      sessionId: this._sessionId,
      messages,
      tokensBefore: tokenCount,
      contextWindow: this._contextWindow,
      strategy,
      meta: isPromptTooLong !== undefined ? { isPromptTooLong } : undefined,
    };

    try {
      strategyOutput = await this._runStrategy(strategy, strategyInput);
    } catch (err) {
      const error = summarizeError(err);
      this._transition('failed');
      emitCompactionFailed(this._bus, this._ctx, {
        sessionId: this._sessionId,
        strategy,
        error,
      });
      this._transition('idle');
      logger.error('[CompactionManager] strategy execution failed', {
        sessionId: this._sessionId,
        strategy,
        error,
      });
      return null;
    }

    // ── Score quality and auto-switch if low ─────────────────────────────────
    qualityScore = await this._score(strategyInput, strategyOutput);
    if (qualityScore === null) return null;

    emitCompactionQualityScore(this._bus, this._ctx, {
      sessionId: this._sessionId,
      strategy,
      score: qualityScore.score,
      grade: qualityScore.grade,
      compressionRatio: qualityScore.compressionRatio,
      retentionScore: qualityScore.retentionScore,
      isLowQuality: qualityScore.isLowQuality,
      description: qualityScore.description,
    });

    if (qualityScore.isLowQuality) {
      const escalated = escalateStrategy(strategy);
      if (escalated !== strategy) {
        const reason = `Quality score ${qualityScore.score.toFixed(2)} below threshold ${LOW_QUALITY_THRESHOLD}; escalating from ${strategy} to ${escalated}`;
        strategySwitchReason = reason;

        logger.warn('[CompactionManager] low quality score, switching strategy', {
          sessionId: this._sessionId,
          fromStrategy: strategy,
          toStrategy: escalated,
          score: qualityScore.score,
          grade: qualityScore.grade,
        });

        emitCompactionStrategySwitch(this._bus, this._ctx, {
          sessionId: this._sessionId,
          fromStrategy: strategy,
          toStrategy: escalated,
          reason,
          score: qualityScore.score,
        });

        // Force state to the escalated strategy state, bypassing normal transition
        // validation. This is intentional: quality-correction reruns are not modelled
        // in the standard state machine, and forcing the state allows _runStrategy to
        // emit the correct strategy event while keeping lifecycle state consistent.
        this._state = strategyToState(escalated);

        const escalatedInput: StrategyInput = { ...strategyInput, strategy: escalated };
        let escalatedOutput: StrategyOutput | undefined;
        try {
          escalatedOutput = await this._runStrategy(escalated, escalatedInput);
        } catch (err) {
          const error = summarizeError(err);
          logger.warn('[CompactionManager] escalated strategy also failed; using original output', {
            sessionId: this._sessionId,
            strategy: escalated,
            error,
          });
          // Fall back to the original output, restore to the original strategy state
          this._state = strategyToState(strategy);
        }
        if (escalatedOutput !== undefined) {
          // Re-score the escalated result
          const escalatedScore = await this._score(escalatedInput, escalatedOutput);
          if (escalatedScore === null) return null;
          qualityScore = escalatedScore;
          strategyOutput = escalatedOutput;
          strategy = escalated;
        }
      } else {
        // Already at ceiling strategy (collapse or reactive), log but continue
        logger.debug('[CompactionManager] low quality at ceiling strategy; no escalation possible', {
          sessionId: this._sessionId,
          strategy,
          score: qualityScore.score,
        });
      }
    }

    // ── Transition: <strategy> → boundary_commit ─────────────────────────────
    this._transition('boundary_commit');

    // ── Create boundary commit ───────────────────────────────────────────────
    const commit = createBoundaryCommit({
      sessionId: this._sessionId,
      strategyOutput,
      parent: this._lastCommit,
      tokensBefore: tokenCount,
    });

    const commitErrors = validateBoundaryCommit(commit);
    if (commitErrors.length > 0) {
      const error = commitErrors.join('; ');
      this._transition('failed');
      emitCompactionFailed(this._bus, this._ctx, {
        sessionId: this._sessionId,
        strategy,
        error,
      });
      this._transition('idle');
      logger.error('[CompactionManager] boundary commit validation failed', {
        sessionId: this._sessionId,
        errors: commitErrors,
      });
      return null;
    }

    emitCompactionBoundaryCommit(this._bus, this._ctx, {
      sessionId: this._sessionId,
      checkpointId: commit.checkpointId,
    });

    this._lastCommit = commit;

    // ── Transition: boundary_commit → done ───────────────────────────────────
    this._transition('done');
    const durationMs = Date.now() - runStart;

    emitCompactionDone(this._bus, this._ctx, {
      sessionId: this._sessionId,
      strategy,
      tokensBefore: tokenCount,
      tokensAfter: strategyOutput.tokensAfter,
      durationMs,
    });

    // ── Transition: done → idle ───────────────────────────────────────────────
    this._transition('idle');

    return {
      sessionId: this._sessionId,
      strategy,
      tokensBefore: tokenCount,
      tokensAfter: strategyOutput.tokensAfter,
      durationMs,
      commit,
      messages: strategyOutput.messages,
      warnings: strategyOutput.warnings,
      qualityScore,
      strategySwitchReason,
    };
  }

  /**
   * Runs the lifecycle of a compaction the session itself performs.
   *
   * The session decides that it compacts and how (the orchestrator's threshold
   * and model-warning checks, and the conversation's structured, distiller or
   * small-window compaction); this manager owns the run's lifecycle: it moves
   * the state machine idle, checking_threshold, the strategy state,
   * boundary_commit, done (or failed) and back to idle, emits the matching
   * COMPACTION_* events on the session's bus, and records a boundary commit
   * chained to the previous one. Runs are serialized per session.
   *
   * `execute` performs the compaction; `outcome` reads what it applied from
   * its result (null when nothing was applied). A throw from `execute` is a
   * failed run: COMPACTION_FAILED is emitted and the error is rethrown to the
   * caller unchanged.
   *
   * @returns Whatever `execute` returned.
   */
  runLifecycle<T>(opts: {
    trigger: CompactionTrigger;
    strategy: CompactionStrategy;
    messages: readonly ProviderMessage[];
    tokenCount: number;
    /** Window used for this run's threshold report; defaults to the manager's. */
    contextWindow?: number | undefined;
    /** Threshold (tokens) the session compared against; defaults to window x fraction. */
    threshold?: number | undefined;
    execute: () => Promise<T>;
    outcome: (result: T) => SessionCompactionOutcome | null;
  }): Promise<T> {
    if (this._disposed) {
      return Promise.reject(new Error(`CompactionManager for session ${this._sessionId} is disposed`));
    }
    const run = this._runChain.then(() => this._runLifecycle(opts));
    this._runChain = run.catch(() => undefined);
    return run;
  }

  /**
   * Releases the manager with its session: no further run starts, a run still
   * in flight finishes its compaction without emitting on the session's bus,
   * and the boundary commit chain is dropped.
   */
  dispose(): void {
    this._disposed = true;
    this._lastCommit = null;
  }

  private async _runLifecycle<T>(opts: {
    trigger: CompactionTrigger;
    strategy: CompactionStrategy;
    messages: readonly ProviderMessage[];
    tokenCount: number;
    contextWindow?: number | undefined;
    threshold?: number | undefined;
    execute: () => Promise<T>;
    outcome: (result: T) => SessionCompactionOutcome | null;
  }): Promise<T> {
    const runStart = Date.now();
    const { strategy, tokenCount, trigger } = opts;
    const contextWindow = opts.contextWindow ?? this._contextWindow;
    const threshold = opts.threshold ?? Math.floor(contextWindow * this._thresholdFraction);
    const live = (): boolean => !this._disposed;

    if (this._state !== 'idle') this._state = 'idle';
    this._transition('checking_threshold');
    if (live()) {
      emitCompactionCheck(this._bus, this._ctx, { sessionId: this._sessionId, tokenCount, threshold });
    }
    this._transition(strategyToState(strategy));

    const fail = (error: string): void => {
      this._transition('failed');
      if (live()) emitCompactionFailed(this._bus, this._ctx, { sessionId: this._sessionId, strategy, error });
      this._transition('idle');
      logger.warn('[CompactionManager] session compaction failed', { sessionId: this._sessionId, strategy, trigger, error });
    };

    let result: T;
    try {
      result = await opts.execute();
    } catch (err) {
      fail(summarizeError(err));
      throw err;
    }

    const applied = opts.outcome(result);
    if (applied === null) {
      fail('compaction applied no result');
      return result;
    }

    if (live()) this._emitStrategyEvent(strategy, opts.messages.length, tokenCount, applied.tokensAfter, contextWindow);

    this._transition('boundary_commit');
    const commit = createBoundaryCommit({
      sessionId: this._sessionId,
      strategyOutput: {
        messages: applied.messages,
        tokensAfter: applied.tokensAfter,
        summary: applied.summary,
        strategy,
        durationMs: Date.now() - runStart,
        warnings: applied.warnings ?? [],
      },
      parent: this._lastCommit,
      tokensBefore: tokenCount,
    });
    const commitErrors = validateBoundaryCommit(commit);
    if (commitErrors.length > 0) {
      fail(commitErrors.join('; '));
      return result;
    }
    if (live()) {
      emitCompactionBoundaryCommit(this._bus, this._ctx, { sessionId: this._sessionId, checkpointId: commit.checkpointId });
      this._lastCommit = commit;
    }

    this._transition('done');
    if (live()) {
      emitCompactionDone(this._bus, this._ctx, {
        sessionId: this._sessionId,
        strategy,
        tokensBefore: tokenCount,
        tokensAfter: applied.tokensAfter,
        durationMs: Date.now() - runStart,
      });
    }
    this._transition('idle');
    return result;
  }

  /** Emits the strategy-specific lifecycle event for a finished strategy run. */
  private _emitStrategyEvent(
    strategy: CompactionStrategy,
    messageCount: number,
    tokensBefore: number,
    tokensAfter: number,
    contextWindow: number,
  ): void {
    switch (strategy) {
      case 'microcompact':
        emitCompactionMicrocompact(this._bus, this._ctx, { sessionId: this._sessionId, turnCount: messageCount, tokensBefore, tokensAfter });
        return;
      case 'collapse':
        emitCompactionCollapse(this._bus, this._ctx, { sessionId: this._sessionId, messageCount, tokensBefore, tokensAfter });
        return;
      case 'autocompact':
        emitCompactionAutocompact(this._bus, this._ctx, { sessionId: this._sessionId, strategy: 'autocompact', tokensBefore, tokensAfter });
        return;
      case 'reactive':
        emitCompactionReactive(this._bus, this._ctx, { sessionId: this._sessionId, tokenCount: tokensBefore, limit: contextWindow });
        return;
      default: {
        const _exhaustive: never = strategy;
        throw new Error(`Unknown compaction strategy: ${_exhaustive}`);
      }
    }
  }

  /**
   * Runs the session resume repair pipeline on the last boundary commit.
   *
   * If no commit exists, returns a result with the original messages and
   * a warning action.
   *
   * @param overrideCommit - Optional commit to repair (defaults to lastCommit).
   * @returns ResumeRepairResult.
   */
  repair(
    overrideCommit?: BoundaryCommit,
  ): ResumeRepairResult {
    const commit = overrideCommit ?? this._lastCommit;
    if (!commit) {
      return {
        sessionId: this._sessionId,
        repaired: false,
        actions: [
          {
            kind: 'no_commit',
            description: 'No boundary commit available; nothing to repair.',
            severity: 'info',
          },
        ],
        messages: [],
        safeToResume: false,
        failReason: 'No boundary commit available for repair.',
      };
    }
    // The repair's own default is a hardcoded 80_000, "80% of a typical 100K
    // context window", a fair guess when it was written. This manager holds
    // the REAL window for the model in play, so the ceiling is computed from
    // it rather than assumed: on a 1M-token model that constant was throwing
    // away messages a resumed session could comfortably have kept.
    return runResumeRepair({ commit, maxTokens: Math.floor(this._contextWindow * 0.8) });
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Scores a strategy output. A scoring failure (the quality readings could
   * not be taken) ends the run the way a strategy failure does: a
   * COMPACTION_FAILED event, back to idle, and null so no unscored output is
   * committed.
   */
  private async _score(input: StrategyInput, output: StrategyOutput): Promise<CompactionQualityScore | null> {
    try {
      return await computeQualityScore(input, output);
    } catch (err) {
      const error = summarizeError(err);
      this._transition('failed');
      emitCompactionFailed(this._bus, this._ctx, {
        sessionId: this._sessionId,
        strategy: input.strategy,
        error,
      });
      this._transition('idle');
      logger.error('[CompactionManager] quality scoring failed', {
        sessionId: this._sessionId,
        strategy: input.strategy,
        error,
      });
      return null;
    }
  }

  /**
   * Executes the selected strategy and emits the corresponding domain event.
   */
  private async _runStrategy(
    strategy: CompactionStrategy,
    input: StrategyInput,
  ): Promise<StrategyOutput> {
    let output: StrategyOutput;
    switch (strategy) {
      case 'microcompact': output = runMicrocompact(input); break;
      case 'collapse': output = await runCollapse(input); break;
      case 'autocompact': output = runAutocompact(input); break;
      case 'reactive': output = runReactive(input); break;
      default: {
        const _exhaustive: never = strategy;
        throw new Error(`Unknown compaction strategy: ${_exhaustive}`);
      }
    }
    this._emitStrategyEvent(strategy, input.messages.length, input.tokensBefore, output.tokensAfter, this._contextWindow);
    return output;
  }

  /**
   * Applies a state transition, throwing if invalid.
   * Invalid transitions are logged and treated as internal errors.
   */
  private _transition(target: CompactionLifecycleState): void {
    const result = applyTransition(this._state, target);
    if (!result.ok) {
      logger.error('[CompactionManager] invalid state transition', {
        from: this._state,
        to: target,
        reason: result.reason,
        sessionId: this._sessionId,
      });
      // Force to failed to avoid being stuck in an inconsistent state
      this._state = 'failed';
      return;
    }
    this._state = result.state;
  }
}
