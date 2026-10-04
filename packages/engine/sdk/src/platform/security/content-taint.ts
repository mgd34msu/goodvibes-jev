/**
 * content-taint.ts, does THIS outward action's content derive from something
 * a stranger wrote?
 *
 * ── Why the question has to be this precise ───────────────────────────────
 *
 * The coarse question, "has this process read anything untrusted?", is
 * useless in a daemon. A daemon reads mail and pages continuously, so the
 * coarse answer is permanently yes, and a boundary that is permanently
 * tripped gets replaced by a disclosure nobody reads. That is exactly what
 * happened: the daemon ended up *reporting* untrusted exposure on a send
 * receipt while a product with a human attached *refused* the send. The
 * unattended surface was the most permissive one, which is backwards, an
 * unattended daemon is where a prompt injection pays off best, because there
 * is nobody to notice.
 *
 * So the question asked here is narrow and answerable: does the CONTENT of
 * this specific outward action derive from untrusted input? A scheduled report
 * that queries a database and mails a summary derives from nothing a stranger
 * wrote and proceeds. A send whose recipient, subject or body carries text that
 * came out of a page or a mailbox is refused, on every surface, daemon
 * included.
 *
 * ── How derivation is decided ─────────────────────────────────────────────
 *
 * By Jev, reading each outgoing field against each piece of untrusted text
 * actually read (`engine.security.content-derivation`), not by provenance
 * bookkeeping the caller could forget to thread. The reading asks whether the
 * field carries an instruction, claim or specific value from the source, and
 * whether all they share is boilerplate that unrelated senders all carry. It
 * replaces the fixed thresholds this module used to apply (8 shared words, a
 * 40 character shared span, a span seen in 2 origins counting as boilerplate,
 * and regexes for where a reply's quoted text starts).
 *
 * A field is clean against a source only on a confident "does not derive" or
 * a confident "only boilerplate in common". Anything less is a finding, which
 * refuses the action until the owner approves it, because a wrong clean lets
 * a stranger decide what leaves the machine and a wrong finding costs one
 * approval.
 *
 * Recipient-style fields (`exactMatchFields`) are first tested by exact
 * containment: an address that appears verbatim in untrusted text is present
 * there, and that needs no reading. A value not found verbatim still gets the
 * derivation reading, so an address assembled from pieces of a message is
 * caught too.
 */

import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { JudgmentError, mapLimit, type JudgmentPort } from '@goodvibes-jev/judgment';
import { executePolicyCheck } from '../gate/execute-policy-check.js';
import { contentDerivation, derivationView } from './batteries/content-derivation.js';

/** The decision site the derivation reading is logged under. */
export const CONTENT_DERIVATION_SITE = 'security.content-taint';

/** How many (field, source) readings run at once. */
const DERIVATION_CONCURRENCY = 4;

/** Untrusted text retained for comparison, with where it came from. */
export interface TaintSource {
  readonly surface: string;
  readonly origin: string;
  readonly text: string;
}

export interface TaintOptions {
  /** Cancels pending derivation and prevents queued readings or late action records. */
  readonly signal?: AbortSignal | undefined;
  /**
   * Fields first tested by EXACT CONTAINMENT.
   *
   * A recipient address is short and high-signal: the whole value IS the
   * payload, so its verbatim presence in untrusted text is a finding without
   * any reading. A value not found verbatim still gets the derivation reading.
   */
  readonly exactMatchFields?: readonly string[] | undefined;
  /**
   * Recipients that are allowed even when they appear in untrusted text.
   *
   * Exactly one case: replying to where a message actually came from. The
   * address must be established from DELIVERY EVIDENCE, the envelope sender,
   * and never from a `From:` header, which the sender writes. Without this,
   * every legitimate auto-reply is refused, because the address it replies to
   * is by definition present in the message it answers.
   */
  readonly replyToEnvelopeSenders?: readonly string[] | undefined;
  /**
   * Fields that are replies, whose quoted copy of the message being answered
   * is context rather than derivation.
   *
   * A reply that quotes the message it answers repeats it verbatim by design.
   * The derivation reading for these fields leaves the quoted copy out and
   * asks only about what the sender wrote themselves.
   */
  readonly stripQuotedFields?: readonly string[] | undefined;
}

export interface TaintFinding {
  /** Which outward field carried it, 'body', 'subject', 'to', … */
  readonly field: string;
  readonly surface: string;
  readonly origin: string;
  /**
   * The outgoing text in question, truncated: the address found verbatim, or
   * the start of the field Jev read as derived. Included so a refusal can SHOW
   * the operator what was refused rather than assert it.
   */
  readonly excerpt: string;
  /** `exact-value`: found verbatim in the source; `derived`: Jev read it as derived from the source. */
  readonly kind: 'exact-value' | 'derived';
}

function normalizeSpan(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function truncate(value: string, limit = 120): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/** Normalized recipient address, for exact containment. */
function normalizeAddress(value: string): string {
  const trimmed = value.trim();
  const angled = /<([^<>]+)>\s*$/.exec(trimmed);
  return (angled?.[1] ?? trimmed).replace(/^<|>$/g, '').trim().toLowerCase();
}

/**
 * The exact-containment half on its own: every `exactMatchFields` field whose
 * normalized value appears verbatim in a source, skipping replies to an
 * envelope sender. Code, because identical characters being present is not a
 * question of meaning.
 *
 * Safe over a wide window (every retained source) where the derivation
 * reading is not: a value found verbatim in something a stranger wrote is not
 * a coincidence however long ago it was read.
 */
export function findExactContainment(
  fields: Readonly<Record<string, string | undefined>>,
  sources: readonly TaintSource[],
  options: TaintOptions = {},
): readonly TaintFinding[] {
  const findings: TaintFinding[] = [];
  if (sources.length === 0) return findings;
  const allowedReplies = new Set((options.replyToEnvelopeSenders ?? []).map(normalizeAddress));
  for (const field of options.exactMatchFields ?? []) {
    const raw = fields[field];
    if (raw === undefined || raw.trim().length === 0) continue;
    const address = normalizeAddress(raw);
    if (address.length === 0 || allowedReplies.has(address)) continue;
    const hit = sources.find((source) => normalizeSpan(source.text).includes(address));
    if (hit === undefined) continue;
    findings.push({ field, surface: hit.surface, origin: hit.origin, excerpt: truncate(address), kind: 'exact-value' });
  }
  return findings;
}

/**
 * Whether one field reads as derived from one source. Clean only on a
 * confident no to the derivation question or a confident yes to the
 * boilerplate question; the reading's outcome is recorded with what was done.
 */
async function readsAsDerived(field: string, text: string, source: TaintSource, reply: boolean, signal?: AbortSignal): Promise<boolean> {
  assertTaintActive(signal);
  const derivationItem = reply ? 'reply_derives' : 'derives';
  const run = await contentDerivation.run(taintPort(signal), derivationView(field, text, source), {
    site: CONTENT_DERIVATION_SITE,
    only: [derivationItem, 'boilerplate_only'],
    ...(signal === undefined ? {} : { signal }),
  });
  assertTaintActive(signal);
  const derives = run.readings[derivationItem];
  const boilerplate = run.readings.boilerplate_only;
  const clean = (derives.verdict === 'no' && derives.outcome === 'act')
    || (boilerplate.verdict === 'yes' && boilerplate.outcome === 'act');
  run.recordAction(clean ? 'clean' : 'finding');
  return !clean;
}

/**
 * Find every field of an outward action whose content derives from untrusted
 * input.
 *
 * `fields` is a record of the caller's own field names to their values, so a
 * refusal names the field an operator would recognise ("body", "subject")
 * rather than an index. At most one finding per field: the exact match when
 * there is one, else the first source (in the order given) the field reads as
 * derived from.
 */
export async function findContentTaint(
  fields: Readonly<Record<string, string | undefined>>,
  sources: readonly TaintSource[],
  options: TaintOptions = {},
): Promise<readonly TaintFinding[]> {
  assertTaintActive(options.signal);
  if (sources.length === 0) return [];
  const exact = findExactContainment(fields, sources, options);
  const settled = new Set(exact.map((finding) => finding.field));
  const allowedReplies = new Set((options.replyToEnvelopeSenders ?? []).map(normalizeAddress));
  const exactFields = new Set(options.exactMatchFields ?? []);
  const replyFields = new Set(options.stripQuotedFields ?? []);

  const pairs: { readonly field: string; readonly text: string; readonly source: TaintSource }[] = [];
  for (const [field, text] of Object.entries(fields)) {
    if (text === undefined || text.trim().length === 0 || settled.has(field)) continue;
    // Replying to where a message actually came from is the one allowed use
    // of an address that appears in it.
    if (exactFields.has(field) && allowedReplies.has(normalizeAddress(text))) continue;
    for (const source of sources) {
      if (source.text.trim().length > 0) pairs.push({ field, text, source });
    }
  }

  const derived = await mapLimit(pairs, DERIVATION_CONCURRENCY, (pair) =>
    readsAsDerived(pair.field, pair.text, pair.source, replyFields.has(pair.field), options.signal));
  assertTaintActive(options.signal);

  const findings: TaintFinding[] = [...exact];
  pairs.forEach((pair, index) => {
    if (!derived[index] || settled.has(pair.field)) return;
    settled.add(pair.field);
    findings.push({
      field: pair.field,
      surface: pair.source.surface,
      origin: pair.source.origin,
      excerpt: truncate(pair.text.trim()),
      kind: 'derived',
    });
  });
  // Report in the caller's field order.
  const order = Object.keys(fields);
  return findings.sort((a, b) => order.indexOf(a.field) - order.indexOf(b.field));
}

/**
 * The refusal an operator reads.
 *
 * Names the field, the surface and the origin, and shows the text in
 * question, because "refused: untrusted content" with no evidence is
 * indistinguishable from a bug and gets worked around.
 */
export function describeContentTaint(action: string, findings: readonly TaintFinding[]): string {
  const first = findings[0];
  if (first === undefined) return `${action} was refused.`;
  const fields = [...new Set(findings.map((finding) => finding.field))].join(', ');
  const evidence = first.kind === 'exact-value'
    ? `"${first.excerpt}" appears word for word in it.`
    : `The text in question is "${first.excerpt}".`;
  return (
    `Refused ${action}: its ${fields} derives from content read from ${first.surface} `
    + `(${first.origin}), which anyone can write. ${evidence} `
    + 'Content that arrived from outside cannot decide what leaves this machine. '
    + 'Compose the message from your own instruction instead, or send it yourself.'
  );
}


function assertTaintActive(signal?: AbortSignal): void {
  // Abort reasons are caller-controlled and may contain protected text.
  if (signal?.aborted) throw new JudgmentError('aborted', 'the judgment call was cancelled');
}

function taintPort(signal?: AbortSignal): JudgmentPort {
  assertTaintActive(signal);
  const port = judgmentPort(CONTENT_DERIVATION_SITE);
  if (!signal) return port;
  const recorder = port.recorder;
  return {
    get model() { return port.model; },
    ...(recorder === undefined ? {} : { recorder: {
      recordReadings(id, readings) { assertTaintActive(signal); recorder.recordReadings(id, readings); },
      recordAction(id, action) { assertTaintActive(signal); recorder.recordAction(id, action); },
    } satisfies JudgmentPort['recorder'] }),
    ...(port.health === undefined ? {} : { health: () => port.health!() }),
    async ask(request) {
      try {
        const result = await executePolicyCheck(() => port.ask(request), signal);
        assertTaintActive(signal);
        return result;
      } catch (error) {
        assertTaintActive(signal);
        throw error;
      }
    },
  };
}
