import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { forgetFailureReadings, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { authoredErrorReadingsPort, errorSpan, errorText } from './_helpers/authored-error-readings.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); forgetFailureReadings(); });
afterEach(() => { installJudgmentPort(previous); forgetFailureReadings(); });

function workspaceDiagnostic(message: string) {
  const fixture = authoredErrorReadingsPort({
    fields: { failed: 'other' },
    parts: [
      [errorText('Workspace swap failed: '), errorSpan('failed'), errorText('')],
      [errorText('workspace gone')],
    ],
  }, [
    { message, errorName: 'Error', reading: { category: 'unknown', connection: 'none' } },
  ]);
  installJudgmentPort(fixture.port);
  return fixture;
}

/**
 * Workspace swap failed event, verifies that the normalizeError path
 * correctly handles workspace-swap-related errors through the error display pipeline.
 */
describe('workspace swap failed', () => {
  test('normalizeError handles workspace errors without throwing', async () => {
    const { normalizeError, readNormalizedError } = await import('../sdk/src/platform/utils/error-display.js');
    const err = new Error('Workspace swap failed: target directory not found');
    expect(normalizeError(err).message).toBe(err.message);
    const fixture = workspaceDiagnostic(err.message);
    const reading = await readNormalizedError(err, { site: 'test.workspace-swap-failed' });
    expect(reading.message).toBe(err.message);
    expect(fixture.requests.length).toBeGreaterThan(0);
    const result = normalizeError(err);
    expect(result.name).toBe('Error');
    expect(result.message).toBe('Workspace swap failed: target directory not found');
  });

  test('normalizeError infers recoverable=false for unknown errors', async () => {
    const { normalizeError } = await import('../sdk/src/platform/utils/error-display.js');
    const err = new Error('Unexpected swap state');
    const result = normalizeError(err);
    expect(result.recoverable).toBe(false);
  });

  test('summarizeError returns a non-empty string', async () => {
    const { readNormalizedError, summarizeError } = await import('../sdk/src/platform/utils/error-display.js');
    const err = new Error('workspace gone');
    expect(summarizeError(err)).toBe(err.message);
    const fixture = workspaceDiagnostic(err.message);
    expect((await readNormalizedError(err, { site: 'test.workspace-swap-failed' })).summary).toBe('workspace gone');
    expect(fixture.requests.length).toBeGreaterThan(0);
    const result = summarizeError(err);
    expect(result).toBe('workspace gone');
  });
});
