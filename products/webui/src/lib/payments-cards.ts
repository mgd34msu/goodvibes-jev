/**
 * payments-cards.ts, the pure half of card entry on THIS surface: which
 * surface we are, whether the SDK's allowlist lets a card be typed here, and
 * how a typed draft becomes the `payments.cards.create` input the daemon
 * accepts. No React, no I/O, so every rule below is unit-testable without a
 * DOM or a daemon.
 *
 * ── Why the webui may take a card at all ──────────────────────────────────
 *
 * The owner was asked directly whether the webui should accept raw card
 * details, with the exposure stated in front of him (a PAN on a browser page,
 * form autofill, password managers, browser history, XSS in our own UI). He
 * chose the option labelled "Card entry in webui too", and then wrote:
 *
 *   "so is the webui getting card input? i said yes..."
 *
 * Recorded in the SDK as docs/decisions/2026-07-27-card-entry-surfaces.md, and
 * enforced in code by `platform/payments/entry-surface.ts`, whose
 * CARD_ENTRY_SURFACES allowlist is the authority this module defers to. The
 * surface list is NEVER duplicated here: `mayEnterCardDetailsHere()` asks the
 * SDK. If a later ruling closes the webui again, that one edit in the SDK
 * turns this whole surface off, with no webui change and no stale copy to miss.
 *
 * ── The six conditions came WITH the ruling ───────────────────────────────
 *
 * The option he selected carried them; they are part of what he chose, not
 * advice added afterwards. The SDK ships them as `WEBUI_CARD_ENTRY_CONDITIONS`
 * so no surface can implement a weaker version, but that export is not in the
 * SDK version this app pins (see the note on CARD_ENTRY_CONDITIONS below), so
 * the text is mirrored here verbatim and pinned by a test against the SDK's
 * copy the moment the pin catches up.
 *
 * A browser adds attack surface a terminal does not, which is exactly why the
 * conditions arrived attached to the ruling rather than after it.
 */
import { mayEnterCardDetails, mayOfferCardEntryFlow } from '@goodvibes-jev/engine/sdk/platform/payments/browser';
import { majorTextToMinorUnits, InvalidMoneyInputError } from './money';

/**
 * This surface's identity, as the SDK's entry-surface allowlist names it.
 *
 * A constant rather than a literal at each call site so the gate below is
 * checking a real, single answer to "which surface is this?", and so a test
 * can drive the refusal path with a different surface without pretending this
 * app is something else.
 */
export const WEBUI_CARD_ENTRY_SURFACE = 'webui';

/**
 * The conditions the owner attached to webui card entry, verbatim.
 *
 * MIRRORED, not imported: the SDK exports these as WEBUI_CARD_ENTRY_CONDITIONS
 * from `platform/payments`, but that export does not exist in the SDK build
 * this app resolves against, so importing it would not compile. The strings
 * below are character-for-character the SDK's. `payments-cards.test.ts` pins
 * them structurally (count and content), and the moment the SDK pin carries
 * the export, that test switches to comparing against it directly and this
 * copy goes away.
 */
export const CARD_ENTRY_CONDITIONS: readonly string[] = [
  'Card fields are posted over the authenticated daemon channel, the same path as any other secret.',
  'Card values never appear in a URL, not a query parameter, not a fragment, not a path segment.',
  'Card values are never rendered back after entry: no response returns them and no field is repopulated from the server.',
  'Every card field carries autocomplete="off".',
  'Card fields must not present as ones a password manager offers to save.',
  'No card value is retained in DOM state, cleared from component state after submit, never left in a store, a form-library cache, or state that survives navigation.',
];

/**
 * The operator method card material goes out on, and the shape its route must
 * keep.
 *
 * Pinned as data so a test can assert it rather than trust it. POST is not a
 * stylistic preference here: `invokeOperator` puts a GET method's input in the
 * query string and a POST method's input in the request body, so a route that
 * ever flipped to GET would put the card number in a URL, condition 2, broken
 * silently and without any change to this file. The test that reads this
 * constant is what makes that a build failure instead.
 */
export const CARD_CREATE_METHOD_ID = 'payments.cards.create';
export const CARD_CREATE_HTTP_METHOD = 'POST';
export const CARD_CREATE_PATH = '/api/payments/cards';

/**
 * The attributes every card input carries, in one place.
 *
 * Spread onto each input rather than typed out per field, so a fifth card field
 * cannot be added without them, the failure mode this guards against is a new
 * input that quietly misses one, which no amount of care at the call site
 * prevents reliably.
 *
 * `autoComplete: 'off'` is condition 4 outright. The rest serve condition 5:
 * autocomplete="off" alone is widely ignored by password managers, so the
 * vendor opt-outs 1Password, LastPass and Bitwarden actually honor are set
 * explicitly. The other half of condition 5 is structural and lives in the
 * component: no <form> element to submit, and no `name` attribute to match on.
 *
 * Lives here rather than beside the component so this module, the one with no
 * React in it, owns every rule the ruling imposed, and so the component file
 * exports only a component.
 */
export const CARD_INPUT_GUARDS = {
  autoComplete: 'off',
  autoCorrect: 'off',
  autoCapitalize: 'off',
  spellCheck: false,
  'data-1p-ignore': '',
  'data-lpignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
} as const;

/** The four fields that are card MATERIAL, the values every condition is about. */
export const CARD_MATERIAL_FIELDS = ['number', 'expiry', 'cvv', 'cardholderName'] as const;
export type CardMaterialField = (typeof CARD_MATERIAL_FIELDS)[number];

/** What the operator sees on screen, before validation turns it into daemon input. */
export interface CardDraft {
  readonly label: string;
  readonly kind: 'virtual' | 'real';
  readonly number: string;
  readonly expiry: string;
  readonly cvv: string;
  readonly cardholderName: string;
  /** Issuer-declared spend cap in MAJOR units, as typed. Empty means none declared. */
  readonly issuerCap: string;
}

/**
 * A blank draft.
 *
 * Also the reset used after a successful submit, condition 6 is implemented by
 * assigning this back over component state, so "cleared" means every card field
 * returns to the same empty value it started at, not merely the ones someone
 * remembered to list at the clear site.
 *
 * `kind` defaults to 'virtual' deliberately. A virtual card with a hard issuer
 * cap bounds what any leak of stored card material could cost to one killable
 * number; a real card number cannot be capped by anything this software does.
 * That is guidance the design states plainly, so the safer option is the one
 * already selected rather than the one the operator has to go find.
 */
export function emptyCardDraft(): CardDraft {
  return { label: '', kind: 'virtual', number: '', expiry: '', cvv: '', cardholderName: '', issuerCap: '' };
}

/** The daemon's `payments.cards.create` input (operator-contract-schemas-payments.ts). */
export interface CardCreateInput {
  readonly label: string;
  readonly kind: 'virtual' | 'real';
  readonly number: string;
  readonly expiryMonth: number;
  readonly expiryYear: number;
  readonly cvv: string;
  readonly cardholderName: string;
  readonly issuerCapMinorUnits: number | null;
}

/**
 * A validation failure, naming the field and what is wrong.
 *
 * The message NEVER contains the offending value. A rejected card number is
 * still a card number, and an error string reaches the DOM, a toast, and
 * anything reading either, the same reason the daemon's own create handler
 * refuses to forward its underlying error message.
 */
export class CardDraftError extends Error {
  constructor(
    readonly field: keyof CardDraft,
    message: string,
  ) {
    super(message);
    this.name = 'CardDraftError';
  }
}

/** Digits only, so "4242 4242 4242 4242" and "4242-4242-4242-4242" both work. */
function digitsOf(text: string): string {
  return text.replace(/[^\d]/g, '');
}

/**
 * Parse "MM/YY" or "MM/YYYY" into the numeric month/year the daemon wants.
 *
 * A two-digit year maps to 2000+YY. That is the only reading a card embosses,
 * and the alternative (rejecting it) would make every card on every desk fail
 * to type.
 */
export function parseExpiry(text: string): { month: number; year: number } {
  const match = /^\s*(\d{1,2})\s*[/-]\s*(\d{2}|\d{4})\s*$/.exec(text);
  if (!match) throw new CardDraftError('expiry', 'Expiry must look like MM/YY (for example 09/29).');
  // Both groups are non-optional in the pattern, so a match guarantees both.
  const [, monthText, yearText] = match;
  const month = Number(monthText);
  if (month < 1 || month > 12) throw new CardDraftError('expiry', 'Expiry month must be between 01 and 12.');
  const rawYear = Number(yearText);
  const year = yearText.length === 2 ? 2000 + rawYear : rawYear;
  return { month, year };
}

/**
 * Turn a typed draft into daemon input, or throw the first problem found.
 *
 * Deliberately strict about shape and deliberately silent about value: length
 * and digit-shape are checked (a mistyped card is worth catching before it
 * reaches an issuer), but nothing here echoes, masks, or logs what was typed.
 *
 * Luhn is NOT checked. The daemon is the authority on whether a card works,
 * this surface is not a validator of card numbers, and a Luhn failure here
 * would only tell someone their typo was interesting.
 */
export function buildCardCreateInput(draft: CardDraft, currency = 'USD'): CardCreateInput {
  const label = draft.label.trim();
  if (!label) throw new CardDraftError('label', 'Give the card a label so you can tell it apart later.');

  // Widened to string on purpose. The DRAFT type says this is already one of
  // two values, so TypeScript considers the check dead, but the draft is built
  // from what a <select> reported, and a runtime guard on the boundary between
  // typed code and typed-by-assertion input is exactly where a real check
  // belongs. The daemon rejects a bad kind too; this just refuses it before the
  // card leaves the browser.
  const kind: string = draft.kind;
  if (kind !== 'virtual' && kind !== 'real') {
    throw new CardDraftError('kind', "Card kind must be 'virtual' or 'real'.");
  }

  const number = digitsOf(draft.number);
  if (number.length < 13 || number.length > 19) {
    throw new CardDraftError('number', 'A card number is 13 to 19 digits.');
  }

  const { month, year } = parseExpiry(draft.expiry);

  const cvv = draft.cvv.trim();
  if (!/^\d{3,4}$/.test(cvv)) throw new CardDraftError('cvv', 'The security code is 3 or 4 digits.');

  const cardholderName = draft.cardholderName.trim();
  if (!cardholderName) throw new CardDraftError('cardholderName', 'Enter the name as printed on the card.');

  let issuerCapMinorUnits: number | null = null;
  if (draft.issuerCap.trim()) {
    try {
      issuerCapMinorUnits = majorTextToMinorUnits(draft.issuerCap, currency);
    } catch (error) {
      if (error instanceof InvalidMoneyInputError) {
        throw new CardDraftError('issuerCap', 'The issuer cap must be an amount, for example 200.00.');
      }
      throw error;
    }
  }

  return { label, kind, number, expiryMonth: month, expiryYear: year, cvv, cardholderName, issuerCapMinorUnits };
}

/**
 * May a card be typed on THIS surface? Asks the SDK's allowlist; never a local list.
 *
 * Exposed as a function rather than a computed constant so a test can observe
 * it being asked, and so the answer is read at the moment of use rather than
 * frozen at module load.
 */
export function mayEnterCardDetailsHere(surface: string = WEBUI_CARD_ENTRY_SURFACE): boolean {
  return mayEnterCardDetails(surface);
}

/**
 * May the card-entry FORM be shown here at all?
 *
 * Separate from the value gate because the prompt is itself the harm: a surface
 * that cannot accept the answer must never ask the question, since asking is
 * what puts the number somewhere it should not be.
 */
export function mayOfferCardEntryHere(surface: string = WEBUI_CARD_ENTRY_SURFACE): boolean {
  return mayOfferCardEntryFlow(surface);
}
