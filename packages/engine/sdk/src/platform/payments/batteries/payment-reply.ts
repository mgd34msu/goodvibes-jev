/**
 * `engine.payments.approval-reply` and `engine.payments.veto-reply`: what the
 * owner's free-text reply to a purchase notice says. Read by Jev in place of
 * the APPROVAL_WORDS and VETO_WORDS tables notice-delivery.ts matched by the
 * whole reply or its first word, which read "no problem, go ahead" as a
 * denial and "yes, but hold off until Friday" as an approval.
 *
 * The reply pattern, once per window, because the windows ask different
 * things and settle differently: an approval window asks for a yes before
 * anything is bought (silence denies), a veto window says the purchase will
 * go ahead unless the owner objects (silence proceeds). The proposal each
 * reply is read against is the notice the owner was sent.
 *
 * Code (notice-delivery.ts) takes an answer only when the reading acts; any
 * other reading, and every `unclear` one, is no answer, so the window's own
 * silence rule decides.
 *
 * Bands, per option: the reading that lets money move (approve on an
 * approval window, acknowledge on a veto window) is read at high stakes; the
 * reading that stops it (deny, object) at medium, because a wrong stop costs
 * one repeated request and a wrong go spends money.
 */
import { defineReplyReader, STAKES_BANDS } from '@goodvibes-jev/judgment';

const APPROVAL_NOTICE = 'Purchase needs your OK: USB-C hub from bestbuy.com, total 42.78 USD. It is over today\'s item budget. Reply to approve or deny; if I hear nothing in 30 minutes, nothing is bought.';
const VETO_NOTICE = 'Buying in 10 minutes unless you say stop: wireless mouse from microcenter.com, total 31.49 USD. Reply to stop it; if I hear nothing, it goes ahead.';

export const approvalReply = defineReplyReader({
  name: 'engine.payments.approval-reply',
  version: 1,
  description: 'Whether the owner\'s reply to a purchase approval request approves it, denies it, or is not an answer.',
  accuracyFloor: 0.85,
  readings: {
    approve: 'Tells the assistant to go ahead and make this purchase as described, without conditions.',
    deny: 'Tells the assistant not to make this purchase: a refusal, a cancellation, or a stop.',
    unclear: 'Neither: a question, a condition or change to the purchase, something unrelated, or an answer that could be read either way.',
  },
  band: {
    ...STAKES_BANDS.medium.confidence,
    perOption: { approve: STAKES_BANDS.high.confidence },
  },
  fixtures: [
    { name: 'a plain yes', proposal: APPROVAL_NOTICE, reply: 'yes', expect: 'approve' },
    { name: 'go ahead after a word that reads as no', proposal: APPROVAL_NOTICE, reply: 'no problem, go ahead', expect: 'approve' },
    { name: 'buy it', proposal: APPROVAL_NOTICE, reply: 'Sure, buy it.', expect: 'approve' },
    { name: 'a plain no', proposal: APPROVAL_NOTICE, reply: 'no', expect: 'deny' },
    { name: 'a refusal in words', proposal: APPROVAL_NOTICE, reply: 'Don\'t bother, I found one at work.', expect: 'deny' },
    { name: 'yes with a condition', proposal: APPROVAL_NOTICE, reply: 'yes, but hold off until Friday', expect: 'unclear' },
    { name: 'a question', proposal: APPROVAL_NOTICE, reply: 'which hub is it?', expect: 'unclear' },
    { name: 'an unrelated message', proposal: APPROVAL_NOTICE, reply: 'can you check the weather tomorrow', expect: 'unclear' },
  ],
});

export const vetoReply = defineReplyReader({
  name: 'engine.payments.veto-reply',
  version: 1,
  description: 'Whether the owner\'s reply to a purchase veto notice lets it go ahead, objects to it, or is not an answer.',
  accuracyFloor: 0.85,
  readings: {
    acknowledge: 'Tells the assistant the purchase may go ahead now, as described.',
    object: 'Tells the assistant to stop, cancel, wait or not make this purchase.',
    unclear: 'Neither: a question, a change to the purchase, something unrelated, or an answer that could be read either way.',
  },
  band: {
    ...STAKES_BANDS.medium.confidence,
    perOption: { acknowledge: STAKES_BANDS.high.confidence },
  },
  fixtures: [
    { name: 'go ahead', proposal: VETO_NOTICE, reply: 'go ahead', expect: 'acknowledge' },
    { name: 'thumbs up in words', proposal: VETO_NOTICE, reply: 'ok thanks, sounds good', expect: 'acknowledge' },
    { name: 'stop', proposal: VETO_NOTICE, reply: 'stop', expect: 'object' },
    { name: 'wait in a sentence', proposal: VETO_NOTICE, reply: 'hang on, I might already have one of those', expect: 'object' },
    { name: 'a polite no', proposal: VETO_NOTICE, reply: 'no thanks, not that one', expect: 'object' },
    { name: 'a question', proposal: VETO_NOTICE, reply: 'how much was shipping?', expect: 'unclear' },
    { name: 'an unrelated message', proposal: VETO_NOTICE, reply: 'remind me to call mom at 6', expect: 'unclear' },
  ],
});
