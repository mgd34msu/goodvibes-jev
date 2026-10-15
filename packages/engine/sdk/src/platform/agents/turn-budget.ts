/**
 * agents/turn-budget.ts
 *
 * Resolving the per-agent turn ceiling as a real, configurable feature rather
 * than a hardcoded constant, and naming the budget-exhaustion outcome so wire
 * consumers can read it instead of regex-matching a prose string.
 *
 * Resolution order (mirrors the orchestration spawn-policy cap machinery so the
 * two never fight): a per-spawn override wins over the config default, but the
 * policy cap always wins over the override, a caller cannot lift the ceiling
 * past agents.maxTurnsCap. The resolved budget carries WHICH input applied so
 * the failure outcome can report it (default / spawn-override / policy-bound).
 */

/** The machine-readable outcome kind for a run that spent its whole turn budget. */
export const TURN_BUDGET_EXHAUSTED = 'max_turns' as const;
export type TurnBudgetExhausted = typeof TURN_BUDGET_EXHAUSTED;

/** Which input determined the applied turn budget. */
export type TurnBudgetSource = 'default' | 'spawn-override' | 'policy-bound';

export interface ResolvedTurnBudget {
  /** The turn ceiling that actually applies to the run. */
  readonly limit: number; // 0 means no turn ceiling
  /** Which input set it, for the honest turn-budget-exhausted outcome. */
  readonly source: TurnBudgetSource;
}

export interface ResolveTurnBudgetInput {
  /** The configured default (agents.maxTurns). */
  readonly configDefault: number;
  /** A per-spawn override, if the spawn requested one. */
  readonly spawnOverride?: number | undefined;
  /** The hard cap a spawn override cannot exceed (agents.maxTurnsCap). */
  readonly policyCap: number;
}

function turnLimitOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/** Zero disables a ceiling. An explicitly configured owner cap still wins. */
export function resolveTurnBudget(input: ResolveTurnBudgetInput): ResolvedTurnBudget {
  const cap = turnLimitOr(input.policyCap, 0);
  const configured = turnLimitOr(input.configDefault, 0);
  const requested = turnLimitOr(input.spawnOverride, configured);
  if (cap > 0 && (requested === 0 || requested > cap)) {
    return { limit: cap, source: 'policy-bound' };
  }
  return { limit: requested, source: input.spawnOverride === undefined ? 'default' : 'spawn-override' };
}

/** The human-readable turn-limit error string, unchanged prose, so nothing that reads it breaks. */
export function formatTurnLimitError(limit: number): string {
  return `Exceeded maximum turn limit (${limit})`;
}

