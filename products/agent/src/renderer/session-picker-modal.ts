/**
 * renderSessionPickerModal, the /sessions picker drawn with the modal surface kit.
 *
 * Saved sessions grouped by recency (today, yesterday, this week, earlier)
 * with message count and age right-aligned and muted, and an always-live
 * search row. Deleting is an explicit slash command in the agent, so `d`
 * only shows that command as a status line under the list.
 */

import { activeTokens } from './theme.ts';
import type { SessionPickerModal } from '../input/session-picker-modal.ts';
import { renderSessionPickerStatePackageText } from '../input/session-picker-modal.ts';
import { formatTimestamp } from './modal-utils.ts';
import { beginModal, drawWrapped, finishModal, scrollCountText, searchRow, wrapLines, type KitHint, type SurfaceLayer } from './surface-kit.ts';
import { drawList, type KitRow } from './surface-kit-list.ts';

const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type RecencyGroup = 'Today' | 'Yesterday' | 'This week' | 'Earlier';
const GROUP_ORDER: readonly RecencyGroup[] = ['Today', 'Yesterday', 'This week', 'Earlier'];

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function recencyGroup(ts: number, now: number): RecencyGroup {
  const today = startOfDay(now);
  if (ts >= today) return 'Today';
  if (ts >= today - DAY_MS) return 'Yesterday';
  if (ts >= today - 6 * DAY_MS) return 'This week';
  return 'Earlier';
}

/** Short age for the right column: HH:MM today, "Mon D" this year, the full date otherwise. */
function shortWhen(ts: number, now: number): string {
  if (!ts) return 'unknown';
  const d = new Date(ts);
  if (ts >= startOfDay(now)) return formatTimestamp(ts).slice(11);
  if (d.getFullYear() === new Date(now).getFullYear()) return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return formatTimestamp(ts).slice(0, 10);
}

/** The static strings this surface can show (checked by package verification). */
export function renderSessionPickerPackageText(): string {
  return [
    'Sessions',
    'Search sessions',
    '<n> saved',
    '<n> of <total>',
    'Today',
    'Yesterday',
    'This week',
    'Earlier',
    'No saved sessions.',
    'Open Agent Workspace -> Conversation -> Save current session.',
    'No sessions match "<query>".',
    '<n> msgs',
    'move',
    'load',
    'how to delete',
    'edit search',
    renderSessionPickerStatePackageText(),
  ].join('\n');
}

/**
 * Render the session picker as a modal layer.
 *
 * @param modal         SessionPickerModal state.
 * @param screenWidth   Terminal width.
 * @param screenHeight  Terminal height.
 * @param now           Clock for the recency groups (tests pass a fixed value).
 */
export function renderSessionPickerModal(
  modal: SessionPickerModal,
  screenWidth: number,
  screenHeight = 24,
  now: number = Date.now(),
): SurfaceLayer {
  const t = activeTokens();
  const hints: KitHint[] = modal.query.length === 0
    ? [['↑↓', 'move'], ['⏎', 'load'], ['d', 'how to delete']]
    : [['↑↓', 'move'], ['⏎', 'load'], ['⌫', 'edit search']];
  const f = beginModal(screenWidth, screenHeight, { title: 'Sessions', hints });

  const visible = modal.visibleSessions();
  const count = modal.query.length > 0 ? `${visible.length} of ${modal.sessions.length}` : `${modal.sessions.length} saved`;
  searchRow(f, f.top, modal.query, 'Search sessions', count);

  // The status line sits at the bottom of the body, wrapped in full.
  const width = f.r - f.l + 1;
  const footLines = modal.statusMessage ? wrapLines(modal.statusMessage, width) : [];
  const listBottom = footLines.length > 0 ? f.bottom - footLines.length - 1 : f.bottom;

  const rows: KitRow[] = [];
  if (modal.sessions.length === 0) {
    rows.push({ label: 'No saved sessions.', labelFg: t.textFaint });
    rows.push({ label: 'Open Agent Workspace -> Conversation -> Save current session.', labelFg: t.textFaint });
  } else if (visible.length === 0) {
    rows.push({ label: `No sessions match "${modal.query}".`, labelFg: t.textFaint });
  }
  const groups = new Map<RecencyGroup, KitRow[]>();
  visible.forEach((sess, index) => {
    const title = sess.title && sess.title !== sess.name ? sess.title : '';
    const group = recencyGroup(sess.timestamp, now);
    const list = groups.get(group) ?? [];
    list.push({
      label: title || sess.name,
      desc: title ? sess.name : undefined,
      right: `${sess.messageCount} msgs · ${shortWhen(sess.timestamp, now)}`,
      selected: index === modal.selectedIndex,
    });
    groups.set(group, list);
  });
  for (const name of GROUP_ORDER) {
    const group = groups.get(name);
    if (group && group.length > 0) rows.push({ header: name }, ...group);
  }

  const top = f.top + 2;
  modal.setVisibleRows(Math.max(3, listBottom - top + 1));
  const result = drawList(f.canvas, { rows, top, bottom: listBottom, x0: f.l, x1: f.r, scrollKey: { owner: modal, name: 'sessions' } });
  f.hintRight = scrollCountText(result.above, result.below);

  let y = listBottom + 2;
  for (const line of footLines) {
    drawWrapped(f.canvas, f.l, y, width, line, { fg: modal.deleteConfirmationTarget ? t.warning : t.accent }, f.bottom);
    y++;
  }
  return finishModal(f);
}
