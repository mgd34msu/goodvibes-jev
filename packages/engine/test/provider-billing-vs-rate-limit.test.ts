/**
 * "Your credit balance is too low" was being reported, and retried, as a
 * rate limit.
 *
 * Observed live: an Anthropic 400 carrying that message surfaced as
 * `Agent agent-8bc59dec: rate limited on turn 1, retrying in 60s`. Two
 * separate faults produced it:
 *
 *  1. `inferErrorCategory` short-circuited on the status code, so a 400 became
 *     `bad_request` no matter what it said. Providers do not agree on a code
 *     for a spent account, Anthropic uses 400, OpenAI uses 429
 *     `insufficient_quota`, so the code alone cannot classify it.
 *  2. `isRateLimitOrQuotaError` matches quota/credit wording by design (the
 *     SyntheticProvider uses it to rotate backends), and the orchestrator's
 *     retry ladder consumed that verdict directly. A spent account then got
 *     three 60s waits: three minutes burned per agent, and a message that sent
 *     the reader hunting a throughput problem that did not exist.
 *
 * These construct the provider's 400/429 shapes directly. Nothing here calls a
 * provider API.
 *
 * The status fixes a provisional category (a 400 is bad_request, a 429 is
 * rate_limit); whether the wording says the account is spent is read by the
 * failure-reading battery. The fake port below answers with the reading each
 * provider message carries, and every async predicate and the display layer
 * settle the category from it.
 */
import { describe, expect, test } from 'bun:test';
import {
  ProviderError,
  isBillingOrCreditError,
  isRateLimitOrQuotaError,
} from '../sdk/src/platform/types/errors.ts';
import { readNormalizedError } from '../sdk/src/platform/utils/error-display.ts';
import { useFailureReadings } from './_helpers/failure-readings.ts';

/** The message Anthropic returns with a 400 when the account is out of credit. */
const ANTHROPIC_CREDIT_400 =
  'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';

/** OpenAI's shape: a 429 that is billing, not throughput. */
const OPENAI_QUOTA_429 =
  'You exceeded your current quota, please check your plan and billing details. insufficient_quota';

useFailureReadings([
  [ANTHROPIC_CREDIT_400, { category: 'billing', billing: true, providerUnusable: true }],
  [OPENAI_QUOTA_429, { category: 'billing', billing: true, rateLimited: true }],
  ['invalid request: unsupported parameter', { category: 'bad_request' }],
  ['invalid request: malformed tool schema', { category: 'bad_request' }],
  ['Rate limit reached', { category: 'rate_limit', rateLimited: true }],
  ['rate limit of 30000 tokens per minute', { category: 'rate_limit', rateLimited: true }],
  ['prompt is too long', { category: 'bad_request', contextExceeded: true }],
  ['Payment required', { category: 'billing', billing: true }],
]);

/** The category the display layer settles on once the wording is read. */
async function settled(err: ProviderError): Promise<string> {
  return (await readNormalizedError(err, { site: 'test.billing' })).category;
}

describe('a spent account is classified as billing, not as a bad request', () => {
  test('an Anthropic 400 credit-balance failure is categorized billing', async () => {
    const err = new ProviderError(ANTHROPIC_CREDIT_400, { statusCode: 400, provider: 'anthropic' });
    expect(err.category).toBe('bad_request');
    expect(await settled(err)).toBe('billing');
    expect(err.statusCode).toBe(400);
  });

  test('an ordinary 400 is still a bad request', async () => {
    const err = new ProviderError('invalid request: unsupported parameter "reasoning_effort"', { statusCode: 400 });
    expect(await settled(err)).toBe('bad_request');
  });

  test('an OpenAI 429 insufficient_quota is billing, not rate_limit', async () => {
    const err = new ProviderError(OPENAI_QUOTA_429, { statusCode: 429, provider: 'openai' });
    expect(await settled(err)).toBe('billing');
  });

  test('an ordinary 429 is still a rate limit', async () => {
    const err = new ProviderError('Rate limit reached for requests. Please try again later.', { statusCode: 429 });
    expect(await settled(err)).toBe('rate_limit');
  });

  test('the guidance points at credits, not at request volume', async () => {
    const err = new ProviderError(ANTHROPIC_CREDIT_400, { statusCode: 400, provider: 'anthropic' });
    const normalized = await readNormalizedError(err, { site: 'test.billing' });
    expect(normalized.hint).toContain('credits');
    expect(normalized.hint).not.toContain('reduce request volume');
  });

  test('the display-layer classifier twin agrees with the type-layer one', async () => {
    const normalized = await readNormalizedError(
      Object.assign(new Error(ANTHROPIC_CREDIT_400), { statusCode: 400 }),
      { provider: 'anthropic', site: 'test.billing' },
    );
    expect(normalized.category).toBe('billing');
    expect(normalized.statusCode).toBe(400);
  });

  test('the display-layer twin still calls an ordinary 400 a bad request', async () => {
    const normalized = await readNormalizedError(
      Object.assign(new Error('invalid request: malformed tool schema'), { statusCode: 400 }),
      { site: 'test.billing' },
    );
    expect(normalized.category).toBe('bad_request');
  });
});

describe('isBillingOrCreditError separates a spent account from a rate limit', () => {
  test('recognizes the Anthropic 400 credit message', async () => {
    expect(await isBillingOrCreditError(new ProviderError(ANTHROPIC_CREDIT_400, { statusCode: 400 }))).toBe(true);
  });

  test('recognizes a bare Error carrying the same wording', async () => {
    expect(await isBillingOrCreditError(new Error(ANTHROPIC_CREDIT_400))).toBe(true);
  });

  test('recognizes a 402', async () => {
    expect(await isBillingOrCreditError(new ProviderError('Payment required', { statusCode: 402 }))).toBe(true);
  });

  test('recognizes OpenAI insufficient_quota', async () => {
    expect(await isBillingOrCreditError(new ProviderError(OPENAI_QUOTA_429, { statusCode: 429 }))).toBe(true);
  });

  test('a real rate limit is NOT a billing failure', async () => {
    const err = new ProviderError('Rate limit reached for requests. Please try again later.', { statusCode: 429 });
    expect(await isBillingOrCreditError(err)).toBe(false);
    expect(await isRateLimitOrQuotaError(err)).toBe(true);
  });

  test('a per-minute token limit is NOT swept into billing', async () => {
    // Deliberately narrow wording: a bare "quota"/"limit" still retries,
    // because those genuinely do clear on their own.
    const err = new ProviderError('Request too large: rate limit of 30000 tokens per minute exceeded', { statusCode: 429 });
    expect(await isBillingOrCreditError(err)).toBe(false);
    expect(await isRateLimitOrQuotaError(err)).toBe(true);
  });

  test('a context-window rejection is neither', async () => {
    const err = new ProviderError('prompt is too long: 210000 tokens > 200000 maximum', { statusCode: 400 });
    expect(await isBillingOrCreditError(err)).toBe(false);
  });

  test('a non-Error value is not a billing failure', async () => {
    expect(await isBillingOrCreditError('credit balance is too low')).toBe(false);
    expect(await isBillingOrCreditError(null)).toBe(false);
  });
});

describe('the orchestrator retry ladder does not wait out a spent account', () => {
  /**
   * Mirrors the branch order in agents/orchestrator-runner.ts. The point under
   * test is the ORDER: billing is decided before the rate-limit branch, so a
   * credit failure can never take the 60s backoff even though it matches the
   * quota wording that branch keys off.
   */
  async function retryDecision(err: unknown): Promise<'rate-limit-backoff' | 'fail-now'> {
    if (await isBillingOrCreditError(err)) return 'fail-now';
    if (await isRateLimitOrQuotaError(err)) return 'rate-limit-backoff';
    return 'fail-now';
  }

  test('the Anthropic 400 credit failure fails immediately instead of retrying', async () => {
    expect(await retryDecision(new ProviderError(ANTHROPIC_CREDIT_400, { statusCode: 400 }))).toBe('fail-now');
  });

  test('the OpenAI 429 insufficient_quota also fails immediately', async () => {
    expect(await retryDecision(new ProviderError(OPENAI_QUOTA_429, { statusCode: 429 }))).toBe('fail-now');
  });

  test('a genuine rate limit still takes the backoff', async () => {
    expect(await retryDecision(new ProviderError('Rate limit reached, too many requests', { statusCode: 429 })))
      .toBe('rate-limit-backoff');
  });
});
