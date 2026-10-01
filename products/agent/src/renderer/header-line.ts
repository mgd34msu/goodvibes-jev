/**
 * header-line.ts, the one-row header.
 *
 *   col 1   GoodVibes Agent, bold, in the theme's brand -> brandEnd gradient
 *           (the theme's gradient, never the protected splash constant)
 *   then    the version (faint) and the session title (muted)
 *   right   the serving model, ending at width-2
 *
 * No rule row under it; on the main screen one empty row (withHeaderGap)
 * keeps the output off it. The header is the one place for session identity:
 * title and model (the composer holds only input). Inside an agent or process
 * view the title gives way to the breadcrumb (main › researcher, the last name
 * in its own color) and the right side names that session: the agent's model,
 * or the process's pid, uptime and port. The Agent shell never
 * surfaces git or worktree posture here (see scripts/check-architecture.ts):
 * build work belongs to delegated GoodVibes TUI sessions.
 */

import { type Line, createEmptyLine } from '@goodvibes-jev/engine/sdk/platform/types';
import { VERSION } from '../version.ts';
import { getDisplayWidth, interpolateColor, truncateDisplay } from '../utils/terminal-width.ts';
import { activeTokens } from './theme.ts';

const BRAND = 'GoodVibes Agent';
const BRAND_X = 1;
const GAP = 3;

interface Seg { readonly text: string; readonly fg: string; readonly bold?: boolean }

/** An agent or process view: the breadcrumb in place of the title, the session's own right side. */
export interface HeaderView {
  /** main, then each level down to the one shown; the last is drawn bold in its color. */
  readonly crumbs: ReadonlyArray<{ readonly text: string; readonly fg: string; readonly bold?: boolean }>;
  /** Replaces the model on the right (the agent's model; pid · uptime · port). */
  readonly right: string;
  readonly rightFg?: string;
}

function put(line: Line, x: number, endX: number, seg: Seg): number {
  let cx = x;
  for (const ch of seg.text) {
    const w = getDisplayWidth(ch);
    if (w <= 0) continue;
    if (cx + w > endX) break;
    line[cx] = { char: ch, fg: seg.fg, bg: '', bold: seg.bold ?? false, dim: false, underline: false, italic: false, strikethrough: false };
    if (w === 2 && cx + 1 < line.length) line[cx + 1] = { ...line[cx]!, char: '' };
    cx += w;
  }
  return cx;
}

/**
 * Render the header row.
 *
 * @param width   - Terminal columns.
 * @param model   - Serving model id.
 * @param title   - Optional session title, truncated to fit.
 * @param version - Defaults to the live build VERSION; tests pin a fixture.
 * @param view    - An agent or process view is showing: breadcrumb and that session's right side.
 */
export function renderHeaderLine(width: number, model: string, title?: string, version: string = VERSION, view?: HeaderView): Line[] {
  const t = activeTokens();
  const line = createEmptyLine(width);
  for (const cell of line) cell.bg = '';
  const end = width - 1; // exclusive: the model ends at width-2
  const versionText = `v${version}`;
  if (view) return [renderViewHeader(line, width, versionText, view)];

  // Right side first, so the title knows how much room it has.
  const leftMin = BRAND_X + getDisplayWidth(BRAND) + 1 + getDisplayWidth(versionText);
  const modelText = leftMin + GAP + getDisplayWidth(model) <= end ? model : truncateDisplay(model, Math.max(0, end - leftMin - GAP));
  const rightX = Math.max(leftMin + GAP, end - getDisplayWidth(modelText));

  // Wordmark, version, title.
  const x = putWordmark(line, end, versionText);
  if (title) {
    const room = rightX - GAP - (x + 2);
    if (room >= 4) put(line, x + 2, rightX - GAP, { text: truncateDisplay(title, room), fg: t.textMuted });
  }
  put(line, rightX, end, { text: modelText, fg: t.text });
  return [line];
}

/** The wordmark and version; returns the column after the version. */
function putWordmark(line: Line, end: number, versionText: string): number {
  const t = activeTokens();
  let x = BRAND_X;
  const letters = [...BRAND];
  letters.forEach((ch, i) => {
    x = put(line, x, end, { text: ch, fg: interpolateColor(t.brand, t.brandEnd, i / (letters.length - 1)), bold: true });
  });
  return put(line, x + 1, end, { text: versionText, fg: t.textFaint });
}

/** The header inside an agent or process view. */
function renderViewHeader(line: Line, width: number, versionText: string, view: HeaderView): Line {
  const t = activeTokens();
  const end = width - 1;
  let x = putWordmark(line, end, versionText);
  const crumbsW = view.crumbs.reduce((s, c, i) => s + (i > 0 ? 3 : 0) + getDisplayWidth(c.text), 0);
  // The right side yields before the breadcrumb does: where you are matters more than the model name.
  const roomForRight = end - (x + 2 + crumbsW + GAP);
  const right = roomForRight >= 4 ? truncateDisplay(view.right, roomForRight) : '';
  const rightX = end - getDisplayWidth(right);
  const crumbEnd = right ? rightX - GAP : end;
  x += 2;
  view.crumbs.forEach((crumb, i) => {
    if (i > 0) x = put(line, x + 1, crumbEnd, { text: '›', fg: t.textFaint }) + 1;
    const last = i === view.crumbs.length - 1;
    const room = crumbEnd - x;
    x = put(line, x, crumbEnd, { text: last ? truncateDisplay(crumb.text, Math.max(0, room)) : crumb.text, fg: crumb.fg, bold: crumb.bold });
  });
  if (right) put(line, rightX, end, { text: right, fg: view.rightFg ?? t.text });
  return line;
}

/**
 * The main screen's header block with its gap: the header row (and the
 * session chips row, when it shows), then one empty row, so output never
 * touches the header. An agent or process view's body starts with its own
 * empty row, so a view does not take this one.
 */
export function withHeaderGap(header: readonly Line[], width: number): Line[] {
  const gap = createEmptyLine(width);
  for (const cell of gap) cell.bg = '';
  return [...header, gap];
}

/** Rows the gap under the main screen's header adds. */
export const HEADER_GAP_ROWS = 1;
