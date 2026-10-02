import type { Line } from '@goodvibes-jev/engine/sdk/platform/types';
import { fitDisplay, getDisplayWidth, truncateDisplay } from '../utils/terminal-width.ts';
import type { SearchManager } from '../input/search.ts';
import { createBottomBarLine, writeBottomBarText } from '@goodvibes-jev/engine/terminal-shell';
import { activeTokens } from './theme.ts';
import { keycapHintsWidth, paintKeycapHints } from './surface-kit-parts.ts';
import type { KitHint } from './surface-kit.ts';

const SEARCH_OVERLAY_LABEL = ' Find: ';
const SEARCH_OVERLAY_NO_MATCHES = 'No matches';
const SEARCH_OVERLAY_COUNT_SUFFIX = 'up/down';
const SEARCH_OVERLAY_LOCKED_HINTS: KitHint[] = [['↑↓ jk', 'navigate'], ['bksp', 'edit'], ['esc', 'close']];
const SEARCH_OVERLAY_UNLOCKED_HINTS: KitHint[] = [['⏎ tab', 'lock'], ['esc', 'close']];

function searchOverlayMatchCount(current: string | number, total: string | number): string {
  return `${current}/${total} ${SEARCH_OVERLAY_COUNT_SUFFIX}`;
}

export function renderSearchOverlayPackageText(): string {
  return [
    SEARCH_OVERLAY_LABEL.trim(),
    searchOverlayMatchCount('<current>', '<total>'),
    SEARCH_OVERLAY_NO_MATCHES,
    ...SEARCH_OVERLAY_LOCKED_HINTS.map(([, action]) => action),
    ...SEARCH_OVERLAY_UNLOCKED_HINTS.map(([, action]) => action),
  ].join('\n');
}

/**
 * Render the search bar as a single Line[] overlay at the bottom of the viewport.
 * Format: [ Find: <query>   3/17 up/down          (keycap hints on the right) ]
 * The match count is dim; the hints are keycaps and drop out on a narrow bar.
 */
export function renderSearchOverlay(
  manager: SearchManager,
  width: number
): Line[] {
  const matchCount = manager.matches?.length > 0
    ? searchOverlayMatchCount(manager.currentMatch + 1, manager.matches.length)
    : manager.query.length > 0
      ? SEARCH_OVERLAY_NO_MATCHES
      : '';

  const locked = manager.locked;
  const cursor = locked ? '' : '█';
  const leftPart = SEARCH_OVERLAY_LABEL + manager.query + cursor;
  const hints = locked ? SEARCH_OVERLAY_LOCKED_HINTS : SEARCH_OVERLAY_UNLOCKED_HINTS;
  const matchStr = matchCount ? ` ${matchCount}` : '';
  const matchStrW = getDisplayWidth(matchStr);
  const hintsW = keycapHintsWidth(hints);
  // Hints sit at the right end of the bar when they fit beside the query.
  const showHints = width - hintsW - 2 - matchStrW >= getDisplayWidth(SEARCH_OVERLAY_LABEL) + 8;
  const leftWidth = Math.max(1, width - matchStrW - (showHints ? hintsW + 4 : 1));
  const truncatedLeft = fitDisplay(
    getDisplayWidth(leftPart) > leftWidth ? truncateDisplay(leftPart, leftWidth) : leftPart,
    leftWidth,
  );

  const p = activeTokens();
  const line = createBottomBarLine(width, { fg: p.selectedListItemText, bg: p.accent });
  writeBottomBarText(line, 0, leftWidth, truncatedLeft, { fg: p.selectedListItemText, bg: p.accent });
  if (matchStr.length > 0) {
    // dim kept: de-emphasis on the accent bar, where a faint grey would not read.
    writeBottomBarText(line, leftWidth, matchStrW, matchStr, { fg: p.selectedListItemText, bg: p.accent, dim: true });
  }
  if (showHints) paintKeycapHints(line, width - hintsW - 2, width - 2, hints, { fg: p.selectedListItemText, bg: p.accent });
  return [line];
}
