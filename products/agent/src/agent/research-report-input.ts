import { snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import { sanitizeResearchSourceUrl } from './research-source-registry.ts';

export interface AgentResearchReportSource {
  readonly title: string;
  readonly url?: string;
  readonly urlOmitted?: true;
  readonly publisher?: string;
  readonly publishedAt?: string;
  readonly accessedAt?: string;
  readonly credibility: string;
  readonly note?: string;
}

const WITHHELD_URL = '[source URL withheld]';

/** RFC 3986 sections 3.1/3.2: userinfo is delimited by @ inside //authority. */
function hasUriUserinfo(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+@/i.test(value);
}

function literalReferencePattern(value: string, foldCase = false): string {
  return [...value].map((character) => foldCase && /[a-z]/i.test(character)
    ? `[${character.toLowerCase()}${character.toUpperCase()}]`
    : character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
}

/** Fold ASCII case only in scheme and hostname, never userinfo, path or query text. */
function omittedReferencePattern(value: string): string {
  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(value)?.[0] ?? '';
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\\]*)/i.exec(value);
  if (!authority) return literalReferencePattern(scheme, true) + literalReferencePattern(value.slice(scheme.length));
  const authorityText = authority[1]!;
  const hostStart = authority[0].length - authorityText.length + authorityText.lastIndexOf('@') + 1;
  const hostAndPort = value.slice(hostStart, authority[0].length);
  const hostname = hostAndPort.startsWith('[')
    ? /^\[[^\]]*\]/.exec(hostAndPort)?.[0] ?? ''
    : hostAndPort.split(':', 1)[0]!;
  return literalReferencePattern(scheme, true)
    + literalReferencePattern(value.slice(scheme.length, hostStart))
    + literalReferencePattern(hostname, true)
    + literalReferencePattern(value.slice(hostStart + hostname.length));
}

/**
 * Preserve complete usable citations. Reuse the existing source-registry URL
 * sanitizer, rather than adding a second parameter-name heuristic. If that
 * compatibility sanitizer changes a reference, withhold it explicitly instead
 * of presenting the changed resource as equivalent. Userinfo and malformed URL
 * syntax are structural containment cases.
 *
 * The existing sanitizer is NOT a semantic credential decision: arbitrary
 * undeclared URL parameter roles need a protected, name-only Jev screening seam.
 * No such source-URL seam is currently exposed; never send raw values to Jev or
 * borrow a ledger/journal judgment as authority for citation transmission.
 */
function citationUrl(value: string): string {
  try {
    // WHATWG parsing repairs these malformed references (dropping controls,
    // treating backslashes as slashes, or supplying a missing authority). Do
    // not silently turn them into a different citation. Encoded characters,
    // ordinary canonicalization, queries and section anchors remain usable.
    if (/[\u0000-\u001f\u007f\\]/.test(value) || !/^https?:\/\/[^/\\]/i.test(value)) return WITHHELD_URL;
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return WITHHELD_URL;
    if (url.username || url.password) return WITHHELD_URL;
    const canonical = url.toString();
    return sanitizeResearchSourceUrl(canonical) === canonical ? canonical : WITHHELD_URL;
  } catch { return WITHHELD_URL; }
}

/** Keep complete omitted references before a prose tokenizer can split their controls. */
function omittedSourceReferences(values: readonly unknown[]): RegExp | undefined {
  const urls = new Set<string>();
  for (const value of values) {
    const candidates = typeof value === 'string'
      ? value.trim().replace(/^[-*]\s+/, '').split('|').map((part) => part.trim()).filter((part) => /^https?:/i.test(part) || hasUriUserinfo(part))
      : value && typeof value === 'object' && !Array.isArray(value)
        ? [(value as Record<string, unknown>).url]
        : [];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      const url = candidate.trim();
      // Contiguous candidates already reach citationUrl intact. These are the
      // declared references whose exact identity a prose delimiter would lose.
      if (/[\s<>"|]/.test(url) && citationUrl(url) === WITHHELD_URL) urls.add(url);
    }
  }
  if (urls.size === 0) return undefined;
  const literals = [...urls].sort((left, right) => right.length - left.length)
    .map(omittedReferencePattern);
  try { return new RegExp(literals.join('|'), 'g'); }
  catch { throw new Error('Research source aliases could not be prepared before transmission.'); }
}

/** Also contain URL aliases in names, notes and URL-derived fallback titles. */
function sourceText(value: unknown, omittedReferences?: RegExp): string {
  if (typeof value !== 'string') return '';
  const text = omittedReferences ? value.trim().replace(omittedReferences, WITHHELD_URL) : value.trim();
  // Prose whitespace is not URL provenance. In particular, never join lines
  // based on query-like punctuation or withhold their surrounding ordinary text.
  // Unbound control-split references need an explicit span/semantic screening
  // boundary; bounded tokens and aliases of declared references are handled here.
  // A literal scheme://authority gives userinfo a structural meaning without
  // guessing query-parameter roles. Keep benign non-HTTP references byte-for-byte;
  // no parser repair or whole-field omission is needed. Start once per scheme
  // run so a long ordinary word cannot cause quadratic candidate scanning.
  const projected = text.replace(/(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s<>"|]*/gi,
    (candidate) => !/^https?:/i.test(candidate) && hasUriUserinfo(candidate) ? WITHHELD_URL : candidate);
  return projected.replace(/https?:[^\s<>|]*/gi, (candidate) => citationUrl(candidate));
}

function source(value: unknown, omittedReferences?: RegExp): AgentResearchReportSource | null {
  if (typeof value === 'string') {
    // Parse the declared pipe-delimited syntax, then contain every field before
    // choosing a fallback. No fallback ever reads the original source string.
    const rawParts = value.trim().replace(/^[-*]\s+/, '').split('|').map((part) => part.trim()).filter(Boolean);
    if (!rawParts.length) return null;
    const rawUrlIndex = rawParts.findIndex((part) => /^https?:/i.test(part));
    const parts = rawParts.map((part, index) => index === rawUrlIndex ? citationUrl(part) : sourceText(part, omittedReferences));
    const urlIndex = rawUrlIndex >= 0 ? rawUrlIndex : parts.findIndex((part) => part === WITHHELD_URL);
    const url = urlIndex < 0 ? '' : parts[urlIndex]!;
    const detailStart = urlIndex < 0 ? 1 : urlIndex + 1;
    const title = urlIndex === 0 ? url : parts[0]!;
    return Object.freeze({
      title,
      ...(url && url !== WITHHELD_URL ? { url } : {}),
      ...(parts.some((part) => part.includes(WITHHELD_URL)) ? { urlOmitted: true as const } : {}),
      credibility: parts[detailStart] || 'unreviewed',
      ...(parts.length > detailStart + 1 ? { note: parts.slice(detailStart + 1).join(' | ') } : {}),
    });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? citationUrl(record.url.trim()) : '';
  const title = sourceText(record.title, omittedReferences) || sourceText(record.name, omittedReferences) || url;
  if (!title) return null;
  const credibility = sourceText(record.credibility, omittedReferences) || 'unreviewed';
  const metadata: Record<string, string> = {};
  for (const key of ['publisher', 'publishedAt', 'accessedAt', 'note']) {
    const text = sourceText(record[key], omittedReferences);
    if (text) metadata[key] = text;
  }
  return Object.freeze({
    title,
    ...(url && url !== WITHHELD_URL ? { url } : {}),
    ...metadata,
    ...(url === WITHHELD_URL || title.includes(WITHHELD_URL) || credibility.includes(WITHHELD_URL) || Object.values(metadata).some((text) => text.includes(WITHHELD_URL)) || record.urlOmitted === true ? { urlOmitted: true as const } : {}),
    credibility,
  });
}

/** Shared pre-transmission preparation for both workspace prompts and tool calls. */
export function prepareAgentResearchReportInput<T extends { readonly sources?: unknown }>(input: T): Omit<T, 'sources'> & {
  readonly sources: readonly AgentResearchReportSource[];
} {
  const captured = snapshotJudgmentInput(input, 'agent_research_report') as T;
  const raw = Array.isArray(captured.sources) ? captured.sources
    : typeof captured.sources === 'string' ? captured.sources.split(/\n/) : [];
  const omittedReferences = omittedSourceReferences(raw);
  const sources = Object.freeze(raw.map((entry) => source(entry, omittedReferences)).filter((entry): entry is AgentResearchReportSource => entry !== null).slice(0, 50));
  const prepared = Object.freeze({ ...captured, sources });
  // Revalidate projection without presentation caps; no semantic approval is
  // invented here, and no raw credential is sent for a judgment.
  return snapshotJudgmentInput(prepared, 'agent_research_report') as Omit<T, 'sources'> & {
    readonly sources: readonly AgentResearchReportSource[];
  };
}
