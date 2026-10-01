import { describe, expect, test } from 'bun:test';
import {
  formatError,
  isAuthExpiredError,
  isConflictError,
  isEmailAuthFailedError,
  isEmailUnconfiguredError,
  isMethodUnavailableError,
  isSessionActiveError,
  isSessionNotFoundError,
  isSessionNotLocalError,
  isStepUpRequiredError,
  isStepUpVerifierUnavailableError,
} from './errors';

describe('isStepUpRequiredError (relay mutating-call refusal)', () => {
  test('true for the step-up-required code', () => {
    expect(isStepUpRequiredError({ code: 'step-up-required', message: 'needs a fresh assertion' })).toBe(true);
  });

  test('true for the step-up-verifier-unavailable code', () => {
    expect(isStepUpRequiredError({ code: 'step-up-verifier-unavailable', message: 'no verifier wired' })).toBe(true);
  });

  test('true when the code is nested under transport.body', () => {
    expect(isStepUpRequiredError(
      Object.assign(new Error('refused'), { transport: { body: { code: 'step-up-required' } } }),
    )).toBe(true);
  });

  test('false for unrelated errors', () => {
    expect(isStepUpRequiredError({ code: 'CONFLICT', status: 409 })).toBe(false);
    expect(isStepUpRequiredError({ status: 403 })).toBe(false);
    expect(isStepUpRequiredError(undefined)).toBe(false);
  });
});

describe('isStepUpVerifierUnavailableError', () => {
  test('true only for the verifier-unavailable variant', () => {
    expect(isStepUpVerifierUnavailableError({ code: 'step-up-verifier-unavailable' })).toBe(true);
    expect(isStepUpVerifierUnavailableError({ code: 'step-up-required' })).toBe(false);
    expect(isStepUpVerifierUnavailableError(undefined)).toBe(false);
  });
});

describe('isConflictError (409 stale-hunk / not-ready-group)', () => {
  test('true for the CONFLICT code (revertHunk stale, attempts.pick not-ready)', () => {
    expect(isConflictError({ code: 'CONFLICT', status: 409, message: 'hunk no longer applies' })).toBe(true);
    expect(isConflictError(Object.assign(new Error('conflict'), { transport: { body: { code: 'CONFLICT' } } }))).toBe(true);
  });

  test('true for a bare 409 status even without the machine code', () => {
    expect(isConflictError({ status: 409 })).toBe(true);
    expect(isConflictError(Object.assign(new Error('x'), { transport: { status: 409 } }))).toBe(true);
  });

  test('false for non-conflict errors', () => {
    expect(isConflictError({ status: 404, code: 'METHOD_NOT_FOUND' })).toBe(false);
    expect(isConflictError({ status: 500 })).toBe(false);
    expect(isConflictError(undefined)).toBe(false);
  });
});

describe('error formatting', () => {
  test('includes transport status and hint when present, preferring the body text', () => {
    const error = Object.assign(new Error('Login failed'), {
      category: 'authentication',
      hint: 'Check your authentication token or credentials.',
      transport: {
        status: 401,
        body: { error: 'invalid credentials' },
      },
    });

    expect(formatError(error)).toContain('invalid credentials');
    expect(formatError(error)).toContain('HTTP 401');
    expect(formatError(error)).toContain('authentication');
  });

  test('the daemon body message beats the synthetic transport line', () => {
    const actionable = 'Google reports this refresh token as expired or revoked.';
    const error = Object.assign(new Error('GET /api/calendar/events failed: 400 Bad Request'), {
      status: 400,
      category: 'service',
      body: { error: actionable, code: 'CALENDAR_REQUEST_FAILED', status: 400 },
    });

    const formatted = formatError(error);
    expect(formatted).toContain(actionable);
    expect(formatted).not.toContain('400 Bad Request');
  });

  test('a plain client-side Error still formats its own message', () => {
    expect(formatError(new Error('local parse failure'))).toContain('local parse failure');
  });

  test('detects daemon session-not-found errors', () => {
    expect(isSessionNotFoundError({ body: { code: 'SESSION_NOT_FOUND', error: 'Session not found' } })).toBe(true);
    expect(isSessionNotFoundError(Object.assign(new Error('Request failed'), {
      transport: { body: { code: 'SESSION_NOT_FOUND' } },
    }))).toBe(true);
    expect(isSessionNotFoundError(new Error('Session not found'))).toBe(true);
  });

  test('detects a 401 / category:authentication as an expired-token error', () => {
    expect(isAuthExpiredError(Object.assign(new Error('Unauthorized'), { category: 'authentication' }))).toBe(true);
    expect(isAuthExpiredError(Object.assign(new Error('Unauthorized'), { status: 401 }))).toBe(true);
    expect(isAuthExpiredError(Object.assign(new Error('Unreachable'), {
      transport: { status: 401, category: 'authentication' },
    }))).toBe(true);
  });

  test('does not misclassify a network failure or a generic 500 as auth-expired', () => {
    expect(isAuthExpiredError(Object.assign(new Error('offline'), { category: 'network', status: 0 }))).toBe(false);
    expect(isAuthExpiredError(Object.assign(new Error('boom'), { status: 500 }))).toBe(false);
    expect(isAuthExpiredError(null)).toBe(false);
    expect(isAuthExpiredError(undefined)).toBe(false);
  });

  test('detects the honest 409 SESSION_ACTIVE delete-rejection (delete-means-delete)', () => {
    expect(isSessionActiveError({ body: { code: 'SESSION_ACTIVE', error: 'Session is active; close it, then delete.' } })).toBe(true);
    expect(isSessionActiveError(new Error('Session is active; close it, then delete.'))).toBe(true);
    expect(isSessionActiveError({ body: { code: 'SESSION_NOT_FOUND' } })).toBe(false);
  });

  test('distinguishes "method not registered on this daemon" from a normal 404 on a known resource', () => {
    expect(isMethodUnavailableError({
      status: 404,
      body: { error: 'Unknown gateway method' },
    })).toBe(true);
    // A genuine SESSION_NOT_FOUND is ALSO a 404 but is a different honest signal
    // (the resource doesn't exist, not "this daemon has never heard of this verb"),
    // isMethodUnavailableError must not conflate the two.
    expect(isMethodUnavailableError({ status: 404, body: { code: 'SESSION_NOT_FOUND', error: 'Session not found' } })).toBe(false);
    expect(isMethodUnavailableError({ status: 500, body: { error: 'Unknown gateway method' } })).toBe(false);
    expect(isMethodUnavailableError(undefined)).toBe(false);
  });

  // Since the 1.0.0 delete-means-delete change, the daemon carries
  // code: 'METHOD_NOT_FOUND' on this 404 (SDKErrorCodes.METHOD_NOT_FOUND).
  // Code-first, message-fallback, the same pattern as
  // isSessionClosedError/isSessionActiveError above.
  test('recognizes the machine code METHOD_NOT_FOUND (an upgraded daemon), no message-sniff needed', () => {
    expect(isMethodUnavailableError({
      status: 404,
      body: { code: 'METHOD_NOT_FOUND', error: 'Unknown gateway method: sessions.delete' },
    })).toBe(true);
    // Wire shape via transport (the SDK client's real error envelope), not a bare body.
    expect(isMethodUnavailableError(Object.assign(new Error('Request failed'), {
      transport: { status: 404, body: { code: 'METHOD_NOT_FOUND' } },
    }))).toBe(true);
  });

  test('back-compat: an un-upgraded daemon (pre-1.0.0, npm 0.38) with no code field still falls back to the message match', () => {
    expect(isMethodUnavailableError({
      status: 404,
      body: { error: 'Unknown gateway method: sessions.delete' },
    })).toBe(true);
  });

  // sessions.permissionMode.get/set + sessions.contextUsage.get (SDK 1.6.1): the daemon's
  // honest 404 for a session id that is not its own live local runtime.
  test('detects the honest 404 SESSION_NOT_LOCAL refusal', () => {
    expect(isSessionNotLocalError({ status: 404, body: { code: 'SESSION_NOT_LOCAL', error: 'This daemon does not host a live runtime for session s-1.' } })).toBe(true);
    expect(isSessionNotLocalError(Object.assign(new Error('Request failed'), {
      transport: { status: 404, body: { code: 'SESSION_NOT_LOCAL' } },
    }))).toBe(true);
    expect(isSessionNotLocalError(new Error('This daemon does not host a live runtime for session s-1.'))).toBe(true);
  });

  test('SESSION_NOT_LOCAL is not confused with SESSION_NOT_FOUND (both 404, different meanings)', () => {
    expect(isSessionNotLocalError({ status: 404, body: { code: 'SESSION_NOT_FOUND', error: 'Session not found' } })).toBe(false);
    expect(isSessionNotFoundError({ status: 404, body: { code: 'SESSION_NOT_LOCAL' } })).toBe(false);
  });
});

describe('isEmailUnconfiguredError (412 precondition refusal, structural backstop)', () => {
  test('true for the named EMAIL_NOT_CONFIGURED code', () => {
    expect(isEmailUnconfiguredError({ status: 412, body: { code: 'EMAIL_NOT_CONFIGURED', error: 'No mail account is configured.' } })).toBe(true);
  });

  test('true for a bare HTTP 412 with a code none of the anticipated literals name, the structural backstop', () => {
    // The whole point of the backstop: correctness must not rest on guessing the
    // daemon's exact code string right. A 412 with an unrecognized code still reads
    // as "not configured yet" rather than falling through to a scary generic error.
    expect(isEmailUnconfiguredError({ status: 412, body: { code: 'SOME_FUTURE_CODE_NOT_YET_NAMED' } })).toBe(true);
    expect(isEmailUnconfiguredError({ status: 412, body: {} })).toBe(true);
  });

  test('false for a 404 (capability-absent, a different honest signal entirely)', () => {
    expect(isEmailUnconfiguredError({ status: 404, body: { code: 'METHOD_NOT_FOUND' } })).toBe(false);
  });

  test('false for a 501 (cataloged but not invokable, not a precondition refusal)', () => {
    expect(isEmailUnconfiguredError({ status: 501, body: { code: 'METHOD_NOT_INVOKABLE' } })).toBe(false);
  });
});

describe('isEmailAuthFailedError (configured account, rejected credentials)', () => {
  test('true for EMAIL_AUTH_FAILED and IMAP_AUTH_FAILED', () => {
    expect(isEmailAuthFailedError({ body: { code: 'EMAIL_AUTH_FAILED' } })).toBe(true);
    expect(isEmailAuthFailedError({ body: { code: 'IMAP_AUTH_FAILED' } })).toBe(true);
  });

  test('false for a plain 401: must not swallow daemon-session expiry, which isAuthExpiredError already owns', () => {
    expect(isEmailAuthFailedError({ status: 401, category: 'authentication' })).toBe(false);
    expect(isEmailAuthFailedError(Object.assign(new Error('Unauthorized'), { status: 401 }))).toBe(false);
  });
});
