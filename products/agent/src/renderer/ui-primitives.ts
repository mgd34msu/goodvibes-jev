// ---------------------------------------------------------------------------
// ui-primitives.ts, glyph registry + spinner frames.
//
// GLYPHS and SPINNER_FRAMES are the SDK presentation contract
// (@goodvibes-jev/engine/sdk/platform/presentation), shared with the TUI so both
// surfaces use ONE source. See
// docs/decisions/2026-07-05-presentation-contract-sdk-extraction.md in the SDK.
//
// Colours no longer live here: the static dark UI_TONES / DIFF_TONES tables
// were retired when the agent adopted the SDK theme engine. Every colour is
// read from the active theme in theme.ts (activeTokens / activeUiTones /
// activeDiffTones / activeTheme).
//
// Visible glyph convergence (deliberate, per S1's divergence ruling): the
// agent's status glyphs adopt the TUI reference, idle ○ (U+25CB) -> ◌ (U+25CC),
// info • (U+2022) -> ○ (U+25CB), and a new warn ⚠ key. Called out here so the
// render-time change is not mistaken for a regression.
// ---------------------------------------------------------------------------

import {
  GLYPHS,
  SPINNER_FRAMES,
} from '@goodvibes-jev/engine/sdk/platform/presentation';

export { GLYPHS, SPINNER_FRAMES };

/** The glyph registry shape, preserved for existing type references. */
export type UiGlyphRegistry = typeof GLYPHS;
