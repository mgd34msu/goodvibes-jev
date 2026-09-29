/**
 * The wait before retrying that a provider error states in its message is
 * read by Jev (`engine.provider.retry-wait`), not by the regex the
 * ProviderError constructor used to run on every 429 message
 * (`retry[-_\s]?after[:=\s]+(\d+)`, taken as seconds). That regex took the
 * year in "retry after 2025-06-01" as a 2025-second wait, and "retry after 5
 * minutes" as 5 seconds.
 *
 * The constructor now keeps only an explicit wait (a Retry-After header or a
 * structured field). readRetryWait supplies the reading; the synthetic
 * provider's cooldown and the error display's "Retry in" line use it. A fake
 * port answers both the failure reading and the retry-wait reading, so
 * nothing here calls the live Jev API.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { EntryType, JudgmentPort, Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { forgetFailureReadings, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ProviderError, readRetryWait } from '../sdk/src/platform/types/errors.ts';
import { forgetRetryWaitReadings, numberSpans, type RetryWaitUnit } from '../sdk/src/platform/types/batteries/retry-wait.ts';
import { readFormattedError } from '../sdk/src/platform/utils/error-display.ts';
import { SyntheticProvider, type CanonicalModel } from '../sdk/src/platform/providers/synthetic.ts';
import type { LLMProvider } from '../sdk/src/platform/providers/interface.ts';

/** A year in a date: a number the old regex took as a wait, which is not one. */
const DATE_MESSAGE = 'Plan limit reached; retry after 2025-06-01 when your plan renews.';
/** A wait in minutes, which the old regex read as seconds. */
const MINUTES_MESSAGE = 'Too many requests: retry after 5 minutes.';

/** What the fake Jev reads as the wait in a message: the number's text and unit, or none. */
type WaitAnswer = { readonly number: string; readonly unit: RetryWaitUnit; readonly confidence?: number } | 'none';

function waitPort(waits: ReadonlyArray<readonly [wording: string, answer: WaitAnswer]>) {
  const answerFor = (state: EntryType): WaitAnswer => {
    const message = (state as { message?: string }).message ?? '';
    return waits.find(([wording]) => message.includes(wording))?.[1] ?? 'none';
  };
  const idOf = (state: EntryType, text: string): string => {
    const numbers = (state as { numbers: Record<string, { number: string }> }).numbers;
    return Object.entries(numbers).find(([, entry]) => entry.number === text)![0];
  };
  const { port: inner, requests } = fakePort((name: string, question: Question, state: EntryType) => {
    const answer = answerFor(state);
    if (name === 'pick') return answer === 'none' ? choiceAnswer(question, 'none', 0.95) : choiceAnswer(question, idOf(state, answer.number), answer.confidence ?? 0.95);
    if (name === 'unit') return choiceAnswer(question, answer === 'none' ? 's' : answer.unit, 0.95);
    if (name.startsWith('fits_')) return noulAnswer(answer !== 'none' && name === `fits_${idOf(state, answer.number)}` ? 0.97 : 0.03);
    // The failure reading: a rate limit, nothing else.
    if (name === 'category') return choiceAnswer(question, 'rate_limit', 0.95);
    if (name === 'connection_failure') return choiceAnswer(question, 'none', 0.95);
    return noulAnswer(name === 'rate_limited' ? 0.97 : 0.03);
  });
  const actions: string[] = [];
  const port: JudgmentPort = {
    model: inner.model,
    async ask(request) {
      return { ...(await inner.ask(request)), decisionId: `d${requests.length}` };
    },
    recorder: {
      recordReadings: () => undefined,
      recordAction: (_decisionId: string, action: string) => void actions.push(action),
    } as unknown as NonNullable<JudgmentPort['recorder']>,
  };
  const waitRequests = () => requests.filter((request) => 'pick' in request.questions && 'unit' in request.questions);
  return { port, waitRequests, actions };
}

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  forgetFailureReadings();
  forgetRetryWaitReadings();
  previous = installJudgmentPort(undefined);
});
afterEach(() => {
  installJudgmentPort(previous);
  forgetFailureReadings();
  forgetRetryWaitReadings();
});

describe('numberSpans (number grammar)', () => {
  test('finds every number in order, with comma groups and one decimal part', () => {
    const spans = numberSpans('limit 1,500 per 2 min; try again in 1.5s (gpt-4o)');
    expect(spans.map((span) => [span.id, span.text, span.value])).toEqual([
      ['n1', '1,500', 1500],
      ['n2', '2', 2],
      ['n3', '1.5', 1.5],
      ['n4', '4', 4],
    ]);
  });

  test('a message with no digits has no spans', () => {
    expect(numberSpans('Rate limit reached. Please slow down.')).toEqual([]);
  });
});

describe('a number that is not a wait', () => {
  test('the constructor takes no wait from the message', () => {
    expect(new ProviderError(DATE_MESSAGE, 429).retryAfterMs).toBeUndefined();
  });

  test('Jev reads none, so no wait and no "Retry in" line', async () => {
    const { port, waitRequests, actions } = waitPort([[DATE_MESSAGE, 'none']]);
    installJudgmentPort(port);
    const err = new ProviderError(DATE_MESSAGE, 429);
    expect(await readRetryWait(err, 'test.retry-wait')).toBeUndefined();
    expect(await readFormattedError(err, { site: 'test.retry-wait' })).not.toContain('Retry in');
    expect(waitRequests()).toHaveLength(1);
    expect(actions).toContain('took no retry wait from the message: no number reads as the wait');
  });
});

describe('a wait in minutes', () => {
  test('is read as minutes and converted by code to milliseconds', async () => {
    const { port, actions } = waitPort([[MINUTES_MESSAGE, { number: '5', unit: 'min' }]]);
    installJudgmentPort(port);
    const err = new ProviderError(MINUTES_MESSAGE, 429);
    expect(err.retryAfterMs).toBeUndefined();
    expect(await readRetryWait(err, 'test.retry-wait')).toBe(300_000);
    expect(await readFormattedError(err, { site: 'test.retry-wait' })).toContain('Retry in 300s');
    expect(actions).toContain('took a retry wait of 300000ms from the message (5 min)');
  });

  test('sets the synthetic provider cooldown for the rate-limited backend', async () => {
    const { port } = waitPort([[MINUTES_MESSAGE, { number: '5', unit: 'min' }]]);
    installJudgmentPort(port);
    const backend: LLMProvider = {
      name: 'backend-a',
      models: ['m1'],
      chat: async () => { throw new ProviderError(MINUTES_MESSAGE, 429); },
    } as unknown as LLMProvider;
    const catalog: CanonicalModel[] = [{
      id: 'model-x',
      tier: 'paid',
      backends: [{ providerName: 'backend-a', modelId: 'm1' }],
      backendCount: 1,
      keyedBackendCount: 1,
    }];
    const synthetic = new SyntheticProvider({ resolveProvider: () => backend, getCatalogModels: () => catalog, getBenchmarks: () => undefined });
    // Five minutes is past the provider's two-minute auto-wait, so it reports the cooldown at once.
    await expect(synthetic.chat({ model: 'model-x', messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow('Shortest cooldown expires in 300s');
  });
});

describe('what the site acts on', () => {
  test('an explicit Retry-After value is used as given, with no request', async () => {
    const { port, waitRequests } = waitPort([]);
    installJudgmentPort(port);
    const err = new ProviderError(MINUTES_MESSAGE, { statusCode: 429, retryAfterMs: 7_000 });
    expect(await readRetryWait(err, 'test.retry-wait')).toBe(7_000);
    expect(waitRequests()).toHaveLength(0);
  });

  test('a message with no number asks nothing', async () => {
    const { port, waitRequests } = waitPort([]);
    installJudgmentPort(port);
    expect(await readRetryWait(new ProviderError('Rate limit reached. Please slow down.', 429), 'test.retry-wait')).toBeUndefined();
    expect(waitRequests()).toHaveLength(0);
  });

  test('a reading too weak to act on gives no wait, and says so', async () => {
    const { port, actions } = waitPort([[MINUTES_MESSAGE, { number: '5', unit: 'min', confidence: 0.5 }]]);
    installJudgmentPort(port);
    expect(await readRetryWait(new ProviderError(MINUTES_MESSAGE, 429), 'test.retry-wait')).toBeUndefined();
    expect(actions.some((action) => action.startsWith('took no retry wait from the message: the reading of 5 min is'))).toBe(true);
  });
});
