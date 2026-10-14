/** No credentials or ambiguous destinations in endpoint addresses. */
export function validEndpointURL(value: string): boolean {
  if (typeof value !== 'string' || /[\s\x00-\x1f\x7f?#\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

/** Recognize a resolved Jev version without selecting or pinning that version. */
export const isPinnedJudgmentModel = (model: string): boolean => /^jev-\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(model);

/** Aliases resolve at the endpoint; explicit model requests must still match exactly. */
export function matchesJudgmentModel(requested: string, actual: string): boolean {
  return actual === requested || ((requested === 'jev-latest' || requested === 'jev-preview') && isPinnedJudgmentModel(actual));
}
