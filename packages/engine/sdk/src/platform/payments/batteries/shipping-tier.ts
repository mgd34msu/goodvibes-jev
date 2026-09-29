/**
 * `engine.payments.shipping-standard`, `engine.payments.shipping-fast` and
 * `engine.payments.shipping-fastest`: which of a checkout's delivery options
 * is each shipping tier? Read by Jev in place of the cost order shipping.ts
 * used (the cheapest option was normal, the next fast, the next fastest).
 *
 * Price order stood in for delivery speed: a pricier option can be the same
 * speed with a signature, insurance or a named-day add-on, so the owner's
 * "fast" tier bought a signature instead of speed.
 *
 * The selector pattern, one per tier: the candidates are the offered options,
 * `o0`, `o1` and so on, each with its label and its cost in minor units.
 * shipping.ts composes the tiers: the standard and fastest readings are asked
 * together, and the fast reading is asked over the options left when three or
 * more are offered, told the whole offer and which options were read as
 * standard and fastest.
 *
 * The labels are the merchant's text. A label written to be picked can at
 * most move the choice between the options the checkout offers, and every
 * option's cost is drawn from the overage pool and checked against it by
 * code (decide.ts), so no reading here can spend past the owner's budget.
 *
 * Band: low stakes. A wrong tier costs a few units of currency within the
 * owner's overage pool, which code checks every option's cost against, or a
 * slower parcel; nothing irreversible turns on it. A tier whose reading does
 * not act is left out and the ladder steps past it.
 */
import { defineSelector, NONE, STAKES_BANDS } from '@goodvibes-jev/judgment';

/** The candidate id of the delivery option at `index`. */
export const shippingOptionId = (index: number): string => `o${index}`;

type Offered = readonly (readonly [label: string, costMinorUnits: number])[];

/** Candidates as a reading sees them: each option's label and cost. */
export function shippingCandidates(options: Offered, currency: string): { id: string; content: { label: string; cost_minor_units: number; currency: string } }[] {
  return options.map(([label, costMinorUnits], index) => ({ id: shippingOptionId(index), content: { label, cost_minor_units: costMinorUnits, currency } }));
}

const CONTEXT = { checkout: 'The delivery options an online checkout offers for one order.' };
const THREE: Offered = [['Standard (5-7 business days)', 499], ['Expedited (2-3 business days)', 1299], ['Next Day Air', 2499]];
const SIGNATURE: Offered = [['Standard delivery', 399], ['Standard delivery with signature required', 899], ['Express 1-2 days', 1499]];
const INSURED: Offered = [['Ground shipping', 0], ['Ground shipping + package insurance', 350]];
const PRIORITY: Offered = [['Economy (7-10 days)', 299], ['Priority (3-4 days)', 799], ['Overnight', 1999], ['Two-day', 1199]];

const BAND = STAKES_BANDS.low.confidence;
const FIT_BAND = STAKES_BANDS.low.yesNo;

export const shippingStandard = defineSelector({
  name: 'engine.payments.shipping-standard',
  version: 1,
  description: 'Which of a checkout\'s delivery options is the standard one: ordinary speed with no paid upgrade.',
  accuracyFloor: 0.85,
  instructions: '`candidates` are the delivery options a checkout offers, each with its label and cost in minor units of `currency`. Which one is the standard delivery: the ordinary speed a shop sends at, without paying for faster delivery or for add-ons such as a signature, insurance or a chosen delivery day? When several are the ordinary speed, the one with no add-on.',
  fitInstructions: 'Is this candidate a delivery option at the ordinary, unhurried speed, with no paid add-on such as a signature, insurance or a chosen delivery day?',
  band: BAND,
  fitBand: FIT_BAND,
  fixtures: [
    { name: 'three speeds', context: CONTEXT, candidates: shippingCandidates(THREE, 'USD'), expect: 'o0' },
    { name: 'a signature option priced between standard and express', context: CONTEXT, candidates: shippingCandidates(SIGNATURE, 'USD'), expect: 'o0' },
    { name: 'free ground and insured ground', context: CONTEXT, candidates: shippingCandidates(INSURED, 'USD'), expect: 'o0' },
    { name: 'economy is the ordinary speed', context: CONTEXT, candidates: shippingCandidates(PRIORITY, 'USD'), expect: 'o0' },
  ],
});

export const shippingFastest = defineSelector({
  name: 'engine.payments.shipping-fastest',
  version: 1,
  description: 'Which of a checkout\'s delivery options arrives soonest, or none when none is faster than standard.',
  accuracyFloor: 0.85,
  instructions: '`candidates` are the delivery options a checkout offers, each with its label and cost in minor units of `currency`. Which one delivers the order soonest? Choose none when no option is faster than ordinary delivery (for example when the options differ only by a signature or insurance).',
  fitInstructions: 'Is this candidate a faster-than-ordinary delivery option, one that pays for speed rather than for an add-on such as a signature or insurance?',
  band: BAND,
  fitBand: FIT_BAND,
  fixtures: [
    { name: 'three speeds', context: CONTEXT, candidates: shippingCandidates(THREE, 'USD'), expect: 'o2' },
    { name: 'express beats a pricier-than-standard signature', context: CONTEXT, candidates: shippingCandidates(SIGNATURE, 'USD'), expect: 'o2' },
    { name: 'only an add-on, no faster option', context: CONTEXT, candidates: shippingCandidates(INSURED, 'USD'), expect: NONE },
    { name: 'overnight listed before two-day', context: CONTEXT, candidates: shippingCandidates(PRIORITY, 'USD'), expect: 'o2' },
  ],
});

/** What the fast reading is told: every offered option, and which two were read as standard and fastest. */
export function fastContext(offered: Offered, standard: number, fastest: number): { offered: { label: string; cost_minor_units: number }[]; standard: string; fastest: string } {
  return {
    offered: offered.map(([label, cost]) => ({ label, cost_minor_units: cost })),
    standard: offered[standard]![0],
    fastest: offered[fastest]![0],
  };
}

export const shippingFast = defineSelector({
  name: 'engine.payments.shipping-fast',
  version: 1,
  description: 'Which of the delivery options between standard and fastest is faster than standard, or none.',
  accuracyFloor: 0.85,
  instructions: '`context.offered` is every delivery option a checkout offers; `context.standard` is its ordinary delivery and `context.fastest` its quickest. `candidates` are the other options. Which candidate delivers sooner than `context.standard`? When several do, the soonest.',
  fitInstructions: 'Does this candidate deliver sooner than `context.standard`, by paying for speed rather than for an add-on such as a signature or insurance?',
  band: BAND,
  fitBand: FIT_BAND,
  fixtures: [
    { name: 'expedited between standard and overnight', context: fastContext(THREE, 0, 2), candidates: shippingCandidates([THREE[1]!], 'USD'), expect: 'o0' },
    { name: 'signature only, not faster', context: fastContext(SIGNATURE, 0, 2), candidates: shippingCandidates([SIGNATURE[1]!], 'USD'), expect: NONE },
    { name: 'two-day over priority', context: fastContext(PRIORITY, 0, 2), candidates: shippingCandidates([PRIORITY[1]!, PRIORITY[3]!], 'USD'), expect: 'o1' },
    { name: 'two-day between standard and overnight', context: fastContext([['Standard', 499], ['Two-day', 1299], ['Overnight', 2999]], 0, 2), candidates: shippingCandidates([['Two-day', 1299]], 'USD'), expect: 'o0' },
  ],
});
