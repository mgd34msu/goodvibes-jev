/**
 * renderProfilePickerModal, the settings-profile picker drawn with the modal
 * surface kit: the always-live search row (filters by name), one kit row per
 * saved profile (name, saved time right-aligned), the status line, and keycap
 * hints. Isolated Agent profile homes live in the Agent workspace, which the
 * muted note under the list points to.
 */

import type { ProfilePickerModal } from '../input/profile-picker-modal.ts';
import { renderProfilePickerStatePackageText } from '../input/profile-picker-modal.ts';
import { formatTimestamp } from './modal-utils.ts';
import { activeTokens } from './theme.ts';
import {
  beginModal,
  finishModal,
  searchRow,
  scrollCountText,
  type KitHint,
  type SurfaceLayer,
} from './surface-kit.ts';
import { drawList, type KitRow } from './surface-kit-list.ts';
import { drawTextBlock, listHeight, modalHeightFor, modalTextWidth, textBlockHeight, type TextLine } from './surface-kit-extra.ts';

const HINTS: readonly KitHint[] = [['↑↓', 'move'], ['⏎', 'load']];
const AGENT_PROFILES_NOTE = 'Agent profiles: /agent profiles';

/** The static strings this surface can show (checked by package verification). */
export function renderProfilePickerPackageText(): string {
  return [
    'Profiles',
    'Filter profiles',
    '<n> saved',
    '<n> of <total>',
    'No saved profiles.',
    'Open Agent Workspace -> Profiles to create and manage isolated Agent profile homes.',
    'No profiles match "<query>".',
    'move',
    'load',
    AGENT_PROFILES_NOTE,
    renderProfilePickerStatePackageText(),
  ].join('\n');
}

/**
 * Render the profile picker modal as a SurfaceLayer in screen coordinates.
 */
export function renderProfilePickerModal(
  modal: ProfilePickerModal,
  screenWidth: number,
  screenHeight = 24,
): SurfaceLayer {
  const t = activeTokens();
  const visible = modal.visibleProfiles;
  const rows: KitRow[] = visible.map((profile, i) => ({
    label: profile.name,
    desc: 'display, provider, behavior',
    right: formatTimestamp(profile.timestamp),
    selected: i === modal.selectedIndex,
  }));

  const notes: TextLine[] = [];
  if (modal.statusMessage) notes.push({ text: modal.statusMessage, style: { fg: t.accent } });
  notes.push({ text: AGENT_PROFILES_NOTE, style: { fg: t.textFaint } });

  const width = modalTextWidth(screenWidth, screenHeight);
  const allRows = modal.profiles.map((profile): KitRow => ({ label: profile.name, desc: 'display, provider, behavior', right: formatTimestamp(profile.timestamp) }));
  const emptyLines: TextLine[] = [
    { text: 'No saved profiles.', style: { fg: t.textMuted } },
    { text: 'Open Agent Workspace -> Profiles to create and manage isolated Agent profile homes.', style: { fg: t.textFaint } },
  ];
  const listRows = allRows.length > 0 ? listHeight(allRows, 0, width - 1) : textBlockHeight(emptyLines, width);
  const noteRows = textBlockHeight(notes, width) + 1;
  const height = modalHeightFor(screenWidth, screenHeight, { hints: HINTS }, 2 + listRows + noteRows);

  const f = beginModal(screenWidth, screenHeight, { title: 'Profiles', hints: HINTS, height });
  const total = modal.profiles.length;
  searchRow(f, f.top, modal.query, 'Filter profiles', modal.query ? `${visible.length} of ${total}` : `${total} saved`);

  const top = f.top + 2;
  const listBottom = Math.max(top, f.bottom - noteRows);
  modal.setVisibleRows(Math.max(3, listBottom - top + 1));
  drawTextBlock(f.canvas, f.l, listBottom + 2, f.r - f.l + 1, notes, f.bottom);

  if (total === 0) {
    drawTextBlock(f.canvas, f.l, top, f.r - f.l + 1, emptyLines, listBottom);
  } else if (rows.length === 0) {
    drawTextBlock(f.canvas, f.l, top, f.r - f.l + 1, [{ text: `No profiles match "${modal.query}".`, style: { fg: t.textMuted } }], listBottom);
  } else {
    const res = drawList(f.canvas, { rows, top, bottom: listBottom, x0: f.l, x1: f.r, scrollKey: { owner: modal, name: 'profiles' } });
    f.hintRight = scrollCountText(res.above, res.below);
  }
  return finishModal(f);
}
