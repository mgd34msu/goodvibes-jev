/**
 * Cache Strategy Planner, keeps the cache breakpoint strategy for a session
 * and decides when to recompute it.
 *
 * Placement is arithmetic over the provider's cache capability and the
 * request's token counts (getDefaultStrategy() in cache-strategy.ts).
 *
 * The planner recomputes:
 *   - Once at session start (first turn)
 *   - Every N turns (the strategy's refreshAfterTurns)
 *   - When cache hit rate drops below threshold
 */

import type {
  CacheStrategy,
  CacheContext,
  CacheHitTracker,
} from './cache-strategy.js';
import { getDefaultStrategy } from './cache-strategy.js';
import type { ConfigManager } from '../config/manager.js';

/** Result of a strategy planning run. */
export interface PlanResult {
  strategy: CacheStrategy;
  source: 'computed' | 'cached';
  planTimeMs: number;
}

/**
 * CachePlanner, manages cache strategy lifecycle.
 *
 * Caches the current strategy and refreshes it based on
 * turn count and hit rate thresholds.
 */
export class CachePlanner {
  private currentStrategy: CacheStrategy | null = null;
  private lastPlanTurn = 0;
  private turnsSinceLastPlan = 0;
  private readonly cacheHitTracker: Pick<CacheHitTracker, 'getMetrics'>;

  constructor(
    private readonly configManager: Pick<ConfigManager, 'get'>,
    cacheHitTracker: Pick<CacheHitTracker, 'getMetrics'>,
  ) {
    this.cacheHitTracker = cacheHitTracker;
  }

  /**
   * Get the current cache strategy, planning a new one if needed.
   *
   * Triggers re-planning when:
   *   - No strategy exists yet (first call)
   *   - refreshAfterTurns threshold reached
   *   - Cache hit rate dropped below warning threshold
   */
  async getStrategy(context: CacheContext): Promise<PlanResult> {
    const startMs = Date.now();
    this.turnsSinceLastPlan++;

    const needsRefresh = this.shouldRefresh(context);

    if (this.currentStrategy && !needsRefresh) {
      return {
        strategy: this.currentStrategy,
        source: 'cached',
        planTimeMs: Date.now() - startMs,
      };
    }

    const strategy = getDefaultStrategy(context);
    this.currentStrategy = strategy;
    this.lastPlanTurn = this.turnsSinceLastPlan;
    this.turnsSinceLastPlan = 0;

    return {
      strategy,
      source: 'computed',
      planTimeMs: Date.now() - startMs,
    };
  }

  /** Check if strategy needs refresh. */
  private shouldRefresh(context: CacheContext): boolean {
    // No strategy yet
    if (!this.currentStrategy) return true;

    // Refresh interval reached
    if (
      this.currentStrategy.refreshAfterTurns > 0 &&
      this.turnsSinceLastPlan >= this.currentStrategy.refreshAfterTurns
    ) {
      return true;
    }

    // Hit rate dropped below threshold
    const hitRateThreshold = this.configManager.get('cache.hitRateWarningThreshold') as number;
    if (
      context.recentCacheHitRate !== undefined &&
      context.recentCacheHitRate < hitRateThreshold &&
      this.cacheHitTracker.getMetrics().turns >= 3 // Need enough data
    ) {
      return true;
    }

    return false;
  }

  /** Force a strategy refresh on the next getStrategy() call. */
  invalidate(): void {
    this.currentStrategy = null;
  }

}
