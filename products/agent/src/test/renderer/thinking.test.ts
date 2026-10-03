/**
 * thinking.test.ts, the thinking block reads live tones.
 *
 * The ▌ marker accent and italic body paint on the transparent terminal bg, so
 * they must resolve through activeUiTones() per render (not a frozen dark
 * constant). Proven by flipping the active mode and observing the marker accent
 * change to the light reasoning purple.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { renderThinkingBlock } from '../../renderer/thinking.ts';
import { resolveUiTones, setActiveThemeMode } from '../../renderer/theme.ts';

afterEach(() => setActiveThemeMode('dark'));

/** The set of foreground colours used across a rendered surface. */
function fgSet(lines: ReturnType<typeof renderThinkingBlock>): Set<string> {
  const out = new Set<string>();
  for (const line of lines) for (const cell of line) if (cell.fg) out.add(cell.fg);
  return out;
}

describe('renderThinkingBlock reads live tones', () => {
  test('dark uses the shared reasoning accent + chrome.faint body', () => {
    const fgs = fgSet(renderThinkingBlock('Reasoning about the plan', 60));
    expect(fgs.has(resolveUiTones('dark').state.reasoning)).toBe(true);
    expect(fgs.has(resolveUiTones('dark').chrome.faint)).toBe(true);
  });

  test('light flips to the light reasoning accent (legible on a light terminal)', () => {
    setActiveThemeMode('light');
    const fgs = fgSet(renderThinkingBlock('Reasoning about the plan', 60));
    expect(fgs.has(resolveUiTones('light').state.reasoning)).toBe(true);
    // The dark reasoning accent no longer leaks into a light render.
    expect(fgs.has(resolveUiTones('dark').state.reasoning)).toBe(false);
  });
});
