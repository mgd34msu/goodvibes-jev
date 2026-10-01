import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
import type { InfiniteBuffer } from '@goodvibes-jev/engine/terminal-shell';
import type { CommandContext, CommandRegistry } from './command-registry.ts';
import { AutocompleteEngine } from './autocomplete.ts';
import { FilePickerModal } from './file-picker.ts';
import { ModelPickerModal } from './model-picker.ts';
import { SelectionModal } from './selection-modal.ts';
import type { SelectionResult } from './selection-modal.ts';
import { SearchManager } from './search.ts';
import type { InputHistory, HistorySearch } from './input-history.ts';
import type { BlockMeta, ConversationManager } from '../core/conversation';
import { ProcessModal } from '../renderer/process-modal.ts';
import { LiveTailModal } from '../renderer/live-tail-modal.ts';
import { BlockActionsMenu } from '../renderer/block-actions.ts';
import { ContextInspectorModal } from '../renderer/context-inspector.ts';
import type { OverlayFilters } from './overlay-filter.ts';
import type { SurfaceModalHost } from './surface-modal-host.ts';
import { BookmarkModal } from './bookmark-modal.ts';
import { SettingsModal } from './settings-modal.ts';
import type { McpWorkspace } from './mcp-workspace.ts';
import type { AgentWorkspace } from './agent-workspace.ts';
import { SessionPickerModal } from './session-picker-modal.ts';
import { ProfilePickerModal } from './profile-picker-modal.ts';
import {
  IMAGE_EXTENSIONS,
  formatFileSize,
  mediaTypeFromExt,
} from './handler-content-actions.ts';
import {
  handleIndicatorFocusToken,
  handleMouseToken,
  handlePromptKeyToken,
  handlePromptTextToken,
} from './handler-feed-routes.ts';
import type { WrappedPromptInfo } from './handler-prompt-buffer.ts';
import { getViewportBottomLine } from '../renderer/conversation-layout.ts';
import { handleWorkTreeToken } from './handler-work-tree-route.ts';
import { handleSessionViewToken } from './handler-session-view-route.ts';
import { handleModalTokenRoutes } from './handler-modal-token-routes.ts';
import { handleCommandModeToken } from './handler-command-route.ts';
import { handleGlobalShortcutToken } from './handler-shortcuts.ts';
import type { PromptEdit } from './handler-shortcuts.ts';
import { SelectionManager } from '@goodvibes-jev/engine/terminal-shell';
import type { KeybindingsManager } from './keybindings.ts';
import type { ModelPickerTarget } from './model-picker.ts';
import { trackPasteFloodGuard, type PasteBurstGuardState } from './paste-flood-guard.ts';
import type { FocusTracker } from '@/runtime/index.ts';

/**
 * InputFeedContext, The single long-lived context object passed to feedInputTokens
 * on every keystroke. Allocated once at InputHandler construction; mutated in place
 * per-feed to avoid per-keystroke GC pressure from ~80-field object allocation.
 *
 * **Mutable per-feed** (synced from handler at the top of every feed() call, and
 * updated inside action closures via syncFeedContextMutableFields):
 *   - `prompt`, `cursorPos`, current text buffer state
 *   - `commandMode`, `indicatorFocused`, focus-mode flags
 *   - `helpOverlayActive`, `helpScrollOffset`, help overlay visibility and scroll
 *   - `shortcutsOverlayActive`, `shortcutsScrollOffset`, shortcuts overlay state
 *   - `nextPasteId`, `nextImageId`, monotonically increasing ID counters
 *   - `mouseDownRow`, `mouseDownCol`, drag-tracking coordinates
 *   - `contentWidth`, reflow width (semi-stable; synced at feed() entry only)
 *   - `selectionCallback`, current in-flight selection modal callback (nullable)
 *   - `requestRender`, swapped per-feed to a buffered version, restored after
 *
 * **Stable service handles** (set once at construction, never reallocated):
 *   - `commandRegistry`, `commandContext`, wired via setCommandRegistry() after
 *     construction; synced at feed() entry (not per-action) since no action changes them
 *   - `autocomplete`, wired after construction; synced at feed() entry
 *   - `inputHistory`, `conversationManager`, late-wired service handles; synced at
 *     feed() entry only since no in-feed action rewires them
 *   - `pasteRegistry`, `imageRegistry`, owned Maps, never replaced
 *   - `burstGuard` (see paste-flood-guard.ts), the
 *     unbracketed-paste-flood guard's sliding-window state, mutated in place
 *     across tokens by trackPasteFloodGuard (see paste-flood-guard.ts).
 *     Never reallocated. `burstSuppressedCount` is this wiring layer's own
 *     bookkeeping (not part of the ported module) for the honest resolution
 *     notice, see feedInputTokens below.
 *   - `focusTracker` (the SDK's FocusTracker), tracks OS-level
 *     terminal focus from `\x1b[I`/`\x1b[O` tokens (DECSET ?1004h, enabled in
 *     main.ts). Shared instance from RuntimeServices, threaded via
 *     uiServices.platform.focusTracker (mirrors the TUI's own wiring).
 *   - `selectionModal`, `bookmarkModal`, `settingsModal`, `sessionPickerModal`,
 *     `profilePickerModal`, modal objects constructed once in InputHandler constructor
 *   - `filePicker`, `modelPicker`, `processModal`, `liveTailModal`,
 *     `contextInspectorModal`, `blockActionsMenu`, `searchManager`, `historySearch`,
 *     service objects constructed once
 *   - `keybindingsManager`, from uiServices, stable for app lifetime
 *   - `modalStack`, reference to the handler's shared array (mutated in place)
 *   - `getHistory`, `getViewportHeight`, `getScrollTop`, `scroll`, `exitApp`, stable
 *     callbacks bound in the InputHandler constructor
 *   - All method closures (`modalOpened`, `handleEscape`, etc.), bound once at init
 *
 * **Rationale:** per-feed mutation avoids per-keystroke allocation cost; stable
 * references are service handles whose identity never changes after construction.
 */
export interface InputFeedContext {
  prompt: string;
  cursorPos: number;
  inputScrollTop: number;
  commandMode: boolean;
  indicatorFocused: boolean;
  helpOverlayActive: boolean;
  helpScrollOffset: number;
  shortcutsOverlayActive: boolean;
  shortcutsScrollOffset: number;
  nextPasteId: number;
  nextImageId: number;
  mouseDownRow: number;
  mouseDownCol: number;
  contentWidth: number;
  readonly pasteRegistry: Map<string, string>;
  readonly imageRegistry: Map<string, { data: string; mediaType: string }>;
  /** Ported from goodvibes-tui's paste-flood guard, mutated in place, never reallocated. */
  readonly burstGuard: PasteBurstGuardState;
  /** Wiring-layer bookkeeping (not part of the ported module) for the honest suppressed-count notice. */
  burstSuppressedCount: number;
  /** OS-level terminal focus, fed from the 'focus' tokens below. */
  readonly focusTracker: FocusTracker;
  readonly projectRoot: string;
  readonly selection: SelectionManager;
  readonly selectionModal: SelectionModal;
  selectionCallback: ((result: SelectionResult | null) => void) | null;
  readonly bookmarkModal: BookmarkModal;
  readonly settingsModal: SettingsModal;
  readonly mcpWorkspace: McpWorkspace;
  readonly agentWorkspace: AgentWorkspace;
  readonly sessionPickerModal: SessionPickerModal;
  readonly profilePickerModal: ProfilePickerModal;
  readonly historySearch: HistorySearch;
  commandRegistry: CommandRegistry | null;
  commandContext: CommandContext | undefined;
  autocomplete: AutocompleteEngine | null;
  readonly filePicker: FilePickerModal;
  readonly modelPicker: ModelPickerModal;
  readonly processModal: ProcessModal;
  readonly liveTailModal: LiveTailModal;
  readonly contextInspectorModal: ContextInspectorModal;
  readonly overlayFilters: OverlayFilters;
  /** Kit modals (the activity modal, ...): they take every key while open. */
  readonly surfaceModals?: SurfaceModalHost;
  readonly blockActionsMenu: BlockActionsMenu;
  readonly searchManager: SearchManager;
  readonly keybindingsManager: KeybindingsManager;
  readonly modalStack: string[];
  inputHistory: InputHistory | null;
  conversationManager: ConversationManager | null;
  readonly getHistory: () => InfiniteBuffer;
  readonly getViewportHeight: () => number;
  readonly getScrollTop: () => number;
  readonly scroll: (delta: number) => void;
  requestRender: () => void;
  readonly modalOpened: (name: string) => void;
  /** The agent or process view controls (null before the shell wires them). */
  readonly getSessionView: () => import('./handler-session-view-route.ts').SessionViewControls | null;
  readonly handleEscape: () => void;
  /**
   * Deliver an Enter submission to a pending composer line prompt (masked card
   * field, or plain address field). True means it was consumed and the normal
   * submit path, including input history, must not run. See
   * input/concealed-input.ts and input/plain-line-input.ts.
   */
  readonly submitConcealedInput: (value: string) => boolean;
  readonly handleCopy: () => void;
  readonly handleCtrlC: () => void;
  readonly handleBlockCopy: () => void;
  readonly handleBookmark: () => void;
  readonly handleBlockSave: () => void;
  // Report where the prompt landed; the shortcut route copies it forward.
  readonly handleUndo: () => PromptEdit | void;
  readonly handleRedo: () => PromptEdit | void;
  readonly handlePaste: () => PromptEdit | void;
  readonly saveUndoState: () => void;
  readonly ensureInputCursorVisible: (contentWidth?: number) => void;
  readonly registerPaste: (content: string) => string;
  readonly executeBlockAction: (id: string) => void;
  readonly cycleAgentWorkspaceCategory: (direction: 'next' | 'prev') => void;
  readonly dismissAgentWorkspace: () => boolean;
  readonly getWrappedPromptInfo: (contentWidth: number) => WrappedPromptInfo;
  readonly moveCursorVertical: (direction: -1 | 1) => boolean;
  readonly handlePathCompletion: () => boolean;
  readonly bodyTopRow: () => number;
  readonly handleBlockToggle: () => void;
  readonly findMarkerAtPos: (pos: number) => { start: number; end: number } | null;
  readonly cleanupMarkerRegistry: (text: string) => void;
  readonly expandPrompt: (text: string) => string | import('@goodvibes-jev/engine/sdk/platform/providers').ContentPart[];
  readonly openModelPickerWithTarget: (target: ModelPickerTarget, source?: 'settings') => boolean;
  readonly openProviderModelPickerWithTarget: (target: ModelPickerTarget, source?: 'settings') => boolean;
  readonly onModelPickerCommit: () => boolean;
  readonly exitApp: () => void;
}

export function feedInputTokens(context: InputFeedContext, tokens: readonly InputToken[]): void {
  const history = context.getHistory();
  const viewportHeight = context.getViewportHeight();
  const scrollTop = context.getScrollTop();
  const lineCount = history.getLineCount();
  const keybindings = context.keybindingsManager;
  // One `now` per feed() call (not per token), a genuine unbracketed-paste
  // flood delivers many tokens in one drain, and they should all measure as
  // arriving "at once" (mirrors the same doc note in goodvibes-tui's handler-feed.ts).
  const now = Date.now();

  for (const token of tokens) {
    // Focus-reporting tokens (CSI ?1004h)
    // never reach the composer or any modal route, consumed here, first,
    // unconditionally. No render needed.
    if (token.type === 'focus') {
      context.focusTracker.setFocused(token.action === 'in');
      continue;
    }

    if (token.type === 'key' && context.keybindingsManager.matches('clear-cancel', token)) {
      context.handleCtrlC();
      continue;
    }

    // Kit modals sit on top of everything else: focus belongs to the top one.
    // Esc goes through the shared chain (handler-modal-stack.ts), which pops
    // exactly one level of the host before anything else.
    if (context.surfaceModals?.active && (token.type === 'key' || token.type === 'text')) {
      if (token.type === 'key' && token.logicalName === 'escape') context.handleEscape();
      else context.surfaceModals.handleToken(token);
      context.requestRender();
      continue;
    }

    // The route works on a snapshot; a branch that acts through the handler
    // (Esc closing the help overlay, Esc clearing the composer) writes its
    // result into `context` directly. Only fields the action left alone take
    // the route's snapshot back (as goodvibes-tui's feed does).
    const before = {
      helpOverlayActive: context.helpOverlayActive, helpScrollOffset: context.helpScrollOffset,
      shortcutsOverlayActive: context.shortcutsOverlayActive, shortcutsScrollOffset: context.shortcutsScrollOffset,
      prompt: context.prompt, cursorPos: context.cursorPos,
    };
    const modalRoute = handleModalTokenRoutes({
      history,
      searchShortcutMatch: token.type === 'key' && keybindings.matches('search', token),
      selectionModal: context.selectionModal,
      selectionCallback: context.selectionCallback,
      getSelectionCallback: () => context.selectionCallback,
      setSelectionCallback: (callback) => {
        context.selectionCallback = callback;
      },
      bookmarkModal: context.bookmarkModal,
      settingsModal: context.settingsModal,
      mcpWorkspace: context.mcpWorkspace,
      agentWorkspace: context.agentWorkspace,
      sessionPickerModal: context.sessionPickerModal,
      profilePickerModal: context.profilePickerModal,
      helpOverlayActive: context.helpOverlayActive,
      helpScrollOffset: context.helpScrollOffset,
      shortcutsOverlayActive: context.shortcutsOverlayActive,
      shortcutsScrollOffset: context.shortcutsScrollOffset,
      historySearch: context.historySearch,
      prompt: context.prompt,
      cursorPos: context.cursorPos,
      modelPicker: context.modelPicker,
      modalStack: context.modalStack,
      commandContext: context.commandContext,
      getViewportHeight: context.getViewportHeight,
      requestRender: context.requestRender,
      handleEscape: context.handleEscape,
      liveTailModal: context.liveTailModal,
      processModal: context.processModal,
      contextInspectorModal: context.contextInspectorModal,
      overlayFilters: context.overlayFilters,
      modalOpened: context.modalOpened,
      filePicker: context.filePicker,
      imageRegistry: context.imageRegistry,
      nextImageId: context.nextImageId,
      saveUndoState: context.saveUndoState,
      ensureInputCursorVisible: () => context.ensureInputCursorVisible(),
      formatFileSize,
      mediaTypeFromExt,
      imageExtensions: IMAGE_EXTENSIONS,
      blockActionsMenu: context.blockActionsMenu,
      executeBlockAction: context.executeBlockAction,
      searchManager: context.searchManager,
      conversationManager: context.conversationManager,
      scroll: context.scroll,
      getScrollTop: context.getScrollTop,
      openModelPickerWithTarget: context.openModelPickerWithTarget,
      openProviderModelPickerWithTarget: context.openProviderModelPickerWithTarget,
      onModelPickerCommit: context.onModelPickerCommit,
    }, token);
    context.selectionCallback = modalRoute.selectionCallback;
    if (context.helpOverlayActive === before.helpOverlayActive) context.helpOverlayActive = modalRoute.helpOverlayActive;
    if (context.helpScrollOffset === before.helpScrollOffset) context.helpScrollOffset = modalRoute.helpScrollOffset;
    if (context.shortcutsOverlayActive === before.shortcutsOverlayActive) context.shortcutsOverlayActive = modalRoute.shortcutsOverlayActive;
    if (context.shortcutsScrollOffset === before.shortcutsScrollOffset) context.shortcutsScrollOffset = modalRoute.shortcutsScrollOffset;
    if (context.prompt === before.prompt) context.prompt = modalRoute.prompt;
    if (context.cursorPos === before.cursorPos) context.cursorPos = modalRoute.cursorPos;
    context.nextImageId = modalRoute.nextImageId;
    if (modalRoute.handled) {
      continue;
    }

    // An agent or process open full screen, and the session chips' Tab (handler-session-view-route.ts).
    const sessionView = context.getSessionView();
    const viewState = {
      controls: sessionView,
      prompt: context.prompt,
      cursorPos: context.cursorPos,
      commandMode: context.commandMode,
      saveUndoState: context.saveUndoState,
      requestRender: context.requestRender,
    };
    if (handleSessionViewToken(viewState, token)) {
      context.prompt = viewState.prompt;
      context.cursorPos = viewState.cursorPos;
      continue;
    }

    // The keyboard inside the work tree (Alt+Up enters, Esc leaves; see
    // handler-work-tree-route.ts). The work tree is main's: inside a view it is not on screen.
    if (!sessionView?.active && handleWorkTreeToken({
      conversationManager: context.conversationManager,
      enterMatch: token.type === 'key' && keybindings.matches('focus-work-tree', token),
      anchorLine: getViewportBottomLine(scrollTop, viewportHeight, lineCount),
      scrollTop: context.getScrollTop(),
      viewportHeight,
      scroll: context.scroll,
      requestRender: context.requestRender,
      onCopied: () => { /* the copy receipt is the transcript line handleBlockCopy logs */ },
      openAgent: (id) => context.commandContext?.openSessionView?.({ kind: 'agent', id }) ?? false,
      openProcess: (id) => context.commandContext?.openSessionView?.({ kind: 'process', id }) ?? false,
    }, token)) {
      continue;
    }

    if (token.type === 'key') {
      const shortcutState = {
        prompt: context.prompt,
        cursorPos: context.cursorPos,
        commandMode: context.commandMode,
        autocomplete: context.autocomplete,
        historySearch: context.historySearch,
        searchManager: context.searchManager,
        conversationManager: context.conversationManager,
        commandContext: context.commandContext,
        contentWidth: context.contentWidth,
        getScrollTop: context.getScrollTop,
        getWrappedPromptInfo: context.getWrappedPromptInfo,
        saveUndoState: context.saveUndoState,
        requestRender: context.requestRender,
        scroll: context.scroll,
        ensureInputCursorVisible: () => context.ensureInputCursorVisible(),
        handleCopy: context.handleCopy,
        handleCtrlC: context.handleCtrlC,
        handleBlockCopy: context.handleBlockCopy,
        handleBookmark: context.handleBookmark,
        handleBlockSave: context.handleBlockSave,
        handleUndo: context.handleUndo,
        handleRedo: context.handleRedo,
        handlePaste: context.handlePaste,
        handleEscape: context.handleEscape,
        cycleAgentWorkspaceCategory: context.cycleAgentWorkspaceCategory,
        dismissAgentWorkspace: context.dismissAgentWorkspace,
        keybindingsManager: context.keybindingsManager,
      };
      const promptBefore = context.prompt;
      const cursorPosBefore = context.cursorPos;
      const commandModeBefore = context.commandMode;
      if (handleGlobalShortcutToken(shortcutState, token, viewportHeight)) {
        // Some branches (handleEscape, handleCtrlC) mutate handler state directly
        // and sync it into this same `context` (syncFeedContextMutableFields):
        // Esc clearing the composer sets context.prompt to ''. `shortcutState` is
        // a snapshot taken BEFORE that call, so applying it unconditionally would
        // stomp the live update back to its stale pre-action value (Esc would
        // never clear typed text). Only apply the snapshot for a field the
        // dispatched action did not already change (as goodvibes-tui does).
        context.prompt = context.prompt === promptBefore ? shortcutState.prompt : context.prompt;
        context.cursorPos = context.cursorPos === cursorPosBefore ? shortcutState.cursorPos : context.cursorPos;
        context.commandMode = context.commandMode === commandModeBefore ? shortcutState.commandMode : context.commandMode;
        continue;
      }
    }

    // Paste-flood guard (paste-flood-guard.ts): guards
    // command-mode's key-driven dispatch (handleCommandModeToken,
    // below) from an unbracketed-paste-replay or control-character-injection
    // burst.
    //
    // SCOPE, 'key' tokens, and only while commandMode is active: the plain
    // composer (commandMode false) is a capturing surface that stays
    // untouched. handlePromptTextToken absorbs pasted/typed text of any length
    // by plain insertion, and handlePromptKeyToken's arrow/backspace/enter
    // handling is ordinary editing. Guarding those would falsely trip on
    // ordinary fast/bulk delivery (a single feed() call carrying many
    // characters/keys shares one `now`, indistinguishable from a real flood
    // under this millisecond-resolution model, confirmed by a regression in
    // command-modal-handoff.test.ts when an earlier version of this guard
    // covered all 'key'/'text' tokens unconditionally) and would add friction
    // (e.g. held-arrow-key auto-repeat) to the default interaction mode.
    //
    // commandMode's key dispatch is where a burst becomes
    // command/keybinding dispatch: once
    // commandMode is armed (state.prompt starts with '/'), Enter EXECUTES a
    // slash command (handler-command-route.ts), Tab completes, up/down
    // navigate, real state-changing single-key actions. An unbracketed
    // paste whose content happens to start with '/' and contains a bare '\r'
    // partway through (not '\n', the tokenizer maps '\n' to shift+enter/
    // newline-insert, code10; only '\r'/code13 is a genuine 'enter' key, see
    // platform/core/tokenizer.ts) would otherwise execute a slash command
    // early with truncated/wrong arguments. A human never sends 9 key-tokens
    // within 120ms.
    //
    // UX-FIRST / HONEST DEGRADED STATE: never silent, a one-shot notice fires
    // the moment the guard trips, and a second notice reports how many
    // keystrokes it suppressed once the burst quiets down.
    if (token.type === 'key' && context.commandMode) {
      const wasSuspended = context.burstGuard.suspended;
      const guard = trackPasteFloodGuard(context.burstGuard, now);
      if (!guard.dispatch) {
        context.burstSuppressedCount++;
        if (guard.showHintNow) {
          context.commandContext?.print('[paste] unbracketed paste flood detected: suppressing extra keystrokes until it settles');
          context.requestRender();
        }
        continue;
      }
      if (wasSuspended) {
        context.commandContext?.print(`[paste] flood cleared: suppressed ${context.burstSuppressedCount} keystroke(s)`);
        context.burstSuppressedCount = 0;
        context.requestRender();
      }
    }

    const indicatorRoute = handleIndicatorFocusToken({
      indicatorFocused: context.indicatorFocused,
      modalOpened: context.modalOpened,
      processModal: context.processModal,
      requestRender: context.requestRender,
    }, token);
    context.indicatorFocused = indicatorRoute.indicatorFocused;
    if (indicatorRoute.handled) {
      continue;
    }

    const textRoute = handlePromptTextToken({
      prompt: context.prompt,
      cursorPos: context.cursorPos,
      commandMode: context.commandMode,
      nextPasteId: context.nextPasteId,
      nextImageId: context.nextImageId,
      pasteRegistry: context.pasteRegistry,
      imageRegistry: context.imageRegistry,
      inputHistory: context.inputHistory,
      commandRegistry: context.commandRegistry,
      commandContext: context.commandContext,
      autocomplete: context.autocomplete,
      filePicker: context.filePicker,
      modalOpened: context.modalOpened,
      saveUndoState: context.saveUndoState,
      ensureInputCursorVisible: () => context.ensureInputCursorVisible(),
      registerPaste: context.registerPaste,
      requestRender: context.requestRender,
    }, token);
    if (textRoute.handled) {
      context.prompt = textRoute.prompt;
      context.cursorPos = textRoute.cursorPos;
      context.commandMode = textRoute.commandMode;
      continue;
    }

    if (token.type === 'key') {
      const commandState = {
        commandMode: context.commandMode,
        prompt: context.prompt,
        cursorPos: context.cursorPos,
        autocomplete: context.autocomplete,
        modalStack: context.modalStack,
        commandRegistry: context.commandRegistry,
        commandContext: context.commandContext,
        conversationManager: context.conversationManager,
        requestRender: context.requestRender,
        handleEscape: context.handleEscape,
        projectRoot: context.projectRoot,
        pasteRegistry: context.pasteRegistry,
        imageRegistry: context.imageRegistry,
        nextPasteId: context.nextPasteId,
        nextImageId: context.nextImageId,
        saveUndoState: context.saveUndoState,
        ensureInputCursorVisible: () => context.ensureInputCursorVisible(),
      };
      if (handleCommandModeToken(commandState, token)) {
        context.commandMode = commandState.commandMode;
        context.prompt = commandState.prompt;
        context.cursorPos = commandState.cursorPos;
        context.nextPasteId = commandState.nextPasteId;
        context.nextImageId = commandState.nextImageId;
        continue;
      }

      const keyRoute = handlePromptKeyToken({
        prompt: context.prompt,
        cursorPos: context.cursorPos,
        inputScrollTop: context.inputScrollTop,
        commandMode: context.commandMode,
        contentWidth: context.contentWidth,
        maxInputRows: 8,
        inputHistory: context.inputHistory,
        indicatorFocused: context.indicatorFocused,
        conversationManager: context.conversationManager,
        commandContext: context.commandContext,
        autocomplete: context.autocomplete,
        blockActionsMenu: { open: (block: BlockMeta) => context.blockActionsMenu.open(block) },
        processModal: context.processModal,
        modalOpened: context.modalOpened,
        saveUndoState: context.saveUndoState,
        ensureInputCursorVisible: context.ensureInputCursorVisible,
        getWrappedPromptInfo: context.getWrappedPromptInfo,
        moveCursorVertical: context.moveCursorVertical,
        handlePathCompletion: context.handlePathCompletion,
        handleBlockToggle: context.handleBlockToggle,
        findMarkerAtPos: context.findMarkerAtPos,
        cleanupMarkerRegistry: context.cleanupMarkerRegistry,
        expandPrompt: context.expandPrompt,
        submitConcealedInput: context.submitConcealedInput,
        scroll: context.scroll,
        exitApp: context.exitApp,
        requestRender: context.requestRender,
      }, token);
      if (keyRoute.handled) {
        context.prompt = keyRoute.prompt;
        context.cursorPos = keyRoute.cursorPos;
        context.inputScrollTop = keyRoute.inputScrollTop;
        context.commandMode = keyRoute.commandMode;
        context.indicatorFocused = keyRoute.indicatorFocused;
        continue;
      }
    } else if (token.type === 'mouse') {
      const mouseRoute = handleMouseToken({
        conversationManager: context.conversationManager,
        selection: context.selection,
        mouseDownRow: context.mouseDownRow,
        mouseDownCol: context.mouseDownCol,
        scrollTop,
        viewportHeight,
        lineCount,
        scroll: context.scroll,
        requestRender: context.requestRender,
        handlePaste: context.handlePaste,
        handleCopy: context.handleCopy,
        bodyTopRow: context.bodyTopRow,
      }, token);
      context.mouseDownRow = mouseRoute.mouseDownRow;
      context.mouseDownCol = mouseRoute.mouseDownCol;
      if (mouseRoute.handled) {
        continue;
      }
    }
  }

  context.requestRender();
}
