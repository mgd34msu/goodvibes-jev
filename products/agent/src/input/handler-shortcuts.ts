import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
import type { CommandContext } from './command-registry.ts';
import type { SearchManager } from './search.ts';
import type { HistorySearch } from './input-history.ts';
import type { ConversationManager } from '../core/conversation';
import type { AutocompleteEngine } from './autocomplete.ts';
import type { KeybindingsManager } from './keybindings.ts';

type WrappedPromptInfo = {
  wrappedLines: string[];
  segments: { rawStart: number; length: number }[];
  cursorWrappedLine: number;
};

/**
 * Where the prompt ended up after an action that edits it somewhere else.
 *
 * Most cases in the switch below edit `state.prompt` directly, and the caller
 * (feedInputTokens) copies `state.prompt` back into the feed context when the
 * token is handled. Paste, undo and redo are different: they delegate to
 * InputHandler methods that edit the handler's own `prompt` field. Those edits
 * used to be invisible to the caller, which then wrote its pre-action snapshot
 * of `state.prompt` back over them, a pasted image marker was inserted and
 * immediately erased, so Ctrl+V looked like it did nothing at all. Returning
 * the new prompt keeps this route state the single thing the caller reads.
 */
export type PromptEdit = { readonly prompt: string; readonly cursorPos: number };

function applyPromptEdit(state: GlobalShortcutRouteState, edit: PromptEdit | void): void {
  if (!edit) return;
  state.prompt = edit.prompt;
  state.cursorPos = edit.cursorPos;
}

export type GlobalShortcutRouteState = {
  keybindingsManager: KeybindingsManager;
  prompt: string;
  cursorPos: number;
  commandMode: boolean;
  autocomplete: AutocompleteEngine | null;
  historySearch: HistorySearch;
  searchManager: SearchManager;
  conversationManager: ConversationManager | null;
  commandContext?: CommandContext;
  contentWidth: number;
  getScrollTop: () => number;
  getWrappedPromptInfo: (contentWidth: number) => WrappedPromptInfo;
  saveUndoState: () => void;
  requestRender: () => void;
  scroll: (delta: number) => void;
  ensureInputCursorVisible: () => void;
  handleCopy: () => void;
  handleCtrlC: () => void;
  handleBlockCopy: () => void;
  handleBookmark: () => void;
  handleBlockSave: () => void;
  /**
   * Actions that edit the prompt on the InputHandler rather than on this
   * route state. They return where the prompt landed so the switch can copy it
   * back, see applyPromptEdit and the note on PromptEdit.
   */
  handleUndo: () => PromptEdit | void;
  handleRedo: () => PromptEdit | void;
  handlePaste: () => PromptEdit | void;
  handleEscape: () => void;
  cycleAgentWorkspaceCategory: (direction: 'next' | 'prev') => void;
  dismissAgentWorkspace: () => boolean;
};

export function handleGlobalShortcutToken(
  state: GlobalShortcutRouteState,
  token: InputToken,
  viewportHeight: number,
): boolean {
  if (token.type !== 'key') return false;

  // Fast-path: bare pageup/pagedown have no keybinding entry.
  if (token.logicalName === 'pageup') {
    state.scroll(-Math.max(1, viewportHeight - 2));
    return true;
  }
  if (token.logicalName === 'pagedown') {
    state.scroll(Math.max(1, viewportHeight - 2));
    return true;
  }
  // Bare escape is also not in the keybinding table.
  if (token.logicalName === 'escape') {
    state.handleEscape();
    return true;
  }

  // O(1) lookup via inverted map.
  const kb = state.keybindingsManager;
  const action = kb.lookup(token);

  switch (action) {
    case 'copy-selection':
      state.handleCopy();
      return true;

    case 'screen-clear':
      state.commandContext?.clearScreen?.();
      return true;

    case 'workspace-close-all':
    case 'workspace-close':
      state.dismissAgentWorkspace();
      state.requestRender();
      return true;

    case 'workspace-picker':
      state.commandContext?.openWorkspacePicker?.();
      state.requestRender();
      return true;

    case 'activity-open':
      state.commandContext?.openActivityModal?.();
      state.requestRender();
      return true;

    case 'workspace-tab-next':
      state.cycleAgentWorkspaceCategory('next');
      return true;

    case 'workspace-tab-prev':
      state.cycleAgentWorkspaceCategory('prev');
      return true;

    case 'history-search':
      state.historySearch.open(state.prompt);
      state.requestRender();
      return true;

    case 'search':
      if (state.searchManager.active) state.searchManager.close(state.conversationManager);
      else state.searchManager.open();
      state.requestRender();
      return true;

    case 'block-copy':
      if (!state.commandMode) { state.handleBlockCopy(); return true; }
      return false;

    case 'bookmark':
      if (!state.commandMode) { state.handleBookmark(); return true; }
      return false;

    case 'block-save':
      if (!state.commandMode) { state.handleBlockSave(); return true; }
      return false;

    case 'delete-word': {
      state.saveUndoState();
      let pos = state.cursorPos;
      while (pos > 0 && state.prompt[pos - 1] === ' ') pos--;
      while (pos > 0 && state.prompt[pos - 1] !== ' ') pos--;
      state.prompt = state.prompt.slice(0, pos) + state.prompt.slice(state.cursorPos);
      state.cursorPos = pos;
      state.ensureInputCursorVisible();
      return true;
    }

    case 'line-start': {
      const info = state.getWrappedPromptInfo(state.contentWidth);
      state.cursorPos = info.wrappedLines.length > 1 ? info.segments[info.cursorWrappedLine].rawStart : 0;
      state.ensureInputCursorVisible();
      return true;
    }

    case 'next-error-line-end': {
      if (state.prompt === '' && !state.commandMode) {
        const nextLine = state.conversationManager?.nextErrorLine(state.getScrollTop()) ?? -1;
        if (nextLine >= 0) {
          state.scroll(nextLine - state.getScrollTop());
          state.requestRender();
          return true;
        }
      }
      const info = state.getWrappedPromptInfo(state.contentWidth);
      state.cursorPos = info.wrappedLines.length > 1
        ? info.segments[info.cursorWrappedLine].rawStart + info.segments[info.cursorWrappedLine].length
        : state.prompt.length;
      state.ensureInputCursorVisible();
      return true;
    }

    case 'kill-line':
      state.saveUndoState();
      state.prompt = state.prompt.slice(0, state.cursorPos);
      state.ensureInputCursorVisible();
      return true;

    case 'clear-prompt':
      state.saveUndoState();
      state.prompt = '';
      state.cursorPos = 0;
      if (state.commandMode) {
        state.commandMode = false;
        state.autocomplete?.reset();
      }
      return true;

    case 'undo':
      applyPromptEdit(state, state.handleUndo());
      return true;

    case 'redo':
      applyPromptEdit(state, state.handleRedo());
      return true;

    case 'paste':
      applyPromptEdit(state, state.handlePaste());
      return true;

    default:
      return false;
  }
}
