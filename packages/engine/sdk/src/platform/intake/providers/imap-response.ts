import { fetchSection, parseFetchResponses } from '../../email/imap-fetch-response.js';
import type { ImapEnvelope } from './imap-client.js';

import { wireLines } from '../../email/imap-wire-frames.js';

/** IMAP atoms are case-insensitive; quoted values remain byte-for-byte data. */
function canonicalSyntax(value: string): string {
  return value.replace(/"(?:[^"\\]|\\.)*"|[^\"]+/g, part => part.startsWith('"') ? part : part.toUpperCase());
}

/** Only a complete syntax line outside a literal can end the current command. */
export function taggedCompletion(raw: Uint8Array, tag: string): { status: string; end: number } | undefined {
  for (const { syntax, literal, end } of wireLines(raw, false)) {
    if (literal !== undefined) continue;
    const status = new RegExp(`^${tag} (OK|NO|BAD)\\b`, 'i').exec(syntax)?.[1];
    if (status) return { status: status.toUpperCase(), end };
  }
  return undefined;
}

export function parseIntakeFetchResponse(raw: string | Uint8Array): ImapEnvelope[] {
  const lines = [...wireLines(raw, true)];
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
  return parseFetchResponses(lines.map(({ syntax, literal }) => ({ syntax: canonicalSyntax(syntax), ...(literal === undefined ? {} : { literal }) }))).map(response => {
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
