import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
import type { BlockMeta, ConversationManager } from '../core/conversation';
import type { InputHistory } from './input-history.ts';
import type { ContentPart } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { CommandRegistry, CommandContext } from './command-registry.ts';
import type { AutocompleteEngine } from './autocomplete.ts';
import type { SelectionManager } from '@goodvibes-jev/engine/terminal-shell';
import type { WrappedPromptInfo } from './handler-prompt-buffer.ts';
import {
  ensureInputCursorVisible as computeInputScrollTop,
  getWrappedPromptInfo as computeWrappedPromptInfo,
  moveCursorVertical as computeCursorVerticalMove,
} from './handler-prompt-buffer.ts';
import { cleanupMarkerRegistry, expandPrompt, findMarkerAtPos, registerPaste } from './handler-content-actions.ts';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';

export type IndicatorFocusRouteState = {
  indicatorFocused: boolean;
  modalOpened: (name: string) => void;
  processModal: { open: () => void };
  requestRender: () => void;
};

export function handleIndicatorFocusToken(state: IndicatorFocusRouteState, token: InputToken): {
  handled: boolean;
  indicatorFocused: boolean;
} {
  let indicatorFocused = state.indicatorFocused;
  if (!indicatorFocused) {
    return { handled: false, indicatorFocused };
  }

  if (token.type === 'key') {
    if (token.logicalName === 'up' || token.logicalName === 'escape') {
      indicatorFocused = false;
      state.requestRender();
      return { handled: true, indicatorFocused };
    }
    if (token.logicalName === 'enter') {
      indicatorFocused = false;
      state.modalOpened('process');
      state.processModal.open();
      state.requestRender();
      return { handled: true, indicatorFocused };
    }
    if (token.ctrl || token.logicalName === 'left' || token.logicalName === 'right') {
      indicatorFocused = false;
      return { handled: false, indicatorFocused };
    }
    state.requestRender();
    return { handled: true, indicatorFocused };
  }

  indicatorFocused = false;
  return { handled: false, indicatorFocused };
}

export type TextRouteState = {
  prompt: string;
  cursorPos: number;
  commandMode: boolean;
  nextPasteId: number;
  nextImageId: number;
  pasteRegistry: Map<string, string>;
  imageRegistry: Map<string, { data: string; mediaType: string }>;
  inputHistory: InputHistory | null;
  commandRegistry: CommandRegistry | null;
  commandContext: CommandContext | undefined;
  autocomplete: AutocompleteEngine | null;
  filePicker: { open: (insertPos: number, injectMode?: boolean) => void };
  modalOpened: (name: string) => void;
  saveUndoState: () => void;
  ensureInputCursorVisible: () => void;
  registerPaste: (content: string) => string;
  requestRender: () => void;
};

export function handlePromptTextToken(state: TextRouteState, token: InputToken): {
  handled: boolean;
  prompt: string;
  cursorPos: number;
  commandMode: boolean;
} {
  if (token.type !== 'text') {
    return { handled: false, prompt: state.prompt, cursorPos: state.cursorPos, commandMode: state.commandMode };
  }

  if (token.value === '?' && state.prompt === '' && !state.commandMode) {
    if (state.commandContext?.openSelection) {
      state.commandRegistry?.execute('help', [], state.commandContext);
    }
    state.requestRender();
    return { handled: true, prompt: state.prompt, cursorPos: state.cursorPos, commandMode: state.commandMode };
  }

  if (state.inputHistory?.isBrowsing) {
    state.inputHistory.resetPosition();
  }
  state.saveUndoState();
  const text = state.registerPaste(token.value);
  let prompt = state.prompt.slice(0, state.cursorPos) + text + state.prompt.slice(state.cursorPos);
  let cursorPos = state.cursorPos + text.length;
  let commandMode = state.commandMode;
  state.ensureInputCursorVisible();

  if (token.value === '@' && !commandMode) {
    const charBefore = cursorPos >= 2 ? prompt[cursorPos - 2] : undefined;
    if (charBefore === '!') {
      state.modalOpened('filePicker');
      state.filePicker.open(cursorPos - 2, true);
    } else if (charBefore === undefined || charBefore === ' ' || charBefore === '\n') {
      state.modalOpened('filePicker');
      state.filePicker.open(cursorPos - 1);
    }
  }

  if (prompt === '/' && state.commandRegistry) {
    commandMode = true;
    state.modalOpened('command');
    state.autocomplete?.update('');
  } else if (commandMode && state.commandRegistry) {
    const query = prompt.startsWith('/') ? prompt.slice(1) : '';
    const spaceIdx = query.indexOf(' ');
    if (spaceIdx === -1) {
      state.autocomplete?.update(query);
    } else {
      state.autocomplete?.reset();
    }
  }

  return { handled: true, prompt, cursorPos, commandMode };
}

export type KeyRouteState = {
  prompt: string;
  cursorPos: number;
  inputScrollTop: number;
  commandMode: boolean;
  contentWidth: number;
  maxInputRows: number;
  inputHistory: InputHistory | null;
  indicatorFocused: boolean;
  conversationManager: ConversationManager | null;
  commandContext: CommandContext | undefined;
  autocomplete: AutocompleteEngine | null;
  blockActionsMenu: { open: (block: BlockMeta) => void };
  processModal: { open: () => void };
  modalOpened: (name: string) => void;
  saveUndoState: () => void;
  ensureInputCursorVisible: (contentWidth?: number) => void;
  getWrappedPromptInfo: (contentWidth: number) => WrappedPromptInfo;
  moveCursorVertical: (direction: -1 | 1) => boolean;
  handlePathCompletion: () => boolean;
  handleBlockToggle: () => void;
  findMarkerAtPos: (pos: number) => { start: number; end: number } | null;
  cleanupMarkerRegistry: (markerText: string) => void;
  expandPrompt: (text: string) => string | ContentPart[];
  /**
   * Deliver a concealed submission. When it returns true, concealed mode was
   * active and consumed the value, the plaintext went straight to the
   * requester, bypassing input history and the transcript. Optional so bare
   * test callers can omit it.
   */
  submitConcealedInput?: (value: string) => boolean;
  scroll: (delta: number) => void;
  exitApp: () => void;
  requestRender: () => void;
};

export function handlePromptKeyToken(state: KeyRouteState, token: InputToken): {
  handled: boolean;
  prompt: string;
  cursorPos: number;
  inputScrollTop: number;
  commandMode: boolean;
  indicatorFocused: boolean;
} {
  if (token.type !== 'key') {
    return {
      handled: false,
      prompt: state.prompt,
      cursorPos: state.cursorPos,
      inputScrollTop: state.inputScrollTop,
      commandMode: state.commandMode,
      indicatorFocused: state.indicatorFocused,
    };
  }

  let prompt = state.prompt;
  let cursorPos = state.cursorPos;
  let inputScrollTop = state.inputScrollTop;
  let commandMode = state.commandMode;
  let indicatorFocused = state.indicatorFocused;
  const ensureLocalInputCursorVisible = () => {
    inputScrollTop = computeInputScrollTop(prompt, cursorPos, inputScrollTop, state.contentWidth, state.maxInputRows);
  };
  const runQuitShortcut = (commandName: 'quit' | 'wq') => {
    if (state.commandContext?.executeCommand) {
      void state.commandContext.executeCommand(commandName, []).catch((error) => {
        state.commandContext?.print(
          `[${commandName}] ${summarizeError(error)}`,
        );
      });
      return;
    }
    state.exitApp();
  };

  if (token.logicalName === 'tab' && !commandMode) {
    if (!state.handlePathCompletion()) {
      state.handleBlockToggle();
    }
    return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
  }

  if (token.logicalName === 'enter') {
    if (token.shift) {
      prompt = prompt.slice(0, cursorPos) + '\n' + prompt.slice(cursorPos);
      cursorPos++;
      ensureLocalInputCursorVisible();
      return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
    }

    // Concealed input: the typed line is a secret. Deliver the plaintext (the
    // live feed snapshot, not the possibly-stale handler buffer) to the
    // concealed consumer, never to input history or the transcript, then clear.
    //
    // This sits ABOVE everything else in the enter branch on purpose. Below it
    // the line would be trimmed, tested against :q/:wq, and, the one that
    // actually matters, handed to inputHistory.add(), which persists to
    // ~/.goodvibes/agent/input-history.json. A card number recalled with
    // arrow-up, or sitting in that file on disk, is the same leak as one
    // printed into the transcript.
    if (state.submitConcealedInput?.(prompt)) {
      prompt = '';
      cursorPos = 0;
      state.requestRender();
      return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
    }

    const text = prompt.trim();
    if (!text && !commandMode) {
      const lineIndex = 0;
      const nearest = state.conversationManager?.findNearestBlock(lineIndex);
      if (nearest) {
        state.modalOpened('blockActions');
        state.blockActionsMenu.open(nearest);
        state.requestRender();
        return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
      }
    }
    if (text === ':q' || text === ':wq') {
      prompt = '';
      cursorPos = 0;
      runQuitShortcut(text === ':wq' ? 'wq' : 'quit');
      state.requestRender();
      return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
    }
    if (text) {
      const expanded = state.expandPrompt(text);
      const historyRecallText = typeof expanded === 'string'
        ? expanded
        : expanded
            .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
            .map(p => p.text)
            .join('');
      state.inputHistory?.add(text, { recallText: historyRecallText });
      prompt = '';
      cursorPos = 0;
      if (typeof expanded === 'string') {
        state.commandContext?.submitInput?.(expanded);
      } else {
        const textOnly = expanded
          .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map(p => p.text)
          .join('');
        state.commandContext?.submitInput?.(textOnly, expanded);
      }
    }
    return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
  }

  if (token.logicalName === 'backspace') {
    if (cursorPos > 0) {
      state.saveUndoState();
      let marker = state.findMarkerAtPos(cursorPos);
      if (!marker) {
        const ahead = state.findMarkerAtPos(cursorPos + 1);
        if (ahead && ahead.start === cursorPos) {
          marker = ahead;
        }
      }
      if (marker) {
        const markerText = prompt.slice(marker.start, marker.end);
        state.cleanupMarkerRegistry(markerText);
        prompt = prompt.slice(0, marker.start) + prompt.slice(marker.end);
        cursorPos = marker.start;
      } else {
        prompt = prompt.slice(0, cursorPos - 1) + prompt.slice(cursorPos);
        cursorPos--;
      }
      ensureLocalInputCursorVisible();
    }
    return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
  }

  if (token.logicalName === 'delete') {
    if (cursorPos < prompt.length) {
      state.saveUndoState();
      const marker = state.findMarkerAtPos(cursorPos + 1);
      if (marker) {
        const markerText = prompt.slice(marker.start, marker.end);
        state.cleanupMarkerRegistry(markerText);
        prompt = prompt.slice(0, marker.start) + prompt.slice(marker.end);
      } else {
        prompt = prompt.slice(0, cursorPos) + prompt.slice(cursorPos + 1);
      }
      ensureLocalInputCursorVisible();
    }
    state.requestRender();
    return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
  }

  if (token.logicalName === 'left') {
    if (cursorPos > 0) {
      const marker = state.findMarkerAtPos(cursorPos);
      cursorPos = marker ? marker.start : cursorPos - 1;
      ensureLocalInputCursorVisible();
    }
    state.requestRender();
    return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
  }

  if (token.logicalName === 'right') {
    if (cursorPos < prompt.length) {
      const marker = state.findMarkerAtPos(cursorPos + 1);
      cursorPos = marker ? marker.end : cursorPos + 1;
      ensureLocalInputCursorVisible();
    }
    state.requestRender();
    return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
  }

  if (token.logicalName === 'home') {
    cursorPos = 0;
    ensureLocalInputCursorVisible();
    return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
  }

  if (token.logicalName === 'end') {
    cursorPos = prompt.length;
    ensureLocalInputCursorVisible();
    return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
  }

  if (token.logicalName === 'up') {
    const move = computeCursorVerticalMove(prompt, cursorPos, inputScrollTop, state.contentWidth, state.maxInputRows, -1);
    if (move.moved) {
      cursorPos = move.cursorPos;
      inputScrollTop = move.inputScrollTop;
    } else {
      const info = computeWrappedPromptInfo(prompt, cursorPos, inputScrollTop, state.contentWidth, state.maxInputRows);
      if (info.cursorWrappedLine === 0) {
        if (state.inputHistory) {
          const recalled = state.inputHistory.up(prompt);
          if (recalled !== null) {
            prompt = recalled;
            cursorPos = recalled.length;
            ensureLocalInputCursorVisible();
          } else {
            state.scroll(-3);
          }
        } else {
          state.scroll(-3);
        }
      }
    }
    return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
  }

  if (token.logicalName === 'down') {
    const move = computeCursorVerticalMove(prompt, cursorPos, inputScrollTop, state.contentWidth, state.maxInputRows, 1);
    if (move.moved) {
      cursorPos = move.cursorPos;
      inputScrollTop = move.inputScrollTop;
    } else {
      const info = computeWrappedPromptInfo(prompt, cursorPos, inputScrollTop, state.contentWidth, state.maxInputRows);
      const atBottom = info.cursorWrappedLine >= info.wrappedLines.length - 1;
      if (atBottom && state.inputHistory?.isBrowsing) {
        const recalled = state.inputHistory.down();
        if (recalled !== null) {
          prompt = recalled;
          cursorPos = recalled.length;
          ensureLocalInputCursorVisible();
        } else {
          indicatorFocused = true;
        }
      } else {
        indicatorFocused = true;
      }
    }
    return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
  }

  if (token.logicalName === 'f2') {
    indicatorFocused = false;
    state.modalOpened('process');
    state.processModal.open();
    return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
  }

  return { handled: false, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
}

export type MouseRouteState = {
  conversationManager: ConversationManager | null;
  selection: SelectionManager;
  mouseDownRow: number;
  mouseDownCol: number;
  scrollTop: number;
  viewportHeight: number;
  lineCount: number;
  scroll: (delta: number) => void;
  requestRender: () => void;
  handlePaste: () => void;
  handleCopy: () => void;
  /** Screen rows above the transcript (the header, the chips, the gap under them); 2 when not given. */
  bodyTopRow?: () => number;
};

export function handleMouseToken(state: MouseRouteState, token: InputToken): {
  handled: boolean;
  mouseDownRow: number;
  mouseDownCol: number;
} {
  let mouseDownRow = state.mouseDownRow;
  let mouseDownCol = state.mouseDownCol;
  if (token.type !== 'mouse') {
    return { handled: false, mouseDownRow, mouseDownCol };
  }

  // Mouse rows are 1-based; the transcript's first row is the one after the header block.
  const viewportRow = token.row - 1 - (state.bodyTopRow?.() ?? 2);

  if (token.button === 64) {
    state.scroll(-3);
    return { handled: true, mouseDownRow, mouseDownCol };
  }
  if (token.button === 65) {
    state.scroll(3);
    return { handled: true, mouseDownRow, mouseDownCol };
  }
  if (token.button === 1 && token.action === 'press') {
    state.handlePaste();
    return { handled: true, mouseDownRow, mouseDownCol };
  }
  if (token.button === 0 && token.action === 'press') {
    mouseDownRow = token.row;
    mouseDownCol = token.col;
    state.selection.startSelection(token.col, viewportRow, state.scrollTop, state.viewportHeight, state.lineCount);
    return { handled: true, mouseDownRow, mouseDownCol };
  }
  if (token.button === 32) {
    state.selection.extendSelection(token.col, viewportRow, state.scrollTop, state.viewportHeight, state.lineCount);
    return { handled: true, mouseDownRow, mouseDownCol };
  }
  if (token.action === 'release') {
    const moved = Math.abs(token.row - mouseDownRow) + Math.abs(token.col - mouseDownCol);
    if (moved <= 2 && state.conversationManager) {
      const offset = Math.max(0, state.viewportHeight - state.lineCount);
      const absoluteLine = state.scrollTop + (viewportRow - offset);
      if (absoluteLine >= 0) {
        const blockIdx = state.conversationManager.toggleCollapseAtLine(absoluteLine);
        if (blockIdx >= 0) {
          state.selection.clearSelection();
          state.requestRender();
          return { handled: true, mouseDownRow: -1, mouseDownCol: -1 };
        }
      }
    }
    state.handleCopy();
    state.selection.endSelection();
    return { handled: true, mouseDownRow: -1, mouseDownCol: -1 };
  }

  return { handled: false, mouseDownRow, mouseDownCol };
}
