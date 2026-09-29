/**
 * Context window for a model nobody has sized.
 *
 * Used only when neither the live catalog (models.dev), OpenRouter nor the
 * provider API reports a context window for a model, e.g. a model newer than
 * the models.dev snapshot. A single flat default badly mis-sizes the window
 * and drives auto-compaction to fire far too early (small default) or too
 * late (large default, risking a provider "context length exceeded" error).
 *
 * The rows below are each family's documented window and stay code. Which
 * row a model belongs to, through gateway paths, region prefixes and version
 * suffixes, is read by routing.context-window-family
 * (routing/batteries/model-limits.ts) and remembered per provider and id; the
 * provider-name substrings and id prefixes it replaces are gone.
 *
 * The real window always wins whenever the catalog, OpenRouter or the
 * provider supplies one; this is the last line of defense, not a primary
 * source.
 */
import { knownContextWindowFamily, readContextWindowFamily } from '../routing/model-limit-readings.js';
import type { ContextWindowFamily } from '../routing/batteries/model-limits.js';

/**
 * The window of a model with no documented row, and of every model until its
 * row has been read. Over-estimating is the dangerous direction (it risks
 * context-overflow errors), so this is the conservative size.
 */
export const FALLBACK_CONTEXT_WINDOW = 128_000;

/**
 * Each family's documented window. Where a family's members differ, the row
 * holds the smallest, since over-estimating is the dangerous direction.
 */
const FAMILY_CONTEXT_WINDOWS: Readonly<Record<ContextWindowFamily, number>> = {
  // ai.google.dev/gemini-api/docs/models: Gemini 1.5 Flash, 2.x, 2.5 and 3
  // take 1,048,576 input tokens; 1.5 Pro takes 2M.
  gemini: 1_000_000,
  // platform.claude.com/docs/en/about-claude/models/overview: 200K is the
  // standard window of every current and legacy Claude from 3 on (1M only
  // behind a beta header on some models).
  claude: 200_000,
  // docs.x.ai/docs/models: grok-4 has a 256,000-token window; grok-4-fast
  // and later variants document 2M.
  'grok-4': 256_000,
  // platform.openai.com/docs/models: gpt-5 has a 400,000-token window;
  // gpt-4.1 documents 1,047,576.
  'gpt-5-or-4-1': 400_000,
  // platform.openai.com/docs/models: o1, o3 and o4-mini have 200,000-token windows.
  'openai-o-series': 200_000,
};

/**
 * The window of a model the catalog, OpenRouter and the provider leave
 * unsized: its family's row once routing.context-window-family has read the
 * id, else {@link FALLBACK_CONTEXT_WINDOW} (not read yet, no documented
 * family, or a reading too weak to act on).
 */
export function knownFallbackContextWindow(provider: string, modelId: string): number {
  const family = knownContextWindowFamily(provider, modelId);
  return family ? FAMILY_CONTEXT_WINDOWS[family] : FALLBACK_CONTEXT_WINDOW;
}

/** Reads the model's context-window family when it has not been read, then returns its window. */
export async function readFallbackContextWindow(provider: string, modelId: string, site: string): Promise<number> {
  const family = await readContextWindowFamily(provider, modelId, site);
  return family ? FAMILY_CONTEXT_WINDOWS[family] : FALLBACK_CONTEXT_WINDOW;
}
