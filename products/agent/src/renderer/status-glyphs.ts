// ---------------------------------------------------------------------------
// status-glyphs.ts, canonical glyph map for status states.
//
// STATE_GLYPHS is no longer hardcoded here. It is the SDK presentation
// contract (@goodvibes-jev/engine/sdk/platform/presentation),
// aliased to GLYPHS.status so the four semantic glyphs are spelled out in
// exactly one place and can never drift from the registry again. Re-exported
// under the historical names so status-token.ts and polish.ts import unchanged.
//
// Glyphs (the reconciled TUI-reference definitions):
//   good  ✓  (CHECK MARK U+2713)    , GLYPHS.status.success
//   warn  ⚠  (WARNING SIGN U+26A0)   , GLYPHS.status.warn
//   bad   ✕  (MULTIPLICATION X U+2715), GLYPHS.status.failure
//   info  ○  (WHITE CIRCLE U+25CB)   , GLYPHS.status.info
// ---------------------------------------------------------------------------

export { STATE_GLYPHS, type StatusState } from '@goodvibes-jev/engine/sdk/platform/presentation';
