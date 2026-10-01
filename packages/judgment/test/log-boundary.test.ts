import { describe, expect, test } from 'bun:test';
import { JudgmentError, SqliteDecisionLog, withDecisionLog, type DecisionLog, type JudgmentPort } from '../src/index.ts';

const SECRET = 'Bearer sk-secret-provider-body';
const request = { state: 'private state', questions: { q: { type: 'noul', instructions: 'Q?' } } } as const;
const attempt = { attempt: 1, endpointIndex: 0, endpointKind: 'hosted', requestedModel: 'jev-1.13.0', latencyMs: 12, outcome: 'answered', requestId: 'req-ok' } as const;
const result = () => ({
  answers: { q: { type: 'noul', noul: 0.9 } },
  requestedModel: 'jev-1.13.0', model: 'jev-1.13.0',
  usage: { inputTokens: 120, outputTokens: 9 }, latencyMs: 42, requestId: 'req-ok',
  lineage: { logicalRequestId: 'logical-1', attempts: [{ ...attempt }] },
} as const);
const borrowed = (answer: unknown): JudgmentPort => ({ model: 'jev-1.13.0', async ask() { return answer as never; } });
const rejecting = (error: unknown): JudgmentPort => ({ model: 'jev-1.13.0', async ask() { throw error; } });
const exposedError = (error: unknown) => {
  expect(error).toBeInstanceOf(JudgmentError);
  const failure = error as JudgmentError;
  expect(failure.cause).toBeUndefined();
  expect(`${failure.message}\n${failure.stack}\n${JSON.stringify(failure)}`).not.toContain(SECRET);
  return failure;
};

describe('recording port trust boundary', () => {
  test('projects provider answers and metadata before recording and returning them', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const raw = {
      ...result(), rawBody: SECRET, decisionId: SECRET,
      answers: { q: { type: 'noul', noul: 0.9, rawBody: SECRET }, unexpected: SECRET },
      usage: { inputTokens: 120, outputTokens: 9, rawBody: SECRET },
      lineage: { logicalRequestId: 'logical-1', rawBody: SECRET, attempts: [{ ...attempt, headers: SECRET }] },
    };
    const answer = await withDecisionLog(borrowed(raw), log).ask(request);
    expect(answer).toEqual({ ...result(), decisionId: answer.decisionId! });
    expect(answer.decisionId).toBeString();
    const entry = log.get(answer.decisionId!)!;
    expect(entry.status).toBe('answered');
    expect(entry.lineage).toEqual(result().lineage);
    expect(JSON.stringify(entry)).not.toContain(SECRET);
    expect(JSON.stringify(answer)).not.toContain(SECRET);
  });

  test('projects choice probabilities and derives score legends from the request', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const questions = {
      choice: { type: 'choice', instructions: 'Pick', criteria: { a: 'A', b: 'B' } },
      score: { type: 'score', instructions: 'Rate', criteria: ['low', 'high'] },
    } as const;
    const answer = await withDecisionLog(borrowed({ ...result(), answers: {
      choice: { type: 'choice', choice: 'a', confidence: 0.9, probabilities: { a: 0.9, b: 0.1, rawBody: SECRET }, rawBody: SECRET },
      score: { type: 'score', score: 1, confidence: 0.8, probabilities: { 0: 0.2, 1: 0.8 }, legend: { 0: SECRET, 1: SECRET } },
    } }), log).ask({ state: 'x', questions });
    expect(answer.answers.choice.probabilities).toEqual({ a: 0.9, b: 0.1 });
    expect(answer.answers.score.legend).toEqual({ 0: 'low', 1: 'high' });
    expect(JSON.stringify(log.query())).not.toContain(SECRET);
    expect(JSON.stringify(answer)).not.toContain(SECRET);
  });

  test.each([
    { q: { type: SECRET, noul: 0.9 } },
    { q: { type: 'noul', noul: SECRET } },
    { q: { type: 'noul', noul: Number.NaN } },
    null,
  ])('records malformed answers as a value-free failed judgment', async (answers) => {
    using log = new SqliteDecisionLog(':memory:');
    const error = await withDecisionLog(borrowed({ ...result(), answers }), log).ask(request).catch((e: unknown) => e);
    expect(exposedError(error).kind).toBe('invalid-response');
    expect(exposedError(error).requestId).toBe('req-ok');
    const [entry] = log.query();
    expect(entry?.status).toBe('failed');
    expect(log.query({ status: 'answered' })).toHaveLength(0);
    expect(JSON.stringify(entry)).not.toContain(SECRET);
    expect(entry?.requestId).toBe('req-ok');
  });

  test.each([
    new Error(SECRET, { cause: new Error(SECRET) }),
    SECRET,
    { toString() { throw new Error(SECRET); }, rawBody: SECRET },
    new JudgmentError('rejected', SECRET, { cause: new Error(SECRET), status: 403, requestId: 'req-rejected' }),
  ])('replaces all upstream failure text without retaining causes or coercing thrown values', async (upstream) => {
    using log = new SqliteDecisionLog(':memory:');
    const error = exposedError(await withDecisionLog(rejecting(upstream), log).ask(request).catch((e: unknown) => e));
    expect(error.kind).toBe(upstream instanceof JudgmentError ? 'rejected' : 'unavailable');
    if (upstream instanceof JudgmentError) {
      expect(error.status).toBe(403);
      expect(error.requestId).toBe('req-rejected');
    }
    expect(log.query({ status: 'failed' })).toHaveLength(1);
    expect(JSON.stringify(log.query())).not.toContain(SECRET);
  });

  test('projects failure lineage and omits unsafe request ids', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const upstream = new JudgmentError('unavailable', SECRET, {
      requestId: SECRET, status: 529, cause: new Error(SECRET),
      lineage: { logicalRequestId: 'logical-1', rawBody: SECRET, attempts: [{ ...attempt, outcome: 'unavailable', requestId: SECRET, status: 529, body: SECRET }] } as never,
    });
    const error = exposedError(await withDecisionLog(rejecting(upstream), log).ask(request).catch((e: unknown) => e));
    expect(error.requestId).toBeUndefined();
    expect(error.status).toBe(529);
    const { requestId: _requestId, ...withoutRequestId } = attempt;
    expect(error.lineage).toEqual({ logicalRequestId: 'logical-1', attempts: [{ ...withoutRequestId, outcome: 'unavailable', status: 529 }] });
    expect(JSON.stringify(log.query())).not.toContain(SECRET);
    expect(log.query()[0]?.lineage).toEqual(error.lineage);
  });

  test.each(['requestId', 'model', 'requestedModel', 'usage', 'latencyMs', 'lineage'])('does not log unsafe %s metadata', async (field) => {
    using log = new SqliteDecisionLog(':memory:');
    const response = { ...result(), [field]: SECRET };
    const outcome = await withDecisionLog(borrowed(response), log).ask(request).catch((e: unknown) => e);
    if (field === 'requestId') expect((outcome as { requestId?: string }).requestId).toBeUndefined();
    else expect(exposedError(outcome).kind).toBe('invalid-response');
    expect(JSON.stringify(log.query())).not.toContain(SECRET);
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });

  test.each(['Authorization: Bearer fake-provider-key', 'https://provider.invalid/private-key', 'x'.repeat(257)])('omits header text, URL or oversized request identifiers', async (requestId) => {
    using log = new SqliteDecisionLog(':memory:');
    const answer = await withDecisionLog(borrowed({ ...result(), requestId,
      lineage: { logicalRequestId: 'logical-1', attempts: [{ ...attempt, requestId }] },
    }), log).ask(request);
    expect(answer.requestId).toBeUndefined();
    expect(answer.lineage?.attempts[0]?.requestId).toBeUndefined();
    expect(JSON.stringify(log.query())).not.toContain(requestId);
  });

  test.each(['sk-fake-provider-key', 'req-token', 'password-reset', '-leading.punctuation'])('preserves identifiers that conform to the wire grammar without guessing secret words', async (requestId) => {
    using log = new SqliteDecisionLog(':memory:');
    const lineage = { logicalRequestId: 'logical-1', attempts: [{ ...attempt, requestId }] };
    const answer = await withDecisionLog(borrowed({ ...result(), requestId, lineage }), log).ask(request);
    expect(answer.requestId).toBe(requestId);
    expect(answer.lineage).toEqual(lineage);
    expect(log.query()[0]?.requestId).toBe(requestId);
    expect(log.query()[0]?.lineage).toEqual(lineage);
  });

  test.each(['invalid-request', 'rejected', 'unavailable', 'aborted', 'invalid-response', 'unrecorded'] as const)('preserves the genuine %s failure kind', async (kind) => {
    using log = new SqliteDecisionLog(':memory:');
    const error = exposedError(await withDecisionLog(rejecting(new JudgmentError(kind, SECRET)), log).ask(request).catch((e: unknown) => e));
    expect(error.kind).toBe(kind);
    const [entry] = log.query();
    if (entry?.status !== 'failed') throw new Error('expected a failed entry');
    expect(entry.error.kind).toBe(kind);
    expect(entry.error.message).toBe(error.message);
    expect(JSON.stringify(entry)).not.toContain(SECRET);
  });

  test('preserves compatible model identifiers and reads usage metadata only once', async () => {
    using log = new SqliteDecisionLog(':memory:');
    let reads = 0;
    const answer = await withDecisionLog(borrowed({ ...result(), model: 'local/jev-1.13.0+build.1', usage: {
      get inputTokens() { return ++reads === 1 ? 120 : SECRET; }, outputTokens: 9,
    } }), log).ask(request);
    expect(answer.model).toBe('local/jev-1.13.0+build.1');
    expect(answer.usage).toEqual({ inputTokens: 120, outputTokens: 9 });
    expect(reads).toBe(1);
    expect(JSON.stringify(log.query())).not.toContain(SECRET);
  });

  test('reads failure metadata only once and never copies unknown properties', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const upstream = new JudgmentError('rejected', SECRET);
    let kindReads = 0;
    let statusReads = 0;
    Object.defineProperties(upstream, {
      kind: { get() { return ++kindReads === 1 ? 'rejected' : SECRET; } },
      status: { get() { return ++statusReads === 1 ? 403 : SECRET; } },
      rawBody: { value: SECRET, enumerable: true },
    });
    const error = exposedError(await withDecisionLog(rejecting(upstream), log).ask(request).catch((e: unknown) => e));
    expect(error.kind).toBe('rejected');
    expect(error.status).toBe(403);
    expect(kindReads).toBe(1);
    expect(statusReads).toBe(1);
    expect(JSON.stringify(log.query())).not.toContain(SECRET);
  });

  test.each(['status', 'requestId', 'lineage'] as const)('preserves aborted and remaining evidence when the optional %s getter throws', async (field) => {
    using log = new SqliteDecisionLog(':memory:');
    const lineage = { logicalRequestId: 'logical-1', attempts: [{ ...attempt, endpointKind: 'hosted' as const, outcome: 'aborted' as const }] };
    const upstream = new JudgmentError('aborted', SECRET, { status: 499, requestId: 'req-aborted', lineage });
    Object.defineProperty(upstream, field, { get() { throw new Error(SECRET); } });
    const error = exposedError(await withDecisionLog(rejecting(upstream), log).ask(request).catch((e: unknown) => e));
    expect(error.kind).toBe('aborted');
    expect(error.status).toBe(field === 'status' ? undefined : 499);
    expect(error.requestId).toBe(field === 'requestId' ? undefined : 'req-aborted');
    expect(error.lineage).toEqual(field === 'lineage' ? undefined : lineage);
    const [entry] = log.query();
    if (entry?.status !== 'failed') throw new Error('expected a failed entry');
    expect(entry.error.kind).toBe('aborted');
    expect(JSON.stringify(entry)).not.toContain(SECRET);
  });

  test('records pre-existing cancellation without invoking the provider', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const controller = new AbortController();
    controller.abort(new Error(SECRET));
    let calls = 0;
    const port: JudgmentPort = { model: 'jev-1.13.0', async ask() { calls += 1; return result() as never; } };
    const error = exposedError(await withDecisionLog(port, log).ask({ ...request, signal: controller.signal }).catch((e: unknown) => e));
    expect(error.kind).toBe('aborted');
    expect(calls).toBe(0);
    expect(log.query({ status: 'failed' })).toHaveLength(1);
    expect(log.query({ status: 'answered' })).toHaveLength(0);
    expect(JSON.stringify(log.query())).not.toContain(SECRET);
  });

  test('classifies a borrowed rejection with signal.reason as aborted', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const controller = new AbortController();
    const port: JudgmentPort = { model: 'jev-1.13.0', async ask(incoming) {
      controller.abort(new Error(SECRET));
      throw incoming.signal!.reason;
    } };
    const error = exposedError(await withDecisionLog(port, log).ask({ ...request, signal: controller.signal }).catch((e: unknown) => e));
    expect(error.kind).toBe('aborted');
    const [entry] = log.query();
    if (entry?.status !== 'failed') throw new Error('expected a failed entry');
    expect(entry.error.kind).toBe('aborted');
    expect(JSON.stringify(entry)).not.toContain(SECRET);
  });

  test.each(['before-resolution', 'during-projection'])('never records or returns a valid answer after cancellation %s', async (stage) => {
    using log = new SqliteDecisionLog(':memory:');
    const controller = new AbortController();
    const port: JudgmentPort = { model: 'jev-1.13.0', async ask() {
      if (stage === 'before-resolution') controller.abort(new Error(SECRET));
      return { ...result(), usage: {
        get inputTokens() { if (stage === 'during-projection') controller.abort(new Error(SECRET)); return 120; }, outputTokens: 9,
      } } as never;
    } };
    const error = exposedError(await withDecisionLog(port, log).ask({ ...request, signal: controller.signal }).catch((e: unknown) => e));
    expect(error.kind).toBe('aborted');
    expect(log.query({ status: 'answered' })).toHaveLength(0);
    expect(log.query({ status: 'failed' })).toHaveLength(1);
    expect(JSON.stringify(log.query())).not.toContain(SECRET);
  });

  test.each([new JudgmentError('unavailable', SECRET), new DOMException(SECRET, 'TimeoutError')])('preserves explicitly typed timeout cancellation as unavailable', async (reason) => {
    using log = new SqliteDecisionLog(':memory:');
    const controller = new AbortController();
    const port: JudgmentPort = { model: 'jev-1.13.0', async ask() { controller.abort(reason); throw reason; } };
    const error = exposedError(await withDecisionLog(port, log).ask({ ...request, signal: controller.signal }).catch((e: unknown) => e));
    expect(error.kind).toBe('unavailable');
    const [entry] = log.query();
    if (entry?.status !== 'failed') throw new Error('expected a failed entry');
    expect(entry.error.kind).toBe('unavailable');
    expect(JSON.stringify(entry)).not.toContain(SECRET);
  });

  test.each([undefined, 'jev-1.14.0'])('rejects borrowed requestedModel inconsistent with the captured requested model %s', async (model) => {
    using log = new SqliteDecisionLog(':memory:');
    const raw = { ...result(), requestedModel: 'jev-0.0.0' };
    const input = { ...request, ...(model === undefined ? {} : { model }) };
    const error = exposedError(await withDecisionLog(borrowed(raw), log).ask(input).catch((e: unknown) => e));
    expect(error.kind).toBe('invalid-response');
    const [entry] = log.query();
    if (entry?.status !== 'failed') throw new Error('expected a failed entry');
    expect(entry.requestedModel).toBe(model ?? 'jev-1.13.0');
    expect(log.query({ status: 'answered' })).toHaveLength(0);
  });

  test('uses the captured requested model while preserving a distinct answering model', async () => {
    using log = new SqliteDecisionLog(':memory:');
    let model = 'jev-1.13.0';
    const port: JudgmentPort = { get model() { return model; }, async ask() {
      model = 'jev-1.14.0';
      return { ...result(), model: 'local/jev-1.13.0+build.1' } as never;
    } };
    const answer = await withDecisionLog(port, log).ask(request);
    expect(answer.requestedModel).toBe('jev-1.13.0');
    expect(answer.model).toBe('local/jev-1.13.0+build.1');
    const [entry] = log.query();
    if (entry?.status !== 'answered') throw new Error('expected an answered entry');
    expect(entry.requestedModel).toBe('jev-1.13.0');
    expect(entry.model).toBe('local/jev-1.13.0+build.1');
  });

  test('rejects a malformed lineage without exposing its content', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const error = exposedError(await withDecisionLog(borrowed({ ...result(), lineage: {
      logicalRequestId: 'logical-1', attempts: [{ ...attempt, outcome: SECRET }],
    } }), log).ask(request).catch((e: unknown) => e));
    expect(error.kind).toBe('invalid-response');
    expect(JSON.stringify(log.query())).not.toContain(SECRET);
  });

  test('rejects answer getters that change values without leaking the changed value', async () => {
    using log = new SqliteDecisionLog(':memory:');
    let reads = 0;
    const response = { ...result(), answers: { q: { type: 'noul', get noul() { return ++reads === 1 ? 0.9 : SECRET; } } } };
    expect(exposedError(await withDecisionLog(borrowed(response), log).ask(request).catch((e: unknown) => e)).kind).toBe('invalid-response');
    expect(JSON.stringify(log.query())).not.toContain(SECRET);
  });

  test('checks answers against the original questions even if a borrowed port mutates the request', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const input = { state: 'x', questions: { q: { type: 'noul', instructions: 'Q?' } } } as const;
    const port: JudgmentPort = { model: 'jev-1.13.0', async ask(incoming) {
      (incoming.questions as Record<string, unknown>).q = { type: SECRET };
      return { ...result(), answers: { q: { type: SECRET } } } as never;
    } };
    expect(exposedError(await withDecisionLog(port, log).ask(input).catch((e: unknown) => e)).kind).toBe('invalid-response');
    expect(JSON.stringify(log.query())).not.toContain(SECRET);
  });

  test.each(['answer', 'failure', 'action', 'readings'])('log-write failure during %s is value-free and unrecorded', async (stage) => {
    const broken: DecisionLog = {
      record() { throw new Error(SECRET); }, attach() { throw new Error(SECRET); }, get: () => undefined, query: () => [],
    };
    const port = withDecisionLog(stage === 'failure' ? rejecting(new Error(SECRET)) : borrowed(result()), broken);
    const error = stage === 'action' || stage === 'readings'
      ? (() => { try { stage === 'action' ? port.recorder!.recordAction('id', 'act') : port.recorder!.recordReadings('id', {}); } catch (e) { return e; } })()
      : await port.ask(request).catch((e: unknown) => e);
    expect(exposedError(error).kind).toBe('unrecorded');
  });
});
