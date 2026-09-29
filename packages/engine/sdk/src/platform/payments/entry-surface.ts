/**
 * entry-surface.ts, where card details may be TYPED, which is a different
 * question from where a purchase may be APPROVED.
 *
 * ══ Attribution, stated precisely ═════════════════════════════════════════
 *
 * Owner rulings and coordinator decisions are different weights. An earlier
 * version of this file collapsed them and relayed a coordinator decision as an
 * owner ruling; the correction is kept visible rather than tidied away.
 *
 * OWNER, verbatim, on the TUI and the agent:
 *
 *   "i need to be able to enter payment details (card info and shipping/billing
 *    address etc) in the tui too"
 *   "and in the agent - basically ui should expose it in both."
 *
 * OWNER, verbatim, on the webui, asked directly after the above, given a
 * two-option choice with the exposure stated (PAN on a browser page, form
 * autofill, password managers, browser history, XSS in our own UI). The owner
 * selected the option labelled:
 *
 *   "Card entry in webui too"
 *
 * and then wrote:
 *
 *   "so is the webui getting card input? i said yes..."
 *
 * The option the owner selected carried the browser-side conditions in
 * `WEBUI_CARD_ENTRY_CONDITIONS` below. Those conditions are part of what the
 * owner chose, not a gloss added afterwards.
 *
 * COORDINATOR ruling, that card details are refused on remote messaging
 * surfaces, with the reasoning below. Recorded as the coordinator's because no
 * verbatim owner wording exists for it.
 *
 * ══ The two axes look alike and must never be merged ══════════════════════
 *
 * A later reader will notice two channel classifications here and try to unify
 * them. They answer different questions:
 *
 *   ANSWERING , may this surface say yes or no to a purchase?
 *                YES for Telegram and every other live channel. That IS the
 *                owner's explicit ruling and it stays. See types.ts,
 *                `CommandAuthorityChannel`.
 *
 *   ENTERING  , may card details be typed into this surface?
 *                The TUI, the agent's own terminal, and the webui. Not any
 *                remote messaging surface.
 *
 * Remote channels have authority to decide about a purchase. They have no path
 * for entering the instrument.
 *
 * ══ Why entering is stricter than answering ═══════════════════════════════
 *
 * A card number typed into Telegram is stored on Telegram's servers, in message
 * history nobody here controls or can erase, and it travelled through their
 * infrastructure before it ever reached us. The same is true of every hosted
 * chat channel.
 *
 * Encryption at rest is irrelevant to a value that was already copied somewhere
 * else on its way in. That is the whole argument: the damage is done before any
 * storage decision of ours applies.
 *
 * An "approve" typed into Telegram carries no such residue, it is one word
 * about one purchase, it expires, and it authorizes nothing on its own.
 *
 * ══ The prompt is itself the harm ═════════════════════════════════════════
 *
 * There is deliberately no card-entry flow that can be STARTED from a
 * non-entry surface. Prompting for a card number where the answer cannot be
 * accepted is an invitation to type it there, and the invitation is what puts
 * the number on someone else's server. Refusing the answer afterwards is too
 * late.
 */

import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { maskDigits } from '../security/batteries/card-talk.js';
import { cardShapeKinds, detectCardShapes, type CardShapeKind } from '../security/card-shapes.js';
import { securityCodeReply } from './batteries/security-code-reply.js';

/**
 * Surfaces where card details may be typed.
 *
 * The webui is here by the owner's direct ruling, and it arrives with
 * conditions the other two do not carry, see `WEBUI_CARD_ENTRY_CONDITIONS`.
 * A browser is more exposed than a terminal, which is exactly why they came
 * attached to the ruling rather than after it.
 */
export type CardEntrySurface = 'tui' | 'agent-terminal' | 'webui';

const CARD_ENTRY_SURFACES: readonly string[] = ['tui', 'agent-terminal', 'webui'];

/**
 * The conditions the owner attached to webui card entry.
 *
 * Exported so a surface cannot quietly implement a weaker version, and so a
 * reviewer has the list without going back to a transcript. Each is a
 * requirement with a test, not a recommendation.
 *
 * They exist because a browser adds attack surface a terminal does not: a URL
 * reaches history, referrers and server logs; a rendered response reaches the
 * DOM and anything reading it; a password manager copies the value somewhere
 * this system does not control; and state that survives navigation survives
 * longer than the submit that needed it.
 */
export const WEBUI_CARD_ENTRY_CONDITIONS: readonly string[] = [
  'Card fields are posted over the authenticated daemon channel, the same path as any other secret.',
  'Card values never appear in a URL, not a query parameter, not a fragment, not a path segment.',
  'Card values are never rendered back after entry: no response returns them and no field is repopulated from the server.',
  'Every card field carries autocomplete="off".',
  'Card fields must not present as ones a password manager offers to save.',
  'No card value is retained in DOM state, cleared from component state after submit, never left in a store, a form-library cache, or state that survives navigation.',
];

/**
 * Remote messaging surfaces, named so a refusal can say which one it refused.
 *
 * The list is a courtesy for the message, not the defence: `mayEnterCardDetails`
 * allows only the three entry surfaces, so anything not on that allowlist is
 * refused whether or not it appears here.
 */
const REMOTE_MESSAGE_SURFACES: readonly string[] = [
  'telegram', 'ntfy', 'discord', 'slack', 'whatsapp', 'signal', 'webhook', 'email', 'sms', 'matrix',
];

/**
 * May card details be typed on this surface?
 *
 * An ALLOWLIST, deliberately. A denylist ships every channel added after it was
 * written, and the direction to fail for card material is closed.
 */
export function mayEnterCardDetails(surface: string): boolean {
  return CARD_ENTRY_SURFACES.includes(surface.trim().toLowerCase());
}

export function isRemoteMessageSurface(surface: string): boolean {
  return REMOTE_MESSAGE_SURFACES.includes(surface.trim().toLowerCase());
}

/** The decision site the security-code reply reading is logged under. */
export const SECURITY_CODE_REPLY_SITE = 'payments.security-code-reply';

/** A bare 3 or 4 digit run: something that could be a security code at all. */
const SHORT_DIGIT_RUN = /\b\d{3,4}\b/;

const SHAPE_NAMES: Readonly<Record<CardShapeKind, 'card-number' | 'expiry' | 'cvv'>> = {
  pan: 'card-number',
  expiry: 'expiry',
  'security-code': 'cvv',
};

export interface CardDetailScan {
  readonly looksLikeCardDetails: boolean;
  /** Which shape matched, for the refusal, never the value that matched. */
  readonly matched: readonly ('card-number' | 'expiry' | 'cvv')[];
}

/**
 * Does this inbound message carry card details?
 *
 * Returns only WHICH KIND was found, never the matching text. A scanner that
 * echoed its evidence would put the card in the refusal, the log line and the
 * notification body, the exact places this exists to keep it out of.
 *
 * The same detection the remote channel gate uses (security/card-shapes.ts):
 * a card number is a 13 to 19 digit run that passes the Luhn checksum, in
 * code, because that is what a card number is and asking about one would send
 * the digits off the machine; whether a short number is a security code or an
 * `MM/YY` pair an expiry is the digit-masked `engine.security.card-talk`
 * reading. They replace a digit-count regex that took any 13 to 19 digits (an
 * order or tracking number) as a card and any `MM/YY` (a meeting date) as an
 * expiry.
 *
 * `expectingCvv` is set when the last thing we asked for was the security
 * code. A bare "482" means nothing without that context, and with it the
 * question is a different one: does this reply give the code that was asked
 * for? That is read by Jev too (`engine.payments.security-code-reply`), over
 * the reply with every digit masked, and anything but a confident no counts
 * as the code.
 */
export async function scanForCardDetails(text: string, options: { readonly expectingCvv?: boolean } = {}): Promise<CardDetailScan> {
  const found = new Set(cardShapeKinds(await detectCardShapes(text)).map((kind) => SHAPE_NAMES[kind]));
  if (options.expectingCvv === true && !found.has('cvv') && SHORT_DIGIT_RUN.test(text)) {
    const run = await securityCodeReply.run(judgmentPort(SECURITY_CODE_REPLY_SITE), maskDigits(text), { site: SECURITY_CODE_REPLY_SITE });
    const reading = run.readings.gives_code;
    const givesCode = !(reading.verdict === 'no' && reading.outcome === 'act');
    run.recordAction(givesCode ? 'treated as the security code' : 'not the security code');
    if (givesCode) found.add('cvv');
  }
  const order: readonly ('card-number' | 'expiry' | 'cvv')[] = ['card-number', 'expiry', 'cvv'];
  const matched = order.filter((kind) => found.has(kind));
  return { looksLikeCardDetails: matched.length > 0, matched };
}

/**
 * The reply the owner gets when card details arrive somewhere they cannot be accepted.
 *
 * Built from the surface name and the matched SHAPES only. It never quotes,
 * echoes, partially masks or summarizes the value it just refused, a masked
 * echo is still an echo, and the message it appears in is stored on the same
 * server the refusal is about.
 */
export function describeCardEntryRefusal(surface: string): string {
  const where = isRemoteMessageSurface(surface) ? surface : 'this channel';
  return [
    `I can't take card details over ${where}, so I have not stored anything from that message.`,
    `Anything typed here is kept on ${where}'s servers, in history I can't reach or delete,`,
    'and it passed through their systems before it ever got to me, encrypting it on my end afterwards',
    'would not undo that.',
    '',
    'Enter the card at a terminal instead: the TUI, the agent terminal, or the web UI.',
    '',
    'Please also delete the message you just sent, and if that was a real card number, treat it as exposed.',
  ].join(' ').replace(/ {2,}/g, ' ');
}

export interface CardEntryDecision {
  readonly allowed: boolean;
  readonly reason: string | null;
  /** Shapes detected, for the audit record. Never the values. */
  readonly matched: readonly ('card-number' | 'expiry' | 'cvv')[];
}

/**
 * The gate an inbound message passes before anything stores card material.
 *
 * Two refusals, in order:
 *  1. the surface may not carry card details at all; or
 *  2. the surface may, but this specific message is not a card-entry step.
 *
 * Note the asymmetry with approvals: this function has no bearing on whether
 * the same surface may approve a purchase. See the module header.
 */
export async function evaluateCardEntry(input: {
  readonly surface: string;
  readonly text: string;
  readonly expectingCvv?: boolean;
}): Promise<CardEntryDecision> {
  const scan = await scanForCardDetails(input.text, { expectingCvv: input.expectingCvv === true });
  if (mayEnterCardDetails(input.surface)) {
    return { allowed: true, reason: null, matched: scan.matched };
  }
  if (!scan.looksLikeCardDetails) {
    // Nothing card-shaped arrived; this is an ordinary message on a channel
    // that simply is not a card-entry surface. Not a refusal, just not entry.
    return { allowed: false, reason: null, matched: [] };
  }
  return {
    allowed: false,
    reason: describeCardEntryRefusal(input.surface),
    matched: scan.matched,
  };
}

/**
 * May a card-entry FLOW be offered here?
 *
 * Separate from `evaluateCardEntry` because the prompt is the harm: a surface
 * that cannot accept the answer must never ask the question.
 */
export function mayOfferCardEntryFlow(surface: string): boolean {
  return mayEnterCardDetails(surface);
}
