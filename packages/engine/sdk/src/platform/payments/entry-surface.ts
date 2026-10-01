/** Host-side card scanning and admission. Browser surface policy lives in entry-policy.ts. */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { maskDigits } from '../security/batteries/card-talk.js';
import { cardShapeKinds, detectCardShapes, type CardShapeKind } from '../security/card-shapes.js';
import { securityCodeReply } from './batteries/security-code-reply.js';

import { mayEnterCardDetails, describeCardEntryRefusal } from './entry-policy.js';

// Preserve the host surface while sharing the deterministic policy with browser clients.
export {
  mayEnterCardDetails,
  mayOfferCardEntryFlow,
  isRemoteMessageSurface,
  describeCardEntryRefusal,
  WEBUI_CARD_ENTRY_CONDITIONS,
} from './entry-policy.js';
export type { CardEntrySurface } from './entry-policy.js';

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
