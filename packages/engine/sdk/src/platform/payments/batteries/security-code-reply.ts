/**
 * `engine.payments.security-code-reply`: the owner was just asked for their
 * card's security code; does this reply give it? Read by Jev in place of
 * entry-surface.ts's CVV_SHAPED test (the whole message a bare three or four
 * digits), which missed "it's 482" and "cvv 482 thanks" and took "100" sent
 * in answer to something else.
 *
 * Asked only when a security code was the last thing asked for; without that
 * context the general card-talk reading (security/batteries/card-talk.ts)
 * decides. Like that reading it never sees a digit: code replaces every
 * digit with `#` before asking.
 *
 * Band: high stakes. A wrong no leaves a security code on a remote channel
 * without telling the owner to delete it; a wrong yes sends one refusal
 * about a harmless number. Code treats anything but a confident no as yes.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';
import { maskDigits } from '../../security/batteries/card-talk.js';

export const securityCodeReply = defineBattery({
  name: 'engine.payments.security-code-reply',
  version: 1,
  description: 'Whether a reply to a request for a card\'s security code gives the code; digits are masked before asking.',
  accuracyFloor: 0.85,
  items: {
    gives_code: yesNo(
      'An assistant asked its owner for the security code printed on their payment card, and the state is the owner\'s reply. Before you see the reply, every digit the owner typed was replaced by `#`, so `###` is the owner typing a three digit number and `####` a four digit one. In this reply, is the owner sending a number as the card\'s security code?',
      STAKES_BANDS.high.yesNo,
      {
        true: 'The owner typed a 3 or 4 digit number as the answer: on its own, or with words such as "it is" or "cvv".',
        false: 'The reply does not give the code: it refuses, asks a question back, changes the subject, or its number is something else, such as a time, an amount, or the last four digits of a card number used to say which card is meant.',
      },
    ),
  },
  fixtures: [
    { name: 'the bare code', state: maskDigits('482'), expect: { gives_code: 'yes' } },
    { name: 'the code in a sentence', state: maskDigits('it\'s 482'), expect: { gives_code: 'yes' } },
    { name: 'the code with a label and thanks', state: maskDigits('cvv 7311 thanks'), expect: { gives_code: 'yes' } },
    { name: 'a refusal', state: maskDigits('I\'d rather type it at the terminal'), expect: { gives_code: 'no' } },
    { name: 'a question back', state: maskDigits('which card, the one ending 4242?'), expect: { gives_code: 'no' } },
    { name: 'a number about something else', state: maskDigits('I will be home after 1700, do it then'), expect: { gives_code: 'no' } },
  ],
});
