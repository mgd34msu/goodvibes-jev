/**
 * The chat's pieces of the shell header, and the quiet notice above the
 * composer for a turn that ended somewhere other than a normal reply.
 *
 * The chat no longer draws its own title bar: ChatView portals `ChatTitle`
 * into the shell header's title slot (click to rename) and `ChatFindButton`
 * into its actions slot (design doc "App shell" and "Chat").
 */
import { Pencil, RefreshCw, Search } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { IconButton } from '../../components/ui/IconButton';

export interface ChatTitleProps {
  activeSessionId: string;
  title: string;
  isRenaming: boolean;
  draft: string;
  onStartRename: () => void;
  onDraftChange: (value: string) => void;
  onFinishRename: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}

/** The chat title in the 48 header; a click turns it into a rename field. */
export function ChatTitle({
  activeSessionId,
  title,
  isRenaming,
  draft,
  onStartRename,
  onDraftChange,
  onFinishRename,
  onKeyDown,
}: ChatTitleProps) {
  if (isRenaming) {
    return (
      <input
        className="chat-title-input"
        value={draft}
        onBlur={onFinishRename}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={onKeyDown}
        autoFocus
        aria-label="Rename chat session"
      />
    );
  }
  return (
    <h1 className="shell-header__title chat-title">
      <button
        className="chat-title-button"
        type="button"
        disabled={!activeSessionId}
        onClick={() => activeSessionId && onStartRename()}
        title={activeSessionId ? 'Rename chat' : undefined}
      >
        <span className="chat-title-button__text">{title}</span>
        {activeSessionId && <Pencil size={14} aria-hidden="true" className="chat-title-button__icon" />}
      </button>
    </h1>
  );
}

/** The header's find button: opens the glass find bar (also Ctrl F). */
export function ChatFindButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <IconButton
      label={open ? 'Close find' : 'Find in chats'}
      shortcut="Ctrl F"
      icon={<Search />}
      aria-pressed={open}
      onClick={onToggle}
      className="chat-find-toggle"
    />
  );
}

export interface ChatTurnNoticeProps {
  /** Plain words for the settled state (settledTurnLabel); '' renders nothing. */
  label: string;
  /**
   * Present only when there is something to retry (turnState === 'stream
   * paused': the built-in reconnect gave up). A real, labelled button, never a
   * hover title that touch cannot reach.
   */
  onRetryStream?: () => void;
}

export function ChatTurnNotice({ label, onRetryStream }: ChatTurnNoticeProps) {
  if (!label && !onRetryStream) return null;
  return (
    <div className="chat-status" role="status">
      {label && <span className="chat-status__text">{label}</span>}
      {onRetryStream && (
        <Button
          variant="ghost"
          size="sm"
          className="chat-status__retry"
          icon={<RefreshCw size={14} aria-hidden="true" />}
          onClick={onRetryStream}
          aria-label="Retry the live stream"
          title="Live updates are off, retry the stream"
        >
          Retry
        </Button>
      )}
    </div>
  );
}
