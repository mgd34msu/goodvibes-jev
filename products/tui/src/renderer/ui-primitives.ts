// ---------------------------------------------------------------------------
// ui-primitives.ts, glyph registry + spinner frames.
//
// GLYPHS and SPINNER_FRAMES are the SDK presentation contract
// (@goodvibes-jev/engine/sdk/platform/presentation), shared with the agent.
//
// Colours no longer live here: the static dark UI_TONES / DIFF_TONES tables
// were retired when the TUI adopted the SDK theme engine. Every colour is read
// from the active theme in theme.ts (activeTokens / activeUiTones /
// activeDiffTones / activeTheme).
// ---------------------------------------------------------------------------

import {
  GLYPHS,
  SPINNER_FRAMES,
} from '@goodvibes-jev/engine/sdk/platform/presentation';

export { GLYPHS, SPINNER_FRAMES };
