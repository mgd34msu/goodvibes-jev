/**
 * Mail, the Mail tab of Personal: a two-pane inbox (messages left, the open
 * message right) with a compose panel that floats from the lower right, over
 * the daemon's four `email.*` verbs. The web UI is mail's first screen, exactly
 * as it was calendar's.
 *
 * WHY THIS EXISTS: `email.inbox.list`, `email.inbox.read`, `email.draft.create`
 * and `email.send` have been in the operator contract and in the generated
 * WEBUI_METHOD_ROUTES table since before the SDK pin this repo was stuck on, the
 * routing was always there and no surface ever rendered it. This view is wiring
 * over capability the daemon already publishes, not an integration: there is no
 * IMAP client, no SMTP client, no OAuth flow and no credential handling anywhere
 * in this file or anything it imports. Every call is `sdk.operator.email.*`. The
 * browser never holds a mail credential because it never has one to hold.
 *
 * HONESTY CONTRACT (mail-refusal.ts owns the classification; three shapes, each
 * rendered distinctly, never folded into a generic "error"):
 *  1. NOT AVAILABLE, 404/501. This daemon build has no mail handler wired. The
 *     tab is one empty state: what is missing, what fixes it, one action. There
 *     is no form to fill in for a capability that cannot answer.
 *  2. NEEDS SETUP, a 412 precondition refusal. The handler exists; no account
 *     has been brought. Points at settings, which writes through the daemon.
 *  3. GENUINE ERROR, anything else, an empty state with retry.
 * There is deliberately no fourth "maybe it's just empty" reading. An inbox that
 * really is empty is a successful response with `messages: []`, and renders as
 * an empty state that says so, never as a refusal, and never the other way round.
 *
 * NEVER A DEAD BUTTON: while the surface is refusing, Compose does not render at
 * all, so nothing invites an action that cannot land.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertCircle, AlertTriangle, Inbox, Mail, Pencil, RefreshCw, Reply } from 'lucide-react';
import { sdk } from '../../lib/goodvibes';
import type { EmailDraftCreateInput, EmailSendInput, EmailUnreadableMessage } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { formatError } from '../../lib/errors';
import ErrorBoundary from '../../components/feedback/ErrorBoundary';
import { useToast } from '../../lib/toast';
import { useConfirm } from '../../components/ui/ConfirmDialog';
import { DetailPane, EmptyState, ListDetail, SkeletonRows } from '../../components/data-view/DataView';
import { Button, Checkbox, IconButton, Row, RowList, Select, StatusDot } from '../../components/ui';
import { DateField } from '../../components/ui/DateField';
import { mailRefusalNote } from '../../lib/mail-refusal';
import { sortInboxMessagesByUidDescending } from '../../lib/mail-order';
import { PersonalPage } from '../personal/PersonalPage';
import { openSettingsSection } from '../personal/openSettings';
import { MailCompose } from './MailCompose';
import { MailMessageBody, useMailMessage } from './MailMessagePeek';
import '../../styles/components/mail.css';
import { whenLabel } from '../../lib/when-label';
import { nonEmpty } from '../../lib/non-empty';

const LIMIT_OPTIONS = [
  { value: '25', label: '25 messages' },
  { value: '50', label: '50 messages' },
  { value: '100', label: '100 messages' },
] as const;

/**
 * The messages the daemon could not parse, and why.
 *
 * Rendered rather than counted: "3 messages could not be read" tells an operator
 * nothing they can act on, while the per-message detail the daemon already sends
 * ("unsupported encoding", "malformed header") is the thing that says whether it
 * is one broken sender or a whole account misconfigured. `uid` is optional on the
 * wire, a message can fail before its uid is known, so it is only shown when
 * present rather than rendered as "undefined".
 */
function UnreadableNote({ items }: { items: readonly EmailUnreadableMessage[] }) {
  if (items.length === 0) return null;
  return (
    <div className="dv-notice dv-notice--warn mail-unreadable" role="status" data-testid="mail-unreadable">
      <AlertTriangle aria-hidden="true" />
      <div>
        <p className="mail-unreadable__title">
          {items.length === 1 ? '1 message could not be read' : `${String(items.length)} messages could not be read`}
        </p>
        <ul>
          {items.map((item, index) => (
            <li key={item.uid ?? `no-uid-${String(index)}`}>
              {item.uid === undefined ? item.detail : `uid ${String(item.uid)}: ${item.detail}`}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function normalizeRecipients(value: string): string {
  return value.split(',').map((part) => part.trim()).filter(Boolean).join(', ');
}

function formatWhen(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : whenLabel(parsed.getTime()) || iso;
}

/** A compact date for a list row: the time today, the month and day otherwise. */
function formatShort(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const sameDay = parsed.toDateString() === new Date().toDateString();
  return sameDay
    ? parsed.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export interface MailViewProps {
  /** The Personal tab switcher; shown first in the filter row. */
  tabs?: ReactNode;
}

export function MailView({ tabs }: MailViewProps = {}) {
  // Deliberately no queryClient/invalidation here. Neither write touches the inbox:
  // email.send puts a message in the recipient's mailbox, and email.draft.create
  // appends to the account's Drafts folder, the inbox listing this view caches is
  // unchanged by both, and the read verb is BODY.PEEK so opening a message does not
  // flip its unread flag either. Invalidating anyway would refetch the whole inbox to
  // redraw identical rows and would quietly imply a relationship that is not there.
  const { toast } = useToast();
  const confirm = useConfirm();

  const [limit, setLimit] = useState('25');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [since, setSince] = useState('');
  const [selectedUid, setSelectedUid] = useState<number | null>(null);

  const [composeOpen, setComposeOpen] = useState(false);
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [inReplyTo, setInReplyTo] = useState('');

  const inbox = useQuery({
    queryKey: queryKeys.emailInbox(Number(limit), unreadOnly, since),
    queryFn: () =>
      sdk.operator.email.inbox.list({
        limit: Number(limit),
        ...(unreadOnly ? { unreadOnly: true } : {}),
        ...(since ? { since: new Date(`${since}T00:00:00.000Z`).toISOString() } : {}),
      }),
  });
  const detail = useMailMessage(selectedUid);

  const inboxNote = inbox.error ? mailRefusalNote(inbox.error) : null;
  // Sending follows the inbox's verdict: if listing is refused, sending is too (same
  // surface, same daemon state). A control whose availability is not yet known must
  // not look available, so Compose also waits for the first answer.
  const surfaceRefusing = Boolean(inboxNote) || inbox.isPending;

  function clearComposer(): void {
    setTo('');
    setSubject('');
    setBody('');
    setInReplyTo('');
    setComposeOpen(false);
  }

  const send = useMutation({
    mutationFn: () => {
      const input: EmailSendInput = {
        to: normalizeRecipients(to),
        subject: subject.trim(),
        body,
        // Literal true, and only reached after the confirmation sheet resolved, the
        // SDK marks this verb dangerous and irreversible, so the flag is set because
        // the operator saw the recipients and agreed, never on their behalf.
        confirm: true,
        ...(inReplyTo ? { inReplyTo } : {}),
      };
      return sdk.operator.email.send(input);
    },
    onSuccess: (result) => {
      clearComposer();
      toast({ title: 'Message sent', description: `Sent ${formatWhen(result.sentAt)} · ${result.messageId}`, tone: 'success' });
    },
    onError: (error) => {
      const note = mailRefusalNote(error);
      toast({ title: note?.title ?? 'Send failed', description: note?.description ?? formatError(error), tone: 'danger' });
    },
  });

  const saveDraft = useMutation({
    mutationFn: () => {
      const input: EmailDraftCreateInput = {
        to: normalizeRecipients(to),
        subject: subject.trim(),
        body,
        ...(inReplyTo ? { inReplyTo, references: inReplyTo } : {}),
      };
      return sdk.operator.email.draft.create(input);
    },
    onSuccess: (result) => {
      clearComposer();
      toast({
        title: 'Draft saved to the account',
        description: `Appended to the IMAP Drafts folder as UID ${result.uid}. It is in the mailbox itself, so it is there in any mail client, not only here.`,
        tone: 'success',
      });
    },
    onError: (error) => {
      const note = mailRefusalNote(error);
      toast({ title: note?.title ?? 'Draft failed', description: note?.description ?? formatError(error), tone: 'danger' });
    },
  });

  const messages = inbox.data?.messages;
  // Ordered by `uid` (server-assigned) descending, NEVER by `date` (sender-written,
  // sorting on it would let a sender pin their message to the top with a far-future
  // Date: header). Full rationale in mail-order.ts; do not "simplify" this to `date`.
  const sorted = useMemo(() => sortInboxMessagesByUidDescending(messages ?? []), [messages]);
  // Messages the account returned but the daemon could not parse, each with its own
  // reason. The contract has always carried this list, and they are shown even when
  // every message in the window is unreadable, where the list would otherwise
  // report a normal empty inbox.
  const unreadable = inbox.data?.unreadable ?? [];

  const composerReady = to.trim() !== '' && subject.trim() !== '' && body.trim() !== '';

  function startReply(message: { subject: string; from: string; messageId: string }): void {
    setTo(message.from);
    setSubject(message.subject.startsWith('Re: ') ? message.subject : `Re: ${message.subject}`);
    setInReplyTo(message.messageId);
    setBody('');
    setComposeOpen(true);
  }

  async function submitSend(): Promise<void> {
    if (!composerReady || surfaceRefusing) return;
    const recipients = normalizeRecipients(to);
    const agreed = await confirm.ask({
      title: 'Send this message?',
      target: recipients,
      description: 'It leaves the account right away and cannot be recalled.',
      confirmLabel: 'Send',
      tone: 'danger',
    });
    if (agreed) send.mutate();
  }

  const filters = inboxNote ? undefined : (
    <>
      <Select
        value={limit}
        onChange={setLimit}
        options={LIMIT_OPTIONS}
        aria-label="Number of messages to fetch"
      />
      <DateField value={since} onChange={setSince} aria-label="Only messages on or after this date" />
      <Checkbox checked={unreadOnly} onChange={setUnreadOnly}>Unread only</Checkbox>
      <div className="dv-filters__end">
        <IconButton label="Refresh inbox" icon={<RefreshCw />} onClick={() => void inbox.refetch()} />
      </div>
    </>
  );

  const action = surfaceRefusing
    ? undefined
    : (
      <Button
        variant="primary"
        icon={<Pencil />}
        onClick={() => {
          if (!composeOpen) setComposeOpen(true);
        }}
      >
        Compose
      </Button>
    );

  let content: ReactNode;
  if (inbox.isPending) {
    content = <SkeletonRows count={6} label="Loading inbox" />;
  } else if (inboxNote) {
    const notAvailable = inboxNote.kind === 'not-available';
    content = (
      <div data-testid={`mail-note-${inboxNote.kind}`}>
        <EmptyState
          icon={<Mail />}
          title={notAvailable ? 'Mail isn’t connected yet' : inboxNote.title}
          role="status"
          action={notAvailable
            ? <Button variant="outline" onClick={() => openSettingsSection('about')}>Update daemon</Button>
            : <Button variant="outline" onClick={() => openSettingsSection('account')}>Open settings</Button>}
        >
          {notAvailable
            ? 'This daemon doesn’t serve mail. Updating the daemon adds it, and your inbox shows up here with nothing else to set up.'
            : inboxNote.description}
        </EmptyState>
      </div>
    );
  } else if (inbox.error) {
    content = (
      <EmptyState
        icon={<AlertCircle />}
        title="Inbox failed to load"
        role="status"
        action={<Button variant="outline" onClick={() => void inbox.refetch()}>Try again</Button>}
      >
        {formatError(inbox.error)}
      </EmptyState>
    );
  } else if (sorted.length === 0) {
    content = (
      <>
        <EmptyState
          icon={<Inbox />}
          title={unreadable.length > 0 ? 'Nothing readable in the inbox' : 'Nothing in the inbox'}
        >
          {unreadable.length > 0
            ? 'Every message in this window failed to parse. They are listed below with the reason each one gave.'
            : unreadOnly
              ? 'No unread messages match this window. Clear the unread filter to see the rest.'
              : 'The account answered normally with no messages in this window.'}
        </EmptyState>
        <UnreadableNote items={unreadable} />
      </>
    );
  } else {
    const list = (
      <div data-testid="mail-list">
        <p className="mail-count">
          Showing {sorted.length} of {inbox.data?.total ?? sorted.length} messages the account reported.
        </p>
        <UnreadableNote items={unreadable} />
        <RowList aria-label="Inbox">
          {sorted.map((message) => (
            <Row
              key={message.uid}
              className={message.unread ? 'mail-row mail-row--unread' : 'mail-row'}
              leading={<span className="mail-row__lead">{message.unread ? <StatusDot tone="info" srLabel="Unread" /> : null}</span>}
              title={message.subject || '(no subject)'}
              meta={`${message.from} · ${message.bodyPreview}`}
              selected={message.uid === selectedUid}
              onSelect={() => setSelectedUid(message.uid)}
              trailing={<span className="mail-row__date">{formatShort(message.date)}</span>}
            />
          ))}
        </RowList>
      </div>
    );
    content = (
      <ListDetail
        mode="peek"
        list={list}
        detailOpen={selectedUid !== null}
        onCloseDetail={() => setSelectedUid(null)}
        listLabel="Inbox"
        detailLabel="Message"
        backLabel="Inbox"
        detail={(
          <DetailPane
            title={nonEmpty(detail.data?.subject) ?? (detail.isPending ? 'Message' : '(no subject)')}
            meta={detail.data ? `${detail.data.from} · ${formatWhen(detail.data.date)}` : undefined}
            actions={detail.data ? (
              <Button
                variant="outline"
                size="sm"
                icon={<Reply />}
                onClick={() => {
                  const message = detail.data;
                  if (message) startReply({ subject: message.subject, from: message.from, messageId: message.messageId });
                }}
              >
                Reply
              </Button>
            ) : undefined}
            onClose={() => setSelectedUid(null)}
            closeLabel="Close message"
          >
            <MailMessageBody detail={detail} />
          </DetailPane>
        )}
      />
    );
  }

  return (
    <ErrorBoundary
      fallback={(err, reset) => (
        <EmptyState icon={<AlertCircle />} title="Mail view failed" action={<Button variant="outline" onClick={reset}>Try again</Button>}>
          {formatError(err)}
        </EmptyState>
      )}
    >
      <div className="mail-view" data-testid="mail-view">
        <PersonalPage tabs={tabs} filters={filters} action={action}>
          {content}
        </PersonalPage>
        {composeOpen && !surfaceRefusing ? (
          <MailCompose
            to={to}
            subject={subject}
            body={body}
            inReplyTo={inReplyTo}
            onToChange={setTo}
            onSubjectChange={setSubject}
            onBodyChange={setBody}
            onClearReply={() => setInReplyTo('')}
            onSend={() => void submitSend()}
            onSaveDraft={() => saveDraft.mutate()}
            onClose={() => setComposeOpen(false)}
            ready={composerReady}
            sending={send.isPending}
            saving={saveDraft.isPending}
          />
        ) : null}
        {confirm.element}
      </div>
    </ErrorBoundary>
  );
}
