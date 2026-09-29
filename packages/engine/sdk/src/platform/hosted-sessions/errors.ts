/**
 * errors.ts, the hosted-session engine's refusals. Each has its own class so
 * the routes can give each its own wire shape (routes/hosted-sessions.ts):
 * "no such session", "that session cannot serve this, and why", "a malformed
 * argument" and "at the configured cap" want four different reactions.
 */

/** A hosted session id nobody here knows. */
export class HostedSessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super(`This daemon hosts no session ${sessionId}.`);
    this.name = 'HostedSessionNotFoundError';
  }
}

/** A known hosted session that cannot serve this request, with the reason. */
export class HostedSessionUnavailableError extends Error {
  constructor(public readonly sessionId: string, reason: string) {
    super(`Hosted session ${sessionId} is unavailable: ${reason}.`);
    this.name = 'HostedSessionUnavailableError';
  }
}

/** A malformed request argument. */
export class HostedSessionArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostedSessionArgumentError';
  }
}

/** The configured hosted-session cap is reached. */
export class HostedSessionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostedSessionLimitError';
  }
}
