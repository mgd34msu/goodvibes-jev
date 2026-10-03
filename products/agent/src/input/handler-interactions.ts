import { cleanupMarkerRegistry, expandPrompt, findMarkerAtPos, handleBlockCopy, handleBlockRerun, handleBlockSave, handleBlockToggle, handleBookmark, handleClipboardPaste, handleCopy, handleCtrlC, registerPaste } from './handler-content-actions.ts';
import { clearModalStack, handleEscape, modalOpened } from './handler-modal-stack.ts';
import type { ClipboardPasteResult } from './handler-content-actions.ts';
import { missingClipboardReaderHint } from '../utils/clipboard.ts';
import type { InputHandler } from './handler.ts';
import { activeTokens } from '../renderer/theme.ts';

/**
 * handlePasteForHandler - Shared paste path for Ctrl+V and middle-click.
 *
 * Tries the clipboard's image first, then its text. The clipboard itself is
 * taken from `handler.clipboardSource`, so tests can hand in a clipboard
 * without touching the real one.
 *
 * Returns where the prompt landed. That return value is load-bearing: the
 * shortcut route snapshots the prompt before dispatching and copies its own
 * copy back afterwards, so an edit made only on the handler was written over
 * and the paste vanished. See PromptEdit in handler-shortcuts.ts.
 */
export function handlePasteForHandler(handler: InputHandler): ClipboardPasteResult {
  const result = handleClipboardPaste({
    prompt: handler.prompt,
    cursorPos: handler.cursorPos,
    pasteRegistry: handler.pasteRegistry,
    nextPasteId: handler.nextPasteId,
    imageRegistry: handler.imageRegistry,
    nextImageId: handler.nextImageId,
    saveUndoState: () => handler.saveUndoState(),
    ensureInputCursorVisible: () => handler.ensureInputCursorVisible(),
    requestRender: handler.requestRender,
  }, handler.uiServices.environment.shellPaths.workingDirectory, handler.clipboardSource);

  handler.prompt = result.prompt;
  handler.cursorPos = result.cursorPos;
  handler.nextImageId = result.nextImageId;
  handler.nextPasteId = result.nextPasteId;

  if (!result.pasted) {
    // A missing helper program and a genuinely empty clipboard look identical
    // from here, and only one of them is the person's to fix. Say which.
    const hint = missingClipboardReaderHint();
    handler.conversationManager?.log(
      hint ? `[Paste] ${hint}` : '[Paste: clipboard does not contain supported text or image data]',
      { fg: activeTokens().textFaint },
    );
    handler.requestRender();
  }
  return result;
}

export function registerPasteForHandler(handler: InputHandler, content: string): string {
    const result = registerPaste({
      pasteRegistry: handler.pasteRegistry,
      nextPasteId: handler.nextPasteId,
      imageRegistry: handler.imageRegistry,
      nextImageId: handler.nextImageId,
    }, content, handler.uiServices.environment.shellPaths.workingDirectory);
    handler.nextPasteId = result.nextPasteId;
    handler.nextImageId = result.nextImageId;
    return result.marker;
  }

  /**
   * expandPrompt - Replaces paste markers with actual content.
   * If image markers are present, returns ContentPart[] for multimodal delivery.
   * Otherwise returns a plain string.
   */
export function expandPromptForHandler(handler: InputHandler, text: string) {
    return expandPrompt(handler.pasteRegistry, handler.imageRegistry, text, handler.uiServices.environment.shellPaths.workingDirectory);
  }

  /**
   * getImageAttachments - Returns a copy of the current image registry.
   * Callers can use this to attach images when building LLM messages.
   */
export function getImageAttachmentsForHandler(handler: InputHandler): Map<string, { data: string; mediaType: string }> {
    return new Map(handler.imageRegistry);
  }

  /**
   * findMarkerAtPos - Returns the start/end of an atomic marker if pos is inside one.
   * Used to make backspace/delete/arrow treat markers as single units.
   */
  /**
   * cleanupMarkerRegistry - If the given marker text is an IMAGE marker,
   * parses its ID and removes it from imageRegistry.
   */
export function cleanupMarkerRegistryForHandler(handler: InputHandler, markerText: string): void {
    cleanupMarkerRegistry(handler.imageRegistry, markerText);
  }

export function findMarkerAtPosForHandler(handler: InputHandler, pos: number): { start: number; end: number } | null {
    return findMarkerAtPos(handler.prompt, pos);
  }

export function handleCopyForHandler(handler: InputHandler): void {
    handleCopy(handler.selection, handler.getHistory, handler.requestRender, () => {
      handler.lastCopyTime = Date.now();
    });
  }

  /**
   * handleBlockCopy - Ctrl+Y: Copy the content of the nearest code/tool block.
   */
export function handleBlockCopyForHandler(handler: InputHandler): void {
    handleBlockCopy(handler.conversationManager, handler.getScrollTop, handler.requestRender, () => {
      handler.lastBlockCopyTime = Date.now();
    });
  }

  /**
   * handleBookmark - Ctrl+B: Toggle bookmark on the nearest block.
   */
export function handleBookmarkForHandler(handler: InputHandler): void {
    handleBookmark(handler.conversationManager, handler.getScrollTop, handler.requestRender, handler.uiServices.shell.bookmarkManager);
  }

  /**
   * handleBlockSave - Ctrl+S: Explain that implicit block file saves are blocked.
   */
export function handleBlockSaveForHandler(handler: InputHandler): void {
    handleBlockSave(handler.conversationManager, handler.getScrollTop, handler.requestRender, handler.uiServices.shell.bookmarkManager);
  }

  /**
   * executeBlockAction - Execute a block action ID on the nearest block.
   * Called when the user selects an action from the BlockActionsMenu.
   */
export function executeBlockActionForHandler(handler: InputHandler, actionId: string): void {
    switch (actionId) {
      case 'copy':     handler.handleBlockCopy(); break;
      case 'bookmark': handler.handleBookmark(); break;
      case 'toggle':   handler.handleBlockToggle(); break;
      case 'rerun':    handler.handleBlockRerun(); break;
    }
  }

  /**
   * handleBlockRerun - Re-run the tool call for the nearest tool block.
   * Emits a tool-rerun event for the orchestrator to handle.
   */
export function handleBlockRerunForHandler(handler: InputHandler): void {
    handleBlockRerun(handler.conversationManager, handler.getScrollTop, handler.requestRender);
  }

  /**
   * handleBlockToggle - Tab (non-command mode): Toggle collapse of nearest block.
   */
export function handleBlockToggleForHandler(handler: InputHandler): void {
    handleBlockToggle(handler.conversationManager, handler.getScrollTop, handler.requestRender);
  }

  /**
   * Handle Ctrl+C:
   * - If prompt has text: clear it
   * - If prompt is empty and LLM is thinking: cancel generation
   * - If prompt is empty and idle: show exit notice (double = exit)
   */
export function handleCtrlCForHandler(handler: InputHandler): void {
    handleCtrlC(
      handler.prompt,
      () => handler.saveUndoState(),
      (value) => { handler.prompt = value; },
      (value) => { handler.cursorPos = value; },
      handler.commandContext?.cancelGeneration,
      handler.exitApp,
      handler.requestRender,
      handler.lastCtrlCTime,
      (value) => { handler.lastCtrlCTime = value; },
      (value) => { handler.showExitNotice = value; },
    );
  }

  /**
   * Handle Escape:
   * - If prompt has text: clear it
   * - If prompt is empty: cancel generation (double-tap not needed)
   */
  /**
   * Record that a modal has been opened and push it onto the navigation stack.
   * Call this EVERY time a modal opens (except inside openModal()).
   *
   * @param name - The modal identifier (e.g. 'settings', 'help', 'process').
   */
export function modalOpenedForHandler(handler: InputHandler, name: string): void {
    modalOpened(handler, name);
  }

  /**
   * Clear the modal navigation stack on non-modal user input (e.g. submit).
   */
export function clearModalStackForHandler(handler: InputHandler): void {
    clearModalStack(handler.modalStack);
  }

export function handleEscapeForHandler(handler: InputHandler): void {
    const result = handleEscape({
      helpOverlayActive: handler.helpOverlayActive,
      shortcutsOverlayActive: handler.shortcutsOverlayActive,
      bookmarkModal: handler.bookmarkModal,
      liveTailModal: handler.liveTailModal,
      settingsModal: handler.settingsModal,
      mcpWorkspace: handler.mcpWorkspace,
      agentWorkspace: handler.agentWorkspace,
      sessionPickerModal: handler.sessionPickerModal,
      profilePickerModal: handler.profilePickerModal,
      contextInspectorModal: handler.contextInspectorModal,
      processModal: handler.processModal,
      modelPicker: handler.modelPicker,
      filePicker: handler.filePicker,
      blockActionsMenu: handler.blockActionsMenu,
      surfaceModals: handler.surfaceModals,
      sessionView: handler.sessionView ?? undefined,
      transcriptScroll: handler.transcriptScroll ?? undefined,
      selectionModal: handler.selectionModal,
      commandMode: handler.commandMode,
      modalStack: handler.modalStack,
      modalReturnFocus: handler.modalReturnFocus,
      indicatorFocused: handler.indicatorFocused,
      prompt: handler.prompt,
      cursorPos: handler.cursorPos,
      requestRender: handler.requestRender,
      saveUndoState: () => handler.saveUndoState(),
      cancelGeneration: handler.commandContext?.cancelGeneration,
      selectionCallback: handler.selectionCallback,
      autocompleteReset: () => handler.autocomplete?.reset(),
      autocompleteUpdate: (query: string) => handler.autocomplete?.update(query),
      helpScrollOffset: handler.helpScrollOffset,
      shortcutsScrollOffset: handler.shortcutsScrollOffset,
    });
    handler.prompt = result.prompt;
    handler.cursorPos = result.cursorPos;
    handler.commandMode = result.commandMode;
    handler.helpOverlayActive = result.helpOverlayActive;
    handler.helpScrollOffset = result.helpScrollOffset;
    handler.shortcutsOverlayActive = result.shortcutsOverlayActive;
    handler.shortcutsScrollOffset = result.shortcutsScrollOffset;
    handler.selectionCallback = result.selectionCallback;
    handler.indicatorFocused = result.indicatorFocused;
    handler.modalReturnFocus = result.modalReturnFocus;
}
