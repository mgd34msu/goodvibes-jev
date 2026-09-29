/**
 * page-blocks.ts, an HTML page carved into the text units Jev reads for the
 * fetch tool's `readable` and `summary` modes (fetch/page-reading.ts).
 *
 * Nothing here decides what is content. It follows the HTML grammar only:
 * the document head, comments, `script` and `style` are not rendered text;
 * block-level elements end one run of text and start the next; character
 * references decode to the characters they name. Every run keeps the path of
 * the grouping elements it sits in (tag, id and class, as written), which Jev
 * sees beside the text.
 */

/** Grouping elements: a run of text is keyed by the chain of these it sits in. */
const REGION_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'div', 'dl', 'fieldset', 'figure',
  'footer', 'form', 'header', 'main', 'menu', 'nav', 'ol', 'pre', 'section', 'table', 'ul',
]);

/** Block-level elements inside a region that end one run of text and start another. */
const UNIT_TAGS = new Set([
  'br', 'caption', 'dd', 'dt', 'figcaption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'legend', 'li',
  'p', 'summary', 'td', 'th', 'tr',
]);

const HEADING = /^h([1-6])$/;

/** Most characters of one element label (tag, id and classes) carried in a path. */
const MAX_LABEL_CHARS = 80;

/** One run of rendered text: its text, the region path it sits in, and its heading level when it is a heading. */
export interface PageUnit {
  readonly text: string;
  readonly path: string;
  readonly headingLevel?: number | undefined;
}

/** Consecutive units in the same region, joined: one block for the readable reading. */
export interface PageBlock {
  readonly path: string;
  readonly text: string;
}

const NAMED_REFERENCES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', copy: '\u00a9', reg: '\u00ae', trade: '\u2122',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', laquo: '\u00ab', raquo: '\u00bb',
  middot: '\u00b7', bull: '\u2022', times: '\u00d7', deg: '\u00b0',
};

/** Decodes numeric character references and the common named ones. */
export function decodeCharacterReferences(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_REFERENCES[ref.toLowerCase()] ?? match;
  });
}

/** The text of the document's `<title>`, or empty. */
export function pageTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? decodeCharacterReferences(match[1]!.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : '';
}

/** The rendered part of the document: the body when one is written, without comments, scripts and styles. */
function renderedMarkup(html: string): string {
  const withoutHidden = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<head[\s>][\s\S]*?<\/head>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
  const body = /<body[^>]*>([\s\S]*?)(?:<\/body>|$)/i.exec(withoutHidden);
  return body ? body[1]! : withoutHidden;
}

function elementLabel(tag: string, attributes: string): string {
  const id = /\bid\s*=\s*["']([^"']*)["']/i.exec(attributes)?.[1]?.trim();
  const classes = /\bclass\s*=\s*["']([^"']*)["']/i.exec(attributes)?.[1]?.trim().split(/\s+/).filter(Boolean) ?? [];
  const label = `${tag}${id ? `#${id}` : ''}${classes.map((name) => `.${name}`).join('')}`;
  return label.length <= MAX_LABEL_CHARS ? label : `${label.slice(0, MAX_LABEL_CHARS)}...`;
}

const TOKEN = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)|</g;

/** The page's runs of rendered text, in document order. */
export function pageUnits(html: string): PageUnit[] {
  const units: PageUnit[] = [];
  const regions: { readonly tag: string; readonly label: string }[] = [];
  let text = '';
  let headingLevel: number | undefined;

  const flush = (): void => {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (cleaned) {
      const path = regions.length > 0 ? regions.map((region) => region.label).join(' > ') : 'body';
      units.push({ text: cleaned, path, ...(headingLevel === undefined ? {} : { headingLevel }) });
    }
    text = '';
    headingLevel = undefined;
  };

  for (const match of renderedMarkup(html).matchAll(TOKEN)) {
    const [, closing, rawTag, attributes, run] = match;
    if (rawTag === undefined) {
      text += decodeCharacterReferences(run ?? match[0]);
      continue;
    }
    const tag = rawTag.toLowerCase();
    const isRegion = REGION_TAGS.has(tag);
    if (!isRegion && !UNIT_TAGS.has(tag)) {
      text += ' ';
      continue;
    }
    flush();
    const heading = HEADING.exec(tag);
    if (heading && !closing) headingLevel = Number(heading[1]);
    if (!isRegion) continue;
    if (!closing && !(attributes ?? '').trimEnd().endsWith('/')) {
      regions.push({ tag, label: elementLabel(tag, attributes ?? '') });
      continue;
    }
    if (closing) {
      const open = regions.map((region) => region.tag).lastIndexOf(tag);
      if (open >= 0) regions.length = open;
    }
  }
  flush();
  return units;
}

/** Consecutive units that share a region path, joined line by line. */
export function pageBlocks(units: readonly PageUnit[]): PageBlock[] {
  const blocks: { path: string; lines: string[] }[] = [];
  for (const unit of units) {
    const last = blocks[blocks.length - 1];
    if (last && last.path === unit.path) last.lines.push(unit.text);
    else blocks.push({ path: unit.path, lines: [unit.text] });
  }
  return blocks.map(({ path, lines }) => ({ path, text: lines.join('\n') }));
}
