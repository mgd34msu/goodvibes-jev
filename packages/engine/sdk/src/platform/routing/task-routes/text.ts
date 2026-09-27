/**
 * Fixed text formats the route planner prints: the request preview and the
 * quoted query inside a route string. Ported exactly from the agent's
 * previewHarnessText and quote; these are formats, never judged.
 */

export const PREVIEW_LIMIT = 56;

/** Collapses whitespace and cuts to `maxLength`, ending a cut with "...". */
export function previewText(value: string, maxLength = PREVIEW_LIMIT): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

/** The request as a JSON string literal for a route string, previewed to `limit`. */
export function quote(value: string, limit = 96): string {
  return JSON.stringify(previewText(value, limit));
}
