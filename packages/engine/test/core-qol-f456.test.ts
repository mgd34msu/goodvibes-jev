import { describe, it, expect } from 'bun:test';
import { ProviderError } from '@goodvibes-jev/engine/sdk/platform/types';
import {
  buildErrorResponseBody,
  formatError,
  formatProviderError,
  normalizeError,
  readNormalizedError,
  summarizeError,
  toProviderError,
} from '@goodvibes-jev/engine/sdk/platform/utils';
import { useFailureReadings } from './_helpers/failure-readings.ts';

/** What Jev reads in a refused connection's wording. */
const REFUSED = [['ECONNREFUSED', { category: 'network', connection: 'refused', transientNetwork: true, beforeResponse: true }]] as const;

describe('F6 - ProviderError semantics', () => {
  useFailureReadings(REFUSED);
  it('keeps rate-limit retries recoverable and carries the explicit retry-after', () => {
    // A wait stated only in the message is read by Jev (readRetryWait,
    // provider-retry-wait.test.ts); the constructor keeps the explicit value.
    const err = new ProviderError('Rate limited', { statusCode: 429, retryAfterMs: 30000 });
    expect(err.category).toBe('rate_limit');
    expect(err.retryAfterMs).toBe(30000);
    expect(err.recoverable).toBe(true);
    expect(err.guidance).toContain('retry automatically');
  });

  it('uses broad authentication guidance instead of blaming only the API key', () => {
    const err = new ProviderError('Unauthorized', 401);
    expect(err.category).toBe('authentication');
    expect(err.guidance).toContain('invalid or expired credentials');
    expect(err.guidance).toContain('wrong provider/endpoint');
    expect(err.guidance).not.toContain('Check your API key for this provider.');
    expect(err.recoverable).toBe(false);
  });

  it('distinguishes authorization from authentication', () => {
    const err = new ProviderError('Forbidden', 403);
    expect(err.category).toBe('authorization');
    expect(err.guidance).toContain('missing model access');
  });

  it('classifies timeout and network failures without collapsing them together', async () => {
    expect(new ProviderError('Request Timeout', 408).category).toBe('timeout');
    // With no status the error's own category stays open, and Jev reads a
    // refused connection in the wording.
    const refused = new ProviderError('connect ECONNREFUSED 127.0.0.1:11434');
    expect((await readNormalizedError(refused, { site: 'test.f6' })).category).toBe('network');
  });

  it('preserves structured provider metadata', () => {
    const err = new ProviderError('inceptionlabs chat request failed 401: token rejected', {
      statusCode: 401,
      provider: 'inceptionlabs',
      operation: 'chat',
      phase: 'request',
      requestId: 'req-123',
      providerCode: 'invalid_api_key',
      providerType: 'authentication_error',
    });
    expect(err.provider).toBe('inceptionlabs');
    expect(err.operation).toBe('chat');
    expect(err.phase).toBe('request');
    expect(err.requestId).toBe('req-123');
    expect(err.providerCode).toBe('invalid_api_key');
    expect(err.providerType).toBe('authentication_error');
  });
});

describe('F6 - error normalization and display', () => {
  useFailureReadings(REFUSED);
  it('formats provider errors with preserved metadata and broad hints', () => {
    const err = new ProviderError('inceptionlabs chat request failed 401: token rejected by upstream', {
      statusCode: 401,
      provider: 'inceptionlabs',
      operation: 'chat',
      phase: 'request',
      requestId: 'req-review-1',
      providerCode: 'invalid_api_key',
    });

    const formatted = formatProviderError(err);
    expect(formatted).toContain('token rejected by upstream');
    expect(formatted).toContain('request_id=req-review-1');
    expect(formatted).toContain('Hint:');
    expect(formatted).not.toContain('Check your API key for this provider.');
  });

  it('extracts useful text from raw JSON errors', () => {
    const summary = summarizeError('{"error":{"message":"model not found","code":"model_not_found"}}');
    expect(summary).toContain('model not found');
    expect(summary).toContain('model_not_found');
  });

  it('normalizes network errors into a descriptive summary and category where the wording is read', async () => {
    const error = new Error('connect ECONNREFUSED 127.0.0.1:11434');
    const read = await readNormalizedError(error, { provider: 'ollama', site: 'test.f6' });
    expect(read.category).toBe('network');
    expect(read.summary).toContain('Cannot connect to ollama');
    // The synchronous path reads nothing: it shows the error's own message.
    const shown = normalizeError(error, { provider: 'ollama' });
    expect(shown.category).toBe('unknown');
    expect(shown.summary).toBe('connect ECONNREFUSED 127.0.0.1:11434');
  });

  it('formats generic errors through the same display path', () => {
    const formatted = formatError(new Error('invalid JSON response from upstream'));
    expect(formatted).toContain('invalid JSON response from upstream');
  });

  it('builds structured HTTP error bodies without losing compatibility', () => {
    const body = buildErrorResponseBody(new ProviderError('request failed', {
      statusCode: 503,
      provider: 'inceptionlabs',
      operation: 'chat',
      phase: 'request',
      requestId: 'req-503',
    }));
    expect(body).toMatchObject({
      error: 'request failed (request_id=req-503)',
      hint: 'The provider is temporarily unavailable. Retry shortly or switch providers if the issue persists.',
      code: 'PROVIDER_ERROR',
      category: 'service',
      source: 'provider',
      recoverable: true,
      status: 503,
      provider: 'inceptionlabs',
      operation: 'chat',
      phase: 'request',
      requestId: 'req-503',
    });
  });

  it('upgrades unknown provider failures into structured provider errors', () => {
    const err = toProviderError(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
      provider: 'ollama',
      operation: 'chat',
      phase: 'request',
    });

    expect(err).toBeInstanceOf(ProviderError);
    // Nothing structural names the failure, so the rewrapped error leaves the
    // category for the wording to be read where it matters.
    expect(err.category).toBe('unknown');
    expect(err.message).toBe('connect ECONNREFUSED 127.0.0.1:11434');
    expect(err.provider).toBe('ollama');
    expect(err.operation).toBe('chat');
    expect(err.phase).toBe('request');
  });

  it('preserves upstream provider metadata when rewrapping provider errors', () => {
    const err = toProviderError(new ProviderError('upstream failed', {
      statusCode: 503,
      requestId: 'req-upstream',
      providerCode: 'overloaded',
    }), {
      provider: 'lm-studio',
      operation: 'chat',
      phase: 'stream',
    });

    expect(err.statusCode).toBe(503);
    expect(err.requestId).toBe('req-upstream');
    expect(err.providerCode).toBe('overloaded');
    expect(err.provider).toBe('lm-studio');
    expect(err.operation).toBe('chat');
    expect(err.phase).toBe('stream');
  });
});
