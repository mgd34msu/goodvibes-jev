/**
 * `engine.security.card-talk`: does a message give a payment card's security
 * code or expiry date? Read by Jev in place of the card-context regex
 * (`cvv|cvc|card|expiry|security code`) that card-shapes.ts used to decide
 * whether every bare 3 or 4 digit number and every MM/YY pair in a message
 * was a card security code or expiry.
 *
 * The reading never sees a digit: code replaces every digit with `#` before
 * asking, so the question is about what the message says, and the values it
 * protects never leave the machine. Card numbers themselves stay code (the
 * Luhn checksum over a 13 to 19 digit run), for the same reason.
 *
 * Band: high stakes. A wrong no leaves a security code or expiry in a stored
 * record or a channel's history; a wrong yes hides a harmless number. Code
 * treats anything but a confident no as yes.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

/** The message with every digit replaced by `#`, which is all the reading is shown. */
export function maskDigits(text: string): string {
  return text.replace(/\p{Nd}/gu, '#');
}

export const cardTalk = defineBattery({
  name: 'engine.security.card-talk',
  version: 1,
  description: 'Whether a message gives a payment card\'s security code or expiry date; digits are masked before asking.',
  accuracyFloor: 0.85,
  items: {
    security_code: yesNo(
      'The state is a message someone sent, with every digit replaced by `#`. Does the message give a payment card\'s security code (the 3 or 4 digit CVV, CVC or CID printed on the card), as one of its `#` runs?',
      STAKES_BANDS.high.yesNo,
      {
        true: 'One of the masked numbers is stated as, or clearly is, a card\'s security code.',
        false: 'The masked numbers are something else: room or order numbers, counts, times, years, prices, PINs for other things, or there is no card talk at all.',
      },
    ),
    expiry: yesNo(
      'The state is a message someone sent, with every digit replaced by `#`. Does the message give a payment card\'s expiry date (a month and year such as ##/##), as one of its masked values?',
      STAKES_BANDS.high.yesNo,
      {
        true: 'One of the masked dates is stated as, or clearly is, a card\'s expiry.',
        false: 'The masked dates are something else: an invoice or delivery date, a date range, a deadline, or there is no card talk at all.',
      },
    ),
  },
  fixtures: [
    { name: 'card details typed into a chat', state: maskDigits('card 4111 1111 1111 1111 exp 09/28 cvv 123 thanks'), expect: { security_code: 'yes', expiry: 'yes' } },
    { name: 'security code alone', state: maskDigits('the code on the back is 482'), expect: { security_code: 'yes' } },
    { name: 'expiry in words around it', state: maskDigits('my visa runs out 11/27, can you update it'), expect: { expiry: 'yes' } },
    { name: 'German card talk', state: maskDigits('Prüfziffer ist 731, gültig bis 04/29'), expect: { security_code: 'yes', expiry: 'yes' } },
    { name: 'a room number', state: maskDigits('meet me in room 4021 at noon'), expect: { security_code: 'no', expiry: 'no' } },
    { name: 'build counts', state: maskDigits('build 872 passed, 991 queued, 100 pending'), expect: { security_code: 'no' } },
    { name: 'an invoice date', state: maskDigits('the invoice is dated 07/26'), expect: { expiry: 'no' } },
    { name: 'a date range', state: maskDigits('the window is 03/27 to 11/27'), expect: { expiry: 'no' } },
    { name: 'a purchase veto with an amount', state: maskDigits('veto the 129 dollar order from yesterday'), expect: { security_code: 'no', expiry: 'no' } },
  ],
});
