/**
 * card-material.ts, keys that must never round-trip into this surface,
 * full stop.
 *
 * Card NUMBER, expiry and CVV live in the daemon's secret store
 * (schema-domain-payments.ts's header: "Card MATERIAL never appears here"),
 * never in CONFIG_SCHEMA, so under normal operation no schema-driven field
 * ever renders one. This module is the belt-and-suspenders backstop for the
 * one path settings-model.ts otherwise takes on faith: a key present in the
 * LIVE config but absent from the schema still renders, as a read-only raw
 * row, "so nothing the daemon actually holds becomes invisible." That rule is
 * right for ordinary config and wrong for card material, a raw row that
 * happened to hold a card number or CVV must be genuinely invisible, not
 * masked. isCardMaterialKey() is that one deliberate exception, applied in
 * settings-model.ts to strip matching keys out of every row source (plain,
 * feature-owned, and raw) before they ever reach a component.
 *
 * This is a distinct, stronger check than config-redaction.ts's
 * isSecretConfigKey(): a secret-shaped key (token/password/apiKey/...) still
 * renders, masked, with a write-only "Replace" path, acceptable for a bot
 * token. Card material must never be entered OR displayed here at all, so a
 * matching key is dropped from the model entirely rather than rendered
 * masked.
 *
 * Matching is word-boundary-aware (camelCase- and separator-split), not a
 * bare substring test, and checks only the FINAL word component, never a
 * bare `/pan/i` or "any word" test. Two failure directions have to be
 * balanced here, in different keys:
 *   - `payments.cvvHandling` and a hypothetical `map.panEnabled` are real,
 *     legitimate, non-secret settings where "cvv"/"pan" is the FIRST word of
 *     a compound (a policy/feature name qualifying it), these must render.
 *   - `payments.cards.visa.cvv`, `...pan`, and a hypothetical `...rawPan` are
 *     card material, where "cvv"/"pan" IS the trailing, identifying word.
 * Checking only the last word component distinguishes these correctly. A
 * bare substring test would also wrongly hide ordinary words that merely
 * CONTAIN "pan" (e.g. "companyName", "japanRegion"), the word-split (rather
 * than substring) match avoids that failure too.
 */

/** Trailing word tokens (after camelCase/separator splitting) that mean card material. */
const CARD_MATERIAL_WORD_TOKENS: ReadonlySet<string> = new Set(['cvv', 'cvv2', 'cvc', 'cvc2', 'pan']);

/**
 * Whole keys that are card material but whose LAST word is an ordinary one.
 *
 * `payments.cardExpiry` and `payments.cardholderName` end in "expiry" and
 * "name", words that must never become trailing-token rules, because
 * `payments.billingAddress.name` is a legitimate, displayable setting and a
 * "name" token would hide it (along with every other `*.name` key in the
 * schema). Matching these two by their FULL key instead keeps the rule exact:
 * all four card-material fields the card-entry surface writes
 * (payments.cardNumber, payments.cardExpiry, payments.cardCvv,
 * payments.cardholderName) are non-displayable, and nothing else moves.
 *
 * They are here because "never rendered back after entry" is a condition of the
 * owner's card-entry ruling, and it has to hold for every card field rather
 * than only the two whose names happen to trip a word rule. In practice these
 * keys hold a `goodvibes://secrets/...` reference rather than a value, the
 * daemon secret store holds the value, so this is the belt-and-suspenders
 * layer, not the primary one.
 */
const CARD_MATERIAL_EXACT_KEYS: ReadonlySet<string> = new Set([
  'payments.cardExpiry',
  'payments.cardholderName',
]);

/** Whole-segment (fully concatenated, case-insensitive) forms of "card number". */
const CARD_MATERIAL_COMPOUND_SEGMENTS: ReadonlySet<string> = new Set(['cardnumber', 'cardnum', 'cardno']);

/** Split a dotted key's last segment into lowercase words on camelCase humps and separators. */
function wordsOfLastSegment(key: string): string[] {
  const lastSegment = key.split('.').pop() ?? key;
  return lastSegment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 0);
}

/**
 * True when `key`'s last dotted segment names card material, a card number
 * (PAN), a CVV/CVC, or a compound like `cardNumber`, by exact trailing-word
 * match, never a bare substring match. Keys like `payments.defaultCardId` (a
 * card ID reference, not the card itself), `payments.cvvHandling` (a policy
 * setting whose FIRST word is "cvv", not its identifying last word), or
 * `surfaces.slack.companyName` (contains "pan" only as a substring of
 * "company") correctly do not match.
 */
export function isCardMaterialKey(key: string): boolean {
  if (CARD_MATERIAL_EXACT_KEYS.has(key)) return true;
  const lastSegment = key.split('.').pop() ?? key;
  const compound = lastSegment.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  if (CARD_MATERIAL_COMPOUND_SEGMENTS.has(compound)) return true;
  const words = wordsOfLastSegment(key);
  return words.length > 0 && CARD_MATERIAL_WORD_TOKENS.has(words[words.length - 1]);
}
