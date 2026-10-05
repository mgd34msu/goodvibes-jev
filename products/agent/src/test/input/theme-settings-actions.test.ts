/**
 * theme-settings-actions.test.ts, the display.theme picker.
 *
 * Covers: the rows (system + every bundled theme, current marked), live
 * preview as the cursor moves (theme + repaint), Enter persisting the choice,
 * Esc restoring the theme active at open, and the SelectionModal highlight
 * hook the preview rides on.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { getBundledTheme, resolveTheme } from '@goodvibes-jev/engine/sdk/platform/presentation';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { SelectionModal, type SelectionItem, type SelectionResult } from '../../input/selection-modal.ts';
import { buildThemePickerItems, openThemePicker } from '../../input/theme-settings-actions.ts';
import { activeTokens, getActiveThemeMode, getActiveThemeName, listThemeChoices, setActiveThemeMode, setActiveThemeName } from '../../renderer/theme.ts';

afterEach(() => {
  setActiveThemeName('goodvibes');
  setActiveThemeMode('dark');
});

interface Harness {
  readonly ctx: CommandContext;
  readonly modal: SelectionModal;
  readonly configManager: ConfigManager;
  reload(): ConfigManager;
  repaints: number;
  resolve(result: SelectionResult | null): void;
}

function harness(configured: unknown): Harness {
  const modal = new SelectionModal();
  const configDir = makeProjectTempDir('theme-picker');
  const configManager = new ConfigManager({ configDir });
  configManager.setDynamic('display.theme', configured);
  configManager.set('display.themeMode', 'light');
  setActiveThemeMode('light');
  let callback: ((result: SelectionResult | null) => void) | null = null;
  const h: Harness = {
    modal,
    configManager,
    reload: () => new ConfigManager({ configDir, readOnly: true }),
    repaints: 0,
    resolve: (result) => {
      modal.close();
      callback?.(result);
    },
    ctx: {
      openSelection: (title: string, items: SelectionItem[], opts: Parameters<SelectionModal['open']>[2], cb: (r: SelectionResult | null) => void) => {
        callback = cb;
        modal.open(title, items, opts);
      },
      platform: {
        configManager,
      },
      clearScreen: () => { h.repaints++; },
      renderRequest: () => {},
      print: () => {},
    } as unknown as CommandContext,
  };
  return h;
}

describe('theme picker rows', () => {
  test('lists system then every bundled theme, marking the current one', () => {
    const items = buildThemePickerItems('nord');
    expect(items.map((item) => item.id)).toEqual(listThemeChoices().map((choice) => choice.name));
    expect(items[0]!.id).toBe('system');
    expect(items.find((item) => item.id === 'nord')!.detail).toContain('(current)');
    expect(items.find((item) => item.id === 'nord')!.detail).toContain('dark only');
    expect(items.find((item) => item.id === 'dracula')!.detail).toContain('dark + light');
  });
});

describe('openThemePicker', () => {
  test('opens on the configured theme (legacy vaporwave lands on goodvibes-neon)', () => {
    const h = harness('vaporwave');
    setActiveThemeName('vaporwave');
    expect(openThemePicker(h.ctx)).toBe(true);
    expect(h.modal.getSelected()?.id).toBe('goodvibes-neon');
  });

  test('moving the cursor previews the highlighted theme and repaints', () => {
    const h = harness('goodvibes');
    openThemePicker(h.ctx);
    expect(getActiveThemeName()).toBe('goodvibes');
    h.modal.moveDown();
    expect(getActiveThemeName()).toBe(h.modal.getSelected()!.id);
    expect(getActiveThemeName()).toBe('goodvibes-neon');
    expect(h.repaints).toBeGreaterThan(0);
    h.modal.moveDown();
    expect(getActiveThemeName()).toBe('catppuccin');
    expect(activeTokens()).toEqual(resolveTheme(getBundledTheme('catppuccin')!.json, 'light'));
    expect(h.configManager.get('display.theme')).toBe('goodvibes');
    expect(h.reload().get('display.theme')).toBe('goodvibes');
    expect(getActiveThemeMode()).toBe('light');
    expect(h.configManager.get('display.themeMode')).toBe('light');
  });

  test('Esc restores the theme that was active when the picker opened', () => {
    const h = harness('dracula');
    setActiveThemeName('dracula');
    openThemePicker(h.ctx);
    h.modal.moveDown();
    h.modal.moveDown();
    expect(getActiveThemeName()).not.toBe('dracula');
    h.resolve(null);
    expect(getActiveThemeName()).toBe('dracula');
    expect(h.configManager.get('display.theme')).toBe('dracula');
    expect(h.reload().get('display.theme')).toBe('dracula');
    expect(activeTokens()).toEqual(resolveTheme(getBundledTheme('dracula')!.json, 'light'));
    expect(getActiveThemeMode()).toBe('light');
    expect(h.reload().get('display.themeMode')).toBe('light');
  });

  test('Enter stores the choice in display.theme and keeps it active', () => {
    const h = harness('goodvibes');
    openThemePicker(h.ctx);
    h.modal.setQuery('gruv');
    const item = h.modal.getSelected()!;
    expect(item.id).toBe('gruvbox');
    expect(getActiveThemeName()).toBe('gruvbox'); // searching previews too
    h.resolve({ item, action: 'select' });
    expect(h.configManager.get('display.theme')).toBe('gruvbox');
    expect(h.reload().get('display.theme')).toBe('gruvbox');
    expect(getActiveThemeName()).toBe('gruvbox');
    expect(activeTokens()).toEqual(resolveTheme(getBundledTheme('gruvbox')!.json, 'light'));
    expect(getActiveThemeMode()).toBe('light');
    expect(h.reload().get('display.themeMode')).toBe('light');

    // A second open starts on the committed choice; cancelling its preview
    // restores that choice without writing the preview to the enum setting.
    openThemePicker(h.ctx);
    expect(h.modal.getSelected()?.id).toBe('gruvbox');
    h.modal.setQuery('nord');
    expect(getActiveThemeName()).toBe('nord');
    h.resolve(null);
    expect(getActiveThemeName()).toBe('gruvbox');
    expect(h.reload().get('display.theme')).toBe('gruvbox');
  });
});

describe('SelectionModal onHighlight', () => {
  test('fires on open and only when the highlighted row changes', () => {
    const modal = new SelectionModal();
    const seen: Array<string | null> = [];
    modal.open('t', [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], {
      onHighlight: (item) => { seen.push(item?.id ?? null); },
    });
    modal.moveDown();
    modal.moveDown(); // wraps back to a
    modal.setQuery('A'); // still a: no event
    expect(seen).toEqual(['a', 'b', 'a']);
    modal.close();
    modal.moveDown();
    expect(seen).toEqual(['a', 'b', 'a']);
  });
});
