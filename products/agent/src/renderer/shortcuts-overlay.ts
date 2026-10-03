/**
 * renderShortcutsOverlay, the keyboard shortcuts modal (/shortcuts), drawn
 * like the concept's "keys" screen: columns of key / action pairs, keys bold,
 * actions muted, grouped under ✦ headers, with the always-live search row
 * filtering by key or action. Reflects the live keybindings labels (user
 * overrides included).
 *
 * Two columns below a 170-column screen, three from 170 up (one on a narrow
 * modal). The modal takes 86% of the screen without the usual 124-column cap,
 * so each description gets room to stay on one line; the key column is as wide
 * as the longest key (up to 18). Keys and actions that still do not fit wrap
 * inside their column; the grid scrolls when it is taller than the modal.
 */

import type { KeybindingsManager } from '../input/keybindings.ts';
import type { OverlayFilter } from '../input/overlay-filter.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import { activeTokens } from './theme.ts';
import {
  NARROW_MODAL_BREAKPOINT,
  beginModal,
  finishModal,
  searchRow,
  scrollCountText,
  standardModalWidth,
  wrapLines,
  MODAL_MARK_INSET,
  type KitHint,
  type SurfaceCanvas,
  type SurfaceLayer,
} from './surface-kit.ts';
import { drawTextBlock } from './surface-kit-extra.ts';

interface ShortcutGroup {
  readonly title: string;
  readonly items: ReadonlyArray<readonly [key: string, action: string]>;
}

/** The static strings this surface can show (checked by package verification through help-overlay.ts). */
export const SHORTCUT_OVERLAY_STATIC_TEXT = [
  'Keyboard shortcuts',
  'customize with /keybindings',
  'Filter shortcuts',
  'No shortcuts match "<query>".',
  'Navigation',
  'Scroll / history recall',
  'Scroll by full page',
  'Jump to start / end of line',
  'Search conversation',
  'Scroll conversation or hovered panel',
  'Editing',
  'Submit message',
  'Insert newline',
  'Open file picker',
  'Slash command mode',
  'Paste (image priority)',
  'Undo / redo',
  'Clear prompt',
  'Delete word backward',
  'Kill to end of line',
  'Move to start of line',
  'Next error / line end',
  'Actions',
  'Collapse/expand block',
  'Bookmark block',
  'Copy block to clipboard',
  'Block file save disabled; copy or export',
  'Copy selection',
  'Process monitor',
  'Help overlay',
  'Exit',
  'Workspace',
  'Swap focus between input and active Agent workspace',
  'Open the Agent operator workspace',
  'Cycle Agent workspace category forward',
  'Cycle Agent workspace category backward',
  'Config: /keybindings to list and customize',
  'Sessions',
  'Open that agent; typing steers it',
  "Open that process's live output",
  'Next / prev session (empty composer)',
  'Go up one level; stops nothing',
  'Stop what the view shows (twice)',
] as const;

/** Every shortcut group, from the live keybindings table (user overrides included). */
function shortcutGroups(keybindingsManager: KeybindingsManager): ShortcutGroup[] {
  const kb = (action: Parameters<typeof keybindingsManager.getComboLabel>[0]) => keybindingsManager.getComboLabel(action);
  return [
    {
      title: 'Navigation',
      items: [
        ['Up / Down', 'Scroll / history recall'],
        ['PageUp / PageDn', 'Scroll by full page'],
        ['Home / End', 'Jump to start / end of line'],
        [kb('search'), 'Search conversation'],
        ['Mouse wheel', 'Scroll conversation or hovered panel'],
      ],
    },
    {
      title: 'Editing',
      items: [
        ['Enter', 'Submit message'],
        ['Shift+Enter', 'Insert newline'],
        ['@', 'Open file picker'],
        ['/', 'Slash command mode'],
        [kb('paste'), 'Paste (image priority)'],
        [`${kb('undo')} / ${kb('redo')}`, 'Undo / redo'],
        [kb('clear-prompt'), 'Clear prompt'],
        [kb('delete-word'), 'Delete word backward'],
        [kb('kill-line'), 'Kill to end of line'],
        [kb('line-start'), 'Move to start of line'],
        [kb('next-error-line-end'), 'Next error / line end'],
      ],
    },
    {
      title: 'Actions',
      items: [
        ['Tab', 'Collapse/expand block'],
        [kb('bookmark'), 'Bookmark block'],
        [kb('block-copy'), 'Copy block to clipboard'],
        [kb('block-save'), 'Block file save disabled; copy or export'],
        [kb('copy-selection'), 'Copy selection'],
        ['F2', 'Process monitor'],
        ['?', 'Help overlay'],
        [`${kb('clear-cancel')} x2`, 'Exit'],
      ],
    },
    {
      title: 'Workspace',
      items: [
        ['Tab', 'Swap focus between input and active Agent workspace'],
        [kb('workspace-picker'), 'Open the Agent operator workspace'],
        [kb('workspace-tab-next'), 'Cycle Agent workspace category forward'],
        [kb('workspace-tab-prev'), 'Cycle Agent workspace category backward'],
      ],
    },
    {
      // Agent and process views (shell/session-views.ts); these keys are fixed.
      title: 'Sessions',
      items: [
        ['Enter on lane', 'Open that agent; typing steers it'],
        ['Enter on ▶ bead', "Open that process's live output"],
        ['Tab / Shift+Tab', 'Next / prev session (empty composer)'],
        ['Esc in a view', 'Go up one level; stops nothing'],
        ['ctrl+x in view', 'Stop what the view shows (twice)'],
      ],
    },
  ];
}

function filterGroups(groups: readonly ShortcutGroup[], query: string): ShortcutGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups.filter((g) => g.items.length > 0);
  return groups
    .map((g) => ({
      title: g.title,
      items: g.title.toLowerCase().includes(q)
        ? g.items
        : g.items.filter(([key, action]) => key.toLowerCase().includes(q) || action.toLowerCase().includes(q)),
    }))
    .filter((g) => g.items.length > 0);
}

/** One drawn row of one column. */
type GridCell =
  | { readonly kind: 'blank' }
  | { readonly kind: 'header'; readonly text: string }
  | { readonly kind: 'pair'; readonly key: string; readonly action: string };

interface Block { readonly cells: GridCell[]; readonly group: string; readonly header: boolean }

function blocksFor(groups: readonly ShortcutGroup[], keyW: number, actionW: number): Block[] {
  const blocks: Block[] = [];
  groups.forEach((g, gi) => {
    blocks.push({ cells: [...(gi > 0 ? [{ kind: 'blank' as const }] : []), { kind: 'header', text: g.title }], group: g.title, header: true });
    for (const [key, action] of g.items) {
      const keys = wrapLines(key, keyW);
      const actions = wrapLines(action, actionW);
      const cells: GridCell[] = [];
      for (let k = 0; k < Math.max(keys.length, actions.length); k++) cells.push({ kind: 'pair', key: keys[k] ?? '', action: actions[k] ?? '' });
      blocks.push({ cells, group: g.title, header: false });
    }
  });
  return blocks;
}

/** Split blocks into `n` balanced columns; a header never ends a column, a continued group repeats its header. */
function columnsFor(blocks: readonly Block[], n: number): GridCell[][] {
  const total = blocks.reduce((sum, b) => sum + b.cells.length, 0);
  const target = Math.ceil(total / n);
  const cols: GridCell[][] = [[]];
  blocks.forEach((block, i) => {
    let col = cols[cols.length - 1]!;
    const next = blocks[i + 1];
    const need = block.cells.length + (block.header && next && !next.header ? next.cells.length : 0);
    if (col.length > 0 && col.length + need > target && cols.length < n) {
      col = [];
      cols.push(col);
      if (!block.header) col.push({ kind: 'header', text: block.group });
    }
    const cells = col.length === 0 ? block.cells.filter((c) => c.kind !== 'blank') : block.cells;
    col.push(...cells);
  });
  return cols;
}

function drawCell(canvas: SurfaceCanvas, x: number, y: number, keyW: number, cell: GridCell): void {
  const t = activeTokens();
  if (cell.kind === 'header') {
    canvas.put(x - MODAL_MARK_INSET, y, '✦', { fg: t.brandEnd });
    canvas.put(x, y, cell.text.toLowerCase(), { fg: t.accent, bold: true });
  } else if (cell.kind === 'pair') {
    canvas.put(x, y, cell.key, { fg: t.text, bold: true });
    canvas.put(x + keyW + 2, y, cell.action, { fg: t.textMuted });
  }
}

const HINTS: readonly KitHint[] = [['↑↓', 'scroll'], ['type', 'to filter']];
const COLUMN_GAP = 4;
/** Screen width from which the grid has three columns instead of two. */
const SHORTCUTS_THREE_COLUMN_SCREEN = 170;
/** Widest key column; longer key lists wrap inside it. */
const MAX_KEY_WIDTH = 18;
/** Below this inner width the grid is one column. */
const ONE_COLUMN_INNER = 60;

/** The shortcuts modal's width: the standard 86% rule without the 124-column cap. */
function shortcutsModalWidth(screenW: number): number {
  if (screenW < NARROW_MODAL_BREAKPOINT) return standardModalWidth(screenW);
  return Math.max(standardModalWidth(screenW), Math.min(screenW - 2, Math.round(screenW * 0.86)));
}

/** Columns in the grid for a screen width and the modal's inner width. */
function shortcutsColumnCount(screenW: number, inner: number): number {
  if (inner < ONE_COLUMN_INNER) return 1;
  return screenW >= SHORTCUTS_THREE_COLUMN_SCREEN ? 3 : 2;
}

/**
 * Render the keyboard shortcuts modal as a SurfaceLayer in screen coordinates.
 * `filter` holds the search row's query; the renderer records how far the
 * grid can scroll in it.
 */
export function renderShortcutsOverlay(
  screenWidth: number,
  screenHeight: number,
  keybindingsManager: KeybindingsManager,
  scrollOffset = 0,
  filter?: OverlayFilter,
): SurfaceLayer {
  const t = activeTokens();
  const query = filter?.query ?? '';
  const f = beginModal(screenWidth, screenHeight, { title: 'Keyboard shortcuts', sub: 'customize with /keybindings', hints: HINTS, width: shortcutsModalWidth(screenWidth) });
  const all = shortcutGroups(keybindingsManager);
  const groups = filterGroups(all, query);
  const totalPairs = all.reduce((n, g) => n + g.items.length, 0);
  const shown = groups.reduce((n, g) => n + g.items.length, 0);
  searchRow(f, f.top, query, 'Filter shortcuts', query ? `${shown} of ${totalPairs}` : `${totalPairs} shortcuts`);

  const top = f.top + 2;
  const inner = f.r - f.l + 1;
  if (groups.length === 0) {
    if (filter) filter.maxScroll = 0;
    drawTextBlock(f.canvas, f.l, top, inner, [{ text: `No shortcuts match "${query}".`, style: { fg: t.textMuted } }], f.bottom);
    return finishModal(f);
  }

  const n = shortcutsColumnCount(screenWidth, inner);
  const colW = Math.max(8, Math.floor((inner - COLUMN_GAP * (n - 1)) / n));
  // Measured over every shortcut, not just the filtered ones, so filtering never shifts the columns.
  const longestKey = all.reduce((w, g) => g.items.reduce((m, [key]) => Math.max(m, getDisplayWidth(key)), w), 0);
  const keyW = Math.max(4, Math.min(MAX_KEY_WIDTH, longestKey, Math.floor(colW * 0.45)));
  const actionW = Math.max(4, colW - keyW - 2);
  const cols = columnsFor(blocksFor(groups, keyW, actionW), n);
  const gridH = Math.max(...cols.map((c) => c.length));
  const capacity = Math.max(1, f.bottom - top + 1);
  const maxScroll = Math.max(0, gridH - capacity);
  if (filter) filter.maxScroll = maxScroll;
  const offset = Math.max(0, Math.min(scrollOffset, maxScroll));

  cols.forEach((col, c) => {
    const x = f.l + c * (colW + COLUMN_GAP);
    for (let k = 0; k < capacity && offset + k < col.length; k++) drawCell(f.canvas, x, top + k, keyW, col[offset + k]!);
  });
  f.hintRight = scrollCountText(offset, Math.max(0, gridH - offset - capacity));
  return finishModal(f);
}
