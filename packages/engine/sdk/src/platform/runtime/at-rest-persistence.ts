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
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { findCredentialCandidates, redactIssuerCredentials, type CredentialCandidate } from '../utils/redaction.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
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

/**
 * Remembered readings, keyed by a SHA-256 of the span so the process never
 * keeps a table of plaintext credentials: true when the span read as not a
 * credential (kept in the clear), false when it read as one or the reading
 * was uncertain (masked).
 */
const spanReadings = new Map<string, boolean>();
const spanReadsInFlight = new Map<string, Promise<void>>();

const spanKey = (value: string): string => createHash('sha256').update(value).digest('hex');

function rememberSpan(key: string, clear: boolean): void {
  if (spanReadings.size >= REMEMBERED_SPAN_LIMIT && !spanReadings.has(key)) {
    spanReadings.delete(spanReadings.keys().next().value!);
  }
  spanReadings.set(key, clear);
}

/** The candidate spans in `text` that have no remembered reading, one per distinct value. */
function unreadCandidates(text: string): CredentialCandidate[] {
  const seen = new Set<string>();
  return findCredentialCandidates(text).filter((candidate) => {
    const key = spanKey(candidate.value);
    if (spanReadings.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readSpan(candidate: CredentialCandidate, text: string, site: string): Promise<void> {
  const key = spanKey(candidate.value);
  const inFlight = spanReadsInFlight.get(key);
  if (inFlight) return inFlight;
  const read = (async (): Promise<void> => {
    const state = {
      span: candidate.value,
      context: text.slice(Math.max(0, candidate.start - CANDIDATE_CONTEXT_CHARS), candidate.end + CANDIDATE_CONTEXT_CHARS),
    };
    const run = await atRestCredential.run(judgmentPort(site), state, { site });
    // Critical band: a no verdict needs 0.9 confidence. Anything else masks.
    const clear = run.readings.credential.verdict === 'no';
    run.recordAction(clear ? 'keep' : 'mask');
    rememberSpan(key, clear);
  })();
  spanReadsInFlight.set(key, read);
  void read.then(
    () => spanReadsInFlight.delete(key),
    () => spanReadsInFlight.delete(key),
  );
  return read;
}

/**
 * Reads every candidate span in `lines` that has no remembered reading and
 * remembers the answers, so {@link redactAtRestLine} can apply them. Rejects
 * when a reading cannot be made (no port installed, a port error); the spans
 * it did not read stay unread, and so masked.
 */
export async function readAtRestCredentialSpans(lines: readonly string[], site: string): Promise<void> {
  const work: Array<{ candidate: CredentialCandidate; text: string }> = [];
  const keys = new Set<string>();
  for (const line of lines) {
    const text = redactIssuerCredentials(line);
    for (const candidate of unreadCandidates(text)) {
      const key = spanKey(candidate.value);
      if (keys.has(key)) continue;
      keys.add(key);
      work.push({ candidate, text });
    }
  }
  await mapLimit(work, CANDIDATE_READ_CONCURRENCY, ({ candidate, text }) => readSpan(candidate, text, site));
}

/**
 * Mask profile values, issuer-reserved credential formats and candidate spans
 * in a serialized JSON line. A candidate span stays in the clear only when
 * `engine.runtime.at-rest-credential` read it as not a credential; an unread
 * span is masked. Credentials only: no home-path anonymisation, because this
 * file never leaves the machine. The markers are JSON-safe, so the result stays
 * a valid, parseable line.
 */
export function redactAtRestLine(line: string): string {
  const text = redactIssuerCredentials(line);
  let out = '';
  let cursor = 0;
  for (const candidate of findCredentialCandidates(text)) {
    if (spanReadings.get(spanKey(candidate.value)) === true) continue;
    out += text.slice(cursor, candidate.start) + candidate.marker;
    cursor = candidate.end;
  }
  return out + text.slice(cursor);
}

/** Forgets every remembered span reading (tests). */
export function clearAtRestCredentialReadings(): void {
  spanReadings.clear();
}

/**
 * Keeps an append-only file's lines in order while the candidate spans in a
 * line are read. A line with no unread candidate and nothing queued ahead of it
 * is written at once, as before; any other line waits for the lines ahead of it
 * and for its own readings. When a reading cannot be made the failure is logged
 * and the line is written with its unread spans masked.
 */
export class AtRestLineWriter {
  readonly #site: string;
  #tail: Promise<void> | null = null;

  constructor(site: string) {
    this.#site = site;
  }

  /** Redact `line` and hand it to `append`, which handles its own write errors. */
  write(line: string, append: (redacted: string) => void): void {
    if (this.#tail === null && unreadCandidates(redactIssuerCredentials(line)).length === 0) {
      append(redactAtRestLine(line));
      return;
    }
    const previous = this.#tail ?? Promise.resolve();
    const next = previous
      .then(() => readAtRestCredentialSpans([line], this.#site))
      .catch((error: unknown) => {
        logger.warn('[at-rest] credential span reading failed; unread spans are masked', {
          site: this.#site,
          error: summarizeError(error),
        });
      })
      .then(() => append(redactAtRestLine(line)))
      .catch((error: unknown) => {
        logger.warn('[at-rest] writing a queued line failed', { site: this.#site, error: summarizeError(error) });
      });
    this.#tail = next;
    void next.then(() => {
      if (this.#tail === next) this.#tail = null;
    });
  }

  /** Resolves once every queued line has been written. */
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
