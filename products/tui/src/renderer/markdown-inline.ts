/**
 * markdown-inline.ts, inline markdown tokenizer (bold, italic, inline code,
 * links, bare URLs, absolute file paths).
 *
 * Extracted from markdown.ts so both the block renderer (markdown.ts) and the
 * table renderer (markdown-table.ts) can tokenize cell/line text without the
 * two modules importing each other. markdown.ts re-exports
 * renderInlineMarkdown so existing importers are unaffected.
 */

import type { Cell } from '@goodvibes-jev/engine/sdk/platform/types';
import { safeTerminalLink } from '@goodvibes-jev/engine/terminal-shell';
import { activeTheme } from './theme.ts';

/** Module-level set of inline markdown special characters (hoisted out of hot loop). */
const INLINE_SPECIAL_CHARS = new Set(['[', '`', '*', '_', '~']);

/** Candidate matching leaves sentence punctuation outside the clickable target. */
function bareLinkAt(text: string, index: number): string | undefined {
  if (index > 0 && !/[\s(<"']/.test(text[index - 1])) return;
  if (text[index] !== '/' && !text.startsWith('http', index)) return;
  const match = /^(?:https?:\/\/[^\s,)<>"'`]+|\/[^\s,)<>"'`]+\/[^\s,)<>"'`]+)/.exec(text.slice(index));
  return match?.[0].replace(/[.;:!?]+$/, '') || undefined;
}

/**
 * Inline markdown token types.
 */
export type InlineToken =
  | { type: 'text'; text: string; style: Partial<Cell> }
  | { type: 'code'; text: string }
  | { type: 'link'; text: string; url: string };

/**
 * renderInlineMarkdown - Parse inline markdown (bold, italic, inline code, links)
 * and return a flat array of tokens with style info.
 */
export function renderInlineMarkdown(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let i = 0;

  while (i < text.length) {
    const bare = bareLinkAt(text, i);
    if (bare) {
      tokens.push({ type: 'link', text: bare, url: bare.startsWith('/') ? `file://${bare}` : bare });
      i += bare.length;
      continue;
    }
    // Link: [text](url)
    if (text[i] === '[') {
      const closeB = text.indexOf(']', i);
      if (closeB !== -1 && text[closeB + 1] === '(') {
        const closeP = text.indexOf(')', closeB + 2);
        if (closeP !== -1) {
          const linkText = text.slice(i + 1, closeB);
          const url = text.slice(closeB + 2, closeP);
          const target = safeTerminalLink(url);
          tokens.push(target ? { type: 'link', text: linkText, url: target } : { type: 'text', text: linkText, style: {} });
          i = closeP + 1;
          continue;
        }
      }
    }

    // Inline code: `code`
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end !== -1) {
        tokens.push({ type: 'code', text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // Bold+italic: ***text***
    if (text.slice(i, i + 3) === '***') {
      const end = text.indexOf('***', i + 3);
      if (end !== -1) {
        tokens.push({ type: 'text', text: text.slice(i + 3, end), style: { bold: true, italic: true } });
        i = end + 3;
        continue;
      }
      // No closing *** found, emit the leading * as plain text so the ** bold
      // check can handle the remaining ** on the next iteration.
      tokens.push({ type: 'text', text: '*', style: {} });
      i += 1;
      continue;
    }

    // Bold: **text**
    if (text.slice(i, i + 2) === '**') {
      const end = text.indexOf('**', i + 2);
      if (end !== -1) {
        tokens.push({ type: 'text', text: text.slice(i + 2, end), style: { bold: true } });
        i = end + 2;
        continue;
      }
    }

    // Italic: *text* or _text_
    // Guard: text[i - 1] !== '*' prevents the second * of ** from starting italic.
    // Guard: text[i + 1] !== text[i] prevents the first * of ** (or _ of __) from
    // starting italic when bold/underscore-bold detection failed (e.g. unclosed **).
    if (
      (text[i] === '*' || text[i] === '_') &&
      text[i - 1] !== text[i] &&
      text[i + 1] !== text[i]
    ) {
      const closer = text[i];
      const end = text.indexOf(closer, i + 1);
      if (end !== -1 && end > i + 1) {
        tokens.push({ type: 'text', text: text.slice(i + 1, end), style: { italic: true } });
        i = end + 1;
        continue;
      }
    }

    // Strikethrough: ~~text~~
    if (text.slice(i, i + 2) === '~~') {
      const end = text.indexOf('~~', i + 2);
      if (end !== -1) {
        tokens.push({ type: 'text', text: text.slice(i + 2, end), style: { strikethrough: true, fg: activeTheme().strikethrough } });
        i = end + 2;
        continue;
      }
    }

    // Plain text, accumulate until next special char, detect bare URLs and file paths
    let end = i + 1;
    while (end < text.length && !INLINE_SPECIAL_CHARS.has(text[end]) && !bareLinkAt(text, end)) {
      const code = text.charCodeAt(end);
      end += (code >= 0xD800 && code <= 0xDBFF) ? 2 : 1;
    }
    const plainText = text.slice(i, end);

    tokens.push({ type: 'text', text: plainText, style: {} });
    i = end;
  }

  return tokens;
}
