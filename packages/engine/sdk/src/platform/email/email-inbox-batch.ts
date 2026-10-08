/** A bounded snapshot, never a timestamp cursor or a mailbox-backlog claim. */
import { withEmailReadConnection } from './email-read-connection.js';
import type { ImapCompleteMessageRead } from './imap-client.js';
import type { EmailConfig, EmailServiceDeps } from './email-service.js';
import type { EmailReplySubjectRead } from './reply-subject-source.js';

export interface EmailInboxBatchInput {
  /** Newest server-assigned UIDs, from 1 through 50. Default 10. */
  readonly limit?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}
export interface EmailInboxBatchMessage {
  readonly unread: boolean;
  readonly source: Extract<ImapCompleteMessageRead, { outcome: 'complete' }>;
}
export type EmailInboxBatchRead =
  | { readonly outcome: 'complete'; readonly messages: readonly EmailInboxBatchMessage[]; readonly total: number }
  | { readonly outcome: 'incomplete'; readonly reason: string };

const MAX_BATCH_SOURCE_BYTES = 4 * 1024 * 1024;

export async function readEmailInboxBatch(deps: EmailServiceDeps, config: EmailConfig,
  sourceRead: EmailReplySubjectRead, input: EmailInboxBatchInput,
): Promise<EmailInboxBatchRead> {
  const limit = input.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Mail batch limit must be from 1 through 50.');
  return withEmailReadConnection(deps, config, sourceRead, input.signal, async (client, current) => {
    const validity = client.mailboxStatus?.uidValidity;
    if (!Number.isSafeInteger(validity) || validity === undefined || validity === null || validity < 1 || validity > 0xffffffff) {
      return Object.freeze({ outcome: 'incomplete', reason: 'Mailbox identity is unavailable.' });
    }
    const uids = await client.searchCompleteUids(false);
    current();
    const unseen = new Set(await client.searchCompleteUids(true));
    const messages: EmailInboxBatchMessage[] = [];
    let bytes = 0;
    // This operation deliberately takes no SINCE timestamp. Date headers do not
    // establish progress, and the intake poller's cursor cannot represent UIDs.
    for (const uid of uids.slice(-limit).reverse()) {
      current();
      const source = await client.readCompleteMessageDetail(uid);
      current();
      if (source.outcome !== 'complete') return Object.freeze({ outcome: 'incomplete',
        reason: source.outcome === 'gone' ? 'Mailbox changed during the snapshot.' : source.reason });
      bytes += Buffer.byteLength(source.rawHeaders, 'utf8') + Buffer.byteLength(source.rawBodyStructure, 'utf8');
      for (const section of source.textSections) bytes += Buffer.byteLength(section.text, 'utf8');
      if (bytes > MAX_BATCH_SOURCE_BYTES) return Object.freeze({ outcome: 'incomplete', reason: 'Mail snapshot exceeds the complete-source limit.' });
      messages.push(Object.freeze({ unread: unseen.has(uid), source }));
    }
    current();
    return Object.freeze({ outcome: 'complete', messages: Object.freeze(messages), total: uids.length });
  });
}
