/**
 * Deterministic structural intake helpers for Node/Bun hosts.
 *
 * Ported from goodvibes-daemon mapping.ts at 254699bf5d834cdca41436211ada1ae32bf89258.
 * These helpers do not redact personal data or credentials, impose preview
 * budgets, validate HTML, or authorize disclosure. See docs/contracts/intake-text-normalization.md.
 */
import { createHash } from 'node:crypto';

/** First `hexChars` hexadecimal characters of the UTF-8 SHA-256 digest. */
export function sha256First(input: string, hexChars: number): string {
  const digest = createHash('sha256').update(input, 'utf-8').digest('hex');
  return digest.slice(0, Math.max(0, hexChars));
}

/** Stable 16-hex-character sender token; not an anonymization guarantee. */
export function digestSender(senderExternalId: string): string {
  return sha256First(senderExternalId, 16);
}

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
};

function isMultipart(text: string): boolean {
  return /^--[^\r\n]+\r?\n/m.test(text) && /content-type:/i.test(text);
}

/** Retain upstream first-plain, first-HTML, original-text fallback order. */
function extractMimePart(text: string): string {
  const boundaryMatch = /^--([^\r\n]+?)(?:--)?\r?$/m.exec(text);
  if (!boundaryMatch) return text;
  const boundary = boundaryMatch[1]!;
  const parts = text.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?\r?\n?`));
  let htmlPart: string | undefined;
  for (const rawPart of parts) {
    const split = /\r?\n\r?\n/.exec(rawPart);
    if (!split) continue;
    const headers = rawPart.slice(0, split.index);
    const body = rawPart.slice(split.index + split[0].length);
    const ctype = /content-type:\s*([^\r\n;]+)/i.exec(headers)?.[1]?.trim().toLowerCase();
    if (!ctype) continue;
    if (ctype === 'text/plain') return body.trim();
    if (ctype === 'text/html' && htmlPart === undefined) htmlPart = body;
  }
  return (htmlPart ?? text).trim();
}

function stripMimeHeaders(text: string): string {
  return text.replace(
    /^(?:content-type|content-transfer-encoding|content-disposition|content-id|mime-version|--[^\r\n]+)\b[^\r\n]*\r?\n/gim,
    '',
  );
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&apos;|&nbsp;/gi, (match) => HTML_ENTITIES[match.toLowerCase()] ?? match)
    .replace(/&#(\d{1,7});/g, (match: string, decimal: string) => {
      const code = Number.parseInt(decimal, 10);
      // A decimal entity denotes a Unicode scalar, never a surrogate or an
      // out-of-range code point. Keep invalid input literal instead of throwing.
      return code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
        ? String.fromCodePoint(code)
        : match;
    });
}

/**
 * De-structure supported MIME/HTML into text, retaining the upstream grammar.
 * Prefer a multipart plain part, then HTML, then original input; remove MIME
 * header lines, complete script/style blocks and tags, then decode the small
 * named-entity set and valid decimal Unicode scalar entities.
 * This is neither a complete MIME parser nor a privacy/HTML sanitizer.
 */
export function stripMarkup(input: string): string {
  let text = input;
  if (isMultipart(text)) text = extractMimePart(text);
  text = stripMimeHeaders(text);
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  if (/<[a-z!/][^>]*>/i.test(text)) {
    text = text
      .replace(/<\/?(?:br|p|div|tr|li|h[1-6]|table|ul|ol|blockquote|hr)\b[^>]*>/gi, ' ')
      .replace(/<[^>]+>/g, '');
  }
  return decodeEntities(text);
}

/** Collapse JavaScript whitespace runs and trim the result. No length cap. */
export function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}
