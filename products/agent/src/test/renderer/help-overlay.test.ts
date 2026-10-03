/**
 * Tests for renderHelpOverlay and renderShortcutsOverlay (kit modals with an
 * always-live search row).
 */
import { describe, test, expect } from 'bun:test';
import { renderHelpOverlay, renderShortcutsOverlay } from '../../renderer/help-overlay.ts';
import type { SlashCommand } from '../../input/command-registry.ts';
import { KeybindingsManager } from '../../input/keybindings.ts';
import { OverlayFilter } from '../../input/overlay-filter.ts';
import { frameFromLayer, layerText, layerTextBlock } from '../helpers/surface-frame.ts';
import { auditFrame } from '../helpers/frame-audit.ts';
import { activeTokens } from '../../renderer/theme.ts';
import type { SurfaceLayer } from '../../renderer/surface-kit.ts';

const W = 120;
const H = 40;
const KEYBINDINGS = new KeybindingsManager({ configPath: '/nonexistent/path/keybindings.json' });

const SAMPLE_COMMANDS: SlashCommand[] = [
  { name: 'model', aliases: ['m'], description: 'Select LLM model', handler: () => {} },
  { name: 'help', aliases: ['h', '?'], description: 'Show help', handler: () => {} },
  { name: 'quit', aliases: ['q'], description: 'Exit application', handler: () => {} },
];

/** Every row of the help list, scrolled through with the renderer's own scroll bound. */
function renderAllText(commands?: SlashCommand[], query = ''): string {
  const filter = new OverlayFilter();
  filter.query = query;
  const frames: string[] = [layerTextBlock(renderHelpOverlay(W, H, KEYBINDINGS, commands, 0, filter))];
  for (let offset = 6; offset <= filter.maxScroll + 6; offset += 6) {
    frames.push(layerTextBlock(renderHelpOverlay(W, H, KEYBINDINGS, commands, offset, filter)));
  }
  return frames.join('\n');
}

function renderAllShortcutText(): string {
  const filter = new OverlayFilter();
  const frames: string[] = [layerTextBlock(renderShortcutsOverlay(W, H, KEYBINDINGS, 0, filter))];
  for (let offset = 6; offset <= filter.maxScroll + 6; offset += 6) {
    frames.push(layerTextBlock(renderShortcutsOverlay(W, H, KEYBINDINGS, offset, filter)));
  }
  return frames.join('\n');
}

function rows(layer: SurfaceLayer): string[] {
  return layer.lines.map((line) => line.map((cell) => cell.char).join(''));
}

describe('renderHelpOverlay', () => {
  test('is a kit modal layer that fits the screen', () => {
    const layer = renderHelpOverlay(W, H, KEYBINDINGS, undefined, 0);
    expect(layer.dim).toBe(true);
    expect(layer.x + layer.lines[0]!.length).toBeLessThanOrEqual(W);
    expect(layer.y + layer.lines.length).toBeLessThanOrEqual(H);
  });

  test('title row reads Help with the esc keycap', () => {
    const title = rows(renderHelpOverlay(W, H, KEYBINDINGS, undefined, 0))[2]!;
    expect(title).toContain('Help');
    expect(title).toContain(' esc ');
  });

  test('the search row is always live and filters every group', () => {
    const text = renderAllText(SAMPLE_COMMANDS, 'model');
    expect(text).toContain('model▏');
    expect(text).toContain('/model');
    expect(text).not.toContain('Scroll by full page');
  });

  test('says when nothing matches', () => {
    const filter = new OverlayFilter();
    filter.query = 'zzzz-no-match';
    expect(layerTextBlock(renderHelpOverlay(W, H, KEYBINDINGS, SAMPLE_COMMANDS, 0, filter))).toContain('Nothing matches "zzzz-no-match".');
  });

  test('lists the navigation, editing and workspace groups', () => {
    const text = renderAllText();
    expect(text).toContain('core navigation');
    expect(text).toContain('prompt and editing');
    expect(text).toContain('overlays and workspace');
    expect(text).toContain('Search all Agent workspace actions');
    expect(text).toContain('Open selected action or form');
  });

  test('contains Quick Start when featured commands are registered', () => {
    const text = renderAllText([{ name: 'agent', description: 'Operator workspace', handler: () => {} }]);
    expect(text).toContain('quick start');
    expect(text).toContain('press / there to search every action');
  });

  test('shows the setup quick-start row when setup is registered', () => {
    const text = renderAllText([{ name: 'setup', description: 'Setup surfaces', handler: () => {} }]);
    expect(text).toContain('/setup');
    expect(text).toContain('Open the Agent workspace');
    expect(text).not.toContain('first-run checklist');
  });

  test('includes the search, page and ? shortcuts', () => {
    const text = renderAllText();
    expect(text).toContain('Ctrl+F');
    expect(text).toContain('PageUp');
    expect(text).toContain('Toggle help');
  });

  test('renders the command list when commands are provided', () => {
    const text = renderAllText(SAMPLE_COMMANDS);
    expect(text).toContain('/model');
    expect(text).toContain('/help');
    expect(text).toContain('Hidden power commands still work');
  });

  test('shows the fallback command list when no commands are provided', () => {
    expect(renderAllText()).toContain('/help');
  });

  test('fits a narrow terminal', () => {
    const layer = renderHelpOverlay(60, 24, KEYBINDINGS, undefined, 0);
    expect(layer.x + layer.lines[0]!.length).toBeLessThanOrEqual(60);
  });

  test('keycap hints name scrolling and closing', () => {
    const text = layerTextBlock(renderHelpOverlay(W, H, KEYBINDINGS, undefined, 0));
    expect(text).toContain('↑↓  scroll');
    expect(text).toContain('?  close');
  });

  test('registry traversal crash guard: a throwing command getter does not crash the modal', () => {
    const throwingCmd = {
      name: 'cockpit',
      description: 'Control room',
      handler: () => {},
      get aliases(): string[] {
        throw new Error('plugin getter failure');
      },
    } as unknown as SlashCommand;
    expect(() => {
      const text = layerTextBlock(renderHelpOverlay(W, H, KEYBINDINGS, [throwingCmd], 0));
      expect(text).toContain('Help');
    }).not.toThrow();
  });
});

describe('renderShortcutsOverlay', () => {
  test('presents Ctrl+A as prompt editing only', () => {
    const text = renderAllShortcutText();
    expect(text).toContain('Move to start of line');
    expect(text).not.toContain('Delegate diff');
    expect(text).not.toContain('apply-diff');
  });

  test('records how far the grid can scroll and filters by key or action', () => {
    const filter = new OverlayFilter();
    filter.query = 'bookmark';
    const text = layerTextBlock(renderShortcutsOverlay(W, H, KEYBINDINGS, 0, filter));
    expect(text).toContain('Bookmark block');
    expect(text).not.toContain('Insert newline');
    expect(filter.maxScroll).toBe(0);
  });

  /** Columns of ✦ group headers below the title row (the title's own ✦ is excluded). */
  function headerColumns(layer: SurfaceLayer): number[] {
    const rows = layerText(layer);
    const title = rows.findIndex((line) => line.includes('Keyboard shortcuts'));
    return [...new Set(rows.slice(title + 1).flatMap((line) => [...line.matchAll(/✦/g)].map((m) => m.index!)))].sort((a, b) => a - b);
  }

  test('two columns below 170 screen columns, three from 170 up; the frame passes the layout audit', () => {
    for (const [width, columns] of [[100, 2], [150, 2], [169, 2], [170, 3], [200, 3]] as const) {
      const layer = renderShortcutsOverlay(width, 50, KEYBINDINGS, 0, new OverlayFilter());
      expect(headerColumns(layer).length).toBe(columns);
      const frame = frameFromLayer(layer, width, 50);
      expect(auditFrame(frame, width, activeTokens()).map((i) => `${width}: ${i.kind} row ${i.row}: ${i.detail}`)).toEqual([]);
    }
  });

  test('at 150 columns an action that fits its column stays on one line', () => {
    const rows = layerText(renderShortcutsOverlay(150, 120, KEYBINDINGS, 0, new OverlayFilter()));
    for (const action of [
      'Scroll conversation or hovered panel',
      'Open that process\'s live output',
      'Go up one level; stops nothing',
      'Next / prev session (empty composer)',
      'Stop what the view shows (twice)',
    ]) expect(rows.some((line) => line.includes(action))).toBe(true);
  });
});
