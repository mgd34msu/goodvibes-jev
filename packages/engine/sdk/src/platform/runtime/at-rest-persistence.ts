/**
 * at-rest-persistence.ts, the redaction + retention policy layer for the two
 * raw-content on-disk writers: the per-agent transcript journal
 * (agents/session.ts, `<agentId>.jsonl`) and the local execution ledger
 * (runtime/telemetry/exporters/local-ledger.ts, spans + `<file>.ledger.jsonl`).
 *
 * Both historically appended raw serialized records, a prompt, a tool stdout,
 * an event payload, straight to disk, so an API key or bearer token that
 * flowed through a turn was persisted in the clear. The redaction helper
 * (utils/redaction.ts) existed but was wired only to the telemetry query egress,
 * so nothing masked the at-rest copy.
 *
 * This module supplies:
 *   - redactAtRestLine: mask profile values and issuer-reserved credential
 *     formats (redactIssuerCredentials), and every candidate span (an `sk-` or
 *     `key-` token, the word after `Bearer`) that has not been read as
 *     something other than a credential by `engine.runtime.at-rest-credential`,
 *     in a serialized JSON line before it is appended.
 *     The markers replace only the matched secret substrings with
 *     JSON-safe `[REDACTED_*]` markers, so the line stays valid JSON and its
 *     non-secret content stays readable, a redacted record never pretends the
 *     content was not there, it shows the marker.
 *
 *     Credentials ONLY, deliberately. utils/redaction.ts also carries
 *     home-path anonymisation, and the egress helper (redactSensitiveData)
 *     applies both, correctly, because a session export goes to someone who
 *     is not the owner. These files do not go anywhere: they sit on the
 *     owner's disk, inside the very directory those patterns rewrite.
 *     Anonymising the owner from themselves turned `/home/owner/Projects/x`
 *     into `/home/[REDACTED]/Projects/x` at write time and irreversibly, which
 *     costs the journal the one detail that makes a stale entry worth reading
 *     and protects nobody.
 *   - enforceFileRetention: an age + total-size cap over a set of append-only
 *     files, deleting oldest-first. A production caller invokes it at a natural
 *     lifecycle point (the checkpoint-gc lesson: retention that is defined but
 *     never called reclaims nothing).
 *   - resolveAtRestPolicy: read the honest-default config keys (redaction on by
 *     default; retention generous but bounded) into a resolved policy.
 */
import { createHash } from 'node:crypto';
import { statSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { mapLimit } from '@goodvibes-jev/judgment';
import { captureJudgmentPort, type JudgmentPortCapture } from '@goodvibes-jev/engine/errors';
import { captureRedactionSource, containsIssuerCredential, findCredentialCandidates, redactIssuerCredentials, type CredentialCandidate } from '../utils/redaction.js';
import { logger } from '../utils/logger.js';
import { captureOwnedJson, snapshotJudgmentInput } from '../gate/judgment-input.js';
import { atRestCredential } from './batteries/at-rest-credential.js';

/** Resolved at-rest policy the journal + ledger writers consult. */
export interface AtRestPolicy {
  /** Redact secret/credential patterns in each record before it is written. */
  readonly redact: boolean;
  /** Retention caps enforced over the on-disk files. */
  readonly retention: {
    /** Delete files whose mtime is older than this many milliseconds. */
    readonly maxAgeMs: number;
    /** Delete oldest files until the set's total size is under this many bytes. */
    readonly maxTotalBytes: number;
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;

/**
 * The honest defaults, used when no config is wired: redaction ON, retention
 * generous but bounded (30 days / 512 MB) so a long-lived daemon cannot grow
 * these files without limit while a normal debugging window stays intact.
 */
export const DEFAULT_AT_REST_POLICY: AtRestPolicy = {
  redact: true,
  retention: { maxAgeMs: 30 * DAY_MS, maxTotalBytes: 512 * MB },
};

/** Config keys backing the policy (see config/schema-domain-at-rest.ts). */
export const AT_REST_CONFIG_KEYS = {
  redactEnabled: 'atRest.redactionEnabled',
  maxAgeDays: 'atRest.retentionMaxAgeDays',
  maxTotalMb: 'atRest.retentionMaxTotalMb',
} as const;

/**
 * Build a resolved policy from a config getter (ConfigManager.get shape). A
 * missing/invalid value falls back to the honest default rather than throwing,
 * a config problem must never take the write path down.
 */
export function resolveAtRestPolicy(get?: (key: string) => unknown): AtRestPolicy {
  if (!get) return DEFAULT_AT_REST_POLICY;
  const redactRaw = get(AT_REST_CONFIG_KEYS.redactEnabled);
  const ageDaysRaw = get(AT_REST_CONFIG_KEYS.maxAgeDays);
  const totalMbRaw = get(AT_REST_CONFIG_KEYS.maxTotalMb);
  const redact = typeof redactRaw === 'boolean' ? redactRaw : DEFAULT_AT_REST_POLICY.redact;
  const maxAgeMs = typeof ageDaysRaw === 'number' && ageDaysRaw > 0
    ? ageDaysRaw * DAY_MS
    : DEFAULT_AT_REST_POLICY.retention.maxAgeMs;
  const maxTotalBytes = typeof totalMbRaw === 'number' && totalMbRaw > 0
    ? totalMbRaw * MB
    : DEFAULT_AT_REST_POLICY.retention.maxTotalBytes;
  return { redact, retention: { maxAgeMs, maxTotalBytes } };
}

// ---------------------------------------------------------------------------
// Candidate spans: `engine.runtime.at-rest-credential`
// ---------------------------------------------------------------------------

/** How much text on each side of a candidate span the reading sees. */
const CANDIDATE_CONTEXT_CHARS = 160;
/** How many span readings run at once; each span is its own request. */
const CANDIDATE_READ_CONCURRENCY = 4;
/** How many span readings are remembered for the life of the process. */
const REMEMBERED_SPAN_LIMIT = 2048;

/** Immutable original and its current local profile/issuer projection. Never logged. */
interface AdmittedLine {
  readonly original: string;
  readonly text: string;
  readonly revision: string;
  readonly redaction: ReturnType<typeof captureRedactionSource>;
}
interface SpanReading {
  readonly clear: boolean;
  readonly redaction: ReturnType<typeof captureRedactionSource>;
  readonly authority: JudgmentPortCapture;
}
interface PendingSpan {
  readonly authority: JudgmentPortCapture;
  readonly promise: Promise<void>;
}

// Context and source identity are part of a reading, not just the token value.
// Store digests and bounded authority records, never a plaintext credential map.
const spanReadings = new Map<string, SpanReading>();
const spanReadsInFlight = new Map<string, PendingSpan>();
let readingGeneration = 0;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const spanKey = (line: AdmittedLine, candidate: CredentialCandidate): string =>
  `${line.revision}:${candidate.start}:${candidate.end}`;
const unavailable = (): Error => new Error('At-rest credential reading is unavailable; unread spans remain masked');

/** Match issuer formats in strings/keys and nested JSON-string envelopes. */
function containsDecodedIssuer(value: unknown): boolean {
  let nodes = 0;
  let characters = 0;
  const visit = (entry: unknown, depth: number): boolean => {
    if (++nodes > 20_000 || depth > 64) throw unavailable();
    if (typeof entry === 'string') {
      characters += entry.length;
      if (characters > 1_000_000) throw unavailable();
      if (containsIssuerCredential(entry)) return true;
      const trimmed = entry.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        let decoded: unknown;
        try { decoded = JSON.parse(entry) as unknown; } catch { return false; }
        return visit(decoded, depth + 1);
      }
      return false;
    }
    if (Array.isArray(entry)) return entry.some((child) => visit(child, depth + 1));
    if (entry && typeof entry === 'object') {
      return Object.entries(entry).some(([key, child]) => visit(key, depth + 1) || visit(child, depth + 1));
    }
    return false;
  };
  return visit(value, 0);
}

/**
 * Admit the COMPLETE original before extracting any candidate or context.
 * The ledger span writer also supplies JSONL batches. Inspect both the intact
 * input (including multiline material) and every complete decoded record.
 * This is the existing deterministic floor, not universal secret detection.
 * Refused sources still use the existing local issuer/candidate masking path;
 * this boundary does not change the persisted journal/ledger record schema.
 */
function admitLine(original: string): AdmittedLine | undefined {
  try {
    const redaction = captureRedactionSource();
    snapshotJudgmentInput(original);
    if (containsIssuerCredential(original)) return undefined;
    let records: unknown[];
    try { records = [JSON.parse(original) as unknown]; }
    catch {
      const lines = original.split('\n').filter((line) => line.trim().length > 0);
      if (lines.length === 0) return undefined;
      records = lines.map((line) => JSON.parse(line) as unknown);
    }
    for (const record of records) {
      snapshotJudgmentInput(record);
      // JSON escaping must not conceal an issuer format from admission.
      if (containsDecodedIssuer(record)) return undefined;
    }
    const text = redactIssuerCredentials(original);
    redaction.assertCurrent();
    return Object.freeze({ original, text, revision: digest(JSON.stringify([original, text])), redaction });
  } catch {
    // Never retain or inspect an upstream rejection, which may carry source text.
    return undefined;
  }
}

/** Fence transport AND the installed decision recorder without retaining original text. */
function captureReadingAuthority(site: string, redactions: readonly ReturnType<typeof captureRedactionSource>[]): JudgmentPortCapture {
  const generation = readingGeneration;
  // Capture only value-free assertions, never AdmittedLine/source strings.
  const checks = redactions.map((source) => source.assertCurrent);
  return captureJudgmentPort(site, { assertCurrent: () => {
    if (generation !== readingGeneration) throw unavailable();
    for (const check of checks) check();
  } });
}

function remembered(line: AdmittedLine, candidate: CredentialCandidate, authority: JudgmentPortCapture): boolean | undefined {
  const key = spanKey(line, candidate);
  const reading = spanReadings.get(key);
  if (!reading) return undefined;
  try {
    authority.assertCurrent();
    if (reading.authority.identity !== authority.identity) return undefined;
    line.redaction.assertCurrent();
    reading.redaction.assertCurrent();
    reading.authority.assertCurrent();
    authority.assertCurrent();
    return reading.clear;
  }
  catch { spanReadings.delete(key); return undefined; }
}

function rememberSpan(key: string, clear: boolean, authority: JudgmentPortCapture, redaction: ReturnType<typeof captureRedactionSource>): void {
  if (spanReadings.size >= REMEMBERED_SPAN_LIMIT && !spanReadings.has(key)) {
    spanReadings.delete(spanReadings.keys().next().value!);
  }
  spanReadings.set(key, { clear, authority, redaction });
}

function unreadCandidates(line: AdmittedLine, authority: JudgmentPortCapture): CredentialCandidate[] {
  return findCredentialCandidates(line.text).filter((candidate) => remembered(line, candidate, authority) === undefined);
}

function readSpan(candidate: CredentialCandidate, line: AdmittedLine, site: string, authority: JudgmentPortCapture): Promise<void> {
  const key = spanKey(line, candidate);
  const inFlight = spanReadsInFlight.get(key);
  if (inFlight?.authority.identity === authority.identity) return inFlight.promise;
  const generation = readingGeneration;
  const assertCurrent = () => {
    authority.assertCurrent();
    line.redaction.assertCurrent();
    if (generation !== readingGeneration || admitLine(line.original)?.revision !== line.revision) throw unavailable();
    authority.assertCurrent();
  };
  const read = (async (): Promise<void> => {
    try {
      assertCurrent();
      const state = {
        span: candidate.value,
        context: line.text.slice(Math.max(0, candidate.start - CANDIDATE_CONTEXT_CHARS), candidate.end + CANDIDATE_CONTEXT_CHARS),
      };
      const run = await atRestCredential.run(authority.port, state, {
        site, signal: authority.signal, beforeAttempt: assertCurrent,
      });
      assertCurrent();
      // Critical's settled no already requires >=0.9 confidence; its legacy band never emits act.
      const clear = run.readings.credential.verdict === 'no';
      run.recordAction(clear ? 'keep' : 'mask');
      assertCurrent();
      rememberSpan(key, clear, authority, line.redaction);
    } catch { throw unavailable(); }
  })();
  const pending = { authority, promise: read };
  spanReadsInFlight.set(key, pending);
  const release = () => { if (spanReadsInFlight.get(key) === pending) spanReadsInFlight.delete(key); };
  void read.then(release, release);
  return read;
}

async function readAdmittedLines(lines: readonly AdmittedLine[], site: string, authority: JudgmentPortCapture): Promise<void> {
  const work: Array<{ candidate: CredentialCandidate; line: AdmittedLine }> = [];
  const keys = new Set<string>();
  for (const line of lines) {
    for (const candidate of unreadCandidates(line, authority)) {
      const key = spanKey(line, candidate);
      if (keys.has(key)) continue;
      keys.add(key);
      work.push({ candidate, line });
    }
  }
  await mapLimit(work, CANDIDATE_READ_CONCURRENCY, ({ candidate, line }) => readSpan(candidate, line, site, authority));
}

/**
 * Protected or unsupported originals are never sent to the judgment port.
 * Admissible records retain the semantic reading; missing/failed ports reject
 * with a fixed error and leave unread spans masked. No source is truncated to
 * make it pass admission. This does not certify arbitrary unknown tokens safe.
 */
export async function readAtRestCredentialSpans(lines: readonly string[], site: string): Promise<void> {
  try {
    // Capture the complete array structurally. Its elements are independent
    // complete sources; each JSONL payload is admitted intact, never per window.
    let originals: readonly string[];
    try {
      const captured = captureOwnedJson(lines);
      if (!Array.isArray(captured) || captured.some((line) => typeof line !== 'string')) return;
      originals = captured as readonly string[];
    } catch { return; }
    const admitted = originals.map(admitLine).filter((line): line is AdmittedLine => line !== undefined);
    if (!admitted.some((line) => findCredentialCandidates(line.text).length > 0)) return;
    const authority = captureReadingAuthority(site, admitted.map((line) => line.redaction));
    await readAdmittedLines(admitted, site, authority);
  } catch { throw unavailable(); }
}

/** Project using only the caller's captured authority; a queued line cannot borrow a new runtime. */
function projectAtRestLine(line: string, authority?: JudgmentPortCapture, redaction?: ReturnType<typeof captureRedactionSource>): string {
  let text: string;
  try { text = redactIssuerCredentials(line); } catch { throw unavailable(); }
  const admitted = admitLine(line);
  let currentAuthority = authority;
  try { redaction?.assertCurrent(); } catch { currentAuthority = undefined; }
  let out = '';
  let cursor = 0;
  for (const candidate of findCredentialCandidates(text)) {
    if (admitted?.text === text && currentAuthority && remembered(admitted, candidate, currentAuthority) === true) continue;
    out += text.slice(cursor, candidate.start) + candidate.marker;
    cursor = candidate.end;
  }
  return out + text.slice(cursor);
}

/** Local issuer/profile protection plus candidate masking, retaining the JSONL schema. */
export function redactAtRestLine(line: string): string {
  let authority: JudgmentPortCapture | undefined;
  try { authority = captureJudgmentPort('runtime.at-rest.cached-projection'); } catch { /* No live proof: mask. */ }
  return projectAtRestLine(line, authority);
}

/** Forgets readings and prevents an older in-flight result from repopulating them. */
export function clearAtRestCredentialReadings(): void {
  readingGeneration += 1;
  spanReadings.clear();
  spanReadsInFlight.clear();
}

/** Ordered writer: capture source and reading authority when the line is queued. */
export class AtRestLineWriter {
  readonly #site: string;
  #tail: Promise<void> | null = null;

  constructor(site: string) { this.#site = site; }

  write(line: string, append: (redacted: string) => void): void {
    const admitted = admitLine(line);
    let authority: JudgmentPortCapture | undefined;
    if (admitted && findCredentialCandidates(admitted.text).length > 0) {
      try { authority = captureReadingAuthority(this.#site, [admitted.redaction]); } catch { /* Unavailable: keep unread spans masked. */ }
    }
    const needsReading = admitted !== undefined && authority !== undefined && unreadCandidates(admitted, authority).length > 0;
    if (this.#tail === null && !needsReading) {
      append(projectAtRestLine(line, authority, admitted?.redaction));
      return;
    }
    const previous = this.#tail ?? Promise.resolve();
    const next = previous
      .then(async () => {
        if (needsReading && admitted && authority) await readAdmittedLines([admitted], this.#site, authority);
      })
      .catch(() => {
        // Value-free, nonrecursive failure: no error-display reading or borrowed error fields.
        try { logger.warn('[at-rest] credential span reading failed; unread spans are masked'); } catch { /* Diagnostics are best effort. */ }
      })
      .then(() => append(projectAtRestLine(line, authority, admitted?.redaction)))
      .catch(() => {
        try { logger.warn('[at-rest] writing a queued line failed'); } catch { /* Diagnostics are best effort. */ }
      });
    this.#tail = next;
    void next.then(() => { if (this.#tail === next) this.#tail = null; });
  }

  async flush(): Promise<void> {
    while (this.#tail !== null) await this.#tail;
  }
}

export interface RetentionOutcome {
  readonly deletedFiles: readonly string[];
  readonly reclaimedBytes: number;
}

/**
 * Enforce the age + total-size caps over a set of append-only files, deleting
 * oldest-first. Missing files are skipped. Deletion failures are swallowed
 * (best-effort gc must never break the write path) but excluded from the
 * reclaimed total. Returns what was reclaimed for the caller to log.
 */
export function enforceFileRetention(files: readonly string[], policy: AtRestPolicy): RetentionOutcome {
  const now = Date.now();
  const stats: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const path of files) {
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      stats.push({ path, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // Missing / unreadable file, nothing to retain.
    }
  }

  const deleted: string[] = [];
  let reclaimed = 0;
  const remove = (entry: { path: string; size: number }): void => {
    try {
      unlinkSync(entry.path);
      deleted.push(entry.path);
      reclaimed += entry.size;
    } catch {
      // Best-effort: a file we cannot delete is left in place.
    }
  };

  // Age cap: drop anything older than maxAgeMs.
  const survivors: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const entry of stats) {
    if (now - entry.mtimeMs > policy.retention.maxAgeMs) remove(entry);
    else survivors.push(entry);
  }

  // Size cap: oldest-first until the surviving set is under the byte budget.
  survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = survivors.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of survivors) {
    if (total <= policy.retention.maxTotalBytes) break;
    remove(entry);
    total -= entry.size;
  }

  return { deletedFiles: deleted, reclaimedBytes: reclaimed };
}

/**
 * Enforce retention over every `*.jsonl` transcript-journal file in a directory
 * (the per-agent `<agentId>.jsonl` logs). A convenience wrapper over
 * enforceFileRetention that resolves the directory listing; a missing directory
 * is a no-op.
 */
export function enforceJournalDirectoryRetention(dir: string, policy: AtRestPolicy): RetentionOutcome {
  if (!existsSync(dir)) return { deletedFiles: [], reclaimedBytes: 0 };
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return { deletedFiles: [], reclaimedBytes: 0 };
  }
  return enforceFileRetention(names.map((name) => join(dir, name)), policy);
}
