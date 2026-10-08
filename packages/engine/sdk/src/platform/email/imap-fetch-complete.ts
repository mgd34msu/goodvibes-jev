/** Strict proof over canonical FETCH results; compatibility extraction is untouched. */
import { extractBodyStructure } from './imap-bodystructure.js';
import {
  hasCompleteFetchSection,
  parseFetchResponses,
  type ImapFetchFrame,
} from './imap-fetch-response.js';
import { parseSearchNumbers } from './imap-headers.js';
import { MAX_IMAP_UID } from './inbound/source-cursor.js';

/** Unsupported extra data items/unsolicited responses are refused, not ignored. */
function exactFrames(frames: readonly ImapFetchFrame[], uid: number): readonly ImapFetchFrame[] | null {
  const responses = parseFetchResponses(frames);
  if (responses.length !== 1 || responses[0]?.parseError !== null || responses[0].uid !== uid) return null;
  const last = frames.at(-1);
  const response = last !== undefined && last.literal === undefined && /^\S+ OK\b/.test(last.syntax)
    ? frames.slice(0, -1) : frames;
  if (response.length === 0 || response.length > 2) return null;
  return response;
}

function envelope(prefix: string, suffix: string, item: string, uid: number): boolean {
  const match = /^\* ([1-9][0-9]*) FETCH \((?:UID ([1-9][0-9]*)[ \t]+)?/i.exec(prefix);
  if (match === null || Number(match[1]) > MAX_IMAP_UID || prefix.slice(match[0].length).toUpperCase() !== item.toUpperCase()) return false;
  const tail = /^(?:[ \t]+UID ([1-9][0-9]*))?[ \t]*\)$/i.exec(suffix);
  if (tail === null || (match[2] === undefined) === (tail[1] === undefined)) return false;
  return Number(match[2] ?? tail[1]) === uid;
}

/** Only a whole exact section, with an unambiguous UID and a real value. */
export function completeFetchSection(frames: readonly ImapFetchFrame[], uid: number, section: string): string | null {
  const responseFrames = exactFrames(frames, uid);
  if (responseFrames === null) return null;
  const [response] = parseFetchResponses(frames);
  if (response === undefined || !hasCompleteFetchSection(response, section) || response.sections.size !== 1) return null;
  const first = responseFrames[0]!;
  const item = `BODY[${section}] `;
  if (first.literal !== undefined) {
    const last = responseFrames[1];
    if (responseFrames.length !== 2 || last === undefined || last.literal !== undefined
      || !envelope(first.syntax, last.syntax, item, uid)) return null;
    return first.literal;
  }
  if (responseFrames.length !== 1) return null;
  const marker = first.syntax.toUpperCase().indexOf(item);
  if (marker < 0) return null;
  const start = marker + item.length;
  const quoted = /^"(?:[^"\\\r\n\x00-\x1f\x7f-\uffff]|\\["\\])*"/.exec(first.syntax.slice(start));
  if (quoted === null || !envelope(first.syntax.slice(0, start), first.syntax.slice(start + quoted[0].length), item, uid)) return null;
  return response.sections.get(section.toUpperCase()) ?? null;
}

/** Full structure from the canonical extractor, with exact outer syntax/UID. */
export function completeFetchBodyStructure(frames: readonly ImapFetchFrame[], uid: number): string | null {
  const responseFrames = exactFrames(frames, uid);
  if (responseFrames === null || responseFrames.some(frame => frame.literal !== undefined)) return null;
  const raw = responseFrames.map(frame => frame.syntax).join('\r\n');
  const marker = /BODYSTRUCTURE[ \t]+/i.exec(raw);
  if (marker === null) return null;
  const structure = extractBodyStructure(responseFrames);
  const start = marker.index + marker[0].length;
  if (!structure || !envelope(raw.slice(0, marker.index) + 'BODYSTRUCTURE ', raw.slice(start + structure.length), 'BODYSTRUCTURE ', uid)) return null;
  return structure;
}

/** Complete UID SEARCH snapshot. A malformed reply cannot mean an empty inbox. */
export function completeSearchUids(frames: readonly ImapFetchFrame[]): readonly number[] {
  const failure = (): never => { throw new Error('IMAP UID SEARCH response was incomplete or unsupported'); };
  if (frames.length !== 2 || frames.some(frame => frame.literal !== undefined)
    || !/^\S+ OK\b/.test(frames[1]?.syntax ?? '')) return failure();
  const response = frames[0]?.syntax ?? '';
  if (!/^\* SEARCH(?: [1-9][0-9]{0,9})*$/.test(response)) return failure();
  const tokens = response.length === 8 ? [] : response.slice(9).split(' ');
  const uids = parseSearchNumbers([response]);
  if (uids.length !== tokens.length || uids.some(uid => !Number.isSafeInteger(uid) || uid < 1 || uid > MAX_IMAP_UID)
    || new Set(uids).size !== uids.length) return failure();
  return Object.freeze(uids.sort((a, b) => a - b));
}
