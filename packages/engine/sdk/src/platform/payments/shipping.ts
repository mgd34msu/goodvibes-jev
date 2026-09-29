/**
 * shipping.ts, the tier preference, and the ladder that steps down one rung.
 *
 * The preference is ORDINAL against what the checkout actually offers: which
 * offered option is standard delivery, which is the fastest, and which sits
 * between. Merchants describe delivery in incomparable ways, "2-day",
 * "express", "by Tuesday", "signature required", so which option is which
 * tier is read by Jev over the options' labels and costs
 * (`engine.payments.shipping-standard`, `-fastest` and `-fast`,
 * batteries/shipping-tier.ts). It used to be read off the price order
 * (cheapest normal, next fast, next fastest), which let a pricier option
 * with a signature or insurance, and no more speed, stand in for "fast".
 *
 * A checkout with one option has nothing to choose, so every tier is that
 * option. With two or more, the standard and fastest readings are asked
 * together; with three or more, the fast reading is asked over the options
 * left. When nothing lies between standard and fastest, or the fast reading
 * is a confident none, `fast` is the fastest option, as a two-option checkout
 * always was. A tier whose reading does not act is left out, and the ladder
 * steps past it.
 *
 * ── The ladder ────────────────────────────────────────────────────────────
 *
 * The preferred tier draws on the overage pool. When the pool cannot cover it,
 * step down ONE tier at a time until it fits, stopping at standard. Not
 * straight to the bottom: with tiers at $15 / $9 / $5 and $9 available, the
 * one-rung rule gets the owner $9 delivery and the shortcut gets them $5
 * delivery they did not ask for. The ladder compares amounts; it reads
 * nothing.
 *
 * A step-down needs no approval, it is within budget by construction, but it
 * IS recorded and surfaced, because the owner must not learn about it from a
 * late package.
 *
 * ── Filler items ──────────────────────────────────────────────────────────
 *
 * There is no free-shipping-threshold logic in this file, and there must never
 * be. Adding an item the owner did not ask for in order to save on delivery is
 * buying something on their behalf to make a number look better. `assertCartMatchesRequest`
 * in cart.ts is the enforcement; its absence here is the design.
 */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import type { JsonValue, Selection, Selector } from '@goodvibes-jev/judgment';
import { fastContext, shippingCandidates, shippingFast, shippingFastest, shippingOptionId, shippingStandard } from './batteries/shipping-tier.js';
import type { MinorUnits, ShippingOption, ShippingStepDown, ShippingTier } from './types.js';
import { SHIPPING_TIERS } from './types.js';

/** The decision site the shipping tier readings are logged under. */
export const SHIPPING_TIER_SITE = 'payments.shipping-tier';

/** Which offered option each tier is. A tier missing from the map is not offered. */
export type ShippingTiers = ReadonlyMap<ShippingTier, ShippingOption>;

/** What a tier reading settled: an option (its index), a confident none, or nothing it may act on. */
type TierPick = number | 'none' | 'unread';

/** The chosen option's position in `offered`, a confident none, or unread when the selection does not act. */
function actedPick(selection: Selection, offered: readonly { readonly id: string }[]): TierPick {
  if (selection.outcome !== 'act') return 'unread';
  if (selection.chosen === undefined) return 'none';
  const index = offered.findIndex((candidate) => candidate.id === selection.chosen);
  return index === -1 ? 'unread' : index;
}

const CHECKOUT_CONTEXT = { checkout: 'The delivery options an online checkout offers for one order.' };

async function pick(
  selector: Selector,
  options: readonly ShippingOption[],
  indexes: readonly number[],
  currency: string,
  context: JsonValue = CHECKOUT_CONTEXT,
): Promise<TierPick> {
  const offered = shippingCandidates(indexes.map((index) => [options[index]!.rawLabel, options[index]!.costMinorUnits] as const), currency);
  const selection = await selector.select(judgmentPort(SHIPPING_TIER_SITE), context, offered, { site: SHIPPING_TIER_SITE });
  const picked = actedPick(selection, offered);
  const result = typeof picked === 'number' ? indexes[picked]! : picked;
  selection.recordAction(typeof result === 'number' ? `option ${shippingOptionId(result)}` : result === 'none' ? 'no option is this tier' : 'tier left unread');
  return result;
}

/**
 * Read which offered delivery option each tier is.
 *
 * `options` are the checkout's options in the order it listed them;
 * `currency` is what their costs are in.
 */
export async function readShippingTiers(options: readonly ShippingOption[], currency: string): Promise<ShippingTiers> {
  const tiers = new Map<ShippingTier, ShippingOption>();
  const only = options.length === 1 ? options[0] : undefined;
  if (only !== undefined) {
    for (const tier of SHIPPING_TIERS) tiers.set(tier, only);
    return tiers;
  }
  if (options.length === 0) return tiers;

  const all = options.map((_, index) => index);
  const [standardPick, fastestPick] = await Promise.all([
    pick(shippingStandard, options, all, currency),
    pick(shippingFastest, options, all, currency),
  ]);
  const standard = typeof standardPick === 'number' ? standardPick : undefined;
  // The fastest option is a tier only when it is not the standard one.
  const fastest = typeof fastestPick === 'number' && fastestPick !== standard ? fastestPick : undefined;
  if (standard !== undefined) tiers.set('normal', options[standard]!);
  if (fastest === undefined) return tiers;
  tiers.set('fastest', options[fastest]!);

  // Fast sits between standard and fastest. With nothing between them, or a
  // confident reading that nothing between them is faster than standard, the
  // fastest option is the only faster one, so it is fast too. A reading that
  // does not act leaves fast out.
  const between = all.filter((index) => index !== standard && index !== fastest);
  if (between.length === 0) {
    tiers.set('fast', options[fastest]!);
    return tiers;
  }
  if (standard === undefined) return tiers;
  const whole = options.map((option) => [option.rawLabel, option.costMinorUnits] as const);
  const fast = await pick(shippingFast, options, between, currency, fastContext(whole, standard, fastest));
  if (fast === 'unread') return tiers;
  tiers.set('fast', options[fast === 'none' ? fastest : fast]!);
  return tiers;
}

export interface ShippingLadderResult {
  readonly tier: ShippingTier;
  readonly option: ShippingOption;
  readonly costMinorUnits: MinorUnits;
  readonly stepDown: ShippingStepDown | null;
  /** How many rungs were tried, so a test can prove it stepped rather than jumped. */
  readonly rungsTried: number;
}

/**
 * Walk down from the preferred tier until the total unavoidable draw fits.
 *
 * `tiers` is what `readShippingTiers` read; `budgetForOverage` is what the
 * overage pool can still cover; `fixedUnavoidable` is tax plus mandatory fees,
 * which no amount of stepping down can reduce. Returns null when nothing fits
 * even at the lowest rung, the caller then either draws on the tolerance pool
 * or refuses, per the decision order.
 */
export function walkShippingLadder(input: {
  readonly preferred: ShippingTier;
  readonly tiers: ShippingTiers;
  readonly fixedUnavoidableMinorUnits: MinorUnits;
  readonly budgetForOverageMinorUnits: MinorUnits;
}): ShippingLadderResult | null {
  const tierToOption = input.tiers;
  if (tierToOption.size === 0) return null;

  const startIndex = SHIPPING_TIERS.indexOf(input.preferred);
  const from = startIndex === -1 ? 0 : startIndex;

  let rungsTried = 0;
  for (let index = from; index >= 0; index -= 1) {
    const tier = SHIPPING_TIERS[index];
    if (tier === undefined) continue;
    const option = tierToOption.get(tier);
    if (option === undefined) continue;
    rungsTried += 1;

    const draw = input.fixedUnavoidableMinorUnits + option.costMinorUnits;
    if (draw > input.budgetForOverageMinorUnits) continue;

    const preferredOption = tierToOption.get(input.preferred);
    const stepDown: ShippingStepDown | null =
      tier === input.preferred || preferredOption === undefined
        ? null
        : {
            from: input.preferred,
            to: tier,
            savedMinorUnits: preferredOption.costMinorUnits - option.costMinorUnits,
            reason: 'overage-pool-insufficient',
          };

    return { tier, option, costMinorUnits: option.costMinorUnits, stepDown, rungsTried };
  }
  return null;
}
