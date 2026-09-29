/**
 * `engine.tools.child-failure-reason`: why a child agent died, read from the
 * free-text error on its record, as one of the failure envelope's reason
 * codes (tools/agent/child-failure-envelope.ts). Cancellation and a reason
 * code stamped on the record where code produced the failure decide in code
 * first; this reading is asked only for a failure with no stamp.
 *
 * Read by Jev in place of the regex keyword groups the envelope matched over
 * the error message (maximum turn limit, circuit breaker, went silent or
 * timeout, budget or exhausted, claim or unverified, rate limit or network or
 * status code), and in place of the interim two-way split through the errors
 * failure reading (any categorised failure an API error, anything else a
 * generic error), which could never return the budget, claim or watchdog
 * codes for an unstamped message.
 *
 * Band: low stakes. The code is a label in the envelope a supervising agent
 * reads to choose its next step; the error text itself travels beside it. A
 * reading that does not act is reported as `error`, the envelope's code for
 * a failure it does not place.
 */
import { defineBattery, oneOf, STAKES_BANDS } from '@goodvibes-jev/judgment';

export const CHILD_FAILURE_OPTIONS = {
  max_turns: 'The agent used up its allowed number of turns or steps.',
  circuit_breaker: 'The agent was stopped after too many failing turns or tool errors in a row.',
  watchdog_timeout: 'The agent went silent, stalled or ran past its time limit and was stopped.',
  budget_exhausted: 'A token, cost or work budget that this platform set for the agent or its workstream ran out. A model provider account with no credit left is api_error, not this.',
  claim_unverified: 'The agent claimed work it had not done, or its claims could not be verified.',
  api_error: 'The model provider or the network failed: a rate limit, an HTTP error status, an overloaded or unreachable service, a refused or reset connection, a provider account out of credit, or a rejected key.',
  error: 'Any other failure, or the message does not say.',
} as const;

export type ChildFailureReading = keyof typeof CHILD_FAILURE_OPTIONS;

/** Most characters of the error message one request carries. */
export const MAX_JUDGED_CHILD_ERROR_CHARS = 2_000;

/** What the reading sees: the child's own error message. */
export function childFailureView(error: string): { error: string } {
  return { error: error.slice(0, MAX_JUDGED_CHILD_ERROR_CHARS) };
}

const said = (error: string) => childFailureView(error);

export const childFailureReason = defineBattery({
  name: 'engine.tools.child-failure-reason',
  version: 1,
  description: 'Why a child agent died, from its error message, as one of the failure envelope\'s reason codes.',
  accuracyFloor: 0.85,
  items: {
    reason: oneOf(
      '`error` is the error message recorded when an AI sub-agent stopped working and failed. Why did it fail?',
      CHILD_FAILURE_OPTIONS,
      STAKES_BANDS.low.confidence,
    ),
  },
  fixtures: [
    { name: 'turn limit', state: said('Exceeded maximum turn limit (50)'), expect: { reason: 'max_turns' } },
    { name: 'step budget worded differently', state: said('Agent stopped: ran out of steps after 40 of 40 allowed'), expect: { reason: 'max_turns' } },
    { name: 'circuit breaker', state: said('Circuit breaker tripped after 10 consecutive all-error turns'), expect: { reason: 'circuit_breaker' } },
    { name: 'repeated tool failures', state: said('Stopped after 8 consecutive tool failures with no successful call'), expect: { reason: 'circuit_breaker' } },
    { name: 'went silent', state: said('Agent went silent for 120s (timeout: 60s)'), expect: { reason: 'watchdog_timeout' } },
    { name: 'wall clock limit', state: said('Agent exceeded its 15 minute run time limit and was stopped'), expect: { reason: 'watchdog_timeout' } },
    { name: 'workstream budget', state: said('workstream budget exhausted: 200000 of 200000 tokens used'), expect: { reason: 'budget_exhausted' } },
    { name: 'cost ceiling', state: said('Cost ceiling of $5.00 reached for this run'), expect: { reason: 'budget_exhausted' } },
    { name: 'phantom claim', state: said('Completion rejected: claimed tests pass but no test run was recorded'), expect: { reason: 'claim_unverified' } },
    { name: 'claims not verified', state: said('Claims could not be verified: files listed as changed are unmodified'), expect: { reason: 'claim_unverified' } },
    { name: 'rate limit', state: said('429 Too Many Requests: rate limit exceeded for model claude-sonnet'), expect: { reason: 'api_error' } },
    { name: 'provider 500', state: said('API error: status 500 Internal Server Error'), expect: { reason: 'api_error' } },
    { name: 'connection refused', state: said('connect ECONNREFUSED 127.0.0.1:11434'), expect: { reason: 'api_error' } },
    { name: 'spent account', state: said('Your credit balance is too low to access the Anthropic API.'), expect: { reason: 'api_error' } },
    { name: 'tool threw', state: said("TypeError: Cannot read properties of undefined (reading 'map')"), expect: { reason: 'error' } },
    { name: 'no cause given', state: said('Agent failed'), expect: { reason: 'error' } },
    { name: 'file not writable', state: said('File not writable: /etc/hosts is owned by root'), expect: { reason: 'error' } },
  ],
});
