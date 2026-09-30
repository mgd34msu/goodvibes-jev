import { fetchSection, parseFetchResponses } from '../../email/imap-fetch-response.js';
import type { ImapEnvelope } from './imap-client.js';

interface WireLine { readonly line: string; readonly syntax: string }

/** IMAP atoms are case-insensitive; quoted values remain byte-for-byte data. */
function canonicalSyntax(value: string): string {
  return value.replace(/"(?:[^"\\]|\\.)*"|[^\"]+/g, part => part.startsWith('"') ? part : part.toUpperCase());
}

/** Fold byte-counted literals exactly like the canonical email wire session. */
function wireLines(raw: string, complete: boolean): WireLine[] {
  const bytes = Buffer.from(raw, 'utf8');
  const lines: WireLine[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const newline = bytes.indexOf(10, offset);
    if (newline < 0) {
      if (complete) {
        const line = bytes.subarray(offset).toString('utf8');
        lines.push({ line: canonicalSyntax(line), syntax: line });
      }
      break;
    }
    const line = bytes.subarray(offset, newline).toString('utf8').replace(/\r$/, '');
    offset = newline + 1;
    const literal = /\{(\d+)\}$/.exec(line);
    if (!literal) { lines.push({ line: canonicalSyntax(line), syntax: line }); continue; }
    const length = Number(literal[1]);
    if (!Number.isSafeInteger(length) || length > bytes.length - offset) {
      if (complete) throw new Error('Incomplete IMAP literal');
      break;
    }
    const prefix = line.slice(0, literal.index);
    const payload = bytes.subarray(offset, offset + length).toString('utf8');
    lines.push({ line: `${canonicalSyntax(prefix)} ${payload}`, syntax: prefix });
    offset += length;
  }
  return lines;
}

/** A tagged-looking line inside a literal is message text, never completion. */
export function hasTaggedCompletion(raw: string, tag: string): boolean {
  return taggedStatus(raw, tag) !== undefined;
}

export function taggedStatus(raw: string, tag: string): string | undefined {
  for (const { syntax } of wireLines(raw, false)) {
    const status = new RegExp(`^${tag} (OK|NO|BAD)\\b`, 'i').exec(syntax)?.[1];
    if (status) return status.toUpperCase();
  }
  return undefined;
}

export function parseIntakeFetchResponse(raw: string): ImapEnvelope[] {
  const lines = wireLines(raw, true);
  const flags = new Map<number, string>();
  let seq: number | undefined;
  for (const { syntax } of lines) {
    // Mask quoted payloads and section specifiers before reading protocol flags.
    const structural = syntax.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\[[^\]]*\]/g, '[]');
    const start = /^\* (\d+) FETCH /i.exec(structural);
    if (start) seq = Number(start[1]);
    const match = /\bFLAGS \(([^)]*)\)/i.exec(structural);
    if (seq !== undefined && match) flags.set(seq, match[1]!);
  }
  return parseFetchResponses(lines.map(({ line }) => line)).map(response => {
    if (response.parseError || response.uid === null || response.uid < 1) {
      throw new Error('Unreadable IMAP FETCH response');
    }
    const headers = fetchSection(response, section => section.startsWith('HEADER.FIELDS')) ?? '';
    const dateRaw = /^Date:\s*(.*)$/im.exec(headers)?.[1]?.trim();
    const date = dateRaw ? Date.parse(dateRaw) : NaN;
    return {
      uid: response.uid,
      from: /^From:\s*(.*)$/im.exec(headers)?.[1]?.trim() ?? '',
      subject: decodeHeader(/^Subject:\s*(.*)$/im.exec(headers)?.[1]?.trim() ?? ''),
      date: Number.isFinite(date) ? date : 0,
      seen: (flags.get(response.seq) ?? '').split(/\s+/).some(flag => flag.toLowerCase() === '\\seen'),
      bodyPreview: fetchSection(response, section => section === 'TEXT') ?? '',
    };
  });
}

/** RFC 2047 encoded words; decoding is protocol syntax, never classification. */
export function decodeHeader(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_match, charset: string, enc: string, text: string) => {
    try {
      const bytes = enc.toUpperCase() === 'B' ? Buffer.from(text, 'base64')
        : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g,
          (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), 'latin1');
      return new TextDecoder(charset).decode(bytes);
    } catch { return text; }
  });
}
