/**
 * The message detail for a selected inbox row. Reads `email.inbox.read`, which
 * carries what the summary row cannot: the full body text and attachment
 * metadata. A genuine detail fetch, the same relationship the calendar event
 * detail has to the event list. The caller owns the query (so the pane header
 * can show the subject and sender) and hands it to MailMessageBody.
 *
 * TWO DELIBERATE RESTRAINTS, both about not doing more than the surface should:
 *
 * 1. `bodyHtml` is NEVER rendered. The detail schema carries it and this
 *    component reads it, but only to say that an HTML alternative exists, the
 *    text part is what gets displayed. Rendering an arbitrary sender's HTML
 *    inside the operator console would let mail from anyone style, lay out, and
 *    (via remote image loads) phone home from a page that also holds the daemon
 *    session. Showing bodyText and naming the HTML part is the honest version:
 *    nothing is hidden from the operator, and nothing a stranger wrote gets to
 *    run in here.
 *
 * 2. Attachments are listed, never fetched. The schema is metadata only, filename,
 *    content type, size, and there is no attachment-download verb in the contract
 *    at all. So this lists what is attached and stops, rather than rendering a
 *    download control that no daemon method backs.
 *
 * The read verb is explicitly non-mutating on the server (BODY.PEEK, the SDK's
 * own description says it does not mark the message read), so opening a message
 * does not silently change the operator's mailbox state. The unread dot in the
 * list stays truthful after a read, which is why nothing here clears it.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { AlertCircle, Mail } from 'lucide-react';
import { sdk } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { formatError } from '../../lib/errors';
import { mailRefusalNote } from '../../lib/mail-refusal';
import { Button } from '../../components/ui';
import { DetailSection, EmptyState, Facts, SkeletonRows } from '../../components/data-view/DataView';

export type MailMessageData = Awaited<ReturnType<typeof sdk.operator.email.inbox.read>>;

export function useMailMessage(uid: number | null): UseQueryResult<MailMessageData> {
  return useQuery({
    queryKey: queryKeys.emailMessage(uid ?? -1),
    enabled: uid !== null && Number.isFinite(uid),
    queryFn: () => sdk.operator.email.inbox.read(uid ?? -1),
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MailMessageBody({ detail }: { detail: UseQueryResult<MailMessageData> }) {
  if (detail.isPending) return <SkeletonRows count={3} label="Loading message" />;

  if (detail.error) {
    const note = mailRefusalNote(detail.error);
    return (
      <EmptyState
        icon={note ? <Mail /> : <AlertCircle />}
        title={note?.title ?? 'Message failed to load'}
        role="status"
        action={note ? undefined : <Button variant="outline" onClick={() => void detail.refetch()}>Try again</Button>}
      >
        {note?.description ?? formatError(detail.error)}
      </EmptyState>
    );
  }

  const message = detail.data;
  const attachments = message.attachments ?? [];

  return (
    <div className="mail-detail" data-testid="mail-message-detail">
      <pre className="mail-detail__text">{message.bodyText}</pre>

      {message.bodyHtml ? (
        <p className="mail-detail__note">
          This message also has an HTML part. The plain-text part is shown above. The console does not render
          sender HTML, so nothing from the message can style or load anything inside this page.
        </p>
      ) : null}

      {attachments.length > 0 ? (
        <DetailSection title={`Attachments (${attachments.length})`}>
          <Facts
            items={attachments.map((attachment) => ({
              label: attachment.filename,
              value: `${attachment.contentType} · ${formatBytes(attachment.sizeBytes)}`,
            }))}
          />
          <p className="mail-detail__note">
            Listed from the message metadata. The daemon publishes no attachment-download verb, so these cannot be
            opened from here yet.
          </p>
        </DetailSection>
      ) : null}

      <p className="mail-detail__uid">UID: {message.uid}</p>
    </div>
  );
}
