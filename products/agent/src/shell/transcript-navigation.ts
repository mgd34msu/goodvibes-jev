/**
 * transcript-navigation.ts, the two scroll-the-transcript-somewhere actions
 * the command layer calls: jump to a bookmark, and scroll to an absolute line.
 *
 * Extracted from main.ts, which sits at the source-line cap. Both actions share
 * the same shape (flush the display, clear scroll-lock, move scrollTop, render)
 * and both need the folded-tool-group fallback described below, so they belong
 * together rather than inline among main.ts's wiring.
 */

import type { ConversationManager } from '../core/conversation.ts';
import { resolveFoldedBookmarkLine } from '../core/bookmark-navigation.ts';

export interface TranscriptNavigationDeps {
  readonly conversation: ConversationManager;
  /** Viewport height in lines, read at call time (the terminal can resize). */
  readonly getViewportHeight: () => number;
  /** Move the transcript to `line` and release scroll-lock. */
  readonly setScrollTop: (line: number) => void;
  readonly render: () => void;
  /** Surface a user-visible notice (bookmark misses). */
  readonly notify: (message: string) => void;
}

export interface TranscriptNavigators {
  readonly jumpToBookmark: (key: string) => void;
  readonly scrollToLine: (line: number) => void;
}

export function createTranscriptNavigators(deps: TranscriptNavigationDeps): TranscriptNavigators {
  const jumpToBookmark = (key: string): void => {
    deps.conversation.getDisplayBlocks();
    const block = deps.conversation.getBlockRegistry().find((entry) => entry.collapseKey === key);
    // A bookmark set on a tool result now hidden by a collapsed assistant
    // turn has no BlockMeta of its own while that turn stays collapsed (see
    // work-tree-model.ts), resolve it to the turn's header line
    // rather than reporting a false "not found".
    const line = block?.startLine ?? resolveFoldedBookmarkLine(deps.conversation, key);
    if (line === null) {
      deps.notify(`[Bookmark] Not found: ${key}`);
      deps.render();
      return;
    }
    deps.setScrollTop(Math.max(0, line));
    deps.render();
  };

  const scrollToLine = (line: number): void => {
    deps.conversation.getDisplayBlocks();
    const maxScroll = Math.max(0, deps.conversation.history.getLineCount() - deps.getViewportHeight());
    deps.setScrollTop(Math.max(0, Math.min(line, maxScroll)));
    deps.render();
  };

  return { jumpToBookmark, scrollToLine };
}
