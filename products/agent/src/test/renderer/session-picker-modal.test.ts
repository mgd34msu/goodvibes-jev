/**
 * Tests for renderSessionPickerModal (a kit modal with an always-live search row).
 */
import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionPickerModal } from '../../input/session-picker-modal.ts';
import { SessionManager } from '@goodvibes-jev/engine/sdk/platform/sessions';
import { renderSessionPickerModal } from '../../renderer/session-picker-modal.ts';
import { activeTokens } from '../../renderer/theme.ts';
import { layerText, layerTextBlock } from '../helpers/surface-frame.ts';

const W = 120;
const H = 30;
const NOW = 1700100000000 + 3_600_000;
// Never materialized on disk: SessionManager's constructor only reads, and this
// suite only renders modal state.
const sessionManager = new SessionManager(join(tmpdir(), 'gv-renderer-session-picker'), { surfaceRoot: 'tui' });

function makeModal(overrides: Partial<SessionPickerModal> = {}): SessionPickerModal {
  const modal = new SessionPickerModal(sessionManager);
  modal.active = true;
  modal.sessions = [
    { name: 'alpha-session', title: 'Alpha', model: 'gpt-4', provider: 'openai', timestamp: 1700000000000, messageCount: 5, filePath: '/x/alpha.jsonl' },
    { name: 'beta-session',  title: 'Beta',  model: 'gpt-4', provider: 'openai', timestamp: 1700100000000, messageCount: 12, filePath: '/x/beta.jsonl' },
  ];
  modal.selectedIndex = 0;
  Object.assign(modal, overrides);
  return modal;
}

function render(modal: SessionPickerModal, width = W, height = H): string {
  return layerTextBlock(renderSessionPickerModal(modal, width, height, NOW));
}

describe('renderSessionPickerModal', () => {
  test('is a kit modal layer that fits the screen', () => {
    const layer = renderSessionPickerModal(makeModal(), W, H, NOW);
    expect(layer.dim).toBe(true);
    expect(layer.x + layer.lines[0]!.length).toBeLessThanOrEqual(W);
  });

  test('title row carries the ✦ mark and the title', () => {
    expect(layerText(renderSessionPickerModal(makeModal(), W, H, NOW))[2]).toMatch(/✦ Sessions/);
  });

  test('keycap hints: move, load, and how to delete; the search row is live', () => {
    const text = render(makeModal());
    expect(text).toContain('↑↓  move');
    expect(text).toContain('⏎  load');
    expect(text).toContain('d  how to delete');
    expect(text).toContain('▏Search sessions');
    expect(text).toContain('2 saved');
  });

  test('shows session titles with their names, message counts and recency groups', () => {
    const text = render(makeModal());
    expect(text).toContain('Alpha');
    expect(text).toContain('alpha-session');
    expect(text).toContain('12 msgs');
    expect(text).toMatch(/✦ (today|yesterday|this week|earlier)/);
  });

  test('the selected session is drawn as the selected row', () => {
    const layer = renderSessionPickerModal(makeModal({ selectedIndex: 1 }), W, H, NOW);
    const ink = activeTokens().selectedListItemText;
    const row = layer.lines.findIndex((line) => line.some((c) => c.fg === ink && c.bold && c.char.trim() !== ''));
    expect(layerText(layer)[row]).toContain('Beta');
  });

  test('the search row filters by name and title', () => {
    const modal = makeModal();
    modal.setQuery('bet');
    const text = render(modal);
    expect(text).toContain('bet▏');
    expect(text).toContain('1 of 2');
    expect(text).not.toContain('alpha-session');
  });

  test('empty sessions shows the helpful message', () => {
    const text = render(makeModal({ sessions: [] }));
    expect(text).toContain('No saved sessions.');
    expect(text).toContain('Save current session');
  });

  test('status message is displayed when set, wrapped in full', () => {
    const modal = makeModal();
    modal.deleteSelected();
    const text = layerText(renderSessionPickerModal(modal, W, H, NOW)).join(' ').replace(/\s+/g, ' ');
    expect(text).toContain('Deletion requires an explicit command: /session delete alpha-session --yes');
  });

  test('works at narrow terminal width', () => {
    const layer = renderSessionPickerModal(makeModal(), 60, 24, NOW);
    expect(layer.x + layer.lines[0]!.length).toBeLessThanOrEqual(60);
  });
});
