/**
 * card-store.ts, the daemon's card file and the material behind it.
 *
 * The SDK states the arrangement and implements neither half of it:
 * `CardMaterialStore` (platform/payments/card-material.ts) says "it is
 * implemented by the daemon against its own secret store", and the TUI's
 * payments-config.ts says card material is "named by keys the daemon's own
 * `payments.cards.create` control-plane method derives internally". This module
 * is that implementation, and the split it enforces is the whole point:
 *
 *   - METADATA (id, label, brand, last4, kind, expiry, declared issuer cap,
 *     addedAt) lives in a plain JSON file. Nothing in it can identify a card to
 *     a merchant, so it is readable by any verb that lists cards.
 *   - MATERIAL (number, expiry parts, CVV, cardholder name) lives one field per
 *     key in the daemon secret tier and is reachable only through `read()`,
 *     which is in-process by construction: nothing that calls it is a handler.
 *
 * `read()` is all-or-nothing. A partially-present card resolves to null rather
 * than to an object with empty strings in it, because the caller of `read()`
 * types what it is given into a checkout form, and a form filled with four
 * fields and a blank is a submitted order with a wrong card on it.
 *
 * ── The CVV and `payments.cvvHandling` ────────────────────────────────────
 *
 * `'prompt'` is the owner saying the CVV must not be kept. This module obeys it
 * on BOTH sides: it is not written at create time, and it is not supplied at
 * read time whatever is already in the store, so flipping the setting takes
 * effect on the cards that already exist instead of only on the next one. Under
 * 'prompt' a card reports `materialComplete: false` and `read()` answers null,
 * which is exactly what that flag is for, the descriptor for
 * `payments.cards.list` names 'CVV not set' as the case a surface renders from
 * it. The stored bytes are not purged; see `suppliesStoredCvv`.
 *
 * ── A damaged card file is refused, never read as empty ───────────────────
 *
 * `readCardsFile` reports three outcomes, not two, mirroring the SDK's own
 * secret-store reader for the reason it gives: collapsing "cannot read" into
 * "empty" is how a damaged file becomes a destroyed one. Here it was worse than
 * data loss. A `create` against a corrupt file rewrote the file with only the
 * new card, and the material of every card it silently dropped stayed in the
 * secret tier with no row left to reach it by, so `payments.cards.delete` could
 * not clear it either. Every path through this module now refuses while the
 * file exists and does not parse.
 *
 * ── No value ever reaches a log line or an error ──────────────────────────
 *
 * Every failure below is either raised with a message written here, or left to
 * the caller. Nothing catches a secret-store error and forwards its message: the
 * failing call had the card in its arguments.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { atomicWriteFileSync } from '../../config/atomic-write.js';
import { normalizeSecretKeyPart } from '../../config/daemon-secret-keys.js';
import type { CardMaterial, CardMaterialStore } from '../card-material.js';
import type { CardMetadata } from '../types.js';

// ---------------------------------------------------------------------------
// The secret port
// ---------------------------------------------------------------------------

/**
 * The three operations this store performs against the daemon secret tier.
 *
 * Narrower than `SecretsManager` on purpose, the same treatment
 * cluster-group-composition.ts gives the group key: a store that held the whole
 * manager could read any credential in the process, and this one has business
 * with five keys per card and nothing else. The composition root binds the
 * scope; nothing here chooses where a secret lands.
 */
export interface PaymentsSecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** How the owner wants the CVV handled, read live (`payments.cvvHandling`). */
export type CvvHandling = 'stored' | 'prompt';

// ---------------------------------------------------------------------------
// Secret key derivation
// ---------------------------------------------------------------------------

/**
 * The five material fields, and the suffix each one's secret key carries.
 *
 * Spelled as a list rather than derived from the `CardMaterial` type so that
 * adding a field to that interface does not silently start writing a sixth
 * secret nobody decided to store.
 */
export const CARD_MATERIAL_FIELDS = [
  'number',
  'expiryMonth',
  'expiryYear',
  'cvv',
  'cardholderName',
] as const;

export type CardMaterialField = (typeof CARD_MATERIAL_FIELDS)[number];

/**
 * `GOODVIBES_PAYMENTS_CARD_<ID>_<FIELD>`.
 *
 * Built through the same `normalizeSecretKeyPart` every other daemon secret key
 * goes through (config/secret-config.ts), so a card key looks like the mailbox
 * password key beside it in the store rather than like a second convention.
 */
export function cardSecretKey(cardId: string, field: CardMaterialField): string {
  return `GOODVIBES_PAYMENTS_CARD_${normalizeSecretKeyPart(cardId)}_${normalizeSecretKeyPart(field)}`;
}

// ---------------------------------------------------------------------------
// Metadata derived from the number, at the moment it is stored
// ---------------------------------------------------------------------------

/**
 * The brand, from the issuer identification number.
 *
 * Derived once, at create time, from a number this process is holding anyway,
 * and then the number is gone. An unrecognised prefix reports 'unknown' rather
 * than guessing: the field is a label on a settings screen, and a wrong label is
 * worse than an honest blank one.
 */
export function cardBrand(digits: string): string {
  if (/^4/.test(digits)) return 'visa';
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(digits)) return 'mastercard';
  if (/^3[47]/.test(digits)) return 'amex';
  if (/^(6011|65|64[4-9]|622)/.test(digits)) return 'discover';
  if (/^3(0[0-5]|[689])/.test(digits)) return 'diners';
  if (/^35(2[89]|[3-8]\d)/.test(digits)) return 'jcb';
  return 'unknown';
}

/** A fresh card id. Random, not derived from the number: a derived id is a digest of it. */
export function newCardId(): string {
  return `card-${randomBytes(6).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// The metadata file
// ---------------------------------------------------------------------------

const CARDS_FILE_VERSION = 1;

interface CardsFile {
  readonly version: number;
  readonly cards: readonly CardMetadata[];
}

/**
 * Raised when the card file exists and cannot be read.
 *
 * A distinct type, not a bare Error, because the handlers have to tell it apart
 * from every other failure: this one carries an operator instruction and is
 * meant to reach the caller verbatim, and the others carry a store path that
 * must not.
 */
export class CardStoreUnreadableError extends Error {
  constructor(filePath: string, reason: string) {
    super(
      `Refusing to touch the payment card store at ${filePath}: the file exists but cannot be read (${reason}). `
      + 'Reading it as empty would report your cards as gone, and writing over it would strand the card material '
      + 'in the secret store with nothing left pointing at it. Repair the file, or move it aside if you want to '
      + 'start over, then retry.',
    );
    this.name = 'CardStoreUnreadableError';
  }
}

/**
 * Three outcomes, never two.
 *
 * This mirrors the SDK's own `readEncryptedStore` (config/secrets.ts) and it
 * mirrors it because that module learned the lesson first: `missing` is a
 * legitimately empty store and `unreadable` is a file whose contents are still
 * there and merely unavailable to us, and collapsing the second into the first
 * is what turns a damaged file into a destroyed one. Here the destruction was
 * two-sided: a `create` against a corrupt file rewrote it with only the new
 * card, and the material of every card it dropped stayed in the secret tier
 * with no row left to reach it by, so `payments.cards.delete` could not clear
 * it either. Unrecoverable through any verb this daemon serves.
 */
type CardsReadResult =
  | { readonly status: 'ok'; readonly cards: CardMetadata[] }
  | { readonly status: 'missing' }
  | { readonly status: 'unreadable'; readonly reason: string };

function readCardsFile(filePath: string): CardsReadResult {
  if (!existsSync(filePath)) return { status: 'missing' };
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (error) {
    return { status: 'unreadable', reason: error instanceof Error ? error.message : 'unreadable' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { status: 'unreadable', reason: 'card file is not valid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 'unreadable', reason: 'card file has an unrecognized shape' };
  }
  const cards = (parsed as Partial<CardsFile>).cards;
  if (cards === undefined) {
    // A well-formed document with no `cards` key is an empty store somebody
    // wrote deliberately, not a damaged one. Distinct from a `cards` that is
    // present and the wrong type, which is damage.
    return { status: 'ok', cards: [] };
  }
  if (!Array.isArray(cards)) {
    return { status: 'unreadable', reason: 'card file has an unrecognized shape' };
  }
  return { status: 'ok', cards: [...cards] };
}

function writeCardsFile(filePath: string, cards: readonly CardMetadata[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const contents: CardsFile = { version: CARDS_FILE_VERSION, cards };
  atomicWriteFileSync(filePath, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 });
}

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

export interface DaemonCardStoreOptions {
  readonly filePath: string;
  readonly secrets: PaymentsSecretStore;
  /** Read live, per call: the owner can change it between two card writes. */
  readonly cvvHandling: () => CvvHandling;
  /** Injectable so a test can assert on the id it is about to look up. */
  readonly generateId?: (() => string) | undefined;
  readonly now?: (() => Date) | undefined;
}

/**
 * The daemon's card store: metadata on disk, material in the secret tier.
 *
 * Implements the SDK's `CardMaterialStore` so the checkout flow can be handed
 * this object unchanged the day `payments.checkout.*` is wired to a page driver.
 */
export class DaemonCardStore implements CardMaterialStore {
  private readonly filePath: string;
  private readonly secrets: PaymentsSecretStore;
  private readonly cvvHandling: () => CvvHandling;
  private readonly generateId: () => string;
  private readonly now: () => Date;

  constructor(options: DaemonCardStoreOptions) {
    this.filePath = options.filePath;
    this.secrets = options.secrets;
    this.cvvHandling = options.cvvHandling;
    this.generateId = options.generateId ?? newCardId;
    this.now = options.now ?? ((): Date => new Date());
  }

  /**
   * Every configured card, oldest first. Metadata only; there is no other shape.
   *
   * Raises `CardStoreUnreadableError` when the file is present and damaged,
   * rather than answering "no cards". "Your cards are gone" and "I cannot read
   * the file your cards are in" are different sentences and only one of them is
   * ever true here.
   */
  list(): readonly CardMetadata[] {
    return this.readOrRaise().cards;
  }

  async metadata(cardId: string): Promise<CardMetadata | null> {
    return this.list().find((card) => card.id === cardId) ?? null;
  }

  /**
   * Whether the store can currently SUPPLY every field `read()` requires.
   *
   * Two sources, and neither is the metadata file: the secret tier, so a card
   * whose material was cleared out from under it reports incomplete rather than
   * reporting a card that cannot be typed; and the live `payments.cvvHandling`,
   * see `suppliesStoredCvv`.
   */
  async materialComplete(cardId: string): Promise<boolean> {
    if ((await this.metadata(cardId)) === null) return false;
    for (const field of CARD_MATERIAL_FIELDS) {
      if (await this.fieldValue(cardId, field) === null) return false;
    }
    return true;
  }

  /**
   * The material. In-process callers only, and all-or-nothing.
   *
   * Never logged, never cached beyond the call, and never part of a thrown
   * error, which is the contract `CardMaterialStore` states and the reason this
   * method returns null instead of raising anything descriptive. The one thing
   * it does raise is `CardStoreUnreadableError`, from `metadata`, and that is
   * deliberate: a damaged card file means this store cannot tell whether the
   * card is configured at all, and null would claim it had checked.
   */
  async read(cardId: string): Promise<CardMaterial | null> {
    if ((await this.metadata(cardId)) === null) return null;
    const values: Partial<Record<CardMaterialField, string>> = {};
    for (const field of CARD_MATERIAL_FIELDS) {
      const value = await this.fieldValue(cardId, field);
      if (value === null) return null;
      values[field] = value;
    }
    return {
      number: values.number!,
      expiryMonth: values.expiryMonth!,
      expiryYear: values.expiryYear!,
      cvv: values.cvv!,
      cardholderName: values.cardholderName!,
    };
  }

  /**
   * Store a card: the metadata ROW first, the material second.
   *
   * Both orders leave a window, and they leave different ones. Material first
   * means a crash between the two strands key material with no row pointing at
   * it: invisible to `payments.cards.list` and therefore unreachable by
   * `payments.cards.delete`, which resolves the id through the row. Row first
   * means a crash leaves a card the owner can SEE, reporting
   * `materialComplete: false`, and can delete, which sweeps the material that
   * did land. A visible half-written card beats invisible key material, so the
   * row goes first.
   *
   * A failure this method actually catches is unwound completely: the secrets
   * that landed are cleared and the row is taken back out, so a reported failure
   * leaves nothing behind. Only a crash can leave the intermediate state, and
   * that state is the recoverable one by construction.
   */
  async create(input: CardCreateInput): Promise<CardMetadata> {
    const digits = input.number.replace(/\D/g, '');
    const cardId = this.generateId();
    const storeCvv = this.cvvHandling() === 'stored';

    // Reads before it writes, so a damaged file refuses HERE, before any secret
    // is written and before the existing rows could be dropped.
    const existing = this.readOrRaise().cards;
    const metadata: CardMetadata = {
      id: cardId,
      label: input.label,
      brand: cardBrand(digits),
      last4: digits.slice(-4),
      kind: input.kind,
      expiryMonth: input.expiryMonth,
      expiryYear: input.expiryYear,
      issuerCapMinorUnits: input.issuerCapMinorUnits,
      addedAt: this.now().toISOString(),
    };
    writeCardsFile(this.filePath, [...existing, metadata]);

    const written: CardMaterialField[] = [];
    try {
      // The NORMALIZED digits, not what was typed. Separators are a data-entry
      // convenience and a checkout field is not: `fillCard` types this value
      // verbatim, and "4111-1111 1111-1111" in a card-number input is a
      // declined order. The owner's spacing is not information worth keeping.
      await this.putField(cardId, 'number', digits, written);
      await this.putField(cardId, 'expiryMonth', String(input.expiryMonth).padStart(2, '0'), written);
      await this.putField(cardId, 'expiryYear', String(input.expiryYear), written);
      // Not written at all under 'prompt'. See the header: the card then reports
      // materialComplete: false, which is the truth and the rendered state.
      if (storeCvv) await this.putField(cardId, 'cvv', input.cvv, written);
      await this.putField(cardId, 'cardholderName', input.cardholderName, written);
    } catch (error) {
      await this.clearFields(cardId, written);
      this.dropRow(cardId);
      // Rethrown as a message written HERE. The original came from a call whose
      // arguments were the card.
      void error;
      throw new Error('The card could not be written to the daemon secret store.');
    }
    return metadata;
  }

  /**
   * Delete a card and every secret derived from its id.
   *
   * `secretsCleared` counts the keys that actually held something, so a partial
   * deletion is visible rather than silent, which is what the descriptor for
   * `payments.cards.delete` promises.
   *
   * The material goes first and the row LAST, which is `create` read backwards
   * and the same principle: a crash between the two leaves a visible row the
   * owner can delete again, never material with no row pointing at it. For the
   * same reason the sweep runs even when there is no row to remove, so material
   * a crashed `create` stranded can still be cleared by asking for its id.
   *
   * Reads the file before it deletes anything, so a damaged store refuses here
   * rather than clearing material it is about to lose the row for.
   */
  async remove(cardId: string): Promise<{ deleted: boolean; secretsCleared: number }> {
    const cards = this.list();
    const remaining = cards.filter((card) => card.id !== cardId);
    let secretsCleared = 0;
    for (const field of CARD_MATERIAL_FIELDS) {
      const key = cardSecretKey(cardId, field);
      const value = await this.secrets.get(key);
      if (value === null) continue;
      await this.secrets.delete(key);
      secretsCleared += 1;
    }
    const deleted = remaining.length !== cards.length;
    if (deleted) writeCardsFile(this.filePath, remaining);
    return { deleted, secretsCleared };
  }

  /** The file's contents, or the refusal. The one read path; nothing else parses. */
  private readOrRaise(): { cards: CardMetadata[] } {
    const result = readCardsFile(this.filePath);
    if (result.status === 'unreadable') {
      throw new CardStoreUnreadableError(this.filePath, result.reason);
    }
    return { cards: result.status === 'ok' ? result.cards : [] };
  }

  /** Take one row back out, used only to unwind a `create` that failed. */
  private dropRow(cardId: string): void {
    try {
      writeCardsFile(this.filePath, this.readOrRaise().cards.filter((card) => card.id !== cardId));
    } catch {
      // Best effort, for the same reason clearFields is: the write that failed
      // is already being reported, and a failure to unwind it must not replace
      // that report with a second one. What survives is a visible row with
      // materialComplete false, which is the recoverable state by design.
    }
  }

  /**
   * Whether the store may hand back a STORED CVV right now.
   *
   * `payments.cvvHandling: 'prompt'` is the owner saying the CVV must not be
   * kept, and honoring that only at write time would have made it a statement
   * about new cards rather than a setting: a card added under 'stored' went on
   * being readable, and went on reporting complete, after the flip. So the check
   * is HERE, on every supply path, and the setting means what it says whenever
   * it is read.
   *
   * The stored bytes are deliberately NOT purged when the setting flips.
   * Flipping back restores the card intact, and destroying the owner's stored
   * data as a side effect of changing a preference is not a decision this module
   * gets to make; a purge is `payments.cards.delete`, which the owner asks for.
   */
  private suppliesStoredCvv(): boolean {
    return this.cvvHandling() === 'stored';
  }

  /** One field, or null when it is absent or currently not suppliable. */
  private async fieldValue(cardId: string, field: CardMaterialField): Promise<string | null> {
    if (field === 'cvv' && !this.suppliesStoredCvv()) return null;
    const value = await this.secrets.get(cardSecretKey(cardId, field));
    return value === null || value.length === 0 ? null : value;
  }

  private async putField(
    cardId: string,
    field: CardMaterialField,
    value: string,
    written: CardMaterialField[],
  ): Promise<void> {
    await this.secrets.set(cardSecretKey(cardId, field), value);
    written.push(field);
  }

  private async clearFields(cardId: string, fields: readonly CardMaterialField[]): Promise<void> {
    for (const field of fields) {
      try {
        await this.secrets.delete(cardSecretKey(cardId, field));
      } catch {
        // Best effort. The write that failed is already being reported; a
        // failure to undo it must not replace that report with a second one.
      }
    }
  }
}
