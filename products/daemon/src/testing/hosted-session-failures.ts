/**
 * hosted-session-failures.ts, what `sessions.hosted.*` answers when it refuses.
 *
 * ── Why this is a shipped module ─────────────────────────────────────────
 *
 * The platform's shared mock-daemon fixture set
 * (@pellux/goodvibes-contracts/testing) is generated from each method's OUTPUT
 * schema, so every fixture in it is a 200 carrying a schema-valid success body.
 * There is no failure shape in it for anything, and a client mocked entirely
 * from it has never once been handed a refusal.
 *
 * That matters most for hosted sessions, because a hosted session refuses in
 * four distinct ways ON PURPOSE and the whole point of the distinction is that
 * a client reacts differently to each: "no such session", "that session exists
 * and cannot serve this right now, here is why", "you are at the configured
 * cap", "your argument is malformed". A client that collapses them retries the
 * one thing that will never work.
 *
 * These are the three refusals a client has to handle and could not previously
 * mock. They are declared here rather than hand-written in each consumer, and
 * `src/test/daemon/gateway-hosted-session-failures.test.ts` drives the REAL
 * engine to produce each one and asserts it still matches, so a fixture that
 * drifts from the daemon fails in this repository, not in a consumer's CI six
 * weeks later.
 */

/** The wire shape of a refusal, as `invokeGatewayMethodCall` reports it. */
export interface HostedSessionFailureFixture {
  /** The verb whose refusal this is. */
  readonly methodId: string;
  /** Machine-readable code, the field a client branches on. */
  readonly code: string;
  /** HTTP status the control plane maps this refusal to. */
  readonly status: number;
  /** What the caller did to earn it, in one line. */
  readonly when: string;
  /** How a client should react. Stated because the codes exist to be reacted to. */
  readonly clientAction: string;
}

/**
 * A hosted session id that names nothing. 404: the id is wrong, and no amount
 * of retrying it will make it right.
 */
export const SESSION_NOT_FOUND: HostedSessionFailureFixture = {
  methodId: 'sessions.hosted.attach',
  code: 'SESSION_NOT_FOUND',
  status: 404,
  when: 'the sessionId names no session this daemon holds',
  clientAction: 'Drop the id. Re-list before addressing a session again.',
};

/**
 * The session is real and cannot serve this request. 409, deliberately not 404:
 * a 404 would invite a retry against an id that is perfectly valid. The message
 * carries the reason (terminated, loop not composable) so a client can say why.
 */
export const HOSTED_SESSION_UNAVAILABLE: HostedSessionFailureFixture = {
  methodId: 'sessions.hosted.attach',
  code: 'HOSTED_SESSION_UNAVAILABLE',
  status: 409,
  when: 'the session exists but has terminated, or its loop could not be composed',
  clientAction: 'Show the reason. Offer a new session, never a retry of this one.',
};

/**
 * At the configured cap. 429: the request is well-formed and the daemon is not
 * broken, there is no room. Retrying after a kill succeeds.
 */
export const HOSTED_SESSION_LIMIT_REACHED: HostedSessionFailureFixture = {
  methodId: 'sessions.hosted.create',
  code: 'HOSTED_SESSION_LIMIT_REACHED',
  status: 429,
  when: 'hostedSessions.maxSessions live sessions already exist',
  clientAction: 'Offer to kill one, or to raise hostedSessions.maxSessions. Retry after either.',
};

/** Every hosted-session refusal a client must handle, in one list. */
export const HOSTED_SESSION_FAILURE_FIXTURES: readonly HostedSessionFailureFixture[] = [
  SESSION_NOT_FOUND,
  HOSTED_SESSION_UNAVAILABLE,
  HOSTED_SESSION_LIMIT_REACHED,
];

/** Every `sessions.hosted.*` verb, for a conformance sweep's `onlyIds`. */
export const HOSTED_SESSION_METHOD_IDS: readonly string[] = [
  'sessions.hosted.create',
  'sessions.hosted.attach',
  'sessions.hosted.detach',
  'sessions.hosted.kill',
  'sessions.hosted.list',
];
