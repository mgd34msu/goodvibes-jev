/** Structural HTML parsing is optional; all main-content and title choices use Jev. */
import { assertJudgmentInput } from '../gate/judgment-input.js';
import { decodeCharacterReferences, pageTitle } from '../tools/fetch/page-blocks.js';
import { loadOptionalDependency } from '../utils/optional-dependency.js';
import { selectHtmlContent } from './html-content-selection.js';

export interface ReadableHtmlExtraction {
  readonly title?: string | undefined;
  readonly byline?: string | undefined;
  readonly siteName?: string | undefined;
  readonly excerpt?: string | undefined;
  readonly textContent: string;
  readonly length: number;
  readonly links: readonly string[];
  readonly headings: readonly string[];
  readonly paragraphSamples: readonly string[];
}

/** Whether the optional DOM parser is available; the lightweight parser uses the same judgments. */
export interface HtmlReadabilityAvailability {
  readonly available: boolean;
  readonly reason?: string;
}

const HTML_PARSE_LIMIT_BYTES = 5 * 1024 * 1024;
type JsdomModule = typeof import('jsdom');
interface ReadabilityToolchain { readonly JSDOM: JsdomModule['JSDOM'] }
type ReadabilityToolchainLoad =
  | { readonly available: true; readonly toolchain: ReadabilityToolchain }
  | { readonly available: false; readonly reason: string };

/** Load only a structural parser, never Mozilla's density/keyword article classifier. */
export async function loadHtmlReadabilityToolchain(): Promise<ReadabilityToolchainLoad> {
  const jsdom = await loadOptionalDependency('jsdom', () => import('jsdom'));
  return jsdom.available
    ? { available: true, toolchain: { JSDOM: jsdom.module.JSDOM } }
    : { available: false, reason: jsdom.reason };
}

export async function describeHtmlReadabilityAvailability(): Promise<HtmlReadabilityAvailability> {
  const loaded = await loadHtmlReadabilityToolchain();
  return loaded.available ? { available: true } : { available: false, reason: loaded.reason };
}

function normalizeText(value: string | undefined | null): string {
  return (value ?? '').replace(/\u0000/g, ' ').replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

function uniqueText(values: Iterable<string>, limit: number): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const cleaned = normalizeText(value);
    if (cleaned) seen.add(cleaned);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

function truncateHtml(html: string): string {
  return Buffer.byteLength(html, 'utf8') <= HTML_PARSE_LIMIT_BYTES ? html : html.slice(0, HTML_PARSE_LIMIT_BYTES);
}

/** Null means no main content, or no optional DOM parser. Judgment holds always throw. */
export async function extractReadableHtml(html: string): Promise<ReadableHtmlExtraction | null> {
  assertJudgmentInput(html);
  const loaded = await loadHtmlReadabilityToolchain();
  if (!loaded.available) return null;
  const dom = new loaded.toolchain.JSDOM(truncateHtml(html), { contentType: 'text/html', includeNodeLocations: false, pretendToBeVisual: false });
  try {
    const document = dom.window.document;
    document.querySelectorAll('script, style, noscript, iframe, template, svg, canvas').forEach((node) => node.remove());
    const metadataTitles = Array.from(document.querySelectorAll('meta[property="og:title"], meta[name="twitter:title"]'), (node) => node.getAttribute('content') ?? '');
    const selected = await selectHtmlContent(document.documentElement.outerHTML, document.title, metadataTitles);
    if (!selected) return null;
    const byline = normalizeText(document.querySelector('meta[name="author"]')?.getAttribute('content'));
    const siteName = normalizeText(document.querySelector('meta[property="og:site_name"]')?.getAttribute('content'));
    return {
      ...selected,
      ...(byline ? { byline } : {}),
      ...(siteName ? { siteName } : {}),
      length: selected.textContent.length,
      links: uniqueText(Array.from(document.querySelectorAll('a[href]'), (node) => node.getAttribute('href') ?? ''), 80),
    };
  } finally { dom.window.close(); }
}

/** Parser fallback only: identical registered decisions and strict hold semantics. */
export async function extractLightweightReadableHtml(html: string): Promise<ReadableHtmlExtraction | null> {
  assertJudgmentInput(html);
  const markup = truncateHtml(html).replace(/<(script|style|noscript|iframe|template|svg|canvas)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const selected = await selectHtmlContent(markup, pageTitle(markup));
  if (!selected) return null;
  const links = uniqueText(Array.from(markup.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi), (match) => decodeCharacterReferences(match[1] ?? '')), 80);
  return { ...selected, length: selected.textContent.length, links };
}
