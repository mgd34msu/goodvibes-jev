import { describe, expect, test } from 'bun:test';
import {
  asWireCostSource,
  costAmountLabel,
  formatPricingAsOf,
  manualPriceKey,
  priceSourceLabel,
  unpricedBlindSpotLabel,
} from './cost-source';

describe('manualPriceKey', () => {
  test('joins provider and model with a colon, null when either is missing', () => {
    expect(manualPriceKey('openrouter', 'deepseek/deepseek-chat')).toBe('openrouter:deepseek/deepseek-chat');
    expect(manualPriceKey(undefined, 'model')).toBeNull();
    expect(manualPriceKey('provider', undefined)).toBeNull();
  });
});

describe('asWireCostSource', () => {
  test('accepts the four wire sources, rejects everything else', () => {
    for (const s of ['user', 'provider', 'catalog', 'mixed'] as const) {
      expect(asWireCostSource(s)).toBe(s);
    }
    expect(asWireCostSource('none')).toBeUndefined();
    expect(asWireCostSource(null)).toBeUndefined();
    expect(asWireCostSource(undefined)).toBeUndefined();
    expect(asWireCostSource(42)).toBeUndefined();
  });
});

describe('formatPricingAsOf', () => {
  test('renders an ISO timestamp as a UTC calendar date', () => {
    expect(formatPricingAsOf('2026-07-01T00:00:00.000Z')).toBe('Jul 1, 2026');
    // A late-UTC-day timestamp still reports its own UTC date (no TZ drift).
    expect(formatPricingAsOf('2026-07-01T23:30:00.000Z')).toBe('Jul 1, 2026');
  });

  test('absent/empty -> null; an unparseable value passes through trimmed', () => {
    expect(formatPricingAsOf(undefined)).toBeNull();
    expect(formatPricingAsOf(null)).toBeNull();
    expect(formatPricingAsOf('   ')).toBeNull();
    expect(formatPricingAsOf('  whenever  ')).toBe('whenever');
  });
});

describe('priceSourceLabel', () => {
  test('each source gets a distinct label, and a served as-of date is appended', () => {
    const sources = ['user', 'catalog', 'provider', 'mixed'] as const;
    const plain = sources.map((source) => priceSourceLabel(source));
    expect(new Set(plain).size).toBe(sources.length);
    for (const source of sources) {
      expect(priceSourceLabel(source, '2026-07-01T00:00:00.000Z')).toContain(formatPricingAsOf('2026-07-01T00:00:00.000Z') ?? '');
    }
    expect(priceSourceLabel('catalog')).not.toContain('2026');
  });

  test('absent/unknown source -> null (the amount marker carries the honesty)', () => {
    expect(priceSourceLabel(null)).toBeNull();
    expect(priceSourceLabel(undefined)).toBeNull();
    expect(priceSourceLabel(undefined, '2026-07-01T00:00:00.000Z')).toBeNull();
  });
});

describe('costAmountLabel', () => {
  test('priced dollars render, sub-dollar with four decimals', () => {
    expect(costAmountLabel(1.5, 'priced')).toBe('$1.50');
    expect(costAmountLabel(0.0032, 'priced')).toBe('$0.0032');
  });

  test('estimated dollars carry the ~ prefix', () => {
    expect(costAmountLabel(2, 'estimated')).toBe('~$2.00');
  });

  test('unpriced is the explicit marker, never $0.00', () => {
    const unknown = costAmountLabel(null, 'unpriced');
    expect(unknown).not.toContain('$');
    expect(costAmountLabel(0.5, 'unpriced')).toBe(unknown);
    expect(costAmountLabel(null, 'priced')).toBe(unknown);
    expect(costAmountLabel(undefined, 'priced')).toBe(unknown);
  });
});

describe('unpricedBlindSpotLabel', () => {
  test('mixed aggregates state the floor', () => {
    const label = unpricedBlindSpotLabel(3, 1);
    expect(label).toContain('1');
    expect(label).toContain('4');
  });

  test('fully-unpriced aggregates say so', () => {
    const label = unpricedBlindSpotLabel(0, 5);
    expect(label).toContain('5');
    expect(label).not.toBe(unpricedBlindSpotLabel(4, 1));
  });

  test('no blind spot -> empty string', () => {
    expect(unpricedBlindSpotLabel(10, 0)).toBe('');
    expect(unpricedBlindSpotLabel(0, 0)).toBe('');
  });
});
