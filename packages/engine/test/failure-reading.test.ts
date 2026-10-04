import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import {
  categoryDependsOnWording,
  categoryForStatus,
  forgetFailureReadings,
  installJudgmentPort,
  JudgmentPortMissingError,
  readFailure,
  settleCategory,
} from '@goodvibes-jev/engine/errors';
import { readErrorResponseBody } from '@goodvibes-jev/engine/daemon-sdk';
import { ProviderError, isBillingOrCreditError, isRateLimitOrQuotaError } from '../sdk/src/platform/types/errors.ts';
import { readNormalizedError } from '../sdk/src/platform/utils/error-display.ts';

/** A port that answers as if the message were a spent-account 400, and counts requests. */
function billingPort(category = 'billing', confidence = 0.95) {
  return fakePort((name: string, question: Question) => {
    if (name === 'category') return choiceAnswer(question, category, confidence);
    if (name === 'connection_failure') return choiceAnswer(question, 'none', confidence);
    return noulAnswer(name === 'billing' || name === 'provider_unusable' ? 0.95 : 0.05);
  });
}

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  forgetFailureReadings();
  previous = installJudgmentPort(undefined);
});
afterEach(() => {
  installJudgmentPort(previous);
  forgetFailureReadings();
});

describe('structure decides without a request', () => {
  test('status table, with 504 as a timeout', () => {
    expect(categoryForStatus(401)).toBe('authentication');
    expect(categoryForStatus(402)).toBe('billing');
    expect(categoryForStatus(403)).toBe('authorization');
    expect(categoryForStatus(404)).toBe('not_found');
    expect(categoryForStatus(504)).toBe('timeout');
    expect(categoryForStatus(503)).toBe('service');
    expect(categoryForStatus(418)).toBeUndefined();
  });

  test('only open categories, or a provider\'s provisional 400 or 429, depend on wording', () => {
    expect(categoryDependsOnWording(undefined, undefined, false)).toBe(true);
    expect(categoryDependsOnWording('bad_request', 400, true)).toBe(true);
    expect(categoryDependsOnWording('rate_limit', 429, true)).toBe(true);
    expect(categoryDependsOnWording('bad_request', 400, false)).toBe(false);
    expect(categoryDependsOnWording('not_found', 404, true)).toBe(false);
    expect(categoryDependsOnWording('authentication', 400, true)).toBe(false);
  });

  test('a validation 400 from a route needs no reading', async () => {
    const body = await readErrorResponseBody(new Error('Missing required field: body'), { status: 400 });
    expect(body.category).toBe('bad_request');
  });

  test('a 402 is billing with no port installed', async () => {
    expect(await isBillingOrCreditError(new ProviderError('Payment Required', 402))).toBe(true);
    expect(await isRateLimitOrQuotaError(new ProviderError('slow down', 429))).toBe(true);
  });

  test('a 404 response body needs no reading', async () => {
    const body = await readErrorResponseBody({ message: 'no such session', status: 404 });
    expect(body.category).toBe('not_found');
  });
});

describe('the reading', () => {
  test('asks every failure question in one request and remembers the wording', async () => {
    const { port, requests } = billingPort();
    installJudgmentPort(port);
    const evidence = { message: 'Your credit balance is too low to access the API.', status: 400 };
    const first = await readFailure(evidence, 'test.site');
    const second = await readFailure(evidence, 'test.site');
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0]!.questions).sort()).toEqual(
      ['before_response', 'billing', 'category', 'connection_failure', 'context_exceeded', 'provider_unusable', 'rate_limited', 'transient_network'],
    );
    expect(requests[0]!.state).toBe('HTTP status: 400\nMessage: Your credit balance is too low to access the API.');
    expect(requests[0]!.context?.site).toBe('test.site');
    expect(first).toBe(second);
    expect(first.billing).toBe(true);
    expect(first.rateLimited).toBe(false);
    expect(first.category).toBe('billing');
  });

  test('a category too weak to act on stays unknown', async () => {
    installJudgmentPort(billingPort('network', 0.4).port);
    expect((await readFailure({ message: 'something odd' }, 'test.site')).category).toBe('unknown');
  });

  test('an owned reading preserves its transport lifetime and does not borrow or populate the global memo', async () => {
    const shared = billingPort(); const owned = billingPort('network');
    installJudgmentPort(shared.port);
    const evidence = { message: 'Same failure wording across different owners' };
    const cached = await readFailure(evidence, 'test.shared');
    const signal = new AbortController().signal;
    const beforeAttempt = () => {}; const onRetry = () => {};
    const options = { port: owned.port, signal, beforeAttempt, onRetry };
    const first = await readFailure(evidence, 'test.owned', options);
    const second = await readFailure(evidence, 'test.owned', options);
    expect(first.category).toBe('network'); expect(second).not.toBe(first);
    expect(owned.requests).toHaveLength(2);
    for (const request of owned.requests) {
      expect(request.signal).toBe(signal); expect(request.beforeAttempt).toBe(beforeAttempt); expect(request.onRetry).toBe(onRetry);
    }
    expect(await readFailure(evidence, 'test.shared')).toBe(cached); expect(shared.requests).toHaveLength(1);
  });

  test('no port is an error, not a guess', async () => {
    await expect(readFailure({ message: 'fetch failed' }, 'test.site')).rejects.toBeInstanceOf(JudgmentPortMissingError);
  });

  test('a billing reading turns only a provider\'s provisional 400 into billing', () => {
    const failure = { billing: true, category: 'billing', connection: 'none' } as Parameters<typeof settleCategory>[3];
    expect(settleCategory('bad_request', 400, true, failure)).toBe('billing');
    expect(settleCategory('bad_request', 400, false, failure)).toBe('bad_request');
    expect(settleCategory('authentication', 400, true, failure)).toBe('authentication');
    expect(settleCategory(undefined, undefined, false, failure)).toBe('billing');
    expect(settleCategory(undefined, undefined, false, undefined)).toBe('unknown');
  });
});

describe('call sites', () => {
  test('a spent-account 400 is billing, with the billing hint', async () => {
    const { port, requests } = billingPort();
    installJudgmentPort(port);
    const error = new ProviderError('Your credit balance is too low to access the API.', 400);
    expect(error.category).toBe('bad_request');
    expect(await isBillingOrCreditError(error)).toBe(true);
    const normalized = await readNormalizedError(error, { site: 'test.display' });
    expect(normalized.category).toBe('billing');
    expect(normalized.hint).toContain('credits');
    expect(requests).toHaveLength(1);
  });

  test('the daemon body reads a bare message', async () => {
    const { port, requests } = billingPort();
    installJudgmentPort(port);
    const body = await readErrorResponseBody(new Error('out of credits'));
    expect(body.category).toBe('billing');
    expect(requests).toHaveLength(1);
  });
});
