/**
 * The action-result block, sized to fit and scrollable when it cannot.
 *
 * This exists because of a ruling with no exceptions in it: no surface ships too
 * small for its complete text, size to content, or scroll, never clip. The
 * pane used to give the action list `height - 2` and append the result
 * afterwards, so a multi-line result was cut wherever the terminal happened to
 * end. A person reading a setup report saw its first two lines and had no way
 * to reach the rest, and nothing said the rest existed.
 *
 * Sizing to content is not available here, the pane is bounded by the
 * terminal. So the result gets a reserved share of the pane before the action
 * list is windowed, and when the result is longer than even that share it
 * scrolls with PageUp/PageDown, announcing how many lines lie above and below.
 * Every line is reachable, which is what the ruling requires.
 */
import type { AgentWorkspaceActionResult } from '../input/agent-workspace-types.ts';
import { wrapText } from '../utils/terminal-width.ts';

export interface ResultRow {
  readonly text: string;
  readonly kind?: string;
  readonly fg?: string;
  readonly bold?: boolean;
  readonly dim?: boolean;
}

export interface ResultRowPalette {
  readonly text: string;
  readonly good: string;
  readonly muted: string;
  readonly dim: string;
}

/**
 * The action list never shrinks below this. A result long enough to fill the
 * pane must not push the actions out of view, the person still has to be able
 * to pick the next card.
 */
export const MIN_ACTION_ROWS = 6;

/** Every line the result wants, before any windowing. */
export function buildActionResultRows(
  result: AgentWorkspaceActionResult,
  options: {
    readonly onboarding: boolean;
    readonly width: number;
    readonly titleColor: string;
    readonly palette: ResultRowPalette;
    readonly moreAbove: string;
    readonly moreBelow: string;
  },
): readonly ResultRow[] {
  // No leading blank row: in a short pane that blank is a line of the report
  // that does not get shown. The status line above already separates them.
  const rows: ResultRow[] = [
    { text: `${options.onboarding ? 'Result' : 'Action Result'}: ${result.title}`, fg: options.titleColor, bold: true },
  ];

  // For recap results, skip the detail body, the checkmarked lines below carry
  // the full content. Rendering detail AND lines would duplicate every line.
  if (result.kind !== 'recap') {
    for (const line of wrapText(result.detail, Math.max(1, options.width - 2))) {
      rows.push({ text: `  ${line}`, fg: options.palette.text });
    }
  }
  if (result.kind === 'recap' && result.lines?.length) {
    rows.push({ text: '' });
    for (const line of result.lines) {
      rows.push({ text: `  ✔ ${line}`, fg: options.palette.good });
    }
  }
  if (!options.onboarding && result.command) {
    rows.push({ text: `  Command: ${result.command}`, fg: options.palette.muted });
  }
  return rows;
}

/**
 * Split the pane between the action list and the result.
 *
 * The actions pane is a good deal shorter than the terminal, the context lines
 * above it take most of the column, so a fixed floor for the action list can
 * leave a result with nothing at all, which is worse than the clipping this
 * replaced. The floor therefore yields: it is `MIN_ACTION_ROWS` when there is
 * room and shrinks toward one row when there is not, and the result is always
 * granted at least one line so that its scroll marker can say the rest exists.
 *
 * @param usableRows rows left for the action list and the result together,
 *   after the pane's own headers, markers and status line.
 */
export function reserveForResult(totalRows: number, usableRows: number): number {
  if (totalRows <= 0 || usableRows <= 0) return 0;
  const actionsFloor = Math.min(MIN_ACTION_ROWS, Math.max(1, usableRows - 1));
  return Math.min(totalRows, Math.max(1, usableRows - actionsFloor));
}

/**
 * The furthest the block can scroll and still be showing its last line.
 *
 * The `+ 1` pays for the "more above" marker, which is present at any non-zero
 * offset and costs a row that would otherwise hold content. Without it the last
 * line or two can never be reached, which is the same failure as clipping,
 * just harder to notice.
 */
export function maxResultScroll(totalRows: number, reserved: number): number {
  if (reserved <= 0 || totalRows <= reserved) return 0;
  return Math.max(0, totalRows - reserved + 1);
}

/** Clamp a requested scroll offset to what the content actually allows. */
export function clampResultScroll(offset: number, totalRows: number, reserved: number): number {
  if (!Number.isFinite(offset) || offset <= 0) return 0;
  return Math.min(Math.floor(offset), maxResultScroll(totalRows, reserved));
}

/**
 * Settle the offset for this frame, resetting it when the result changed.
 *
 * `lastActionResult` is assigned from a great many places in the workspace, so
 * rather than asking every one of them to remember to rewind the scroll, the
 * renderer compares the result it is drawing against the one the offset was
 * taken for. A new result therefore always starts at its first line, and no
 * caller can forget.
 */
export function settleResultScroll(
  workspace: { resultScroll: number; resultScrollFor: AgentWorkspaceActionResult | null },
  result: AgentWorkspaceActionResult | null,
  totalRows: number,
  reserved: number,
): number {
  if (result !== workspace.resultScrollFor) {
    workspace.resultScrollFor = result;
    workspace.resultScroll = 0;
    return 0;
  }
  const clamped = clampResultScroll(workspace.resultScroll, totalRows, reserved);
  workspace.resultScroll = clamped;
  return clamped;
}

/**
 * The rows to actually draw, with a marker on each side that has more.
 *
 * The markers are part of the window rather than extra rows, because a marker
 * that pushed the content down would be one more line the pane could not show.
 */
export function windowResultRows(
  rows: readonly ResultRow[],
  reserved: number,
  offset: number,
  options: { readonly palette: ResultRowPalette; readonly moreAbove: string; readonly moreBelow: string },
): readonly ResultRow[] {
  if (reserved <= 0) return [];
  if (rows.length <= reserved) return rows;

  const clamped = clampResultScroll(offset, rows.length, reserved);
  const above = clamped > 0 ? 1 : 0;

  // Take the whole remaining budget first; only give a row back to the bottom
  // marker if there is in fact something below. Doing it the other way round
  // permanently hides the last line.
  let content = Math.max(1, reserved - above);
  let below = 0;
  if (clamped + content < rows.length) {
    below = 1;
    content = Math.max(1, reserved - above - below);
  }
  const end = Math.min(rows.length, clamped + content);
  const hidden = rows.length - end;

  const windowed: ResultRow[] = [];
  if (above === 1) {
    windowed.push({
      text: `${options.moreAbove} ${clamped} more line(s) above, PageUp`,
      kind: 'more',
      fg: options.palette.dim,
      dim: true,
    });
  }
  windowed.push(...rows.slice(clamped, end));
  if (hidden > 0) {
    windowed.push({
      text: `${options.moreBelow} ${hidden} more line(s) below, PageDown`,
      kind: 'more',
      fg: options.palette.dim,
      dim: true,
    });
  }
  return windowed;
}
