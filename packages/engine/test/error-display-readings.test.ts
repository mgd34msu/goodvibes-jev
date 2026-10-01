/**
 * What error display does with each answer of the two readings it asks:
 * the connection-failure item of engine.failure-reading (the summary and
 * category of an error that got no HTTP response) and
 * engine.errors.display-payload (which bracketed parts of the message are
 * machine payload left out of the displayed message). The synchronous
 * normalizeError has neither reading and shows the error's own category and
 * message.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { EntryType, JudgmentPort, Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { forgetFailureReadings, installJudgmentPort, type ConnectionFailure } from '@goodvibes-jev/engine/errors';
import { ProviderError } from '../sdk/src/platform/types/errors.ts';
import { normalizeError, readFormattedError, readNormalizedError } from '../sdk/src/platform/utils/error-display.ts';
import { payloadSpans } from '../sdk/src/platform/utils/batteries/display-payload.ts';

/** A payload answer: yes, no, or a reading too unsure to act on. */
type PayloadAnswer = 'yes' | 'no' | 'unsure';

interface Answers {
  readonly connection?: ConnectionFailure;
  readonly payload?: (span: string) => PayloadAnswer;
}

function spanText(state: EntryType, name: string): string {
  const spans = (state as { spans?: Record<string, string> }).spans ?? {};
  return spans[`s${name.slice('payload_'.length)}`] ?? '';
}

/** A port answering both readings, recording every request and every recorded action. */
function readingsPort(answers: Answers) {
  const { port: inner, requests } = fakePort((name: string, question: Question, state: EntryType) => {
    if (name.startsWith('payload_')) {
      const answer = answers.payload?.(spanText(state, name)) ?? 'no';
      return noulAnswer(answer === 'yes' ? 0.97 : answer === 'no' ? 0.03 : 0.5);
    }
    if (name === 'category') return choiceAnswer(question, 'unknown', 0.95);
    if (name === 'connection_failure') return choiceAnswer(question, answers.connection ?? 'none', 0.95);
    // Numbers in payloads also ask the retry-wait battery. These fixtures name
    // no wait: answer its two Choice items rather than falling through to Noul.
    if (name === 'pick') return choiceAnswer(question, 'none', 0.95);
    if (name === 'unit') return choiceAnswer(question, 's', 0.95);
    return noulAnswer(0.03);
  });
  const actions: string[] = [];
  let next = 0;
  const port: JudgmentPort = {
    model: inner.model,
    async ask(request) {
      const result = await inner.ask(request);
      next += 1;
      return { ...result, decisionId: `d${next}` };
    },
    recorder: {
      recordReadings: () => undefined,
      recordAction: (_decisionId: string, action: string) => void actions.push(action),
    } as unknown as NonNullable<JudgmentPort['recorder']>,
  };
  return { port, requests, actions };
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

const payloadRequests = <R extends { readonly questions: object }>(requests: ReadonlyArray<R>): R[] =>
  requests.filter((request) => Object.keys(request.questions).some((name) => name.startsWith('payload_')));

describe('payloadSpans (bracket grammar)', () => {
  test('finds outermost balanced parts in order, numbered from 1', () => {
    const spans = payloadSpans('a [x] b {"k":{"n":[1,2]}} c');
    expect(spans.map((span) => span.text)).toEqual(['[x]', '{"k":{"n":[1,2]}}']);
    expect(spans.map((span) => span.number)).toEqual([1, 2]);
  });

  test('a bracket inside a quoted string does not close the part', () => {
    expect(payloadSpans('bad {"v":"a]}b"} end').map((span) => span.text)).toEqual(['{"v":"a]}b"}']);
  });

  test('an unbalanced bracket starts no part', () => {
    expect(payloadSpans('open [ never closed, then {"ok":1}').map((span) => span.text)).toEqual(['{"ok":1}']);
    expect(payloadSpans('mismatched [} here')).toEqual([]);
  });

  test('redaction placeholders are not parts', () => {
    expect(payloadSpans('/home/[REDACTED]/x [REDACTED_API_KEY] [REDACTED_TEXT length=12] [real]').map((span) => span.text)).toEqual(['[real]']);
  });
});

describe('display payload', () => {
  test('a yes removes the part, a no keeps it, and the action is recorded', async () => {
    const { port, actions } = readingsPort({ payload: (span) => (span.startsWith('{') ? 'yes' : 'no') });
    installJudgmentPort(port);
    const error = new ProviderError('Rate limit for model [gpt-4o] {"used":29870,"limit":30000} try later', 429);
    const normalized = await readNormalizedError(error, { site: 'test.display' });
    expect(normalized.message).toBe('Rate limit for model [gpt-4o] try later');
    expect(actions).toContain('removed 1 of 2 bracketed parts from the displayed message');
  });

  test('a reading too unsure to act on keeps the part', async () => {
    const { port } = readingsPort({ payload: () => 'unsure' });
    installJudgmentPort(port);
    const normalized = await readNormalizedError(new ProviderError('failed {"a":1}', 500), { site: 'test.display' });
    expect(normalized.message).toBe('failed {"a":1}');
  });

  test('every part of one message is asked in one request', async () => {
    const { port, requests } = readingsPort({ payload: () => 'yes' });
    installJudgmentPort(port);
    await readNormalizedError(new ProviderError('x {"a":1} y [1,2] z {"b":2}', 500), { site: 'test.display' });
    const asked = payloadRequests(requests);
    expect(asked).toHaveLength(1);
    expect(Object.keys(asked[0]!.questions).sort()).toEqual(['payload_1', 'payload_2', 'payload_3']);
    expect(asked[0]!.context?.site).toBe('test.display');
  });

  test('a message that is all payload shows the message itself', async () => {
    const { port } = readingsPort({ payload: () => 'yes' });
    installJudgmentPort(port);
    const normalized = await readNormalizedError(new ProviderError('[1,2,3]', 500), { site: 'test.display' });
    expect(normalized.message).toBe('[1,2,3]');
  });

  test('a whole-JSON message is parsed, not read', async () => {
    const { port, requests } = readingsPort({ payload: () => 'yes' });
    installJudgmentPort(port);
    const normalized = await readNormalizedError(new ProviderError('{"error":{"message":"Invalid model"}}', { statusCode: 404 }), { site: 'test.display' });
    expect(normalized.message).toBe('Invalid model');
    expect(payloadRequests(requests)).toHaveLength(0);
  });

  test('a message with no bracketed part asks nothing about payload', async () => {
    const { port, requests } = readingsPort({});
    installJudgmentPort(port);
    await readNormalizedError(new ProviderError('plain words only', 500), { site: 'test.display' });
    expect(payloadRequests(requests)).toHaveLength(0);
  });

  test('the synchronous path shows the message unstripped and asks nothing', () => {
    const { port, requests } = readingsPort({ payload: () => 'yes' });
    installJudgmentPort(port);
    expect(normalizeError(new Error('failed {"a":1} here')).message).toBe('failed {"a":1} here');
    expect(requests).toHaveLength(0);
  });
});

describe('connection failure', () => {
  test('refused: network, with the cannot-connect summary naming the provider', async () => {
    const { port } = readingsPort({ connection: 'refused' });
    installJudgmentPort(port);
    const normalized = await readNormalizedError(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { site: 'test.display', provider: 'ollama' });
    expect(normalized.category).toBe('network');
    expect(normalized.summary).toBe('Cannot connect to ollama. Check whether the service is reachable.');
    expect(normalized.message).toBe('connect ECONNREFUSED 127.0.0.1:11434');
  });

  test('timed out: timeout, with the timed-out summary', async () => {
    const { port } = readingsPort({ connection: 'timed_out' });
    installJudgmentPort(port);
    const formatted = await readFormattedError(new Error('ETIMEDOUT: companion pairing handshake'), { site: 'test.display' });
    expect(formatted.split('\n')[0]).toBe('Connection timed out before the request completed.');
    expect((await readNormalizedError(new Error('ETIMEDOUT: companion pairing handshake'), { site: 'test.display' })).category).toBe('timeout');
  });

  test('DNS failure: network, with the DNS summary', async () => {
    const { port } = readingsPort({ connection: 'dns_failed' });
    installJudgmentPort(port);
    const normalized = await readNormalizedError(new Error('getaddrinfo ENOTFOUND api.example.com'), { site: 'test.display' });
    expect(normalized.category).toBe('network');
    expect(normalized.summary).toBe('DNS lookup failed for the provider. Check the base URL and network.');
  });

  test('none: the message is the summary', async () => {
    const { port } = readingsPort({ connection: 'none' });
    installJudgmentPort(port);
    const normalized = await readNormalizedError(new Error('something else broke'), { site: 'test.display' });
    expect(normalized.summary).toBe('something else broke');
    expect(normalized.category).toBe('unknown');
  });

  test('an errno on the structured code field fixes the category without the wording', async () => {
    const { port } = readingsPort({ connection: 'refused' });
    installJudgmentPort(port);
    const error = Object.assign(new Error('socket trouble'), { code: 'ETIMEDOUT' });
    const normalized = await readNormalizedError(error, { site: 'test.display' });
    expect(normalized.category).toBe('timeout');
    expect(normalized.summary).toMatch(/^Cannot connect/);
  });

  test('an error with an HTTP status is not read for a connection failure', async () => {
    const { port, requests } = readingsPort({ connection: 'refused' });
    installJudgmentPort(port);
    const normalized = await readNormalizedError(new ProviderError('upstream ECONNREFUSED behind the gateway', 502), { site: 'test.display' });
    expect(normalized.category).toBe('service');
    expect(normalized.summary).toBe('upstream ECONNREFUSED behind the gateway');
    expect(requests).toHaveLength(0);
  });

  test('the synchronous path keeps the error\'s own category and message', () => {
    const normalized = normalizeError(new Error('ECONNREFUSED 127.0.0.1:3000'));
    expect(normalized.category).toBe('unknown');
    expect(normalized.summary).toBe('ECONNREFUSED 127.0.0.1:3000');
  });
});
