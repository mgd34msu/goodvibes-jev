import { asRecord, compactJson } from './object';
import { daemonRefusalValue } from './daemon-refusal';

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : '';
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (!error) return {};
  if (error instanceof Error) {
    const record = asRecord(error);
    const json = typeof record.toJSON === 'function' ? asRecord((record.toJSON as () => unknown)()) : {};
    return {
      name: error.name,
      message: error.message,
      ...json,
      ...record,
    };
  }
  return asRecord(error);
}

export function formatError(error: unknown): string {
  if (!error) return '';

  const serialized = serializeError(error);
  const transport = asRecord(serialized.transport);
  const body = serialized.body ?? transport.body;
  // The daemon's own words about what failed (body.message / body.error) beat
  // the transport wrapper's synthetic "GET /path failed: 400 Bad Request",
  // which is ALWAYS present on an HTTP error and used to shadow an actionable
  // body ("refresh token expired... start a fresh consent") behind a bare
  // status line.
  const message = readString(asRecord(body), 'message')
    || readString(asRecord(body), 'error')
    || readString(serialized, 'message')
    || (typeof error === 'string' ? error : 'Request failed');
  const status = readNumber(serialized, 'status') ?? readNumber(transport, 'status');
  const category = readString(serialized, 'category');
  const hint = readString(serialized, 'hint');

  const details = [
    status ? `HTTP ${status}` : '',
    category && category !== 'unknown' ? category : '',
    hint,
  ].filter(Boolean);

  return details.length ? `${message} (${details.join(' · ')})` : message;
}

export function errorCode(error: unknown): string {
  const serialized = serializeError(error);
  const transport = asRecord(serialized.transport);
  const body = asRecord(serialized.body ?? transport.body);
  return readString(serialized, 'code')
    || readString(body, 'code')
    || readString(asRecord(body.error), 'code')
    || '';
}

export function isSessionNotFoundError(error: unknown): boolean {
  return errorCode(error) === 'SESSION_NOT_FOUND' || daemonRefusalValue(error)?.session_not_found === true;
}

/** SESSION_CLOSED is structural; unresolved prose requires a genuine daemon reading. */
export function isSessionClosedError(error: unknown): boolean {
  return errorCode(error) === 'SESSION_CLOSED' || daemonRefusalValue(error)?.session_closed === true;
}

/** SESSION_ACTIVE is structural; unresolved prose requires a genuine daemon reading. */
export function isSessionActiveError(error: unknown): boolean {
  return errorCode(error) === 'SESSION_ACTIVE' || daemonRefusalValue(error)?.session_active === true;
}

/** SESSION_NOT_LOCAL is structural; unresolved prose requires a genuine daemon reading. */
export function isSessionNotLocalError(error: unknown): boolean {
  return errorCode(error) === 'SESSION_NOT_LOCAL' || daemonRefusalValue(error)?.session_not_local === true;
}


/**
 * The benign refusal from companion.chat.turns.cancel: no turn was in flight,
 * it finished naturally before the stop landed. Rendered quietly, never as an
 * error (the daemon promises the machine code, not message text).
 */
export function isNoActiveTurnError(error: unknown): boolean {
  return errorCode(error) === 'NO_ACTIVE_TURN';
}

/**
 * True for the daemon's honest 409 CONFLICT rejection. Two review-cockpit surfaces
 * raise it, both meaning "nothing was written, re-read and retry", never a partial apply:
 *   - checkpoints.revertHunk, when the hunk no longer reverse-applies cleanly because the
 *     file drifted since the diff was captured (control-plane/routes/checkpoints.ts throws
 *     GatewayVerbError(..., 'CONFLICT', 409));
 *   - fleet.attempts.pick, for an unknown/not-ready group or an invalid winner (never a
 *     partial merge of a best-of-N group).
 * Code-first, status-fallback, the same pattern as the other daemon-code checks above.
 */
export function isConflictError(error: unknown): boolean {
  if (errorCode(error) === 'CONFLICT') return true;
  const serialized = serializeError(error);
  const transport = asRecord(serialized.transport);
  const status = readNumber(serialized, 'status') ?? readNumber(transport, 'status');
  return status === 409;
}

/**
 * True for the daemon's honest 501 refusal on memory.consolidation.receipts when this
 * runtime has no consolidation scheduler wired at all (method-catalog-runtime.ts's
 * own description: "a runtime without the consolidation scheduler answers an honest
 * 501"), distinct from `isMethodUnavailableError`'s 404 (the verb id itself is
 * unregistered on an older daemon build): here the verb IS registered, but this
 * daemon build genuinely never runs the scheduler. Status-only, same pattern as
 * `isConflictError`, no machine `code` is documented for this refusal.
 */
export function isConsolidationUnavailableError(error: unknown): boolean {
  const serialized = serializeError(error);
  const transport = asRecord(serialized.transport);
  const status = readNumber(serialized, 'status') ?? readNumber(transport, 'status');
  return status === 501;
}

export function isMethodUnavailableError(error: unknown): boolean {
  const serialized = serializeError(error);
  const transport = asRecord(serialized.transport);
  const status = readNumber(serialized, 'status') ?? readNumber(transport, 'status');
  return status === 404 && (errorCode(error) === 'METHOD_NOT_FOUND' || daemonRefusalValue(error)?.method_unknown === true);
}

/**
 * True when a thrown request error never reached the daemon, a network/connection
 * failure rather than an HTTP rejection. The SDK transport tags these with
 * `category: 'network'` and `transport.status: 0` (createNetworkTransportError), and the
 * webui's own requestJson leaves `status` unset when fetch throws. This is what lets the
 * auth gate tell "daemon unreachable" (keep the token, reconnect) apart from a genuine
 * 401 "unauthenticated" (clear the token, show the sign-in front door).
 */
export function isDaemonUnreachableError(error: unknown): boolean {
  if (!error) return false;
  const serialized = serializeError(error);
  const transport = asRecord(serialized.transport);
  const category = readString(serialized, 'category') || readString(transport, 'category');
  if (category === 'network') return true;
  const status = readNumber(serialized, 'status') ?? readNumber(transport, 'status');
  return status === 0;
}

/**
 * True for a 401 / `category: 'authentication'` rejection, a token that was valid
 * when the request/stream opened but has since expired or been revoked. Distinct from
 * `isDaemonUnreachableError` (network/status-0, daemon unreachable): this is a genuine
 * "the daemon is answering and says you are no longer authenticated" signal, the one
 * that must hand off to the sign-in front door rather than retry forever.
 */
export function isAuthExpiredError(error: unknown): boolean {
  if (!error) return false;
  const serialized = serializeError(error);
  const transport = asRecord(serialized.transport);
  const category = readString(serialized, 'category') || readString(transport, 'category');
  if (category === 'authentication') return true;
  const status = readNumber(serialized, 'status') ?? readNumber(transport, 'status');
  return status === 401;
}

/**
 * True for the daemon's honest 412 refusals on the calendar surface,
 * CALENDAR_NOT_CONFIGURED (no CalDAV URL/user set: `surfaces.calendar.caldavUrl` /
 * `surfaces.calendar.caldavUser`) or CALENDAR_CREDENTIALS_MISSING (the CalDAV
 * password is not in the credential store). Both mean the operator has not yet
 * brought their own CalDAV endpoint, a self-hosted-calendar analogue of an
 * unconfigured provider, not a fault. Distinguished from a genuine error so the
 * calendar view can point at setup instead of rendering a scary failure.
 */
export function isCalendarUnconfiguredError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'CALENDAR_NOT_CONFIGURED' || code === 'CALENDAR_CREDENTIALS_MISSING';
}

/**
 * True for the daemon's CALENDAR_AUTH_FAILED code, the configured CalDAV
 * endpoint rejected the stored credentials (401/403 from the CalDAV server
 * itself). Distinct from `isCalendarUnconfiguredError`: here the operator DID
 * configure a CalDAV endpoint, but the credentials it holds no longer work.
 */
export function isCalendarAuthFailedError(error: unknown): boolean {
  return errorCode(error) === 'CALENDAR_AUTH_FAILED';
}

/**
 * True for a 501 "Gateway method is cataloged but not invokable through method
 * dispatch" refusal (control-plane.ts), a method the daemon's contract knows
 * about but has no live handler wired for on this build. Distinct from
 * `isMethodUnavailableError` (404, the daemon has never heard of the id at
 * all): 501 means the id IS in the catalog, just not wired to a handler yet.
 * Calendar is the first surface where this matters, the SDK ships the
 * `calendar.*` contract with `invokable: false` by default; a daemon build
 * that has not registered a real CalDAV handler answers this way.
 */
export function isMethodNotInvokableError(error: unknown): boolean {
  const serialized = serializeError(error);
  const transport = asRecord(serialized.transport);
  const status = readNumber(serialized, 'status') ?? readNumber(transport, 'status');
  return status === 501;
}

/**
 * True for the daemon's honest refusals on the email surface, the operator has an
 * account to bring but has not brought it yet (no IMAP host / SMTP host / account
 * address / app password in daemon config and the daemon secret tier).
 *
 * GROUNDING NOTE, deliberately explicit because it differs from most helpers here:
 * the installed SDK defines no EMAIL_, IMAP_ or SMTP_ prefixed error-code literals at
 * all (verified by sweeping @goodvibes-jev/engine/sdk/dist, only the three
 * EMAIL_..._SCHEMA shape names appear). The named codes below are ANTICIPATED, as
 * `isCalendarUnconfiguredError`'s CALENDAR_NOT_CONFIGURED is anticipated, that
 * literal is likewise absent from the SDK. So correctness here does not rest on
 * guessing a string right: the structural backstop is HTTP 412, which is what a
 * precondition refusal ("configure the surface first") is by definition. Any 412 on
 * an email call reads as not-configured whether or not its code matches, so a daemon
 * that ships a code none of these names anticipates still gets the calm setup pointer
 * rather than a red failure. Tighten the literals once a real handler ships one.
 */
export function isEmailUnconfiguredError(error: unknown): boolean {
  const code = errorCode(error);
  if (
    code === 'EMAIL_NOT_CONFIGURED'
    || code === 'EMAIL_CREDENTIALS_MISSING'
    || code === 'IMAP_NOT_CONFIGURED'
    || code === 'SMTP_NOT_CONFIGURED'
  ) {
    return true;
  }
  const serialized = serializeError(error);
  const transport = asRecord(serialized.transport);
  const status = readNumber(serialized, 'status') ?? readNumber(transport, 'status');
  return status === 412;
}

/**
 * True when the operator DID configure a mail account but the IMAP/SMTP server
 * rejected the stored credentials, the app password was revoked, or the account
 * moved. Distinct from `isEmailUnconfiguredError`: there is something to fix, not
 * something to set up. Same anticipated-literal caveat as above; here the structural
 * backstop is deliberately NOT a bare status check, because 401 on an email call is
 * ambiguous (it is also what an expired *daemon* session returns, which
 * `isAuthExpiredError` already owns and must keep owning).
 */
export function isEmailAuthFailedError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'EMAIL_AUTH_FAILED' || code === 'IMAP_AUTH_FAILED' || code === 'SMTP_AUTH_FAILED';
}

/**
 * True for the daemon's step-up refusal on a mutating call that arrived over the relay
 * (evaluateStepUp in @pellux/goodvibes-sdk's relay step-up policy, a fail-closed hook:
 * consumers wire a real WebAuthn verifier, and until one is wired every mutating relay
 * call is refused rather than silently allowed through). Two distinct codes, both a
 * genuine policy refusal rather than a fault:
 *   - `step-up-required`, a fresh assertion is required and none/an invalid one was
 *     presented.
 *   - `step-up-verifier-unavailable`, the daemon has no verifier wired at all, so the
 *     policy fails closed unconditionally.
 * The webui has no WebAuthn ceremony implemented (a further deferral of its own), so
 * either code always means: render the honest refusal with its reason, never retry
 * silently and never paint a generic/scary failure banner.
 */
export function isStepUpRequiredError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'step-up-required' || code === 'step-up-verifier-unavailable';
}

/**
 * True when the underlying refusal is specifically the "no verifier wired at all"
 * variant, as opposed to "a verifier exists but this call didn't carry a valid fresh
 * assertion". Callers that want to word the refusal differently (e.g. "not supported on
 * this connection yet" vs "step up and try again") can branch on this.
 */
export function isStepUpVerifierUnavailableError(error: unknown): boolean {
  return errorCode(error) === 'step-up-verifier-unavailable';
}

export function errorDebugValue(error: unknown): unknown {
  const serialized = serializeError(error);
  return Object.keys(serialized).length ? serialized : undefined;
}

export function compactError(error: unknown): string {
  return compactJson(serializeError(error));
}
