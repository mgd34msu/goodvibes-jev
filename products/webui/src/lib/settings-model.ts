/**
 * settings-model.ts, the schema-driven, domain-grouped model the settings
 * surface renders from. Pure and deterministic: it takes the daemon's live
 * config snapshot (config.get) and the SDK's generated schema + per-feature
 * settings metadata, and produces the ordered group / feature-unit / row
 * structure the SettingsModal walks. No React, no I/O, fully unit-testable.
 *
 * Grouping rules (dissolved feature model, every capability is a first-class
 * domain setting; there is no separate enablement namespace):
 *   - Every feature (FEATURE_SETTINGS) renders as a FEATURE UNIT inside its
 *     DOMAIN group (the top-level namespace of its enablement key): its real
 *     name and full description, its enablement control in its real shape
 *     (boolean toggle / enum mode select / constant, governed directly by its
 *     own settings keys), and the typed editors for the settings keys it owns.
 *   - A config key owned by a feature unit is NOT double-listed as an orphan row
 *     in its namespace group (ownership wins).
 *   - Schema keys owned by no feature render as typed "plain" rows under their
 *     namespace group.
 *   - Keys present in the LIVE config but absent from the schema still render (as
 *     read-only raw rows) so nothing the daemon actually holds becomes invisible,
 *     EXCEPT a key card-material.ts's isCardMaterialKey() matches (a card number,
 *     PAN, or CVV/CVC). That is the one deliberate exception to "nothing becomes
 *     invisible": card material must never be entered or displayed on this surface
 *     at all, so a matching key is dropped from every row source (plain, feature-
 *     owned, and raw) rather than rendered, masked or otherwise. In practice
 *     CONFIG_SCHEMA never declares such a key (schema-domain-payments.ts keeps card
 *     material in the daemon's secret store only), so this filter only ever catches
 *     a stray live-config key the schema does not know about.
 *
 * Grouping SOURCE is SDK metadata (CONFIG_SCHEMA namespaces + each feature's
 * domain), never a hand-copied category list, so cross-surface parity with the
 * TUI is structural. config-redaction.ts's CATEGORY_LABELS supplies only the
 * human display label for a namespace (special-casing acronyms), with a Title
 * Case fallback for any namespace it has not special-cased.
 */
import {
  CONFIG_SCHEMA_ENTRIES,
  FEATURE_SETTINGS,
  type ConfigSchemaEntry,
  type FeatureSettingMeta,
} from './generated/config-schema';
import { categoryLabelForKey, CATEGORY_LABELS, isSecretConfigKey, isUnresolvedConfigKey, SECRET_CONFIG_KEYS } from './config-redaction';
import { isDaemonOwnedConfigKey } from './config-ownership';
import { isSecretStoreOnlyConfigKey } from './secret-store-only-config-keys';
import { isCardMaterialKey } from './card-material';
import { asRecord } from './object';

/** A single typed, editable config field: schema metadata merged with its live value. */
export interface ConfigFieldModel {
  readonly key: string;
  readonly type: ConfigSchemaEntry['type'];
  readonly enumValues?: readonly string[];
  readonly default: unknown;
  readonly description: string;
  readonly validationHint?: string;
  /** What kind of `number` quantity this is, from the schema (never the key's
   *  name), `'money'` marks a plain amount of `payments.currency`. */
  readonly unit?: ConfigSchemaEntry['unit'];
  /** The live value from config.get (undefined when the key is absent from the live tree). */
  readonly liveValue: unknown;
  /** Whether the live config tree actually holds this key (vs. only the schema default). */
  readonly present: boolean;
  readonly isSecret: boolean;
  /** True when the daemon, not this client, is the writer/reader-of-record for this key
   *  (config-ownership.ts). A write to a daemon-owned key applies to every connected client,
   *  not just this browser tab. */
  readonly daemonOwned: boolean;
  /** True when this key's real value is resolved ONLY from the daemon's secret
   *  store (secret-store-only-config-keys.ts), a config.set write here is inert
   *  (never read by the connector that uses it) and leaves a plaintext, unused
   *  copy of the value in the daemon's config file. SettingsField refuses to
   *  write these and names the real command instead. */
  readonly secretStoreOnly: boolean;
}

/** A live-config key with no schema entry, shown read-only so nothing is hidden. */
export interface RawRowModel {
  readonly key: string;
  readonly value: unknown;
  readonly isSecret: boolean;
  /** Set only for an unresolved key with a current, acted negative reading. */
  readonly displayCleared?: boolean;
  readonly daemonOwned: boolean;
}

/**
 * A feature rendered as one unit: its enablement control in its real shape
 * plus the typed editors for the settings keys it owns.
 *
 * Enablement shapes:
 *   - boolean : `enablementField` is the boolean settings key the feature-level
 *               toggle writes (true/false). It is excluded from `fields`.
 *   - enum    : `enablementField` is the enum settings key rendered as the
 *               feature's mode select; the feature is active while its value is
 *               in `feature.enablement.enabledValues`. Excluded from `fields`.
 *   - constant: no separate off switch, `enablementField` is null and ALL the
 *               feature's settings keys (which govern runtime activation
 *               directly) render as `fields`.
 */
export interface FeatureUnitModel {
  readonly feature: FeatureSettingMeta;
  /** Whether the feature is active given the live config (per its enablement shape). */
  readonly enabled: boolean;
  /** True when the live config explicitly holds the enablement key (vs. schema default). */
  readonly explicit: boolean;
  /** The enablement key's typed field (null for constant enablement). */
  readonly enablementField: ConfigFieldModel | null;
  /** The remaining settings fields the feature owns (enablement key excluded). */
  readonly fields: readonly ConfigFieldModel[];
  /** True when every settings key this feature owns is daemon-owned (config-ownership.ts),
   *  every feature lives in one domain, so this is all-or-nothing in practice. */
  readonly daemonOwned: boolean;
}

export interface SettingsGroupModel {
  readonly id: string;
  readonly label: string;
  readonly featureUnits: readonly FeatureUnitModel[];
  readonly plainRows: readonly ConfigFieldModel[];
  readonly rawRows: readonly RawRowModel[];
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Read a dotted key from a nested config object; returns { present, value }. */
export function readConfigPath(config: unknown, key: string): { present: boolean; value: unknown } {
  const segments = key.split('.');
  let cursor: unknown = config;
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) {
      return { present: false, value: undefined };
    }
    const record = cursor as Record<string, unknown>;
    if (!(segment in record)) return { present: false, value: undefined };
    cursor = record[segment];
  }
  return { present: true, value: cursor };
}

/**
 * All dotted leaf keys held in the live config (objects descended, arrays are
 * leaves). A key in `stopKeys` is treated as a leaf even when its value is an
 * object, the schema's object-typed keys (e.g. pricing.modelPrices) are ONE
 * setting with a typed editor, and descending into their entries would
 * double-render every entry as an unschema'd raw row. Entry keys may also
 * contain dots (model ids like "provider:model-3.5"), which a dotted-path
 * descent would corrupt.
 */
export function liveLeafKeys(config: unknown, prefix = '', stopKeys?: ReadonlySet<string>): string[] {
  const record = asRecord(config);
  const keys = Object.keys(record);
  if (keys.length === 0) return [];
  const out: string[] = [];
  for (const key of keys) {
    const full = prefix ? `${prefix}.${key}` : key;
    const item = record[key];
    if (item !== null && typeof item === 'object' && !Array.isArray(item) && !stopKeys?.has(full)) {
      out.push(...liveLeafKeys(item, full, stopKeys));
    } else {
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Field construction
// ---------------------------------------------------------------------------

const SCHEMA_BY_KEY = new Map<string, ConfigSchemaEntry>(CONFIG_SCHEMA_ENTRIES.map((e) => [e.key, e]));

/** Schema keys whose VALUE is an object, one setting each, never descended into. */
export const OBJECT_TYPED_CONFIG_KEYS: ReadonlySet<string> = new Set(
  CONFIG_SCHEMA_ENTRIES.filter((e) => e.type === 'object').map((e) => e.key),
);

/** Every config key owned by at least one feature (excluded from orphan rows). */
export const OWNED_CONFIG_KEYS: ReadonlySet<string> = new Set(
  FEATURE_SETTINGS.flatMap((f) => [...f.settings]),
);

function buildField(entry: ConfigSchemaEntry, config: unknown): ConfigFieldModel {
  const { present, value } = readConfigPath(config, entry.key);
  return {
    key: entry.key,
    type: entry.type,
    enumValues: entry.enumValues,
    default: entry.default,
    description: entry.description,
    validationHint: entry.validationHint,
    unit: entry.unit,
    liveValue: value,
    present,
    isSecret: isSecretConfigKey(entry.key),
    daemonOwned: isDaemonOwnedConfigKey(entry.key),
    secretStoreOnly: isSecretStoreOnlyConfigKey(entry.key),
  };
}

function namespaceOf(key: string): string {
  return key.split('.')[0] ?? key;
}

/** Human label for a namespace: CATEGORY_LABELS special-case, else Title Case. */
export function groupLabelForNamespace(namespace: string): string {
  // categoryLabelForKey applies CATEGORY_LABELS with a titleCase fallback; a
  // namespace with no special-case maps to a Title Case of itself.
  if (namespace in CATEGORY_LABELS) return CATEGORY_LABELS[namespace];
  return categoryLabelForKey(`${namespace}.x`);
}

// ---------------------------------------------------------------------------
// Feature enablement
// ---------------------------------------------------------------------------

/**
 * Whether a feature is active for a given enablement-key value, per its
 * enablement shape. Mirrors the SDK's own state derivation: boolean keys are
 * active when true; enum keys while the value is in enabledValues; constant
 * capabilities have no separate off switch (their own settings keys govern
 * runtime activation directly), so they report active.
 */
export function isFeatureEnabled(feature: FeatureSettingMeta, value: unknown): boolean {
  switch (feature.enablement.kind) {
    case 'constant':
      return true;
    case 'boolean':
      return value === true;
    case 'enum':
      return typeof value === 'string' && (feature.enablement.enabledValues ?? []).includes(value);
  }
}

function buildFeatureUnit(feature: FeatureSettingMeta, liveConfig: unknown): FeatureUnitModel {
  const enablementEntry = SCHEMA_BY_KEY.get(feature.enablement.key);
  const enablementField =
    feature.enablement.kind !== 'constant' && enablementEntry
      ? buildField(enablementEntry, liveConfig)
      : null;

  // For boolean/enum enablement the enablement key is the feature-level
  // control, so it does not repeat in the field list; constant features keep
  // every settings key (enablement key first) as ordinary typed fields.
  const fieldKeys = (
    feature.enablement.kind === 'constant'
      ? feature.settings
      : feature.settings.filter((k) => k !== feature.enablement.key)
  ).filter((k) => !isCardMaterialKey(k));
  const fields = fieldKeys
    .map((k) => SCHEMA_BY_KEY.get(k))
    .filter((e): e is ConfigSchemaEntry => Boolean(e))
    .map((e) => buildField(e, liveConfig));

  const { present, value } = readConfigPath(liveConfig, feature.enablement.key);
  const effective = present ? value : enablementEntry?.default;
  return {
    feature,
    enabled: isFeatureEnabled(feature, effective),
    explicit: present,
    enablementField,
    fields,
    daemonOwned: feature.settings.length > 0 && feature.settings.every(isDaemonOwnedConfigKey),
  };
}

// ---------------------------------------------------------------------------
// Model construction
// ---------------------------------------------------------------------------

/**
 * Build the ordered settings model from the live config snapshot.
 *
 * Group order: namespaces in CONFIG_SCHEMA order (first appearance), then any
 * feature domains the schema does not cover, then live-only namespaces the
 * schema does not know.
 */
export function buildSettingsModel(liveConfig: unknown, clearedKeys: ReadonlySet<string> = new Set()): SettingsGroupModel[] {
  // 1. Ordered namespace list from the schema (first appearance wins).
  const orderedNamespaces: string[] = [];
  const seen = new Set<string>();
  for (const entry of CONFIG_SCHEMA_ENTRIES) {
    const ns = namespaceOf(entry.key);
    if (!seen.has(ns)) {
      seen.add(ns);
      orderedNamespaces.push(ns);
    }
  }

  // 2. Feature units grouped by their domain, in FEATURE_SETTINGS declaration order.
  const unitsByNamespace = new Map<string, FeatureUnitModel[]>();
  for (const feature of FEATURE_SETTINGS) {
    const unit = buildFeatureUnit(feature, liveConfig);
    const ns = feature.domain;
    const list = unitsByNamespace.get(ns) ?? [];
    list.push(unit);
    unitsByNamespace.set(ns, list);
    if (!seen.has(ns)) {
      seen.add(ns);
      orderedNamespaces.push(ns);
    }
  }

  // 3. Live-only namespaces the schema does not cover. Object-typed schema
  // keys are leaves here: their live entries belong to the key's own typed
  // editor, not to the unschema'd raw-row table.
  // A malformed object under a declared secret remains one masked row. Never
  // descend into it and ask a reading to clear its otherwise-unknown children.
  const liveKeys = liveLeafKeys(liveConfig, '', new Set([...OBJECT_TYPED_CONFIG_KEYS, ...SECRET_CONFIG_KEYS]));
  for (const key of liveKeys) {
    const ns = namespaceOf(key);
    if (!seen.has(ns)) {
      seen.add(ns);
      orderedNamespaces.push(ns);
    }
  }

  const schemaKeySet = new Set(CONFIG_SCHEMA_ENTRIES.map((e) => e.key));

  // 4. Assemble each namespace group.
  const groups: SettingsGroupModel[] = [];
  for (const ns of orderedNamespaces) {
    const featureUnits = unitsByNamespace.get(ns) ?? [];

    const plainRows = CONFIG_SCHEMA_ENTRIES.filter(
      (e) => namespaceOf(e.key) === ns && !OWNED_CONFIG_KEYS.has(e.key) && !isCardMaterialKey(e.key),
    ).map((e) => buildField(e, liveConfig));

    const rawRows: RawRowModel[] = liveKeys
      .filter(
        (k) => namespaceOf(k) === ns && !schemaKeySet.has(k) && !OWNED_CONFIG_KEYS.has(k) && !isCardMaterialKey(k),
      )
      .map((k) => ({
        key: k,
        value: readConfigPath(liveConfig, k).value,
        isSecret: isSecretConfigKey(k) && !(isUnresolvedConfigKey(k) && clearedKeys.has(k)),
        displayCleared: isUnresolvedConfigKey(k) && clearedKeys.has(k),
        daemonOwned: isDaemonOwnedConfigKey(k),
      }));

    if (featureUnits.length === 0 && plainRows.length === 0 && rawRows.length === 0) continue;

    groups.push({
      id: ns,
      label: groupLabelForNamespace(ns),
      featureUnits,
      plainRows,
      rawRows,
    });
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Search / filter
// ---------------------------------------------------------------------------

function fieldMatches(field: ConfigFieldModel, q: string): boolean {
  return field.key.toLowerCase().includes(q) || field.description.toLowerCase().includes(q);
}

function unitMatches(unit: FeatureUnitModel, q: string): boolean {
  return (
    unit.feature.id.toLowerCase().includes(q) ||
    unit.feature.name.toLowerCase().includes(q) ||
    unit.feature.description.toLowerCase().includes(q) ||
    (unit.enablementField !== null && fieldMatches(unit.enablementField, q)) ||
    unit.fields.some((f) => fieldMatches(f, q))
  );
}

/**
 * Filter the model by a free-text query across group labels, feature id/name/
 * description, and config key/description. A group matches wholly when its label
 * matches; otherwise it is narrowed to matching units and rows. Empty groups drop.
 */
export function filterSettingsModel(groups: SettingsGroupModel[], query: string): SettingsGroupModel[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  const out: SettingsGroupModel[] = [];
  for (const group of groups) {
    if (group.label.toLowerCase().includes(q)) {
      out.push(group);
      continue;
    }
    const featureUnits = group.featureUnits
      .map((u) =>
        unitMatches(u, q)
          ? u
          : { ...u, fields: u.fields.filter((f) => fieldMatches(f, q)) },
      )
      .filter((u) => unitMatches(u, q) || u.fields.length > 0);
    const plainRows = group.plainRows.filter((f) => fieldMatches(f, q));
    const rawRows = group.rawRows.filter((r) => r.key.toLowerCase().includes(q));
    if (featureUnits.length === 0 && plainRows.length === 0 && rawRows.length === 0) continue;
    out.push({ ...group, featureUnits, plainRows, rawRows });
  }
  return out;
}
