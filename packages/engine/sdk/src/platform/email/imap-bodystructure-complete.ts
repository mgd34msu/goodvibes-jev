/** Fail-closed MIME proof, layered over the canonical BODYSTRUCTURE reader. */
import {
  parseBodyStructure,
  parseCompleteBodyStructureNodes,
  type ImapBodyPart,
  type ImapBodyStructureNode as Node,
} from './imap-bodystructure.js';

export const COMPLETE_MESSAGE_SOURCE_BYTES = 1_048_576;
export const COMPLETE_MESSAGE_HEADER_BYTES = 65_536;
export const COMPLETE_MESSAGE_STRUCTURE_BYTES = 200_000;

function text(node: Node | undefined): string { return typeof node === 'string' ? node : ''; }
function count(node: Node | undefined): boolean {
  return typeof node === 'number' && Number.isSafeInteger(node) && node >= 0;
}
function nstring(node: Node | undefined): boolean { return node === null || typeof node === 'string'; }
function parameters(node: Node | undefined): boolean {
  if (node === null) return true;
  if (!Array.isArray(node) || node.length === 0 || node.length % 2 !== 0) return false;
  const keys = new Set<string>();
  for (let i = 0; i < node.length; i += 2) {
    const key = text(node[i]).toLowerCase();
    // Extended/continued MIME parameters need their own decoding proof. In
    // particular, do not mistake filename* for an ordinary inline text body.
    if (!/^[a-z0-9!#$&+.^_`|~-]+$/.test(key) || keys.has(key) || !text(node[i + 1])) return false;
    keys.add(key);
  }
  return true;
}
function disposition(node: Node | undefined): boolean {
  return node === null || (Array.isArray(node) && node.length === 2
    && /^(?:attachment|inline)$/i.test(text(node[0])) && parameters(node[1]));
}
function language(node: Node | undefined): boolean {
  return nstring(node) || (Array.isArray(node) && node.length > 0 && node.every(item => typeof item === 'string'));
}
function extensions(node: Node[], start: number, multipart: boolean): boolean {
  if (node.length <= start) return true;
  if (multipart ? !parameters(node[start]) : !nstring(node[start])) return false;
  if (node.length > start + 1 && !disposition(node[start + 1])) return false;
  if (node.length > start + 2 && !language(node[start + 2])) return false;
  if (node.length > start + 3 && !nstring(node[start + 3])) return false;
  // Unknown extensions can change which bytes count as body; no silent skip.
  return node.length <= start + 4;
}

/** Validates every node before the compatibility collector can omit anything. */
export function parseCompleteBodyStructure(raw: string): readonly ImapBodyPart[] | null {
  const root = parseCompleteBodyStructureNodes(raw);
  if (root === null || Buffer.byteLength(raw, 'utf8') > COMPLETE_MESSAGE_STRUCTURE_BYTES) return null;
  let leaves = 0;
  const attachmentKinds: boolean[] = [];
  const visit = (node: Node[]): boolean => {
    if (Array.isArray(node[0])) {
      let index = 0;
      while (Array.isArray(node[index])) {
        if (!visit(node[index] as Node[])) return false;
        index += 1;
      }
      if (!/^(?:mixed|alternative|related)$/i.test(text(node[index])) || !extensions(node, index + 1, true)) return false;
      // A multipart attachment is not a set of inline body sections. Do not
      // accidentally download its descendants via the legacy leaf collector.
      const params = node[index + 1];
      const disp = node[index + 2];
      if (Array.isArray(params) && params.some((item, n) => n % 2 === 0 && /^name$/i.test(text(item)))) return false;
      if (Array.isArray(disp) && (/^attachment$/i.test(text(disp[0]))
        || (Array.isArray(disp[1]) && disp[1].length > 0))) return false;
      return true;
    }
    if (++leaves > 200 || node.length < 7
      || !/^[a-z0-9!#$&+.^_`|~-]+$/i.test(text(node[0]))
      || !/^[a-z0-9!#$&+.^_`|~-]+$/i.test(text(node[1]))
      || !parameters(node[2]) || !nstring(node[3]) || !nstring(node[4])
      || !text(node[5]) || !count(node[6])) return false;
    const type = text(node[0]).toLowerCase();
    if (type === 'multipart' || type === 'message') return false;
    const ext = type === 'text' ? 8 : 7;
    const disp = node[ext + 1];
    const typeParams = node[2];
    const named = (params: Node | undefined, key: string): boolean => Array.isArray(params)
      && params.some((item, index) => index % 2 === 0 && text(item).toLowerCase() === key);
    const explicitlyAttached = (Array.isArray(disp)
      && (/^attachment$/i.test(text(disp[0])) || named(disp[1], 'filename'))) || named(typeParams, 'name');
    // Non-text is not evidence of an attachment. Inline JSON/XML and other
    // formats can carry the message itself; this reader cannot screen them.
    if (type !== 'text' && !explicitlyAttached) return false;
    attachmentKinds.push(explicitlyAttached);
    return (type !== 'text' || count(node[7])) && extensions(node, ext, false);
  };
  if (!visit(root)) return null;
  const parts = parseBodyStructure(raw);
  if (parts.length !== leaves || parts.length === 0) return null;
  let total = 0;
  for (const [index, part] of parts.entries()) {
    // The lenient collector scans for a disposition-shaped list. A language
    // extension containing "attachment" must never hide an inline text body.
    if (part.isAttachment !== attachmentKinds[index]) return null;
    if (part.isAttachment) continue;
    if (part.type !== 'text' || !/^(?:plain|html)$/.test(part.subtype)) return null;
    total += part.sizeBytes;
    if (!Number.isSafeInteger(total) || total > COMPLETE_MESSAGE_SOURCE_BYTES) return null;
  }
  return parts;
}

function quotedPrintable(raw: string): Buffer | null {
  if (/[^\x09\x0a\x0d\x20-\x7e]/.test(raw) || /[\t ](?:\r\n|$)/.test(raw)) return null;
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    if (raw.charAt(i) !== '=') { bytes.push(raw.charCodeAt(i)); continue; }
    if (raw.slice(i + 1, i + 3) === '\r\n') { i += 2; continue; }
    const hex = raw.slice(i + 1, i + 3);
    if (!/^[0-9a-f]{2}$/i.test(hex)) return null;
    bytes.push(parseInt(hex, 16)); i += 2;
  }
  return Buffer.from(bytes);
}

/** Complete decoded text, preserving content/line endings; null means no proof. */
export function decodeCompleteTextPart(raw: string, part: ImapBodyPart): string | null {
  if (/\ufffd/.test(raw) || Buffer.byteLength(raw, 'utf8') !== part.sizeBytes) return null;
  const charset = part.charset || 'us-ascii';
  if (!/^(?:utf-8|utf8|us-ascii|ascii|iso-?8859-1|latin-?1|windows-1252|cp1252)$/.test(charset)) return null;
  let bytes: Buffer | null;
  if (part.encoding === 'base64') {
    if (/[^A-Za-z0-9+/=\t\r\n ]/.test(raw)) return null;
    const encoded = raw.replace(/[\t\r\n ]/g, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return null;
    bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) return null;
  } else if (part.encoding === 'quoted-printable') {
    bytes = quotedPrintable(raw);
  } else if (/^(?:7bit|8bit|binary)$/.test(part.encoding)) {
    // The legacy transport hands us UTF-8 strings. Non-UTF-8 8-bit bytes are
    // unrecoverable here, even when the replacement decoded length matches.
    if ((part.encoding === '7bit' || !/^(?:utf-8|utf8)$/.test(charset)) && /[^\x00-\x7f]/.test(raw)) return null;
    bytes = Buffer.from(raw, 'utf8');
  } else return null;
  if (bytes === null) return null;
  try {
    let decoded: string;
    if (/^(?:us-ascii|ascii)$/.test(charset)) {
      if (bytes.some(byte => byte > 0x7f)) return null;
      decoded = bytes.toString('ascii');
    } else if (/^(?:iso-?8859-1|latin-?1)$/.test(charset)) decoded = bytes.toString('latin1');
    else decoded = new TextDecoder(/^(?:cp1252|windows-1252)$/.test(charset) ? 'windows-1252' : 'utf-8',
      { fatal: true, ignoreBOM: true }).decode(bytes);
    return /\ufffd|\u0000/.test(decoded) ? null : decoded;
  } catch { return null; }
}
