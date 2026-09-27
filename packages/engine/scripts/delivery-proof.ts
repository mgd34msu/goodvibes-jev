/**
 * Live proof of failure transience before retry, cooldown or dead-letter.
 *
 * Real failure messages from delivery targets (Slack, Discord, Telegram,
 * ntfy, webhooks, the control-plane gateway, fetch itself) run through the
 * same code the engine uses: `readFailureTransience` (structured facts first,
 * then one Jev reading of the wording through the engine failure battery),
 * the integration `DeliveryQueue`, and the automation run follow-up. Each
 * case prints its decision and what it rested on; the script exits non-zero
 * when any decision differs from the expected one.
 *
 *   TYPESAFE_API_KEY=... bun run --cwd packages/engine delivery:proof
 */
import { createSystemOnePort, judgmentConfigFromEnv } from '@goodvibes-jev/judgment';
import { HttpStatusError, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { DeliveryQueue, readFailureTransience, type DeliveryFailureClass } from '../sdk/src/platform/integrations/delivery.ts';
import { readAutomationRunTransience } from '../sdk/src/platform/automation/manager-runtime-delivery.ts';

interface ProofCase {
  readonly label: string;
  readonly error: () => unknown;
  readonly expect: DeliveryFailureClass;
}

function withCause(error: Error, message: string, code?: string): Error {
  const cause = code === undefined ? new Error(message) : Object.assign(new Error(message), { code });
  return Object.assign(error, { cause });
}

const CASES: readonly ProofCase[] = [
  { label: 'Slack chat.postMessage ok:false', error: () => new Error('SlackIntegration.postMessage API error: channel_not_found'), expect: 'terminal' },
  { label: 'Slack token revoked', error: () => new Error('SlackIntegration.postMessage API error: token_revoked'), expect: 'terminal' },
  { label: 'Slack rate limited in body', error: () => new Error('SlackIntegration.postMessage API error: ratelimited'), expect: 'retryable' },
  { label: 'Discord gateway client', error: () => new Error('DiscordAPIError[10003]: Unknown Channel'), expect: 'terminal' },
  { label: 'Telegram bot blocked', error: () => new Error('Telegram delivery failed: Forbidden: bot was blocked by the user'), expect: 'terminal' },
  { label: 'missing credential', error: () => new Error('Missing Mattermost bot token'), expect: 'terminal' },
  { label: 'gateway down', error: () => new Error('Web control-plane gateway unavailable'), expect: 'retryable' },
  { label: 'fetch, peer closed', error: () => withCause(new TypeError('fetch failed'), 'other side closed'), expect: 'retryable' },
  { label: 'fetch, bad URL', error: () => new TypeError('Failed to parse URL from hooks.slack.com/services/T000/B000'), expect: 'terminal' },
  { label: 'socket reset mid-send', error: () => new Error('socket hang up'), expect: 'retryable' },
  { label: 'fetch, DNS errno', error: () => withCause(new TypeError('fetch failed'), 'getaddrinfo ENOTFOUND hooks.slack.com', 'ENOTFOUND'), expect: 'retryable' },
  { label: 'webhook 410', error: () => new HttpStatusError('HTTP 410: this webhook has been deleted', { status: 410 }), expect: 'terminal' },
  { label: 'ntfy 429', error: () => new HttpStatusError('NtfyIntegration.publish failed (429): limit reached', { status: 429 }), expect: 'retryable' },
  { label: 'GitHub 403 Retry-After', error: () => Object.assign(new Error('You have exceeded a secondary rate limit'), { status: 403, retryAfterMs: 60_000 }), expect: 'retryable' },
  { label: 'fetch timeout', error: () => new DOMException('The operation was aborted due to timeout', 'TimeoutError'), expect: 'retryable' },
];

const QUEUE_DELAY_MS = 1_000;

function wording(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? ` / cause: ${error.cause.message}` : '';
  return `${error.message}${cause}`;
}

installJudgmentPort(createSystemOnePort(judgmentConfigFromEnv(process.env)));

let failed = 0;
for (const proof of CASES) {
  const transience = await readFailureTransience(proof.error(), 'engine.delivery-proof');

  // The integration queue: a retry after a backoff cooldown, or a dead-letter.
  const queue = new DeliveryQueue({ maxRetries: 2, initialDelayMs: QUEUE_DELAY_MS, maxDelayMs: 30_000 });
  const outcome = await queue.enqueue('proof', 'delivery.proof', 'payload', async () => {
    throw proof.error();
  });
  queue.dispose();
  const queueDecision = outcome === 'retrying'
    ? `retry after a ${QUEUE_DELAY_MS}ms+ backoff cooldown`
    : 'dead-letter now';

  // The automation run follow-up: another attempt only when it could succeed.
  const run = await readAutomationRunTransience({ error: proof.error() }, 'engine.delivery-proof.run', { jobId: 'proof', runId: proof.label });
  const runDecision = run?.failureClass === 'retryable' ? 'run retried after its cooldown' : 'run not retried';

  const ok = transience.failureClass === proof.expect
    && (outcome === 'retrying') === (proof.expect === 'retryable')
    && run?.failureClass === proof.expect;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${proof.label}`);
  console.log(`      failure : ${wording(proof.error())}`);
  console.log(`      decided : ${transience.failureClass} (basis ${transience.basis}: ${transience.detail}), expected ${proof.expect}`);
  console.log(`      queue   : ${queueDecision}`);
  console.log(`      run     : ${runDecision}`);
}

const read = CASES.length;
console.log(`\n${read - failed}/${read} decisions as expected`);
process.exit(failed === 0 ? 0 : 1);
