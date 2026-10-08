/** The compatible inbox listing; mailbox provenance stays out of its wire data. */
import { IMAP_MAX_FETCH_UIDS } from './imap-client.js';
import { readSenderAuthentication } from '../google/sender-authentication.js';
import { withEmailReadConnection } from './email-read-connection.js';
import type { EmailConfig, EmailInboxListInput, EmailInboxListResult, EmailServiceDeps } from './email-service.js';
import type { EmailReplySubjectRead } from './reply-subject-source.js';
import type { ImapEnvelope } from './imap-client.js';

export async function listEmailInbox(deps: EmailServiceDeps, config: EmailConfig,
  sourceRead: EmailReplySubjectRead | undefined, input: EmailInboxListInput,
): Promise<{ buildResult: () => EmailInboxListResult; ingest: readonly { from: string; text: string }[] }> {
  const limit = input.limit ?? 10;
  const unreadOnly = input.unreadOnly ?? true;
  return withEmailReadConnection(deps, config, sourceRead, input.signal, async (client, current) => {
    const uids = unreadOnly
      ? await client.searchUnseen(input.since)
      : await client.searchAll(input.since);
    // Page here, visibly, rather than handing the whole match set to a
    // function that would quietly keep the tail of it. `total` below reports
    // the full match, so a caller can always see that this is a page.
    const pageUids = uids.slice(-Math.min(limit, IMAP_MAX_FETCH_UIDS));
    // `fetchEnvelopeBatch`, not `fetchEnvelopes`. They run the same fetch;
    // the difference is that one of them answers the question this method
    // has to answer. `fetchEnvelopes` returns a list, and its own doc warns
    // that "omission alone is not evidence of an expunge", which is exactly
    // the inference a caller makes when a page comes back short with nothing
    // saying why. The responses that could not be read travel with the page.
    const batch = await client.fetchEnvelopeBatch(pageUids);
    const envelopes: readonly ImapEnvelope[] = batch.envelopes;

    // NEWEST FIRST. A search answers in ascending UID order and the page
    // keeps the highest UIDs, so `envelopes` is the newest N with the OLDEST
    // of them at index 0, which is the reverse of what anybody displaying a
    // mailbox wants, and the reverse of what this method's own contract now
    // promises. Ordered by UID rather than by the `Date:` header, because
    // the UID is assigned by the receiving server and `Date:` is written by
    // whoever sent the message: sorting on it would let a forged date pin a
    // message to the top of the owner's inbox.
    const page = [...envelopes].reverse();

    // Fetch a body preview for the newest message of this page (read-only;
    // BODY.PEEK), which is now index 0. Taken from the page rather than from
    // the search results: the first search result is the oldest match and is
    // usually not on the page at all. Preview text taken from one message
    // and shown against another is worse than no preview, it attributes
    // words to a sender who did not write them, both in the listing and in
    // the untrusted-ingest record below.
    // Failures are non-fatal, the inbox summary is still returned.
    const previewTarget = page[0];
    let newestBodyPreview = '';
    if (previewTarget !== undefined) {
      try {
        newestBodyPreview = await client.fetchBodyPreview(previewTarget.uid);
      } catch {
        // best-effort: body preview unavailable, proceed without it
      }
    }

    current();
    // Which of these are actually unread. When the search was UNSEEN they
    // all are; when it was ALL, saying so would be a fabricated flag, so the
    // unseen set is asked for separately rather than assumed.
    const unseen = unreadOnly
      ? null
      : new Set<number>(await client.searchUnseen(input.since));

    return {
      ingest: page.map((env, idx) => ({
        from: env.from,
        text: `${env.subject}\n${idx === 0 ? newestBodyPreview : ''}`.trim(),
      })),
      // The service records untrusted ingest after transport retirement, then
      // invokes display callbacks. Preserve that original observable ordering.
      buildResult: () => {
        const messages = page.map((env, idx) => {
          current();
          const message = {
            uid: env.uid,
            messageId: env.messageId,
            from: env.from,
            subject: env.subject,
            date: env.date,
            unread: unseen === null ? true : unseen.has(env.uid),
            bodyPreview: idx === 0 ? newestBodyPreview : '',
            mailbox: env.mailbox,
            deliveredTo: env.deliveredTo,
            unverifiedToHeaderClaim: env.unverifiedToHeaderClaim,
            senderClaim: deps.describeSenderClaim(
              env.from,
              readSenderAuthentication(env.authenticationResults),
            ),
          };
          current();
          return message;
        });
        return {
          messages,
          total: uids.length,
          ...(batch.unreadable.length > 0
            ? {
              unreadable: batch.unreadable.map((problem) => ({
                uid: problem.uid,
                detail: problem.detail,
              })),
            }
            : {}),
        };
      },
    };
  });
}
