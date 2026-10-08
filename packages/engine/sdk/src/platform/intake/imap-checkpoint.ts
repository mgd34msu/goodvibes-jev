/** Canonical IMAP checkpoint validation; contains no provider/account authority. */
import { types } from 'node:util';
import type { ImapUidCheckpoint, ImapUidCheckpointAdvance, ImapUidTerminalDisposition, InboundChannelItem } from './provider-adapter.js';

const MAX_UID = 0xffffffff;
function validUid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= MAX_UID;
}
function invalid(): never { throw new Error('Invalid IMAP inbox checkpoint transition'); }

/** Reject dynamic fields rather than executing accessors at this boundary. */
function fields<T extends object>(value: T, keys: readonly string[]): T {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const captured: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor) continue;
    if (!('value' in descriptor)) invalid();
    captured[key] = descriptor.value;
  }
  return captured as T;
}

function values<T>(value: readonly T[]): readonly T[] {
  if (!Array.isArray(value) || types.isProxy(value) || value.length > 50) invalid();
  const result: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) invalid();
    result.push(descriptor.value as T);
  }
  return Object.freeze(result);
}

export function captureImapCheckpoint(value: ImapUidCheckpoint): ImapUidCheckpoint {
  const { kind: checkpointKind, uidValidity, lastTerminalUid, history } = fields(value,
    ['kind', 'uidValidity', 'lastTerminalUid', 'history']);
  if (checkpointKind !== 'imap-uid' || !validUid(uidValidity)) invalid();
  const { kind, lowerBoundUid, skippedOlderMessages } = fields(history, ['kind', 'lowerBoundUid', 'skippedOlderMessages']);
  if ((kind !== 'complete' && kind !== 'bounded-seed') || !validUid(lowerBoundUid)
    || !Number.isSafeInteger(skippedOlderMessages) || skippedOlderMessages < 0 || skippedOlderMessages >= lowerBoundUid
    || (kind === 'complete' && (lowerBoundUid !== 1 || skippedOlderMessages !== 0))) invalid();
  if (lastTerminalUid !== null && (!validUid(lastTerminalUid) || lastTerminalUid < lowerBoundUid)) invalid();
  return Object.freeze({ kind: 'imap-uid', uidValidity, lastTerminalUid,
    history: Object.freeze({ kind, lowerBoundUid, skippedOlderMessages }) });
}
export function sameImapCheckpoint(left: ImapUidCheckpoint | null, right: ImapUidCheckpoint | null): boolean {
  if (!left || !right) return left === right;
  return left.uidValidity === right.uidValidity && left.lastTerminalUid === right.lastTerminalUid
    && left.history.kind === right.history.kind && left.history.lowerBoundUid === right.history.lowerBoundUid
    && left.history.skippedOlderMessages === right.history.skippedOlderMessages;
}

/** Copy only redacted feed fields before yielding to persistence. */
export function captureImapItems(provider: string, input: readonly InboundChannelItem[]): readonly InboundChannelItem[] {
  return Object.freeze(values(input).map((raw) => {
    const item = fields(raw, ['id', 'provider', 'kind', 'fromDigest', 'subjectPreview', 'bodyPreview', 'receivedAt', 'unread', 'routeId']);
    if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 500 || item.provider !== provider
      || !['dm', 'thread', 'mention', 'reaction'].includes(item.kind)
      || typeof item.fromDigest !== 'string' || !/^[a-f0-9]{16}$/i.test(item.fromDigest)
      || typeof item.subjectPreview !== 'string' || item.subjectPreview.length > 200
      || typeof item.bodyPreview !== 'string' || item.bodyPreview.length > 500
      || !Number.isFinite(item.receivedAt) || typeof item.unread !== 'boolean'
      || (item.routeId !== undefined && typeof item.routeId !== 'string')) invalid();
    return Object.freeze({ id: item.id, provider, kind: item.kind, fromDigest: item.fromDigest,
      subjectPreview: item.subjectPreview, bodyPreview: item.bodyPreview, receivedAt: item.receivedAt,
      unread: item.unread, ...(item.routeId === undefined ? {} : { routeId: item.routeId }) });
  }));
}

export function captureImapAdvance(raw: ImapUidCheckpointAdvance, items: readonly InboundChannelItem[]): ImapUidCheckpointAdvance {
  const input = fields(raw, ['kind', 'transition', 'previous', 'next', 'coveredUids', 'terminal']);
  if (!input || input.kind !== 'imap-uid' || !['seed', 'advance', 'reset'].includes(input.transition)
    || !Array.isArray(input.coveredUids) || !Array.isArray(input.terminal) || input.coveredUids.length > 50) invalid();
  const previous = input.previous === null ? null : captureImapCheckpoint(input.previous);
  const next = captureImapCheckpoint(input.next);
  const coveredUids = values(input.coveredUids);
  const terminal: readonly ImapUidTerminalDisposition[] = Object.freeze(values(input.terminal).map((rawEntry) => {
    const entry = fields(rawEntry, ['uid', 'disposition', 'itemId']);
    if (!entry || !validUid(entry.uid)) invalid();
    if (entry.disposition === 'published' && typeof entry.itemId === 'string' && entry.itemId) {
      return Object.freeze({ uid: entry.uid, disposition: 'published', itemId: entry.itemId });
    }
    if (entry.disposition === 'suppressed' || entry.disposition === 'gone') {
      return Object.freeze({ uid: entry.uid, disposition: entry.disposition });
    }
    return invalid();
  }));
  if (input.transition === 'seed' || input.transition === 'reset') {
    if ((input.transition === 'seed' && previous !== null)
      || (input.transition === 'reset' && (!previous || previous.uidValidity === next.uidValidity))
      || next.lastTerminalUid !== null || coveredUids.length !== 0 || terminal.length !== 0 || items.length !== 0) invalid();
  } else {
    if (!previous || previous.uidValidity !== next.uidValidity
      || !sameImapCheckpoint({ ...previous, lastTerminalUid: next.lastTerminalUid }, next)
      || coveredUids.length !== terminal.length) invalid();
    let lower = previous.lastTerminalUid ?? previous.history.lowerBoundUid - 1;
    const published = new Set<string>();
    for (let index = 0; index < coveredUids.length; index += 1) {
      const uid = coveredUids[index];
      const disposition = terminal[index]!;
      if (!validUid(uid) || uid <= lower || disposition.uid !== uid) invalid();
      lower = uid;
      if (disposition.disposition === 'published') {
        if (published.has(disposition.itemId)) invalid();
        published.add(disposition.itemId);
      }
    }
    if (next.lastTerminalUid !== (coveredUids.at(-1) ?? previous.lastTerminalUid)
      || published.size !== items.length || new Set(items.map((item) => item.id)).size !== items.length
      || items.some((item) => !published.has(item.id))) invalid();
  }
  return Object.freeze({ kind: 'imap-uid', transition: input.transition, previous, next, coveredUids, terminal });
}
