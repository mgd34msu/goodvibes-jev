// ---------------------------------------------------------------------------
// golden-frames.test.ts, deterministic whole-screen snapshots of every Agent
// surface, each one run through the design's layout audit.
//
// Every fixture in helpers/agent-frame-fixtures.ts (the base screen, the home
// splash, every modal, popup, bar and block) is rendered with frozen inputs
// under two themes:
//
//   golden-frames/                  the default `goodvibes` theme
//   golden-frames-goodvibes-neon/   the same surfaces under goodvibes-neon
//
// and then
//   1. audited (helpers/frame-audit.ts: nothing past the screen edge, text
//      2 columns from every fill's sides, an empty first and last row in
//      every filled block, every ┃ bar running its block's full height), and
//   2. compared against the committed snapshot.
//
// Snapshot format:
//   Line 1:  # GV_GOLDEN surface=<name> width=<W> height=<H>
//   Lines 2..H+1:  |<chars padded to W>|
//   Then:    @STYLES, one record per non-default attribute: <row> <col> <attr>=<value>
//
// Update path:
//   GOODVIBES_UPDATE_GOLDENS=1 bun test src/test/renderer/golden-frames.test.ts
//   Without the variable a mismatch (or a missing snapshot) fails.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Cell, Line } from '@goodvibes-jev/engine/sdk/platform/types';
import { activeTokens, setActiveThemeMode, setActiveThemeName } from '../../renderer/theme.ts';
import { auditFrame } from '../helpers/frame-audit.ts';
import { frameFixtures } from '../helpers/agent-frame-fixtures.ts';

const UPDATE = process.env['GOODVIBES_UPDATE_GOLDENS'] === '1';

const SETS: ReadonlyArray<{ readonly theme: string; readonly dir: string }> = [
  { theme: 'goodvibes', dir: new URL('./golden-frames/', import.meta.url).pathname },
  { theme: 'goodvibes-neon', dir: new URL('./golden-frames-goodvibes-neon/', import.meta.url).pathname },
];

function snapshotEncode(surface: string, lines: Line[]): string {
  const width = lines[0]?.length ?? 0;
  const text: string[] = [];
  const styles: string[] = [];
  lines.forEach((line, row) => {
    text.push(`|${line.map((c) => (c.char === '' ? ' ' : c.char)).join('')}|`);
    line.forEach((cell: Cell, col) => {
      if (cell.fg) styles.push(`${row} ${col} fg=${cell.fg}`);
      if (cell.bg) styles.push(`${row} ${col} bg=${cell.bg}`);
      if (cell.bold) styles.push(`${row} ${col} bold=1`);
      if (cell.dim) styles.push(`${row} ${col} dim=1`);
      if (cell.underline) styles.push(`${row} ${col} underline=1`);
      if (cell.italic) styles.push(`${row} ${col} italic=1`);
      if (cell.strikethrough) styles.push(`${row} ${col} strikethrough=1`);
    });
  });
  return [`# GV_GOLDEN surface=${surface} width=${width} height=${lines.length}`, ...text, '@STYLES', ...styles, ''].join('\n');
}

/** A readable description of how two snapshots differ, or null when they match. */
function snapshotDiff(name: string, expected: string, actual: string): string | null {
  if (expected === actual) return null;
  const split = (raw: string): { text: string[]; styles: Set<string> } => {
    const rows = raw.split('\n');
    const at = rows.indexOf('@STYLES');
    return { text: rows.slice(1, at), styles: new Set(rows.slice(at + 1).filter((r) => r.trim())) };
  };
  const exp = split(expected);
  const act = split(actual);
  const out: string[] = [`[${name}] golden-frame mismatch:`];
  for (let i = 0; i < Math.max(exp.text.length, act.text.length); i++) {
    if (exp.text[i] !== act.text[i]) out.push(`  TEXT row ${i}:`, `    expected: ${exp.text[i] ?? '<missing>'}`, `    actual:   ${act.text[i] ?? '<missing>'}`);
  }
  let styleDiffs = 0;
  for (const s of exp.styles) if (!act.styles.has(s) && styleDiffs++ < 20) out.push(`  STYLE removed: ${s}`);
  for (const s of act.styles) if (!exp.styles.has(s) && styleDiffs++ < 40) out.push(`  STYLE added:   ${s}`);
  return out.join('\n');
}

for (const set of SETS) {
  describe(`golden frames : ${set.theme}`, () => {
    for (const fixture of frameFixtures()) {
      test(fixture.name, () => {
        setActiveThemeName(set.theme);
        setActiveThemeMode('dark');
        try {
          const lines = fixture.render();
          expect(lines).toHaveLength(fixture.height);
          expect(lines.every((line) => line.length === fixture.width)).toBe(true);
          // The layout audit runs on every frame before it is compared.
          const issues = auditFrame(lines, fixture.width, activeTokens());
          expect(issues.map((i) => `${i.kind} row ${i.row}: ${i.detail}`)).toEqual([]);
          const actual = snapshotEncode(fixture.name, lines);
          const file = join(set.dir, `${fixture.name}.txt`);
          if (UPDATE) {
            mkdirSync(set.dir, { recursive: true });
            writeFileSync(file, actual, 'utf-8');
            return;
          }
          if (!existsSync(file)) throw new Error(`[${fixture.name}] golden file missing. Run with GOODVIBES_UPDATE_GOLDENS=1 to generate.`);
          const diff = snapshotDiff(fixture.name, readFileSync(file, 'utf-8'), actual);
          if (diff !== null) throw new Error(`${diff}\n\nRun with GOODVIBES_UPDATE_GOLDENS=1 to regenerate.`);
        } finally {
          setActiveThemeName('goodvibes');
          setActiveThemeMode('dark');
        }
      });
    }
  });
}

describe('golden frames : determinism', () => {
  test('chrome at rest is 7 rows: header 1, input area 5 (caps and padding around the text), status line 1', async () => {
    const { UIFactory } = await import('../../renderer/ui-factory.ts');
    const { fixtureFooter } = await import('../helpers/agent-frame-fixtures.ts');
    expect(UIFactory.createHeader(120, 'claude-opus-4')).toHaveLength(1);
    expect(fixtureFooter(120)).toHaveLength(6);
  });
});
