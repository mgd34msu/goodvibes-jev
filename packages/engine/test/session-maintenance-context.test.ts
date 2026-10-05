import { describe, expect, test } from 'bun:test';
import { DEFAULT_CONFIG } from '../sdk/src/platform/config/schema.js';
import type { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { evaluateSessionMaintenance, formatSessionMaintenanceLines } from '../sdk/src/platform/runtime/session-maintenance.js';

const configManager = { get(key: string) {
  return ({ 'behavior.guidanceMode': 'minimal', 'behavior.compactionStrategy': 'auto',
    'behavior.autoCompactThreshold': DEFAULT_CONFIG.behavior.autoCompactThreshold, 'behavior.staleContextWarnings': true } as Record<string, unknown>)[key];
} } as Pick<ConfigManager, 'get'>;

describe('session maintenance nullable capacity', () => {
  test.each([null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])('unknown capacity %s cannot recommend compaction', contextWindow => {
    const status = evaluateSessionMaintenance({ configManager, currentTokens: 190_000, contextWindow, messageCount: 40 });
    expect(status).toMatchObject({ level: 'unknown', usagePct: null, remainingTokens: null, compactRecommended: false });
    expect(formatSessionMaintenanceLines(status).join(' ')).toContain('Context window unavailable');
    expect(formatSessionMaintenanceLines(status).join(' ')).not.toContain('%');
  });
  test('a known ceiling retains its threshold and remaining-token behavior', () => {
    expect(evaluateSessionMaintenance({ configManager, currentTokens: 190_000, contextWindow: 200_000 }))
      .toMatchObject({ level: 'suggest-compact', usagePct: 95, remainingTokens: 10_000, compactRecommended: true });
    expect(evaluateSessionMaintenance({ configManager, currentTokens: 20_000, contextWindow: 200_000 }))
      .toMatchObject({ level: 'stable', usagePct: 10, remainingTokens: 180_000, compactRecommended: false });
  });
});
