/**
 * theme.test.ts, the token layers the renderer reads.
 *
 * Covers:
 *   - resolveTheme / resolveUiTones: stable per (theme, mode), complete, and
 *     light differs from dark
 *   - transcript tokens map onto the SDK theme tokens (one source)
 *   - goodvibes-neon reproduces the historical transcript and chrome values,
 *     except the documented textFaint nudge (#475569 -> #4e5c6f)
 *   - raw colours live only in the theme layer (the QR module colours) and the
 *     protected splash gradient: no other agent source file holds a hex
 *     literal or a quoted ANSI-256 index as a colour
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { TONE_TOKENS } from '@goodvibes-jev/engine/sdk/platform/presentation';
import {
  activeTokens,
  listThemeChoices,
  resolveTheme,
  resolveUiTones,
  setActiveThemeMode,
  setActiveThemeName,
  type ThemeTokens,
} from '../../renderer/theme.ts';

afterEach(() => {
  setActiveThemeName('goodvibes');
  setActiveThemeMode('dark');
});

const TOKEN_KEYS: (keyof ThemeTokens)[] = [
  'heading1', 'heading2', 'heading3', 'inlineCodeFg', 'link',
  'searchMatchBg', 'searchMatchFg', 'searchCurrentBg', 'searchCurrentFg',
  'strikethrough', 'blockquote', 'assistantHeader', 'reasoningAccent',
  'toolAccent', 'collapsedBodyBg', 'checkboxChecked', 'errorBarBg',
  'modelNameDim', 'toolNameFg', 'diffAccent',
];

function collectStringLeaves(value: unknown, prefix: string, out: Array<[string, unknown]>): void {
  if (typeof value === 'string') {
    out.push([prefix, value]);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      collectStringLeaves(nested, prefix ? `${prefix}.${key}` : key, out);
    }
  }
}

describe('resolveTheme', () => {
  test('is stable per (theme, mode): same object on repeat reads', () => {
    expect(resolveTheme('dark')).toBe(resolveTheme('dark'));
    expect(resolveTheme('light')).toBe(resolveTheme('light'));
  });

  test('light differs from dark', () => {
    expect(resolveTheme('light')).not.toBe(resolveTheme('dark'));
    expect(resolveTheme('light').heading1).not.toBe(resolveTheme('dark').heading1);
  });

  for (const choice of listThemeChoices()) {
    for (const mode of ['dark', 'light'] as const) {
      test(`${choice.name}/${mode}: every transcript token is a #rrggbb colour`, () => {
        setActiveThemeName(choice.name);
        const tokens = resolveTheme(mode);
        for (const key of TOKEN_KEYS) expect(tokens[key]).toMatch(/^#[0-9a-f]{6}$/);
      });
    }
  }

  test('transcript tokens come from the theme tokens (one source)', () => {
    const p = activeTokens();
    const t = resolveTheme('dark');
    expect(t.heading1).toBe(p.markdownHeading);
    expect(t.heading3).toBe(p.markdownHeading);
    expect(t.inlineCodeFg).toBe(p.markdownCode);
    expect(t.link).toBe(p.markdownLink);
    expect(t.blockquote).toBe(p.markdownBlockQuote);
    expect(t.strikethrough).toBe(p.textMuted);
    expect(t.searchMatchBg).toBe(p.searchMatchBg);
    expect(t.searchCurrentBg).toBe(p.searchCurrentBg);
    expect(t.errorBarBg).toBe(p.backgroundError);
    expect(t.checkboxChecked).toBe(p.success);
    expect(t.diffAccent).toBe(p.warning);
  });
});

describe('goodvibes-neon reproduces the historical look', () => {
  test('transcript tokens keep their historical dark values', () => {
    setActiveThemeName('goodvibes-neon');
    const dark = resolveTheme('dark');
    expect(dark.heading1).toBe('#00ffff');
    expect(dark.inlineCodeFg).toBe('#ffcc00');
    expect(dark.link).toBe('#00aaff');
    expect(dark.assistantHeader).toBe('#22d3ee');
    expect(dark.reasoningAccent).toBe('#a855f7');
    expect(dark.toolAccent).toBe('#38bdf8');
    expect(dark.checkboxChecked).toBe('#22c55e');
    expect(dark.modelNameDim).toBe('#94a3b8');
    expect(dark.toolNameFg).toBe('#e2e8f0');
    expect(dark.diffAccent).toBe('#f59e0b');
  });

  test('the legacy vaporwave name resolves to the same tokens', () => {
    setActiveThemeName('goodvibes-neon');
    const neon = activeTokens();
    setActiveThemeName('vaporwave');
    expect(activeTokens()).toBe(neon);
  });

  test('dark chrome equals the historical TONE_TOKENS except the textFaint nudge', () => {
    setActiveThemeName('goodvibes-neon');
    const expected: Array<[string, unknown]> = [];
    const actual: Array<[string, unknown]> = [];
    collectStringLeaves(TONE_TOKENS, '', expected);
    collectStringLeaves(resolveUiTones('dark'), '', actual);
    const actualMap = new Map(actual);
    for (const [leaf, value] of expected) {
      if (leaf === 'fg.dim' || leaf === 'chrome.faint') {
        expect(value).toBe('#475569');
        expect(actualMap.get(leaf)).toBe('#4e5c6f');
      } else {
        expect([leaf, actualMap.get(leaf)]).toEqual([leaf, value]);
      }
    }
  });
});

describe('resolveUiTones', () => {
  test('light has the same leaf shape as dark, every leaf a colour', () => {
    const darkLeaves: Array<[string, unknown]> = [];
    const lightLeaves: Array<[string, unknown]> = [];
    collectStringLeaves(resolveUiTones('dark'), '', darkLeaves);
    collectStringLeaves(resolveUiTones('light'), '', lightLeaves);
    expect(lightLeaves.map(([leaf]) => leaf).sort()).toEqual(darkLeaves.map(([leaf]) => leaf).sort());
    for (const [, value] of lightLeaves) expect(value).toMatch(/^#[0-9a-f]{6}$/);
  });

  test('light substitutes roles away from dark', () => {
    expect(resolveUiTones('light').state.reasoning).not.toBe(resolveUiTones('dark').state.reasoning);
    expect(resolveUiTones('light').accent.brand).not.toBe(resolveUiTones('dark').accent.brand);
  });
});

// ---------------------------------------------------------------------------
// Raw colours live only in the theme layer and the protected splash.
// ---------------------------------------------------------------------------

const SRC_ROOT = path.resolve(import.meta.dir, '../..');

function listSourceFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'test') continue;
      listSourceFiles(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
}

/** The only raw colour literals allowed in agent source, by file. */
const ALLOWED_HEX: Readonly<Record<string, readonly string[]>> = {
  // QR modules: fixed black-on-white so a camera can scan them.
  'renderer/theme.ts': ['#000000', '#ffffff'],
  // The protected splash gradient (byte-identical to the TUI's SPLASH_GRADIENT).
  'utils/splash-lines.ts': ['#00ffff', '#d000ff'],
};

const HEX_RE = /#[0-9a-fA-F]{8}(?![0-9a-fA-F])|#[0-9a-fA-F]{6}(?![0-9a-fA-F])|#[0-9a-fA-F]{3}(?![0-9a-fA-F])/g;
// A quoted ANSI-256 index assigned to a colour slot: `fg: '244'`, `bgColor = '240'`, `color: '196'`.
// NO_COLOR is the environment switch, not a colour.
const ANSI_INDEX_RE = /\b(?!NO_COLOR\b)(?:fg|bg|\w*(?:Fg|Bg|FG|BG|Color|COLOR))\s*[:=]\s*'\d{1,3}'/g;

describe('raw colours stay in the theme layer', () => {
  const files: string[] = [];
  listSourceFiles(SRC_ROOT, files);

  test('the scan sees the renderer', () => {
    expect(files.some((f) => f.endsWith(path.join('renderer', 'ui-factory.ts')))).toBe(true);
  });

  test('no hex colour literal outside the allowed files', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(SRC_ROOT, file).split(path.sep).join('/');
      const text = readFileSync(file, 'utf-8');
      const allowed = ALLOWED_HEX[rel] ?? [];
      for (const match of text.match(HEX_RE) ?? []) {
        if (!allowed.includes(match.toLowerCase())) offenders.push(`${rel}: ${match}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('no quoted ANSI-256 index used as a colour', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(SRC_ROOT, file).split(path.sep).join('/');
      const text = readFileSync(file, 'utf-8');
      for (const match of text.match(ANSI_INDEX_RE) ?? []) offenders.push(`${rel}: ${match}`);
    }
    expect(offenders).toEqual([]);
  });
});
