/**
 * Tests for renderProfilePickerModal renderer.
 */
import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProfilePickerModal } from '../../input/profile-picker-modal.ts';
import { ProfileManager } from '@goodvibes-jev/engine/sdk/platform/profiles';
import { renderProfilePickerModal } from '../../renderer/profile-picker-modal.ts';
import { layerText, layerTextBlock } from '../helpers/surface-frame.ts';
import { activeTokens } from '../../renderer/theme.ts';

const W = 120;
const profileManager = new ProfileManager(join(tmpdir(), 'gv-renderer-profile-picker'));

function makeModal(overrides: Partial<ProfilePickerModal> = {}): ProfilePickerModal {
  const modal = new ProfilePickerModal(profileManager);
  modal.active = true;
  modal.profiles = [
    { name: 'work-profile',    timestamp: 1700000000000, filePath: '/x/work-profile.json' },
    { name: 'minimal-profile', timestamp: 1700100000000, filePath: '/x/minimal-profile.json' },
  ];
  modal.selectedIndex = 0;
  Object.assign(modal, overrides);
  return modal;
}

const H = 30;

describe('renderProfilePickerModal (modal surface kit)', () => {
  test('draws a kit modal inside the screen with the title and no box frame', () => {
    const layer = renderProfilePickerModal(makeModal(), W, H);
    expect(layer.x + layer.lines[0]!.length).toBeLessThanOrEqual(W);
    expect(layer.y + layer.lines.length).toBeLessThanOrEqual(H);
    expect(layerText(layer)[2]).toContain('Profiles');
    expect(layerTextBlock(layer)).not.toMatch(/[┌┐└┘│]/);
  });

  test('keycap hints: move and load; Agent profile homes are pointed to in the workspace', () => {
    const text = layerTextBlock(renderProfilePickerModal(makeModal(), W, H));
    expect(text).toContain('↑↓  move');
    expect(text).toContain('⏎  load');
    expect(text).toContain('Agent profiles: /agent profiles');
  });

  test('shows profile names and saved times; the selected row is the gradient row', () => {
    const layer = renderProfilePickerModal(makeModal(), W, H);
    const text = layerTextBlock(layer);
    expect(text).toContain('work-profile');
    expect(text).toContain('minimal-profile');
    const ink = activeTokens().selectedListItemText;
    const row = layer.lines.findIndex((line) => line.some((c) => c.fg === ink && c.bold && c.char.trim() !== ''));
    expect(layerText(layer)[row]).toContain('work-profile');
  });

  test('empty profiles shows the honest empty state', () => {
    const modal = makeModal();
    modal.profiles = [];
    const text = layerTextBlock(renderProfilePickerModal(modal, W, H));
    expect(text).toContain('No saved profiles');
    expect(text).toContain('Open Agent Workspace -> Profiles');
  });

  test('status message is displayed when set', () => {
    const modal = makeModal();
    modal.statusMessage = 'Loaded profile: work-profile';
    expect(layerTextBlock(renderProfilePickerModal(modal, W, H))).toContain('Loaded profile: work-profile');
  });

  test('deleting explains that it needs the explicit command (the status line wraps in full)', () => {
    const modal = makeModal();
    modal.selectedIndex = 1;
    modal.deleteSelected();
    const text = layerText(renderProfilePickerModal(modal, W, H)).join(' ').replace(/\s+/g, ' ');
    expect(text).toContain(modal.statusMessage.replace(/\s+/g, ' '));
  });

  test('the search row filters by name', () => {
    const modal = makeModal();
    modal.setQuery('mini');
    const text = layerTextBlock(renderProfilePickerModal(modal, W, H));
    expect(text).toContain('mini▏');
    expect(text).toContain('1 of 2');
    expect(text).not.toContain('work-profile');
  });

  test('works at a narrow terminal width', () => {
    const layer = renderProfilePickerModal(makeModal(), 60, 24);
    expect(layer.x).toBe(1);
    expect(layer.lines[0]!.length).toBe(58);
  });
});
