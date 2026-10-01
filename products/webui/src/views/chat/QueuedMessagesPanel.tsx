/**
 * QueuedMessagesPanel, messages posted while another turn is still running sit
 * queued (not yet delivered to the model) until that turn ends
 * (sessions.queuedMessages.list/edit/delete, SDK 1.8.0's interaction-wins
 * round). This panel lets the operator review, edit, or drop a queued message
 * before it is ever sent, renders nothing when there is nothing queued (the
 * common case), never a dead empty section.
 *
 * No wire event exists for this verb family yet (the same standing gap
 * fleet.* / checkpoints.* / memory.* document in lib/queries.ts), so this
 * polls while a turn is active and refetches explicitly on every mutation
 * success.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Pencil, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { IconButton } from '../../components/ui/IconButton';
import { useConfirm } from '../../components/ui/ConfirmDialog';
import { sdk } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { formatError } from '../../lib/errors';
import '../../styles/components/queued-messages.css';

export interface QueuedMessagesPanelProps {
  sessionId: string;
  /** Poll only while a turn is actually active, a queued message can only exist then. */
  active: boolean;
}

const POLL_INTERVAL_MS = 2000;

export function QueuedMessagesPanel({ sessionId, active }: QueuedMessagesPanelProps) {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState('');
  const [draftText, setDraftText] = useState('');
  const confirm = useConfirm();

  const list = useQuery({
    queryKey: queryKeys.sessionQueuedMessages(sessionId),
    queryFn: () => sdk.operator.sessions.queuedMessages.list(sessionId),
    enabled: Boolean(sessionId),
    refetchInterval: active ? POLL_INTERVAL_MS : false,
  });

  async function invalidate(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: queryKeys.sessionQueuedMessages(sessionId) });
  }

  const editMutation = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) => sdk.operator.sessions.queuedMessages.edit(sessionId, id, text),
    onSuccess: async () => {
      setEditingId('');
      setDraftText('');
      await invalidate();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => sdk.operator.sessions.queuedMessages.delete(sessionId, id),
    onSuccess: invalidate,
  });

  const messages = list.data?.messages ?? [];
  if (messages.length === 0) return confirm.element;

  return (
    <div className="queued-messages-panel" aria-label="Queued messages">
      {confirm.element}
      <p className="queued-messages-panel__note" role="note">
        <Clock size={14} aria-hidden="true" />
        Queued: will be sent once the current reply finishes. Edit or drop it before then.
      </p>
      <ul className="queued-messages-list">
        {messages.map((message) => (
          <li key={message.id} className="queued-message">
            {editingId === message.id ? (
              <form
                className="queued-message__edit-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const trimmed = draftText.trim();
                  if (trimmed) editMutation.mutate({ id: message.id, text: trimmed });
                }}
              >
                <textarea
                  value={draftText}
                  onChange={(event) => setDraftText(event.target.value)}
                  aria-label="Edit queued message"
                  rows={2}
                />
                <div className="queued-message__edit-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="queued-message__cancel-edit"
                    onClick={() => { setEditingId(''); setDraftText(''); }}
                    aria-label="Cancel editing queued message"
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    size="sm"
                    className="queued-message__save"
                    disabled={editMutation.isPending || !draftText.trim()}
                    aria-label="Save queued message"
                  >
                    Save
                  </Button>
                </div>
              </form>
            ) : (
              <>
                <span className="queued-message__text">{message.text}</span>
                <div className="queued-message__actions">
                  <IconButton
                    size="sm"
                    className="queued-message__edit"
                    label="Edit queued message"
                    icon={<Pencil />}
                    tooltipPlacement="top"
                    onClick={() => { setEditingId(message.id); setDraftText(message.text); }}
                  />
                  <IconButton
                    size="sm"
                    className="queued-message__delete"
                    label="Delete queued message"
                    icon={<Trash2 />}
                    tooltipPlacement="top"
                    disabled={deleteMutation.isPending}
                    onClick={() => {
                      void confirm.ask({
                        title: 'Drop this queued message?',
                        description: 'It is removed from the queue and never sent.',
                        confirmLabel: 'Drop message',
                        tone: 'danger',
                      }).then((confirmed) => {
                        if (confirmed) deleteMutation.mutate(message.id);
                      });
                    }}
                  />
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
      {(editMutation.isError || deleteMutation.isError) && (
        <p className="banner warning" role="alert">
          {formatError(editMutation.error ?? deleteMutation.error)}
        </p>
      )}
    </div>
  );
}
