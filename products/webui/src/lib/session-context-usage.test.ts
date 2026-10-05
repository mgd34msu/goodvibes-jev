import { describe, expect, test } from 'bun:test';
import type { OperatorMethodOutput } from './goodvibes';
import { formatSessionContextUsage } from './session-context-usage';

type Usage = OperatorMethodOutput<'sessions.contextUsage.get'>;
const known: Usage = { sessionId: 'local', estimatedContextTokens: 1000, contextWindow: 10000,
  contextUsagePct: 10, contextRemainingTokens: 9000, estimated: true };
const unknown: Usage = { ...known, contextWindow: null, contextUsagePct: null, contextRemainingTokens: null };

describe('session context usage provenance', () => {
  test('keeps the legacy compact estimate without inventing provenance', () => {
    expect(formatSessionContextUsage(known)).toBe('~10% (1,000 of 10,000 tokens, estimated)');
    expect(formatSessionContextUsage(unknown)).toBe('1,000 tokens estimated; context window unknown');
  });

  for (const [source, label] of [
    ['provider_api', 'provider API'], ['configured_cap', 'configured cap'],
    ['observed_limit', 'learned from a provider rejection'], ['catalog', 'model catalog'],
    ['registry', 'model registry'], ['openrouter', 'OpenRouter'],
  ] as const) {
    test(`labels typed ${source} source`, () => {
      expect(formatSessionContextUsage({ ...known, contextWindowSource: source })).toBe(
        `~10% (1,000 of 10,000 tokens, estimated); source: ${label}`,
      );
    });
  }

  for (const [origin, label] of [
    [{ kind: 'user_override' }, 'user override'],
    [{ kind: 'provider_file' }, 'provider file'],
    [{ kind: 'catalog', catalogProviderId: 'synthetic-provider' }, 'catalog: synthetic-provider'],
    [{ kind: 'consensus', providers: 4, agreeing: 3 }, 'estimate from 4 providers (3 agree)'],
    [{ kind: 'consensus', providers: 4, agreeing: 4 }, 'estimate from 4 providers'],
    [{ kind: 'consensus', providers: 1, agreeing: 1 }, 'estimate from 1 provider'],
    [{ kind: 'family_default' }, 'family default (estimate)'],
  ] as const) {
    test(`discloses ${label} origin without claiming endpoint capability`, () => {
      expect(formatSessionContextUsage({ ...unknown, contextWindowOrigin: origin })).toBe(
        `1,000 tokens estimated; context window unknown; source: ${label}`,
      );
    });
  }

  for (const usage of [unknown, known]) {
    test(`accepted floor is a lower bound even with ${usage.contextWindow === null ? 'null' : 'legacy numeric'} window`, () => {
      const text = formatSessionContextUsage({ ...usage, contextWindowSource: 'accepted_floor', contextWindowAcceptedFloor: 12000 });
      expect(text).toContain('1,000 tokens estimated; context window unknown');
      expect(text).toContain('source: provider accepted a larger request than the stated window');
      expect(text).toContain('provider accepted at least 12,000 tokens (lower bound, not capacity)');
      expect(text).not.toContain('%');
      expect(text).not.toContain(' of ');
    });
  }

  test('a catalog budget can retain distinct accepted-floor evidence', () => {
    const text = formatSessionContextUsage({ ...known, contextWindowSource: 'catalog',
      contextWindowOrigin: { kind: 'catalog', catalogProviderId: 'synthetic-provider' }, contextWindowAcceptedFloor: 8000 });
    expect(text).toContain('~10% (1,000 of 10,000 tokens, estimated)');
    expect(text).toContain('model catalog · catalog: synthetic-provider');
    expect(text).toContain('provider accepted at least 8,000 tokens (lower bound, not capacity)');
  });

  test('unknown window ignores any stale percentage', () => {
    const text = formatSessionContextUsage({ ...unknown, contextUsagePct: 10 });
    expect(text).not.toContain('%');
    expect(text).not.toContain(' of ');
  });

  test('invalid legacy numbers never render NaN or an invented denominator', () => {
    const text = formatSessionContextUsage({ ...known, estimatedContextTokens: NaN, contextWindow: Infinity,
      contextUsagePct: NaN, contextWindowAcceptedFloor: -1 });
    expect(text).toBe('Unknown tokens estimated; context window unknown');
  });
});


for (const provenance of [
  { contextWindowSource: 'fallback' },
  { contextWindowSource: 'catalog', contextWindowOrigin: { kind: 'consensus', providers: 4, agreeing: 3 } },
  { contextWindowSource: 'fallback', contextWindowOrigin: { kind: 'family_default' } },
] as const) {
  test(`${JSON.stringify(provenance)} never turns an older numeric estimate into capacity`, () => {
    const text = formatSessionContextUsage({ ...known, ...provenance });
    expect(text).toContain('1,000 tokens estimated; context window unknown');
    expect(text).not.toContain('%');
    expect(text).not.toContain(' of ');
  });
}
