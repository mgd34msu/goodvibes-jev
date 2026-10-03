/**
 * payments-config.ts, the agent's synthetic settings entries for the payment
 * capability's card MATERIAL fields, plus the config-key constants the
 * `/payments` command writes through.
 *
 * ── What is real and what is synthetic ───────────────────────────────────
 *
 * The SDK's CONFIG_SCHEMA already carries a full real `payments` section:
 * enabled, defaultCardId, currency, cvvHandling, the six budget keys,
 * shipping.preferredTier, the FOURTEEN billing/shipping address sub-fields
 * (name, line1, line2, city, region, postalCode, country, each repeated for
 * billingAddress and shippingAddress), the two window keys, and
 * notifyChannels. Every one of those reads and writes through the ordinary
 * CONFIG_SCHEMA-driven loop in settings-modal.ts's _loadGroups, exactly like
 * `relay.*` or any other real SDK domain. This module builds NOTHING for them
 * and deliberately does not restate them, a second local copy of a schema is
 * a second thing to drift.
 *
 * What this module does build is the four card MATERIAL fields: number,
 * expiry, CVV, cardholder name. Per the SDK's own design, card material is
 * deliberately never a config VALUE at all: it lives write-only in the daemon
 * secret store, and config holds only a `goodvibes://secrets/...` reference
 * pointing at it. The SDK does not expose a config-level path for the single
 * implicit card this app's `/payments card` flow models, so these four are
 * synthetic sub-keys under the SDK's real `payments` section: a key one level
 * under an EXISTING section that CONFIG_SCHEMA has not grown a scalar entry
 * for (see settings-modal.ts's _loadGroups, where these are injected).
 *
 * ── Why the keys are named FLAT ──────────────────────────────────────────
 *
 * `payments.cardNumber`, not `payments.card.number`. The real ConfigManager's
 * dotted-path resolver throws "Invalid config path" only when an INTERMEDIATE
 * segment is missing, `payments.card.number` would fail because `card` is not
 * itself a declared section, but it tolerates an undeclared final leaf under
 * a section that does exist. So the flat shape is what makes
 * `ConfigManager.get`/`setDynamic` accept these keys against the real manager
 * rather than a local store.
 *
 * ── Why that matters for the daemon ──────────────────────────────────────
 *
 * `payments.` is one of the SDK's DAEMON_OWNED_CONFIG_PREFIXES, so a write to
 * any of these keys lands in the daemon-owned settings tier, not an
 * agent-local file. The daemon, and the TUI, and the webui, read the same
 * value, and they keep reading it after this program exits. A card that only
 * this process can see is the feature not working: the daemon is the thing
 * that completes an unattended purchase, and it does so with every surface
 * closed. The matching secret VALUE is written at `scope: 'daemon'` for the
 * same reason (see config/secret-config.ts's defaultSecretBackedScope).
 *
 * ── Secrecy ─────────────────────────────────────────────────────────────
 *
 * All four keys are listed in config/secret-config.ts's SECRET_CONFIG_KEYS.
 * That membership is what makes them masked at rest AND masked mid-edit in
 * the settings modal (renderer/settings-modal.ts's currentSettingValue), and
 * what routes a settings-modal edit through the secret manager instead of
 * writing plaintext into a config file. The primary entry path is the
 * concealed-input flow in commands/payment-card-intake.ts, itself gated on the
 * SDK's `mayOfferCardEntryFlow`.
 *
 * `cvvHandling` is a REAL schema key and is not built here; callers that need
 * its trade-off wording import `CVV_PROMPT_TRADEOFF_WARNING` directly from
 * `@goodvibes-jev/engine/sdk/platform/payments`, so no local copy of that text
 * exists anywhere in this app.
 */

import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ConfigKey } from '../config/index.ts';
import type { SettingEntry } from './settings-modal-types.ts';

/** Real ConfigManager's read surface, these four keys are defensive reads (see header). */
export type PaymentsConfigReader = Pick<ConfigManager, 'get'>;

export const PAYMENTS_CARD_NUMBER_CONFIG_KEY = 'payments.cardNumber' as ConfigKey;
export const PAYMENTS_CARD_EXPIRY_CONFIG_KEY = 'payments.cardExpiry' as ConfigKey;
export const PAYMENTS_CARD_CVV_CONFIG_KEY = 'payments.cardCvv' as ConfigKey;
export const PAYMENTS_CARD_CARDHOLDER_NAME_CONFIG_KEY = 'payments.cardholderName' as ConfigKey;

/** The real SDK schema key for the CVV-handling selector, not synthetic. */
export const PAYMENTS_CVV_HANDLING_CONFIG_KEY = 'payments.cvvHandling' as ConfigKey;

/**
 * The real SDK schema keys for the two addresses, in the order the guided
 * `/payments address` flow asks for them.
 *
 * These are ordinary (non-secret) CONFIG_SCHEMA string keys, listed here only
 * so the command and its tests share one ordering, not to redefine the schema.
 * A postal address is not a credential: it is printed on every parcel and is
 * already visible in the settings modal, so it is entered in the CLEAR. Routing
 * it through the concealed-input path would mask something that does not need
 * masking, and would teach the reflex that bullets mean "this field is fine to
 * type anywhere", the opposite of what the card fields need it to mean.
 */
export const PAYMENTS_ADDRESS_FIELD_SUFFIXES: readonly string[] = [
  'name',
  'line1',
  'line2',
  'city',
  'region',
  'postalCode',
  'country',
];

export type PaymentsAddressKind = 'billing' | 'shipping';

/**
 * The fourteen address keys, written out as literals rather than assembled from
 * a template.
 *
 * A `payments.${kind}Address.${field}` template is shorter and is the wrong
 * choice here. Written out, these keys are greppable, someone auditing what
 * the payment flow writes to the daemon's config can find every one of them by
 * searching for the key they are looking at, and the repo's own settings
 * coverage scan (verification/settings-consumed-keys.ts) can see that this
 * product actually consumes them, which a runtime-assembled string hides. A
 * typo in a template also produces a silently wrong key that ConfigManager
 * accepts, because a flat leaf under an existing section is tolerated.
 */
const PAYMENTS_ADDRESS_KEYS: Readonly<Record<PaymentsAddressKind, Readonly<Record<string, ConfigKey>>>> = {
  billing: {
    name: 'payments.billingAddress.name' as ConfigKey,
    line1: 'payments.billingAddress.line1' as ConfigKey,
    line2: 'payments.billingAddress.line2' as ConfigKey,
    city: 'payments.billingAddress.city' as ConfigKey,
    region: 'payments.billingAddress.region' as ConfigKey,
    postalCode: 'payments.billingAddress.postalCode' as ConfigKey,
    country: 'payments.billingAddress.country' as ConfigKey,
  },
  shipping: {
    name: 'payments.shippingAddress.name' as ConfigKey,
    line1: 'payments.shippingAddress.line1' as ConfigKey,
    line2: 'payments.shippingAddress.line2' as ConfigKey,
    city: 'payments.shippingAddress.city' as ConfigKey,
    region: 'payments.shippingAddress.region' as ConfigKey,
    postalCode: 'payments.shippingAddress.postalCode' as ConfigKey,
    country: 'payments.shippingAddress.country' as ConfigKey,
  },
};

/** `payments.billingAddress.line1` etc. Throws on an unknown field rather than inventing a key. */
export function paymentsAddressConfigKey(kind: PaymentsAddressKind, field: string): ConfigKey {
  const key = PAYMENTS_ADDRESS_KEYS[kind][field];
  if (key === undefined) throw new Error(`Unknown payments address field "${field}".`);
  return key;
}

export function paymentsAddressConfigKeys(kind: PaymentsAddressKind): readonly ConfigKey[] {
  return PAYMENTS_ADDRESS_FIELD_SUFFIXES.map((field) => paymentsAddressConfigKey(kind, field));
}

function readStringField(configManager: PaymentsConfigReader, key: ConfigKey): string {
  // Defensive try/catch, the same posture every synthetic setting in this app
  // takes toward an unexpected value: the real ConfigManager does not throw for
  // these particular keys (see header, flat leaf under an existing section),
  // but degrading to empty is better than taking the whole settings modal down
  // if that ever stops being true.
  try {
    const raw = configManager.get(key);
    return typeof raw === 'string' ? raw : '';
  } catch {
    return '';
  }
}

function buildStringFieldEntry(
  configManager: PaymentsConfigReader,
  key: ConfigKey,
  description: string,
): SettingEntry {
  const currentValue = readStringField(configManager, key);
  return {
    setting: { key, type: 'string', default: '', description },
    currentValue,
    isDefault: currentValue === '',
  };
}

export function buildPaymentsCardNumberEntry(configManager: PaymentsConfigReader): SettingEntry {
  return buildStringFieldEntry(
    configManager,
    PAYMENTS_CARD_NUMBER_CONFIG_KEY,
    'Payment card number. Stored through the secret manager at daemon scope; entering it here or via /payments card never shows the typed characters in plaintext.',
  );
}

export function buildPaymentsCardExpiryEntry(configManager: PaymentsConfigReader): SettingEntry {
  return buildStringFieldEntry(
    configManager,
    PAYMENTS_CARD_EXPIRY_CONFIG_KEY,
    'Payment card expiry (MM/YY). Stored through the secret manager at daemon scope, same handling as the card number.',
  );
}

export function buildPaymentsCardCvvEntry(configManager: PaymentsConfigReader): SettingEntry {
  return buildStringFieldEntry(
    configManager,
    PAYMENTS_CARD_CVV_CONFIG_KEY,
    'Payment card CVV. Stored through the secret manager at daemon scope: never logged, never rendered, never shown mid-edit, excluded from every export and diagnostic dump.',
  );
}

export function buildPaymentsCardCardholderNameEntry(configManager: PaymentsConfigReader): SettingEntry {
  return buildStringFieldEntry(
    configManager,
    PAYMENTS_CARD_CARDHOLDER_NAME_CONFIG_KEY,
    'Name on the payment card. Stored through the secret manager at daemon scope, same handling as the card number.',
  );
}

/** All payments synthetic entries (the four card-material fields), in render order. */
export function buildPaymentsSyntheticEntries(configManager: PaymentsConfigReader): SettingEntry[] {
  return [
    buildPaymentsCardNumberEntry(configManager),
    buildPaymentsCardExpiryEntry(configManager),
    buildPaymentsCardCvvEntry(configManager),
    buildPaymentsCardCardholderNameEntry(configManager),
  ];
}

/** Every payments synthetic config key this module owns, for membership checks. */
export const PAYMENTS_SYNTHETIC_CONFIG_KEYS: readonly ConfigKey[] = [
  PAYMENTS_CARD_NUMBER_CONFIG_KEY,
  PAYMENTS_CARD_EXPIRY_CONFIG_KEY,
  PAYMENTS_CARD_CVV_CONFIG_KEY,
  PAYMENTS_CARD_CARDHOLDER_NAME_CONFIG_KEY,
];

export function isPaymentsSyntheticConfigKey(key: string): key is ConfigKey {
  return (PAYMENTS_SYNTHETIC_CONFIG_KEYS as readonly string[]).includes(key);
}

/** Refresh one payments synthetic entry's currentValue/isDefault in place. */
export function refreshPaymentsSyntheticEntry(entry: SettingEntry, configManager: PaymentsConfigReader): void {
  const currentValue = readStringField(configManager, entry.setting.key as ConfigKey);
  entry.currentValue = currentValue;
  entry.isDefault = currentValue === '';
}
