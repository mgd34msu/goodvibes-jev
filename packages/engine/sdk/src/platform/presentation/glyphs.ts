/**
 * Shared glyph registry for status, frames, navigation and meters.
 * Status uses idle '◌', info '○', and warn '⚠', matching the TUI values.
 * See docs/decisions/2026-07-05-presentation-contract-sdk-extraction.md
 * for the compatibility decision when Agent adopted these values.
 */

/** The full glyph registry, frame/surface/navigation/status/meter groups. */
export const GLYPHS = {
  frame: {
    topLeft: '┌',
    topRight: '┐',
    bottomLeft: '└',
    bottomRight: '┘',
    horizontal: '─',
    vertical: '│',
    teeLeft: '├',
    teeRight: '┤',
    teeTop: '┬',
    teeBottom: '┴',
    cross: '┼',
  },
  surface: {
    top: '▄',
    bottom: '▀',
    cursor: '█',
    altCursor: '▌',
  },
  navigation: {
    selected: '▸',
    collapsed: '▸',
    expanded: '▾',
    up: '↑',
    down: '↓',
    moreAbove: '▲',
    moreBelow: '▼',
    next: '→',
    back: '←',
    pipeSeparator: '│',
  },
  status: {
    success: '✓',
    failure: '✕',
    pending: '•',
    active: '●',
    idle: '◌',
    info: '○',
    warn: '⚠',
    blocked: '⊘',
    skipped: '◇',
    review: '◈',
    retry: '↻',
    handoff: '⇢',
    reference: '↗',
    partial: '◐',
    dualPane: '◆',
    star: '★',
  },
  meter: {
    filled: '█',
    medium: '▓',
    light: '▒',
    empty: '░',
    spark: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
  },
} as const;

/** The four semantic status states STATE_GLYPHS maps onto. */
export type StatusState = 'good' | 'warn' | 'bad' | 'info';

/**
 * STATE_GLYPHS, the 4-state semantic alias map, aliased to GLYPHS.status (the
 * TUI's mechanism). The agent's twin (status-glyphs.ts) hardcoded its own
 * literals ('✓'/'⚠'/'✕'/'○') instead of aliasing a shared registry; hoisting
 * the TUI's alias pattern here means there is exactly one place these four
 * glyphs are spelled out, and STATUS_GLYPHS/GLYPHS.status can never drift
 * apart again.
 */
export const STATE_GLYPHS: Record<StatusState, string> = {
  good: GLYPHS.status.success, // ✓
  warn: GLYPHS.status.warn,    // ⚠
  bad:  GLYPHS.status.failure, // ✕
  info: GLYPHS.status.info,    // ○
};
