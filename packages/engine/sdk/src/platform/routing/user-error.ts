/**
 * The user error formatter, hoisted from the TUI (core/format-user-error.ts):
 * a caught provider or network error becomes one plain-language line and a
 * suggested action. The messages and actions are the TUI's, unchanged.
 *
 * What stays code: a 401 is auth, a 429 is a rate limit, and a connection
 * errno (ECONNREFUSED, ETIMEDOUT, ENOTFOUND and the rest of the fixed errno
 * table) is a network failure. What the wording means is read in one request:
 * the engine failure reading (engine.failure-reading) fanned out with
 * routing.user-error, which asks whether a subscription session has ended.
 * The regex ladder over a status, name, message and cause probe is gone.
 */
import { categoryForCode, failureReading, failureState, judgmentPort, type FailureEvidence } from '@goodvibes-jev/engine/errors';
import { defineBattery, fanOut, STAKES_BANDS, yesNo, type YesNoReading } from '@goodvibes-jev/judgment';
import { summarizeError } from '../utils/error-display.js';

export type ErrorClass = 'auth' | 'rate-limit' | 'context-overflow' | 'network' | 'generic';

export interface UserFacingError {
  /** Short, plain-language description of what went wrong. */
  readonly message: string;
  /** Suggested recovery action (slash-command or brief instruction). */
  readonly action: string;
  /** Which class the error was read into. */
  readonly kind: ErrorClass;
}

/**
 * `routing.user-error`: the one thing the user error line needs that the
 * failure reading does not ask. Low bands: it only picks between two wordings
 * of the same sign-in advice.
 */
export const userErrorReading = defineBattery({
  name: 'routing.user-error',
  version: 1,
  description: 'Whether an error says the user\'s subscription login session with the provider has ended, so they must sign in again.',
  accuracyFloor: 0.9,
  items: {
    session_ended: yesNo(
      'Does this error say the user\'s subscription or login session with the provider has ended, expired or been revoked, so they have to sign in again (as opposed to an API key being wrong)?',
      STAKES_BANDS.low.yesNo,
    ),
  },
  fixtures: [
    { name: 'subscription session ended', state: 'HTTP status: 401\nMessage: Your ChatGPT subscription session has ended. Sign in again to continue.', expect: { session_ended: 'yes' } },
    { name: 'refresh token revoked', state: 'Message: OAuth refresh token was revoked; the login session is no longer valid, please log in again', expect: { session_ended: 'yes' } },
    { name: 'wrong api key', state: 'HTTP status: 401\nMessage: Invalid API key provided', expect: { session_ended: 'no' } },
    { name: 'rate limited', state: 'HTTP status: 429\nMessage: Too Many Requests', expect: { session_ended: 'no' } },
  ],
});

const holds = (reading: YesNoReading): boolean => reading.verdict === 'yes' && reading.outcome === 'act';

/** The status, errno code and wording of an error, one cause level deep, as the TUI probe collected them. */
export function userErrorEvidence(err: unknown): { readonly evidence: FailureEvidence; readonly causeCode?: string | undefined } {
  if (err === null || err === undefined) return { evidence: { message: '' } };
  if (typeof err !== 'object') return { evidence: { message: String(err) } };
  const record = err as Record<string, unknown>;
  const status = [record['status'], record['statusCode']].find((value): value is number => typeof value === 'number');
  const code = typeof record['code'] === 'string' ? record['code'] : undefined;
  const cause = record['cause'] && typeof record['cause'] === 'object' ? record['cause'] as Record<string, unknown> : undefined;
  const causeMessage = typeof cause?.['message'] === 'string' ? cause['message'] : undefined;
  const causeCode = typeof cause?.['code'] === 'string' ? cause['code'] : undefined;
  const message = [typeof record['message'] === 'string' ? record['message'] : '', causeMessage ?? ''].filter(Boolean).join('\nCaused by: ');
  return {
    evidence: {
      message,
      ...(status === undefined ? {} : { status }),
      ...(code === undefined ? {} : { code }),
      ...(typeof record['name'] === 'string' ? { errorName: record['name'] } : {}),
    },
    causeCode,
  };
}

/** The class structure fixes on its own, before any wording is read. */
function structuralClass(evidence: FailureEvidence, causeCode: string | undefined): ErrorClass | undefined {
  if (evidence.status === 401) return 'auth';
  if (evidence.status === 429) return 'rate-limit';
  if (categoryForCode(evidence.code) !== undefined || categoryForCode(causeCode) !== undefined) return 'network';
  return undefined;
}

export interface UserErrorReading {
  readonly kind: ErrorClass;
  /** Whether the error says a subscription session has ended; only asked about an error whose wording was read. */
  readonly sessionEnded: boolean;
}

/** Reads which class an error falls in, asking Jev only when structure does not settle it. */
export async function readUserErrorClass(err: unknown, site = 'routing.user-error'): Promise<UserErrorReading> {
  const { evidence, causeCode } = userErrorEvidence(err);
  const fixed = structuralClass(evidence, causeCode);
  if (evidence.message.trim().length === 0) return { kind: fixed ?? 'generic', sessionEnded: false };
  if (fixed !== undefined && fixed !== 'auth') return { kind: fixed, sessionEnded: false };
  const run = await fanOut(judgmentPort(site), failureState(evidence), { failure: failureReading, user: userErrorReading }, { site, label: 'routing.user-error' });
  const failure = run.readings.failure;
  const sessionEnded = holds(run.readings.user.session_ended);
  let kind: ErrorClass;
  if (fixed === 'auth' || (failure.category.outcome === 'act' && failure.category.choice === 'authentication')) kind = 'auth';
  else if (holds(failure.rate_limited)) kind = 'rate-limit';
  else if (holds(failure.context_exceeded)) kind = 'context-overflow';
  else if (holds(failure.transient_network) || (failure.category.outcome === 'act' && (failure.category.choice === 'network' || failure.category.choice === 'timeout'))) kind = 'network';
  else kind = 'generic';
  run.recordAction(`class:${kind}`);
  return { kind, sessionEnded: kind === 'auth' && sessionEnded };
}

/** The TUI's line and action for each class. */
export function describeUserError(err: unknown, reading: UserErrorReading): UserFacingError {
  switch (reading.kind) {
    case 'auth':
      // A subscription-session death is not an API-key problem, and telling a
      // subscriber to "check your API key" reads as "your subscription isn't
      // there". Keep the meaning distinct.
      if (reading.sessionEnded) {
        return {
          kind: 'auth',
          message: 'Authentication failed: your provider subscription session has ended.',
          action: 'Run /login to sign in to the provider again.',
        };
      }
      return {
        kind: 'auth',
        message: 'Authentication failed: the provider rejected your API key.',
        action: 'Run /login to re-authenticate or check your API key.',
      };
    case 'rate-limit':
      return {
        kind: 'rate-limit',
        message: 'Rate limit reached: the provider is throttling requests.',
        action: 'Wait a moment and retry, or switch models with /model.',
      };
    case 'context-overflow':
      return {
        kind: 'context-overflow',
        message: 'Context window exceeded: the conversation is too long for this model.',
        action: 'Run /compact to summarise the conversation and free context.',
      };
    case 'network':
      return {
        kind: 'network',
        message: 'Network error: could not reach the provider.',
        action: 'Check your connection and retry, or switch models with /model.',
      };
    default:
      return {
        kind: 'generic',
        message: `Provider error: ${summarizeError(err)}`,
        action: 'Retry your last message, or switch models with /model.',
      };
  }
}

/** Reads `err` and returns its plain-language line and suggested action. */
export async function readUserFacingError(err: unknown, site = 'routing.user-error'): Promise<UserFacingError> {
  return describeUserError(err, await readUserErrorClass(err, site));
}

/** The full line for a single system message: "<message> <action>". */
export async function readUserFacingErrorLine(err: unknown, site = 'routing.user-error'): Promise<string> {
  const { message, action } = await readUserFacingError(err, site);
  return `${message} ${action}`;
}
