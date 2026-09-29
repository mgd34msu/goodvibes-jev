import { describe, expect, test } from 'bun:test';
import { useFailureReadings } from './_helpers/failure-readings.ts';

/**
 * Error normalize/summarize redaction smoke, verifies that the
 * normalizeError and summarizeError pipeline handles errors without leaking
 * sensitive tokens in output. Tests use companion/pairing-style error messages.
 *
 * NOTE: This file does NOT test pairing.request / pairing.verify flows.
 * COVERAGE.md has been updated to reflect the actual scope.
 */
describe('normalize/summarize redaction smoke', () => {
  useFailureReadings([['companion pairing handshake', { category: 'timeout', connection: 'timed_out', transientNetwork: true }]]);

  test('normalizeError does not expose Bearer token in summary', async () => {
    const { normalizeError } = await import('../sdk/src/platform/utils/error-display.js');
    const err = new Error('Auth failed: Bearer sk-ant-abc123xyz Bearer sk-prod-999 is invalid');
    const result = normalizeError(err);
    expect(result.summary).not.toContain('sk-ant-abc123xyz');
    expect(result.summary).not.toContain('sk-prod-999');
  });

  test('the synchronous normalizeError keeps an ECONNREFUSED error\'s own message and category', async () => {
    const { normalizeError } = await import('../sdk/src/platform/utils/error-display.js');
    const result = normalizeError(new Error('ECONNREFUSED 127.0.0.1:3000'));
    expect(result.category).toBe('unknown');
    expect(result.summary).toBe('ECONNREFUSED 127.0.0.1:3000');
  });

  test('a pairing timeout read by Jev produces the timed-out summary', async () => {
    const { readFormattedError } = await import('../sdk/src/platform/utils/error-display.js');
    const result = await readFormattedError(new Error('ETIMEDOUT: companion pairing handshake'), { site: 'test.pairing' });
    expect(result).toContain('timed out');
  });
});
