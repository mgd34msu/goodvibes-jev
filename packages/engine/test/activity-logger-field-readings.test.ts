import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ActivityLogger } from '../sdk/src/platform/utils/logger.js';
import { FieldKindReader } from '../sdk/src/platform/utils/field-kind-reading.js';

const roots: string[] = [], loggers: ActivityLogger[] = [];
afterEach(() => { for (const logger of loggers.splice(0)) logger.dispose(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'local-log-fields-')); roots.push(root);
  const logger = new ActivityLogger(); loggers.push(logger); logger.configure(root);
  return { logger, text() { logger.flushSync(); return readFileSync(join(root, 'activity.md'), 'utf8'); } };
}

test('repeated logging retains declared diagnostics and masks protected or unknown values without Jev', () => {
  let calls = 0;
  const previous = installJudgmentPort({ model: 'synthetic-unavailable', async ask() { calls++; throw new Error('No field-name request is allowed'); } });
  try {
    const { logger, text } = fixture();
    for (let i = 0; i < 70; i++) logger.warn('request failed', {
      error: 'private-diagnostic-output', tokenCount: 42, durationMs: 3, requestId: 'request-1',
      unlockPassphrase: 'private-password', shippingAddress: 'private-address', opaque: 'private-unknown',
    });
    const written = text();
    for (const value of ['private-diagnostic-output', 'private-password', 'private-address', 'private-unknown']) expect(written).not.toContain(value);
    expect(written).toContain('"tokenCount": 42'); expect(written).toContain('"requestId": "request-1"');
    expect(written).toContain('[REDACTED_TEXT]'); expect(written).toContain('[REDACTED_PROFILE]');
    expect(calls).toBe(0);
  } finally { installJudgmentPort(previous); }
});

test('nested log data retains declared counts and protects cyclic structures', () => {
  const { logger, text } = fixture();
  const data: Record<string, unknown> = { details: { count: 4, shippingAddress: 'private-address' } }; data.self = data;
  logger.info('record', data);
  const written = text();
  expect(written).toContain('"count": 4'); expect(written).toContain('[Circular]'); expect(written).not.toContain('private-address');
});

test('local field roles respect cancellation, disposal and caller ownership', async () => {
  let current = true;
  const reader = new FieldKindReader({ assertCurrent() { if (!current) throw new Error('Retired'); } });
  expect(await reader.readAsync('max_tokens')).toBe('other');
  expect(reader.read('unknownField')).toBeUndefined();
  current = false; expect(reader.read('max_tokens')).toBeUndefined();
  current = true; reader.dispose(); expect(reader.read('max_tokens')).toBeUndefined();
  const abort = new AbortController(); const cancelled = new FieldKindReader({ signal: abort.signal });
  abort.abort(); expect(cancelled.read('tokenCount')).toBeUndefined();
});
