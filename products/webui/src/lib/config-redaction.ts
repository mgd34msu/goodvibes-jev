/**
 * config-redaction.ts, secret-free config display, honestly.
 *
 * GROUNDED: GET /config (config.get) returns configManager.getAll() verbatim,
 * a plain structuredClone with NO field-level redaction anywhere in the daemon
 * (packages/sdk/src/platform/config/manager.ts). Provider API keys are NOT part
 * of this object (they live in the separate SecretsManager store, resolved
 * through api-keys.ts), but several config values ARE plain, secret-shaped
 * strings the daemon config object carries directly: Slack/Discord/Telegram/
 * WhatsApp/Matrix/etc bot tokens and signing/webhook secrets
 * (schema-domain-surfaces.ts), mail and calendar passwords and secret
 * references (schema-domain-daemon-mailbox.ts,
 * DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS in config-ownership.ts), the cluster
 * coordination phrase and key material, and Cloudflare provisioning tokens
 * (schema-domain-runtime.ts). A web settings surface reading config.get must
 * never render any of those verbatim.
 *
 * DECLARED LIST IS PRIMARY, NOT A NAMING HEURISTIC. This module used to decide
 * "is this a secret?" mostly by pattern-matching the key's last dot-segment
 * against /(token|secret|password|apikey|api_key)$/i, with the curated list as
 * a secondary top-up. That is backwards, and it is a real defect rather than a
 * style preference: a sibling round found the identical suffix-matching shape
 * in the agent's support-bundle redactor, and it matched NONE of `cardNumber`,
 * `cardExpiry`, `cardholderName`, fields that are obviously sensitive to a
 * person but carry no "token/secret/password" word anywhere in their name. The
 * same blind spot exists here: `cloudflare.apiTokenRef` ends in "Ref", not
 * "token"/"secret"/"password", so the suffix pattern let it through; so did
 * `calendar.google.icsUrl` (a private calendar feed URL that grants read
 * access to anyone holding it, config-ownership.ts treats it as a credential
 * for exactly that reason) and `cluster.groupMaterial` (literal key material).
 * A key that merely LOOKS naming-convention-compliant is not the same thing as
 * a key a person has actually decided is safe to show, only enumeration does
 * that.
 *
 * So the order of authority is now:
 *   1. SECRET_CONFIG_KEYS, the declared, enumerated set below. This is the
 *      thing that actually decides "mask this." It carries every mail/calendar
 *      credential and secret-reference, every `surfaces.<channel>.*` token or
 *      secret-shaped field (including surfaces.telephony's, previously
 *      missing), the Cloudflare provisioning tokens, and the cluster
 *      coordination secret/key material, and any payments/card field this
 *      repo defines (none exist in the current schema; see
 *      config-redaction.test.ts for the scan that would catch one arriving
 *      undeclared, to the extent a naming scan can).
 *   2. SECRET_KEY_SUFFIX, kept as an ADDITIONAL safety net, not the decision
 *      maker: a key the declared list has not caught up to yet, but whose last
 *      segment still looks secret-shaped, is also masked. This can never
 *      UNDER-mask relative to declared-list-only; it only ever adds more
 *      masking.
 *   3. Neither is a promise of completeness for a case the brief itself names:
 *      a field whose CONTENT is sensitive but whose NAME carries no signal at
 *      all (card numbers, expiry, cardholder name) cannot be caught by any
 *      naming scan, declared or heuristic. config-redaction.test.ts runs a
 *      broad, test-only content scan (keyword search anywhere in the dotted
 *      key, not just the last segment) over every real schema key and every
 *      daemon-owned non-schema path, and fails the moment one matches that
 *      broad net without being in SECRET_CONFIG_KEYS, so a new field that
 *      merely CONTAINS "secret"/"token"/"password"/"credential" anywhere is
 *      reported by a test rather than silently rendered. A field with no
 *      naming signal whatsoever is the one class this cannot catch
 *      automatically; there is no such field in this repo's schema today.
 */
import { asRecord } from './object';

/**
 * The declared, enumerated set of config keys that hold secret-shaped values.
 * This is the PRIMARY classifier, SECRET_KEY_SUFFIX below is an additional
 * safety net, not a substitute for naming a key here.
 */
export const SECRET_CONFIG_KEYS: ReadonlySet<string> = new Set([
  // Chat/notification surface tokens and signing secrets, ported from
  // goodvibes-tui's src/config/secret-config.ts SECRET_CONFIG_KEYS.
  'surfaces.slack.signingSecret',
  'surfaces.slack.botToken',
  'surfaces.slack.appToken',
  'surfaces.discord.botToken',
  'surfaces.ntfy.token',
  'surfaces.webhook.secret',
  'surfaces.homeassistant.accessToken',
  'surfaces.homeassistant.webhookSecret',
  'surfaces.telegram.botToken',
  'surfaces.telegram.webhookSecret',
  'surfaces.googleChat.verificationToken',
  'surfaces.signal.token',
  'surfaces.whatsapp.accessToken',
  'surfaces.whatsapp.verifyToken',
  'surfaces.whatsapp.signingSecret',
  'surfaces.imessage.token',
  'surfaces.msteams.appPassword',
  'surfaces.bluebubbles.password',
  'surfaces.mattermost.botToken',
  'surfaces.matrix.accessToken',
  // Telephony surface, confirmed gap: schema-domain-surfaces.ts defines these
  // three, none of which were in the TUI's ported list or caught by name alone
  // once considered as a set rather than case-by-case.
  'surfaces.telephony.token',
  'surfaces.telephony.authToken',
  'surfaces.telephony.webhookSecret',
  // Mail and calendar credentials, schema-domain-daemon-mailbox.ts.
  'surfaces.email.password',
  'surfaces.email.imapPassword',
  'surfaces.email.imap.password',
  'surfaces.email.smtp.password',
  'surfaces.calendar.caldavPassword',
  // Mail/calendar secret references and the credential-shaped calendar feed
  // URL, DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS in the SDK's config-ownership.ts
  // (app-layer paths, not CONFIG_SCHEMA scalars, so they never showed up in
  // any suffix scan over the schema).
  'email.passwordRef',
  // Arrived with the 1.19.1 SDK, which split the single mail password reference
  // into an IMAP one and this SMTP one. Caught by the content scan in
  // config-redaction.test.ts rather than by anyone noticing, which is what that
  // scan is for. Undeclared, it would have rendered the operator's outgoing-mail
  // credential reference verbatim in the settings surface.
  'email.smtpPasswordRef',
  'calendar.google.clientSecretRef',
  'calendar.microsoft.clientSecretRef',
  'calendar.google.icsUrl',
  'google.oauth.refreshToken',
  // Cluster coordination, cluster.secret is the shared signing phrase;
  // cluster.groupMaterial is literal key material (config-ownership.ts calls
  // it exactly that). cluster.secret already happened to match the old suffix
  // pattern; cluster.groupMaterial did not.
  'cluster.secret',
  'cluster.groupMaterial',
  // Cloudflare provisioning tokens, schema-domain-runtime.ts. Every one of
  // these ends in "...Ref" (a reference into the secret store), not
  // "token"/"secret"/"password", so the old suffix-only heuristic masked none
  // of them. Deliberately NOT here: cloudflare.accessServiceTokenId (the
  // resource id, not the secret value, same shape as calendar.google.clientId)
  // and cloudflare.secretsStoreName/secretsStoreId (which store to use, not a
  // secret itself).
  'cloudflare.apiTokenRef',
  'cloudflare.workerTokenRef',
  'cloudflare.workerClientTokenRef',
  'cloudflare.tunnelTokenRef',
  'cloudflare.accessServiceTokenRef',
]);

/**
 * Additional safety net: the key's last dot-segment looks secret-shaped. Never
 * the decision-maker (see the module header), a key that needs masking
 * belongs in SECRET_CONFIG_KEYS above; this only ever adds masking on top of
 * that, for a key the declared list has not caught up to yet.
 */
const SECRET_KEY_SUFFIX = /(token|secret|password|apikey|api_key)$/i;

export function isSecretConfigKey(key: string): boolean {
  if (SECRET_CONFIG_KEYS.has(key)) return true;
  const lastSegment = key.split('.').pop() ?? key;
  return SECRET_KEY_SUFFIX.test(lastSegment);
}

/** Mask a secret string the same shape the TUI uses: keep the last 4 chars, star the rest. */
export function maskSecretValue(value: string): string {
  if (value.length === 0) return '(empty)';
  if (value.length <= 4) return '••••';
  return `${'•'.repeat(Math.min(12, Math.max(4, value.length - 4)))}${value.slice(-4)}`;
}

/** Render a config value for display, masking it first if the key is secret-shaped. */
export function displayConfigValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return '(unset)';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') {
    if (value === '') return '(empty)';
    return isSecretConfigKey(key) ? maskSecretValue(value) : value;
  }
  if (typeof value === 'number') return String(value);
  try {
    return JSON.stringify(value) ?? '(unrepresentable)';
  } catch {
    return '(unrepresentable)';
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
 *  (objects are descended, not shown as a row themselves, arrays are treated
 *  as leaf values). Mirrors the dotted config-key shape config.set expects. */
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
    if (isPlainObject) {
      entries.push(...flattenConfig(item, fullKey));
    } else {
      entries.push({ key: fullKey, value: item, category: categoryLabelForKey(fullKey) });
    }
  }
  return entries;
}
