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
      ? value.trim().replace(/^[-*]\s+/, '').split('|').map((part) => part.trim()).filter((part) => /^https?:/i.test(part))
      : value && typeof value === 'object' && !Array.isArray(value)
        ? [(value as Record<string, unknown>).url]
        : [];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      const url = candidate.trim();
      // Contiguous candidates already reach citationUrl intact. These are the
      // declared references whose exact identity a prose delimiter would lose.
      if (/[\s<>|]/.test(url) && citationUrl(url) === WITHHELD_URL) urls.add(url);
    }
  }
  if (urls.size === 0) return undefined;
  const literals = [...urls].sort((left, right) => right.length - left.length)
    .map((url) => url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  try { return new RegExp(literals.join('|'), 'g'); }
  catch { throw new Error('Research source aliases could not be prepared before transmission.'); }
}

/**
 * A control-separated query/fragment continuation is malformed URI syntax,
 * regardless of parameter names. A URL followed by normal line-delimited prose
 * or a separate URL is not such a continuation. Never emit a repaired prefix.
 */
function hasControlSplitReference(text: string): boolean {
  const urls = /https?:[^\s<>|]*/gi;
  const controls = /[\t\r\n\f\v]+/y;
  const token = /[^\s<>|]+/y;
  for (let match = urls.exec(text); match; match = urls.exec(text)) {
    let cursor = urls.lastIndex;
    const chunks: string[] = [];
    while (cursor < text.length) {
      controls.lastIndex = cursor;
      if (!controls.exec(text)) break;
      const start = controls.lastIndex;
      token.lastIndex = start;
      const next = token.exec(text);
      if (!next) break;
      const separateUrl = next[0].search(/https?:/i);
      if (separateUrl >= 0) {
        chunks.push(next[0].slice(0, separateUrl));
        cursor = start + separateUrl;
        break;
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(next[0])) break;
      chunks.push(next[0]);
      cursor = token.lastIndex;
    }
    const continuation = chunks.join('');
    if (/[?&#][^?&#]/.test(continuation)
      || (/[?&#]$/.test(match[0]) && continuation.length > 0)
      || (/[?#]/.test(match[0]) && /[=&]/.test(continuation))) return true;
    // All inspected chunks are URL-free; avoid repeatedly scanning long prose.
    urls.lastIndex = Math.max(urls.lastIndex, cursor);
  }
  return false;
}

/** Also contain URL aliases in names, notes and URL-derived fallback titles. */
function sourceText(value: unknown, omittedReferences?: RegExp): string {
  if (typeof value !== 'string') return '';
  const text = omittedReferences ? value.trim().replace(omittedReferences, WITHHELD_URL) : value.trim();
  if (hasControlSplitReference(text)) return WITHHELD_URL;
  let unboundOmission = false;
  const projected = text.replace(/https?:[^\s<>|]*/gi, (candidate) => {
    const url = citationUrl(candidate);
    if (url === WITHHELD_URL) unboundOmission = true;
    return url;
  });
  // Known reference spans have already been removed completely, so retain their
  // surrounding prose. An unbound malformed candidate still withholds the field
  // rather than retaining an unparsed tail that may contain protected material.
  return unboundOmission ? WITHHELD_URL : projected;
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
