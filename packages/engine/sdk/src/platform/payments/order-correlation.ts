/**
 * order-correlation.ts, recognising the store's confirmation when it arrives.
 *
 * ══ This CORRELATES. It does not gate ═════════════════════════════════════
 *
 * An earlier design registered an expectation for the confirmation, the way a
 * signup registers one for a verification link. That was the wrong instrument
 * and it is worth saying why, because the two look alike.
 *
 * An expectation exists to AUTHORIZE. A verification link lets an agent do
 * something, click through and complete a signup, so it must have been asked
 * for in advance, correlated to an address minted for that one service, and
 * expired aggressively. `google/verification-expectations.ts` is built entirely
 * around that, and its own header names the excluded cases: a password reset
 * nobody asked for, a security alert, AN INVOICE. An order confirmation is
 * invoice-shaped, it arrives at the owner's real address rather than a minted
 * alias, and nothing is authorized by it. Adding it there would have widened
 * exactly the hole that module keeps small.
 *
 * Telling the owner that a piece of mail arrived requires no authorization at
 * all. The general inbound path already records unexpected mail and reports it.
 * All this module adds is recognition: when mail arrives from a domain we
 * bought something at moments ago, the owner should read "this is the order you
 * approved" rather than an unrelated receipt they have to place themselves.
 *
 * So: no registration, no interception, no expiry, nothing held. A lookup
 * against the purchase records that are being written anyway.
 *
 * ══ Matching is on OUR record, never on the mail's claims ═════════════════
 *
 * The mail proposes a sender domain, an arrival time and some text. The
 * candidates come from the purchase ledger: a message claiming to be from a
 * merchant we never bought from correlates to nothing, and a message from a
 * merchant we DID buy from still cannot alter what we recorded, it can only be
 * recognised as relating to it.
 *
 * The sender domain is compared as a REGISTRABLE DOMAIN computed by us from the
 * envelope, against the registrable domain we computed from the validated
 * checkout url. Stores routinely send from a different subdomain than they sell
 * from, `order-update.example.com` for a purchase at `www.example.com`, so
 * subdomains of the same registrable domain match, and a different registrable
 * domain does not, however similar it looks. Mail that arrived before the
 * purchase cannot be its confirmation, whatever it says.
 *
 * Whether a same-domain mail is ABOUT a given purchase (its confirmation,
 * receipt, shipping or delivery update) is read by Jev per candidate
 * (`engine.payments.order-mail`), from the mail and our record of the
 * purchase. It replaces a six-hour window, which matched a promotion from the
 * same shop minutes later and missed a shipping notice the next day.
 *
 * ══ Which OUTCOMES are eligible, and why a match never rewrites one ═══════
 *
 * A record only correlates when the click was actually issued: `purchased` and
 * `submitted-unverified` both mean the submit reached the driver, and only
 * those two are checked below. Every refused or cancelled outcome never
 * clicked submit, so mail from that domain arriving afterward is not that
 * purchase's confirmation, whatever it claims; it is unrelated mail, which the
 * general inbound path still records and reports on its own.
 *
 * `submitted-unverified` is deliberately INCLUDED rather than treated as not
 * yet a real purchase. It is exactly the outcome whose report already tells
 * the owner "check your order history at this merchant", and a piece of mail
 * from that same merchant about that order is the single strongest signal
 * available that it went through, so it is the case where recognition is most
 * worth doing, not least.
 *
 * What a match does NOT do is rewrite the stored record. This module recognises
 * mail; it does not re-verify a purchase after the fact. A `matched` result
 * against a `submitted-unverified` record still carries that record with its
 * `outcome` untouched, `verified` was decided once, at submit time, from what
 * the driver itself saw, and a later email is evidence for the OWNER to read,
 * not evidence this module is positioned to fold back into the audit trail.
 *
 * ══ No card material reaches a reading ════════════════════════════════════
 *
 * The subject and body have every card-shaped span redacted
 * (`redactCardShapes`: card numbers by the Luhn checksum in code, security
 * codes and expiry dates by the digit-masked card-talk reading) before any
 * reading here sees them.
 */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { mapLimit, type Selector } from '@goodvibes-jev/judgment';
import { redactCardShapes } from '../security/card-shapes.js';
import { registrableDomain } from '../security/public-suffix.js';
import { sanitizeNoticeField } from '../security/notice-text.js';
import {
  clipMail,
  identifierCandidates,
  orderMail,
  orderNumber,
  SHIP_DATE_ROLE,
  shipDate,
  trackingReference,
  type OrderMailView,
} from './batteries/confirmation.js';
import type { PurchaseRecord } from './checkout-flow.js';

/** The decision sites the confirmation readings are logged under. */
export const ORDER_MAIL_SITE = 'payments.order-mail';
export const CONFIRMATION_FACTS_SITE = 'payments.confirmation-facts';

/** How many candidate purchases are read at once. */
const ORDER_MAIL_CONCURRENCY = 4;
/** Most identifier candidates one selection offers (the choice limit, less the none option). */
const MAX_CANDIDATES_PER_PICK = 254;

const CORRELATABLE_OUTCOMES: ReadonlySet<string> = new Set(['purchased', 'submitted-unverified']);

export interface InboundMailFacts {
  /** The envelope sender, as the mail surface parsed it. */
  readonly senderAddress: string;
  readonly receivedAtMs: number;
  readonly subject: string;
  /** The body as text. Card-shaped spans are redacted here before any reading. */
  readonly body: string;
}

export type CorrelationResult =
  | { readonly kind: 'matched'; readonly record: PurchaseRecord; readonly senderDomain: string }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly PurchaseRecord[]; readonly senderDomain: string }
  | { readonly kind: 'unrelated'; readonly reason: string };

/** The registrable domain of an email address, or null when it has none. */
export function senderRegistrableDomain(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at === -1 || at === address.length - 1) return null;
  return registrableDomain(address.slice(at + 1).trim().toLowerCase());
}

/** The mail with card-shaped spans redacted, clipped for a reading. */
async function redactedMail(mail: InboundMailFacts): Promise<{ subject: string; body: string }> {
  const [subject, body] = await Promise.all([redactCardShapes(mail.subject), redactCardShapes(mail.body)]);
  return { subject, body: clipMail(body) };
}

function orderMailView(mail: { subject: string; body: string }, receivedAtMs: number, record: PurchaseRecord): OrderMailView {
  return {
    mail: { subject: mail.subject, body: mail.body, received_at: new Date(receivedAtMs).toISOString() },
    purchase: {
      merchant: record.merchantDomain,
      item: record.item,
      total: `${record.totalMinorUnits} minor units of ${record.currency}`,
      placed_at: record.atUtc,
      outcome: record.outcome,
    },
  };
}

/** Whether the mail reads as about this purchase; only a reading that acts counts. */
async function isAboutPurchase(mail: { subject: string; body: string }, receivedAtMs: number, record: PurchaseRecord): Promise<boolean> {
  const run = await orderMail.run(judgmentPort(ORDER_MAIL_SITE), orderMailView(mail, receivedAtMs, record), { site: ORDER_MAIL_SITE });
  const reading = run.readings.about_order;
  const about = reading.verdict === 'yes' && reading.outcome === 'act';
  run.recordAction(about ? `about purchase ${record.purchaseId}` : `not about purchase ${record.purchaseId}`);
  return about;
}

/**
 * Find the purchase this mail is about, or say it is about none of them.
 *
 * Returns `ambiguous` rather than choosing when the mail reads as about two
 * purchases at the same merchant. Naming the wrong order in a message about
 * money is worse than not naming one, and the general inbound path still
 * reports the mail either way.
 */
export async function correlatePurchaseMail(
  mail: InboundMailFacts,
  records: readonly PurchaseRecord[],
): Promise<CorrelationResult> {
  const senderDomain = senderRegistrableDomain(mail.senderAddress);
  if (senderDomain === null) {
    return { kind: 'unrelated', reason: 'The sender address has no registrable domain to compare.' };
  }

  const eligible = records.filter((record) => {
    if (record.merchantDomain !== senderDomain) return false;
    if (!CORRELATABLE_OUTCOMES.has(record.outcome)) return false;
    const purchasedAtMs = Date.parse(record.atUtc);
    if (Number.isNaN(purchasedAtMs)) return false;
    // Strictly after the purchase: mail that predates the charge cannot be its
    // confirmation, however close it lands.
    return mail.receivedAtMs >= purchasedAtMs;
  });
  if (eligible.length === 0) {
    return {
      kind: 'unrelated',
      reason: `Nothing was bought at ${senderDomain} before this mail arrived.`,
    };
  }

  const redacted = await redactedMail(mail);
  const about = await mapLimit(eligible, ORDER_MAIL_CONCURRENCY, (record) => isAboutPurchase(redacted, mail.receivedAtMs, record));
  const candidates = eligible.filter((_, index) => about[index] === true);

  if (candidates.length === 0) {
    return {
      kind: 'unrelated',
      reason: `This mail from ${senderDomain} is not about anything bought there.`,
    };
  }
  if (candidates.length > 1) {
    return { kind: 'ambiguous', candidates, senderDomain };
  }
  const [record] = candidates;
  if (record === undefined) {
    return { kind: 'unrelated', reason: 'The matching purchase disappeared mid-lookup.' };
  }
  return { kind: 'matched', record, senderDomain };
}

/**
 * The three facts worth lifting out of a confirmation, and nothing else.
 *
 * ── Why extraction rather than quoting ────────────────────────────────────
 *
 * The body arrives from outside at the exact moment the owner is expecting it,
 * which makes it the most attractive thing on this whole path for an attacker
 * to forge. Rendering any span of it into a message the owner reads on their
 * phone hands whoever wrote it a channel to them.
 *
 * So only three short values are lifted, each neutralised before it can be
 * rendered, and nothing else survives. Jev reads which identifier in the body
 * is the order number and which the tracking reference, from the tokens code
 * lists (`identifierCandidates`), and when the order ships or is due, as date
 * parts code assembles (batteries/confirmation.ts). A value whose reading does
 * not act is null, and the report simply carries no order number, which is a
 * strictly better outcome than quoting a line to be helpful.
 *
 * Note what is deliberately NOT extracted: the total. We have our own, computed
 * from integers we parsed, and a total taken from the email would be a number
 * an attacker chose sitting next to the words "charged to your card".
 */
export interface ConfirmationFacts {
  readonly orderNumber: string | null;
  /** When the order ships or is due, as YYYY-MM-DD. */
  readonly shipDate: string | null;
  readonly trackingReference: string | null;
}

/**
 * The candidate `selector` picks, or null. Candidates beyond one choice's
 * limit are offered in groups, and the groups' picks offered again, so every
 * token is considered however long the mail is.
 */
async function pickIdentifier(
  selector: Selector,
  candidates: readonly { readonly id: string; readonly content: { readonly token: string; readonly around: string } }[],
  context: { readonly subject: string; readonly source: string },
): Promise<string | null> {
  if (candidates.length === 0) return null;
  const port = judgmentPort(CONFIRMATION_FACTS_SITE);
  let pool = [...candidates];
  while (pool.length > 0) {
    const groups: (typeof pool)[] = [];
    for (let start = 0; start < pool.length; start += MAX_CANDIDATES_PER_PICK) groups.push(pool.slice(start, start + MAX_CANDIDATES_PER_PICK));
    const picks = await Promise.all(groups.map(async (group) => {
      const selection = await selector.select(port, context, group, { site: CONFIRMATION_FACTS_SITE });
      const chosen = selection.outcome === 'act' && selection.chosen !== undefined
        ? group.find((candidate) => candidate.id === selection.chosen)
        : undefined;
      selection.recordAction(chosen === undefined ? 'none' : 'picked');
      return chosen;
    }));
    const winners = picks.filter((pick): pick is (typeof pool)[number] => pick !== undefined);
    if (groups.length === 1) return winners[0]?.content.token ?? null;
    pool = winners;
  }
  return null;
}

/** YYYY-MM-DD of a millisecond time, in UTC. */
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Pull the structured facts out of a confirmation.
 *
 * Takes the raw text and returns only neutralised short values. The caller must
 * never pass the body itself onward; there is deliberately no field on the
 * result that could carry it. `receivedAtMs` anchors relative dates such as
 * "arriving tomorrow".
 */
export async function extractConfirmationFacts(mail: Pick<InboundMailFacts, 'subject' | 'body' | 'receivedAtMs'>): Promise<ConfirmationFacts> {
  const { subject, body } = await redactedMail({ ...mail, senderAddress: '' });
  const candidates = identifierCandidates(body);
  const context = { subject, source: 'a shop\'s mail about an order' };
  const [order, tracking, date] = await Promise.all([
    pickIdentifier(orderNumber, candidates, context),
    pickIdentifier(trackingReference, candidates, context),
    shipDate.extract(judgmentPort(CONFIRMATION_FACTS_SITE), body, SHIP_DATE_ROLE, utcDay(mail.receivedAtMs), { site: CONFIRMATION_FACTS_SITE }),
  ]);
  const clean = (value: string | null, max: number): string | null => {
    if (value === null) return null;
    const neutralised = sanitizeNoticeField(value, max);
    return neutralised.length === 0 ? null : neutralised;
  };
  const shipDateValue = date.outcome === 'act' ? date.date : null;
  date.recordAction(shipDateValue === null ? 'no ship date' : 'ship date taken');
  return {
    orderNumber: clean(order, 40),
    shipDate: clean(shipDateValue, 40),
    trackingReference: clean(tracking, 60),
  };
}
