import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { forgetFailureReadings, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { authoredErrorReadingsPort, errorSpan, errorText } from './_helpers/authored-error-readings.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  forgetFailureReadings();
  previous = installJudgmentPort(authoredErrorReadingsPort({
    parts: [[errorText('ETIMEDOUT: '), errorSpan('ETIMEDOUT'), errorText('')]],
    fields: { ETIMEDOUT: 'content' },
  }, [{ message: 'ETIMEDOUT: [REDACTED_TEXT]',
    reading: { category: 'timeout', connection: 'timed_out', transientNetwork: true } }]).port);
});
afterEach(() => { installJudgmentPort(previous); forgetFailureReadings(); });

/**
 * Error normalize/summarize redaction smoke, verifies that the
 * normalizeError and summarizeError pipeline handles errors without leaking
 * sensitive tokens in output. Tests use companion/pairing-style error messages.
 *
 * NOTE: This file does NOT test pairing.request / pairing.verify flows.
 * COVERAGE.md has been updated to reflect the actual scope.
 */
describe('normalize/summarize redaction smoke', () => {

  test('normalizeError does not expose Bearer token in summary', async () => {
    const { normalizeError } = await import('../sdk/src/platform/utils/error-display.js');
    const err = new Error('Auth failed: Bearer sk-ant-abc123xyz Bearer sk-prod-999 is invalid');
    const result = normalizeError(err);
    expect(result.summary).not.toContain('sk-ant-abc123xyz');
    expect(result.summary).not.toContain('sk-prod-999');
  });

  test('the synchronous normalizeError holds unqualified prose and keeps its native category', async () => {
    const { normalizeError } = await import('../sdk/src/platform/utils/error-display.js');
    const error = new Error('ECONNREFUSED 127.0.0.1:3000');
    const result = normalizeError(error);
    expect(result.category).toBe('unknown');
    expect(result.summary).toBe('[REDACTED]');
    expect(error.message).toBe('ECONNREFUSED 127.0.0.1:3000');
  });

  test('a pairing timeout read by Jev produces the timed-out summary', async () => {
    const { readFormattedError } = await import('../sdk/src/platform/utils/error-display.js');
    const result = await readFormattedError(new Error('ETIMEDOUT: companion pairing handshake'), { site: 'test.pairing' });
    expect(result).toContain('timed out');
  });
});
