import { describe, expect, test } from 'bun:test';
import {
  choice,
  createSystemOnePort,
  endpointKind,
  judgmentConfigFromEnv,
  JudgmentError,
  noul,
  score,
  type JudgmentConfig,
} from '../src/index.ts';

type Handler = (body: Record<string, unknown>) => Response;

function portWith(handler: Handler) {
  const calls: Record<string, unknown>[] = [];
  const config: JudgmentConfig = {
    endpoint: { kind: 'hosted', baseURL: 'https://judge.test', apiKey: 'test-key' },
    model: 'jev-1.13.0',
    timeoutMs: 1_000,
    retry: { maxRetries: 0 },
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(body);
      return handler(body);
    },
  };
  return { port: createSystemOnePort(config), calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const QUESTIONS = {
  urgent: noul('Does this convey urgency?'),
  team: choice('Which team handles this?', { billing: null, technical: null }),
  mood: score('How frustrated is the sender?', ['calm', 'frustrated', 'angry']),
};

const GOOD_ANSWERS = {
  urgent: { type: 'noul', noul: 0.9 },
  team: { type: 'choice', choice: 'billing', confidence: 0.8, probabilities: { billing: 0.9, technical: 0.1 } },
  mood: {
    type: 'score',
    score: 1.2,
    confidence: 0.7,
    legend: { '0': 'calm', '1': 'frustrated', '2': 'angry' },
    probabilities: { '0': 0, '1': 0.8, '2': 0.2 },
  },
};

describe('createSystemOnePort', () => {
  test('sends state, questions and the pinned model; returns typed answers with metadata', async () => {
    const { port, calls } = portWith(() =>
      json(200, { model: 'jev-1.13.0', answers: GOOD_ANSWERS, usage: { input_tokens: 300, output_tokens: 40 } }, {
        'x-typesafe-request-id': 'req-1',
      }),
    );
    const result = await port.ask({ state: 'Payouts failing for 3 days', questions: QUESTIONS });
    expect(calls[0]?.['model']).toBe('jev-1.13.0');
    expect(calls[0]?.['state']).toBe('Payouts failing for 3 days');
    expect(result.answers.urgent.noul).toBe(0.9);
    expect(result.answers.team.choice).toBe('billing');
    expect(result.answers.mood.score).toBe(1.2);
    expect(result.model).toBe('jev-1.13.0');
    expect(result.requestedModel).toBe('jev-1.13.0');
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 40 });
    expect(result.requestId).toBe('req-1');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test('a per-call model override is sent and reported', async () => {
    const { port, calls } = portWith(() =>
      json(200, { model: 'jev-9.0.0', answers: { urgent: GOOD_ANSWERS.urgent }, usage: { input_tokens: 1, output_tokens: 1 } }),
    );
    const result = await port.ask({ state: 'x', questions: { urgent: QUESTIONS.urgent }, model: 'jev-9.0.0' });
    expect(calls[0]?.['model']).toBe('jev-9.0.0');
    expect(result.requestedModel).toBe('jev-9.0.0');
  });

  test.each([
    ['no questions', {}],
    ['one-option choice', { c: choice('q', { only: null }) }],
    ['one-level score', { s: score('q', ['a'] as unknown as readonly [string, string]) }],
    ['eleven-level score', { s: score('q', ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10']) }],
    [
      '256-option choice',
      { c: choice('q', Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, null]))) },
    ],
  ])('rejects %s before sending', async (_label, questions) => {
    const { port, calls } = portWith(() => json(200, {}));
    const error = await port.ask({ state: 'x', questions }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JudgmentError);
    expect((error as JudgmentError).kind).toBe('invalid-request');
    expect(calls).toHaveLength(0);
  });

  test.each([
    ['missing answer', { urgent: GOOD_ANSWERS.urgent, team: GOOD_ANSWERS.team }],
    ['wrong answer type', { ...GOOD_ANSWERS, urgent: { type: 'score', score: 1 } }],
    ['noul out of range', { ...GOOD_ANSWERS, urgent: { type: 'noul', noul: 1.4 } }],
    ['choice outside criteria', { ...GOOD_ANSWERS, team: { ...GOOD_ANSWERS.team, choice: 'sales' } }],
    ['choice missing a probability', { ...GOOD_ANSWERS, team: { ...GOOD_ANSWERS.team, probabilities: { billing: 1 } } }],
    ['choice has zero total probability', { ...GOOD_ANSWERS, team: { ...GOOD_ANSWERS.team, probabilities: { billing: 0, technical: 0 } } }],
    ['choice exceeds unit total probability', { ...GOOD_ANSWERS, team: { ...GOOD_ANSWERS.team, probabilities: { billing: 1, technical: 1 } } }],
    ['choice is not a maximum', { ...GOOD_ANSWERS, team: { ...GOOD_ANSWERS.team, probabilities: { billing: 0.1, technical: 0.9 } } }],
    ['score above the top level', { ...GOOD_ANSWERS, mood: { ...GOOD_ANSWERS.mood, score: 2.5 } }],
    ['score missing a level', { ...GOOD_ANSWERS, mood: { ...GOOD_ANSWERS.mood, probabilities: { '0': 1 } } }],
  ])('treats %s as an invalid response', async (_label, answers) => {
    const { port } = portWith(() => json(200, { model: 'jev-1.13.0', answers, usage: { input_tokens: 1, output_tokens: 1 } }));
    const error = await port.ask({ state: 'x', questions: QUESTIONS }).catch((e: unknown) => e);
    expect((error as JudgmentError).kind).toBe('invalid-response');
  });

  test.each([
    [401, 'rejected'],
    [422, 'rejected'],
    [429, 'unavailable'],
    [500, 'unavailable'],
    [529, 'unavailable'],
  ] as const)('maps HTTP %i to %s', async (status, kind) => {
    const { port } = portWith(() => json(status, { error: 'nope' }, { 'x-typesafe-request-id': 'req-9' }));
    const error = (await port.ask({ state: 'x', questions: { urgent: QUESTIONS.urgent } }).catch((e: unknown) => e)) as JudgmentError;
    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
    expect(error.requestId).toBe('req-9');
  });

  test('a network failure is unavailable', async () => {
    const port = createSystemOnePort({
      endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:9', apiKey: 'k' },
      model: 'jev-1.13.0',
      timeoutMs: 1_000,
      retry: { maxRetries: 0 },
      fetch: async () => {
        throw new TypeError('connection refused');
      },
    });
    const error = (await port.ask({ state: 'x', questions: { urgent: QUESTIONS.urgent } }).catch((e: unknown) => e)) as JudgmentError;
    expect(error.kind).toBe('unavailable');
  });

  test('a cancelled call is aborted', async () => {
    const { port } = portWith(() => json(200, {}));
    const controller = new AbortController();
    controller.abort();
    const error = (await port
      .ask({ state: 'x', questions: { urgent: QUESTIONS.urgent }, signal: controller.signal })
      .catch((e: unknown) => e)) as JudgmentError;
    expect(error.kind).toBe('aborted');
  });
});

describe('endpoint configuration', () => {
  test('loopback base URLs are local, everything else hosted', () => {
    expect(endpointKind('http://localhost:8080')).toBe('local');
    expect(endpointKind('http://127.0.0.2:8080')).toBe('local');
    expect(endpointKind('http://[::1]:8080')).toBe('local');
    expect(endpointKind('https://api.typesafe.ai')).toBe('hosted');
  });

  test('config from env pins the model and defaults to the hosted endpoint', () => {
    const config = judgmentConfigFromEnv({ TYPESAFE_API_KEY: ' key \n' });
    expect(config.endpoint).toEqual({ kind: 'hosted', baseURL: 'https://api.typesafe.ai', apiKey: 'key' });
    expect(config.model).toBe('jev-1.13.0');
  });

  test('a loopback TYPESAFE_BASE_URL selects the local model on the same protocol', () => {
    const config = judgmentConfigFromEnv({
      TYPESAFE_API_KEY: 'k',
      TYPESAFE_BASE_URL: 'http://localhost:7000',
      TYPESAFE_DEFAULT_MODEL: 'local-s1',
    });
    expect(config.endpoint.kind).toBe('local');
    expect(config.model).toBe('local-s1');
  });

  test('a missing key is an error, not a silent default', () => {
    expect(() => judgmentConfigFromEnv({})).toThrow(JudgmentError);
  });
});
