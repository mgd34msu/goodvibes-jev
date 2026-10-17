import { useSecurityReadings } from './helpers/security-readings.ts';
import { describe, expect, test } from 'bun:test';

/**
 * Bearer/token redaction, verifies that redactSensitiveData strips
 * Bearer tokens and API keys from error strings before they appear in logs.
 */
useSecurityReadings();

describe('bearer redaction', () => {
  test('redactSensitiveData removes Bearer tokens', async () => {
    const { redactSensitiveDataAsync: redactSensitiveData } = await import('../sdk/src/platform/utils/redaction.js');
    const input = 'Authorization: Bearer sk-ant-abc123def456';
    const result = await redactSensitiveData(input);
    expect(result).not.toContain('sk-ant-abc123def456');
    expect(result).toContain('[REDACTED_TOKEN]');
  });

  test('redactSensitiveData is case-insensitive for Bearer prefix', async () => {
    const { redactSensitiveDataAsync: redactSensitiveData } = await import('../sdk/src/platform/utils/redaction.js');
    const input = 'auth header: bearer MYTOKEN12345';
    const result = await redactSensitiveData(input);
    expect(result).not.toContain('MYTOKEN12345');
  });

  test('redactedErrorMessage protects Bearer tokens at the output boundary', async () => {
    const { redactedErrorMessage } = await import('../sdk/src/platform/utils/error-display.js');
    const err = new Error('HTTP 401: Authorization: Bearer sk-secret-key-99 is not valid');
    expect(redactedErrorMessage(err)).not.toContain('sk-secret-key-99');
  });

  test('local normalization preserves ordinary failure diagnostics', async () => {
    const { summarizeError } = await import('../sdk/src/platform/utils/error-display.js');
    const err = new Error('Connection refused to local fixture');
    const result = summarizeError(err);
    expect(result).toContain('Connection refused to local fixture');
  });

  test('redactSensitiveData preserves non-sensitive content', async () => {
    const { redactSensitiveDataAsync: redactSensitiveData } = await import('../sdk/src/platform/utils/redaction.js');
    const input = 'Connection refused to localhost:3000';
    const result = await redactSensitiveData(input);
    expect(result).toBe(input);
  });
});
