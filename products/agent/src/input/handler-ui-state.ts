import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
import type { InfiniteBuffer } from '@goodvibes-jev/engine/terminal-shell';
import type { SearchManager } from './search.ts';
import type { ConversationManager } from '../core/conversation.ts';
import type { HistorySearch } from './input-history.ts';
import type { OverlayFilter, OverlayFilters } from './overlay-filter.ts';
import { isTextBackspace } from '@goodvibes-jev/engine/terminal-shell';

export type ActiveModalState = {
  helpOverlayActive: boolean;
  shortcutsOverlayActive: boolean;
  bookmarkModal: { active: boolean; close: () => void };
  liveTailModal: { active: boolean; close: () => void };
  settingsModal: { active: boolean; close: () => void };
  mcpWorkspace?: { active: boolean; close: () => void; reopen: () => void };
  agentWorkspace?: { active: boolean; close: () => void; reopen: () => void };
  sessionPickerModal: { active: boolean; close: () => void };
  profilePickerModal: { active: boolean; close: () => void };
  contextInspectorModal: { active: boolean; close: () => void };
  processModal: { active: boolean; close: () => void };
  modelPicker: { active: boolean; close: () => void };
  filePicker: { active: boolean; close: () => void };
  blockActionsMenu: { active: boolean; close: () => void };
  selectionModal: { active: boolean; close: () => void };
  commandMode: boolean;
};

export function getActiveModalName(state: ActiveModalState): string | null {
  if (state.helpOverlayActive) return 'help';
  if (state.shortcutsOverlayActive) return 'shortcuts';
  if (state.bookmarkModal.active) return 'bookmark';
  if (state.liveTailModal.active) return 'liveTail';
  if (state.settingsModal.active) return 'settings';
  if (state.mcpWorkspace?.active) return 'mcpWorkspace';
  if (state.agentWorkspace?.active) return 'agentWorkspace';
  if (state.sessionPickerModal.active) return 'sessionPicker';
  if (state.profilePickerModal.active) return 'profilePicker';
  if (state.contextInspectorModal.active) return 'contextInspector';
  if (state.processModal.active) return 'process';
  if (state.modelPicker.active) return 'modelPicker';
  if (state.filePicker.active) return 'filePicker';
  if (state.blockActionsMenu.active) return 'blockActions';
  if (state.selectionModal.active) return 'selection';
  if (state.commandMode) return 'command';
  return null;
}

export type ModalCloseOps = {
  resetHelp: () => void;
  resetShortcuts: () => void;
  closeBookmark: () => void;
  closeLiveTail: () => void;
  closeSettings: () => void;
  closeMcpWorkspace: () => void;
  closeAgentWorkspace?: () => void;
  closeSessionPicker: () => void;
  closeProfilePicker: () => void;
  closeContextInspector: () => void;
  closeProcess: () => void;
  closeModelPicker: () => void;
  closeFilePicker: () => void;
  closeBlockActions: () => void;
  closeSelection: () => void;
  closeCommandMode: () => void;
};

export function closeModalByName(name: string, ops: ModalCloseOps): void {
  switch (name) {
    case 'help':
      ops.resetHelp();
      break;
    case 'shortcuts':
      ops.resetShortcuts();
      break;
    case 'bookmark':
      ops.closeBookmark();
      break;
    case 'liveTail':
      ops.closeLiveTail();
      break;
    case 'settings':
      ops.closeSettings();
      break;
    case 'mcpWorkspace':
      ops.closeMcpWorkspace();
      break;
    case 'agentWorkspace':
      ops.closeAgentWorkspace?.();
      break;
    case 'sessionPicker':
      ops.closeSessionPicker();
      break;
    case 'profilePicker':
      ops.closeProfilePicker();
      break;
    case 'contextInspector':
      ops.closeContextInspector();
      break;
    case 'process':
      ops.closeProcess();
      break;
    case 'modelPicker':
      ops.closeModelPicker();
      break;
    case 'filePicker':
      ops.closeFilePicker();
      break;
    case 'blockActions':
      ops.closeBlockActions();
      break;
    case 'selection':
      ops.closeSelection();
      break;
    case 'command':
      ops.closeCommandMode();
      break;
  }
}

export type ModalOpenOps = {
  openHelp: () => void;
  openShortcuts: () => void;
  openBookmark: () => void;
  openProcess: () => void;
  openContextInspector: () => void;
  openMcpWorkspace?: () => void;
  openAgentWorkspace?: () => void;
  openCommandMode: () => void;
};

/**
 * Reopen the modal that was previously on top of the stack after it has been
 * popped (so the one beneath it can resurface).
 *
 * INVARIANT: modals omitted from this switch are intentionally absent because
 * they remain `.active` as underlays when something stacks above them, they
 * never close themselves on stack push, so they need no explicit reopen.
 * Only the self-closing set (help, shortcuts, bookmark, process,
 * contextInspector, mcpWorkspace, agentWorkspace, command) is handled here.
 *
 * NOTE: any future modal that closes itself on overlay push MUST be added to
 * this switch, or it will silently fail to reopen when the stack unwinds.
 */
export function reopenModalByName(name: string, ops: ModalOpenOps): void {
  switch (name) {
    case 'help':
      ops.openHelp();
      break;
    case 'shortcuts':
      ops.openShortcuts();
      break;
    case 'bookmark':
      ops.openBookmark();
      break;
    case 'process':
      ops.openProcess();
      break;
    case 'contextInspector':
      ops.openContextInspector();
      break;
    case 'mcpWorkspace':
      ops.openMcpWorkspace?.();
      break;
    case 'agentWorkspace':
      ops.openAgentWorkspace?.();
      break;
    case 'command':
      ops.openCommandMode();
      break;
  }
}

type SearchRouteState = {
  searchManager: SearchManager;
  /** Supplied so search can look INTO collapsed blocks and folded tool-result
   *  groups (see search.ts), not just the rendered buffer. */
  conversationManager?: ConversationManager | null;
  requestRender: () => void;
  scroll: (delta: number) => void;
  getScrollTop: () => number;
  getViewportHeight: () => number;
};

export function handleSearchModeToken(
  state: SearchRouteState,
  token: InputToken,
  history: InfiniteBuffer,
  matchesSearchShortcut: boolean,
): boolean {
  const { searchManager } = state;
  if (!searchManager.active) return false;

  if (!searchManager.locked) {
    if (token.type === 'text') {
      const newQuery = searchManager.query + token.value;
      searchManager.search(newQuery, history, state.conversationManager);
    } else if (token.type === 'key') {
      if (token.logicalName === 'escape') {
        searchManager.close(state.conversationManager);
      } else if (token.logicalName === 'enter' || token.logicalName === 'tab') {
        if (searchManager.query.length > 0) {
          searchManager.lock();
          searchManager.revealCurrentMatch(history, state.conversationManager);
          const matchLine = searchManager.getCurrentMatchLine();
          if (matchLine >= 0) {
            state.scroll(matchLine - state.getScrollTop() - Math.floor(state.getViewportHeight() / 2));
          }
        }
      } else if (token.logicalName === 'backspace') {
        const newQuery = searchManager.query.slice(0, -1);
        searchManager.search(newQuery, history, state.conversationManager);
      } else if (matchesSearchShortcut) {
        searchManager.close(state.conversationManager);
      }
    }
  } else {
    if (token.type === 'key') {
      if (token.logicalName === 'escape' || matchesSearchShortcut) {
        searchManager.close(state.conversationManager);
      } else if (token.logicalName === 'right' || token.logicalName === 'down') {
        searchManager.nextMatch();
        searchManager.revealCurrentMatch(history, state.conversationManager);
        const matchLine = searchManager.getCurrentMatchLine();
        if (matchLine >= 0) {
          state.scroll(matchLine - state.getScrollTop() - Math.floor(state.getViewportHeight() / 2));
        }
      } else if (token.logicalName === 'left' || token.logicalName === 'up') {
        searchManager.prevMatch();
        searchManager.revealCurrentMatch(history, state.conversationManager);
        const matchLine = searchManager.getCurrentMatchLine();
        if (matchLine >= 0) {
          state.scroll(matchLine - state.getScrollTop() - Math.floor(state.getViewportHeight() / 2));
        }
      } else if (token.logicalName === 'backspace') {
        searchManager.unlock();
      }
    } else if (token.type === 'text') {
      if (token.value === 'j' || token.value === 'l') {
        searchManager.nextMatch();
        searchManager.revealCurrentMatch(history, state.conversationManager);
        const matchLine = searchManager.getCurrentMatchLine();
        if (matchLine >= 0) {
          state.scroll(matchLine - state.getScrollTop() - Math.floor(state.getViewportHeight() / 2));
        }
      } else if (token.value === 'k' || token.value === 'h') {
        searchManager.prevMatch();
        searchManager.revealCurrentMatch(history, state.conversationManager);
        const matchLine = searchManager.getCurrentMatchLine();
        if (matchLine >= 0) {
          state.scroll(matchLine - state.getScrollTop() - Math.floor(state.getViewportHeight() / 2));
        }
      }
    }
  }

  state.requestRender();
  return true;
}

type OverlayRouteState = {
  helpOverlayActive: boolean;
  helpScrollOffset: number;
  shortcutsOverlayActive: boolean;
  shortcutsScrollOffset: number;
  /** The overlays' always-live search rows (absent in minimal test states). */
  overlayFilters?: OverlayFilters;
  requestRender: () => void;
  handleEscape: () => void;
};

/**
 * Keys shared by the help and shortcuts overlays: ↑↓ and PgUp/PgDn scroll
 * (never past the end the renderer recorded), printable text goes into the
 * always-live search row (the offset returns to the top as the list
 * narrows), Backspace edits it, Esc closes. Returns the new scroll offset.
 */
function routeFilteredOverlayKey(token: InputToken, offset: number, filter: OverlayFilter | undefined): number {
  const max = filter ? filter.maxScroll : 100;
  if (token.type === 'key') {
    if (token.logicalName === 'up') return Math.max(0, Math.min(offset, max) - 1);
    if (token.logicalName === 'down') return Math.min(offset + 1, max);
    if (token.logicalName === 'pageup') return Math.max(0, Math.min(offset, max) - 10);
    if (token.logicalName === 'pagedown') return Math.min(offset + 10, max);
    if (filter && isTextBackspace(token.logicalName ?? '') && filter.query.length > 0) {
      filter.query = filter.query.slice(0, -1);
      return 0;
    }
    return offset;
  }
  if (token.type === 'text' && filter) {
    filter.query += token.value;
    return 0;
  }
  return offset;
}

export function handleOverlayToken(state: OverlayRouteState, token: InputToken): boolean {
  if (state.helpOverlayActive) {
    const filter = state.overlayFilters?.help;
    if (token.type === 'key' && token.logicalName === 'escape') {
      state.handleEscape();
      return true;
    }
    // '?' toggles help closed, but only while the query is empty; once
    // something is typed, '?' is just another character.
    if (token.type === 'text' && token.value === '?' && (!filter || filter.query.length === 0)) {
      state.helpOverlayActive = false;
      state.helpScrollOffset = 0;
      filter?.clear();
    } else {
      state.helpScrollOffset = routeFilteredOverlayKey(token, state.helpScrollOffset, filter);
    }
    state.requestRender();
    return true;
  }

  if (state.shortcutsOverlayActive) {
    if (token.type === 'key' && token.logicalName === 'escape') {
      state.handleEscape();
      return true;
    }
    state.shortcutsScrollOffset = routeFilteredOverlayKey(token, state.shortcutsScrollOffset, state.overlayFilters?.shortcuts);
    state.requestRender();
    return true;
  }

  return false;
}

type HistorySearchRouteState = {
  historySearch: HistorySearch;
  prompt: string;
  cursorPos: number;
  requestRender: () => void;
};

export function handleHistorySearchToken(state: HistorySearchRouteState, token: InputToken): boolean {
  if (!state.historySearch.active) return false;

  if (token.type === 'text') {
    state.historySearch.appendChar(token.value);
  } else if (token.type === 'key') {
    if (token.logicalName === 'escape' || (token.ctrl && token.logicalName === 'g')) {
      state.prompt = state.historySearch.cancel();
      state.cursorPos = state.prompt.length;
    } else if (token.logicalName === 'return') {
      state.prompt = state.historySearch.accept();
      state.cursorPos = state.prompt.length;
    } else if (token.logicalName === 'backspace') {
      state.historySearch.deleteChar();
    } else if (token.ctrl && token.logicalName === 'r') {
      state.historySearch.stepOlder();
    } else if (token.ctrl && token.logicalName === 's') {
      state.historySearch.stepNewer();
    }
  }

  state.requestRender();
  return true;
}
