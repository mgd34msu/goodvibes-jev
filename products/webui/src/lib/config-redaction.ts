/** Config display uses canonical declarations. Unknown keys are masked until a current key-name reading settles. No value is sent for interpretation. */
import { asRecord } from "./object";
import {
  SECRET_BEARING_CONFIG_PATHS,
  isSecretBearingConfigKey,
} from "@goodvibes-jev/engine/sdk/platform/judgment-browser/catalogs";
import { CONFIG_SCHEMA_ENTRIES } from "./generated/config-schema";

export const SECRET_CONFIG_KEYS: ReadonlySet<string> = new Set(SECRET_BEARING_CONFIG_PATHS);
const SCHEMA_KEYS = new Set(CONFIG_SCHEMA_ENTRIES.map((entry) => entry.key));
/** Exact schema facts remain structural; undeclared live keys have no display authorization. */
export function isSecretConfigKey(key: string): boolean {
  return isSecretBearingConfigKey(key) || !SCHEMA_KEYS.has(key);
}
export function isUndeclaredConfigKey(key: string): boolean {
  return !SCHEMA_KEYS.has(key);
}
export function isUnresolvedConfigKey(key: string): boolean {
  return !isSecretBearingConfigKey(key) && !SCHEMA_KEYS.has(key);
}
/** Mask a declared secret string, preserving the existing four-character hint. */
export function maskSecretValue(value: string): string {
  if (value.length === 0) return "(empty)";
  if (value.length <= 4) return "••••";
  return `${"•".repeat(Math.min(12, Math.max(4, value.length - 4)))}${value.slice(-4)}`;
}

/** Render a config value for display, masking declared secrets and unresolved names. */
export function displayConfigValue(key: string, value: unknown, cleared = false): string {
  if (isUnresolvedConfigKey(key) && !cleared) return "••••";
  if (
    isSecretBearingConfigKey(key) &&
    typeof value !== "string" &&
    value !== null &&
    value !== undefined
  )
    return "••••";
  if (value === null || value === undefined) return "(unset)";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    if (value === "") return "(empty)";
    return isSecretBearingConfigKey(key) ? maskSecretValue(value) : value;
  }
  if (typeof value === "number") return String(value);
  try {
    return JSON.stringify(value) ?? "(unrepresentable)";
  } catch {
    return "(unrepresentable)";
  }
}

// ---------------------------------------------------------------------------
// Namespace display labels. The GROUPING SOURCE is SDK metadata (CONFIG_SCHEMA
// namespaces + each feature flag's configCategories, see settings-model.ts);
// this table supplies only the human LABEL for a namespace, special-casing
// acronyms/casing the mechanical Title Case fallback (titleCase, below) would
// get wrong (WRFC, TTS, UI, MCP, HTTP Listener, Control Plane). A namespace with
// no entry here Title-Cases itself, honest, never a fabricated label.
//
// This replaces the earlier hand-copied port of the TUI's CATEGORY_LABELS: the
// key namespaces now come from the SDK schema the TUI is also being rebuilt
// onto, so parity is structural rather than a maintained duplicate list. Every
// namespace CONFIG_SCHEMA actually defines is covered here or by titleCase.
// ---------------------------------------------------------------------------

export const CATEGORY_LABELS: Record<string, string> = {
  display: 'Display',
  ui: 'UI',
  provider: 'Provider',
  behavior: 'Behavior',
  storage: 'Storage',
  permissions: 'Permissions',
  diagnostics: 'Diagnostics',
  orchestration: 'Orchestration',
  planner: 'Planner',
  wrfc: 'WRFC',
  helper: 'Helper',
  tts: 'TTS',
  service: 'Service',
  daemon: 'Daemon',
  checkin: 'Check-In',
  controlPlane: 'Control Plane',
  httpListener: 'HTTP Listener',
  web: 'Web',
  atRest: 'At Rest',
  learning: 'Learning',
  batch: 'Batch',
  automation: 'Automation',
  watchers: 'Watchers',
  runtime: 'Runtime',
  telemetry: 'Telemetry',
  cache: 'Cache',
  sandbox: 'Sandbox',
  surfaces: 'Surfaces',
  cloudflare: 'Cloudflare',
  release: 'Release',
  danger: 'Danger',
  tools: 'Tools',
  network: 'Network',
  relay: 'Relay',
  notifications: 'Notifications',
  fetch: 'Fetch',
  security: 'Security',
  integrations: 'Integrations',
  policy: 'Policy',
  agents: 'Agents',
  // profile.* (docs/owner-profile.md §12.1), the owner profile's own settings
  // (enabled, autonomousWrites, discloseWrites, injectOpenTier, …). The webui derives
  // its groups from the schema with no hand-maintained category list, so this domain
  // cannot be dropped the way the TUI and the agent can drop one; the entry here exists
  // so the group renders with a real name instead of a Title-Cased "Profile", which
  // would collide in the reader's mind with platform/profiles' saved display/provider
  // presets, a different thing entirely.
  profile: 'Owner Profile',
  // Covers both voice.local.* (STT/TTS engine paths) and voice.wake.*
  // (wake-word detection). Wake-word rows render as their own titled feature
  // unit inside this group, from the SDK's FEATURE_SETTINGS surface.
  voice: 'Voice',
  device: 'Paired Phone Capabilities',
  // Features are configured through their domain settings keys (SDK 1.7.1's
  // dissolved feature model), no enablement bucket exists anymore. An OLDER
  // daemon can still hold the legacy `featureFlags` record, which then renders
  // honestly as read-only raw rows; this label names that leftover store
  // without resurrecting a dead category name (the daemon migrates the record
  // onto domain keys on upgrade).
  featureFlags: 'Legacy Toggles',
};

function titleCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

/** Category label for a config key's top-level namespace, TUI-parity where a mapping exists. */
export function categoryLabelForKey(key: string): string {
  const namespace = key.split('.')[0] ?? key;
  return CATEGORY_LABELS[namespace] ?? titleCase(namespace);
}

// ---------------------------------------------------------------------------
// Flattening config.get()'s nested object into (key, value) rows.
// ---------------------------------------------------------------------------

export interface ConfigEntry {
  readonly key: string;
  readonly value: unknown;
  readonly category: string;
}

/** Flatten a nested config object into dotted-key rows, deepest values only
 *  (objects are descended except at declared secret paths; arrays are leaves).
 *  A secret object remains one protected row, never clearable child names.
 *  Mirrors the dotted config-key shape config.set expects. */
export function flattenConfig(value: unknown, prefix = ''): ConfigEntry[] {
  const record = asRecord(value);
  const keys = Object.keys(record);
  // Not a plain object at all (or an array/primitive), nothing to flatten.
  if (keys.length === 0 && !(value && typeof value === 'object' && !Array.isArray(value))) return [];
  const entries: ConfigEntry[] = [];
  for (const key of keys) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const item = record[key];
    const isPlainObject = item !== null && typeof item === 'object' && !Array.isArray(item);
    if (isPlainObject && !SECRET_CONFIG_KEYS.has(fullKey)) {
      entries.push(...flattenConfig(item, fullKey));
    } else {
      entries.push({ key: fullKey, value: item, category: categoryLabelForKey(fullKey) });
    }
  }
  return entries;
}
