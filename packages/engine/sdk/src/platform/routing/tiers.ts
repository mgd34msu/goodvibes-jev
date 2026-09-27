/**
 * The capability tiers routing speaks in. A request is read for the tier of
 * model it needs; a model is read for the tier it belongs to; the route
 * planner matches the two. The descriptions name the kind of work and the
 * kind of model, never a vendor or a model, so the rules hold for the whole
 * catalog.
 */
export const ROUTE_TIERS = ['economy', 'standard', 'premium'] as const;

export type RouteTier = (typeof ROUTE_TIERS)[number];

/** What each tier means for a piece of work, as the request-tier question offers it. */
export const WORK_TIER_OPTIONS = {
  economy: 'A small, fast, inexpensive model does this well: a simple lookup, a short rewrite, formatting, a routine one-step edit, or a casual reply.',
  standard: 'A capable general-purpose model is needed: ordinary coding, writing, summarizing or multi-step work of moderate difficulty.',
  premium: 'The strongest reasoning model is needed: hard debugging, architecture or design decisions, subtle correctness or security, long multi-step planning, research synthesis, or work where a mistake is costly.',
} as const satisfies Readonly<Record<RouteTier, string>>;

/** What each tier means for a model, as the model-tier question offers it. */
export const MODEL_TIER_OPTIONS = {
  economy: 'A small or lightweight model: fast and inexpensive, good at simple well-defined tasks, weak at hard multi-step reasoning. Includes small open-weight models, "mini", "nano", "flash-lite" and "instant" style variants, and embedding or special-purpose models.',
  standard: 'A capable mid-range general model: solid at ordinary coding, writing and multi-step tasks, below the strongest models on hard reasoning. Includes mid-size open-weight models and the balanced middle of a model family.',
  premium: 'A frontier flagship model: among the strongest reasoning and coding models available, usually the largest and highest-priced of its family.',
} as const satisfies Readonly<Record<RouteTier, string>>;

/** The tier's position, lowest first, for comparisons in code. */
export function tierRank(tier: RouteTier): number {
  return ROUTE_TIERS.indexOf(tier);
}

/** The higher of two tiers. */
export function higherTier(a: RouteTier, b: RouteTier): RouteTier {
  return tierRank(a) >= tierRank(b) ? a : b;
}

/** Tiers to try when none of the wanted tier is available: the wanted one, then higher ones, then lower ones. */
export function tierSearchOrder(wanted: RouteTier): readonly RouteTier[] {
  const rank = tierRank(wanted);
  const higher = ROUTE_TIERS.slice(rank + 1);
  const lower = ROUTE_TIERS.slice(0, rank).reverse();
  return [wanted, ...higher, ...lower];
}
