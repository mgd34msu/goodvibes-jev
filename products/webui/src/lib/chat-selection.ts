import type { ViewId } from './router';

export interface ChatSelection {
  readonly revision: number;
  readonly view: ViewId;
  readonly sessionId: string;
}

/** The URL owner advances this before publishing a navigation change. */
export interface ChatSelectionTracker {
  capture: () => ChatSelection;
  isCurrent: (selection: ChatSelection) => boolean;
  update: (view: ViewId, sessionId: string, explicitSession?: boolean) => void;
}

export function createChatSelectionTracker(view: ViewId, sessionId: string): ChatSelectionTracker {
  let current: ChatSelection = Object.freeze({ revision: 0, view, sessionId });
  return {
    capture: () => current,
    isCurrent: (selection) => current === selection && current.view === 'chat',
    update(nextView, nextSessionId, explicitSession = false) {
      if (!explicitSession && nextView === current.view && nextSessionId === current.sessionId) return;
      current = Object.freeze({ revision: current.revision + 1, view: nextView, sessionId: nextSessionId });
    },
  };
}
