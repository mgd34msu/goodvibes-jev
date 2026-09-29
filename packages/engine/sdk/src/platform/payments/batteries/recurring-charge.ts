/**
 * `engine.payments.recurring-charge`: does a checkout's order summary enrol
 * the owner in a charge that repeats? Read by Jev in place of the nine
 * RECURRING_PATTERNS regexes cart.ts used (subscri.., recurring, auto-renew,
 * renews on, per month or year, monthly billing, free trial, "then $x/mo",
 * save card for future).
 *
 * The keywords guessed at what the checkout commits the owner to: "subscribe
 * to our newsletter" and "free trial of our app with every order" refused a
 * one-off purchase, while "billed every 4 weeks until cancelled" passed.
 *
 * The order summary is the merchant's own text. It is read here only to find
 * a reason to REFUSE: untrusted content may talk the flow out of an action,
 * never into one. No card has been typed when this runs (the card is filled
 * after the decision), so the summary carries no card material of ours.
 *
 * Band: high stakes. A wrong no enrols the owner in a charge nothing here
 * watches; a wrong yes costs one manual purchase. Code refuses on anything
 * but a confident no (cart.ts).
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

/** Most characters of an order summary one request carries; longer text is clipped with a note. */
export const MAX_SUMMARY_CHARS = 20_000;

/** What the reading sees: the order summary, clipped to the request budget. */
export function orderSummaryView(orderSummaryText: string): { order_summary: string } {
  const clipped = orderSummaryText.length <= MAX_SUMMARY_CHARS
    ? orderSummaryText
    : `${orderSummaryText.slice(0, MAX_SUMMARY_CHARS)}\n[${orderSummaryText.length - MAX_SUMMARY_CHARS} more characters]`;
  return { order_summary: clipped };
}

export const recurringCharge = defineBattery({
  name: 'engine.payments.recurring-charge',
  version: 1,
  description: 'Whether a checkout\'s order summary sets up a charge that repeats: a subscription, an auto-renewal, a trial that converts, or stored payment for future charges.',
  accuracyFloor: 0.85,
  items: {
    recurring: yesNo(
      '`order_summary` is the text of an online checkout\'s order summary, written by the merchant. Would completing this checkout commit the buyer to charges beyond this one payment: a subscription or membership, an automatic renewal, a free or discounted trial that turns into a paid plan, instalments, or keeping the card on file to charge again later?',
      STAKES_BANDS.high.yesNo,
      {
        true: 'The checkout sets up a repeating or future charge, however it is worded.',
        false: 'A single payment for the items in the cart; any mention of subscriptions or trials is unrelated to this charge, such as a newsletter sign-up or an advert.',
      },
    ),
  },
  fixtures: [
    { name: 'a monthly subscription', state: orderSummaryView('Coffee Club, 2 bags per month. $24.00 billed monthly. Cancel anytime.'), expect: { recurring: 'yes' } },
    { name: 'a trial that converts', state: orderSummaryView('Start your 30-day free trial of Premium today. Then $9.99/mo after the trial ends. Order total today: $0.00'), expect: { recurring: 'yes' } },
    { name: 'a renewal worded without the usual keywords', state: orderSummaryView('Water filter cartridges x3, $38.50. We will send and bill a fresh set every 4 weeks until you tell us to stop.'), expect: { recurring: 'yes' } },
    { name: 'an annual plan', state: orderSummaryView('Cloud Backup Pro, 1 year, $59.00. Your plan renews automatically each year at the then-current price.'), expect: { recurring: 'yes' } },
    { name: 'card kept for future orders', state: orderSummaryView('Order summary: USB-C hub $34.99, shipping $4.99, tax $2.80. Total $42.78. By placing this order you agree we store your card and charge it for future replenishment orders.'), expect: { recurring: 'yes' } },
    { name: 'a plain one-off order', state: orderSummaryView('USB-C cable 2m x1 $12.99. Standard shipping $4.99. Tax $1.44. Order total $19.42.'), expect: { recurring: 'no' } },
    { name: 'a newsletter box on a one-off order', state: orderSummaryView('Wireless mouse x1 $29.99. Shipping free. Total $29.99. [ ] Subscribe to our newsletter for 10% off your next order.'), expect: { recurring: 'no' } },
    { name: 'a magazine title that says subscription', state: orderSummaryView('Back issue: "Subscription Economy" special edition, print copy x1, $14.00. Shipping $3.50. Total $17.50. One-time purchase.'), expect: { recurring: 'no' } },
    { name: 'an advert for a trial elsewhere on the page', state: orderSummaryView('Desk lamp x1 $45.00. Tax $3.60. Total $48.60. Members get free shipping, try it free for 30 days from your account page.'), expect: { recurring: 'no' } },
  ],
});
