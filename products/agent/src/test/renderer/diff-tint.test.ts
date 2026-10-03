/**
 * Diff row tints stay clearly visible in every bundled theme and mode, on the
 * element panel an opened edit's diff sits on (the work tree's bead body), on
 * the surface fill (backgroundPanel), and on the diff view's own context fill.
 *
 * Metric: Euclidean distance in sRGB (0..441). MIN_DIFF_TINT_DISTANCE (24) is
 * about three times the step at which two flat fills can be told apart side by
 * side, so a tinted row reads as tinted at a glance instead of on inspection.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { listBundledThemes } from '@goodvibes-jev/engine/sdk/platform/presentation';
import { diffRowTints } from '../../renderer/diff-tint.ts';
import { activeTokens, getActiveThemeName, getActiveThemeMode, setActiveThemeMode, setActiveThemeName } from '../../renderer/theme.ts';
import { drawDiffRow, type DiffRow } from '../../renderer/lane-graph/diff-rows.ts';
import { renderDiffView } from '../../renderer/diff-view.ts';
import { beginModal } from '../../renderer/surface-kit.ts';
import { panel } from '../../renderer/surface-kit-parts.ts';

/** Mirrors the floor in src/renderer/diff-tint.ts (see the justification there and above). */
const MIN_DIFF_TINT_DISTANCE = 24;

const rgb = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const colorDistance = (a: string, b: string): number => {
  const x = rgb(a);
  const y = rgb(b);
  return Math.hypot(x[0]! - y[0]!, x[1]! - y[1]!, x[2]! - y[2]!);
};

const savedName = getActiveThemeName();
const savedMode = getActiveThemeMode();
afterAll(() => {
  setActiveThemeName(savedName);
  setActiveThemeMode(savedMode);
});

describe('the visibility floor', () => {
  test('keeps a theme tint that is already far enough from the fill', () => {
    setActiveThemeName('dracula');
    setActiveThemeMode('dark');
    const t = activeTokens();
    // dracula dark's added row sits well clear of its surface fill.
    expect(colorDistance(t.diffAddedBg, t.backgroundPanel)).toBeGreaterThan(MIN_DIFF_TINT_DISTANCE);
    expect(diffRowTints(t.backgroundPanel).addedRow).toBe(t.diffAddedBg);
  });

  test('pushes a close tint further along its own direction from the fill', () => {
    setActiveThemeName('gruvbox');
    setActiveThemeMode('light');
    const t = activeTokens();
    const out = diffRowTints(t.backgroundElement).addedRow;
    expect(colorDistance(t.diffAddedBg, t.backgroundElement)).toBeLessThan(MIN_DIFF_TINT_DISTANCE);
    expect(colorDistance(out, t.backgroundElement)).toBeGreaterThanOrEqual(MIN_DIFF_TINT_DISTANCE);
    // Same direction: moving from the fill toward the theme's tint, never past it the other way.
    const along = (c: string): number => rgb(c).reduce((sum, v, i) => sum + (v - rgb(t.backgroundElement)[i]!) * (rgb(t.diffAddedBg)[i]! - rgb(t.backgroundElement)[i]!), 0);
    expect(along(out)).toBeGreaterThan(along(t.diffAddedBg));
  });

  test('a tint equal to the fill falls back to mixing the fill toward the sign color', () => {
    setActiveThemeName('goodvibes');
    setActiveThemeMode('dark');
    const t = activeTokens();
    const out = diffRowTints(t.diffAddedBg).addedRow;
    expect(colorDistance(out, t.diffAddedBg)).toBeGreaterThanOrEqual(MIN_DIFF_TINT_DISTANCE);
  });
});

describe('every bundled theme: added and removed rows are clearly tinted', () => {
  for (const theme of listBundledThemes()) {
    for (const mode of ['dark', 'light'] as const) {
      if (!theme.variants.includes(mode)) continue;
      test(`${theme.name} ${mode}`, () => {
        setActiveThemeName(theme.name);
        setActiveThemeMode(mode);
        const t = activeTokens();
        for (const fill of [t.backgroundElement, t.backgroundPanel, t.diffContextBg]) {
          const tints = diffRowTints(fill);
          for (const [name, color] of Object.entries(tints)) {
            const d = colorDistance(color, fill);
            if (d < MIN_DIFF_TINT_DISTANCE) throw new Error(`${theme.name} ${mode}: ${name} ${color} is ${d.toFixed(1)} from fill ${fill}`);
          }
          // Added and removed rows stay distinguishable from each other too.
          expect(colorDistance(tints.addedRow, tints.removedRow)).toBeGreaterThan(8);
        }
      });
    }
  }
});

test('drawDiffRow paints the visible tints across the row and the gutter', () => {
  setActiveThemeName('gruvbox');
  setActiveThemeMode('light');
  const f = beginModal(120, 30, { title: 'Changes' });
  const p = panel(f.canvas, 10, 4, 60, 8);
  const row: DiffRow = { kind: 'line', hunk: 0, first: true, text: 'const a = 1;', line: { kind: 'add', text: 'const a = 1;', oldNo: null, newNo: 3 }, tokens: [{ text: 'const a = 1;', fg: activeTokens().text }] };
  drawDiffRow(f.canvas, p, p.top, row);
  const tints = diffRowTints(p.bg);
  expect(f.canvas.lines[p.top]![p.x + p.w - 1]!.bg).toBe(tints.addedRow);
  expect(f.canvas.lines[p.top]![p.x]!.bg).toBe(tints.addedGutter);
  expect(colorDistance(tints.addedRow, p.bg)).toBeGreaterThanOrEqual(MIN_DIFF_TINT_DISTANCE);
});

test('the diff view paints its added and removed rows with the visible tints of its own fill', () => {
  setActiveThemeName('gruvbox');
  setActiveThemeMode('light');
  const t = activeTokens();
  const lines = renderDiffView(['@@ -1,2 +1,2 @@', '-old line', '+new line', ' same'].join('\n'), 60);
  const tints = diffRowTints(t.diffContextBg);
  const rowOf = (text: string) => lines.find((line) => line.map((c) => c.char).join('').includes(text))!;
  expect(rowOf('new line').some((c) => c.bg === tints.addedRow)).toBe(true);
  expect(rowOf('old line').some((c) => c.bg === tints.removedRow)).toBe(true);
});
