/**
 * fullscreen-workspace.ts, the frame of the Agent operator workspace, drawn
 * with the modal surface kit.
 *
 *   ✦ Agent workspace › Setup · 12 actions            actions    esc
 *
 *   ✦ start              element panel
 *     ▸ Home               Setup                         (context rows)
 *       Setup              Sign in, pick a model, and connect the basics.
 *   ✦ assistant
 *       Memory             Option              Does       (control rows)
 *                          Sign in to a provider   …     (selected: gradient)
 *
 *   ↑↓ move   ←→ pane   ⏎ open   /  search   r refresh
 *
 * The workspace keeps its own content builders (agent-workspace.ts): the
 * category rail, the context rows and the control rows are plain rows. This
 * frame lays them into the standard modal geometry over the dimmed screen:
 * the rail on the left (✦ group headers, the selected area as the gradient
 * or in the brand color when focus is on the actions), an element panel on
 * the right holding the context above and the controls below, and the
 * footer's key/action pairs as keycap hints. Rows arrive pre-wrapped to the
 * widths getFullscreenWorkspaceMetrics reports, so nothing is clipped.
 */

import { GLYPHS } from './ui-primitives.ts';
import { FULLSCREEN_PALETTE, clamp } from './fullscreen-primitives.ts';
import { activeTokens } from './theme.ts';
import {
  MODAL_MARK_INSET,
  beginModal,
  finishModal,
  hintLayoutWidth,
  layoutHintRows,
  maxModalHeight,
  modalGeometry,
  modalInnerWidth,
  wrapLines,
  type KitHint,
  type SurfaceLayer,
} from './surface-kit.ts';
import { panel } from './surface-kit-parts.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import { kitHintsFromStrings } from './surface-kit-extra.ts';

export {
  clamp,
  padDisplay,
  stableWindow,
} from './fullscreen-primitives.ts';
export { FULLSCREEN_PALETTE as WORKSPACE_PALETTE } from './fullscreen-primitives.ts';

const WORKSPACE_PALETTE = FULLSCREEN_PALETTE;

export interface WorkspaceRow {
  readonly text: string;
  readonly selected?: boolean;
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly fg?: string;
  readonly bg?: string;
  readonly kind?: 'group' | 'item' | 'more' | 'empty';
}

export interface FullscreenWorkspaceRenderOptions {
  /** Screen width and height (the workspace is a modal sized against them). */
  readonly width: number;
  readonly height: number;
  readonly title: string;
  readonly stateLabel?: string;
  readonly leftHeader: string;
  readonly mainHeader: string;
  readonly leftRows: readonly WorkspaceRow[];
  readonly contextRows: readonly WorkspaceRow[];
  readonly controlRows: readonly WorkspaceRow[];
  /** "Key action · Key action" pairs; they become keycap hints. */
  readonly footer: string;
  readonly leftWidth?: number;
  readonly contextRatio?: number;
  readonly minContextRows?: number;
  /** Rows the context wants; it grows toward this while the controls keep their minimum. */
  readonly contextNeed?: number;
}

/** Control rows the context never takes (the action list stays usable). */
const MIN_CONTROL_ROWS = 10;

export interface FullscreenWorkspaceMetrics {
  readonly safeWidth: number;
  readonly safeHeight: number;
  /** Columns of the category rail's text. */
  readonly leftWidth: number;
  /** Columns of the element panel's text. */
  readonly centerWidth: number;
  /** Rows of the category rail. */
  readonly bodyRows: number;
  readonly contextWidth: number;
  readonly contextRows: number;
  readonly controlRows: number;
}

/** Split a legacy footer ("a · b · c", "Enter next/save") into keycap hints. */
export function workspaceHints(footer: string): KitHint[] {
  const parts = footer.split(/\s+·\s+/).map((part) => part.trim()).filter(Boolean);
  return kitHintsFromStrings(parts).hints;
}

/**
 * The workspace is the Agent's main operator surface, so it takes the whole
 * width minus one column per side (the kit's narrow-screen geometry) instead
 * of the standard 86% modal width.
 */
function workspaceWidth(screenWidth: number): number {
  return Math.max(10, screenWidth - 2);
}

/** Hint rows the footer takes in a modal of this width (0 when it has no key pairs). */
function hintRowCount(screenWidth: number, screenHeight: number, footer: string | undefined): number {
  if (!footer) return 1;
  const hints = workspaceHints(footer);
  if (hints.length === 0) return 0;
  const inner = modalInnerWidth(modalGeometry(screenWidth, screenHeight, { width: workspaceWidth(screenWidth) }).w);
  return layoutHintRows(hints, hintLayoutWidth(inner)).length;
}

function railWidthFor(inner: number, explicit?: number): number {
  if (explicit !== undefined) return clamp(explicit, 14, Math.max(14, inner - 24));
  return clamp(Math.round(inner * 0.26), 16, 30);
}

/**
 * The text geometry the workspace content builders size their rows to.
 * `footer` (when given) decides how many hint rows the body gives up.
 */
export function getFullscreenWorkspaceMetrics(options: Pick<
  FullscreenWorkspaceRenderOptions,
  'width' | 'height' | 'leftWidth' | 'contextRatio' | 'minContextRows' | 'contextNeed'
> & { readonly footer?: string }): FullscreenWorkspaceMetrics {
  const safeWidth = Math.max(1, options.width);
  const safeHeight = Math.max(12, options.height);
  const g = modalGeometry(safeWidth, safeHeight, { width: workspaceWidth(safeWidth) });
  const inner = modalInnerWidth(g.w);
  const hintRows = hintRowCount(safeWidth, safeHeight, options.footer);
  // Fill rows: padding, title, blank, body..., [blank, hints...], padding.
  const bodyRows = Math.max(4, maxModalHeight(safeHeight) - (hintRows > 0 ? hintRows + 5 : 4));
  const leftWidth = railWidthFor(inner, options.leftWidth);
  // The panel starts 2 columns right of the rail and reaches 2 columns from
  // the fill's edge; its text keeps 2 columns of padding on both sides.
  const centerWidth = Math.max(20, inner - leftWidth - 3);
  const contextWidth = Math.max(10, centerWidth - 2);
  // Panel rows: a padding row above and below, a blank row between context and controls.
  const panelRows = Math.max(3, bodyRows - 2);
  // The context grows toward what it needs, up to half the panel, and never
  // below the controls' minimum.
  const maxContextRows = Math.max(2, Math.min(Math.round(panelRows * 0.5), panelRows - Math.min(MIN_CONTROL_ROWS, Math.max(4, panelRows - 2)) - 1));
  const minContextRows = clamp(options.minContextRows ?? 10, 2, maxContextRows);
  const contextRows = clamp(
    Math.max(Math.round(panelRows * (options.contextRatio ?? 0.4)), options.contextNeed ?? 0),
    Math.min(minContextRows, maxContextRows),
    maxContextRows,
  );
  const controlRows = Math.max(2, panelRows - contextRows - 1);
  return { safeWidth, safeHeight, leftWidth, centerWidth, bodyRows, contextWidth, contextRows, controlRows };
}

function rowFg(row: WorkspaceRow, fallback: string): string {
  if (row.fg) return row.fg;
  if (row.kind === 'group') return WORKSPACE_PALETTE.subtitle;
  if (row.kind === 'more') return WORKSPACE_PALETTE.dim;
  return fallback;
}

/** A rail row's text without its legacy cursor glyph (the gradient marks the selection now). */
function railText(text: string): string {
  const trimmed = text.replace(/^\s+/, '');
  for (const marker of [GLYPHS.navigation.selected, '•']) {
    if (trimmed.startsWith(`${marker} `)) return trimmed.slice(marker.length + 1).replace(/^\s+/, '');
  }
  return trimmed;
}

/** A panel row's text with its legacy cursor glyph blanked, keeping the column alignment. */
function panelText(text: string): string {
  for (const marker of [GLYPHS.navigation.selected, '•']) {
    if (text.startsWith(`${marker} `)) return ' '.repeat(marker.length + 1) + text.slice(marker.length + 1);
  }
  return text;
}

/**
 * Render the workspace frame as a kit modal layer. `options.width` and
 * `options.height` are the screen size.
 */
export function renderFullscreenWorkspace(options: FullscreenWorkspaceRenderOptions): SurfaceLayer {
  const t = activeTokens();
  const metrics = getFullscreenWorkspaceMetrics({ ...options, footer: options.footer });
  const hints = workspaceHints(options.footer);
  const f = beginModal(metrics.safeWidth, metrics.safeHeight, {
    width: workspaceWidth(metrics.safeWidth),
    title: options.title,
    crumbs: [options.mainHeader],
    sub: options.stateLabel,
    hints,
  });
  const { canvas } = f;

  // Category rail.
  const railX0 = f.l;
  const railX1 = f.l + metrics.leftWidth - 1;
  let y = f.top;
  for (const row of options.leftRows) {
    if (y > f.bottom) break;
    if (row.kind === 'group') {
      canvas.put(railX0 - MODAL_MARK_INSET, y, '✦', { fg: t.brandEnd });
      canvas.put(railX0, y, row.text.trim().toLowerCase(), { fg: t.accent, bold: true });
    } else if (row.text.length > 0) {
      const text = railText(row.text);
      if (row.selected) {
        canvas.grad(railX0 - MODAL_MARK_INSET, y, railX1 - railX0 + 1 + 2 * MODAL_MARK_INSET, t.brand, t.brandEnd);
        canvas.put(railX0, y, text, { fg: t.selectedListItemText, bold: true });
      } else {
        const current = row.bold === true && row.kind === 'item';
        canvas.put(railX0, y, text, {
          fg: current ? t.brand : rowFg(row, WORKSPACE_PALETTE.muted),
          bold: current,
        });
      }
    }
    y++;
  }

  // Element panel: context above, controls below.
  const panelX = railX1 + 3;
  const p = panel(canvas, panelX, f.top, f.r + 2 - panelX + 1, f.bottom - f.top + 1);
  const sx = p.l;
  const sr = p.r;
  let py = p.top;
  const width = sr - sx + 1;
  // Rows wider than the panel wrap onto the next rows (text never crosses the fill's padding).
  // The builders pad to their row budget with empty rows; those absorb the
  // growth first, so only real content can overflow.
  const wrapRows = (rows: readonly WorkspaceRow[]): WorkspaceRow[] => {
    const out = rows.flatMap((row) => (
      getDisplayWidth(row.text.replace(/\s+$/, '')) <= width
        ? [row]
        : wrapLines(row.text.trim(), width).map((text, k) => ({ ...row, text, selected: row.selected && k === 0 }))
    ));
    while (out.length > 0 && out[out.length - 1]!.text.trim() === '') out.pop();
    return out;
  };
  const contextRows = wrapRows(options.contextRows);
  const controlRows = wrapRows(options.controlRows);
  // Context longer than its share says how much it leaves out instead of stopping silently.
  const contextOverflow = contextRows.length > metrics.contextRows;
  const contextShown = contextOverflow ? metrics.contextRows - 1 : metrics.contextRows;
  for (let k = 0; k < contextShown && py <= p.bottom; k++, py++) {
    const row = contextRows[k];
    if (!row || row.text.length === 0) continue;
    canvas.put(sx, py, row.text, { fg: rowFg(row, WORKSPACE_PALETTE.text), bold: row.bold });
  }
  if (contextOverflow && py <= p.bottom) {
    canvas.put(sx, py++, `${contextRows.length - contextShown} more lines`, { fg: t.textFaint });
  }
  py++;
  const controlOverflow = controlRows.length > metrics.controlRows;
  const controlShown = controlOverflow ? metrics.controlRows - 1 : metrics.controlRows;
  for (let k = 0; k < controlShown && py <= p.bottom; k++, py++) {
    const row = controlRows[k];
    if (!row || row.text.length === 0) continue;
    const text = panelText(row.text).replace(/\s+$/, '');
    if (row.selected) {
      canvas.grad(sx - MODAL_MARK_INSET, py, sr - sx + 1 + 2 * MODAL_MARK_INSET, t.brand, t.brandEnd);
      canvas.put(sx, py, text, { fg: t.selectedListItemText, bold: true });
    } else {
      canvas.put(sx, py, text, { fg: rowFg(row, WORKSPACE_PALETTE.text), bold: row.bold });
    }
  }
  if (controlOverflow && py <= p.bottom) {
    canvas.put(sx, py, `${controlRows.length - controlShown} more lines`, { fg: t.textFaint });
  }
  return finishModal(f);
}
