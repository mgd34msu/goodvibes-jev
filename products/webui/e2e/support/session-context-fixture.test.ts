import { describe, expect, test } from 'bun:test';
import { loadSessionContextCapture } from './session-context-fixture';

describe('real session context HTTP captures', () => {
  test('all success bytes match the generated nullable contract; unavailable scope is a refusal', () => {
    const capture = loadSessionContextCapture();
    expect(capture.source).toBe('packages/engine/test/session-context-usage-http.test.ts');
    expect(Object.keys(capture.scenarios).sort()).toEqual([
      'accepted_floor', 'catalog', 'configured_cap', 'consensus', 'fallback', 'hosted_refusal', 'no_model', 'observed_limit', 'provider_api',
    ]);
    for (const scenario of ['accepted_floor', 'consensus', 'fallback', 'no_model'] as const) {
      expect(JSON.parse(capture.scenarios[scenario].body)).toMatchObject({
        contextWindow: null, contextUsagePct: null, contextRemainingTokens: null, estimated: true,
      });
    }
    expect(JSON.parse(capture.scenarios.accepted_floor.body).contextWindowAcceptedFloor).toBeGreaterThan(0);
    expect(capture.scenarios.hosted_refusal.status).toBe(404);
  });
});
