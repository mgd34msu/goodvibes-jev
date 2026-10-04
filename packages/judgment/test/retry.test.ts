import { describe, expect, test } from 'bun:test';
import { getEventListeners } from 'node:events';
import { APIError } from '@typesafe-ai/sdk';
import { createSystemOnePort, JudgmentError, noul, PINNED_MODEL, SqliteDecisionLog, withDecisionLog, type JudgmentConfig, type JudgmentPort } from '../src/index.ts';
import { delay, retryDelay, retryPolicy } from '../src/port/retry.ts';

const request = { state: 'synthetic', questions: { yes: noul('Synthetic question') } };
const good = (id = 'ok') => Response.json({ model: PINNED_MODEL, answers: { yes: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1 } }, { headers: { 'x-typesafe-request-id': id } });
const bad = () => Response.json({}, { status: 503 });
const config = (fetch: NonNullable<JudgmentConfig['fetch']>): JudgmentConfig => ({
  endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic-key' },
  model: PINNED_MODEL, timeoutMs: 15, retry: { backoffInitialMs: 1, backoffMaxMs: 1, backoffJitter: 0 }, fetch,
});

const apiError = (headers: Record<string, string>) => APIError.fromResponse(429, {}, new Headers(headers));

describe('shared retry timing and cancellation', () => {
  test('all timing settings remain finite, positive and ordered, with no finite retry controls', () => {
    for (const value of [0, -1, Infinity, NaN, 60_001]) {
      expect(() => retryPolicy({ backoffInitialMs: value })).toThrow(JudgmentError);
      expect(() => retryPolicy({ backoffMaxMs: value })).toThrow(JudgmentError);
    }
    expect(() => retryPolicy({ backoffInitialMs: 5, backoffMaxMs: 1 })).toThrow(JudgmentError);
    expect(() => retryPolicy({ maxRetries: 0 } as JudgmentConfig['retry'])).toThrow(JudgmentError);
    expect(() => retryPolicy({ apiConnectionError: false } as JudgmentConfig['retry'])).toThrow(JudgmentError);
  });

  test('backoff saturates, jitter cannot hot loop, rate guidance is a minimum', () => {
    const policy = retryPolicy({ backoffInitialMs: 10, backoffMaxMs: 100, backoffJitter: 0 });
    expect([0, 1, 2, 50, 10_000].map((attempt) => retryDelay(undefined, attempt, policy))).toEqual([10, 20, 40, 100, 100]);
    expect(retryDelay(apiError({ 'retry-after': '3600' }), 50, policy)).toBe(3_600_000);
    expect(retryDelay(apiError({ 'retry-after-ms': 'garbage', 'retry-after': '3600' }), 50, policy)).toBe(3_600_000);
    expect(retryDelay(apiError({ 'retry-after-ms': '200', 'retry-after': '3600' }), 50, policy)).toBe(200);
    expect(retryDelay(apiError({ 'retry-after': '0' }), 50, policy)).toBe(100);
    expect(retryDelay(apiError({ 'retry-after': '-1' }), 50, policy)).toBe(100);
    expect(retryDelay(apiError({ 'retry-after': 'Infinity' }), 50, policy)).toBe(100);
    const fullJitter = retryPolicy({ backoffInitialMs: 1, backoffMaxMs: 1, backoffJitter: 1 });
    for (let i = 0; i < 100; i++) expect(retryDelay(undefined, i, fullJitter)).toBe(1);
  });

  test('HTTP date guidance is honored beyond the old 60-second ceiling', () => {
    const date = new Date(Date.now() + 3_600_000).toUTCString();
    expect(retryDelay(apiError({ 'retry-after': date }), 0, retryPolicy({}))).toBeGreaterThan(3_598_000);
  });

  test('even a delay longer than the timer integer range is immediately abortable', async () => {
    const controller = new AbortController();
    const waiting = delay(9_000_000_000, controller.signal);
    controller.abort(new Error('stop'));
    await expect(waiting).rejects.toThrow('stop');
  });
});

describe('shared attempt ownership', () => {
  test('every retry rechecks current authority after backoff and before any transmission', async () => {
    let calls = 0;
    let guards = 0;
    const port = createSystemOnePort(config(async () => { calls++; return bad(); }));
    await expect(port.ask({ ...request, beforeAttempt: () => {
      if (++guards === 3) throw new Error('revoked secret content');
    } })).rejects.toMatchObject({ kind: 'rejected', message: 'the judgment attempt is no longer authorized' });
    expect(guards).toBe(3);
    expect(calls).toBe(2);
  });

  test('async authority guards fail closed and consume their rejection', async () => {
    let calls = 0;
    const port = createSystemOnePort(config(async () => { calls++; return good(); }));
    await expect(port.ask({ ...request, beforeAttempt: async () => { throw new Error('not allowed'); } })).rejects.toMatchObject({ kind: 'invalid-request' });
    expect(calls).toBe(0);
  });

  test('cancellation by the attempt guard prevents the initial transmission', async () => {
    let calls = 0;
    const controller = new AbortController();
    const port = createSystemOnePort(config(async () => { calls++; return good(); }));
    await expect(port.ask({ ...request, signal: controller.signal, beforeAttempt: () => controller.abort() })).rejects.toMatchObject({ kind: 'aborted' });
    expect(calls).toBe(0);
  });

  test.each(['sync', 'async'] as const)('a broken %s progress observer cannot decide or duplicate the reading', async (mode) => {
    let calls = 0;
    const port = createSystemOnePort(config(async () => ++calls < 4 ? bad() : good()));
    const onRetry = mode === 'sync' ? () => { throw new Error('observer'); } : async () => { throw new Error('observer'); };
    expect((await port.ask({ ...request, onRetry })).answers.yes.noul).toBe(0.9);
    expect(calls).toBe(4);
  });

  test('late aborted response cannot change final evidence or create a duplicate decision', async () => {
    let resolveFirst: (response: Response) => void = () => {};
    let calls = 0;
    const port = createSystemOnePort(config(async () => ++calls === 1 ? await new Promise<Response>((resolve) => { resolveFirst = resolve; }) : good('final-request')));
    using log = new SqliteDecisionLog(':memory:');
    const result = await withDecisionLog(port, log).ask(request);
    const before = JSON.stringify(result);
    resolveFirst(good('late-request'));
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(JSON.stringify(result)).toBe(before);
    expect(result.requestId).toBe('final-request');
    expect(log.query()).toHaveLength(1);
    expect(log.query()[0]?.requestId).toBe('final-request');
    expect(calls).toBe(2);
  });

  test('recording admits one payload and model before asynchronous settings acquisition', async () => {
    let begin!: () => void;
    const entered = new Promise<void>((resolve) => { begin = resolve; });
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    let transmitted: unknown;
    const transport = createSystemOnePort(config(async (_url, init) => {
      transmitted = JSON.parse(String(init?.body));
      return good();
    }));
    let defaultModel = PINNED_MODEL;
    const settings: JudgmentPort = { get model() { return defaultModel; }, async ask(request) {
      begin(); await wait; return transport.ask(request);
    } };
    using log = new SqliteDecisionLog(':memory:');
    const caller = { state: { revision: 'admitted' }, questions: { yes: noul('admitted question') } };
    const pending = withDecisionLog(settings, log).ask(caller);
    await entered;
    caller.state.revision = 'changed'; caller.questions.yes.instructions = 'changed question'; defaultModel = 'jev-9.0.0';
    release();
    await pending;
    expect(transmitted).toMatchObject({ state: { revision: 'admitted' }, questions: { yes: { instructions: 'admitted question' } }, model: PINNED_MODEL });
    expect(log.query()).toHaveLength(1);
    expect(log.query()[0]?.questions).toEqual({ yes: { type: 'noul', instructions: 'admitted question' } });
    expect(log.query()[0]?.requestedModel).toBe(PINNED_MODEL);
  });

  test.each(['answered', 'aborted'] as const)('settled %s calls release caller and SDK abort listeners', async (outcome) => {
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    const port = createSystemOnePort(config(async (_url, init) => {
      if (init?.signal) signals.push(init.signal);
      if (signals.length < 25) return bad();
      if (outcome === 'aborted') { queueMicrotask(() => controller.abort()); return await new Promise<Response>(() => {}); }
      return good();
    }));
    const work = port.ask({ ...request, signal: controller.signal });
    if (outcome === 'aborted') await expect(work).rejects.toMatchObject({ kind: 'aborted' });
    else await work;
    // The injected fetch never settles in the cancellation branch. The SDK
    // must still unwind its own signal hooks through the shared fetch race.
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(signals).toHaveLength(25);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    for (const signal of signals) expect(getEventListeners(signal, 'abort')).toHaveLength(0);
  });

  test('malformed successful response terminates as invalid-response, never an endless outage', async () => {
    let calls = 0;
    const port = createSystemOnePort(config(async () => { calls++; return new Response('not json', { headers: { 'content-type': 'application/json' } }); }));
    await expect(port.ask(request)).rejects.toMatchObject({ kind: 'invalid-response' });
    expect(calls).toBe(1);
  });
});
