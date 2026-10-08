/** The canonical full-message read and its exact-result source provenance. */
import { hasVerifiedImapMessageIdentity } from './imap-message-read.js';
import { ImapClient } from './imap-client.js';
import { imapSocketFactoryFor, resolveEmailPassword } from './email-config.js';
import type { ImapMessageDetail } from './imap-client.js';
import type { EmailMessageRead } from './email-read-results.js';
import type { EmailConfig, EmailServiceDeps } from './email-service.js';
import type { EmailReplySubjectSource } from './reply-subject-source.js';

export async function readEmailMessage(
  deps: EmailServiceDeps,
  config: EmailConfig,
  uid: number,
  sources: WeakMap<ImapMessageDetail, EmailReplySubjectSource>,
  recordIngest: (messages: readonly { readonly from: string; readonly text: string }[]) => void,
): Promise<EmailMessageRead> {
  // The account lifetime and mailbox-wide ordering precede ANY credential/I/O
  // await, so config/secret changes while connecting cannot bless an old read.
  const sourceRead = deps.replySubjectSourceOwner?.beginRead(config, uid);
  const password = await resolveEmailPassword(config.passwordRef, deps.secretsManager);
  const socketFactory = deps.imapSocketFactory ?? imapSocketFactoryFor(deps.transport, config.imapSecurity);
  const socket = await socketFactory(config.imapHost, config.imapPort);
  const client = new ImapClient({
    socket,
    username: config.username,
    password,
    ...(config.mailbox.length > 0 ? { mailbox: config.mailbox } : {}),
  });
  try {
    await client.open();
    sourceRead?.observeMailbox(client.mailbox, client.mailboxStatus?.uidValidity ?? null);
    const read = await client.readMessageDetail(uid);
    await client.logout();
    if (read.outcome === 'read') {
      recordIngest([{ from: read.detail.from, text: `${read.detail.subject}\n${read.detail.bodyText}`.trim() }]);
      const source = hasVerifiedImapMessageIdentity(read.detail)
        ? sourceRead?.complete(read.detail.uid, read.detail.mailbox, read.detail.subject)
        : undefined;
      if (source) sources.set(read.detail, source);
      return read;
    }
    if (read.outcome === 'gone') return { outcome: 'gone' };
    return {
      outcome: 'unreadable',
      problems: read.problems.map((problem) => ({ uid: problem.uid, detail: problem.detail })),
    };
  } catch (error) {
    try { await client.logout(); } catch { /* best-effort */ }
    throw error;
  }
}
