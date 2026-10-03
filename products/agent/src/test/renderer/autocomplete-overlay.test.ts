import { describe, expect, test } from 'bun:test';
import { renderAutocompleteOverlay } from '../../renderer/autocomplete-overlay.ts';
import { AutocompleteEngine } from '../../input/autocomplete.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { activeTokens } from '../../renderer/theme.ts';

function engine(): AutocompleteEngine {
  const registry = new CommandRegistry();
  for (const [name, description] of [
    ['approval', 'Review action-specific approval classes and specialized security paths'],
    ['auth', 'Review provider auth posture and export redacted auth review bundles'],
    ['bookmarks', 'List bookmarked blocks'],
  ] as const) {
    registry.register({ name, description, handler: async (_args: string[], _ctx: CommandContext) => {} });
  }
  const autocomplete = new AutocompleteEngine(registry);
  autocomplete.update('a');
  return autocomplete;
}

describe('renderAutocompleteOverlay (composer popup)', () => {
  test('a blank row, then the ┃ bar at column 2 beside a surface fill from column 3 to width-3 on every row', () => {
    const width = 80;
    const lines = renderAutocompleteOverlay(engine(), width);
    expect(lines.length).toBeGreaterThanOrEqual(5);
    for (const line of lines) expect(line.length).toBe(width);
    // The popup keeps one blank row between itself and the transcript behind it.
    expect(lines[0]!.every((cell) => cell.char === ' ' && cell.bg === '')).toBe(true);
    const t = activeTokens();
    for (const line of lines.slice(1)) {
      expect(line[2]!.char).toBe('┃');
      expect(line[3]!.bg).not.toBe('');
      expect(line[width - 3]!.bg).not.toBe('');
      expect(line[width - 2]!.bg).toBe('');
    }
    expect(lines.slice(1).every((line) => line[3]!.bg === t.backgroundPanel || line[3]!.bg !== '')).toBe(true);
  });

  test('the selected row is the gradient row, inset 2 columns from the fill, with its tab hint and full description', () => {
    const lines = renderAutocompleteOverlay(engine(), 80);
    const text = lines.map((line) => line.map((cell) => cell.char).join(''));
    const row = text.findIndex((line) => line.includes('/approval'));
    expect(text[row]).toContain('tab complete');
    const selected = lines[row]!;
    expect(selected[5]!.bg).not.toBe(activeTokens().backgroundPanel);
    expect(selected[5]!.fg).toBe(activeTokens().selectedListItemText);
  });
});
