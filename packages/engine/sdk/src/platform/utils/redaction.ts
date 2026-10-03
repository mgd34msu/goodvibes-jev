/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Issuer-reserved credential formats: GitHub, GitLab, Slack and AWS reserve
 * these prefixes for their credentials, so a token in one of these shapes is a
 * credential by the issuer's own definition. Masked everywhere, the owner's
 * own disk included.
 */
const ISSUER_CREDENTIAL_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\b(ghp_[A-Za-z0-9]{36,})/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
  { pattern: /\b(gho_[A-Za-z0-9]{36,})/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
  { pattern: /\b(github_pat_[A-Za-z0-9_]{36,})/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
  { pattern: /\b(glpat-[A-Za-z0-9_-]{20,})/g, replacement: '[REDACTED_GITLAB_TOKEN]' },
  { pattern: /\b(xoxb-[A-Za-z0-9-]{24,})/g, replacement: '[REDACTED_SLACK_TOKEN]' },
  { pattern: /\b(xoxp-[A-Za-z0-9-]{24,})/g, replacement: '[REDACTED_SLACK_TOKEN]' },
  { pattern: /\b(AKIA[A-Z0-9]{16})\b/g, replacement: '[REDACTED_AWS_KEY]' },
];

/**
 * Whether text contains a canonical issuer-reserved credential format.
 *
 * A synchronous containment predicate for callers that refuse a write rather
 * than redact it. Unlike redactIssuerCredentials, this does not consult owner
 * profile values or account identity. Ambiguous candidate shapes are not
 * issuer formats and no judgment request or remembered reading is consulted.
 */
export function containsIssuerCredential(text: string): boolean {
  // String.search does not consume a global pattern's lastIndex, so repeated
  // calls and interleaved redaction cannot change the answer.
  return ISSUER_CREDENTIAL_PATTERNS.some(({ pattern }) => text.search(pattern) !== -1);
}

/**
 * Shapes that a credential often has but that ordinary text also has: an
 * `sk-` token of 20 or more characters, a `key-` token of 16 or more, and the
 * word after `Bearer`. `key-rotation-policy-for-tenants` and "the bearer of bad
 * news" fit them too. The at-rest writers use them only to FIND candidate
 * spans; whether a span is a credential is the `engine.runtime.at-rest-credential`
 * reading (runtime/at-rest-persistence.ts). The Bearer shape matches the token
 * alone, so a marker replaces the token and keeps the word `Bearer`.
 */
const CREDENTIAL_CANDIDATE_SHAPES: ReadonlyArray<{ pattern: RegExp; marker: string }> = [
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}/g, marker: '[REDACTED_API_KEY]' },
  { pattern: /\bkey-[A-Za-z0-9_-]{16,}/g, marker: '[REDACTED_API_KEY]' },
  { pattern: /(?<=Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, marker: '[REDACTED_TOKEN]' },
];

/**
 * What the egress helper masks: the candidate shapes as a masking rule, then
 * the issuer formats. The egress path (session export, telemetry) is not the
 * at-rest path and still masks every candidate span.
 */
const CREDENTIAL_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  ...CREDENTIAL_CANDIDATE_SHAPES.map(({ pattern, marker }) => ({ pattern, replacement: marker })),
  ...ISSUER_CREDENTIAL_PATTERNS,
];

/** A span of text in a credential candidate shape, and the marker that replaces it when masked. */
export interface CredentialCandidate {
  readonly start: number;
  readonly end: number;
  readonly value: string;
  readonly marker: string;
}

/**
 * The spans of `text` in a credential candidate shape, in text order, with
 * overlaps removed (the earlier span wins, and at the same start the longer).
 */
export function findCredentialCandidates(text: string): CredentialCandidate[] {
  const found: CredentialCandidate[] = [];
  for (const { pattern, marker } of CREDENTIAL_CANDIDATE_SHAPES) {
    for (const match of text.matchAll(pattern)) {
      if (match[0].length === 0) continue;
      found.push({ start: match.index, end: match.index + match[0].length, value: match[0], marker });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const spans: CredentialCandidate[] = [];
  for (const candidate of found) {
    const last = spans[spans.length - 1];
    if (last === undefined || candidate.start >= last.end) spans.push(candidate);
  }
  return spans;
}

/**
 * Identity: the running account's home directory and user name.
 *
 * This is ANONYMISATION, not secret-hiding, and it only earns its keep on text
 * that is about to leave the machine, a session export the owner hands to
 * someone, a telemetry payload. Applied to a file that lives on their own disk
 * it destroys information they need (which directory the work happened in) in
 * order to hide their username from themselves, and the substitution cannot
 * be undone.
 *
 * Kept apart from the credential patterns because the two answer different
 * questions and therefore have different correct call sites. See
 * `redactIssuerCredentials` below.
 *
 * The values are the account's own, read from the operating system and
 * supplied through {@link registerAccountIdentityRedaction}, and matched
 * exactly. They are not guessed from path layout: a `/home/<segment>` pattern
 * takes whatever follows `/home/` for a user name, which is wrong for every
 * path under `/home` that is not this account's home and misses a home that
 * lives anywhere else.
 */
export interface AccountIdentity {
  /** The account's home directory, e.g. `/home/alice`, `/Users/alice`, `C:\\Users\\alice`. */
  readonly homeDirectory: string;
  /** The account's login name, e.g. `alice`. */
  readonly userName: string;
}

/** Supplies the running account's identity. */
export type AccountIdentityReader = () => AccountIdentity;

let accountIdentityReader: AccountIdentityReader | null = null;
let identityPatternCacheKey: string | null = null;
let identityPatterns: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [];

/**
 * Register (or clear, with `null`) the reader that supplies the running
 * account's home directory and user name.
 *
 * A registered reader rather than an `os` import, for the same reason as
 * {@link registerProfileRedactionValues}: this module runs in browser, worker
 * and mobile bundles that have no operating-system account. With nothing
 * registered, text keeps its paths and names.
 */
export function registerAccountIdentityRedaction(reader: AccountIdentityReader | null): void {
  accountIdentityReader = reader;
  identityPatternCacheKey = null;
  identityPatterns = [];
}

/**
 * Where a path or name ends: at anything that cannot continue a path segment
 * or a login name. A dot ends it only when no name character follows, so the
 * full stop after `/home/alice.` ends the path and `/home/alice.old` is
 * another directory.
 */
const NAME_END = '(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}_-])';
const NAME_START = '(?<![\\p{L}\\p{N}_.-])';

/**
 * The home directory with its last segment replaced (`/home/[REDACTED]`), so
 * a redacted path still reads as a path, then the user name on its own.
 */
function currentIdentityPatterns(): ReadonlyArray<{ pattern: RegExp; replacement: string }> {
  if (accountIdentityReader === null) return [];
  const { homeDirectory, userName } = accountIdentityReader();
  const home = homeDirectory.replace(/[\\/]+$/, '');
  const name = userName.trim();
  const cacheKey = `${home}\u0000${name}`;
  if (cacheKey !== identityPatternCacheKey) {
    identityPatternCacheKey = cacheKey;
    const separator = Math.max(home.lastIndexOf('/'), home.lastIndexOf('\\'));
    const patterns: Array<{ pattern: RegExp; replacement: string }> = [];
    if (separator >= 0 && separator < home.length - 1) {
      patterns.push({
        pattern: new RegExp(`${escapeRegExp(home)}${NAME_END}`, 'gu'),
        replacement: `${home.slice(0, separator + 1).replace(/\$/g, '$$$$')}[REDACTED]`,
      });
    }
    if (name.length > 0) {
      patterns.push({ pattern: new RegExp(`${NAME_START}${escapeRegExp(name)}${NAME_END}`, 'gu'), replacement: '[REDACTED]' });
    }
    identityPatterns = patterns;
  }
  return identityPatterns;
}

const SECRET_KEY_PATTERN = /(^|[_-])(authorization|token|secret|password|passwd|cookie|credential|api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?(id|token)?)([_-]|$)/i;
const CONTENT_KEY_PATTERN = /(^|[_-])(prompt|response|content|accumulated|body|text|stdout|stderr|output|input|reasoning|transcript|command|arguments|query|detail|summary|message)([_-]|$)/i;

// ---------------------------------------------------------------------------
// Owner-profile containment (docs/owner-profile.md §11.3)
// ---------------------------------------------------------------------------

/**
 * Object keys that name closed-tier owner-profile content.
 *
 * Written out here rather than derived from `platform/owner-profile`, on
 * purpose: this module is imported by session export, at-rest persistence,
 * telemetry helpers and error display, and every one of those has to keep
 * working in a process where no profile was ever loaded. The values arrive
 * through {@link registerProfileRedactionValues}; the key names are a fixed
 * vocabulary and do not need a live profile to be recognised.
 *
 * Mirrors SECRET_KEY_PATTERN's boundary shape, so it matches `shippingAddress`,
 * `shipping_address` and `shipping-address` alike.
 */
const PROFILE_KEY_PATTERN = /(^|[_-])(shipping[_-]?address|billing[_-]?address|home[_-]?address|postal[_-]?address|street[_-]?address|mailing[_-]?address|agent[_-]?alias|quiet[_-]?hours|owner[_-]?profile|profile[_-]?field)([_-]|$)/i;

/**
 * The shortest value that may become a redaction pattern.
 *
 * A short profile value is a footgun, not a secret: `currency: USD` and
 * `shipping tier: standard` are closed-tier fields whose values are ordinary
 * English, and turning them into patterns would blank the word "standard" out
 * of every unrelated log line and stack trace this module touches. Redacting
 * too much is not the safe direction, it destroys the diagnostic the export
 * exists to carry, and it does it silently.
 */
const MIN_PROFILE_VALUE_LENGTH = 8;

/**
 * Values distinctive enough to match on: long enough, and carrying a digit, an
 * `@`, or internal whitespace.
 *
 * That test admits every value that is genuinely identifying, an address, an
 * email, a phone number, a full name, a `22:00-07:00` range, and rejects the
 * single common words (`telegram`, `standard`, `imperial`) that would otherwise
 * become a pattern matching half the corpus.
 */
function isDistinctiveProfileValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < MIN_PROFILE_VALUE_LENGTH) return false;
  return /[0-9@]/.test(trimmed) || /\s/.test(trimmed);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The closed-tier strings a loaded profile wants kept out of anything written
 * out, in two classes.
 *
 * The split exists because §10 (third-party personal data) and the
 * distinctiveness floor genuinely conflict, and the conflict was reproduced: a
 * `People` line reading `- Bob Lee` is seven characters, fell under the floor,
 * and left a session export in the clear. The floor's reasoning is still right
 * for ordinary values, `currency: USD` must not blank the word USD everywhere,
 * so the resolution is to key third-party data on its SECTION rather than on
 * the shape of its value.
 */
export interface ProfileRedactionValues {
  /** Ordinary closed-tier values. Subject to the distinctiveness floor. */
  readonly guarded: readonly string[];
  /**
   * Third-party personal data (`People`). Redacted regardless of length or
   * shape, because §10 is absolute. Matched on word boundaries so a two-letter
   * name cannot blank the middle of unrelated words.
   */
  readonly absolute: readonly string[];
}

/** Supplies the closed-tier values present in the loaded profile, if any. */
export type ProfileRedactionValueReader = () => ProfileRedactionValues;

let profileValueReader: ProfileRedactionValueReader | null = null;
let profilePatternCacheKey: string | null = null;
let profilePatterns: readonly RegExp[] = [];

/**
 * Register (or clear, with `null`) the reader that supplies the loaded
 * profile's closed-tier values.
 *
 * A registered reader rather than an import: `redaction.ts` must stay usable
 * where no profile exists, a browser bundle, a surface with no daemon, a test
 * that never built a store. With nothing registered this module behaves exactly
 * as it did before the profile existed.
 */
export function registerProfileRedactionValues(reader: ProfileRedactionValueReader | null): void {
  profileValueReader = reader;
  profilePatternCacheKey = null;
  profilePatterns = [];
}

/**
 * Compiled patterns for the current profile values.
 *
 * Recompiled only when the set of values actually changes, because this runs on
 * every at-rest write and every exported message, not once per process, the
 * profile is reloaded whenever the owner edits the file, so a
 * compile-once-at-startup cache would go stale the first time they did.
 */
function currentProfilePatterns(): readonly RegExp[] {
  if (profileValueReader === null) return [];
  const { guarded, absolute } = profileValueReader();
  const guardedValues = guarded.map((value) => value.trim()).filter(isDistinctiveProfileValue);
  // Third-party data skips the floor entirely; only genuinely empty is dropped.
  const absoluteValues = absolute.map((value) => value.trim()).filter((value) => value.length > 0);
  const cacheKey = `${guardedValues.join('\u0000')}\u0001${absoluteValues.join('\u0000')}`;
  if (cacheKey !== profilePatternCacheKey) {
    profilePatternCacheKey = cacheKey;
    // Longest first, so a value contained inside another is not left as a
    // half-redacted fragment of the longer one.
    const sortByLength = (a: { value: string }, b: { value: string }): number =>
      b.value.length - a.value.length;
    profilePatterns = [
      ...guardedValues.map((value) => ({ value, boundary: false })),
      ...absoluteValues.map((value) => ({ value, boundary: true })),
    ]
      .sort(sortByLength)
      .map(({ value, boundary }) => (boundary ? boundedPattern(value) : new RegExp(escapeRegExp(value), 'gi')));
  }
  return profilePatterns;
}

/**
 * A pattern that only matches the value as a whole token.
 *
 * `- Al` as a bare substring pattern would blank the "Al" out of "Also" and
 * "Already". The lookarounds are on letters and digits only, so a value that
 * starts or ends with punctuation still matches where it should.
 */
function boundedPattern(value: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(value)}(?![\\p{L}\\p{N}])`, 'giu');
}

function redactTextValue(value: string, key?: string): string {
  if (key && SECRET_KEY_PATTERN.test(key)) return '[REDACTED]';
  if (key && PROFILE_KEY_PATTERN.test(key)) return '[REDACTED_PROFILE]';
  if (key && CONTENT_KEY_PATTERN.test(key)) return `[REDACTED_TEXT length=${value.length}]`;
  if (value.length > 160 || value.includes('\n')) return `[REDACTED_TEXT length=${value.length}]`;
  return redactSensitiveData(value);
}

function applyPatterns(
  text: string,
  patterns: ReadonlyArray<{ pattern: RegExp; replacement: string }>,
): string {
  let result = text;
  // Profile values first: they are whole values, and replacing them before the
  // generic patterns means an address containing a home path is redacted as a
  // profile value rather than left as a partially-rewritten address.
  for (const pattern of currentProfilePatterns()) {
    result = result.replace(pattern, '[REDACTED_PROFILE]');
  }
  // Iterating the INJECTED list rather than a module constant: that is this
  // lane's narrowing, and hard-coding the egress list here would quietly ignore
  // whatever a caller passed.
  for (const { pattern, replacement } of patterns) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Credentials AND home-path anonymisation.
 *
 * For text that is LEAVING the machine, session exports, telemetry. Both
 * halves are wanted there: the reader is not the owner, so the owner's username
 * is not theirs to have.
 */
export function redactSensitiveData(text: string): string {
  return applyPatterns(text, [...CREDENTIAL_PATTERNS, ...currentIdentityPatterns()]);
}

/**
 * Profile values and issuer-reserved credential formats only, leaving paths
 * and candidate-shaped spans intact.
 *
 * For text that STAYS on the owner's machine, the at-rest journal, whose file
 * lives inside the very directory the identity patterns would rewrite. There
 * is no one to anonymise them from in their own files, and `/home/[REDACTED]/…`
 * makes a journal entry unusable for the debugging it exists for. The
 * candidate spans ({@link findCredentialCandidates}) are masked by the at-rest
 * writer on its reading of each one.
 */
export function redactIssuerCredentials(text: string): string {
  return applyPatterns(text, ISSUER_CREDENTIAL_PATTERNS);
}

export function redactStructuredData(value: unknown): unknown {
  return redactStructuredDataInternal(value, undefined, new WeakSet<object>());
}

function redactStructuredDataInternal(
  value: unknown,
  key: string | undefined,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') {
    return redactTextValue(value, key);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactStructuredDataInternal(item, key, seen));
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(entryKey) && typeof entryValue !== 'object') {
        output[entryKey] = '[REDACTED]';
        continue;
      }
      // A profile-shaped key is redacted whatever it holds, including an object:
      // a structured postal address is exactly the shape whose parts would
      // otherwise each be walked and each pass the string checks individually.
      if (PROFILE_KEY_PATTERN.test(entryKey)) {
        output[entryKey] = '[REDACTED_PROFILE]';
        continue;
      }
      output[entryKey] = redactStructuredDataInternal(entryValue, entryKey, seen);
    }
    seen.delete(value);
    return output;
  }
  return String(value);
}

export function isSensitiveTelemetryKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key) || CONTENT_KEY_PATTERN.test(key);
}
