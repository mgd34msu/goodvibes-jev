/**
 * The confirmation-mail readings order-correlation.ts runs:
 *
 * - `engine.payments.order-mail`: is this mail about this purchase (its
 *   confirmation, receipt, shipping or delivery update)? In place of the
 *   six-hour CONFIRMATION_WINDOW_MS, which matched any mail from the shop's
 *   domain within six hours, a promotion included, and missed a shipping
 *   notice sent the next day.
 * - `engine.payments.order-number` and `engine.payments.tracking-reference`:
 *   which identifier in the mail is the order number, and which the parcel's
 *   tracking reference, or none. In place of the ORDER_NUMBER and TRACKING
 *   regexes, which took whatever token followed the word "order" or
 *   "tracking" ("Order online at ..." gave "online"; "Tracking will follow"
 *   gave nothing; a tracking number after "Your parcel:" was missed).
 * - `engine.payments.ship-date`: the date-parts pattern for when the order
 *   ships or is due, in place of the SHIP_DATE regex. Code assembles the date.
 *
 * The identifier candidates are every token of letters, digits and dashes
 * with at least one digit and three or more characters, listed by code
 * (identifierCandidates) with the text around each; which of them is which is
 * the reading's. The body has card-shaped spans redacted before any reading
 * sees it (order-correlation.ts), so no card number reaches Jev.
 *
 * Bands: medium stakes for the match and the identifiers. A wrong match
 * names the wrong order in a message to the owner, and correlation already
 * refuses to name one when two readings match; a wrong identifier is a wrong
 * reference the owner may quote to the shop. Low stakes for the ship date,
 * an informational line in the notice that decides nothing. Only readings
 * that act are used.
 */
import { defineBattery, defineDatePartsReader, defineSelector, NONE, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

/** Most characters of a mail body one request carries; longer text is clipped with a note. */
export const MAX_MAIL_CHARS = 20_000;
/** Characters of surrounding text shown with each identifier candidate. */
const CANDIDATE_CONTEXT_CHARS = 60;

export function clipMail(text: string): string {
  return text.length <= MAX_MAIL_CHARS ? text : `${text.slice(0, MAX_MAIL_CHARS)}\n[${text.length - MAX_MAIL_CHARS} more characters]`;
}

/** The mail and one purchase, as the order-mail reading sees them. */
export type OrderMailView = {
  readonly mail: { readonly subject: string; readonly body: string; readonly received_at: string };
  readonly purchase: {
    readonly merchant: string;
    readonly item: string;
    readonly total: string;
    readonly placed_at: string;
    readonly outcome: string;
  };
};

const IDENTIFIER = /[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?/g;
const HAS_DIGIT = /\d/;
const MIN_IDENTIFIER_CHARS = 3;

/**
 * Every identifier-shaped token in `text`, first occurrence only, with the
 * text around it. This lists what could be a reference at all (letters,
 * digits and dashes, one digit or more); it decides nothing about which one
 * is which.
 */
export function identifierCandidates(text: string): { id: string; content: { token: string; around: string } }[] {
  const seen = new Set<string>();
  const candidates: { id: string; content: { token: string; around: string } }[] = [];
  for (const match of text.matchAll(IDENTIFIER)) {
    const token = match[0];
    if (token.length < MIN_IDENTIFIER_CHARS || !HAS_DIGIT.test(token) || seen.has(token)) continue;
    seen.add(token);
    const start = match.index ?? 0;
    const around = text.slice(Math.max(0, start - CANDIDATE_CONTEXT_CHARS), start + token.length + CANDIDATE_CONTEXT_CHARS).replace(/\s+/g, ' ').trim();
    candidates.push({ id: `t${candidates.length}`, content: { token, around } });
  }
  return candidates;
}

const PURCHASE = { merchant: 'bestbuy.com', item: 'USB-C hub', total: '42.78 USD', placed_at: '2026-03-02T14:05:00Z', outcome: 'purchased' };
const view = (subject: string, body: string, received_at: string, purchase = PURCHASE): OrderMailView => ({ mail: { subject, body, received_at }, purchase });

export const orderMail = defineBattery({
  name: 'engine.payments.order-mail',
  version: 1,
  description: 'Whether an inbound mail from a shop is about one recorded purchase: its confirmation, receipt, shipping or delivery update.',
  accuracyFloor: 0.85,
  items: {
    about_order: yesNo(
      '`mail` arrived from the shop in `purchase.merchant`, where the owner\'s assistant made the purchase in `purchase` at `purchase.placed_at`. Is this mail about that purchase: its order confirmation, receipt, payment notice, shipping, dispatch or delivery update, or a problem with it?',
      STAKES_BANDS.medium.yesNo,
      {
        true: 'The mail concerns this purchase: it names the item, the total, or an order placed around that time, and is not marketing.',
        false: 'The mail is about something else: a promotion, a newsletter, an account notice, a different order, or a review request with no order details.',
      },
    ),
  },
  fixtures: [
    { name: 'the confirmation minutes later', state: view('Your Best Buy order has been received', 'Thanks for your order! Order #BBY01-806512334. USB-C hub x1. Order total $42.78.', '2026-03-02T14:07:10Z'), expect: { about_order: 'yes' } },
    { name: 'a shipping notice the next day', state: view('Your order is on the way', 'Good news: your USB-C hub has shipped. Track it with UPS 1Z999AA10123456784. Estimated delivery Thursday, March 5.', '2026-03-03T09:30:00Z'), expect: { about_order: 'yes' } },
    { name: 'a promotion within an hour', state: view('Weekend deals: up to 40% off TVs', 'Shop the biggest TV sale of the season. Offers end Sunday. Unsubscribe anytime.', '2026-03-02T15:00:00Z'), expect: { about_order: 'no' } },
    { name: 'a different, older order', state: view('Your order has shipped', 'Your order #BBY01-771122009 (Sony WH-1000XM5 headphones, $348.00, placed February 20) has shipped.', '2026-03-02T16:20:00Z'), expect: { about_order: 'no' } },
    { name: 'an account notice', state: view('Your password was changed', 'The password on your Best Buy account was changed. If this was not you, contact us.', '2026-03-02T14:30:00Z'), expect: { about_order: 'no' } },
  ],
});

const CONFIRMATION = 'Thanks for shopping with us! Order number: W1234-88812. Placed Mar 2, 2026. Items: USB-C hub x1 $34.99. Subtotal $34.99, shipping $4.99, tax $2.80, total $42.78. Call 1-800-433-7200 with questions.';
const SHIPPED = 'Your package is on its way. Carrier: UPS. Your parcel: 1Z999AA10123456784. Order W1234-88812 shipped March 3 and should arrive by March 6. Store #1123, 7601 Penn Ave S.';
const PENDING = 'We received your order 55-20931-3301 and will email tracking details when it ships. Questions? Call 800-555-0142.';
const PROMO = 'Order online at store.example.com and save 15% with code SPRING24 through April 30.';

const idContext = (subject: string) => ({ subject, source: 'a shop\'s mail about an order' });

export const orderNumber = defineSelector({
  name: 'engine.payments.order-number',
  version: 1,
  description: 'Which identifier in a shop\'s mail is the order number, or none.',
  accuracyFloor: 0.85,
  instructions: '`candidates` are the identifier-shaped tokens found in a shop\'s mail, each with the text `around` it. Which one is the shop\'s order number (also called order ID or confirmation number) for the order the mail is about?',
  fitInstructions: 'Is this candidate\'s `token` the order number, order ID or confirmation number of the order, rather than a phone number, a price, a date, a store number, a promotion code or a tracking number?',
  band: STAKES_BANDS.medium.confidence,
  fitBand: STAKES_BANDS.medium.yesNo,
  fixtures: [
    { name: 'an order number beside a phone number and prices', context: idContext('Order confirmation'), candidates: identifierCandidates(CONFIRMATION), expect: 't0' },
    { name: 'an order number in a shipping notice', context: idContext('Your order has shipped'), candidates: identifierCandidates(SHIPPED), expect: 't1' },
    { name: 'a dashed order id', context: idContext('Order received'), candidates: identifierCandidates(PENDING), expect: 't0' },
    { name: 'a promotion with no order', context: idContext('Spring sale'), candidates: identifierCandidates(PROMO), expect: NONE },
  ],
});

export const trackingReference = defineSelector({
  name: 'engine.payments.tracking-reference',
  version: 1,
  description: 'Which identifier in a shop\'s mail is the parcel\'s tracking reference, or none.',
  accuracyFloor: 0.85,
  instructions: '`candidates` are the identifier-shaped tokens found in a shop\'s mail, each with the text `around` it. Which one is the carrier tracking number for the parcel?',
  fitInstructions: 'Is this candidate\'s `token` a carrier tracking number for the parcel, rather than an order number, a phone number, a store number, a date or a price?',
  band: STAKES_BANDS.medium.confidence,
  fitBand: STAKES_BANDS.medium.yesNo,
  fixtures: [
    { name: 'a UPS number after "Your parcel:"', context: idContext('Your order has shipped'), candidates: identifierCandidates(SHIPPED), expect: 't0' },
    { name: 'tracking promised later', context: idContext('Order received'), candidates: identifierCandidates(PENDING), expect: NONE },
    { name: 'a confirmation with no parcel yet', context: idContext('Order confirmation'), candidates: identifierCandidates(CONFIRMATION), expect: NONE },
  ],
});

/** The date the ship-date reading asks for. */
export const SHIP_DATE_ROLE = 'the date the order is expected to be delivered, or the date it ships when the mail gives no delivery date';

export const shipDate = defineDatePartsReader({
  name: 'engine.payments.ship-date',
  version: 1,
  description: 'When a shop\'s mail says the order ships or is due, as its date parts.',
  accuracyFloor: 0.85,
  band: STAKES_BANDS.low.confidence,
  fixtures: [
    { name: 'arrives by a named date', document: SHIPPED, role: SHIP_DATE_ROLE, today: '2026-03-03', expect: '2026-03-06' },
    { name: 'estimated delivery with a weekday', document: 'Estimated delivery: Thursday, March 5. Thanks for your order.', role: SHIP_DATE_ROLE, today: '2026-03-02', expect: '2026-03-05' },
    { name: 'arriving tomorrow', document: 'Great news, your order is arriving tomorrow between 10am and 2pm.', role: SHIP_DATE_ROLE, today: '2026-03-04', expect: '2026-03-05' },
    { name: 'no date stated', document: PENDING, role: SHIP_DATE_ROLE, today: '2026-03-02', expect: NONE },
  ],
});
