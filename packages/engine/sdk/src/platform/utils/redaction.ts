/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */
import { FieldKindReader } from './field-kind-reading.js';
import { fieldKind, type FieldKind } from './batteries/field-kind.js';
import { assertRedactionCurrent, ProfileDistinctiveReader, readCredentialProjection, readResidualProjection, type ProfileRedactionRole } from './redaction-reading.js';
import { captureJudgmentPort, type JudgmentPortCapture, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { assertJudgmentInput, captureOwnedJson, retainOwnedJson, judgmentInputProblem, snapshotJudgmentEvidence, snapshotJudgmentInput } from '../gate/judgment-input.js';
import { captureStructuredCredentialReferenceConfigValue } from '../config/structured-credential-config.js';
import { redactionCredential, exportCredential, residualCredential, profileDistinctive, type RedactionPart } from './batteries/redaction.js';

const fieldKinds = new FieldKindReader();
const profileRoles = new ProfileDistinctiveReader();
const settledText = new Map<string, { readonly value: string; readonly assertCurrent: () => void }>();
const pendingText = new Set<string>();

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

// A value-free incarnation: even replacing a reader with itself or clearing an
// already empty registration retires prior asynchronous redaction proofs.
let redactionSourceIncarnation: object = Object.freeze({});
let profileGenerationReader: (() => unknown) | undefined;
let profileReadCapture: (() => { readonly assertCurrent: () => void }) | undefined;
let profileRegistration: object = Object.freeze({});
let identityRegistration: object = Object.freeze({});

/** Capture registration ownership and retain the supplied profile read lifetime. */
export function captureRedactionSource(): { readonly assertCurrent: () => void } {
  const incarnation = redactionSourceIncarnation;
  const readGeneration = profileGenerationReader;
  const captureRead = profileReadCapture;
  const readValues = profileValueReader;
  const readIdentity = accountIdentityReader;
  const unavailable = (): never => { throw new Error('Redaction source is no longer current'); };
  let generation: unknown;
  let read: { readonly assertCurrent: () => void } | undefined;
  let values: string, identity: string;
  try {
    generation = readGeneration?.(); read = captureRead?.();
    values = JSON.stringify(captureOwnedJson(readValues?.() ?? null));
    identity = JSON.stringify(captureOwnedJson(readIdentity?.() ?? null));
  } catch { return unavailable(); }
  const assertCurrent = (): void => {
    if (redactionSourceIncarnation !== incarnation || profileGenerationReader !== readGeneration || profileReadCapture !== captureRead
      || profileValueReader !== readValues || accountIdentityReader !== readIdentity) return unavailable();
    let current: unknown;
    try {
      current = readGeneration?.(); assertRedactionCurrent(() => read?.assertCurrent());
      if (JSON.stringify(captureOwnedJson(readValues?.() ?? null)) !== values
        || JSON.stringify(captureOwnedJson(readIdentity?.() ?? null)) !== identity) return unavailable();
    } catch { return unavailable(); }
    if (current !== generation || redactionSourceIncarnation !== incarnation || profileGenerationReader !== readGeneration || profileReadCapture !== captureRead) return unavailable();
  };
  assertCurrent();
  return Object.freeze({ assertCurrent });
}

let accountIdentityReader: AccountIdentityReader | null = null;
let identityPatternCacheKey: string | null = null;
let identityPatterns: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [];

/**
 * Register (or clear, with `null`) the reader that supplies the running
 * account's home directory and user name. The returned disposer clears only
 * its own still-current registration and is safe to call repeatedly.
 *
 * A registered reader rather than an `os` import, for the same reason as
 * {@link registerProfileRedactionValues}: this module runs in browser, worker
 * and mobile bundles that have no operating-system account. With nothing
 * registered, text keeps its paths and names.
 */
export function registerAccountIdentityRedaction(reader: AccountIdentityReader | null): () => void {
  const registration = Object.freeze({});
  identityRegistration = registration;
  redactionSourceIncarnation = Object.freeze({});
  accountIdentityReader = reader;
  identityPatternCacheKey = null;
  identityPatterns = [];
  return () => {
    if (identityRegistration !== registration) return;
    registerAccountIdentityRedaction(null);
  };
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
  const cacheKey = JSON.stringify([home, name]);
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

// ---------------------------------------------------------------------------
// Owner-profile containment (docs/owner-profile.md §11.3)
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Local registered values; only safe role descriptors enter semantic readings. */
export interface ProfileRedactionValues {
  /** Closed-tier values, withheld unless their declared safe role settles as non-identifying. */
  readonly guarded: readonly string[];
  /** Values stay local. Only declared field/section roles may enter a reading. */
  readonly guardedFields?: readonly (ProfileRedactionRole & { readonly value: string })[];
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
 * profile's closed-tier values. The returned disposer clears only its own
 * still-current registration and never restores an older owner.
 *
 * A registered reader rather than an import: `redaction.ts` must stay usable
 * where no profile exists, a browser bundle, a surface with no daemon, a test
 * that never built a store. With nothing registered this module behaves exactly
 * as it did before the profile existed.
 */
export function registerProfileRedactionValues(
  reader: ProfileRedactionValueReader | null,
  /** Trusted host load-generation identity; no profile value is exposed by the capture. */
  generationReader?: () => unknown,
  /** Capture once, then assert this lease across load and write intent, including same-content changes. */
  captureRead?: () => { readonly assertCurrent: () => void },
): () => void {
  const registration = Object.freeze({});
  profileRegistration = registration;
  redactionSourceIncarnation = Object.freeze({});
  profileGenerationReader = reader === null ? undefined : generationReader;
  profileReadCapture = reader === null ? undefined : captureRead;
  profileValueReader = reader;
  profilePatternCacheKey = null;
  profilePatterns = [];
  return () => {
    if (profileRegistration !== registration) return;
    registerProfileRedactionValues(null);
  };
}

/** Prepare safe role readings without disclosing any registered local value. */
export async function prepareProfileRedactionRoles(options: JudgmentReadingOptions = {}): Promise<void> {
  const source = captureRedactionSource();
  const signal = options.signal, ownerCurrent = options.assertCurrent;
  const assertCurrent = () => {
    if (signal?.aborted || options.signal !== signal || options.assertCurrent !== ownerCurrent) throw new Error('Redaction operation is no longer current');
    source.assertCurrent(); assertRedactionCurrent(ownerCurrent);
  };
  assertCurrent();
  const roles = profileValueReader?.().guardedFields?.map(({ field, sourceKind }) => ({ field, sourceKind })) ?? [];
  await Promise.all(roles.map((role) => profileRoles.readAsync(role, source, { ...(signal ? { signal } : {}), assertCurrent })));
  assertCurrent();
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
  const { guarded, absolute, guardedFields = [] } = profileValueReader();
  const source = captureRedactionSource();
  const rolesByValue = new Map<string, { occurrences: number; roles: ProfileRedactionRole[] }>();
  for (const value of guarded) {
    const key = value.trim().toLowerCase();
    const group = rolesByValue.get(key) ?? { occurrences: 0, roles: [] };
    group.occurrences++;
    rolesByValue.set(key, group);
  }
  for (const { value, field, sourceKind } of guardedFields) rolesByValue.get(value.trim().toLowerCase())?.roles.push({ field, sourceKind });
  const ordinary = new Set([...rolesByValue].filter(([, group]) => group.roles.length === group.occurrences
    && group.roles.every((role) => profileRoles.read(role, source) === false)).map(([key]) => key));
  const guardedValues = guarded.map((value) => value.trim()).filter((value) => value.length > 0 && !ordinary.has(value.toLowerCase()));
  // Third-party data is unconditional; only empty values are dropped.
  const absoluteValues = absolute.map((value) => value.trim()).filter((value) => value.length > 0);
  const cacheKey = JSON.stringify([guardedValues, absoluteValues]);
  if (cacheKey !== profilePatternCacheKey) {
    profilePatternCacheKey = cacheKey;
    // Longest first, so a value contained inside another is not left as a
    // half-redacted fragment of the longer one.
    const sortByLength = (a: { value: string }, b: { value: string }): number =>
      b.value.length - a.value.length;
    profilePatterns = [
      ...guardedValues.map((value) => ({ value, boundary: true })),
      ...absoluteValues.map((value) => ({ value, boundary: true })),
    ]
      .sort(sortByLength)
      .map(({ value, boundary }) => (boundary ? boundedPattern(value) : new RegExp(escapeRegExp(value), 'gi')));
  }
  source.assertCurrent();
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
  const kind = key === undefined ? undefined : readProtectedFieldKind(key);
  if (kind === undefined || kind === 'secret') return '[REDACTED]';
  if (kind === 'owner_profile') return '[REDACTED_PROFILE]';
  if (kind === 'content') return '[REDACTED_TEXT]';
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
  if (text.length === 0) return text;
  const settled = settledText.get(text);
  if (settled !== undefined) {
    try { settled.assertCurrent(); return settled.value; }
    catch { settledText.delete(text); }
  }
  if (!pendingText.has(text)) {
    pendingText.add(text);
    void redactSensitiveDataAsync(text).finally(() => { pendingText.delete(text); });
  }
  try {
    const source = captureRedactionSource();
    const protectedText = applyPatterns(text, [...ISSUER_CREDENTIAL_PATTERNS, ...currentIdentityPatterns()]);
    const spans = outgoingSpans(protectedText);
    const masked = replaceSpans(protectedText, spans.map((span) => ({ ...span, replacement: span.marker })));
    source.assertCurrent();
    // A synchronous error/telemetry boundary cannot await a semantic proof.
    return [...masked.matchAll(/\[REDACTED(?:_[A-Z]+)*\]/g)].map((match) => match[0]).join(' ') || '[REDACTED]';
  } catch { return '[REDACTED]'; }
}

export interface RedactionOptions extends JudgmentReadingOptions {
  /** Literal values already known to the caller as secrets. They never enter a reading. */
  readonly secretValues?: readonly string[];
  readonly purpose?: 'redaction' | 'export';
}
type OutgoingSpan = CredentialCandidate & { readonly field?: string; readonly syntax: 'assignment-value' | 'candidate-token' };

function outgoingSpans(text: string): OutgoingSpan[] {
  const found: OutgoingSpan[] = findCredentialCandidates(text).map((candidate) => ({ ...candidate, syntax: 'candidate-token' }));
  // Egress withholds every namespace-shaped candidate before a reading. The
  // at-rest discovery minimum is not evidence that a shorter value is public.
  for (const match of text.matchAll(/\b(?:sk-|key-)[A-Za-z0-9_-]+/g)) {
    found.push({ start: match.index, end: match.index + match[0].length, value: match[0],
      marker: '[REDACTED_API_KEY]', syntax: 'candidate-token' });
  }
  // Grammar finds values, never decides whether their field is secret.
  const quoted = String.raw`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'`;
  const boundary = String.raw`(?=\s+["']?[A-Za-z_][A-Za-z0-9_.-]*["']?(?:\s*[:=]|\s+is\s+)|[ \t]*(?:[\n,;}]|$))`;
  // A complete quoted value owns its contents. An unquoted value ends before
  // the next field, so each independent role reaches the canonical reader.
  const value = new RegExp(String.raw`(${quoted}|["']|[^"'\n,;}][^\n,;}]*?${boundary})`, 'y');
  const assignments = /(?:^|[\s{[,;])["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*[:=]\s*/g;
  const declarations = /(?:^|\s)([A-Za-z_][A-Za-z0-9_.-]*)\s+is\s+/g;
  const completeQuoted = new RegExp(`^(?:${quoted})$`);
  const headers: { readonly field: string; readonly start: number; readonly keyStart: number }[] = [];
  for (const grammar of [assignments, declarations]) {
    for (let match = grammar.exec(text); match !== null; match = grammar.exec(text)) {
      grammar.lastIndex = match.index + 1;
      const field = match[1];
      if (field !== undefined) headers.push({ field, start: match.index + match[0].length,
        keyStart: match.index + match[0].indexOf(field) });
    }
  }
  const keyStarts = new Set(headers.map((header) => header.keyStart));
  const values: { readonly field: string; readonly value: string; readonly start: number; readonly end: number }[] = [];
  for (const { field, start } of headers) {
    if (keyStarts.has(start)) continue; // The next field follows an empty value.
    value.lastIndex = start;
    const token = value.exec(text)?.[1];
    if (token !== undefined) values.push({ field, value: token, start, end: start + token.length });
  }
  values.sort((a, b) => a.start - b.start || b.end - a.end);
  const quotedOwners: typeof values = [];
  for (const entry of values) {
    if (completeQuoted.test(entry.value) && (quotedOwners.at(-1)?.end ?? -1) <= entry.start) quotedOwners.push(entry);
  }
  let quotedIndex = 0;
  for (const { field, value, start, end } of values) {
    while (quotedOwners[quotedIndex] !== undefined && quotedOwners[quotedIndex]!.end <= start) quotedIndex++;
    const owner = quotedOwners[quotedIndex];
    if (owner !== undefined && owner.start < start && start < owner.end) continue;
    if ((value.startsWith('"') || value.startsWith("'")) && !completeQuoted.test(value))
      throw new Error('Malformed quoted redaction source.');
    if (/^[A-Za-z]$/.test(field) && value.startsWith('\\')) continue; // Windows drive syntax is not a field declaration.
    const candidate = found.find((span) => span.start >= start && span.end <= end);
    const protectedMarker = value.match(/^\[REDACTED(?:_[A-Z]+)*\]$/)?.[0];
    found.push({ start, end, value, field, syntax: 'assignment-value', marker: protectedMarker ?? candidate?.marker ?? '[REDACTED]' });
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end
    || (a.syntax === b.syntax ? 0 : a.syntax === 'assignment-value' ? -1 : 1));
  const spans: OutgoingSpan[] = [];
  for (const span of found) {
    const previous = spans.at(-1);
    if (previous === undefined || previous.end <= span.start) spans.push(span);
  }
  return spans;
}

function replaceSpans(text: string, spans: readonly { readonly start: number; readonly end: number; readonly replacement: string }[]): string {
  let result = '', offset = 0;
  for (const span of spans) { result += text.slice(offset, span.start) + span.replacement; offset = span.end; }
  return result + text.slice(offset);
}

function protectedFieldValue(value: unknown): string {
  if (typeof value !== 'string') return '[REDACTED]';
  const issuer = ISSUER_CREDENTIAL_PATTERNS.find(({ pattern }) => value.search(pattern) !== -1);
  const marker = issuer?.replacement ?? findCredentialCandidates(value)[0]?.marker ?? '[REDACTED]';
  return (value.match(/^Bearer\s+/i)?.[0] ?? '') + marker;
}

interface OperationFieldReadings {
  read(field: string): Promise<FieldKind | undefined>;
  assertCurrent(): void;
  dispose(): void;
}

/** Reuse only equal field requests within this complete, still-owned source. */
function operationFieldReadings(options: JudgmentReadingOptions): OperationFieldReadings {
  const contractKeys = ['name', 'version', 'model', 'items', 'run'] as const;
  const contractDescriptors = contractKeys.map(key => Object.getOwnPropertyDescriptor(fieldKind, key));
  if (contractDescriptors.some(descriptor => descriptor && !('value' in descriptor))) throw new Error('Field reading source is unavailable');
  const contract = retainOwnedJson({ name: fieldKind.name, version: fieldKind.version,
    model: fieldKind.model, items: fieldKind.items });
  const contractPrototype = Object.getPrototypeOf(fieldKind);
  const callerCurrent = options.assertCurrent, signal = options.signal;
  const assertSource = () => {
    assertRedactionCurrent(callerCurrent);
    if (options.signal !== signal || options.assertCurrent !== callerCurrent || signal?.aborted
      || Object.getPrototypeOf(fieldKind) !== contractPrototype) throw new Error('Field reading source is no longer current');
    for (const [index, key] of contractKeys.entries()) {
      const original = contractDescriptors[index], current = Object.getOwnPropertyDescriptor(fieldKind, key);
      if (original === undefined ? current !== undefined : current === undefined || !('value' in current)
        || !Object.is(current.value, original.value) || current.writable !== original.writable
        || current.enumerable !== original.enumerable || current.configurable !== original.configurable)
        throw new Error('Field reading source is no longer current');
    }
    contract.assertCurrent();
  };
  let owner: JudgmentPortCapture | undefined;
  const assertCurrent = () => { if (owner) owner.assertCurrent(); else assertSource(); };
  const reader = new FieldKindReader({ ...options, assertCurrent });
  const results = new Map<string, Promise<FieldKind | undefined>>();
  return {
    assertCurrent,
    async read(field) {
      assertCurrent();
      try { owner ??= captureJudgmentPort(fieldKind.name, { ...options, assertCurrent: assertSource }); }
      catch { assertSource(); return undefined; }
      owner.assertCurrent();
      let result = results.get(field);
      if (result === undefined) {
        if (results.size >= 256) {
          const oldest = results.keys().next();
          if (!oldest.done) results.delete(oldest.value);
        }
        result = reader.readAsync(field);
        results.set(field, result);
      }
      const kind = await result;
      assertCurrent();
      // An unavailable or uncertain equal reading continues to withhold.
      return kind;
    },
    dispose() { reader.dispose(); results.clear(); },
  };
}

/** Captures the complete source locally, then reads only its protected projection. */
export function redactSensitiveDataAsync(text: string, options: RedactionOptions = {}): Promise<string> {
  return redactTextSource(text, options);
}

async function redactTextSource(text: string, options: RedactionOptions,
  operationFields?: OperationFieldReadings, retainCurrent?: (assertCurrent: () => void) => void): Promise<string> {
  if (text.length === 0) return text;
  const signal = options.signal, ownerCurrent = options.assertCurrent, purpose = options.purpose ?? 'redaction';
  let source: ReturnType<typeof captureRedactionSource>;
  let secrets: readonly string[];
  let secretSource: ReturnType<typeof retainOwnedJson>;
  const originalSecrets = options.secretValues;
  let readingOwner: JudgmentPortCapture | undefined;
  try {
    source = captureRedactionSource();
    captureOwnedJson(text);
    secretSource = retainOwnedJson(originalSecrets ?? []);
    const captured = secretSource.snapshot;
    if (!Array.isArray(captured) || !captured.every((value: unknown) => typeof value === 'string')) return '[REDACTED]';
    secrets = captured;
  } catch { return '[REDACTED]'; }
  const assertSource = () => {
    assertRedactionCurrent(ownerCurrent); source.assertCurrent();
    if (signal?.aborted || options.signal !== signal || options.assertCurrent !== ownerCurrent
      || (options.purpose ?? 'redaction') !== purpose
      || options.secretValues !== originalSecrets) throw new Error('Redaction operation is no longer current');
    secretSource.assertCurrent();
  };
  const assertCurrent = () => { if (readingOwner) readingOwner.assertCurrent(); else assertSource(); };
  const kinds = operationFields ?? operationFieldReadings({ ...(signal ? { signal } : {}), assertCurrent });
  try {
    assertCurrent();
    await prepareProfileRedactionRoles({ ...(signal ? { signal } : {}), assertCurrent });
    let protectedText = applyPatterns(text, [...ISSUER_CREDENTIAL_PATTERNS, ...currentIdentityPatterns()]);
    for (const secret of [...secrets].filter((value) => value.length > 0).sort((a, b) => b.length - a.length))
      protectedText = protectedText.replaceAll(secret, '[REDACTED]');
    const lines = protectedText.split('\n').map((line) => {
      const spans = outgoingSpans(line);
      const parts: RedactionPart[] = [];
      let offset = 0;
      for (const [index, span] of spans.entries()) {
        parts.push({ kind: 'text', text: line.slice(offset, span.start) });
        const safeField = span.field !== undefined && applyPatterns(span.field,
          [...ISSUER_CREDENTIAL_PATTERNS, ...currentIdentityPatterns()]) === span.field ? span.field : undefined;
        parts.push({ kind: 'span', reference: `span-${index + 1}`, syntax: span.syntax,
          ...(safeField !== undefined ? { field: safeField } : {}) });
        offset = span.end;
      }
      parts.push({ kind: 'text', text: line.slice(offset) });
      return { line, spans, parts };
    });
    // Inspect the complete projection before capturing any free-text reading port.
    snapshotJudgmentInput({ lines: lines.map(({ parts }) => ({ parts })) });
    readingOwner = captureJudgmentPort(purpose === 'export' ? 'engine.export.credential' : 'engine.redaction.credential',
      { ...(signal ? { signal } : {}), assertCurrent: assertSource });
    const output: string[] = [];
    for (const { line, spans, parts } of lines) {
      assertCurrent();
      if (line.length === 0) { output.push(line); continue; }
      const replacements: { start: number; end: number; replacement: string }[] = [];
      if (spans.length === 0) {
        const reading = await readCredentialProjection({ phase: 'source', parts, target: 'whole-line' }, purpose,
          { ...(signal ? { signal } : {}), assertCurrent });
        output.push(reading?.line === false && reading.span === false ? line : '[REDACTED]');
      } else {
        let lineHasCredential = false, hasProtectedSpan = false;
        for (const [index, span] of spans.entries()) {
          let replacement = span.marker;
          const field = span.field;
          const kind = field === undefined ? undefined : await kinds.read(field);
          if (kind === 'secret') replacement = (span.value.match(/^Bearer\s+/i)?.[0] ?? '') + span.marker;
          else if (kind === 'owner_profile') replacement = '[REDACTED_PROFILE]';
          else if (kind === 'content') replacement = '[REDACTED_TEXT]';
          else if (field === undefined || kind === 'other') {
            const reading = await readCredentialProjection({ phase: 'source', parts, target: `span-${index + 1}` }, purpose,
              { ...(signal ? { signal } : {}), assertCurrent });
            lineHasCredential ||= reading?.line === true;
            // A role reading cannot release literal authentication/card syntax
            // nested inside an otherwise ordinary opaque value.
            if (reading?.span === false) {
              // Observational egress may already contain our public redaction
              // tokens. Actual nested credentials and cards still withhold the
              // complete span; this never changes action-input admission.
              try { snapshotJudgmentEvidence(span.value); replacement = span.value; }
              catch { /* Preserve the withheld replacement. */ }
            }
          }
          hasProtectedSpan ||= replacement !== span.value;
          assertCurrent();
          replacements.push({ start: span.start, end: span.end, replacement });
        }
        // A benign target cannot certify unrelated prose. Read every residual
        // text part after removing all local spans, independently of target roles.
        const residual = parts.map((part): RedactionPart => part.kind === 'span'
          ? { kind: 'withheld', reference: part.reference } : part);
        const remaining = await readResidualProjection(residual,
          { ...(signal ? { signal } : {}), assertCurrent });
        output.push(remaining === false && (!lineHasCredential || hasProtectedSpan)
          ? replaceSpans(line, replacements) : '[REDACTED]');
      }
    }
    assertCurrent(); kinds.assertCurrent();
    const result = output.join('\n');
    retainCurrent?.(() => { assertCurrent(); kinds.assertCurrent(); });
    if (purpose === 'redaction' && operationFields === undefined) {
      if (settledText.size >= 128) {
        const oldest = settledText.keys().next();
        if (!oldest.done) settledText.delete(oldest.value);
      }
      settledText.set(text, { value: result, assertCurrent: () => { assertCurrent(); kinds.assertCurrent(); } });
    }
    return result;
  } catch { return '[REDACTED]'; }
  finally { if (operationFields === undefined) kinds.dispose(); }
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

/** Shared asynchronous egress recursion. Field values never enter field-role readings. */
export async function redactStructuredDataAsync(value: unknown, options: RedactionOptions = {}): Promise<unknown> {
  const signal = options.signal, ownerCurrent = options.assertCurrent;
  let source: ReturnType<typeof captureRedactionSource>, snapshot: unknown, retainedValue: ReturnType<typeof retainOwnedJson>;
  const purpose = options.purpose, originalSecrets = options.secretValues;
  const secretSource = retainOwnedJson(originalSecrets ?? []), capturedSecrets = secretSource.snapshot;
  const secretLiterals: string[] = [];
  if (!Array.isArray(capturedSecrets)) return '[REDACTED]';
  for (const secret of capturedSecrets) {
    if (typeof secret !== 'string') return '[REDACTED]';
    if (secret.length > 0) secretLiterals.push(secret);
  }
  secretLiterals.sort((a, b) => b.length - a.length);
  type ReferenceCapture = { readonly kind: 'held' } | { readonly kind: 'sentinel' }
    | { readonly kind: 'reference'; readonly value: ReturnType<typeof captureStructuredCredentialReferenceConfigValue> };
  const nativeReferences = new Map<string, { readonly path: readonly string[]; readonly capture: ReferenceCapture }>();
  let readingOwner: JudgmentPortCapture | undefined;
  let assertTextContracts: () => void;
  try {
    // Repeated text may share a result only while every defining contract is
    // still the one captured for this operation, including profile roles.
    const contracts = [redactionCredential, exportCredential, residualCredential, profileDistinctive].map(battery => {
      const keys = ['name', 'version', 'model', 'items', 'run'] as const;
      const prototype = Object.getPrototypeOf(battery);
      const descriptors = keys.map(key => Object.getOwnPropertyDescriptor(battery, key));
      if (descriptors.some(descriptor => descriptor && !('value' in descriptor))) throw new Error('Redaction contract is unavailable');
      const data = retainOwnedJson({ name: battery.name, version: battery.version, model: battery.model, items: battery.items });
      return () => {
        if (Object.getPrototypeOf(battery) !== prototype) throw new Error('Redaction contract is no longer current');
        for (const [index, key] of keys.entries()) {
          const original = descriptors[index], current = Object.getOwnPropertyDescriptor(battery, key);
          if (original === undefined ? current !== undefined : current === undefined || !('value' in current)
            || !Object.is(current.value, original.value) || current.writable !== original.writable
            || current.enumerable !== original.enumerable || current.configurable !== original.configurable)
            throw new Error('Redaction contract is no longer current');
        }
        data.assertCurrent();
      };
    });
    assertTextContracts = () => { for (const assertContract of contracts) assertContract(); };
    source = captureRedactionSource(); retainedValue = retainOwnedJson(value); snapshot = retainedValue.snapshot;
    // Only native config and the support bundle's root config envelope carry
    // this declaration. An arbitrary extension suffix grants no exemption.
    for (const path of [['judgment.fallbacks'], ['judgment', 'fallbacks'], ['config', 'judgment.fallbacks'], ['config', 'judgment', 'fallbacks']]) {
      const raw = originalPath(path);
      if (raw.kind === 'missing') continue;
      let capture: ReferenceCapture = { kind: 'held' };
      if (raw.value === '<redacted>') capture = { kind: 'sentinel' };
      else try {
        const references = captureStructuredCredentialReferenceConfigValue('judgment.fallbacks', raw.value);
        capture = { kind: 'reference', value: references };
      } catch { /* Malformed declared values remain opaque throughout this operation. */ }
      nativeReferences.set(JSON.stringify(path), { path, capture });
    }
  } catch { return '[REDACTED]'; }
  const assertSource = () => {
    assertRedactionCurrent(ownerCurrent); source.assertCurrent();
    if (signal?.aborted || options.signal !== signal || options.assertCurrent !== ownerCurrent
      || options.purpose !== purpose || options.secretValues !== originalSecrets) throw new Error('Structured redaction source is no longer current');
    secretSource.assertCurrent(); retainedValue.assertCurrent();
  };
  const assertCurrent = () => { if (readingOwner) readingOwner.assertCurrent(); else assertSource(); };
  const reading = { ...options, assertCurrent };
  const fields = operationFieldReadings(reading);
  const texts = new Map<string, { readonly value: string; readonly assertCurrent: () => void }>();
  function protectKey(key: string): string {
    let protectedKey = applyPatterns(key, [...ISSUER_CREDENTIAL_PATTERNS, ...currentIdentityPatterns()]);
    for (const secret of secretLiterals) protectedKey = protectedKey.replaceAll(secret, '[REDACTED]');
    return protectedKey;
  }
  function originalPath(path: readonly string[]): { readonly kind: 'missing' } | { readonly kind: 'present'; readonly value: unknown } {
    let raw: unknown = value;
    for (const segment of path) {
      if (raw === null || typeof raw !== 'object') return { kind: 'missing' };
      const descriptor = Object.getOwnPropertyDescriptor(raw, segment);
      if (!descriptor?.enumerable || !('value' in descriptor)) return { kind: 'missing' };
      raw = descriptor.value;
    }
    return { kind: 'present', value: raw };
  }
  function protectReference(path: readonly string[]): unknown {
    // The retained parser capture includes original fields structural JSON
    // omits, and the source guard revalidates it at every reading boundary.
    const capture = nativeReferences.get(JSON.stringify(path))?.capture;
    if (capture === undefined || capture.kind === 'held') return '[REDACTED]';
    if (capture.kind === 'sentinel') return '<redacted>';
    for (const reference of capture.value) for (const text of [reference.endpoint, reference.model, reference.keySource, reference.keyName]) {
      if (protectKey(text) !== text || judgmentInputProblem(text) !== undefined) return '[REDACTED]';
    }
    return capture.value;
  }
  type FieldReading = { readonly kind: 'reference'; readonly safeKey: string; readonly value: unknown }
    | { readonly kind: 'semantic'; readonly safeKey: string; readonly fieldKind: FieldKind | undefined };
  async function visit(entry: unknown, path: readonly string[] = []): Promise<unknown> {
    assertCurrent();
    if (typeof entry === 'string') {
      // A fixed credential-reference sentinel, never a raw secret value.
      if (entry === '<redacted>') return entry;
      assertTextContracts();
      const cached = texts.get(entry);
      if (cached) { cached.assertCurrent(); return cached.value; }
      let current: (() => void) | undefined;
      const result = await redactTextSource(entry, reading, fields, guard => { current = guard; });
      assertTextContracts();
      if (current) {
        current();
        if (texts.size >= 256) {
          const oldest = texts.keys().next();
          if (!oldest.done) texts.delete(oldest.value);
        }
        texts.set(entry, { value: result, assertCurrent: current });
      }
      return result;
    }
    if (Array.isArray(entry)) {
      const output: unknown[] = [];
      for (const [index, child] of entry.entries()) output.push(await visit(child, [...path, String(index)]));
      return output;
    }
    if (entry !== null && typeof entry === 'object') {
      const output: Record<string, unknown> = {};
      const entries = Object.entries(Object.getOwnPropertyDescriptors(entry));
      for (let offset = 0; offset < entries.length; offset += 4) {
        const batch = entries.slice(offset, offset + 4);
        // Drain the bounded group even when one source is retired while awaiting.
        const readings = await Promise.allSettled(batch.map(async ([key]): Promise<FieldReading> => {
          let safeKey = protectKey(key);
          const childPath = [...path, key];
          if (nativeReferences.has(JSON.stringify(childPath))) return { kind: 'reference', safeKey,
            value: safeKey === key ? protectReference(childPath) : '[REDACTED]' };
          // Property names are source text too. An assignment-shaped name must
          // pass the same withheld-span readings before it can become a field
          // role question or an output key. Reuse only this operation's owned
          // complete-text reading, including its source/contract restrictions.
          if (safeKey === key && outgoingSpans(key).length > 0) {
            const protectedKey = await visit(key);
            if (typeof protectedKey !== 'string') throw new Error('Protected field name is unavailable');
            safeKey = protectedKey;
          }
          return { kind: 'semantic', safeKey, fieldKind: safeKey === key ? await fields.read(key) : undefined };
        }));
        assertCurrent();
        for (const [index, [key, descriptor]] of batch.entries()) {
          const result = readings[index];
          if (result === undefined || result.status === 'rejected') throw new Error('Field reading source is no longer current');
          const reading = result.value, { safeKey } = reading;
          const child: unknown = descriptor.value;
          let outputKey = safeKey, suffix = 1;
          while (Object.hasOwn(output, outputKey)) outputKey = `${safeKey} [${suffix++}]`;
          Object.defineProperty(output, outputKey, { value: reading.kind === 'reference' ? reading.value
            : child === '<redacted>' ? child : reading.fieldKind === undefined ? '[REDACTED]'
              : reading.fieldKind === 'secret' ? protectedFieldValue(child)
                : reading.fieldKind === 'owner_profile' ? '[REDACTED_PROFILE]' : await visit(child, [...path, key]), enumerable: true });
        }
      }
      return output;
    }
    return entry;
  }
  try {
    const names: string[] = [];
    function collect(entry: unknown, path: readonly string[] = []): void {
      if (Array.isArray(entry)) { for (const [index, child] of entry.entries()) collect(child, [...path, String(index)]); }
      else if (entry !== null && typeof entry === 'object') for (const [key, child] of Object.entries(entry)) {
        const childPath = [...path, key];
        if (nativeReferences.has(JSON.stringify(childPath))) continue;
        // Candidate values embedded in a name stay local until visit protects
        // them. They must never enter the initial field-name admission.
        if (protectKey(key) === key && outgoingSpans(key).length === 0) names.push(key);
        collect(child, childPath);
      }
    }
    collect(snapshot); assertJudgmentInput({ fields: names }); assertCurrent();
    try { readingOwner = captureJudgmentPort('engine.redaction.field-kind', { ...options, assertCurrent: assertSource }); }
    catch { /* Unavailable field readings withhold each value while preserving structure. */ }
    const result = await visit(snapshot); assertCurrent(); fields.assertCurrent(); assertTextContracts(); return result;
  }
  catch { return '[REDACTED]'; }
  finally { fields.dispose(); }
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
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)];
        result.push(descriptor === undefined ? undefined : !('value' in descriptor) ? '[REDACTED]'
          : redactStructuredDataInternal(descriptor.value, key, seen));
      }
      seen.delete(value);
      return result;
    }
    const output: Record<string, unknown> = {};
    for (const [entryKey, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      let safeKey = applyPatterns(entryKey, [...ISSUER_CREDENTIAL_PATTERNS, ...currentIdentityPatterns()]);
      if (safeKey === entryKey && outgoingSpans(entryKey).length > 0) safeKey = redactSensitiveData(entryKey);
      let outputKey = safeKey, suffix = 1;
      while (Object.hasOwn(output, outputKey)) outputKey = `${safeKey} [${suffix++}]`;
      const kind = safeKey === entryKey ? readProtectedFieldKind(entryKey) : undefined;
      if (kind === undefined || kind === 'secret' || !('value' in descriptor)) {
        Object.defineProperty(output, outputKey, { value: '[REDACTED]', enumerable: true });
        continue;
      }
      // A profile-shaped key is redacted whatever it holds, including an object:
      // a structured postal address is exactly the shape whose parts would
      // otherwise each be walked and each pass the string checks individually.
      if (kind === 'owner_profile') {
        Object.defineProperty(output, outputKey, { value: '[REDACTED_PROFILE]', enumerable: true });
        continue;
      }
      Object.defineProperty(output, outputKey, { value: redactStructuredDataInternal(descriptor.value, entryKey, seen), enumerable: true });
    }
    seen.delete(value);
    return output;
  }
  return '[REDACTED]';
}

export function isSensitiveTelemetryKey(key: string): boolean {
  return readProtectedFieldKind(key) !== 'other';
}

function readProtectedFieldKind(key: string) {
  if (redactIssuerCredentials(key) !== key) return undefined;
  return fieldKinds.read(key);
}
