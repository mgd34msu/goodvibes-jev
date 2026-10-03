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

/** Also contain URL aliases in names, notes and URL-derived fallback titles. */
function sourceText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (/^https?:/i.test(text)) return citationUrl(text);
  const projected = text.replace(/https?:[^\s<>|]*/gi, citationUrl);
  // A malformed candidate can contain whitespace or quoting. Never retain an
  // unparsed tail in an alias after withholding just the recognized prefix.
  return projected.includes(WITHHELD_URL) ? WITHHELD_URL : projected;
}

function source(value: unknown): AgentResearchReportSource | null {
  if (typeof value === 'string') {
    // Parse the declared pipe-delimited syntax, then contain every field before
    // choosing a fallback. No fallback ever reads the original source string.
    const parts = value.trim().replace(/^[-*]\s+/, '').split('|').map(sourceText).filter(Boolean);
    if (!parts.length) return null;
    const urlIndex = parts.findIndex((part) => /^https?:\/\//i.test(part) || part === WITHHELD_URL);
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
  const title = sourceText(record.title) || sourceText(record.name) || url;
  if (!title) return null;
  const credibility = sourceText(record.credibility) || 'unreviewed';
  const metadata: Record<string, string> = {};
  for (const key of ['publisher', 'publishedAt', 'accessedAt', 'note']) {
    const text = sourceText(record[key]);
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
  const sources = Object.freeze(raw.map(source).filter((entry): entry is AgentResearchReportSource => entry !== null).slice(0, 50));
  const prepared = Object.freeze({ ...captured, sources });
  // Revalidate projection without presentation caps; no semantic approval is
  // invented here, and no raw credential is sent for a judgment.
  return snapshotJudgmentInput(prepared, 'agent_research_report') as Omit<T, 'sources'> & {
    readonly sources: readonly AgentResearchReportSource[];
  };
}
