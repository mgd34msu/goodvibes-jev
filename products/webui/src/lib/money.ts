/**
 * money.ts, two distinct, unrelated jobs that happen to both be about an
 * amount of money, kept in one file because they used to be the same job.
 *
 * (1) Plain amount parsing/formatting for the config schema's `unit: 'money'`
 *     keys (`payments.budget.dailyItem`, `dailyOverage`, `perPurchaseCeiling`,
 *     `overageToleranceDailyAllowance`, SDK 2.0.5's money-value.ts). These
 *     keys now hold the number a person would say out loud: typing "100"
 *     stores `100` and reads back `100`; typing "19.99" stores `19.99`. There
 *     is no minor-unit representation left to convert to or from, a schema
 *     key is a money field because the SCHEMA marks it `unit === 'money'`,
 *     never because its name ends in some suffix (the old scheme, which tied
 *     every consumer to a naming convention and broke them all when the SDK
 *     renamed the keys). `isMoneyField` / `parseMoneyAmountInput` /
 *     `formatMoneyAmountValue` below are this half; they are currency-NEUTRAL
 *     by design (mirroring the SDK's own parseMoneyAmount), matching
 *     `payments.currency` only for display, never for arithmetic.
 *
 * (2) Currency-aware major-unit <-> minor-unit conversion, kept ONLY for the
 *     card issuer cap on `payments.cards.create` (payments-cards.ts,
 *     PaymentCardEntry.tsx): `CardCreateInput.issuerCapMinorUnits` is a
 *     genuinely different, still-minor-units contract (an issuer's own
 *     virtual-card cap, unrelated to CONFIG_SCHEMA and untouched by the
 *     2.0.5 budget-key rename), a person types "50.00" and the issuer cap is
 *     set in cents because that is the unit the card-issuing API itself
 *     uses. `minorUnitExponent` / `majorTextToMinorUnits` /
 *     `minorUnitsToMajorText` below are this half, unchanged.
 *
 * Never uses floating-point multiplication/division for either half.
 * `Number(text) * 100` looks right and is wrong: binary floating point cannot
 * represent most decimal fractions exactly (0.1, 0.29, 19.99, all in the
 * round-trip cases this module is tested against, do not survive a `* 100` /
 * `/ 100` round trip bit-for-bit on every JS engine and rounding path). All
 * arithmetic here is on integers parsed directly out of the decimal string.
 *
 * The minor-unit half is currency-exponent-aware: NOT every currency has 2
 * decimal digits. Mirrors the SDK's `platform/payments/message.ts` exponent
 * table exactly (its ZERO_DECIMAL / THREE_DECIMAL sets), not imported
 * directly, because that module's `exponentFor` is a private helper (only the
 * DISPLAY formatter `formatMinorUnits`, which returns a currency-prefixed,
 * comma-grouped string, is exported, not suitable as a bare, re-parseable
 * input value). Getting this wrong is a real bug, not a cosmetic one: assuming
 * 2 decimals for a JPY issuer cap would turn a typed "5000" into 500000 minor
 * units, fifty times the intended amount, since JPY has no minor unit at
 * all.
 */

export class InvalidMoneyInputError extends Error {}

/** Minor units per major unit, by ISO-4217 code, mirrors the SDK's table exactly. */
const THREE_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);
const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'XAF', 'XOF', 'XPF']);

/** How many fraction digits `currency`'s minor unit represents (0, 2, or 3). Defaults to 2. */
export function minorUnitExponent(currency: string): number {
  const code = currency.trim().toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return 2;
}

function majorUnitPattern(exponent: number): RegExp {
  return exponent === 0 ? /^(\d+)$/ : new RegExp(`^(\\d+)(?:\\.(\\d{1,${exponent}}))?$`);
}

/**
 * The largest amount a `unit: 'money'` schema key accepts. Mirrors the SDK's
 * money-value.ts MAX_MONEY_AMOUNT exactly (not imported: money-value.ts is
 * reachable only through the full `platform/config` barrel, which pulls
 * SecretsManager / OAuth / google-auth into the browser bundle, see
 * scripts/generate-config-schema.ts's header).
 */
export const MAX_MONEY_AMOUNT = 1_000_000;
/** Amounts accept at most 2 decimal places (baked into the regexes below). */
const MONEY_AMOUNT_EXAMPLE = 'a plain number like 100 or 19.99';

const LEADING_CURRENCY_SYMBOL = /^\p{Sc}\s*/u;
const GROUPED_MONEY_AMOUNT = /^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/;
const PLAIN_MONEY_AMOUNT = /^\d+(?:\.\d{1,2})?$/;

/**
 * True when a schema entry is a `unit: 'money'` field, the ONLY thing that
 * marks a config key as holding a plain amount of `payments.currency`. Never
 * pattern-match the key's name: that is exactly the scheme SDK 2.0.5 removed
 * (the old keys were detected by a `Cents` suffix, which tied every consumer
 * to a naming convention and broke them all when the names changed).
 */
export function isMoneyField(unit: 'money' | undefined): boolean {
  return unit === 'money';
}

/**
 * Parse a `unit: 'money'` amount as a person may have typed it: a leading
 * currency symbol and thousands grouping are tolerated and stripped ("$100",
 * "1,250.50"). The returned number is the one that was typed, nothing is
 * scaled, rounded, or reformatted, and the value is currency-NEUTRAL (it
 * never consults `payments.currency`; whatever the currency is, an amount is
 * an amount of it). Throws InvalidMoneyInputError, naming the same example
 * the daemon's own refusal uses, for anything the daemon's config.set would
 * also refuse, that call is still the authoritative validator.
 */
export function parseMoneyAmountInput(text: string): number {
  const trimmed = text.trim();
  const cleaned = trimmed.replace(LEADING_CURRENCY_SYMBOL, '').trim();
  if (cleaned.length === 0) {
    throw new InvalidMoneyInputError(`Enter ${MONEY_AMOUNT_EXAMPLE} (got "${text}")`);
  }
  const digits = GROUPED_MONEY_AMOUNT.test(cleaned) ? cleaned.replace(/,/g, '') : cleaned;
  if (!PLAIN_MONEY_AMOUNT.test(digits)) {
    throw new InvalidMoneyInputError(
      `Enter ${MONEY_AMOUNT_EXAMPLE}, no greater than ${MAX_MONEY_AMOUNT} (got "${text}")`,
    );
  }
  const value = Number(digits);
  if (!Number.isFinite(value) || value > MAX_MONEY_AMOUNT) {
    throw new InvalidMoneyInputError(
      `Enter ${MONEY_AMOUNT_EXAMPLE}, no greater than ${MAX_MONEY_AMOUNT} (got "${text}")`,
    );
  }
  return value;
}

/**
 * Render a stored `unit: 'money'` value for display/editing, the number the
 * daemon holds, as-is, never scaled or re-derived from a unit conversion. A
 * non-finite value (never produced by a real config tree) falls back to '0'
 * rather than showing a broken string.
 */
export function formatMoneyAmountValue(value: number): string {
  return Number.isFinite(value) ? String(value) : '0';
}

// ---------------------------------------------------------------------------
// Below: the currency-aware major-unit <-> minor-unit half, used ONLY by the
// payments.cards.create issuer cap (see module header, job (2)). Unrelated to
// the schema's `unit: 'money'` keys above.
// ---------------------------------------------------------------------------

/**
 * Parse a major-unit decimal string (e.g. "19.99", "50", "5000" for JPY) into
 * an exact integer count of minor units, for `currency` (default 'USD', 2
 * decimal places). Throws InvalidMoneyInputError for anything that is not a
 * non-negative amount with at most `currency`'s number of fraction digits,
 * never silently truncates or rounds a value the user typed.
 */
export function majorTextToMinorUnits(text: string, currency = 'USD'): number {
  const exponent = minorUnitExponent(currency);
  const trimmed = text.trim();
  const match = majorUnitPattern(exponent).exec(trimmed);
  if (!match) {
    throw new InvalidMoneyInputError(
      exponent === 0
        ? `Enter a non-negative whole amount (got "${text}")`
        : `Enter a non-negative amount with at most ${exponent} decimal place${exponent === 1 ? '' : 's'} (got "${text}")`,
    );
  }
  const [, wholePart, fracPart = ''] = match;
  const whole = Number.parseInt(wholePart, 10);
  if (!Number.isSafeInteger(whole)) {
    throw new InvalidMoneyInputError('Amount is too large');
  }
  const divisor = 10 ** exponent;
  const frac = exponent === 0 ? 0 : Number.parseInt(fracPart.padEnd(exponent, '0'), 10);
  const minor = whole * divisor + frac;
  if (!Number.isSafeInteger(minor)) {
    throw new InvalidMoneyInputError('Amount is too large');
  }
  return minor;
}

/**
 * Render an exact integer count of minor units as a major-unit decimal string
 * for `currency` (e.g. 1999/"USD" -> "19.99", 5000/"JPY" -> "5000",
 * 1000/"KWD" -> "1.000"). Throws InvalidMoneyInputError for a non-integer or
 * negative input, the daemon's schema range (`intRange(0, MAX_MINOR_UNITS)`)
 * never produces one, but this must never fabricate a plausible-looking
 * amount for a value it cannot represent honestly.
 */
export function minorUnitsToMajorText(minor: number, currency = 'USD'): string {
  if (!Number.isInteger(minor) || minor < 0) {
    throw new InvalidMoneyInputError(`Minor units must be a non-negative integer (got ${String(minor)})`);
  }
  const exponent = minorUnitExponent(currency);
  if (exponent === 0) return String(minor);
  const divisor = 10 ** exponent;
  const whole = Math.trunc(minor / divisor);
  const frac = minor - whole * divisor;
  return `${whole}.${String(frac).padStart(exponent, '0')}`;
}
