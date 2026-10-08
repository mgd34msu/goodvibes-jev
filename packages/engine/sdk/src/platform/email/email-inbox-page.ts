/** UID progress pages. Seed planning and content consumption are separate reads. */
import type { ImapUidCheckpoint } from '../intake/provider-adapter.js';
import { captureImapCheckpoint } from '../intake/imap-checkpoint.js';
import type { EmailInboxBatchMessage } from './email-inbox-batch.js';
import { withEmailReadConnection } from './email-read-connection.js';
import type { EmailConfig, EmailServiceDeps } from './email-service.js';
import type { EmailReplySubjectRead } from './reply-subject-source.js';

export interface EmailInboxPageInput {
  /** Only a durably committed checkpoint belongs here. Missing means plan only. */
  readonly checkpoint?: ImapUidCheckpoint | undefined;
  /** First seed keeps the newest page; later reads take the oldest pending page. */
  readonly limit?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface EmailInboxPageSelection {
  /** All UIDs in this connection's complete ALL search, including older history. */
  readonly total: number;
  /** Eligible UIDs at this read, before the page limit; never a processed count. */
  readonly pending: number;
  /** Exact ascending page chosen from that search. Seed planning fetches none. */
  readonly selectedUids: readonly number[];
  readonly hasMore: boolean;
}

export type EmailInboxPageRead =
  | (EmailInboxPageSelection & {
    readonly outcome: 'checkpoint-required';
    readonly transition: 'seed' | 'reset';
    readonly previous: ImapUidCheckpoint | null;
    /** Persist this baseline before another read can consume its first message. */
    readonly next: ImapUidCheckpoint;
    readonly coveredUids: readonly [];
  })
  | (EmailInboxPageSelection & {
    readonly outcome: 'complete';
    readonly checkpoint: ImapUidCheckpoint;
    readonly messages: readonly EmailInboxBatchMessage[];
    /** Every selected UID has a complete source; screening still comes later. */
    readonly coveredUids: readonly number[];
  })
  | { readonly outcome: 'incomplete'; readonly reason: string };

const MAX_PAGE_SOURCE_BYTES = 4 * 1024 * 1024;
const isUid = (value: number): boolean => Number.isSafeInteger(value) && value >= 1 && value <= 0xffffffff;

export async function readEmailInboxPage(deps: EmailServiceDeps, config: EmailConfig,
  sourceRead: EmailReplySubjectRead, input: EmailInboxPageInput,
): Promise<EmailInboxPageRead> {
  const limit = input.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Mail page limit must be from 1 through 50.');
  // Capture nested caller state synchronously, before credentials or transport.
  const checkpoint = input.checkpoint === undefined ? undefined : captureImapCheckpoint(input.checkpoint);
  return withEmailReadConnection(deps, config, sourceRead, input.signal, async (client, current) => {
    const validity = client.mailboxStatus?.uidValidity;
    if (validity === undefined || validity === null || !isUid(validity)) {
      return Object.freeze({ outcome: 'incomplete', reason: 'Mailbox identity is unavailable.' });
    }
    const uids = await client.searchCompleteUids(false);
    current();
    if (!checkpoint || checkpoint.uidValidity !== validity) {
      const selectedUids = Object.freeze(uids.slice(-limit));
      const skippedOlderMessages = uids.length - selectedUids.length;
      const next: ImapUidCheckpoint = Object.freeze({ kind: 'imap-uid', uidValidity: validity, lastTerminalUid: null,
        history: Object.freeze(skippedOlderMessages === 0
          ? { kind: 'complete', lowerBoundUid: 1, skippedOlderMessages: 0 }
          : { kind: 'bounded-seed', lowerBoundUid: selectedUids[0]!, skippedOlderMessages }) });
      // This connection stops before UNSEEN/FETCH. Even a failed first body on
      // the next connection cannot move this already-persisted history fence.
      return Object.freeze({ outcome: 'checkpoint-required', transition: checkpoint ? 'reset' : 'seed',
        previous: checkpoint ?? null, next, total: uids.length, pending: selectedUids.length,
        selectedUids, coveredUids: Object.freeze([] as const), hasMore: false });
    }
    const pending = uids.filter(uid => uid >= checkpoint.history.lowerBoundUid
      && (checkpoint.lastTerminalUid === null || uid > checkpoint.lastTerminalUid));
    const selectedUids = Object.freeze(pending.slice(0, limit));
    const unseen = selectedUids.length === 0 ? new Set<number>() : new Set(await client.searchCompleteUids(true));
    current();
    const messages: EmailInboxBatchMessage[] = [];
    let bytes = 0;
    for (const uid of selectedUids) {
      current();
      const source = await client.readCompleteMessageDetail(uid);
      current();
      if (source.outcome !== 'complete') return Object.freeze({ outcome: 'incomplete',
        reason: source.outcome === 'gone' ? 'Mailbox changed during the page read.' : source.reason });
      bytes += Buffer.byteLength(source.rawHeaders, 'utf8') + Buffer.byteLength(source.rawBodyStructure, 'utf8');
      for (const section of source.textSections) bytes += Buffer.byteLength(section.text, 'utf8');
      if (bytes > MAX_PAGE_SOURCE_BYTES) return Object.freeze({ outcome: 'incomplete', reason: 'Mail page exceeds the complete-source limit.' });
      messages.push(Object.freeze({ unread: unseen.has(uid), source }));
    }
    current();
    return Object.freeze({ outcome: 'complete', checkpoint, messages: Object.freeze(messages),
      total: uids.length, pending: pending.length, selectedUids, coveredUids: selectedUids,
      hasMore: pending.length > selectedUids.length });
  });
}
