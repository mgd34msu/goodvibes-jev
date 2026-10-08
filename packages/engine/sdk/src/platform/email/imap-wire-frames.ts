import type { ImapFetchFrame } from './imap-fetch-response.js';

interface WireLine extends ImapFetchFrame { readonly end: number }

/** Frame original octets before decoding: IMAP literal lengths are byte counts. */
export function* wireLines(raw: string | Uint8Array, complete: boolean, literalCap = Number.MAX_SAFE_INTEGER): Generator<WireLine> {
  const bytes = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  let offset = 0;
  while (offset < bytes.length) {
    const newline = bytes.indexOf(10, offset);
    if (newline < 0) {
      if (complete) yield { syntax: bytes.subarray(offset).toString('utf8'), end: bytes.length };
      break;
    }
    const syntax = bytes.subarray(offset, newline).toString('utf8').replace(/\r$/, '');
    offset = newline + 1;
    const literal = /\{(\d+)\}$/.exec(syntax);
    if (!literal) { yield { syntax, end: offset }; continue; }
    const length = Number(literal[1]);
    if (!Number.isSafeInteger(length)) throw new Error('Invalid IMAP literal length');
    if (length > literalCap) throw new Error(`IMAP server sent an oversized literal ({${length}} bytes, max allowed: ${literalCap}). The operation has been aborted.`);
    if (length > bytes.length - offset) {
      if (complete) throw new Error('Incomplete IMAP literal');
      break;
    }
    const payload = bytes.subarray(offset, offset + length).toString('utf8');
    offset += length;
    yield { syntax: syntax.slice(0, literal.index), literal: payload, end: offset };
  }
}
