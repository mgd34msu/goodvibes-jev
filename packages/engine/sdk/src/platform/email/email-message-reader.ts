/** The canonical full-message read and its exact-result source provenance. */
import { hasVerifiedImapMessageIdentity } from './imap-message-read.js';
import { withEmailReadConnection } from './email-read-connection.js';
import type { ImapMessageDetail } from './imap-client.js';
import type { EmailMessageRead } from './email-read-results.js';
import type { EmailConfig, EmailServiceDeps } from './email-service.js';
import type { EmailReplySubjectSource } from './reply-subject-source.js';

export async function readEmailMessage(
  deps: EmailServiceDeps,
  config: EmailConfig,
  uid: number,
  sources: WeakMap<ImapMessageDetail, EmailReplySubjectSource>,
  recordIngest: (messages: readonly { readonly from: string; readonly text: string }[], assertCurrent: () => void) => void,
): Promise<EmailMessageRead> {
  // The account lifetime and mailbox-wide ordering precede ANY credential/I/O
  // await, so config/secret changes while connecting cannot bless an old read.
  const sourceRead = deps.replySubjectSourceOwner?.beginRead(config, uid);
  const read = await withEmailReadConnection(deps, config, sourceRead, undefined,
    (client) => client.readMessageDetail(uid));
  const current = (): void => sourceRead?.assertCurrent();
  current();
  if (read.outcome === 'read') {
    recordIngest([{ from: read.detail.from, text: `${read.detail.subject}\n${read.detail.bodyText}`.trim() }], current);
    current();
    const source = hasVerifiedImapMessageIdentity(read.detail)
      ? sourceRead?.complete(read.detail.uid, read.detail.mailbox, read.detail.subject)
      : undefined;
    if (source) sources.set(read.detail, source);
    current();
    return read;
  }
  if (read.outcome === 'gone') return { outcome: 'gone' };
  return {
    outcome: 'unreadable',
    problems: read.problems.map((problem) => ({ uid: problem.uid, detail: problem.detail })),
  };
}
