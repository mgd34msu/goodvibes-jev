import type { ConfigGet } from './alert-gating.js';

/** Host-owned presentation preference; this reader does not install its schema. */
export const TREE_GLYPHS_CONFIG_KEY = 'display.treeGlyphs';

/** Closed set understood by the terminal work-tree renderer. */
export type TreeGlyphSetName = 'rounded' | 'square' | 'ascii';

/**
 * Read the work-tree style live. Unknown, unavailable or malformed values use
 * rounded, the upstream presentation default. A terminal that cannot draw
 * Unicode always uses ASCII; probing that capability stays with the host.
 *
 * Async getters are not awaited or accepted. Their rejection is consumed so
 * an accidental async reader cannot leak a private error or kill the host.
 * This adds no ConfigKey, persisted default, validation or write permission.
 */
export function readTreeGlyphSet(configGet: ConfigGet, unicodeCapable: boolean): TreeGlyphSetName {
  let configured: unknown;
  try {
    configured = configGet(TREE_GLYPHS_CONFIG_KEY);
    discardAsyncReadValue(configured);
  } catch (error) {
    discardAsyncReadValue(error);
    // A malformed or older config reader does not prevent rendering.
  }
  if (!unicodeCapable) return 'ascii';
  return configured === 'rounded' || configured === 'square' || configured === 'ascii' ? configured : 'rounded';
}

/** Consume only asynchronous malformed values; never log or retain their failures. */
function discardAsyncReadValue(value: unknown): void {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    void new Promise<unknown>((resolve) => resolve(value)).then(() => undefined, () => undefined);
  }
}
