/**
 * generate-presentation-tokens.test.ts: a change in the SDK presentation
 * contract (a glyph, a tone color) reaches both emitted artifacts, the TS artifact
 * is a valid module whose exports are the snapshot (proven by importing what was
 * rendered), and the artifacts are written only when their content changes. The
 * artifacts themselves are regenerated at the version bump
 * (scripts/release-prepare.ts), so nothing here compares them with the checked-in
 * files.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './helpers/project-temp';
import {
  loadContractSnapshot,
  renderCss,
  renderTs,
  writeIfChanged,
  type PresentationContractSnapshot,
} from './generate-presentation-tokens';

function withSuccessGlyph(snapshot: PresentationContractSnapshot, glyph: string): PresentationContractSnapshot {
  return {
    ...snapshot,
    glyphs: { ...snapshot.glyphs, status: { ...snapshot.glyphs.status, success: glyph } },
  };
}

function withGoodTone(snapshot: PresentationContractSnapshot, color: string): PresentationContractSnapshot {
  return {
    ...snapshot,
    toneDark: { ...snapshot.toneDark, state: { ...snapshot.toneDark.state, good: color } },
  };
}

describe('generate-presentation-tokens', () => {
  test('a changed status glyph reaches both the CSS and the TS artifact', () => {
    const base = loadContractSnapshot();
    const changed = withSuccessGlyph(base, '☺');
    expect(renderCss(base)).not.toContain('☺');
    expect(renderCss(changed)).toContain('☺');
    expect(renderTs(changed)).toContain('☺');
  });

  test('a changed tone color reaches the CSS artifact', () => {
    const changed = withGoodTone(loadContractSnapshot(), '#123456');
    expect(renderCss(changed)).toContain('#123456');
  });

  test('the emitted TS module is valid and its exports equal the snapshot it was rendered from', async () => {
    const snapshot = withGoodTone(withSuccessGlyph(loadContractSnapshot(), '☺'), '#123456');
    const dir = makeProjectTempDir('webui-gen-presentation-roundtrip-');
    try {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, 'presentation-tokens.ts');
      writeFileSync(path, renderTs(snapshot), 'utf8');
      const emitted = await import(path) as Record<string, unknown>;
      expect(emitted.CONTRACT_GLYPHS).toEqual(snapshot.glyphs);
      expect(emitted.CONTRACT_STATE_GLYPHS).toEqual(snapshot.stateGlyphs);
      expect(emitted.CONTRACT_TONE_DARK).toEqual(snapshot.toneDark);
      expect(emitted.CONTRACT_TONE_LIGHT).toEqual(snapshot.toneLight);
      expect(emitted.CONTRACT_SPINNER_FRAMES).toEqual(snapshot.spinnerFrames);
      expect(emitted.CONTRACT_THINKING_PHRASES).toEqual(snapshot.thinkingPhrases);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('writeIfChanged writes new content and reports identical content as unchanged', () => {
    const dir = makeProjectTempDir('webui-gen-presentation-');
    try {
      const path = join(dir, 'nested', 'tokens.css');
      expect(writeIfChanged(path, 'a {}')).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe('a {}');
      expect(writeIfChanged(path, 'a {}')).toBe(false);
      expect(writeIfChanged(path, 'b {}')).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe('b {}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
