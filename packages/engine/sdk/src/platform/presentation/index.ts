/**
 * Shared glyphs, semantic status aliases, theme tokens, spinner frames,
 * thinking phrases, and waiting-state wording used by the TUI and Agent.
 * Rendering stays product-owned; these exports provide pure values and functions.
 * See docs/decisions/2026-07-05-presentation-contract-sdk-extraction.md
 * for the status-glyph choices and extraction history.
 */

export { GLYPHS, STATE_GLYPHS, type StatusState } from './glyphs.js';

export {
  TONE_TOKENS,
  resolveTones,
  DIFF_TONES,
  SPINNER_FRAMES,
  type ThemeMode,
  type ToneTokens,
} from './tones.js';

export { THINKING_PHRASES } from './thinking-phrases.js';

export {
  waitingPhrase,
  type WaitingState,
  type WaitingPhraseContext,
} from './waiting-wording.js';

// The theme system (bundled themes, `system` theme, resolver, legacy bridge).
export * from './theme/index.js';
