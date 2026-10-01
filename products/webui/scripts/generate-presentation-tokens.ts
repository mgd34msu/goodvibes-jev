#!/usr/bin/env bun
/**
 * generate-presentation-tokens.ts
 *
 * Bridges the SDK presentation contract (@goodvibes-jev/engine/sdk/platform/presentation
 *, the status-glyph registry, tone-token table, thinking-phrase pool and
 * waiting-state wording that the TUI and agent already render through) onto
 * two generated, checked-in artifacts:
 *
 *   - src/lib/generated/presentation-tokens.ts    , a typed TS mirror: a
 *     literal snapshot of the contract's data tables, consumed by
 *     src/lib/presentation-bridge.ts (the hand-written semantic mapping onto
 *     web UI components) and any other code that wants the raw contract shape.
 *   - src/styles/generated/presentation-tokens.css, CSS custom properties:
 *     glyph characters as quoted `content` strings (`--contract-glyph-*`) and
 *     the state tone-color table per theme mode (`--contract-state-*`).
 *
 * This file only SNAPSHOTS data (GLYPHS, STATE_GLYPHS, TONE_TOKENS,
 * SPINNER_FRAMES, THINKING_PHRASES), genuinely-duplicable tables per the
 * presentation contract's own docstring. `waitingPhrase` is a pure function,
 * not a data table; it has no meaningful "generated" form (a text diff of a
 * re-export wouldn't catch a behavior change), so src/lib/presentation-bridge.ts
 * imports it directly from the SDK package instead of going through here.
 *
 * Regenerate with `bun run release:prepare`; `bun run generated:check`
 * verifies these snapshots against the workspace engine before every build.
 *
 * Usage:
 *   bun run scripts/generate-presentation-tokens.ts          # write/update
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GLYPHS,
  STATE_GLYPHS,
  TONE_TOKENS,
  resolveTones,
  SPINNER_FRAMES,
  THINKING_PHRASES,
} from '@goodvibes-jev/engine/sdk/platform/presentation';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

export const CSS_OUT_PATH = resolve(ROOT, 'src/styles/generated/presentation-tokens.css');
export const TS_OUT_PATH = resolve(ROOT, 'src/lib/generated/presentation-tokens.ts');

// ---------------------------------------------------------------------------
// Snapshot, the exact shape the render functions need. Pulled into its own
// type (rather than importing package types inline everywhere) so a test can
// hand renderCss/renderTs a mutated fixture snapshot without needing to fake
// the npm package itself.
// ---------------------------------------------------------------------------

/**
 * Keep the SDK contract's STRUCTURE (every key, nesting, and array-ness) while
 * widening its leaf VALUES from the exact literals the package declares
 * (`'✓'`, `'#22c55e'`, …) to plain string/number/boolean.
 *
 * The renderers below only ever read these leaves as strings, and the drift half of
 * the test suite has to build a snapshot whose glyph or tone color DIFFERS from the
 * installed one, that is the whole point of a drift gate. With the literal types in
 * place that mutated snapshot was not constructible, so the drift test could only
 * ever have been written against the exact value it was trying to change.
 * Structure is still pinned: a renamed or removed contract key is still an error here.
 */
type WidenLiterals<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends readonly (infer U)[]
        ? readonly WidenLiterals<U>[]
        : { readonly [K in keyof T]: WidenLiterals<T[K]> };

export interface PresentationContractSnapshot {
  readonly glyphs: WidenLiterals<typeof GLYPHS>;
  readonly stateGlyphs: WidenLiterals<typeof STATE_GLYPHS>;
  readonly toneDark: WidenLiterals<typeof TONE_TOKENS>;
  readonly toneLight: WidenLiterals<ReturnType<typeof resolveTones>>;
  readonly spinnerFrames: WidenLiterals<typeof SPINNER_FRAMES>;
  readonly thinkingPhrases: WidenLiterals<typeof THINKING_PHRASES>;
}

/** Read the real contract from the installed @pellux/goodvibes-sdk. */
export function loadContractSnapshot(): PresentationContractSnapshot {
  return {
    glyphs: GLYPHS,
    stateGlyphs: STATE_GLYPHS,
    toneDark: TONE_TOKENS,
    toneLight: resolveTones('light'),
    spinnerFrames: SPINNER_FRAMES,
    thinkingPhrases: THINKING_PHRASES,
  };
}

// ---------------------------------------------------------------------------
// Rendering, pure functions, no fs access, deterministic for a given input.
// ---------------------------------------------------------------------------

/** camelCase -> kebab-case for CSS custom-property names (gradientStart -> gradient-start). */
function cssIdent(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function cssStringLiteral(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const GENERATED_BANNER = [
  'GENERATED FILE. DO NOT EDIT BY HAND.',
  'Produced by scripts/generate-presentation-tokens.ts from',
  '@goodvibes-jev/engine/sdk/platform/presentation, the presentation contract',
  'the TUI and agent already render through. See that package\'s own',
  'docstring for the parity-audit provenance.',
  '',
  'This is a layer SEPARATE from src/styles/tokens.css: tokens.css owns the',
  'web UI\'s own brand palette / layout / motion tokens (an explicitly',
  'webui-only, NOT-contract layer, documented at its own top); this file',
  'owns only the values the SDK contract actually defines: status glyphs',
  'and the state tone-color table.',
  '',
  'Regenerate: `bun run presentation:generate`.',
  '`bun run generated:check` verifies it before every build.',
].join('\n * ');

/** Strip trailing whitespace introduced by joining banner lines around blanks. */
function stripTrailingWhitespace(text: string): string {
  return text.replace(/[ \t]+$/gm, '');
}

export function renderCss(snapshot: PresentationContractSnapshot): string {
  const lines: string[] = [];
  lines.push(`/*\n * ${GENERATED_BANNER}\n */`);
  lines.push('');
  lines.push(':root {');
  lines.push('  /* Status glyphs: GLYPHS.status, quoted for `content:` use. All 16 keys are');
  lines.push('   * emitted for parity with the TS mirror (one snapshot, not a hand-picked');
  lines.push('   * subset) even though only 4 (success/warn/failure/info, the good/warn/bad/');
  lines.push('   * info bucket STATE_GLYPHS aliases) have a real `var()` consumer today: see');
  lines.push('   * `.badge[data-contract-state]::before` in src/styles.css (FleetView.tsx /');
  lines.push('   * WorkstreamView.tsx StateBadge). The other 12 (pending/active/idle/blocked/');
  lines.push('   * skipped/review/retry/handoff/reference/partial/dualPane/star) have no');
  lines.push('   * consumer YET. Kept checked-in so a future component reaching for a more');
  lines.push('   * specific glyph than the 4-bucket alias affords never has to regenerate first. */');
  for (const [key, value] of Object.entries(snapshot.glyphs.status)) {
    lines.push(`  --contract-glyph-${cssIdent(key)}: ${cssStringLiteral(value)};`);
  }
  lines.push('');
  lines.push('  /* State tone colors: TONE_TOKENS.state (dark / default). Consumed by the same');
  lines.push('   * `.badge[data-contract-state]::before` rule (src/styles.css), deliberately only');
  lines.push('   * for the glyph\'s own tint, never the badge\'s overall background/text color: this');
  lines.push('   * web UI\'s own palette (tokens.css) is NOT repainted onto the contract\'s colors');
  lines.push('   * (see presentation-bridge.ts\'s header for why: glyphs, not colors, are the');
  lines.push('   * cross-surface parity mechanism). */');
  for (const [key, value] of Object.entries(snapshot.toneDark.state)) {
    lines.push(`  --contract-state-${cssIdent(key)}: ${value};`);
  }
  lines.push('}');
  lines.push('');
  lines.push('/* State tone colors: light-mode override (resolveTones(\'light\')). */');
  lines.push(':root[data-theme="light"] {');
  for (const [key, value] of Object.entries(snapshot.toneLight.state)) {
    lines.push(`  --contract-state-${cssIdent(key)}: ${value};`);
  }
  lines.push('}');
  lines.push('');
  return stripTrailingWhitespace(lines.join('\n'));
}

export function renderTs(snapshot: PresentationContractSnapshot): string {
  const json = (value: unknown): string => JSON.stringify(value, null, 2);
  const text = [
    `/**\n * ${GENERATED_BANNER}\n *\n * Import from src/lib/presentation-bridge.ts for the semantic mapping\n * onto web UI components; import from here directly only if you need the\n * raw contract shape.\n */`,
    '',
    `export const CONTRACT_GLYPHS = ${json(snapshot.glyphs)} as const;`,
    '',
    `export const CONTRACT_STATE_GLYPHS = ${json(snapshot.stateGlyphs)} as const;`,
    '',
    `export const CONTRACT_TONE_DARK = ${json(snapshot.toneDark)} as const;`,
    '',
    `export const CONTRACT_TONE_LIGHT = ${json(snapshot.toneLight)} as const;`,
    '',
    `export const CONTRACT_SPINNER_FRAMES = ${json(snapshot.spinnerFrames)} as const;`,
    '',
    `export const CONTRACT_THINKING_PHRASES = ${json(snapshot.thinkingPhrases)} as const;`,
    '',
    '/** The four contract severity buckets STATE_GLYPHS aliases onto. */',
    'export type ContractStatusState = keyof typeof CONTRACT_STATE_GLYPHS;',
    '',
  ].join('\n');
  return stripTrailingWhitespace(text);
}

// ---------------------------------------------------------------------------
// CLI, regenerate the two checked-in artifact paths.
// ---------------------------------------------------------------------------

export function writeIfChanged(path: string, content: string): boolean {
  let current: string | null;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    current = null;
  }
  if (current === content) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  console.log(`[presentation:generate] wrote: ${path}`);
  return true;
}

if (import.meta.main) {
  const snapshot = loadContractSnapshot();
  let written = false;
  written = writeIfChanged(CSS_OUT_PATH, renderCss(snapshot)) || written;
  written = writeIfChanged(TS_OUT_PATH, renderTs(snapshot)) || written;
  if (!written) console.log('[presentation:generate] up-to-date');
}
