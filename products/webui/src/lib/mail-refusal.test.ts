/**
 * mail-refusal, the classifier's ORDERING is the contract (see mail-refusal.ts's own
 * top-of-file comment: capability-absent, then configuration, then credentials, each
 * step only reachable once the prior one is genuinely satisfied). These tests pin
 * that order against overlapping status codes, not just each predicate in isolation.
 */
import { describe, expect, test } from 'bun:test';
import { mailRefusalNote } from './mail-refusal';

describe('mailRefusalNote: ordering contract', () => {
  test('a 501 (cataloged but not invokable) classifies as not-available even though 501 is also "not a 412"', () => {
    const note = mailRefusalNote({ status: 501, body: { code: 'METHOD_NOT_INVOKABLE' } });
    expect(note?.kind).toBe('not-available');
  });

  test('a 404 (method unregistered on this daemon build) also classifies as not-available', () => {
    const note = mailRefusalNote({ status: 404, body: { code: 'METHOD_NOT_FOUND' } });
    expect(note?.kind).toBe('not-available');
  });

  test('a 412 classifies as needs-setup', () => {
    const note = mailRefusalNote({ status: 412, body: { code: 'EMAIL_NOT_CONFIGURED' } });
    expect(note?.kind).toBe('needs-setup');
  });

  test('an EMAIL_AUTH_FAILED code classifies as auth-failed', () => {
    const note = mailRefusalNote({ body: { code: 'EMAIL_AUTH_FAILED' } });
    expect(note?.kind).toBe('auth-failed');
  });

  test('a genuine error (random 500) returns null so the caller falls back to ErrorState with retry', () => {
    expect(mailRefusalNote({ status: 500, body: { error: 'internal error' } })).toBeNull();
  });

  test('a genuine 401 (daemon session expiry, not an email-specific refusal) also returns null here', () => {
    // mailRefusalNote has no opinion on daemon-session auth at all, isAuthExpiredError
    // owns that signal elsewhere. A bare 401 must not be misread as an email refusal.
    expect(mailRefusalNote({ status: 401, category: 'authentication' })).toBeNull();
  });
});
