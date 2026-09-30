/** No credentials or ambiguous destinations in endpoint addresses. */
export function validEndpointURL(value: string): boolean {
  if (typeof value !== 'string' || /[\s\x00-\x1f\x7f?#\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

/** Failover pins the known System One version format; moving aliases cannot preserve calibration. */
export const isPinnedJudgmentModel = (model: string): boolean => /^jev-\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(model);
