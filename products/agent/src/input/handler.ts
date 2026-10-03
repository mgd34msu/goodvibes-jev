import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { InputTokenizer } from '@goodvibes-jev/engine/sdk/platform/core';
import { clearModalStackForHandler, cleanupMarkerRegistryForHandler, executeBlockActionForHandler, expandPromptForHandler, findMarkerAtPosForHandler, getImageAttachmentsForHandler, handleBlockCopyForHandler, handleBlockRerunForHandler, handleBlockSaveForHandler, handleBlockToggleForHandler, handleBookmarkForHandler, handleCopyForHandler, handleCtrlCForHandler, handleEscapeForHandler, handlePasteForHandler, modalOpenedForHandler, registerPasteForHandler } from './handler-interactions.ts';
import { SelectionManager } from '@goodvibes-jev/engine/terminal-shell';
import type { InfiniteBuffer } from '@goodvibes-jev/engine/terminal-shell';
import type { CommandRegistry, CommandContext } from './command-registry.ts';
import { AutocompleteEngine } from './autocomplete.ts';
import { FilePickerModal } from './file-picker.ts';
import { ModelPickerModal } from './model-picker.ts';
import { SelectionModal } from './selection-modal.ts';
import type { SelectionResult, SelectionAction } from './selection-modal.ts';
import { SearchManager } from './search.ts';
import { InputHistory, HistorySearch } from './input-history.ts';
import type { BlockMeta, ConversationManager } from '../core/conversation';
import { ProcessModal } from '../renderer/process-modal.ts';
import { LiveTailModal } from '../renderer/live-tail-modal.ts';
import { BlockActionsMenu } from '../renderer/block-actions.ts';
import { ContextInspectorModal } from '../renderer/context-inspector.ts';
import { OverlayFilters } from './overlay-filter.ts';
import { SurfaceModalHost } from './surface-modal-host.ts';
import { BookmarkModal } from './bookmark-modal.ts';
import { SettingsModal } from './settings-modal.ts';
import { McpWorkspace } from './mcp-workspace.ts';
import { AgentWorkspace } from './agent-workspace.ts';
import { parseSlashCommand } from './slash-command-parser.ts';
import { SessionPickerModal } from './session-picker-modal.ts';
import { ProfilePickerModal } from './profile-picker-modal.ts';
import {
  IMAGE_EXTENSIONS,
  cleanupMarkerRegistry,
  expandPrompt,
  findMarkerAtPos,
  formatFileSize,
  handleBlockCopy,
  handleBlockRerun,
  handleBlockSave,
  handleBlockToggle,
  handleBookmark,
  handleClipboardPaste,
  handleCopy,
  handleCtrlC,
  mediaTypeFromExt,
  registerPaste,
} from './handler-content-actions.ts';
import {
  handleIndicatorFocusToken,
  handleMouseToken,
  handlePromptKeyToken,
  handlePromptTextToken,
} from './handler-feed-routes.ts';
import {
  ensureInputCursorVisible,
  findPathToken,
  getWrappedPromptInfo,
  handlePathCompletion,
  moveCursorVertical,
  redoPromptState,
  saveUndoState,
  undoPromptState,
  wordWrapLine,
  type WrappedPromptInfo,
} from './handler-prompt-buffer.ts';
import { clearModalStack, handleEscape, modalOpened } from './handler-modal-stack.ts';
import { maskConcealedText, type ConcealedInputRequest } from './concealed-input.ts';
import type { PlainLineInputRequest } from './plain-line-input.ts';
import {
  beginConcealedInputForHandler,
  beginPlainInputForHandler,
  submitLinePromptForHandler,
  cancelLinePromptForHandler,
} from './handler-line-prompts.ts';
import { handleModalTokenRoutes } from './handler-modal-token-routes.ts';
import { handleCommandModeToken } from './handler-command-route.ts';
import { handleGlobalShortcutToken } from './handler-shortcuts.ts';
import { pasteImageFromClipboard, pasteFromClipboard } from '../utils/clipboard.ts';
import type { ClipboardPasteSource } from './handler-content-actions.ts';
import { feedInputTokens } from './handler-feed.ts';
import { buildInitialFeedContext, syncFeedContextMutableFields } from './feed-context-factory.ts';
import type { UiRuntimeServices } from '../runtime/ui-services.ts';
import type { ModelPickerTarget } from './model-picker.ts';
import type { PasteBurstGuardState } from './paste-flood-guard.ts';

type SelectionModalCallback = (result: SelectionResult | null) => void;


/**
 * InputHandler - Owns prompt text, paste registry, and keyboard/mouse handling.
 * Extracted from main.ts and StateManager.
 */
export class InputHandler {
  public prompt = '';
  public cursorPos = 0;
  public showExitNotice = false;
  /**
   * Active concealed-input request, or null. When set, the composer masks its
   * echo (see getWrappedPromptInfo) and diverts submission to the request's
   * onSubmit (see submitConcealedInput) instead of the normal chat/command
   * path, so the plaintext never reaches input history or the transcript.
   */
  public concealedInput: ConcealedInputRequest | null = null;
  /**
   * Active plain-line request, or null. Same chaining shape as concealedInput
   * but echoed normally, see plain-line-input.ts for why the two are separate
   * slots rather than one type with a masking flag. At most one of the two is
   * ever set; the begin* methods below enforce that.
   */
  public plainLineInput: PlainLineInputRequest | null = null;
  /** Max visible rows for the input area. Content beyond this scrolls internally. */
  public static readonly MAX_INPUT_ROWS = 8;
  /** Internal scroll offset for the input area when content exceeds MAX_INPUT_ROWS. */
  public inputScrollTop = 0;
  public lastCopyTime = 0;
  /** True when the user has entered slash-command mode (prompt starts with '/'). */
  public commandMode = false;
  /** True when the process indicator bar has keyboard focus. */
  public indicatorFocused = false;

  public tokenizer = new InputTokenizer();
  public pasteRegistry = new Map<string, string>();
  public nextPasteId = 1;
  public lastCtrlCTime = 0;
  /** Ported from goodvibes-tui, unbracketed-paste-flood guard state, mutated in place. */
  public burstGuard: PasteBurstGuardState = { timestamps: [], suspended: false, hintShown: false };
  /** Long-lived feed context, reused across every feed() call to avoid per-keystroke allocation. */
  public feedContext!: import('./handler-feed.ts').InputFeedContext;
  public commandRegistry: CommandRegistry | null = null;
  public commandContext: CommandContext | undefined = undefined;
  public autocomplete: AutocompleteEngine | null = null;
  public modelPicker: ModelPickerModal;
  public selectionModal = new SelectionModal();
  public searchManager = new SearchManager();
  public processModal: ProcessModal;
  public liveTailModal: LiveTailModal;
  public contextInspectorModal = new ContextInspectorModal();
  public readonly overlayFilters = new OverlayFilters();
  /** Kit modals: a one-level-Esc stack drawn over everything else (surface-modal-host.ts). */
  public surfaceModals = new SurfaceModalHost();
  /** Agent and process views (shell/session-views.ts); null until the shell wires them. */
  public sessionView: import('./handler-session-view-route.ts').SessionViewControls | null = null;
  /** The main transcript's scroll, for Esc while scrolled back (handler-modal-stack.ts); null until the shell wires it. */
  public transcriptScroll: import('./handler-modal-stack.ts').TranscriptScrollControls | null = null;
  /** Screen rows above the transcript, set each frame by the shell: the header, the chips, the gap under them. */
  public bodyTopRow = 2;
  public bookmarkModal: BookmarkModal;
  public blockActionsMenu = new BlockActionsMenu();
  public settingsModal = new SettingsModal();
  public mcpWorkspace = new McpWorkspace();
  public agentWorkspace = new AgentWorkspace();

  /**
   * Modal navigation stack. Each element is the name of an open modal.
   * Used to support back-navigation via Escape.
   */
  public modalStack: string[] = [];
  public modalReturnFocus: 'prompt' | 'indicator' = 'prompt';
  public sessionPickerModal: SessionPickerModal;
  public profilePickerModal: ProfilePickerModal;
  /** True when the help overlay is visible. */
  public helpOverlayActive = false;
  public helpScrollOffset = 0;
  public shortcutsOverlayActive = false;
  public shortcutsScrollOffset = 0;
  public inputHistory: InputHistory | null = null;
  public filePicker: FilePickerModal;
  public historySearch: HistorySearch = new HistorySearch(() => this.inputHistory?.getEntries() ?? []);
  public conversationManager: ConversationManager | null = null;
  public selectionCallback: SelectionModalCallback | null = null;
  public syncFeedSelectionCallback: ((callback: SelectionModalCallback | null) => void) | null = null;
  /** Time of last [COPIED] block feedback, for brief display. */
  public lastBlockCopyTime = 0;
  public mouseDownRow = -1;
  public mouseDownCol = -1;

  /** Pasted images: maps marker IDs to base64 image data. */
  public imageRegistry = new Map<string, { data: string; mediaType: string }>();
  public nextImageId = 1;

  // ── Undo / Redo ────────────────────────────────────────────────────────────
  public undoStack: Array<{ prompt: string; cursorPos: number }> = [];
  public redoStack: Array<{ prompt: string; cursorPos: number }> = [];
  public static readonly MAX_UNDO = 50;

  // ── Path completion (Tab on path-like token) ───────────────────────────────
  /** Current list of path completions cycling on repeated Tab presses. */
  public pathCompletions: string[] = [];
  /** Index into pathCompletions for Tab cycling. */
  public pathCompletionIndex = -1;
  /** The raw prefix that triggered path completion (e.g. 'src/in'). */
  public pathCompletionPrefix = '';
  /** Start offset in prompt where the path token begins. */
  public pathCompletionStart = 0;

  constructor(
    public requestRender: () => void,
    public selection: SelectionManager,
    public getScrollTop: () => number,
    public getViewportHeight: () => number,
    public getHistory: () => InfiniteBuffer,
    public scroll: (delta: number) => void,
    public exitApp: () => void,
    public readonly uiServices: Pick<UiRuntimeServices,
      'environment'
      | 'platform'
      | 'providers'
      | 'sessions'
      | 'shell'
    >,
  ) {
    this.filePicker = new FilePickerModal(uiServices.environment.shellPaths);
    this.modelPicker = new ModelPickerModal(
      uiServices.providers.favoritesStore,
      uiServices.providers.benchmarkStore,
      uiServices.providers.providerRegistry,
    );
    this.processModal = new ProcessModal({
      processManager: uiServices.shell.processManager,
    });
    this.liveTailModal = new LiveTailModal({
      processManager: uiServices.shell.processManager,
    });
    this.bookmarkModal = new BookmarkModal(uiServices.shell.bookmarkManager);
    this.sessionPickerModal = new SessionPickerModal(uiServices.sessions.sessionManager);
    this.profilePickerModal = new ProfilePickerModal(uiServices.shell.profileManager);
    this.initFeedContext();
  }

  /**
   * initFeedContext, Build the long-lived InputFeedContext once via factory.
   * See feed-context-factory.ts for full field documentation.
   */
  public initFeedContext(): void {
    this.feedContext = buildInitialFeedContext(
      {
        prompt: this.prompt, cursorPos: this.cursorPos, inputScrollTop: this.inputScrollTop, commandMode: this.commandMode,
        indicatorFocused: this.indicatorFocused,
        helpOverlayActive: this.helpOverlayActive, helpScrollOffset: this.helpScrollOffset,
        shortcutsOverlayActive: this.shortcutsOverlayActive, shortcutsScrollOffset: this.shortcutsScrollOffset,
        nextPasteId: this.nextPasteId, nextImageId: this.nextImageId,
        mouseDownRow: this.mouseDownRow, mouseDownCol: this.mouseDownCol,
        contentWidth: this.contentWidth,
        selectionCallback: this.selectionCallback,
      },
      {
        selection: this.selection,
        pasteRegistry: this.pasteRegistry,
        imageRegistry: this.imageRegistry,
        burstGuard: this.burstGuard,
        focusTracker: this.uiServices.platform.focusTracker,
        projectRoot: this.uiServices.environment.shellPaths.workingDirectory,
        selectionModal: this.selectionModal,
        bookmarkModal: this.bookmarkModal,
        settingsModal: this.settingsModal,
        mcpWorkspace: this.mcpWorkspace,
        agentWorkspace: this.agentWorkspace,
        sessionPickerModal: this.sessionPickerModal,
        profilePickerModal: this.profilePickerModal,
        historySearch: this.historySearch,
        commandRegistry: this.commandRegistry,
        commandContext: this.commandContext,
        autocomplete: this.autocomplete,
        filePicker: this.filePicker,
        modelPicker: this.modelPicker,
        processModal: this.processModal,
        liveTailModal: this.liveTailModal,
        contextInspectorModal: this.contextInspectorModal,
        overlayFilters: this.overlayFilters,
        surfaceModals: this.surfaceModals,
        blockActionsMenu: this.blockActionsMenu,
        searchManager: this.searchManager,
        modalStack: this.modalStack,
        inputHistory: this.inputHistory,
        conversationManager: this.conversationManager,
        keybindingsManager: this.uiServices.shell.keybindingsManager,
        getHistory: this.getHistory,
        getViewportHeight: this.getViewportHeight,
        getScrollTop: this.getScrollTop,
        scroll: this.scroll,
        exitApp: this.exitApp,
      },
      {
        modalOpened: (name: string) => this.modalOpened(name),
        getSessionView: () => this.sessionView,
        // Escape cancels a pending concealed prompt FIRST. Falling through to
        // the normal modal-stack escape would leave the request dangling, its
        // onCancel never fires, the caller's chained flow never resumes or
        // stops, and the composer silently stays in masked mode.
        handleEscape: () => { if (!this.cancelConcealedInput()) this.handleEscape(); this.syncFeedContextMutableFields(); },
        submitConcealedInput: (value: string) => this.submitConcealedInput(value),
        handleCopy: () => this.handleCopy(),
        handleCtrlC: () => { this.handleCtrlC(); this.syncFeedContextMutableFields(); },
        handleBlockCopy: () => this.handleBlockCopy(),
        handleBookmark: () => this.handleBookmark(),
        handleBlockSave: () => this.handleBlockSave(),
        // These three edit this.prompt, so they report back where it landed;
        // the shortcut route copies that into its own state, which is what the
        // feed loop reads when the token is handled.
        handleUndo: () => { this.handleUndo(); this.syncFeedContextMutableFields(); return this.promptEdit(); },
        handleRedo: () => { this.handleRedo(); this.syncFeedContextMutableFields(); return this.promptEdit(); },
        handlePaste: () => { this.handlePaste(); this.syncFeedContextMutableFields(); return this.promptEdit(); },
        saveUndoState: () => this.saveUndoState(),
        ensureInputCursorVisible: (contentWidth?: number) => this.ensureInputCursorVisible(contentWidth),
        registerPaste: (content: string) => this.registerPaste(content),
        executeBlockAction: (id: string) => this.executeBlockAction(id),
        cycleAgentWorkspaceCategory: (direction: 'next' | 'prev') => this.cycleAgentWorkspaceCategory(direction),
        dismissAgentWorkspace: () => this.dismissAgentWorkspace(),
        getWrappedPromptInfo: (contentWidth: number) => this.getWrappedPromptInfo(contentWidth),
        moveCursorVertical: (direction: -1 | 1) => this.moveCursorVertical(direction),
        handlePathCompletion: () => this.handlePathCompletion(),
        bodyTopRow: () => this.bodyTopRow,
        handleBlockToggle: () => this.handleBlockToggle(),
        findMarkerAtPos: (pos: number) => this.findMarkerAtPos(pos),
        cleanupMarkerRegistry: (text: string) => this.cleanupMarkerRegistry(text),
        expandPrompt: (text: string) => this.expandPrompt(text),
        openModelPickerWithTarget: (target: ModelPickerTarget) => this.openModelPickerWithTarget(target),
        openProviderModelPickerWithTarget: (target: ModelPickerTarget) => this.openProviderModelPickerWithTarget(target),
        onModelPickerCommit: () => this.handleModelPickerCommit(),
      },
    );
  }

  /** Where the prompt currently sits, for callers that must copy it forward. */
  public promptEdit(): { readonly prompt: string; readonly cursorPos: number } {
    return { prompt: this.prompt, cursorPos: this.cursorPos };
  }

  /** Sync mutable handler fields back into feedContext after in-feed mutations. */
  public syncFeedContextMutableFields(): void {
    const h = this;
    syncFeedContextMutableFields({ prompt: h.prompt, cursorPos: h.cursorPos, inputScrollTop: h.inputScrollTop, commandMode: h.commandMode,
      indicatorFocused: h.indicatorFocused, helpOverlayActive: h.helpOverlayActive,
      helpScrollOffset: h.helpScrollOffset, shortcutsOverlayActive: h.shortcutsOverlayActive,
      shortcutsScrollOffset: h.shortcutsScrollOffset, selectionCallback: h.selectionCallback,
      nextPasteId: h.nextPasteId, nextImageId: h.nextImageId, mouseDownRow: h.mouseDownRow,
      mouseDownCol: h.mouseDownCol, contentWidth: h.contentWidth }, this.feedContext);
  }

  /** Wire in the InputHistory instance. Optional; disables history navigation if unset. */
  public setHistory(history: InputHistory): void { this.inputHistory = history; }

  /** Wire in the slash command registry and context. Must be called before commands work. */
  public setCommandRegistry(registry: CommandRegistry, context: CommandContext): void {
    this.commandRegistry = registry;
    this.commandContext = context;
    this.autocomplete = new AutocompleteEngine(registry);
  }

  /** Wire in the conversation manager for block copy/collapse. */
  public setConversationManager(cm: ConversationManager): void { this.conversationManager = cm; }

  /**
   * openSelection - Open the generic selection modal with a callback.
   * The callback receives SelectionResult on selection, or null on cancel/escape.
   */
  public openSelection(
    title: string,
    items: import('./selection-modal.ts').SelectionItem[],
    opts: {
      preSelectId?: string;
      allowSearch?: boolean;
      customActions?: Map<string, SelectionAction>;
      onHighlight?: (item: import('./selection-modal.ts').SelectionItem | null) => void;
    } | undefined,
    callback: SelectionModalCallback,
  ): void {
    this.modalOpened('selection');
    this.selectionModal.open(title, items, opts);
    this.selectionCallback = callback;
    this.syncFeedSelectionCallback?.(callback);
    this.requestRender();
  }

  public registerPaste(content: string): string { return registerPasteForHandler(this, content); }
  public expandPrompt(text: string) { return expandPromptForHandler(this, text); }
  public getImageAttachments(): Map<string, { data: string; mediaType: string }> { return getImageAttachmentsForHandler(this); }
  public cleanupMarkerRegistry(markerText: string): void { cleanupMarkerRegistryForHandler(this, markerText); }
  public findMarkerAtPos(pos: number): { start: number; end: number } | null { return findMarkerAtPosForHandler(this, pos); }
  public handleCopy(): void { handleCopyForHandler(this); }
  public handleBlockCopy(): void { handleBlockCopyForHandler(this); }
  public handleBookmark(): void { handleBookmarkForHandler(this); }
  public handleBlockSave(): void { handleBlockSaveForHandler(this); }
  public executeBlockAction(actionId: string): void { executeBlockActionForHandler(this, actionId); }
  public handleBlockRerun(): void { handleBlockRerunForHandler(this); }
  public handleBlockToggle(): void { handleBlockToggleForHandler(this); }
  public handleCtrlC(): void { handleCtrlCForHandler(this); }
  public modalOpened(name: string): void {
    const keepAgentWorkspaceUnderlay = name === 'modelPicker' || name === 'settings';
    if (name !== 'agentWorkspace' && !keepAgentWorkspaceUnderlay && this.agentWorkspace.active) {
      this.closeAgentWorkspaceModal();
    }
    modalOpenedForHandler(this, name);
  }
  public clearModalStack(): void { clearModalStackForHandler(this); }
  public handleEscape(): void { handleEscapeForHandler(this); }

  // ── Composer line prompts (see handler-line-prompts.ts) ─────────────────

  /** Begin one line of masked composer entry. */
  public beginConcealedInput(request: ConcealedInputRequest): void { beginConcealedInputForHandler(this, request); }

  /** Begin one line of ordinary, echoed composer entry. */
  public beginPlainInput(request: PlainLineInputRequest): void { beginPlainInputForHandler(this, request); }

  /** Deliver an Enter to a pending line prompt. True means it was consumed. */
  public submitConcealedInput(value: string): boolean { return submitLinePromptForHandler(this, value); }

  /** Cancel a pending line prompt of either kind (Escape). */
  public cancelConcealedInput(): boolean { return cancelLinePromptForHandler(this); }

  public openModelPickerWithTarget(target: ModelPickerTarget): boolean {
    const openModelPicker = this.commandContext?.openModelPicker;
    if (!openModelPicker) return false;
    this.modelPicker.target = target;
    openModelPicker();
    return true;
  }
  public openProviderModelPickerWithTarget(target: ModelPickerTarget): boolean {
    const openProviderPicker = this.commandContext?.openProviderPicker;
    if (!openProviderPicker) return false;
    this.modelPicker.target = target;
    openProviderPicker();
    return true;
  }
  public openMcpWorkspace(context: CommandContext): void {
    this.indicatorFocused = false;
    this.modalOpened('mcpWorkspace');
    this.mcpWorkspace.open(context);
    this.requestRender();
  }
  public openAgentWorkspace(context: CommandContext, categoryId?: string, onlyGroup?: string): void {
    this.indicatorFocused = false;
    this.modalOpened('agentWorkspace');
    this.agentWorkspace.open(
      context,
      (command, behavior) => this.dispatchAgentWorkspaceCommand(command, context, behavior),
      categoryId,
      (prompt) => this.dispatchAgentWorkspacePrompt(prompt, context),
      onlyGroup as import('./agent-workspace-types.ts').AgentWorkspaceCategoryGroup | undefined,
    );
    this.requestRender();
  }

  private closeAgentWorkspaceModal(): void {
    this.agentWorkspace.close();
    for (let index = this.modalStack.length - 1; index >= 0; index -= 1) {
      if (this.modalStack[index] === 'agentWorkspace') this.modalStack.splice(index, 1);
    }
  }

  public dismissAgentWorkspace(): boolean {
    if (!this.agentWorkspace.active) return false;
    this.closeAgentWorkspaceModal();
    this.indicatorFocused = false;
    this.requestRender();
    return true;
  }

  public dispatchAgentWorkspaceCommand(command: string, context: CommandContext, behavior?: 'inline' | 'compose' | 'exit'): void {
    // Default to 'inline' so editor submissions stay inside the workspace modal.
    // Closing the modal mid-flow (the old 'compose' default) traps users in the
    // wrong context and was the primary symptom of the broken onboarding flow.
    const resolved = behavior ?? 'inline';
    const { name, args } = parseSlashCommand(command);
    if (!name) return;
    if (resolved === 'exit') {
      this.closeAgentWorkspaceModal();
      void context.executeCommand?.(name, [...args]).catch((error: unknown) => {
        context.print(`Agent workspace command failed: ${error instanceof Error ? error.message : String(error)}`);
        this.requestRender();
      });
      this.requestRender();
      return;
    }
    if (resolved === 'inline') {
      const capturedLines: string[] = [];
      const originalPrint = context.print;
      if (typeof context.executeCommand !== 'function') {
        this.agentWorkspace.lastActionResult = {
          kind: 'error',
          title: `Command unavailable: ${command}`,
          detail: 'No command dispatcher is configured for this runtime.',
          command,
          safety: 'safe',
        };
        this.requestRender();
        return;
      }
      context.print = (text: string): void => {
        capturedLines.push(text);
      };
      const buildCapturedDetail = (): string => {
        const MAX_CHARS = 1500;
        const MAX_LINES = 12;
        const lines = capturedLines.slice(-MAX_LINES);
        const joined = lines.join('\n');
        if (joined.length > MAX_CHARS) {
          return joined.slice(0, MAX_CHARS) + '\n… (output truncated)';
        }
        const omitted = capturedLines.length - lines.length;
        return omitted > 0 ? `… (${omitted} line(s) truncated)\n${joined}` : joined || '(no output)';
      };
      void context.executeCommand(name, [...args]).then(() => {
        context.print = originalPrint;
        this.agentWorkspace.lastActionResult = {
          kind: 'dispatched',
          title: `Result: ${command}`,
          detail: buildCapturedDetail(),
          command,
          safety: 'safe',
        };
        this.requestRender();
      }).catch((error: unknown) => {
        context.print = originalPrint;
        this.agentWorkspace.lastActionResult = {
          kind: 'error',
          title: `${command} failed`,
          detail: error instanceof Error ? error.message : String(error),
          command,
        };
        this.requestRender();
      });
      return;
    }
    // compose (default): close workspace then execute
    this.closeAgentWorkspaceModal();
    void context.executeCommand?.(name, [...args]).catch((error: unknown) => {
      context.print(`Agent workspace command failed: ${error instanceof Error ? error.message : String(error)}`);
      this.requestRender();
    });
    this.requestRender();
  }

  private dispatchAgentWorkspacePrompt(prompt: string, context: CommandContext): void {
    this.closeAgentWorkspaceModal();
    context.submitInput?.(prompt);
    this.requestRender();
  }
  public handleModelPickerCommit(): boolean { return false; }


  /**
   * feed - Process raw stdin data through the tokenizer.
   * Reuses the long-lived this.feedContext to avoid per-keystroke object allocation.
   */
  public feed(data: string): void {
    const immediateRequestRender = this.requestRender;
    let renderRequested = false;
    let isFeeding = true;
    const bufferedRequestRender = (): void => {
      if (isFeeding) {
        renderRequested = true;
        return;
      }
      immediateRequestRender();
    };

    this.requestRender = bufferedRequestRender;
    try {
      const context = this.feedContext;
      // Sync mutable scalars from handler into the reused context.
      context.prompt = this.prompt;
      context.cursorPos = this.cursorPos;
      context.inputScrollTop = this.inputScrollTop;
      context.commandMode = this.commandMode;
      context.indicatorFocused = this.indicatorFocused;
      context.helpOverlayActive = this.helpOverlayActive;
      context.helpScrollOffset = this.helpScrollOffset;
      context.shortcutsOverlayActive = this.shortcutsOverlayActive;
      context.shortcutsScrollOffset = this.shortcutsScrollOffset;
      context.selectionCallback = this.selectionCallback;
      context.nextPasteId = this.nextPasteId;
      context.nextImageId = this.nextImageId;
      context.mouseDownRow = this.mouseDownRow;
      context.mouseDownCol = this.mouseDownCol;
      context.contentWidth = this.contentWidth;
      // Sync semi-stable refs that may be wired after construction.
      context.commandRegistry = this.commandRegistry;
      context.commandContext = this.commandContext;
      context.autocomplete = this.autocomplete;
      context.inputHistory = this.inputHistory;
      context.conversationManager = this.conversationManager;
      // Swap requestRender to buffered version for this feed.
      context.requestRender = bufferedRequestRender;
      this.syncFeedSelectionCallback = (callback) => {
        context.selectionCallback = callback;
      };
      feedInputTokens(context, this.tokenizer.feed(data));
      this.prompt = context.prompt;
      this.cursorPos = context.cursorPos;
      this.inputScrollTop = context.inputScrollTop;
      this.commandMode = context.commandMode;
      this.indicatorFocused = context.indicatorFocused;
      this.helpOverlayActive = context.helpOverlayActive;
      this.helpScrollOffset = context.helpScrollOffset;
      this.shortcutsOverlayActive = context.shortcutsOverlayActive;
      this.shortcutsScrollOffset = context.shortcutsScrollOffset;
      this.selectionCallback = context.selectionCallback;
      this.nextPasteId = context.nextPasteId;
      this.nextImageId = context.nextImageId;
      this.mouseDownRow = context.mouseDownRow;
      this.mouseDownCol = context.mouseDownCol;
    } finally {
      this.syncFeedSelectionCallback = null;
      isFeeding = false;
      this.requestRender = immediateRequestRender;
    }

    if (renderRequested) {
      immediateRequestRender();
    }
  }

  /**
   * handlePaste - Shared paste logic for Ctrl+V and middle-click.
   * Tries image clipboard first, falls back to text paste.
   */
  public handlePaste(): ReturnType<typeof handleClipboardPaste> {
    return handlePasteForHandler(this);
  }

  /**
   * The clipboard this composer pastes from. Swappable so tests can supply a
   * clipboard instead of reaching for the machine's real one.
   */
  public clipboardSource: ClipboardPasteSource = { pasteImageFromClipboard, pasteFromClipboard };

  /** Content width for wrapping, set by main.ts via setContentWidth(). */
  public contentWidth = 76;

  /** Set the content width used for wrapping calculations. Call from main.ts. */
  public setContentWidth(w: number): void {
    this.contentWidth = w;
  }

  /**
   * Move cursor up or down by one WRAPPED line.
   * Uses the segment table to navigate visual lines, not raw \n lines.
   * Returns true if the cursor moved, false if at boundary.
   */
  public moveCursorVertical(direction: -1 | 1): boolean {
    const result = moveCursorVertical(
      this.prompt,
      this.cursorPos,
      this.inputScrollTop,
      this.contentWidth,
      InputHandler.MAX_INPUT_ROWS,
      direction,
    );
    this.cursorPos = result.cursorPos;
    this.inputScrollTop = result.inputScrollTop;
    return result.moved;
  }

  /**
   * Ensure the cursor's wrapped line is visible within the input scroll window.
   */
  public ensureInputCursorVisible(contentWidth?: number): void {
    this.inputScrollTop = ensureInputCursorVisible(
      this.prompt,
      this.cursorPos,
      this.inputScrollTop,
      contentWidth ?? this.contentWidth,
      InputHandler.MAX_INPUT_ROWS,
    );
  }

  /**
   * Get the number of visible prompt lines (capped at MAX_INPUT_ROWS),
   * accounting for word-wrapping within the content width.
   */
  public getVisiblePromptLineCount(contentWidth?: number): number {
    const info = this.getWrappedPromptInfo(contentWidth ?? 76);
    return Math.min(info.wrappedLines.length, InputHandler.MAX_INPUT_ROWS);
  }

  /**
   * Word-wrap the prompt and compute cursor display coordinates.
   * Returns wrapped lines, the cursor's position in wrapped coordinates,
   * and the visible slice respecting inputScrollTop.
   */
  public getWrappedPromptInfo(contentWidth: number): WrappedPromptInfo {
    // In concealed mode, wrap the MASKED buffer. maskConcealedText preserves
    // length and newlines, so wrapping and cursor coordinates are identical to
    // the plaintext while no plaintext character reaches the screen buffer.
    // This is the ONLY place the composer's text becomes screen lines, so
    // masking here covers every renderer that draws the composer.
    const displayPrompt = this.concealedInput ? maskConcealedText(this.prompt) : this.prompt;
    return getWrappedPromptInfo(
      displayPrompt,
      this.cursorPos,
      this.inputScrollTop,
      contentWidth,
      InputHandler.MAX_INPUT_ROWS,
    );
  }

  // ── Undo / Redo methods ─────────────────────────────────────────────────

  /**
   * saveUndoState - Snapshot current prompt + cursor onto the undo stack.
   * Clears the redo stack because a new edit invalidates future states.
   */
  public saveUndoState(): void {
    saveUndoState(this.undoStack, this.redoStack, this.prompt, this.cursorPos, InputHandler.MAX_UNDO);
  }

  /**
   * handleUndo - Ctrl+Z: pop from undo stack, push current to redo stack.
   */
  public handleUndo(): void {
    const state = undoPromptState(this.undoStack, this.redoStack, this.prompt, this.cursorPos);
    if (!state) return;
    this.prompt = state.prompt;
    this.cursorPos = state.cursorPos;
    this.ensureInputCursorVisible();
  }

  /**
   * handleRedo - Ctrl+Shift+Z: pop from redo stack, push current to undo stack.
   */
  public handleRedo(): void {
    const state = redoPromptState(this.undoStack, this.redoStack, this.prompt, this.cursorPos);
    if (!state) return;
    this.prompt = state.prompt;
    this.cursorPos = state.cursorPos;
    this.ensureInputCursorVisible();
  }

  // ── Path completion methods ─────────────────────────────────────────────

  /**
   * findPathToken - Scan backward from cursor to find a path-like token.
   * Detects:
   *   - !@<partial>  (inject mode)
   *   - @<partial>   (normal file ref)
   *   - plain word containing '/'
   * Returns { start, prefix } or null if no path token found.
   */
  /**
   * handlePathCompletion - Tab on a path-like token: fuzzy-complete from filePicker.allFiles.
   * Repeated Tab cycles through matches.
   * Returns true if path completion was performed.
   */
  public findPathToken(): { start: number; prefix: string } | null {
    return findPathToken(this.prompt, this.cursorPos);
  }

  public handlePathCompletion(): boolean {
    const result = handlePathCompletion({
      prompt: this.prompt,
      cursorPos: this.cursorPos,
      inputScrollTop: this.inputScrollTop,
      contentWidth: this.contentWidth,
      maxRows: InputHandler.MAX_INPUT_ROWS,
      pathCompletions: this.pathCompletions,
      pathCompletionIndex: this.pathCompletionIndex,
      pathCompletionPrefix: this.pathCompletionPrefix,
      pathCompletionStart: this.pathCompletionStart,
      allFiles: this.filePicker.allFiles,
      saveUndoState: () => this.saveUndoState(),
    });
    if (!result.handled) return false;
    this.prompt = result.prompt;
    this.cursorPos = result.cursorPos;
    this.inputScrollTop = result.inputScrollTop;
    this.pathCompletions = result.pathCompletions;
    this.pathCompletionIndex = result.pathCompletionIndex;
    this.pathCompletionPrefix = result.pathCompletionPrefix;
    this.pathCompletionStart = result.pathCompletionStart;
    return true;
  }

  public cycleAgentWorkspaceCategory(direction: 'next' | 'prev'): void {
    const context = this.commandContext;
    if (!this.agentWorkspace.active) {
      if (!context) return;
      this.indicatorFocused = false;
      this.modalOpened('agentWorkspace');
      this.agentWorkspace.open(
        context,
        (command, behavior) => this.dispatchAgentWorkspaceCommand(command, context, behavior),
        undefined,
        (prompt) => this.dispatchAgentWorkspacePrompt(prompt, context),
      );
    }
    this.agentWorkspace.cycleCategory(direction);
    this.indicatorFocused = false;
    this.requestRender();
  }

  /**
   * Word-wrap a single line to fit within maxW columns.
   * Breaks at spaces; words wider than maxW are force-broken.
   */
  public wordWrapLine(line: string, maxW: number): string[] {
    return wordWrapLine(line, maxW);
  }
}
