/** User- or registration-supplied rates, USD per 1M tokens. */
export interface ManualModelPrice {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number | undefined;
  readonly cacheWrite?: number | undefined;
}

export function validManualModelPrice(value: unknown): value is ManualModelPrice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  const rate = (key: string, required: boolean): boolean => {
    const v = rec[key];
    if (v === undefined) return !required;
    return typeof v === 'number' && Number.isFinite(v) && v >= 0;
  };
  return rate('input', true) && rate('output', true) && rate('cacheRead', false) && rate('cacheWrite', false);
}

/** Validate the whole `pricing.modelPrices` config value (record keyed `provider:model`). */
export function validateManualModelPrices(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([key, price]) => key.includes(':') && validManualModelPrice(price),
  );
}
