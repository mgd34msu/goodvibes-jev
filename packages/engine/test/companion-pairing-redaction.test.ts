import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { forgetFailureReadings, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { authoredErrorReadingsPort, errorSpan, errorText } from './_helpers/authored-error-readings.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  forgetFailureReadings();
  previous = installJudgmentPort(authoredErrorReadingsPort({
    parts: [[errorText('ETIMEDOUT: '), errorSpan('ETIMEDOUT'), errorText('')]],
    fields: { ETIMEDOUT: 'other' },
  }, [{ message: 'ETIMEDOUT: companion pairing handshake', errorName: 'Error',
    reading: { category: 'timeout', connection: 'timed_out', transientNetwork: true } }]).port);
});
afterEach(() => { installJudgmentPort(previous); forgetFailureReadings(); });

/** Local pairing diagnostics retain their text; Jev supplies retry classification. */
describe('normalize/summarize pairing diagnostics', () => {

  test('normalizeError retains the original local diagnostic', async () => {
    const { normalizeError } = await import('../sdk/src/platform/utils/error-display.js');
    const err = new Error('Auth failed: Bearer sk-ant-abc123xyz Bearer sk-prod-999 is invalid');
    const result = normalizeError(err);
    expect(result.summary).toBe(err.message);
  });

  test('synchronous normalizeError preserves prose and keeps its native category', async () => {
    const { normalizeError } = await import('../sdk/src/platform/utils/error-display.js');
    const error = new Error('ECONNREFUSED 127.0.0.1:3000');
    const result = normalizeError(error);
    expect(result.category).toBe('unknown');
    expect(result.summary).toBe(error.message);
    expect(error.message).toBe('ECONNREFUSED 127.0.0.1:3000');
  });

  test('a pairing timeout read by Jev preserves the message and includes retry guidance', async () => {
    const { readFormattedError } = await import('../sdk/src/platform/utils/error-display.js');
    const result = await readFormattedError(new Error('ETIMEDOUT: companion pairing handshake'), { site: 'test.pairing' });
    expect(result).toContain('ETIMEDOUT: companion pairing handshake');
    expect(result).toContain('Check network stability');
  });
});
