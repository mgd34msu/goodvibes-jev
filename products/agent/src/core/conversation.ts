import type { RuntimeEventProvenance } from '@goodvibes-jev/engine/sdk/platform/runtime/bootstrap';
import { readTreeGlyphSet, TREE_GLYPHS_CONFIG_KEY } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import { InfiniteBuffer } from '@goodvibes-jev/engine/terminal-shell';
import { createEmptyLine, type Line, type Cell } from '@goodvibes-jev/engine/sdk/platform/types';
import type { SplashOptions } from '../utils/splash-lines.ts';
import type { ToolCall, ToolResult } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ProviderMessage, ContentPart } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { TranscriptEventKind } from '@goodvibes-jev/engine/sdk/platform/core';
import {
  ConversationManager as SdkConversationManager,
  type BlockMeta as SdkBlockMeta,
} from '@goodvibes-jev/engine/sdk/platform/core';
import {
  addConversationSplashScreen,
  conversationTextToLines,
  logConversationText,
} from './conversation-rendering.ts';
import { renderMarkdown } from '../renderer/markdown.ts';
import type { BlockMeta } from './conversation-types.ts';
import { DisplayOnlyOutput } from './conversation-display-only.ts';
import { MessageLineCache } from './conversation-line-cache.ts';
import type { WorkTreeSources } from './work-tree-sources.ts';
import { renderStreamingContinuation } from './work-tree-render.ts';
import { WorkTreeController } from './work-tree-focus.ts';
import { isWorkTreeFoldKey } from './work-tree-fold-store.ts';
import { probeUnicodeSupport, type TreeGlyphSetName } from '../renderer/lane-graph/glyphs.ts';

/**
 * ConversationManager - TUI subclass of the SDK's ConversationManager.
 * Adds InfiniteBuffer history, block registry, collapse state, width tracking,
 * dirty flag, display methods, splash screen, error/event navigation, and
 * Line[]-based rendering atop the SDK's message management.
 */

// Re-export SDK types for backward compatibility
export type {
  TokenUsage,
  ConversationMessageSnapshot,
  ConversationTitleSource,
} from '@goodvibes-jev/engine/sdk/platform/core';

export type { SdkBlockMeta };

/** The app's BlockMeta (see conversation-types.ts), re-exported for every existing importer. */
export type { BlockMeta };

// Import internal types needed for rendering helpers
import type { ConversationMessageSnapshot } from '@goodvibes-jev/engine/sdk/platform/core';
type Message = ConversationMessageSnapshot;

/** Receives every system notice added to (or restored into) the conversation. */
export type NoticeSink = (content: string, options: { readonly restored: boolean; readonly runtimeEvent?: RuntimeEventProvenance | undefined }) => void;

export class ConversationManager extends SdkConversationManager {
  public history = new InfiniteBuffer();
  /** Display-only output kept for redraw (conversation-display-only.ts). */
  private readonly displayOnly = new DisplayOnlyOutput();
  private _getWidth: () => number;
  /** Tracks the rendered width; a change invalidates the full history. */
  private lastRenderedWidth = 0;
  /** When true the buffer needs to be rebuilt before the next display. */
  private dirty = true;

  /** Optional config manager for display settings. */
  private _configManager: ConfigManager | null = null;
  /** Collapse state: stable key (msg_N) -> collapsed (true = collapsed). */
  private collapseState: Map<string, boolean> = new Map();
  /** Block registry: track rendered blocks for copy/apply. */
  protected blockRegistry: BlockMeta[] = [];
  /** Message index -> first rendered line index in the history buffer. */
  private messageLineRegistry: number[] = [];
  /** Registry of rendered line indices for system messages matching a leading [error]/[critical] tag or error:/error! prefix. */
  private errorLineRegistry: number[] = [];
  /** Streaming block start line in history buffer (for incremental streaming update). */
  private streamingStartLine = -1;
  /** Width the streaming block was last drawn at; a change forces the pending rebuild first. */
  private _streamWidth = -1;
  /**
   * Message index at the time of the last clearDisplay() call.
   * rebuildHistory() renders only messages at or after this index, so the
   * display stays blank for messages added before the clear while LLM history
   * is fully preserved. Reset to 0 on resetAll() or rebuildHistory() width change.
   */
  private _displayFromMessageIndex = 0;

  public suppressSplash: boolean = false;
  private noticeSink: NoticeSink | null = null;
  private usageHydrator: (() => void) | null = null;

  /** The shell's usage restore adapter, shared by every history replacement. */
  public setUsageHydrator(hydrate: () => void): void {
    this.usageHydrator = hydrate;
  }
  public splashOptions: SplashOptions = {};
  private splashOnScreen = false;
  /** Per-unit rendered-line cache: an unchanged turn or message is never redrawn (conversation-line-cache.ts). */
  private lineCache = new MessageLineCache();
  /** Live facts the work tree reads (timings, agent lanes, waiting calls); see work-tree-sources.ts. */
  private workTreeSources: WorkTreeSources = {};
  /** Turn activity at the last build: a change forces a rebuild (a finished turn's header must drop "working"). */
  private builtWhileActive = false;
  /** Whether the terminal draws unicode; ascii work-tree glyphs when not. */
  private unicodeCapable = probeUnicodeSupport();
  /** Keyboard focus, live repaint and fold state of the work tree (work-tree-focus.ts). */
  public readonly workTree: WorkTreeController = new WorkTreeController({
    blocks: () => { this.flushHistory(); return this.blockRegistry; },
    collapseState: () => this.collapseState,
    markDirty: () => this.markDirty(),
    noteUserTouch: (key) => this.noteUserTouch(key),
    drewLive: () => this.lineCache.live,
  });

  constructor(
    getWidth: () => number = () => process.stdout.columns || 80,
    configManager?: ConfigManager,
  ) {
    super();
    this._getWidth = getWidth;
    this._configManager = configManager ?? null;
  }

  /** Wire in a config manager after construction (e.g. from main.ts). */
  public setConfigManager(cm: ConfigManager): void {
    this._configManager = cm;
  }

  /** Update the width provider so shell layout can own transcript width. */
  public setWidthProvider(getWidth: () => number): void {
    this._getWidth = getWidth;
    this.markDirty();
  }

  // -------------------------------------------------------------------------
  // Overrides: add markDirty() to message mutations
  // -------------------------------------------------------------------------

  public override addUserMessage(content: string | ContentPart[]): void {
    super.addUserMessage(content);
    this.markDirty();
  }

  public override addAssistantMessage(
    content: string,
    opts?: {
      toolCalls?: ToolCall[];
      reasoningContent?: string;
      reasoningSummary?: string;
      usage?: import('@goodvibes-jev/engine/sdk/platform/core').TokenUsage;
      model?: string;
      provider?: string;
    },
  ): void {
    super.addAssistantMessage(content, opts);
    this.markDirty();
  }

  public override addToolResults(results: ToolResult[]): void {
    super.addToolResults(results);
    this.markDirty();
  }

  public override addSystemMessage(content: string, runtimeEvent?: RuntimeEventProvenance): void {
    super.addSystemMessage(content, runtimeEvent);
    this.markDirty();
    this.noticeSink?.(content, { restored: false, runtimeEvent });
  }

  /**
   * Where system notices go (core/notices.ts: a toast and the notification
   * history). The main transcript does not draw system messages; this sink is
   * how each one is seen. Wired by the shell; absent in bare test conversations.
   */
  public setNoticeSink(sink: NoticeSink | null): void {
    this.noticeSink = sink;
  }

  public override undo(): boolean {
    const result = super.undo();
    if (result) this.markDirty();
    return result;
  }

  public override redo(): boolean {
    const result = super.redo();
    if (result) this.markDirty();
    return result;
  }

  public override removeMessagesAfter(count: number): void {
    super.removeMessagesAfter(count);
    this.markDirty();
  }

  public override markLastUserMessageCancelled(): void {
    super.markLastUserMessageCancelled();
    this.markDirty();
  }

  // -------------------------------------------------------------------------
  // Streaming overrides: add rendering tracking
  // -------------------------------------------------------------------------

  /**
   * startStreamingBlock - Add a placeholder assistant message for incremental display.
   * Called when streaming begins.
   */
  public override startStreamingBlock(): void {
    super.startStreamingBlock();
    this.markDirty();
    // Record the line where the streaming block starts so updates can be incremental.
    // The rebuild already treats the placeholder as streaming (its turn ends
    // without a blank row, the text continues under its spine), the same as a
    // rebuild later in the stream does.
    this.streamingStartLine = 0;
    this.flushHistory();
    // The streamed text starts above any display-only draws kept below it.
    this.streamingStartLine = this.history.getLineCount() - this.displayOnly.trailingLineCount;
    this._streamWidth = this._getWidth();
  }

  /**
   * updateStreamingBlock - Update the in-progress streaming block with accumulated content.
   * Called per-delta during streaming. Does NOT trigger a full rebuild, instead it
   * directly updates the history buffer from streamingStartLine onward.
   */
  public override updateStreamingBlock(content: string): void {
    super.updateStreamingBlock(content);
    // Incrementally update the history buffer instead of a full rebuild: the
    // streamed text continues under the spine of the turn it belongs to.
    if (this.streamingStartLine >= 0) {
      // A terminal resized mid-stream: run the pending width-change rebuild
      // first. rebuildHistory() re-anchors streamingStartLine to the new
      // buffer, so the truncate below targets the right offset.
      if (this._getWidth() !== this._streamWidth) this.flushHistory();
      const width = this._getWidth();
      this.history.truncateToLine(this.streamingStartLine);
      this.history.addLines(this.streamingLines(content, width));
      this.displayOnly.drawTrailing(width, () => this.history.getLineCount());
    }
  }

  /**
   * finalizeStreamingBlock - Remove the streaming placeholder.
   * The orchestrator calls addAssistantMessage immediately after with the final content.
   */
  public override finalizeStreamingBlock(): void {
    super.finalizeStreamingBlock();
    this.streamingStartLine = -1;
    this.displayOnly.resetTrailing();
    this._streamWidth = -1;
    this.markDirty();
  }

  // -------------------------------------------------------------------------
  // Overrides: reset / replace / branch operations that also affect display
  // -------------------------------------------------------------------------

  /**
   * resetAll - Clear both the display buffer and all conversation messages.
   * This is a full reset; the LLM context is wiped.
   */
  public override resetAll(): void {
    super.resetAll();
    this.history.clear();
    this.lastRenderedWidth = 0;
    this.dirty = true;
    this.collapseState.clear();
    this.blockRegistry = [];
    this.messageLineRegistry = [];
    this.errorLineRegistry = [];
    this.streamingStartLine = -1;
    this.displayOnly.drop();
    this.lineCache.clear();
    this.workTree.reset();
    this._displayFromMessageIndex = 0; // full reset, show everything on next render
  }

  /** Compaction's replace: the SDK keeps every kept message whole (tool calls, model, reasoning); the display rebuilds. */
  public override replaceMessagesForLLM(newMessages: ProviderMessage[]): void {
    super.replaceMessagesForLLM(newMessages);
    this.history.clear();
    this.lineCache.clear();
    this.lastRenderedWidth = 0;
    this.dirty = true;
  }

  /**
   * switchBranch - Replace the active messages with the stored branch snapshot.
   * Returns true on success, false if the branch does not exist.
   */
  public override switchBranch(name: string): boolean {
    const result = super.switchBranch(name);
    if (result) this.markDirty();
    return result;
  }

  /**
   * mergeBranch - Append all messages from the named branch that come after
   * the fork point.
   * Returns true on success, false if the branch does not exist.
   */
  public override mergeBranch(name: string): boolean {
    const result = super.mergeBranch(name);
    if (result) this.markDirty();
    return result;
  }

  /**
   * fromJSON - Restore conversation from persisted data.
   */
  public override fromJSON(data: {
    messages: Message[];
    branches?: Record<string, Message[]>;
    currentBranch?: string;
    title?: string;
    titleSource?: import('@goodvibes-jev/engine/sdk/platform/core').ConversationTitleSource;
  }): void {
    super.fromJSON(data);
    this.usageHydrator?.();
    // A restored session's notices go back into the history (not toasted).
    for (const message of data.messages) if (message.role === 'system') this.noticeSink?.(message.content, { restored: true, runtimeEvent: message.runtimeEvent });
    // Output printed over the conversation this one replaces is not about it.
    this.displayOnly.drop();
    this.history.clear();
    this.lineCache.clear();
    this.lastRenderedWidth = 0;
    this.dirty = true;
  }

  // -------------------------------------------------------------------------
  // TUI-only display methods
  // -------------------------------------------------------------------------

  public getDisplayBlocks(): Line[] {
    this.flushHistory();
    return this.history.getAllLines();
  }

  /**
   * clearLineCache - Drop every cached per-unit Line[] and force a full cold
   * re-render on the next display. The rendered output is unchanged (the cache
   * is a pure memoisation); this only discards the reuse, e.g. to reclaim memory
   * or to assert cache/cold equivalence in tests.
   */
  public clearLineCache(): void {
    this.lineCache.clear();
    this.dirty = true;
  }

  /** Number of per-unit Line[] entries retained (bounded by the visible transcript). */
  public getLineCacheSize(): number {
    return this.lineCache.size;
  }

  /**
   * rebuildHistory - Full rebuild. Called when dirty flag is set or terminal width changes.
   */
  public rebuildHistory(): void {
    this.history.clear();
    this.blockRegistry = [];
    this.messageLineRegistry = [];
    this.errorLineRegistry = [];
    const width = this._getWidth();
    this.lastRenderedWidth = width;
    this.dirty = false;
    this.builtWhileActive = this.workTreeSources.turnActive?.() ?? false;
    this.displayOnly.resetTrailing();

    const snapshot = this.getMessageSnapshot();
    // During streaming, the in-progress placeholder (always the last message) is
    // rendered here as EMPTY; the incremental streaming path (updateStreamingBlock)
    // owns its content. This keeps streamingStartLine valid across rebuilds
    // (a width change, a running bead's repaint), otherwise the placeholder would
    // be drawn twice: once here and once by the streaming path.
    const lastMsg = snapshot[snapshot.length - 1];
    const isStreaming = this.streamingStartLine >= 0 && lastMsg?.role === 'assistant';
    const renderSnapshot = isStreaming
      ? [...snapshot.slice(0, -1), { ...lastMsg, content: '' } as Message]
      : snapshot;
    // When _displayFromMessageIndex > 0, clearDisplay() was called. Only render
    // messages added after the clear, the pre-clear history stays off-screen.
    const displayStart = this._displayFromMessageIndex;
    const visibleSnapshot = displayStart > 0 ? renderSnapshot.slice(displayStart) : renderSnapshot;

    // Tool and system messages are not transcript content: a system message is
    // a notice (a toast and the notification history, see core/notices.ts).
    const displayMessages = visibleSnapshot.filter(
      (m) => m.role !== 'tool' && m.role !== 'system',
    );

    // Printed output (a command run before the first message) replaces the
    // splash, or the next rebuild would draw the splash over it.
    if (displayMessages.length === 0 && displayStart === 0 && !this.suppressSplash && this.displayOnly.count === 0) {
      this.splashOnScreen = true;
      this.addSplashScreen(width);
      return;
    }

    this.splashOnScreen = false;
    // Display-only draws go back where they were printed: after the unit that
    // holds the last message that existed then. The turn still streaming is
    // last and its text continues below it, so what follows it waits.
    const kept = this.displayOnly.cursor(width);
    kept.through(displayStart - 1);
    this.lineCache.renderInto(this.renderingContext(), visibleSnapshot, width, this.messageLineRegistry, displayStart, isStreaming ? snapshot.length - 1 : -1, (last, streaming) => { if (!streaming) kept.through(last); });
    if (!isStreaming) kept.through(Number.POSITIVE_INFINITY);

    if (isStreaming) {
      // Re-anchor the streaming block to the freshly rebuilt buffer and redraw
      // the in-progress content at the current width, mirroring startStreamingBlock.
      this.streamingStartLine = this.history.getLineCount();
      this._streamWidth = width;
      const streamingContent = lastMsg?.content;
      if (typeof streamingContent === 'string' && streamingContent.length > 0) {
        this.history.addLines(this.streamingLines(streamingContent, width));
      }
      kept.trailStreamed(() => this.history.getLineCount()); // printed this turn: below the streamed text
    }
  }

  /** Keep a display-only draw and draw it now (below streamed text while streaming; over the splash, the next frame rebuilds without it). */
  private recordDisplayOnly(draw: (width: number) => void): void {
    const seq = this.displayOnly.keep(this.getMessageSnapshot().length, draw);
    if (this.splashOnScreen) return this.markDirty();
    const before = this.history.getLineCount();
    draw(this._getWidth());
    this.displayOnly.noteDrawn(seq, this.history.getLineCount() - before, this.streamingStartLine >= 0);
  }

  /** Display-only draws kept for redraw (bounded; for memory-hygiene assertions). */
  public getDisplayOnlyCount(): number { return this.displayOnly.count; }

  /**
   * flushHistory - Rebuilds the full buffer when dirty or when the terminal width has changed.
   * Clears the history buffer and re-renders all messages from scratch on each call.
   * No-ops when the buffer is clean and width is unchanged.
   */
  public flushHistory(): void {
    const currentWidth = this._getWidth();
    if ((this.workTreeSources.turnActive?.() ?? false) !== this.builtWhileActive) this.dirty = true;
    if (!this.dirty && currentWidth === this.lastRenderedWidth) return;
    this.rebuildHistory();
  }

  /**
   * Mark every rendered line stale so the next flush re-renders the transcript.
   * Registered as a theme refresher (main.ts): rendered lines carry concrete
   * colours, so a theme or mode change must redraw them in the new colours.
   */
  public invalidateRenderedLines(): void {
    this.markDirty();
  }

  private markDirty(): void {
    this.dirty = true;
  }

  private renderingContext() {
    return {
      history: this.history,
      blockRegistry: this.blockRegistry,
      collapseState: this.collapseState,
      errorLineRegistry: this.errorLineRegistry,
      configManager: this._configManager,
      splashOptions: this.splashOptions,
      systemNotices: 'elsewhere' as const,
      workTreeSources: this.workTreeSources,
      treeGlyphSet: this.treeGlyphSet(),
      focusId: this.workTree.focus,
      frame: this.workTree.frame,
    };
  }

  /** The work tree's glyph set: display.treeGlyphs, ascii on a terminal without unicode. */
  private treeGlyphSet(): TreeGlyphSetName {
    return readTreeGlyphSet(
      key => key === TREE_GLYPHS_CONFIG_KEY
        ? Reflect.get(this._configManager?.getRaw().display ?? {}, 'treeGlyphs')
        : undefined,
      this.unicodeCapable,
    );
  }

  /** Streaming text: under the spine of the turn it belongs to when there is one, else full width. */
  private streamingLines(content: string, width: number): Line[] {
    const tail = this.lineCache.lastTail;
    if (!tail) return renderMarkdown(content, width);
    return renderStreamingContinuation(content, width, tail, this.treeGlyphSet());
  }

  // -------------------------------------------------------------------------
  // Work tree (see work-tree-model.ts / work-tree-focus.ts)
  // -------------------------------------------------------------------------

  /** Live facts the work tree draws: timings, agent lanes, the call a prompt is holding. */
  public setWorkTreeSources(sources: WorkTreeSources): void { this.workTreeSources = sources; this.markDirty(); }
  // An agent view (core/agent-view-render.ts) draws with main's sources, glyphs and the agent's lane color.
  public getWorkTreeSources(): WorkTreeSources { return this.workTreeSources; }
  public getTreeGlyphSet(): TreeGlyphSetName { return this.treeGlyphSet(); }
  public laneColorOf(agentId: string): number | undefined { return this.getBlockRegistry().find((b) => b.workTree?.kind === 'lane' && b.workTree.agentId === agentId)?.workTree?.colorIndex; }
  /** Override the unicode probe (tests, and a terminal the caller knows better). */
  public setUnicodeCapable(capable: boolean): void { this.unicodeCapable = capable; this.markDirty(); }

  /** Find the nearest block to a given line index, optionally filtered by type. */
  public findNearestBlock(lineIndex: number, typeFilter?: string): BlockMeta | null {
    let nearest: BlockMeta | null = null;
    let nearestDist = Infinity;
    for (const block of this.blockRegistry) {
      if (typeFilter !== undefined && block.type !== typeFilter) continue;
      if (lineIndex >= block.startLine && lineIndex < block.startLine + block.lineCount) {
        return block;
      }
      const dist = Math.abs(block.startLine - lineIndex);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = block;
      }
    }
    return nearest;
  }

  /**
   * isCollapsed - Returns whether the block at blockIndex is collapsed.
   */
  public isCollapsed(blockIndex: number): boolean {
    const block = this.blockRegistry[blockIndex];
    if (!block) return false;
    return this.collapsedNow(block);
  }

  /** Current collapse of a block: an unset bead key is a closed bead; everything else defaults open. */
  private collapsedNow(block: BlockMeta): boolean {
    const stored = this.collapseState.get(block.collapseKey);
    return block.workTree?.kind === 'bead' ? stored !== false : stored ?? false;
  }

  /**
   * getBlockContentAtLine - Find the nearest block to the given line index.
   * Returns the raw content of the block, or null if not found.
   */
  public getBlockContentAtLine(lineIndex: number): string | null {
    return this.findNearestBlock(lineIndex)?.rawContent ?? null;
  }

  /**
   * getDiffAtLine - Find the diff block nearest the given line index.
   * Returns file path and original/updated content for applying.
   */
  public getDiffAtLine(lineIndex: number): { filePath: string; original: string; updated: string } | null {
    const nearest = this.findNearestBlock(lineIndex, 'diff');
    if (!nearest || !nearest.filePath) return null;
    return {
      filePath: nearest.filePath,
      original: nearest.diffOriginal ?? '',
      updated: nearest.diffUpdated ?? '',
    };
  }

  /**
   * toggleCollapseAtLine - Toggle the collapse state of the nearest block to the given line.
   * Triggers a rebuild. Returns the blockIndex toggled, or -1 if none found.
   */
  public toggleCollapseAtLine(lineIndex: number): number {
    const nearest = this.findNearestBlock(lineIndex);
    if (!nearest) return -1;
    const current = this.collapsedNow(nearest);
    this.collapseState.set(nearest.collapseKey, !current);
    this.noteUserTouch(nearest.collapseKey);
    this.markDirty();
    if (isWorkTreeFoldKey(nearest.collapseKey)) this.workTree.notifyFoldChange();
    return nearest.blockIndex;
  }

  /**
   * Collapse keys currently expanded because the user NAVIGATED to a search
   * match hidden inside them (see search.ts's revealCurrentMatch), never
   * because they were expanded by typing, and never keys the user touched
   * some other way (see noteUserTouch, which removes a key from this set).
   * restoreSearchExpansions() re-folds everything still in this set when
   * search closes, so the transcript the user had collapsed comes back
   * exactly as they left it.
   */
  private searchExpandedKeys = new Set<string>();

  /**
   * Collapse keys the user has explicitly acted on at least once (Tab
   * toggle via toggleCollapseAtLine, Ctrl+Y copy, Ctrl+B bookmark, see
   * handler-content-actions.ts). Membership here permanently exempts a key
   * from restoreSearchExpansions()'s auto-re-collapse, even if search
   * originally opened it, an explicit user action always outranks search's
   * own bookkeeping. Grows for the life of the conversation; never pruned,
   * since membership only ever gates one decision (whether to
   * auto-re-collapse) and a stale positive is harmless.
   */
  private userTouchedKeys = new Set<string>();

  /** Record that `collapseKey` was expanded because the user navigated to a
   *  search match hidden inside it, so restoreSearchExpansions() knows to
   *  fold it back up on close (unless the user separately touches it while
   *  it's open, see noteUserTouch). No-op for a key the user already
   *  touched explicitly, since that ownership always wins. */
  public markSearchExpanded(collapseKey: string): void {
    if (!this.userTouchedKeys.has(collapseKey)) this.searchExpandedKeys.add(collapseKey);
  }

  /** Record an explicit user action on `collapseKey` (toggle/copy/bookmark).
   *  Exempts it from restoreSearchExpansions()'s auto-re-collapse for the
   *  rest of the session, the user's own choice always wins over search's
   *  bookkeeping, whether they acted on it before search touched it or while
   *  it was sitting auto-expanded. */
  public noteUserTouch(collapseKey: string): void {
    this.userTouchedKeys.add(collapseKey);
    this.searchExpandedKeys.delete(collapseKey);
  }

  /**
   * Re-collapse every key search auto-expanded during the just-closed search
   * session, except ones the user explicitly touched while they were open,
   * called from SearchManager.close(). Restores the transcript's pre-search
   * collapse state without disturbing any collapse state search never
   * touched in the first place.
   */
  public restoreSearchExpansions(): void {
    if (this.searchExpandedKeys.size === 0) return;
    for (const key of this.searchExpandedKeys) {
      this.collapseState.set(key, true);
    }
    this.searchExpandedKeys.clear();
    this.markDirty();
  }

  /** First rendered line for message `absoluteIdx` (undefined if never
   *  rendered). For a folded tool-group member this is the group's own
   *  header line, not the following message's position, see
   *  messageLineRegistry's doc. Flushes history if dirty. */
  public getMessageLine(absoluteIdx: number): number | undefined {
    this.flushHistory();
    return this.messageLineRegistry[absoluteIdx];
  }

  /** Set a collapseKey's state directly, bypassing block lookup, needed for
   *  a key with no BlockMeta yet (a folded tool-group member's own
   *  `msg_<idx>` key only becomes a real block once its group expands). */
  public setCollapsed(collapseKey: string, collapsed: boolean): void {
    this.collapseState.set(collapseKey, collapsed);
    this.markDirty();
  }

  /** Returns a read-only view of the block registry for external consumers. */
  public getBlockRegistry(): readonly BlockMeta[] {
    return this.blockRegistry;
  }

  /**
   * getErrorLines - Returns line indices in the rendered history buffer for
   * system messages that contain 'error' (case-insensitive).
   * Triggers a history flush if dirty.
   */
  public getErrorLines(): number[] {
    this.flushHistory();
    return [...this.errorLineRegistry];
  }

  /**
   * nextErrorLine - Find the next error line after currentLine (wraps around).
   * Returns -1 if there are no error lines.
   */
  public nextErrorLine(currentLine: number): number {
    const errors = this.getErrorLines();
    if (errors.length === 0) return -1;
    const after = errors.find(l => l > currentLine);
    return after ?? errors[0];
  }

  /**
   * prevErrorLine - Find the previous error line before currentLine (wraps around).
   * Returns -1 if there are no error lines.
   */
  public prevErrorLine(currentLine: number): number {
    const errors = this.getErrorLines();
    if (errors.length === 0) return -1;
    const before = [...errors].reverse().find(l => l < currentLine);
    return before ?? errors[errors.length - 1];
  }

  public nextTranscriptEventLine(currentLine: number, kind: TranscriptEventKind | 'all' = 'all'): number {
    this.flushHistory();
    const index = this.getTranscriptEventIndex();
    const events = kind === 'all' ? index.events : index.events.filter((event) => event.kind === kind);
    if (events.length === 0) return -1;
    const lines = events
      .map((event) => this.messageLineRegistry[event.messageIndex] ?? -1)
      .filter((line) => line >= 0)
      .sort((a, b) => a - b);
    if (lines.length === 0) return -1;
    const after = lines.find((line) => line > currentLine);
    return after ?? lines[0]!;
  }

  public prevTranscriptEventLine(currentLine: number, kind: TranscriptEventKind | 'all' = 'all'): number {
    this.flushHistory();
    const index = this.getTranscriptEventIndex();
    const events = kind === 'all' ? index.events : index.events.filter((event) => event.kind === kind);
    if (events.length === 0) return -1;
    const lines = events
      .map((event) => this.messageLineRegistry[event.messageIndex] ?? -1)
      .filter((line) => line >= 0)
      .sort((a, b) => a - b);
    if (lines.length === 0) return -1;
    const before = [...lines].reverse().find((line) => line < currentLine);
    return before ?? lines[lines.length - 1]!;
  }

  /** True while the last rebuild drew the splash (the shell centers it vertically). */
  public isSplashShowing(): boolean {
    return this.splashOnScreen;
  }

  public setSplashSuppressed(suppressed: boolean): void {
    if (this.suppressSplash === suppressed) return;
    this.suppressSplash = suppressed;
    this.markDirty();
  }

  private addSplashScreen(width: number): void {
    addConversationSplashScreen(this.renderingContext(), width);
  }

  public textToLines(text: string, width: number, style: Partial<Cell> = {}): Line[] {
    return conversationTextToLines(text, width, style);
  }

  /** Print display-only text into the transcript (never a message); it survives every rebuild. */
  public log(text: string, style: Partial<Cell> = {}, indent = '      '): void {
    this.recordDisplayOnly((width) => logConversationText(this.renderingContext(), width, text, style, indent));
  }

  /** Persistent display-only prose, rewrapped at the current width on every rebuild. */
  public logWrapped(text: string, style: Partial<Cell> = {}): void {
    this.recordDisplayOnly((width) => this.history.addLines(conversationTextToLines(text, width, style)));
  }

  /**
   * clearDisplay - Clear the visual history buffer without touching the LLM context messages.
   * The next render will show a blank conversation area. Subsequent message additions
   * rebuild the display incrementally from that point forward.
   *
   * Contract:
   * - getDisplayBlocks() returns an empty array immediately after this call.
   * - getMessageSnapshot() is unaffected, full LLM history is preserved.
   * - resetAll() (which clears both display and messages) continues to work.
   * - rebuildHistory() can be called by callers that need a full display rebuild.
   */
  public clearDisplay(): void {
    this.history.clear();
    this.displayOnly.drop();
    this.blockRegistry = [];
    this.messageLineRegistry = [];
    this.errorLineRegistry = [];
    // Advance _displayFromMessageIndex to exclude all current messages from display.
    // rebuildHistory() will only render messages added AFTER this point.
    this._displayFromMessageIndex = this.getMessageSnapshot().length;
    this.dirty = false;
    // Do NOT re-render here, display stays blank until the next message is added.
    // The lastRenderedWidth is kept so subsequent appends use the correct width.
  }
}

export { parseDiffForApply, applyDiffContent } from '@goodvibes-jev/engine/sdk/platform/core';
