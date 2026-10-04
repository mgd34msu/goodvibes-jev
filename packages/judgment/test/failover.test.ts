import { describe, expect, test } from 'bun:test';
import { createSystemOnePort, JudgmentError, noul, PINNED_MODEL, SqliteDecisionLog, withDecisionLog, type JudgmentConfig } from '../src/index.ts';

const request = { state: 'synthetic state', questions: { yes: noul('Synthetic question') } };
const primary = { kind: 'hosted' as const, baseURL: 'https://primary.test', apiKey: 'primary-test-key' };
const secondary = { kind: 'local' as const, baseURL: 'http://127.0.0.1:9999', apiKey: 'secondary-test-key' };
const good = (id = 'ok', model = PINNED_MODEL) => Response.json({ model, answers: { yes: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1 } }, { headers: { 'x-typesafe-request-id': id } });
const bad = (status = 503, id = 'failed', headers = {}) => Response.json({ error: `must not log ${primary.apiKey}` }, { status, headers: { 'x-typesafe-request-id': id, ...headers } });
function config(fetch: NonNullable<JudgmentConfig['fetch']>, overrides: Partial<JudgmentConfig> = {}): JudgmentConfig {
  return { endpoint: primary, model: PINNED_MODEL, timeoutMs: 500, retry: { backoffInitialMs: 1, backoffMaxMs: 1, backoffJitter: 0 }, fallbacks: [{ endpoint: secondary, model: PINNED_MODEL }], fetch, ...overrides };
}
const failure = async (promise: Promise<unknown>): Promise<JudgmentError> => {
  try { await promise; throw new Error('expected rejection'); }
  catch (error) { expect(error).toBeInstanceOf(JudgmentError); return error as JudgmentError; }
};

describe('persistent System One availability retry', () => {
  test.each([408, 429, 500, 529])('retries HTTP %i in order with one logical result and request lineage', async (status) => {
    const urls: string[] = [];
    const port = createSystemOnePort(config(async (url, init) => {
      urls.push(String(url));
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${urls.length % 2 === 1 ? primary.apiKey : secondary.apiKey}`);
      return urls.length <= 2 ? bad(status, `req-${urls.length}`) : good('req-3');
    }));
    using log = new SqliteDecisionLog(':memory:');
    const result = await withDecisionLog(port, log).ask(request);
    expect(urls).toEqual([`${primary.baseURL}/v1/systemone`, `${secondary.baseURL}/v1/systemone`, `${primary.baseURL}/v1/systemone`]);
    expect(result.lineage?.attempts.map((a) => [a.endpointIndex, a.outcome, a.requestId])).toEqual([[0, 'unavailable', 'req-1'], [1, 'unavailable', 'req-2'], [0, 'answered', 'req-3']]);
    expect(log.query()).toHaveLength(1);
    expect(log.query()[0]?.lineage).toEqual(result.lineage);
    expect(port.health?.().map((h) => [h.attempts, h.consecutiveFailures, h.lastOutcome])).toEqual([[2, 0, 'answered'], [1, 1, 'unavailable']]);
    expect(JSON.stringify(log.query())).not.toContain(primary.apiKey);
    expect(JSON.stringify(log.query())).not.toContain(primary.baseURL);
  });

  test('an outage remains pending past former retry caps, with one final log and bounded lineage', async () => {
    let calls = 0;
    const progress: number[] = [];
    const ids = new Set<string>();
    const port = createSystemOnePort(config(async () => { if (++calls < 150) throw new Error(`network ${primary.apiKey}`); return good(); }));
    using log = new SqliteDecisionLog(':memory:');
    let effects = 0;
    const result = await withDecisionLog(port, log).ask({ ...request, onRetry: (event) => {
      expect(log.query()).toHaveLength(0);
      expect(effects).toBe(0);
      progress.push(event.attempt.attempt);
      ids.add(event.logicalRequestId);
    } });
    effects += 1;
    expect(calls).toBe(150);
    expect(progress).toHaveLength(149);
    expect(effects).toBe(1);
    expect(ids.size).toBe(1);
    expect(ids.has(result.lineage!.logicalRequestId)).toBe(true);
    expect(result.lineage?.attempts).toHaveLength(128);
    expect(result.lineage?.attempts[0]?.attempt).toBe(23);
    expect(result.lineage?.omittedAttempts).toBe(22);
    expect(log.query()).toHaveLength(1);
    expect(log.query()[0]?.lineage).toEqual(result.lineage);
    expect(JSON.stringify(log.query())).not.toContain(primary.apiKey);
  });

  test.each([400, 401, 403, 404, 422])('HTTP %i does not retry or leak to a fallback', async (status) => {
    let calls = 0;
    const port = createSystemOnePort(config(async () => { calls += 1; return bad(status); }));
    const error = await failure(port.ask(request));
    expect(error.kind).toBe('rejected');
    expect(error.status).toBe(status);
    expect(calls).toBe(1);
  });

  test('invalid input never reaches any endpoint; invalid answers never fail over', async () => {
    let calls = 0;
    const port = createSystemOnePort(config(async () => { calls += 1; return Response.json({ nonsense: primary.apiKey }); }));
    expect((await failure(port.ask({ state: '', questions: {} }))).kind).toBe('invalid-request');
    expect(calls).toBe(0);
    expect((await failure(port.ask(request))).kind).toBe('invalid-response');
    expect(calls).toBe(1);
  });

  test('cancellation stops a fetch ignoring abort and records exactly once', async () => {
    let calls = 0;
    const controller = new AbortController();
    const port = createSystemOnePort(config(async () => { calls += 1; setTimeout(() => controller.abort(), 15); return await new Promise<Response>(() => {}); }));
    using log = new SqliteDecisionLog(':memory:');
    const error = await failure(withDecisionLog(port, log).ask({ ...request, signal: controller.signal }));
    expect(error.kind).toBe('aborted');
    expect(calls).toBe(1);
    expect(log.query()).toHaveLength(1);
    expect(log.query()[0]?.lineage).toEqual(error.lineage);
    expect(error.cause).toBeUndefined();
  });

  test('per-attempt timeout advances the configured chain without ending the reading', async () => {
    let calls = 0;
    const port = createSystemOnePort(config(async () => { calls += 1; return calls === 1 ? await new Promise<Response>(() => {}) : good(); }, { timeoutMs: 15 }));
    expect((await port.ask(request)).lineage?.attempts.map((a) => a.outcome)).toEqual(['unavailable', 'answered']);
    expect(calls).toBe(2);
  });

  test('long Retry-After keeps the reading pending and is immediately cancellable', async () => {
    let calls = 0;
    let delay = 0;
    const controller = new AbortController();
    const port = createSystemOnePort(config(async () => { calls += 1; return bad(429, 'rate-limit', { 'retry-after': '3600' }); }));
    const error = await failure(port.ask({ ...request, signal: controller.signal, onRetry: (progress) => {
      delay = progress.nextDelayMs;
      setTimeout(() => controller.abort(), 10);
    } }));
    expect(error.kind).toBe('aborted');
    expect(delay).toBe(3_600_000);
    expect(calls).toBe(1);
  });

  test.each(['before', 'during', 'between'] as const)('cancellation %s attempts prevents retries and fallback', async (where) => {
    const controller = new AbortController();
    let calls = 0;
    const port = createSystemOnePort(config(async () => {
      calls += 1;
      if (where === 'during') { queueMicrotask(() => controller.abort()); return await new Promise<Response>(() => {}); }
      queueMicrotask(() => controller.abort());
      return bad();
    }));
    if (where === 'before') controller.abort();
    expect((await failure(port.ask({ ...request, signal: controller.signal }))).kind).toBe('aborted');
    expect(calls).toBe(where === 'before' ? 0 : 1);
  });

  test('cancellation while waiting for backoff also prevents any next attempt', async () => {
    const controller = new AbortController();
    let calls = 0;
    const port = createSystemOnePort(config(async () => { calls += 1; setTimeout(() => controller.abort(), 10); return bad(); }, { retry: { backoffInitialMs: 200 } }));
    expect((await failure(port.ask({ ...request, signal: controller.signal }))).kind).toBe('aborted');
    expect(calls).toBe(1);
  });

  test('a response completing after cancellation is never used', async () => {
    const controller = new AbortController();
    const port = createSystemOnePort(config(async () => { controller.abort(); return good(); }));
    expect((await failure(port.ask({ ...request, signal: controller.signal }))).kind).toBe('aborted');
  });

  test('incompatible fallback models are skipped, never silently used', async () => {
    let calls = 0;
    const port = createSystemOnePort(config(async (url) => { expect(String(url)).toStartWith(primary.baseURL); return ++calls < 4 ? bad() : good(); }, { fallbacks: [{ endpoint: secondary, model: 'jev-9.0.0' }] }));
    expect((await port.ask(request)).answers.yes.noul).toBe(0.9);
    expect(calls).toBe(4);
  });

  test('model drift fails closed and aliases cannot enable failover', async () => {
    let calls = 0;
    const port = createSystemOnePort(config(async () => { calls += 1; return good('drift', 'jev-9.0.0'); }));
    expect((await failure(port.ask(request))).kind).toBe('invalid-response');
    expect((await failure(port.ask({ ...request, model: 'jev-latest' }))).kind).toBe('invalid-request');
    expect(calls).toBe(1);
    expect(() => createSystemOnePort(config(async () => good(), { model: 'jev-latest' }))).toThrow('pinned');
    const legacy = createSystemOnePort(config(async () => good(), { model: 'jev-latest', fallbacks: [] }));
    expect((await legacy.ask(request)).model).toBe(PINNED_MODEL);
  });

  test('all targets and retry policy validate before transmission', () => {
    const fetch = async () => good();
    for (const baseURL of ['https://u:p@primary.test', 'https://primary.test/?api_key=secret', 'ftp://primary.test', 'https://primary.test/#secret', 'https://primary.test/?', 'https://primary.test/#', 'https://primary.test/ ']) {
      expect(() => createSystemOnePort(config(fetch, { fallbacks: [{ endpoint: { ...secondary, baseURL }, model: PINNED_MODEL }] }))).toThrow(JudgmentError);
    }
    expect(() => createSystemOnePort(config(fetch, { retry: { maxRetries: 11 } as JudgmentConfig['retry'] }))).toThrow(JudgmentError);
    expect(() => createSystemOnePort(config(fetch, { retry: { httpStatuses: new Set([401]) } as JudgmentConfig['retry'] }))).toThrow(JudgmentError);
    expect(() => createSystemOnePort(config(fetch, { fallbacks: [{ endpoint: { ...secondary, apiKey: '' }, model: PINNED_MODEL }] }))).toThrow(JudgmentError);
  });

  test('request ids that echo credentials are omitted from error and lineage', async () => {
    const port = createSystemOnePort(config(async () => bad(401, primary.apiKey)));
    const error = await failure(port.ask(request));
    expect(error.requestId).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(primary.apiKey);
  });

  test('successful response extensions cannot copy credentials into answers or the log', async () => {
    const port = createSystemOnePort(config(async () => Response.json({
      model: PINNED_MODEL,
      answers: { yes: { type: 'noul', noul: 0.9, debug: primary.apiKey }, unexpected: { secret: secondary.apiKey } },
      usage: { input_tokens: 1, output_tokens: 1, debug: primary.apiKey },
    })));
    using log = new SqliteDecisionLog(':memory:');
    const result = await withDecisionLog(port, log).ask(request);
    expect(result.answers).toEqual({ yes: { type: 'noul', noul: 0.9 } });
    expect(JSON.stringify(log.query())).not.toContain(primary.apiKey);
    expect(JSON.stringify(log.query())).not.toContain(secondary.apiKey);
  });

  test('failure attribution keeps the starting model when live configuration changes', async () => {
    let model = PINNED_MODEL;
    using log = new SqliteDecisionLog(':memory:');
    const port = withDecisionLog({ get model() { return model; }, ask: async () => {
      model = 'jev-9.0.0';
      throw new JudgmentError('unavailable', 'synthetic failure');
    } }, log);
    await failure(port.ask(request));
    expect(log.query()[0]?.requestedModel).toBe(PINNED_MODEL);
  });

  test('concurrent calls have separate request and attempt lineage', async () => {
    const port = createSystemOnePort(config(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { state: string };
      await new Promise((resolve) => setTimeout(resolve, body.state === 'a' ? 10 : 1));
      return good(body.state);
    }));
    const [a, b] = await Promise.all(['a', 'b'].map((state) => port.ask({ ...request, state })));
    expect(a?.requestId).toBe('a');
    expect(b?.requestId).toBe('b');
    expect(a?.lineage?.logicalRequestId).not.toBe(b?.lineage?.logicalRequestId);
  });

  test('one logical request keeps the same state and questions across retries', async () => {
    const state = { value: 'original' };
    const questions = { yes: noul('original question') };
    const bodies: unknown[] = [];
    const port = createSystemOnePort(config(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) {
        state.value = 'changed';
        questions.yes.instructions = 'changed question';
        return bad();
      }
      return good();
    }));
    await port.ask({ state, questions });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toMatchObject({ state: { value: 'original' }, questions: { yes: { instructions: 'original question' } } });
  });

  test('legacy retry caps and total deadlines are rejected rather than silently defeating the policy', async () => {
    let calls = 0;
    const settings = config(async () => { calls++; return good(); });
    expect(() => createSystemOnePort({ ...settings, totalTimeoutMs: 30 } as JudgmentConfig)).toThrow('total-time');
    const port = createSystemOnePort(settings);
    expect((await failure(port.ask({ ...request, ...{ totalTimeoutMs: 30 } }))).kind).toBe('invalid-request');
    expect(calls).toBe(0);
  });

  test('configured local endpoint conforms to the real System One HTTP wire', async () => {
    const seen: string[] = [];
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
      seen.push(new URL(req.url).pathname, req.headers.get('authorization') ?? '');
      const body = await req.json() as { model: string; state: string };
      expect(body.model).toBe(PINNED_MODEL);
      expect(body.state).toBe(request.state);
      return good('local-wire');
    } });
    try {
      const port = createSystemOnePort({ endpoint: { ...secondary, baseURL: `http://127.0.0.1:${server.port}` }, model: PINNED_MODEL, timeoutMs: 500, retry: {} });
      expect((await port.ask(request)).requestId).toBe('local-wire');
      expect(seen).toEqual(['/v1/systemone', `Bearer ${secondary.apiKey}`]);
    } finally { server.stop(true); }
  });
});
