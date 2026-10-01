import { RefObject, type ReactNode } from 'react';
import { ArrowDown, Square, X } from 'lucide-react';
import { MarkdownMessage } from '../../components/MarkdownMessage';
import { Spark } from '../../components/shell/Spark';
import { useReducedMotion } from '../../components/motion/useReducedMotion';
import { MessageItem } from './MessageItem';
import { lineageNodeKey, type LineageNode } from './lineage';
import { bestId } from './message-utils';
import type { ChatMessage } from './types';
import type { ActiveToolCall } from './useChatStream';
import '../../styles/components/chat-stream.css';

interface MessageListProps {
  /** Honest-lineage render nodes: active messages with any retained history attached. */
  nodes: LineageNode[];
  liveText: string;
  showJumpToBottom: boolean;
  isSendPending: boolean;
  /** Whether a turn is actively streaming (running | streaming | tooling). */
  isStreaming?: boolean;
  copiedMessageId: string;
  /** Id of the message to flash-highlight (search jump-to-message target), or '' for none. */
  highlightedMessageId?: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  onJumpToBottom: () => void;
  onCopyMessage: (message: ChatMessage) => void;
  onResendMessage: (message: ChatMessage) => void;
  onRegenerateFrom: (messageId: string) => void;
  /** Called when the user submits an edited version of a user message. */
  onEditMessage?: (messageId: string, newText: string) => void;
  /** Called when the user clicks the Stop button during an active stream. */
  onStop?: () => void;
  /** Tool calls currently running for the active turn (useChatStream's ActiveToolCall). */
  activeToolCalls?: readonly ActiveToolCall[];
  /** Cancel ONE running tool call, the turn itself continues (unlike onStop, which ends it). */
  onCancelToolCall?: (callId: string) => void;
  /**
   * What the working line under the last message says ("Thinking…", "Reading
   * 2 files…"); see workingStatusLabel. Empty falls back to "Thinking…".
   */
  workingLabel?: string;
  /** Rendered before the first message (the new-chat greeting). */
  lead?: ReactNode;
}

export function MessageList({
  nodes,
  liveText,
  showJumpToBottom,
  isSendPending,
  isStreaming = false,
  copiedMessageId,
  highlightedMessageId = '',
  scrollRef,
  onScroll,
  onJumpToBottom,
  onCopyMessage,
  onResendMessage,
  onRegenerateFrom,
  onEditMessage,
  onStop,
  activeToolCalls = [],
  onCancelToolCall,
  workingLabel = '',
  lead,
}: MessageListProps) {
  const reducedMotion = useReducedMotion();
  // Stop must be reachable for the WHOLE active turn, including the
  // pre-first-token window (model thinking, long tool calls), where there is
  // no liveText yet. Requiring text here used to make a turn unstoppable
  // until it started talking.
  const showStreamControls = isStreaming;

  return (
    <div className="chat-thread">
      <div className="messages chat-conversation" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-column">
          {lead}
          {nodes.map((node, index) => (
            <MessageItem
              key={lineageNodeKey(node, index)}
              message={node.message}
              index={index}
              isSendPending={isSendPending}
              copiedMessageId={copiedMessageId}
              priorMessages={node.priorMessages}
              reason={node.reason}
              revisionOf={node.revisionOf}
              isHighlighted={highlightedMessageId !== '' && bestId(node.message) === highlightedMessageId}
              onCopyMessage={onCopyMessage}
              onResendMessage={onResendMessage}
              onRegenerateFrom={onRegenerateFrom}
              onEditMessage={onEditMessage ? (_msg, newText) => onEditMessage(node.message.id ?? node.message.messageId ?? '', newText) : undefined}
            />
          ))}
          {(liveText || isStreaming) && (
            <div aria-live="polite" aria-atomic="false">
              <article className="message assistant streaming">
                <span className="message-mark" aria-hidden="true"><Spark size={18} /></span>
                <div className="message-body">
                  {liveText && (
                    <div className="message-bubble">
                      <MarkdownMessage content={liveText} />
                      {showStreamControls && (
                        <span
                          className={`stream-caret${reducedMotion ? ' stream-caret--reduced' : ''}`}
                          aria-hidden="true"
                        />
                      )}
                    </div>
                  )}
                  {showStreamControls && (
                    // One line naming what is happening right now; it shimmers (the
                    // only animated text in the product) and holds still with
                    // reduced motion. Stop sits at its end for the whole turn,
                    // including the window before the first token.
                    <div className="chat-working">
                      <span
                        className={`chat-working__label${reducedMotion ? ' chat-working__label--still' : ''}`}
                      >
                        {workingLabel || 'Thinking…'}
                      </span>
                      {onStop && (
                        <button
                          type="button"
                          className="stream-stop-btn"
                          onClick={onStop}
                          aria-label="Stop generating"
                        >
                          <Square size={10} aria-hidden="true" />
                          Stop
                        </button>
                      )}
                    </div>
                  )}
                  {/* Running tool calls. Cancel ONE call without ending the turn. The
                      cancelled result renders honestly (a "Cancelled" label replaces the
                      button) until the daemon's own turn.tool_result actually clears it. */}
                  {activeToolCalls.length > 0 && (
                    <ul className="active-tool-calls" aria-label="Running tool calls">
                      {activeToolCalls.map((call) => (
                        <li key={call.toolCallId} className="active-tool-call">
                          <span className="active-tool-call__name">
                            {call.cancelled ? 'Cancelled: ' : 'Running: '}{call.toolName || call.toolCallId}
                          </span>
                          {!call.cancelled && onCancelToolCall && (
                            <button
                              type="button"
                              className="active-tool-call__cancel"
                              onClick={() => onCancelToolCall(call.toolCallId)}
                              aria-label={`Cancel tool call ${call.toolName || call.toolCallId}`}
                            >
                              <X size={12} aria-hidden="true" /> Cancel
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </article>
            </div>
          )}
        </div>
      </div>
      {showJumpToBottom && (
        <button
          type="button"
          className="jump-to-bottom glass"
          onClick={onJumpToBottom}
          aria-label="Jump to latest message"
          title="Jump to latest message"
        >
          <ArrowDown size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
