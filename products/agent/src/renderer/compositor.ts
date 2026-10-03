import { TerminalBuffer } from './buffer.ts';
import { DiffEngine } from './diff.ts';
import { type Line, createEmptyLine } from '@goodvibes-jev/engine/sdk/platform/types';
import type { SearchManager } from '../input/search.ts';
import { allowTerminalWrite, type TermColorCaps } from '@goodvibes-jev/engine/terminal-shell';
import { probeColorCaps } from './term-caps.ts';
import { activeTheme, activeTokens } from './theme.ts';
import type { SurfaceLayer } from './surface-kit.ts';
import { composeLayers } from './surface-compose.ts';

export interface SelectionInfo {
  isCellSelected: (col: number, absoluteRow: number) => boolean;
  scrollTop: number;
  lineCount: number;
}

export interface SearchInfo {
  manager: SearchManager;
  scrollTop: number;
  viewportStartY: number;
}

export interface CompositeRequest {
  width: number;
  height: number;
  header: Line[];
  viewport: Line[];
  footer: Line[];
  forceFullRedraw?: boolean;
  selection?: SelectionInfo;
  search?: SearchInfo;
  /**
   * Surfaces stamped over the finished screen, in order: modals (which dim
   * everything underneath first), popups and toasts. Screen coordinates.
   */
  layers?: readonly SurfaceLayer[];
}

/**
 * Compositor - Authoritative TUI layout engine with Selection Overlay.
 * Decoupled from global state, all needed data is passed as parameters.
 */
export class Compositor {
  /** Double-buffer reuse: back is written, front is the last-rendered reference. */
  private frontBuffer: TerminalBuffer | null = null;
  private backBuffer: TerminalBuffer | null = null;
  private readonly caps: TermColorCaps;
  private diffEngine: DiffEngine;

  constructor(private stdout: NodeJS.WriteStream) {
    // Probe terminal color capabilities once at construction time so the
    // DiffEngine downsamples every emitted SGR to the terminal's real level.
    // The hardcoded truecolor search-highlight hex below (and any future theme
    // colors) is therefore cap-gated, no raw #rrggbb leaks on a non-truecolor
    // terminal. (R4 later replaces the hardcoded hex with live activeTheme()
    // reads in its tone-read region; this R2 region owns only the caps wiring.)
    this.caps = probeColorCaps(stdout);
    this.diffEngine = new DiffEngine(this.caps);
  }

  /** Exposed for unit tests, returns the detected color capability. */
  public get termCapsForTest(): TermColorCaps {
    return this.caps;
  }

  /** Exposed for unit tests, returns the last composited buffer. */
  public get lastBufferForTest(): TerminalBuffer | null {
    return this.frontBuffer;
  }

  public resetDiff(): void {
    this.diffEngine.reset();
    this.frontBuffer = null;
    this.backBuffer = null;
  }

  public composite(params: CompositeRequest): void {
    const { width, height, header, viewport, footer, forceFullRedraw, selection, search, layers } = params;
    const previousFrontBuffer = forceFullRedraw ? null : this.frontBuffer;
    if (forceFullRedraw) this.diffEngine.reset();

    // R3: Reuse back-buffer instead of allocating each frame
    if (!this.backBuffer) {
      this.backBuffer = new TerminalBuffer(width, height);
    } else {
      this.backBuffer.reset(width, height, previousFrontBuffer);
    }
    const newBuffer = this.backBuffer;

    const leftWidth = width;

    // 1. Draw Header, always full width
    header.forEach((line, i) => newBuffer.blitLine(i, line));

    // 2. Draw Viewport directly after the supplied header.
    const viewportStartY = header.length;
    const vHeight = Math.max(0, height - header.length - footer.length);

    // Calculate the offset for bottom-anchored short history
    const lineCount = selection?.lineCount ?? 0;
    const offset = Math.max(0, vHeight - lineCount);

    // R4 tone-read region (the compositor is the pre-ruled R2→R4 shared file;
    // R2 owns the DiffEngine caps wiring above, R4 owns these live theme reads).
    // Read the search-highlight tones and the separator colour live per frame
    // so they follow the active theme.
    const T = activeTheme();

    viewport.forEach((line, i) => {
      const screenY = viewportStartY + i;
      if (screenY >= height) return;

      newBuffer.blitLine(screenY, line);

      // Apply Selection Highlighting Overlay (left side only)
      // Only highlight rows that actually contain history (past the bottom-anchor offset)
      if (selection && i >= offset) {
        const absoluteRow = selection.scrollTop + (i - offset);
        for (let x = 0; x < leftWidth; x++) {
          if (selection.isCellSelected(x, absoluteRow)) {
            // Mouse selection: the theme's selection fill with body text (the
            // inverse selectedListItemText is unreadable on this fill).
            const sel = activeTokens();
            newBuffer.setCell(x, screenY, { bg: sel.backgroundSelected, fg: sel.text, bold: false, dim: false });
          }
        }
      }

      // Apply Search Match Highlighting Overlay (left side only)
      if (search && search.manager.active && search.manager.query.length > 0 && i >= offset) {
        const absoluteRow = search.scrollTop + (i - offset);
        const lineMatches = search.manager.getMatchesOnLine(absoluteRow);
        for (const match of lineMatches) {
          const isCurrent = search.manager.isCurrentMatch(absoluteRow, match.col);
          for (let x = match.col; x < match.col + match.length && x < leftWidth; x++) {
            if (isCurrent) {
              newBuffer.setCell(x, screenY, { bg: T.searchCurrentBg, fg: T.searchCurrentFg, bold: true, dim: false });
            } else {
              newBuffer.setCell(x, screenY, { bg: T.searchMatchBg, fg: T.searchMatchFg, bold: false, dim: false });
            }
          }
        }
      }
    });

    for (let i = viewport.length; i < vHeight; i += 1) {
      const screenY = viewportStartY + i;
      if (screenY >= height) break;
      newBuffer.blitLine(screenY, createEmptyLine(width));
    }

    // 3. Draw Footer (Pinned to Bottom), always full width
    const footerStart = height - footer.length;
    footer.forEach((line, i) => {
      const screenY = footerStart + i;
      if (screenY >= height) return;
      newBuffer.blitLine(screenY, line);
    });

    // 4. Modal passes: dim the composed screen, then stamp each surface over
    // it (cells outside a surface keep their dimmed content). Runs after the
    // selection and search passes so those dim along with everything else.
    if (layers && layers.length > 0) composeLayers(newBuffer, layers);

    // 5. Diff and Render
    // R3: Diff against front-buffer (last-rendered), then swap front/back, no clone() needed
    const diff = this.diffEngine.diff(previousFrontBuffer, newBuffer);
    if (diff) {
      allowTerminalWrite(() => this.stdout.write(diff));
    }

    // Swap: back (just written) becomes the new front reference; old front becomes the next back
    const swap = this.frontBuffer;
    this.frontBuffer = this.backBuffer;
    this.frontBuffer.clearDirty();
    this.backBuffer = swap;
  }
}
