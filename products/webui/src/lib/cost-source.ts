/**
 * cost-source.ts, honest price provenance for cost displays, read straight
 * from the wire.
 *
 * What the daemon now serves (verified against the SDK snapshot's operator
 * contract):
 *   - cost.attribution.get rows AND its aggregate carry `costSource`
 *     ('user' | 'provider' | 'catalog' | 'mixed', or absent) plus a dated
 *     `pricingAsOf`, the daemon's own pricing resolver stamps every priced
 *     figure with whose price produced it and, where meaningful, the date that
 *     price was captured.
 *   - fleet snapshot/list nodes and attempts rows carry the same optional
 *     `costSource` / `pricingAsOf` pair.
 *   - providers.usage.get carries per-model `pricing.source`/`pricing.asOf`
 *     plus a snapshot-level `pricingSource`/`pricingAsOf`.
 *
 * The webui no longer DERIVES provenance client-side (the earlier round read
 * the live config's manual-price table to infer "your price", and consulted
 * providers.usage.get's provider-level source for the rest, and, lacking any
 * dated field on the wire, deliberately rendered no as-of date rather than
 * fabricate one). All of that is gone: the source and the date are facts on
 * the record, so these helpers only format them. Unknown/absent provenance is
 * still rendered honestly, the amount says "price unknown", the note claims
 * no source at all, never an invented label or a $0.00.
 */

/** The pricing provenance a priced figure carries on the wire. */
export type WireCostSource = 'user' | 'provider' | 'catalog' | 'mixed';

/** Build the manual-price table key for a node/row's provider+model, when both are known. */
export function manualPriceKey(provider: string | undefined, model: string | undefined): string | null {
  if (!provider || !model) return null;
  return `${provider}:${model}`;
}

/** Narrow an unknown wire value to a WireCostSource, or undefined when it is absent/unrecognized. */
export function asWireCostSource(value: unknown): WireCostSource | undefined {
  return value === 'user' || value === 'provider' || value === 'catalog' || value === 'mixed' ? value : undefined;
}

/**
 * Format a wire `pricingAsOf` for display. The wire serves an ISO timestamp;
 * this renders the calendar date in UTC (deterministic, no locale/timezone
 * drift) as e.g. "Jul 1, 2026". A value that will not parse is passed through
 * trimmed rather than dropped, an honest date the client can't format is
 * still more truthful than silence. Empty/absent → null.
 */
export function formatPricingAsOf(pricingAsOf: string | null | undefined): string | null {
  if (typeof pricingAsOf !== 'string' || pricingAsOf.trim() === '') return null;
  const parsed = new Date(pricingAsOf);
  if (Number.isNaN(parsed.getTime())) return pricingAsOf.trim();
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(parsed);
}

/**
 * The price-source label for a priced display, straight from the wire's
 * `costSource` and `pricingAsOf`:
 *   - 'user'     → "your price" (the operator's own manual entry won the resolver)
 *   - 'catalog'  → "catalog price"
 *   - 'provider' → "provider-served price"
 *   - 'mixed'    → "mixed pricing sources" (an aggregate spanning more than one tier)
 * The as-of date is appended (", as of <date>") whenever the wire serves one.
 * Absent/unrecognized source → null (the amount's own "price unknown" marker
 * carries the honesty; the note claims nothing).
 */
export function priceSourceLabel(
  costSource: WireCostSource | null | undefined,
  pricingAsOf?: string | null,
): string | null {
  const source = asWireCostSource(costSource);
  if (!source) return null;
  const base =
    source === 'user'
      ? 'your price'
      : source === 'catalog'
        ? 'catalog price'
        : source === 'provider'
          ? 'provider-served price'
          : 'mixed pricing sources';
  const asOf = formatPricingAsOf(pricingAsOf);
  return asOf ? `${base}, as of ${asOf}` : base;
}

/**
 * Dollar amount rendering shared by cost displays: real dollars where priced,
 * the explicit "price unknown" marker where not, never $0.00 for unpriced.
 */
export function costAmountLabel(costUsd: number | null | undefined, costState: string): string {
  if (costState === 'unpriced' || costUsd == null) {
    return costState === 'estimated' && costUsd != null ? `~$${formatUsd(costUsd)}` : 'price unknown';
  }
  const amount = `$${formatUsd(costUsd)}`;
  return costState === 'estimated' ? `~${amount}` : amount;
}

function formatUsd(costUsd: number): string {
  return costUsd.toFixed(costUsd < 1 ? 4 : 2);
}

/**
 * The unpriced blind spot of an aggregate, stated plainly: how many records
 * contributed no dollars, so a shown total reads as a floor, not the truth.
 * Empty string when there is no blind spot.
 */
export function unpricedBlindSpotLabel(pricedRecordCount: number, unpricedRecordCount: number): string {
  if (!Number.isFinite(unpricedRecordCount) || unpricedRecordCount <= 0) return '';
  const total = unpricedRecordCount + (Number.isFinite(pricedRecordCount) ? Math.max(0, pricedRecordCount) : 0);
  if (pricedRecordCount > 0) {
    return `${unpricedRecordCount} of ${total} records unpriced: dollars shown are a floor`;
  }
  return `all ${unpricedRecordCount} records unpriced`;
}
