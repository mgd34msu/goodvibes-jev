/**
 * Network/transport failure classification.
 *
 * Root cause: orchestrator-runner.ts's isNetworkError() only matched a fixed
 * substring allowlist on err.message and never looked at the structured
 * `.recoverable`/`.category` fields that createNetworkTransportError (transport-http)
 * already computes correctly (TypeError, POSIX network errno, or undici UND_ERR_*
 * codes). A socket-closure error whose message text didn't hit the substring list
 * (e.g. "The socket connection was closed unexpectedly") fell through every retry
 * branch and was thrown immediately with zero retry attempts.
 *
 * These tests lock in:
 *  1. createNetworkTransportError's own classification (transport-http) for a
 *     synthetic UND_ERR_SOCKET error, the signal orchestrator-runner.ts is now
 *     told to trust.
 *  2. isNetworkTransportError() trusts that structured classification directly
 *     (RED against the old message-substring-only isNetworkError, this exact
 *     case did not match any entry in the old allowlist).
 *  3. isNetworkTransportError() still returns false for a non-network error that
 *     merely carries similar-looking-but-unrelated fields (no over-retry regression).
 *
 * The wording is read by the failure-reading battery; the fake port below
 * answers with the reading each message carries. A structured HttpStatusError
 * and a non-Error value are decided without any reading.
 */
import { describe, it, expect } from 'bun:test';
import { HttpStatusError } from '../errors/src/index.js';
import { createNetworkTransportError } from '../transport-http/src/http-core.js';
import { isNetworkTransportError } from '../sdk/src/platform/types/errors.js';
import { useFailureReadings } from './_helpers/failure-readings.ts';

const readings = useFailureReadings([
  ['The model refused to produce a tool call', { category: 'bad_request' }],
  ['tool call failed for unrelated reasons', { category: 'unknown' }],
  ['connect ECONNREFUSED', { category: 'network', transientNetwork: true, providerUnusable: true, beforeResponse: true }],
]);

describe('createNetworkTransportError (transport-http): classification transport-http already gets right', () => {
  it('marks recoverable=true and category=network for a synthetic UND_ERR_SOCKET error', async () => {
    const raw = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    const err = createNetworkTransportError(raw, 'https://example.test/v1/chat', 'POST');
    expect(err.recoverable).toBe(true);
    expect(err.category).toBe('network');
    expect(err instanceof HttpStatusError).toBe(true);
  });

  it('marks recoverable=true for a bare TypeError (e.g. fetch-thrown)', async () => {
    const raw = new TypeError('fetch failed');
    const err = createNetworkTransportError(raw, 'https://example.test/v1/chat', 'POST');
    expect(err.recoverable).toBe(true);
    expect(err.category).toBe('network');
  });
});

describe('isNetworkTransportError: trusts structured classification over message text', () => {
  it('returns true for "unexpected socket connection closure" wording once it carries the structured HttpStatusError shape', async () => {
    // This is the exact reported wording. The OLD isNetworkError() in
    // orchestrator-runner.ts (message-substring-only) did NOT match this text
    // against any entry in its allowlist ('socket hang up', 'econnreset', etc.),
    // this is the RED case for that older implementation.
    const raw = Object.assign(new Error('unexpected socket connection closure'), { code: 'UND_ERR_SOCKET' });
    const err = createNetworkTransportError(raw, 'https://example.test/v1/chat', 'POST');
    expect(await isNetworkTransportError(err)).toBe(true);
    expect(readings.requests).toHaveLength(0);
  });

  it('returns false for a plain Error whose message does not look like a transport failure', async () => {
    const err = new Error('The model refused to produce a tool call for this schema');
    expect(await isNetworkTransportError(err)).toBe(false);
  });

  it('returns false for a non-Error value entirely', async () => {
    expect(await isNetworkTransportError('just a string')).toBe(false);
    expect(await isNetworkTransportError(undefined)).toBe(false);
    expect(readings.requests).toHaveLength(0);
  });

  it('does not trust a plain object that merely has recoverable/category properties but is not a branded HttpStatusError', async () => {
    // Guards against the false-positive-retry risk called out in the brief: a
    // custom tool-call error could coincidentally set `.recoverable = true`.
    class FakeToolError extends Error {
      recoverable = true;
      category = 'network';
    }
    const err = new FakeToolError('tool call failed for unrelated reasons');
    expect(await isNetworkTransportError(err)).toBe(false);
  });

  it('still falls back to message-substring matching for a plain Error carrying network wording with no structured fields', async () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:443');
    expect(await isNetworkTransportError(err)).toBe(true);
  });
});
