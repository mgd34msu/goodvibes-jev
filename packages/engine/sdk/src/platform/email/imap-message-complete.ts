/** Exact, bounded whole-source acquisition. No partial result is screenable. */
import { attachmentsFromParts } from './imap-bodystructure.js';
import {
  COMPLETE_MESSAGE_HEADER_BYTES,
  COMPLETE_MESSAGE_SOURCE_BYTES,
  COMPLETE_MESSAGE_STRUCTURE_BYTES,
  decodeCompleteTextPart,
  parseCompleteBodyStructure,
} from './imap-bodystructure-complete.js';
import { completeFetchBodyStructure, completeFetchSection } from './imap-fetch-complete.js';
import {
  extractAuthenticationResults,
  extractDeliveryEvidence,
  extractHeader,
} from './imap-headers.js';
import type { ImapSession } from './imap-session.js';
import type { ImapCompleteMessageRead, ImapCompleteTextSection, ImapMessageDetail } from './imap-types.js';
import { MAX_IMAP_UID } from './inbound/source-cursor.js';

const incomplete = (reason: string): ImapCompleteMessageRead => Object.freeze({ outcome: 'incomplete', reason });

/** Raw source is retained, not reconstructed from the clipped display parser. */
function completeHeaders(raw: string): boolean {
  if (!raw.endsWith('\r\n\r\n') || /\ufffd|\u0000/.test(raw)
    || Buffer.byteLength(raw, 'utf8') > COMPLETE_MESSAGE_HEADER_BYTES) return false;
  const lines = raw.slice(0, -4).split('\r\n');
  let field = false;
  for (const line of lines) {
    if (/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(line)) return false;
    if (/^[ \t]/.test(line)) { if (!field) return false; continue; }
    if (!/^[\x21-\x39\x3b-\x7e]+:/.test(line)) return false;
    field = true;
  }
  return field;
}

function detailFor(uid: number, mailbox: string, rawHeaders: string,
  textSections: readonly ImapCompleteTextSection[],
  attachments: ImapMessageDetail['attachments']): ImapMessageDetail {
  const deliveryEvidence = Object.freeze(extractDeliveryEvidence(rawHeaders).map(entry => Object.freeze(entry)));
  return Object.freeze({
    uid, mailbox,
    from: extractHeader(rawHeaders, 'From'),
    subject: extractHeader(rawHeaders, 'Subject'),
    date: extractHeader(rawHeaders, 'Date'),
    messageId: extractHeader(rawHeaders, 'Message-ID'),
    deliveredTo: Object.freeze(deliveryEvidence.map(entry => entry.address)),
    deliveryEvidence,
    unverifiedToHeaderClaim: extractHeader(rawHeaders, 'To'),
    authenticationResults: Object.freeze(extractAuthenticationResults(rawHeaders)),
    bodyText: (textSections.find(part => part.contentType === 'text/plain')?.text ?? '').replace(/\r\n/g, '\n'),
    bodyHtml: (textSections.find(part => part.contentType === 'text/html')?.text ?? '').replace(/\r\n/g, '\n'),
    attachments: Object.freeze(attachments.map(attachment => Object.freeze(attachment))),
  });
}

/**
 * A command must prove exact UID, full section, complete syntax and encoding.
 * Every supported inline text part is read. Attachment bytes are never fetched.
 * Unsupported formats, limits and transport failures are explicit incomplete
 * outcomes, without leaking sender text into their diagnostics.
 */
export async function readCompleteMessageDetail(session: ImapSession, uid: number,
  mailbox: string): Promise<ImapCompleteMessageRead> {
  if (!Number.isSafeInteger(uid) || uid < 1 || uid > MAX_IMAP_UID) return incomplete('invalid-uid');
  try {
    const headerFrames = await session.commandFrames(`UID FETCH ${uid} BODY.PEEK[HEADER]`,
      { maxResponseBytes: COMPLETE_MESSAGE_HEADER_BYTES + 4_096 });
    if (headerFrames.length === 1 && headerFrames[0]?.literal === undefined
      && /^\S+ OK\b/.test(headerFrames[0]?.syntax ?? '')) return Object.freeze({ outcome: 'gone' });
    const rawHeaders = completeFetchSection(headerFrames, uid, 'HEADER');
    if (rawHeaders === null || !completeHeaders(rawHeaders)) return incomplete('headers-incomplete');

    const structureFrames = await session.commandFrames(`UID FETCH ${uid} BODYSTRUCTURE`,
      { maxResponseBytes: COMPLETE_MESSAGE_STRUCTURE_BYTES + 4_096 });
    const structure = completeFetchBodyStructure(structureFrames, uid);
    const parts = structure === null ? null : parseCompleteBodyStructure(structure);
    if (parts === null || structure === null) return incomplete('bodystructure-incomplete-or-unsupported');
    const textSections: ImapCompleteTextSection[] = [];
    let sourceBytes = Buffer.byteLength(rawHeaders, 'utf8') + Buffer.byteLength(structure, 'utf8');
    for (const part of parts) {
      if (part.isAttachment) continue;
      const frames = await session.commandFrames(`UID FETCH ${uid} BODY.PEEK[${part.section}]`,
        { maxResponseBytes: part.sizeBytes + 4_096 });
      const raw = completeFetchSection(frames, uid, part.section);
      const text = raw === null ? null : decodeCompleteTextPart(raw, part);
      if (text === null) return incomplete('text-section-incomplete-or-unsupported');
      sourceBytes += Buffer.byteLength(text, 'utf8');
      if (sourceBytes > COMPLETE_MESSAGE_SOURCE_BYTES) return incomplete('complete-source-too-large');
      textSections.push(Object.freeze({ section: part.section,
        contentType: part.subtype === 'html' ? 'text/html' : 'text/plain', text }));
    }
    const frozenSections = Object.freeze(textSections);
    return Object.freeze({ outcome: 'complete', rawHeaders, rawBodyStructure: structure, textSections: frozenSections,
      detail: detailFor(uid, mailbox, rawHeaders, frozenSections, attachmentsFromParts(parts)) });
  } catch {
    return incomplete('source-fetch-failed');
  }
}
