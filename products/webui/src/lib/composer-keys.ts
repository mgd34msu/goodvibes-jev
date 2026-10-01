export interface ComposerKeyEventLike {
  key: string;
  shiftKey: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  nativeEvent?: {
    isComposing?: boolean;
  };
}

/**
 * Plain Enter: send (the daemon queues it behind an active turn). Shift+Enter
 * inserts a newline; a composing IME Enter never submits.
 */
export function shouldSubmitComposerKey(event: ComposerKeyEventLike): boolean {
  return event.key === 'Enter'
    && !event.shiftKey
    && !event.ctrlKey
    && !event.metaKey
    && event.nativeEvent?.isComposing !== true;
}

/**
 * Ctrl+Enter (or Cmd+Enter): STEER, send immediately, interrupting the
 * in-flight turn (companion.chat.messages.steer). Distinct from plain Enter,
 * which queues behind an active turn.
 */
export function shouldSteerComposerKey(event: ComposerKeyEventLike): boolean {
  return event.key === 'Enter'
    && !event.shiftKey
    && (event.ctrlKey === true || event.metaKey === true)
    && event.nativeEvent?.isComposing !== true;
}
