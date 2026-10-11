import { Check, Clock, Copy, Layers, Paperclip, Pencil, RotateCcw, X } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import type { ChatMessage } from './types';
import type { SupersededReason } from './lineage';
import { MessageLineage, messageIsEdited } from './MessageLineage';
import { useArtifactsPanel } from './ArtifactsPanel';
import { MarkdownMessage } from '../../components/MarkdownMessage';
import { SpeakButton } from '../../components/voice/SpeakButton';
import { MemoryProvenanceChip } from './MemoryProvenanceChip';
import { ToolActivityGroup } from './ToolActivityGroup';
import { readMemoryProvenanceIds } from '../../lib/memory-provenance';
import { useWebUiPreferences } from '../../lib/ui-preferences';
import { asRecord } from '../../lib/object';
import { isCompactionHandoffMessage } from '../../lib/compaction';
import {
  attachmentLabel,
  attachmentMeta,
  deliveryState,
  messageAttachments,
  messageText,
  messageTone,
  messageTimeMs,
  messageTimestamp,
  messageTimestampTitle,
  bestId,
} from './message-utils';
import { Button } from '../../components/ui/Button';
import { IconButton } from '../../components/ui/IconButton';
import { Spark } from '../../components/shell/Spark';
import '../../styles/components/chat-actions.css';

interface MessageItemProps {
  message: ChatMessage;
  index: number;
  isSendPending: boolean;
  copiedMessageId: string;
  /** Superseded messages retained behind this message's fork, oldest first. */
  priorMessages?: readonly ChatMessage[];
  /** Why the retained run was superseded ('regenerate' | 'edit'). */
  reason?: SupersededReason;
  /** The original message id when this message replaced an edited one. */
  revisionOf?: string;
  /** True when this message is the current search jump-to-message target, flashes a brief highlight. */
  isHighlighted?: boolean;
  onCopyMessage: (message: ChatMessage) => void;
  onResendMessage: (message: ChatMessage) => void;
  onRegenerateFrom: (messageId: string) => void;
  /** Called when the user submits an edited version of a user message. */
  onEditMessage?: (message: ChatMessage, newText: string) => void;
}

export function MessageItem({
  message,
  index,
  isSendPending,
  copiedMessageId,
  priorMessages,
  reason,
  revisionOf,
  isHighlighted = false,
  onCopyMessage,
  onResendMessage,
  onRegenerateFrom,
  onEditMessage,
}: MessageItemProps) {
  const id = bestId(message) || `${index}`;
  const tone = messageTone(message);
  const state = deliveryState(message);
  const text = messageText(message);
  const { openArtifacts } = useArtifactsPanel();
  const canRetry = Boolean(text) && (tone === 'user' || tone === 'assistant');
  // Never an epoch or "unknown" time: a missing or zero time shows nothing.
  const timestamp = messageTimestamp(message);
  const timestampTitle = messageTimestampTitle(message);
  const timeMs = messageTimeMs(message);
  const timeIso = timeMs === null ? undefined : new Date(timeMs).toISOString();
  const attachments = messageAttachments(message);
  const isEdited = messageIsEdited(reason, revisionOf);
  const [{ memoryProvenanceChipEnabled }] = useWebUiPreferences();
  const memoryProvenanceIds = readMemoryProvenanceIds(message.metadata);

  // ---------------------------------------------------------------------------
  // Inline edit state (user messages only)
  // ---------------------------------------------------------------------------
  const [isEditing, setIsEditing] = useState(false);
  const [editDraft, setEditDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleEditStart = useCallback(() => {
    setEditDraft(text);
    setIsEditing(true);
    // Focus textarea on next tick after render
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [text]);

  const handleEditCancel = useCallback(() => {
    setIsEditing(false);
    setEditDraft('');
  }, []);

  const handleEditSubmit = useCallback(() => {
    const trimmed = editDraft.trim();
    if (!trimmed || isSendPending) return;
    onEditMessage?.(message, trimmed);
    setIsEditing(false);
    setEditDraft('');
  }, [editDraft, isSendPending, message, onEditMessage]);

  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleEditSubmit();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        handleEditCancel();
      }
    },
    [handleEditSubmit, handleEditCancel],
  );

  const isAssistant = tone === 'assistant';
  const toolActivity = isAssistant && message.toolActivity && message.toolActivity.length > 0 ? message.toolActivity : null;
  // Quiet in the hover row; states that need attention (not sent, pending,
  // stopped, queued) stay visible without hovering.
  const persistentState = state !== '' && state !== 'sent';

  const content = isEditing && tone === 'user' ? (
    <div className="message-edit-area">
      <textarea
        ref={textareaRef}
        className="message-edit-textarea"
        value={editDraft}
        onChange={(e) => setEditDraft(e.target.value)}
        onKeyDown={handleEditKeyDown}
        aria-label="Edit message"
        rows={3}
      />
      <div className="message-edit-actions">
        <Button variant="ghost" size="sm" className="message-edit-cancel" onClick={handleEditCancel} aria-label="Cancel edit">
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          className="message-edit-submit"
          onClick={handleEditSubmit}
          disabled={!editDraft.trim() || isSendPending}
          aria-label="Send edited message (Ctrl+Enter)"
        >
          Send
        </Button>
      </div>
    </div>
  ) : (
    <div className="message-bubble">
      {text && tone === 'user' && isCompactionHandoffMessage(text) ? (
        // Compactor-authored continuation, not typed input: folded by
        // default so the re-injected instruction wall doesn't repeat in
        // the transcript after every automatic compaction.
        <details className="message-compaction-handoff">
          <summary>Compaction handoff: context re-injected after auto-compaction ({text.split('\n').length} lines)</summary>
          <MarkdownMessage content={text} source={message.sessionId && message.id ? { sessionId: message.sessionId, messageId: message.id } : undefined} />
        </details>
      ) : (
        text && <MarkdownMessage content={text} source={message.sessionId && message.id ? { sessionId: message.sessionId, messageId: message.id } : undefined} />
      )}
      {attachments.length > 0 && (
        <div className="message-attachments">
          {attachments.map((attachment, attachmentIndex) => (
            <div key={`${id}-attachment-${attachmentIndex}`} className="message-attachment">
              <Paperclip size={14} aria-hidden="true" />
              <div>
                <strong>{attachmentLabel(attachment)}</strong>
                {attachmentMeta(attachment) && <span>{attachmentMeta(attachment)}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
      {!text && attachments.length === 0 && <p>{JSON.stringify(asRecord(message))}</p>}
    </div>
  );

  const footer = (
    <div className={`message-actions${persistentState ? ' message-actions--state' : ''}`}>
      <div className="message-actions-inner">
        {/* Delivery indicator */}
        {state && (
          <span
            className={`delivery-indicator ${state}`}
            title={
              state === 'failed' ? 'Not sent'
                : state === 'local' ? 'Pending'
                  : state === 'cancelled' ? 'Stopped before completion: this is the partial reply that existed when the turn was stopped'
                    : state === 'queued' ? 'Queued: will run after the current reply finishes'
                      : 'Sent'
            }
          >
            {state === 'failed' ? <><X size={12} aria-hidden="true" /> Not sent</>
              : state === 'cancelled' ? <><X size={12} aria-hidden="true" /> Stopped</>
                : state === 'queued' ? <><Clock size={12} aria-hidden="true" /> Queued</>
                  : state === 'local' ? <><Clock size={12} aria-hidden="true" /> Sending</>
                    : <Check size={12} aria-label="Sent" />}
          </span>
        )}

        {(timestamp || isEdited) && (
          <span className="message-meta">
            {timestamp && <time dateTime={timeIso} title={timestampTitle}>{timestamp}</time>}
            {isEdited && <span className="message-meta__edited">{timestamp ? ' · ' : ''}Edited</span>}
          </span>
        )}

        <span className="message-actions__buttons">
          <IconButton
            size="sm"
            label="Copy message"
            icon={copiedMessageId === id ? <Check /> : <Copy />}
            tooltipPlacement="top"
            onClick={() => onCopyMessage(message)}
          />

          {/* Edit and branch (user messages only): the edited text becomes a new
              branch; the original stays as retained history. */}
          {tone === 'user' && canRetry && !isEditing && onEditMessage !== undefined && (
            <IconButton
              size="sm"
              label="Edit and resend message"
              icon={<Pencil />}
              tooltipPlacement="top"
              disabled={isSendPending}
              onClick={handleEditStart}
            />
          )}

          {/* Resend / Regenerate */}
          {canRetry && !isEditing && (
            <IconButton
              size="sm"
              label={isAssistant ? 'Regenerate response' : 'Resend message'}
              icon={<RotateCcw />}
              tooltipPlacement="top"
              disabled={isSendPending}
              onClick={() => (isAssistant ? onRegenerateFrom(id) : onResendMessage(message))}
            />
          )}

          {/* Read aloud. Spoken output for assistant replies (honest states inside) */}
          {isAssistant && text && <SpeakButton messageId={message.id ?? id} sessionId={message.sessionId} text={text} />}

          {/* Artifacts: opens the side panel with this reply's code blocks and files */}
          {isAssistant && (text || attachments.length > 0) && (
            <IconButton
              size="sm"
              label="View artifacts from this message"
              icon={<Layers />}
              tooltipPlacement="top"
              className="message-action-artifacts"
              onClick={() => openArtifacts(message)}
            />
          )}
        </span>

        {/* Copied label, announced */}
        {copiedMessageId === id && <span className="message-action-label" role="status">Copied</span>}
      </div>
    </div>
  );

  return (
    <article
      className={`message ${tone}${isHighlighted ? ' message--search-highlight' : ''}`}
      data-message-id={id}
    >
      {isAssistant && <span className="message-mark" aria-hidden="true"><Spark size={18} /></span>}
      <div className="message-body">
        {/* Honest-lineage disclosure: when this message heads a fork, reveal the retained
            (superseded) history rather than pretending it is gone. */}
        <MessageLineage priorMessages={priorMessages} reason={reason} revisionOf={revisionOf} />
        {toolActivity && <ToolActivityGroup toolActivity={toolActivity} />}
        {content}
        {footer}
        {/* Memory provenance. Owner-ruled, default OFF (see ui-preferences.ts). Renders
            nothing when the preference is off or this turn used no memories. */}
        {isAssistant && memoryProvenanceChipEnabled && memoryProvenanceIds.length > 0 && (
          <MemoryProvenanceChip recordIds={memoryProvenanceIds} />
        )}
      </div>
    </article>
  );
}
