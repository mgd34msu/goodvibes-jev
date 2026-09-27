/**
 * Every number the routing composition reads, in one reviewable place. The
 * questions live with their batteries; this file holds only what code does
 * with the readings. Changing a routing policy is an edit here, never a
 * reworded question.
 */
import type { RouteTier } from './tiers.js';

/** The tier each difficulty level asks for when the tier reading itself is too unsure to act on (levels 0 to 3). */
export const TIER_FOR_DIFFICULTY: readonly RouteTier[] = ['economy', 'standard', 'premium', 'premium'];

/** The lowest tier each risk level allows (levels 0 to 3): costly mistakes are not handed to the smallest models. */
export const TIER_FLOOR_FOR_RISK: readonly RouteTier[] = ['economy', 'economy', 'standard', 'premium'];

/**
 * The lowest tier for who does the work. The contract planner writes the
 * units and criteria every other agent is held to, and an integration unit
 * joins other units' work, so neither runs below standard.
 */
export const TIER_FLOOR_FOR_PURPOSE: Readonly<Record<string, RouteTier>> = {
  planner: 'standard',
  integration: 'standard',
};

/**
 * The lowest tier for a request not written in English. Jev reads English
 * best (docs.typesafe.ai, language support), so a non-English request whose
 * tier reading is not strong enough to act on is not sent below standard.
 */
export const TIER_FLOOR_FOR_UNSURE_NON_ENGLISH: RouteTier = 'standard';

/**
 * How many catalog models the planner reads for tier before choosing. The
 * shortlist is ordered in code by published facts (benchmark score and price,
 * see shortlistOrder in route-planner.ts), and only the shortlist is read, so
 * a first plan over a large catalog stays a bounded number of readings.
 */
export const TIER_READ_SHORTLIST = 24;

/**
 * How many shortlists the planner reads, one after another, while a tier's
 * pool is smaller than CHOICE_SHORTLIST. Bounds a first plan over a large
 * catalog to TIER_READ_SHORTLIST x TIER_READ_ROUNDS readings per tier.
 */
export const TIER_READ_ROUNDS = 3;

/** How many same-tier candidates the final model choice weighs at once. */
export const CHOICE_SHORTLIST = 8;

/** How many fallback routes a planned route carries for the provider failover chain. */
export const FALLBACK_ROUTES = 3;

/** Tier readings in flight at once while the planner fills its shortlist. */
export const TIER_READ_CONCURRENCY = 8;

/**
 * The guidance a model gets in its system prompt when its tier reading does
 * not settle: the fullest guidance, which costs a few hundred tokens and
 * cannot mislead a strong model, where too little guidance can derail a weak
 * one.
 */
export const GUIDANCE_TIER_WHEN_UNSETTLED: RouteTier = 'economy';
