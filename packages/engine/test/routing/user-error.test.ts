import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { EntryType, Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { readUserErrorClass, readUserFacingError, readUserFacingErrorLine, type ErrorClass } from '../../sdk/src/platform/routing/user-error.js';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

/**
 * A port answering as the failure reading would for each wording in the TUI's
 * classifier table: the phrase in the state decides the answers.
 */
function wordingPort() {
  const says = (state: EntryType, ...phrases: string[]) => phrases.some((phrase) => String(state).toLowerCase().includes(phrase));
  return fakePort((name: string, question: Question, state: EntryType) => {
    if (name === 'failure__category') {
      const category = says(state, 'api key', 'unauthorized', 'authentication', 'session has ended') ? 'authentication'
        : says(state, 'fetch failed', 'socket hang up', 'connection refused') ? 'network'
          : says(state, 'timeout') ? 'timeout' : 'unknown';
      return choiceAnswer(question, category, 0.95);
    }
    if (name === 'failure__connection_failure') return choiceAnswer(question,
      says(state, 'connection refused') ? 'refused' : says(state, 'timeout') ? 'timed_out' : 'none', 0.95);
    if (name === 'failure__rate_limited') return noulAnswer(says(state, 'rate', 'too many requests', 'quota') ? 0.95 : 0.05);
    if (name === 'failure__context_exceeded') return noulAnswer(says(state, 'context', 'too many tokens', 'too long') ? 0.95 : 0.05);
    if (name === 'failure__transient_network') return noulAnswer(says(state, 'fetch failed', 'socket hang up', 'connection refused', 'timeout') ? 0.95 : 0.05);
    if (name === 'user__session_ended') return noulAnswer(says(state, 'session has ended') ? 0.95 : 0.05);
    return noulAnswer(0.05);
  });
}

describe('structure decides without a reading', () => {
  const cases: { label: string; err: unknown; expected: ErrorClass }[] = [
    { label: 'status 429', err: { status: 429, message: 'Too Many Requests' }, expected: 'rate-limit' },
    { label: 'ECONNREFUSED code', err: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' }), expected: 'network' },
    { label: 'ETIMEDOUT code', err: Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }), expected: 'network' },
    { label: 'cause errno', err: Object.assign(new Error('request failed'), { cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND api.example' } }), expected: 'network' },
    { label: 'null', err: null, expected: 'generic' },
    { label: 'undefined', err: undefined, expected: 'generic' },
  ];
  for (const { label, err, expected } of cases) {
    test(`${label} is ${expected}`, async () => {
      expect((await readUserErrorClass(err)).kind).toBe(expected);
    });
  }
});

describe('wording is read', () => {
  const cases: { label: string; err: unknown; expected: ErrorClass }[] = [
    { label: 'status 401', err: { status: 401, message: 'Unauthorized' }, expected: 'auth' },
    { label: 'invalid api key message', err: new Error('Invalid API key provided'), expected: 'auth' },
    { label: 'Unauthorized string', err: 'Unauthorized', expected: 'auth' },
    { label: 'rate_limit message', err: new Error('rate_limit exceeded'), expected: 'rate-limit' },
    { label: 'quota exceeded', err: new Error('quota exceeded for this billing period'), expected: 'rate-limit' },
    { label: 'context length', err: new Error('This model\'s maximum context length is 128000 tokens'), expected: 'context-overflow' },
    { label: 'too many tokens', err: new Error('too many tokens in conversation'), expected: 'context-overflow' },
    { label: 'fetch failed', err: new Error('fetch failed'), expected: 'network' },
    { label: 'socket hang up', err: new Error('socket hang up'), expected: 'network' },
    { label: 'network timeout', err: new Error('network timeout after 30s'), expected: 'network' },
    { label: 'unknown provider failure', err: new Error('some unknown provider failure'), expected: 'generic' },
  ];
  for (const { label, err, expected } of cases) {
    test(`${label} reads as ${expected}`, async () => {
      installJudgmentPort(wordingPort().port);
      expect((await readUserErrorClass(err)).kind).toBe(expected);
    });
  }

  test('the failure questions and the session question ride one request', async () => {
    const { port, requests } = wordingPort();
    installJudgmentPort(port);
    await readUserErrorClass(new Error('fetch failed'));
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0]!.questions)).toContain('user__session_ended');
    expect(Object.keys(requests[0]!.questions)).toContain('failure__category');
  });

  test('worded errors need the port', async () => {
    await expect(readUserErrorClass(new Error('fetch failed'))).rejects.toBeInstanceOf(JudgmentPortMissingError);
  });
});

describe('the line', () => {
  test('a subscription session that ended says so instead of blaming the key', async () => {
    installJudgmentPort(wordingPort().port);
    const result = await readUserFacingError(Object.assign(new Error('Your subscription session has ended. Sign in again.'), { status: 401 }));
    expect(result.message).toBe('Authentication failed: your provider subscription session has ended.');
    expect(result.action).toBe('Run /login to sign in to the provider again.');
  });

  test('the TUI wording for each class is unchanged', async () => {
    installJudgmentPort(wordingPort().port);
    expect(await readUserFacingErrorLine({ status: 429, message: 'slow down' })).toBe('Rate limit reached: the provider is throttling requests. Wait a moment and retry, or switch models with /model.');
    expect(await readUserFacingErrorLine({ status: 401, message: 'Unauthorized' })).toBe('Authentication failed: the provider rejected your API key. Run /login to re-authenticate or check your API key.');
    const generic = await readUserFacingError(new Error('some unknown provider failure'));
    expect(generic.message).toBe('Provider error: some unknown provider failure');
    expect(generic.action).toBe('Retry your last message, or switch models with /model.');
  });
});
