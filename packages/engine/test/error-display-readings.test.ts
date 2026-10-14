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
import { forgetFailureReadings, installJudgmentPort, readFailure, type ConnectionFailure } from '@goodvibes-jev/engine/errors';
import { ProviderError } from '../sdk/src/platform/types/errors.ts';
import { normalizeError, readFormattedError, readNormalizedError } from '../sdk/src/platform/utils/error-display.ts';
import { payloadSpans } from '../sdk/src/platform/utils/batteries/display-payload.ts';
import type { RedactionPart } from '../sdk/src/platform/utils/batteries/redaction.ts';
import { authoredPrivacyAnswer, errorText as text, errorSpan as span } from './_helpers/authored-error-readings.ts';
import { registerAccountIdentityRedaction } from '../sdk/src/platform/utils/redaction.ts';

const publicLines = [
  '[1,2,3]', 'plain words only', 'connect ECONNREFUSED 127.0.0.1:11434',
  'getaddrinfo ENOTFOUND api.example.com', 'something else broke', 'socket trouble',
  'upstream ECONNREFUSED behind the gateway',
  'No credits remain for the API.',
  'You exceeded your current quota, please check your plan and billing details. insufficient_quota',
  'No credits remain for the API. [REDACTED_GITHUB_TOKEN]',
];
const authoredParts: readonly (readonly RedactionPart[])[] = [
  ...publicLines.map((line) => [text(line)]),
  [text('Rate limit for model [gpt-4o] {"used":'), span('used', 1), text(',"limit":'), span('limit', 2), text('} try later')],
  [text('failed {"used":'), span('used', 1), text('}')],
  [text('x {"used":'), span('used', 1), text('} y [1,2] z {"limit":'), span('limit', 2), text('}')],
  [text('{"code":'), span('code', 1), text('}')],
  [text('ETIMEDOUT: '), span('ETIMEDOUT', 1), text('')],
];
const privacyAnswer = authoredPrivacyAnswer({ parts: authoredParts,
  fields: { used: 'other', limit: 'other', code: 'other', ETIMEDOUT: 'content' } });

/** A payload answer: yes, no, or a reading too unsure to act on. */
type PayloadAnswer = 'yes' | 'no' | 'unsure';

interface Answers {
  readonly connection?: ConnectionFailure;
  readonly payload?: (span: string) => PayloadAnswer;
  readonly billing?: boolean;
}

function spanText(state: EntryType, name: string): string {
  const spans = (state as { spans?: Record<string, string> }).spans ?? {};
  return spans[`s${name.slice('payload_'.length)}`] ?? '';
}

/** A port answering both readings, recording every request and every recorded action. */
function readingsPort(answers: Answers) {
  const { port: inner, requests } = fakePort((name: string, question: Question, state: EntryType) => {
    const privacy = privacyAnswer(name, question, state);
    if (privacy !== undefined) return privacy;
    if (name.startsWith('payload_')) {
      const answer = answers.payload?.(spanText(state, name)) ?? 'no';
      return noulAnswer(answer === 'yes' ? 0.97 : answer === 'no' ? 0.03 : 0.5);
    }
    if (name === 'category') return choiceAnswer(question, answers.billing ? 'billing' : 'unknown', 0.95);
    if (name === 'connection_failure') return choiceAnswer(question, answers.connection ?? 'none', 0.95);
    // Numbers in payloads also ask the retry-wait battery. These fixtures name
    // no wait: answer its two Choice items rather than falling through to Noul.
    if (name === 'pick') return choiceAnswer(question, 'none', 0.95);
    if (name === 'unit') return choiceAnswer(question, 's', 0.95);
    if (['billing', 'rate_limited', 'context_exceeded', 'transient_network', 'provider_unusable', 'before_response'].includes(name)
      || name.startsWith('fits_n')) return noulAnswer(answers.billing && name === 'billing' ? 0.97 : 0.03);
    throw new Error('Unexpected authored display question');
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
    },
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
    const normalized = await readNormalizedError(new ProviderError('failed {"used":1}', 500), { site: 'test.display' });
    expect(normalized.message).toBe('failed {"used":1}');
  });

  test('every part of one message is asked in one request', async () => {
    const { port, requests } = readingsPort({ payload: () => 'yes' });
    installJudgmentPort(port);
    await readNormalizedError(new ProviderError('x {"used":1} y [1,2] z {"limit":2}', 500), { site: 'test.display' });
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
    const normalized = await readNormalizedError(new ProviderError('{"code":"model_not_found"}', { statusCode: 404 }), { site: 'test.display' });
    expect(normalized.message).toBe('model_not_found');
    expect(payloadRequests(requests)).toHaveLength(0);
  });

  test('a message with no bracketed part asks nothing about payload', async () => {
    const { port, requests } = readingsPort({});
    installJudgmentPort(port);
    await readNormalizedError(new ProviderError('plain words only', 500), { site: 'test.display' });
    expect(payloadRequests(requests)).toHaveLength(0);
  });

  test('the synchronous path preserves local diagnostics without asking the payload battery', () => {
    const { port, requests } = readingsPort({ payload: () => 'yes' });
    installJudgmentPort(port);
    const error = new Error('failed {"a":1} here');
    expect(normalizeError(error).message).toBe('failed {"a":1} here');
    expect(error.message).toBe('failed {"a":1} here');
    expect(payloadRequests(requests)).toHaveLength(0);
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
    expect(requests.filter((request) => 'connection_failure' in request.questions)).toHaveLength(0);
  });

  test('the synchronous path keeps the error\'s own category and message', () => {
    const normalized = normalizeError(new Error('ECONNREFUSED 127.0.0.1:3000'));
    expect(normalized.category).toBe('unknown');
    expect(normalized.summary).toBe('ECONNREFUSED 127.0.0.1:3000');
  });
});

describe('first-call protected error normalization', () => {
  test.each([
    [400, 'No credits remain for the API.'],
    [429, 'You exceeded your current quota, please check your plan and billing details. insufficient_quota'],
  ] as const)('settles a first-call provider %i billing failure after privacy qualification', async (status, message) => {
    const { port, requests } = readingsPort({ billing: true });
    installJudgmentPort(port);
    const error = new ProviderError(message, { statusCode: status, provider: 'test-provider' });
    const normalized = await readNormalizedError(error, { site: 'test.first-call' });
    expect(normalized.category).toBe('billing');
    expect(normalized.hint).toContain('credits');
    const failureRequests = requests.filter((request) => 'billing' in request.questions);
    expect(failureRequests).toHaveLength(1);
    expect(failureRequests[0]!.state).toContain(`Message: ${message}`);
    expect(error.message).toBe(message);
  });

  test('issuer credentials never reach prose classification or retry evidence', async () => {
    const { port, requests } = readingsPort({ billing: true });
    installJudgmentPort(port);
    const credential = 'ghp_' + '0123456789'.repeat(4);
    const error = new ProviderError(`No credits remain for the API. ${credential}`, 400);
    const normalized = await readNormalizedError(error, { site: 'test.protected' });
    expect(normalized.category).toBe('billing');
    expect(normalized.message).toContain('[REDACTED_GITHUB_TOKEN]');
    expect(JSON.stringify(requests.map((request) => ({ state: request.state, questions: request.questions })))).not.toContain(credential);
    expect(error.rawMessage).toContain(credential);
  });

  test('unqualified wording stays held without a prose-classification guess', async () => {
    const { port, requests } = readingsPort({ billing: true });
    installJudgmentPort(port);
    const normalized = await readNormalizedError(new ProviderError('Unspecified private diagnostic', 400), { site: 'test.unknown' });
    expect(normalized.message).toBe('[REDACTED]');
    expect(normalized.category).toBe('bad_request');
    expect(requests.filter((request) => 'billing' in request.questions || 'pick' in request.questions)).toHaveLength(0);
  });

  test('PAN-bearing prose is held before any semantic request', async () => {
    const { port, requests } = readingsPort({ billing: true });
    installJudgmentPort(port);
    const normalized = await readNormalizedError(new ProviderError('No credits remain for card 4111111111111111', 400), { site: 'test.pan' });
    expect(normalized.message).toBe('[REDACTED]');
    expect(normalized.category).toBe('bad_request');
    expect(requests).toHaveLength(0);
  });

  test('a protected password assignment settles with held prose and native facts', async () => {
    const parts = [text('Native context owner revoked password='), span('password'), text('')];
    const residual = JSON.stringify({ parts: [text('Native context owner revoked password='),
      { kind: 'withheld', reference: 'span-1' }, text('')] });
    const { port, requests } = fakePort((name, question, state) => {
      if (name === 'kind' && JSON.stringify(state) === JSON.stringify({ field: 'password' }))
        return choiceAnswer(question, 'secret', 0.99);
      if (name === 'credentialRemains' && JSON.stringify(state) === residual) return noulAnswer(0.01);
      throw new Error('Unexpected protected-assignment reading');
    });
    installJudgmentPort(port);
    const secret = 'SYNTHETIC_PRIVATE_CONTEXT';
    const error = new ProviderError(`Native context owner revoked password=${secret}`, 400);
    const failure = await readFailure({ message: 'No credits remain for the API.', status: 400 },
      'test.prior-billing', { port: readingsPort({ billing: true }).port });
    expect(failure).toMatchObject({ billing: true });
    const normalized = await readNormalizedError(error,
      { site: 'test.protected-assignment', failure });
    expect(normalized.message).toBe(error.message);
    expect(normalized.summary).toBe(error.message);
    expect(normalized.category).toBe('bad_request');
    expect(normalized.statusCode).toBe(400);
    expect(requests.map((request) => request.state)).toEqual([{ field: 'password' },
      { parts: parts.map((part) => part.kind === 'span' ? { kind: 'withheld', reference: part.reference } : part) }]);
    expect(JSON.stringify(requests)).not.toContain(secret);
    expect(error.message).toContain(secret);
  });

  test('a PAN in native evidence holds prose before any feature reading', async () => {
    const { port, requests } = readingsPort({ connection: 'refused' });
    installJudgmentPort(port);
    const pan = '4111111111111111';
    const error = Object.assign(new Error('socket trouble'), { code: pan, statusCode: 502 });
    const normalized = await readNormalizedError(error, { site: 'test.native-pan' });
    expect(normalized.message).toBe('socket trouble');
    expect(normalized.summary).toBe('socket trouble');
    expect(normalized.category).toBe('service');
    expect(normalized.statusCode).toBe(502);
    expect(normalized.code).toBeUndefined();
    expect(requests.map((request) => Object.keys(request.questions)))
      .toEqual([['lineHasCredential', 'spanIsCredential']]);
    expect(JSON.stringify(requests)).not.toContain(pan);
    expect(error.code).toBe(pan);
  });

  test.each(['error', 'cause', 'options', 'redaction-source', 'redaction-aba', 'port', 'port-aba', 'cancel'] as const)('retains original %s through the first privacy await', async (change) => {
    const { port: inner, requests } = readingsPort({ billing: true });
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const port: JudgmentPort = { ...inner, async ask(request) {
      if ('lineHasCredential' in request.questions) { entered.resolve(); await released.promise; }
      return inner.ask(request);
    } };
    installJudgmentPort(port);
    const controller = new AbortController();
    const cause = new Error('Private native cause');
    const error = new ProviderError('No credits remain for the API.', { statusCode: 400, cause });
    const options = { site: 'test.current', provider: 'test-provider', signal: controller.signal };
    const pending = readNormalizedError(error, options);
    await entered.promise;
    if (change === 'error') error.message = 'Changed diagnostic';
    else if (change === 'cause') cause.message = 'Changed private native cause';
    else if (change === 'options') options.provider = 'other-provider';
    else if (change === 'redaction-source') registerAccountIdentityRedaction(() => ({ homeDirectory: '/home/test', userName: 'test' }));
    else if (change === 'redaction-aba') { registerAccountIdentityRedaction(() => ({ homeDirectory: '/home/test', userName: 'test' })); registerAccountIdentityRedaction(null); }
    else if (change === 'port') installJudgmentPort(readingsPort({ billing: true }).port);
    else if (change === 'port-aba') { installJudgmentPort(readingsPort({ billing: true }).port); installJudgmentPort(port); }
    else controller.abort();
    try {
      released.resolve();
      await expect(pending).rejects.toThrow();
      expect(requests.filter((request) => 'billing' in request.questions)).toHaveLength(0);
    } finally { registerAccountIdentityRedaction(null); released.resolve(); }
  });

  test('an asynchronous currentness callback cannot qualify the source', async () => {
    const { port, requests } = readingsPort({ billing: true });
    installJudgmentPort(port);
    await expect(readNormalizedError(new ProviderError('No credits remain for the API.', 400),
      { site: 'test.async-current', assertCurrent: async () => {} })).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
});
