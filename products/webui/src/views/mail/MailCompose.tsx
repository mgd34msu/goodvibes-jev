/**
 * The compose panel: glass, fixed to the lower right of the window (480 wide at
 * most, 16 radius), a bottom sheet across the full width on phones. It floats
 * over the inbox the way a mail app's compose window does, so the list and the
 * open message stay in view while you write.
 */
import { forwardRef, useImperativeHandle, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { Send, X } from 'lucide-react';
import { Button, Field, IconButton, Input, Textarea } from '../../components/ui';
import { useModalFocus, useOverlayLayer, useTopLayerEscape } from '../../components/ui/overlay';

export interface MailComposeProps {
  to: string;
  subject: string;
  body: string;
  inReplyTo: string;
  onToChange: (value: string) => void;
  onSubjectChange: (value: string) => void;
  onBodyChange: (value: string) => void;
  onClearReply: () => void;
  onSend: () => void;
  onSaveDraft: () => void;
  onClose: () => void;
  ready: boolean;
  sending: boolean;
  saving: boolean;
  replySubjectState?: 'pending' | 'held' | undefined;
}

export interface MailComposeHandle {
  /** An explicit Compose/Reply action returns to writing in the existing panel. */
  focus: (field: 'to' | 'body') => void;
}

export const MailCompose = forwardRef<MailComposeHandle, MailComposeProps>(function MailCompose({
  to,
  subject,
  body,
  inReplyTo,
  onToChange,
  onSubjectChange,
  onBodyChange,
  onClearReply,
  onSend,
  onSaveDraft,
  onClose,
  ready,
  sending,
  saving,
  replySubjectState,
}, ref) {
  const panelRef = useRef<HTMLElement | null>(null);
  const toRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  // Start where the writing is: the recipient for a new message, the body for a reply.
  // Keep the initial target stable while typing, and return focus to the opener on close.
  const [startsWithRecipient] = useState(() => to.trim() !== '');
  useModalFocus(true, panelRef, startsWithRecipient ? bodyRef : toRef, { recoverFocus: false });
  const isTop = useOverlayLayer(true);
  useTopLayerEscape(true, isTop, onClose);
  useImperativeHandle(ref, () => ({
    focus(field) {
      (field === 'body' ? bodyRef.current : toRef.current)?.focus({ preventScroll: true });
    },
  }), []);

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (ready) onSend();
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  }

  if (typeof document === 'undefined') return null;

  // Share the kit's body-level overlay plane: the message drawer must stay below
  // its reply, and a subsequently opened Send confirmation must stay above it.
  return createPortal(
    <section ref={panelRef} className="glass mail-compose" role="dialog" aria-label="Compose message" onKeyDown={onKeyDown} data-gv-layer="" data-testid="mail-compose">
      <header className="mail-compose__header">
        <h3 className="mail-compose__title">{inReplyTo ? 'Reply' : 'New message'}</h3>
        <IconButton label="Close compose" icon={<X />} onClick={onClose} size="sm" />
      </header>
      <form className="mail-compose__form" onSubmit={submit}>
        <Field label="To">
          <Input ref={toRef} value={to} onChange={(event) => onToChange(event.target.value)} placeholder="someone@example.com, another@example.com" />
        </Field>
        <Field label="Subject">
          <Input value={subject} onChange={(event) => onSubjectChange(event.target.value)} />
        </Field>
        {replySubjectState ? (
          <p role="status" className="mail-compose__reply" data-testid="mail-reply-subject-status">
            {replySubjectState === 'pending'
              ? 'Preparing the reply subject. You can enter a subject yourself to continue.'
              : 'The reply subject could not be prepared. Enter a subject to continue.'}
          </p>
        ) : null}
        <Field label="Message">
          <Textarea ref={bodyRef} value={body} onChange={(event) => onBodyChange(event.target.value)} rows={8} />
        </Field>
        {inReplyTo ? (
          <p className="mail-compose__reply">
            Replying to <code>{inReplyTo}</code>
            <Button variant="ghost" size="sm" onClick={onClearReply}>Clear reply threading</Button>
          </p>
        ) : null}
        <div className="mail-compose__actions">
          <Button variant="primary" type="submit" icon={<Send />} disabled={!ready || sending}>
            {sending ? 'Sending…' : 'Send'}
          </Button>
          <Button variant="outline" disabled={!ready || saving} onClick={onSaveDraft}>
            {saving ? 'Saving…' : 'Save draft to account'}
          </Button>
        </div>
      </form>
    </section>,
    document.body,
  );
});
