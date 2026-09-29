/**
 * `engine.payments.cart-line`: which of the items the owner asked for is this
 * cart line, or is it none of them? Read by Jev in place of the label
 * equality cart.ts used (both labels lowercased with punctuation removed,
 * then compared).
 *
 * The merchant names a product in its own words, so equal labels stood in
 * for "the same item": "USB-C cable, 2 m" asked for and "Anker USB-C to USB-C
 * Cable (6ft/2m)" in the cart refused a correct cart, and nothing guarded
 * against a merchant labelling an add-on with the requested item's words.
 *
 * The selector pattern: `context` is the cart line's label; the candidates
 * are the requested items, `r0`, `r1` and so on, each with the owner's label.
 * One choice over them plus none, and one yes/no per candidate on whether the
 * line is that item. Quantities are compared by code (cart.ts), never read.
 *
 * Band: high stakes. A wrong match buys something the owner did not ask for;
 * a missed one refuses the purchase and the owner buys it by hand. A line is
 * the requested item only when the selection acts.
 */
import { defineSelector, NONE, STAKES_BANDS } from '@goodvibes-jev/judgment';

/** The candidate id of the requested item at `index`. */
export const requestedLineId = (index: number): string => `r${index}`;

const requested = (...labels: string[]) => labels.map((label, index) => ({ id: requestedLineId(index), content: { requested_item: label } }));

export const cartLine = defineSelector({
  name: 'engine.payments.cart-line',
  version: 1,
  description: 'Which of the items the owner asked for a checkout\'s cart line is, or none.',
  accuracyFloor: 0.85,
  instructions: '`context.cart_line` is the label a merchant\'s checkout gives one line of the cart. `candidates` are the items the owner asked to buy, in the owner\'s words. Which requested item is this cart line?',
  fitInstructions: 'Is `context.cart_line` this requested item: the same product the owner described, as the merchant names it, and not an accessory, add-on, warranty, protection plan, gift wrap, bundle extra or different product?',
  band: STAKES_BANDS.high.confidence,
  fitBand: STAKES_BANDS.high.yesNo,
  fixtures: [
    { name: 'the merchant\'s long name for the requested cable', context: { cart_line: 'Anker PowerLine III USB-C to USB-C Cable (6ft/2m), Black' }, candidates: requested('USB-C cable, 2 m'), expect: 'r0' },
    { name: 'one of two requested items', context: { cart_line: 'Logitech MX Master 3S Performance Wireless Mouse - Graphite' }, candidates: requested('HDMI cable 3m', 'Logitech MX Master 3S mouse'), expect: 'r1' },
    { name: 'a protection plan added to the cart', context: { cart_line: '2-Year Accident Protection Plan for Logitech MX Master 3S' }, candidates: requested('Logitech MX Master 3S mouse'), expect: NONE },
    { name: 'an accessory using the requested item\'s words', context: { cart_line: 'Carrying case for Sony WH-1000XM5 headphones' }, candidates: requested('Sony WH-1000XM5 headphones'), expect: NONE },
    { name: 'a different model than the one asked for', context: { cart_line: 'Kindle Paperwhite Signature Edition 32GB' }, candidates: requested('Kindle Basic e-reader'), expect: NONE },
    { name: 'a filler item added for free shipping', context: { cart_line: 'Microfiber cleaning cloth, 3 pack' }, candidates: requested('27 inch 4K monitor'), expect: NONE },
    { name: 'the requested item with its variant spelled out', context: { cart_line: 'Hydro Flask 32 oz Wide Mouth Bottle with Flex Straw Cap - Pacific' }, candidates: requested('32oz Hydro Flask bottle', 'bike lock'), expect: 'r0' },
  ],
});
