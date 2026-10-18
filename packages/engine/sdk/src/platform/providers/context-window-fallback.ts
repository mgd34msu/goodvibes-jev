/** Budget estimate for a model with no provider, catalog or configured limit. */
export const FALLBACK_CONTEXT_WINDOW = 128_000;

/** This estimate never establishes a model's actual endpoint ceiling. */
export function knownFallbackContextWindow(_provider: string, _modelId: string): number {
  return FALLBACK_CONTEXT_WINDOW;
}

/** Async compatibility entrypoint; no model-family inference or network request. */
export async function readFallbackContextWindow(_provider: string, _modelId: string, _site: string): Promise<number> {
  return FALLBACK_CONTEXT_WINDOW;
}
