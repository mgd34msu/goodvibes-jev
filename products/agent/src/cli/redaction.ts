import { isSecretConfigKey } from '../config/secret-config.ts';

export const REDACTED_VALUE = '<redacted>';

/**
 * The original rule, and the reason it is not enough on its own: it matches a
 * config path whose LAST SEGMENT is exactly one of these words. `botToken` and
 * `signingSecret` are on the list, so `surfaces.slack.botToken` matches, but
 * anything that spells its credential differently does not, and the words below
 * are a list somebody wrote once rather than a property of the key.
 *
 * The mailbox password reference, the calendar client secrets, the Google
 * refresh token, the Teams app password, the Cloudflare token references and
 * the cluster's key material all name credential material and match NONE of
 * these words, see the list below, which names each one in full. A support
 * bundle is a file the owner emails to someone; a credential in one is out of
 * his hands the moment he sends it.
 *
 * Widening the words is the wrong repair. Matching any segment CONTAINING
 * "token" or "secret" would also swallow the display toggle for token speed,
 * the planner's token ceiling, the token-audit switches, the default tool token
 * budget and the names/ids of the Cloudflare secrets store, numbers, booleans
 * and identifiers a support bundle exists to show, replaced by `<redacted>`.
 * So the missing keys are named in full, below.
 *
 * (Those counter-examples are described rather than spelled on purpose. The
 * settings denominator in verification/settings-consumed-keys.ts counts a key
 * as this product's responsibility when this repo names it, and a comment
 * saying "we deliberately do nothing with this key" is not a consumer. Spelling
 * them here would put a dozen settings into the coverage denominator on the
 * strength of a sentence about leaving them alone.)
 */
const SENSITIVE_PATH_PATTERN = /(^|\.)(apiKey|accessToken|botToken|appToken|signingSecret|webhookSecret|verifyToken|verificationToken|secret|password|token|keyFile)$/i;

/**
 * Credential-bearing config paths named IN FULL, because their last segment is
 * not one of the words above.
 *
 * Two sources feed the sensitive set and this is the second of them; the first
 * is `SECRET_CONFIG_KEYS` (config/secret-config.ts), consulted directly by
 * `isSensitiveConfigPath` so that every key this product already routes through
 * the secret manager is sensitive here without being written down twice. A new
 * secret-backed setting therefore arrives redacted with nobody remembering.
 *
 * What is left for this list is credential material that is NOT secret-backed,
 * a value that can legitimately sit in settings.json as a literal:
 *
 *   - `google.oauth.refreshToken`, a long-lived Google refresh token.
 *   - `calendar.google.icsUrl`, a private calendar feed address. A URL rather
 *     than a password, but it grants read access to the whole calendar to
 *     anyone holding it, which is what makes it a credential.
 *   - `surfaces.googleChat.webhookUrl`, carries its key and token in the query
 *     string; posting to it is posting as the app.
 *   - `cluster.groupMaterial`, the cluster group's key material.
 *   - the `cloudflare.*Ref` keys, the mail/calendar passwords whose segment is
 *     `appPassword` / `imapPassword` / `caldavPassword` / `authToken`, and
 *     `email.smtpPasswordRef`.
 *
 * The Cloudflare access-service token ID, the Cloudflare secrets-store name and
 * id, and Telegram's discovered-bot-token id are deliberately ABSENT: they are
 * identifiers naming WHERE a credential lives, not the credential, and a
 * support bundle that hides them hides the thing being diagnosed. They are
 * described rather than spelled for the denominator reason above.
 */
const SENSITIVE_CONFIG_PATHS: ReadonlySet<string> = new Set([
  // Mail.
  'email.passwordRef',
  'email.smtpPasswordRef',
  'surfaces.email.imapPassword',
  // Calendar.
  'calendar.google.clientSecretRef',
  'calendar.microsoft.clientSecretRef',
  'calendar.google.icsUrl',
  'surfaces.calendar.caldavPassword',
  // Google OAuth.
  'google.oauth.refreshToken',
  // Chat and telephony surfaces whose segment escapes the word list.
  'surfaces.msteams.appPassword',
  'surfaces.telephony.authToken',
  'surfaces.googleChat.webhookUrl',
  // Cloudflare.
  'cloudflare.apiTokenRef',
  'cloudflare.tunnelTokenRef',
  'cloudflare.workerTokenRef',
  'cloudflare.workerClientTokenRef',
  'cloudflare.accessServiceTokenRef',
  // Cluster key material.
  'cluster.groupMaterial',
  'cluster.secret',
  // Payment card material. Declared here rather than matched by a second
  // dedicated regex: a sibling round added
  // /^payments\.(cardNumber|cardExpiry|cardCvv|cardholderName)$/ because none of
  // those names ends in a word the suffix list knows. That fix was right about
  // the defect and narrow about the cure, the next credential whose name does
  // not fit the habit needs a third pattern. The declared set is the cure; the
  // suffix list stays as an additive backstop only.
  'payments.cardNumber',
  'payments.cardExpiry',
  'payments.cardCvv',
  'payments.cardholderName',
]);

const SECRET_LIKE_TEXT_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bghp_[A-Za-z0-9_]{16,}\b/g,
  /\bgho_[A-Za-z0-9_]{16,}\b/g,
  /\bghu_[A-Za-z0-9_]{16,}\b/g,
  /\bghs_[A-Za-z0-9_]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{24,}\b/g,
  /\b(?:xoxb|xapp|xoxp|xoxa)-[A-Za-z0-9-]{16,}\b/g,
  /\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]{8,}@/g,
];

export function isSensitiveConfigPath(path: string): boolean {
  if (SENSITIVE_PATH_PATTERN.test(path)) return true;
  if (SENSITIVE_CONFIG_PATHS.has(path)) return true;
  // Everything routed through the secret manager is sensitive here too, derived
  // rather than restated so the two lists cannot drift apart.
  return isSecretConfigKey(path);
}

export function isRedactedValue(value: unknown): boolean {
  return value === REDACTED_VALUE;
}

export interface RedactedConfigResult<T> {
  readonly value: T;
  readonly redactedPaths: readonly string[];
}

// Redaction rule for sensitive config paths:
// - Non-string values: redact if truthy (i.e. non-null, non-undefined, non-zero, non-false).
//   Rationale: zero and false are never meaningful secrets; null/undefined mean absent.
// - String values: redact non-empty strings that are not goodvibes:// secret refs.
//   Rationale: empty string means unset; secret refs are safe placeholders, not raw values.
function shouldRedactValue(path: string, value: unknown): boolean {
  if (!isSensitiveConfigPath(path)) return false;
  if (typeof value !== 'string') return value !== null && value !== undefined && Boolean(value);
  if (value.trim().length === 0) return false;
  if (value.startsWith('goodvibes://secrets/')) return false;
  return true;
}

function redactUnknown(value: unknown, path: string, redactedPaths: string[]): unknown {
  if (shouldRedactValue(path, value)) {
    redactedPaths.push(path);
    return REDACTED_VALUE;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => redactUnknown(item, `${path}.${index}`, redactedPaths));
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      const nestedPath = path ? `${path}.${key}` : key;
      result[key] = redactUnknown(nested, nestedPath, redactedPaths);
    }
    return result;
  }

  return value;
}

export function redactConfig<T>(config: T): RedactedConfigResult<T> {
  const redactedPaths: string[] = [];
  return {
    value: redactUnknown(config, '', redactedPaths) as T,
    redactedPaths,
  };
}

export function redactText(input: string): string {
  // Assignment form: keyword=value, anchored so 'monkey=' and 'donkey=' do NOT match.
  // Matches: token=, access_token=, api_key=, api-key=, secret=, password= and colon form token: value
  let output = input
    .replace(
      /(?<![A-Za-z])(?:access_token|api[_-]?key|secret|password|token)\s*=\s*([^ \t\r\n"'`]+)/gi,
      (m, val) => m.slice(0, m.length - val.length) + REDACTED_VALUE,
    )
    .replace(
      /(?<![A-Za-z])(?:access_token|api[_-]?key|secret|password|token)\s*:\s*([^ \t\r\n"'`]+)/gi,
      (m, val) => m.slice(0, m.length - val.length) + REDACTED_VALUE,
    );
  for (const pattern of SECRET_LIKE_TEXT_PATTERNS) {
    output = output.replace(pattern, REDACTED_VALUE);
  }
  return output;
}

function collectSensitiveValues(value: unknown, path: string, values: string[]): void {
  if (shouldRedactValue(path, value) && typeof value === 'string') {
    values.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectSensitiveValues(item, `${path}.${index}`, values));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      collectSensitiveValues(nested, path ? `${path}.${key}` : key, values);
    }
  }
}

export function collectSensitiveConfigValues(config: unknown): readonly string[] {
  const values: string[] = [];
  collectSensitiveValues(config, '', values);
  return [...new Set(values)].sort((left, right) => right.length - left.length);
}

export function redactSerializedSecrets(serialized: string, secretValues: readonly string[]): string {
  let output = redactText(serialized);
  for (const secret of secretValues) {
    if (!secret) continue;
    const encoded = JSON.stringify(secret).slice(1, -1);
    output = output.split(encoded).join(REDACTED_VALUE);
    output = output.split(secret).join(REDACTED_VALUE);
  }
  return output;
}
