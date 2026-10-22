import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { isDeepStrictEqual } from 'node:util';
import { captureJudgmentPort, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { captureStrictJudgmentJson, prepareJudgmentResult, JudgmentResultAdmissionError } from '../sdk/src/platform/gate/judgment-result.ts';
import { JudgmentInputError, judgmentInputProblem } from '../sdk/src/platform/gate/judgment-input.ts';
import { choice, createSystemOnePort, noul, SqliteDecisionLog, withDecisionLog, type JudgmentResult, type Questions } from '@goodvibes-jev/judgment';

const questions = () => ({ flag: noul('Does the synthetic statement hold?'), pick: choice('Pick the matching synthetic option.', { a: 'A', b: 'B' }) });
function response() {
  return { answers: { flag: { type: 'noul', noul: 0.4111111111111111 }, pick: { type: 'choice', choice: 'a', confidence: 0.9991234567890123, probabilities: { a: 0.8, b: 0.2 } } },
    requestedModel: 'jev-1.13.0', model: 'jev-1.13.0', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1, requestId: undefined,
  } satisfies JudgmentResult<Questions>;
}

describe('complete original judgment response admission', () => {
  test('credential-named Choice options are schema coordinates and preserve their complete descriptions', () => {
    const schema = { authorization: choice('Classify the failure.', { authorization: 'Permission was refused.', other: 'A different failure.' }) };
    const result = { ...response(), answers: { authorization: { type: 'choice' as const, choice: 'authorization', confidence: .99, probabilities: { authorization: .99, other: .01 } } } };
    expect(prepareJudgmentResult(schema).capture(result)).toEqual(result);
    expect(() => prepareJudgmentResult({ pick: choice('Classify.', { authorization: 'password=synthetic-fixture', other: 'Other.' }) })).toThrow(JudgmentInputError);
    expect(() => prepareJudgmentResult(schema).capture({ ...result, authorization: 'synthetic-fixture' })).toThrow(JudgmentInputError);
  });
  test('retains exact protocol probabilities without rounding or treating their digits as text', () => {
    const original = response();
    const prepared = prepareJudgmentResult(questions());
    const admitted = prepared.capture(original);
    expect(admitted).toEqual(original);
    expect(admitted).not.toBe(original);
    expect(admitted.answers.flag.noul).toBe(0.4111111111111111);
    expect(admitted.answers.pick.confidence).toBe(0.9991234567890123);
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.answers.pick.probabilities)).toBe(true);
    original.answers.flag.noul = 0.9;
    expect(admitted.answers.flag.noul).toBe(0.4111111111111111);
  });

  test('screens unknown original response metadata instead of projecting it away', () => {
    const prepared = prepareJudgmentResult(questions());
    expect(() => prepared.capture({ ...response(), extra: 'Authorization: Bearer synthetic-fixture-secret' })).toThrow(JudgmentInputError);
    expect(() => prepared.capture({ ...response(), extra: 0.4111111111111111 })).toThrow(JudgmentInputError);
    expect(() => prepared.capture({ ...response(), answers: { ...response().answers, unknown: { type: 'noul', noul: 0.4111111111111111 } } })).toThrow(JudgmentInputError);
  });

  test('does not exempt extra numeric fields inside an otherwise valid answer', () => {
    const original = response();
    const answer = { ...original.answers.flag, sensitive: 0.4111111111111111 };
    expect(() => prepareJudgmentResult(questions()).capture({ ...original, answers: { ...original.answers, flag: answer } })).toThrow(JudgmentInputError);
  });

  test('refuses hidden fields, symbols and accessors before evaluating any original getter', () => {
    const prepared = prepareJudgmentResult(questions());
    for (const mode of ['hidden', 'symbol', 'getter']) {
      const original = response(); let reads = 0;
      if (mode === 'hidden') Object.defineProperty(original, 'hidden', { value: 'ordinary', enumerable: false });
      else if (mode === 'symbol') Object.defineProperty(original, Symbol('ordinary'), { value: 'ordinary', enumerable: true });
      else Object.defineProperty(original, 'decisionId', { enumerable: true, get() { reads++; return 'borrowed-id'; } });
      expect(() => prepared.capture(original)).toThrow(JudgmentResultAdmissionError);
      expect(reads).toBe(0);
    }
  });

  test('refuses cycles, sparse arrays and exotic objects in complete metadata', () => {
    const original = response();
    const cycle: { child?: unknown } = {}; cycle.child = cycle;
    for (const extra of [cycle, new Array(2), new Date(), new Map(), new Set(), new Proxy({}, {})]) {
      expect(() => prepareJudgmentResult(questions()).capture({ ...original, extra })).toThrow(JudgmentResultAdmissionError);
    }
  });

  test('validates every requested answer, distribution and option before admitting an envelope', () => {
    const base = response();
    const invalid = [
      { ...base, answers: {} },
      { ...base, answers: { ...base.answers, flag: { type: 'noul', noul: NaN } } },
      { ...base, answers: { ...base.answers, flag: { type: 'noul', noul: 2 } } },
      { ...base, answers: { ...base.answers, pick: { type: 'choice', choice: 'outside', confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } } } },
      { ...base, answers: { ...base.answers, pick: { type: 'choice', choice: 'a', confidence: 0.9, probabilities: { a: 0.8, b: 0.1 } } } },
      { ...base, answers: { ...base.answers, pick: { type: 'choice', choice: 'a', confidence: 0.9, probabilities: { a: 0.1, b: 0.9 } } } },
    ] satisfies readonly JudgmentResult<Questions>[];
    for (const result of invalid) expect(() => prepareJudgmentResult(questions()).capture(result)).toThrow(JudgmentResultAdmissionError);
  });

  test('fences schema mutation including a present undefined field', () => {
    const original = questions(); const prepared = prepareJudgmentResult(original);
    Object.defineProperty(original, 'unoffered', { value: undefined, enumerable: true });
    expect(() => prepared.assertCurrent()).toThrow(JudgmentResultAdmissionError);
    expect(() => prepared.capture(response())).toThrow(JudgmentResultAdmissionError);
    expect(Object.keys(prepared.questions)).toEqual(['flag', 'pick']);
  });

  test('retains a domain error adapter for malformed responses and stale schemas', () => {
    class DomainHeld extends Error { constructor(readonly reason: 'malformed' | 'stale') { super(reason); } }
    const source = questions(), prepared = prepareJudgmentResult(source, reason => new DomainHeld(reason));
    expect(() => prepared.capture({ ...response(), answers: {} })).toThrow(DomainHeld);
    Object.defineProperty(source, 'unoffered', { value: undefined, enumerable: true });
    try { prepared.assertCurrent(); throw new Error('Expected stale schema.'); } catch (error) {
      expect(error).toBeInstanceOf(DomainHeld); if (error instanceof DomainHeld) expect(error.reason).toBe('stale');
    }
    expect(() => captureStrictJudgmentJson(new Date(), reason => new DomainHeld(reason))).toThrow(DomainHeld);
  });
});


describe('complete owned response admission before native recording', () => {
  let previous: ReturnType<typeof installJudgmentPort>;
  beforeEach(() => { previous = installJudgmentPort(undefined); });
  afterEach(() => { installJudgmentPort(previous); });

  function originalQuestionsPort() {
    return fakePort((name, question) => {
      if (name === 'flag' && question.type === 'noul' && isDeepStrictEqual(question, questions().flag)) return noulAnswer(0.4111111111111111);
      if (name === 'pick' && question.type === 'choice' && isDeepStrictEqual(question, questions().pick)) return choiceAnswer(question, 'a', .999);
      throw new Error('Unexpected original named question.');
    });
  }

  test.each(['top', 'answer', 'usage'] as const)('private %s result data refuses before answered recording', async field => {
    const privateValue = '4111111111111111';
    expect(judgmentInputProblem(privateValue)).toBe('card-material');
    const fake = originalQuestionsPort();
    using log = new SqliteDecisionLog(':memory:');
    installJudgmentPort(withDecisionLog({ ...fake.port, async ask(input) {
      const original = await fake.port.ask(input);
      if (field === 'answer') return { ...original, answers: { ...original.answers, flag: { ...original.answers.flag, undisplayed: privateValue } } };
      if (field === 'usage') return { ...original, usage: { ...original.usage, undisplayed: privateValue } };
      return { ...original, undisplayed: privateValue };
    } }, log));
    const captured = captureJudgmentPort('test.complete-response', { prepareResultCapture: prepareJudgmentResult });
    let published = 0;
    await expect(captured.port.ask({ state: 'synthetic complete response', questions: questions() }).then(result => { published++; return result; })).rejects.toThrow();
    expect(published).toBe(0); expect(fake.requests).toHaveLength(1);
    expect(log.query({ status: 'answered' })).toHaveLength(0);
    expect(JSON.stringify(log.query())).not.toContain(privateValue);
  });

  test('complete safe extensions survive recording and exact protocol probabilities remain unchanged', async () => {
    const fake = originalQuestionsPort();
    using log = new SqliteDecisionLog(':memory:');
    installJudgmentPort(withDecisionLog({ ...fake.port, async ask(input) {
      const original = await fake.port.ask(input);
      return { ...original, undisplayed: { detail: 'Ordinary complete response metadata.' },
        answers: { ...original.answers, flag: { ...original.answers.flag, undisplayed: 'Ordinary answer metadata.' } },
        usage: { ...original.usage, undisplayed: 'Ordinary usage metadata.' } };
    } }, log));
    const captured = captureJudgmentPort('test.complete-response', { prepareResultCapture: prepareJudgmentResult });
    let callerCaptures = 0;
    const result = await captured.port.ask({ state: 'synthetic complete response', questions: questions(), captureResult(result) {
      callerCaptures++; expect(Object.isFrozen(result)).toBe(true); return result;
    } });
    expect(callerCaptures).toBe(1);
    expect(result).toMatchObject({ undisplayed: { detail: 'Ordinary complete response metadata.' },
      answers: { flag: { undisplayed: 'Ordinary answer metadata.', noul: 0.4111111111111111 } },
      usage: { undisplayed: 'Ordinary usage metadata.' } });
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.answers.flag)).toBe(true);
    expect(result.decisionId).toBeDefined();
    expect(log.get(result.decisionId!)).toMatchObject({ status: 'answered', answers: { flag: { noul: 0.4111111111111111 } } });
    expect(JSON.stringify(log.query())).not.toContain('Ordinary complete response metadata.');
  });

  test('ordinary recording keeps its documented-field projection without an owned capturer', async () => {
    const fake = originalQuestionsPort();
    using log = new SqliteDecisionLog(':memory:');
    const result = await withDecisionLog({ ...fake.port, async ask(input) {
      return { ...await fake.port.ask(input), undisplayed: 'Ordinary unused metadata.' };
    } }, log).ask({ state: 'synthetic ordinary response', questions: questions() });
    expect(Object.hasOwn(result, 'undisplayed')).toBe(false);
    expect(log.query({ status: 'answered' })).toHaveLength(1);
  });

  test('a caller capturer cannot replace the owned admitted response', async () => {
    const fake = originalQuestionsPort();
    using log = new SqliteDecisionLog(':memory:');
    installJudgmentPort(withDecisionLog(fake.port, log));
    const captured = captureJudgmentPort('test.complete-response', { prepareResultCapture: prepareJudgmentResult });
    let replacements = 0, published = 0;
    await expect(captured.port.ask({ state: 'synthetic complete response', questions: questions(), captureResult(result) {
      replacements++; const replacement = structuredClone(result);
      Object.defineProperty(replacement, 'model', { value: 'replacement-model', enumerable: true });
      return replacement;
    } }).then(result => { published++; return result; })).rejects.toThrow();
    expect(replacements).toBe(1); expect(published).toBe(0); expect(log.query({ status: 'answered' })).toHaveLength(0);
  });

  test('caller capture cannot remove a private original field before owned admission', async () => {
    const fake = originalQuestionsPort();
    using log = new SqliteDecisionLog(':memory:');
    installJudgmentPort(withDecisionLog({ ...fake.port, async ask(input) {
      return { ...await fake.port.ask(input), undisplayed: '4111111111111111' };
    } }, log));
    const captured = captureJudgmentPort('test.complete-response', { prepareResultCapture: prepareJudgmentResult });
    let callerCaptures = 0;
    await expect(captured.port.ask({ state: 'synthetic complete response', questions: questions(), captureResult(result) {
      callerCaptures++; const replacement = structuredClone(result); Reflect.deleteProperty(replacement, 'undisplayed'); return replacement;
    } })).rejects.toThrow();
    expect(callerCaptures).toBe(0); expect(log.query({ status: 'answered' })).toHaveLength(0);
    expect(JSON.stringify(log.query())).not.toContain('4111111111111111');
  });

  test('cancellation inside the original caller restriction prevents any recording', async () => {
    const fake = originalQuestionsPort(), lifetime = new AbortController();
    using log = new SqliteDecisionLog(':memory:');
    installJudgmentPort(withDecisionLog(fake.port, log));
    const captured = captureJudgmentPort('test.complete-response', { signal: lifetime.signal, prepareResultCapture: prepareJudgmentResult });
    let callerCaptures = 0;
    await expect(captured.port.ask({ state: 'synthetic complete response', questions: questions(), captureResult(result) {
      callerCaptures++; lifetime.abort(); return result;
    } })).rejects.toThrow();
    expect(callerCaptures).toBe(1); expect(log.query()).toHaveLength(0);
  });

  test('replacing the native owned request capturer cannot dispatch or record', async () => {
    const fake = originalQuestionsPort();
    using log = new SqliteDecisionLog(':memory:');
    const recorded = withDecisionLog(fake.port, log);
    installJudgmentPort({ ...recorded, async ask(input) {
      Object.defineProperty(input, 'captureResult', { value: () => response(), enumerable: true });
      return recorded.ask(input);
    } });
    const captured = captureJudgmentPort('test.complete-response', { prepareResultCapture: prepareJudgmentResult });
    await expect(captured.port.ask({ state: 'synthetic complete response', questions: questions() })).rejects.toThrow();
    expect(fake.requests).toHaveLength(0); expect(log.query()).toHaveLength(0);
  });

  test('an asynchronous caller capturer refuses and consumes its late rejection', async () => {
    const fake = originalQuestionsPort();
    using log = new SqliteDecisionLog(':memory:');
    installJudgmentPort(withDecisionLog(fake.port, log));
    const captured = captureJudgmentPort('test.complete-response', { prepareResultCapture: prepareJudgmentResult });
    const input = { state: 'synthetic complete response', questions: questions() };
    Object.defineProperty(input, 'captureResult', { enumerable: true, value: () => Promise.reject(new Error('private-capture-tail')) });
    await expect(captured.port.ask(input)).rejects.toThrow();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(log.query({ status: 'answered' })).toHaveLength(0);
    expect(JSON.stringify(log.query())).not.toContain('private-capture-tail');
  });


  test('the original data-slot restriction cannot be replaced by a proxy property read', async () => {
    const fake = originalQuestionsPort(), lifetime = new AbortController();
    using log = new SqliteDecisionLog(':memory:');
    installJudgmentPort(withDecisionLog(fake.port, log));
    let originalCalls = 0, replacementCalls = 0, getterCalls = 0, published = 0;
    const original = { state: 'synthetic complete response', questions: questions(),
      captureResult: <T extends JudgmentResult<Questions>>(result: T): T => { originalCalls++; lifetime.abort(); return result; },
    };
    const replacement = <T extends JudgmentResult<Questions>>(result: T): T => { replacementCalls++; return result; };
    const input = new Proxy(original, { get(target, key, receiver) {
      if (key === 'captureResult') { getterCalls++; return replacement; }
      return Reflect.get(target, key, receiver);
    } });
    const captured = captureJudgmentPort('test.complete-response', { signal: lifetime.signal, prepareResultCapture: prepareJudgmentResult });
    await expect(captured.port.ask(input).then(result => { published++; return result; })).rejects.toThrow();
    expect(originalCalls).toBe(1); expect(replacementCalls).toBe(0); expect(getterCalls).toBe(0); expect(published).toBe(0);
    expect(fake.requests).toHaveLength(1); expect(log.query()).toHaveLength(0);
  });

  test('mutation while observing the original hook descriptor refuses before dispatch', async () => {
    const fake = originalQuestionsPort();
    using log = new SqliteDecisionLog(':memory:');
    installJudgmentPort(withDecisionLog(fake.port, log));
    let originalCalls = 0, replacementCalls = 0, mutations = 0, published = 0;
    const original = { state: 'synthetic complete response', questions: questions(),
      captureResult: <T extends JudgmentResult<Questions>>(result: T): T => { originalCalls++; return result; },
    };
    const replacement = <T extends JudgmentResult<Questions>>(result: T): T => { replacementCalls++; return result; };
    const input = new Proxy(original, { getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (key === 'captureResult' && mutations === 0) {
        Object.defineProperty(target, 'captureResult', { value: replacement }); mutations++;
      }
      return descriptor;
    } });
    const captured = captureJudgmentPort('test.complete-response', { prepareResultCapture: prepareJudgmentResult });
    await expect(captured.port.ask(input).then(result => { published++; return result; })).rejects.toThrow();
    expect(mutations).toBe(1); expect(originalCalls).toBe(0); expect(replacementCalls).toBe(0); expect(published).toBe(0);
    expect(fake.requests).toHaveLength(0); expect(log.query()).toHaveLength(0);
  });

  test.each(['caller capture', 'caller current'] as const)('a borrowed then getter in %s refuses without being read', async restriction => {
    const fake = originalQuestionsPort();
    using log = new SqliteDecisionLog(':memory:');
    installJudgmentPort(withDecisionLog(fake.port, log));
    const input = { state: 'synthetic complete response', questions: questions() };
    let getterCalls = 0, published = 0, restrict = false;
    const borrowed = {};
    Object.defineProperty(borrowed, 'then', { get() { getterCalls++; throw new Error('private-borrowed-then-tail'); } });
    const captured = captureJudgmentPort('test.complete-response', { prepareResultCapture: prepareJudgmentResult,
      assertCurrent: () => { if (restriction === 'caller current' && restrict) return borrowed; },
    });
    if (restriction === 'caller capture') Object.defineProperty(input, 'captureResult', { enumerable: true, value: () => borrowed });
    restrict = true;
    await expect(captured.port.ask(input).then(result => { published++; return result; })).rejects.toThrow();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(getterCalls).toBe(0); expect(published).toBe(0);
    expect(fake.requests).toHaveLength(restriction === 'caller capture' ? 1 : 0);
    expect(log.query({ status: 'answered' })).toHaveLength(0);
    expect(JSON.stringify(log.query())).not.toContain('private-borrowed-then-tail');
  });

  test.each([
    ['non-enumerable', false], ['non-enumerable', true],
    ['inherited', false], ['inherited', true],
  ] as const)('original %s callback retains its current/cancel result %s', async (shape, cancel) => {
    const fake = originalQuestionsPort(), lifetime = new AbortController();
    using log = new SqliteDecisionLog(':memory:');
    installJudgmentPort(withDecisionLog(fake.port, log));
    const input = { state: 'synthetic complete response', questions: questions() };
    let originalCalls = 0, published = 0;
    const originalCapture = <T extends JudgmentResult<Questions>>(result: T): T => {
      originalCalls++; if (cancel) lifetime.abort(); return result;
    };
    if (shape === 'inherited') Object.setPrototypeOf(input, { captureResult: originalCapture });
    else Object.defineProperty(input, 'captureResult', { value: originalCapture, enumerable: false });
    const captured = captureJudgmentPort('test.complete-response', { signal: lifetime.signal, prepareResultCapture: prepareJudgmentResult });
    const pending = captured.port.ask(input).then(result => { published++; return result; });
    if (cancel) { await expect(pending).rejects.toThrow(); expect(published).toBe(0); expect(log.query()).toHaveLength(0); }
    else { await pending; expect(published).toBe(1); expect(log.query({ status: 'answered' })).toHaveLength(1); }
    expect(originalCalls).toBe(1); expect(fake.requests).toHaveLength(1);
  });

  test('a preparer cannot replace the original request hook before binding', async () => {
    const fake = originalQuestionsPort();
    using log = new SqliteDecisionLog(':memory:');
    installJudgmentPort(withDecisionLog(fake.port, log));
    let originalCalls = 0, replacementCalls = 0;
    const input = { state: 'synthetic complete response', questions: questions(),
      captureResult: <T extends JudgmentResult<Questions>>(result: T): T => { originalCalls++; return result; } };
    const captured = captureJudgmentPort('test.complete-response', { prepareResultCapture(originalQuestions) {
      Object.defineProperty(input, 'captureResult', { enumerable: true, value: <T extends JudgmentResult<Questions>>(result: T): T => {
        replacementCalls++; return result;
      } });
      return prepareJudgmentResult(originalQuestions);
    } });
    await expect(captured.port.ask(input)).rejects.toThrow();
    expect(originalCalls).toBe(0); expect(replacementCalls).toBe(0);
    expect(fake.requests).toHaveLength(0); expect(log.query()).toHaveLength(0);
  });

  test('an inherited hook accessor refuses without invocation, dispatch or recording', async () => {
    const fake = originalQuestionsPort();
    using log = new SqliteDecisionLog(':memory:');
    installJudgmentPort(withDecisionLog(fake.port, log));
    const input = { state: 'synthetic complete response', questions: questions() };
    let getterCalls = 0;
    const prototype = {};
    Object.defineProperty(prototype, 'captureResult', { get() { getterCalls++; return () => response(); } });
    Object.setPrototypeOf(input, prototype);
    const captured = captureJudgmentPort('test.complete-response', { prepareResultCapture: prepareJudgmentResult });
    await expect(captured.port.ask(input)).rejects.toThrow();
    expect(getterCalls).toBe(0); expect(fake.requests).toHaveLength(0); expect(log.query()).toHaveLength(0);
  });
});

test('exact bounded latency metadata does not become card material', () => {
  const latencyMs = 0.4111111111111111;
  expect(judgmentInputProblem(latencyMs)).toBe('card-material');
  const original = { ...response(), latencyMs, lineage: { logicalRequestId: 'synthetic', attempts: [
    { attempt: 1, endpointIndex: 0, endpointKind: 'local' as const, requestedModel: 'jev-latest', latencyMs, outcome: 'answered' as const },
  ] } };
  expect(prepareJudgmentResult(questions()).capture(original)).toEqual(original);
  expect(() => prepareJudgmentResult(questions()).capture({ ...original, latencyMs: 4111111111111111 })).toThrow(JudgmentResultAdmissionError);
  const privateResult = { ...original, privateMetadata: { latencyMs } };
  expect(() => prepareJudgmentResult(questions()).capture(privateResult)).toThrow(JudgmentInputError);
});

test.each(['req_4111111111111111', '013c2c70-53ea-4240-8f43-497101781208'])('native diagnostic identities cannot reset a valid judgment: %s', async requestId => {
  // This is a randomly generated UUID, not payment data. Its digits across
  // the final hyphen happen to pass the same checksum as a card number.
  const generated = '013c2c70-53ea-4240-8f43-497101781208';
  expect(judgmentInputProblem(generated)).toBe('card-material');
  const uuid = spyOn(crypto, 'randomUUID').mockReturnValue(generated);
  const native = createSystemOnePort({ endpoint: { kind: 'hosted', baseURL: 'https://judge.test', apiKey: 'synthetic-key' },
    model: 'jev-1.13.0', timeoutMs: 1_000, retry: {}, fetch: async () => new Response(JSON.stringify({
      model: 'jev-1.13.0', answers: { checked: { type: 'noul', noul: .01 } }, usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json', 'x-typesafe-request-id': requestId } }) });
  using log = new SqliteDecisionLog(':memory:');
  const prior = installJudgmentPort(withDecisionLog(native, log));
  try {
    const owner = captureJudgmentPort('test.native-optional-id', { prepareResultCapture: prepareJudgmentResult });
    const result = await owner.port.ask({ state: 'The existing delivery was inspected.', questions: { checked: noul('Is its inspection missing?') } });
    expect(result.answers.checked.noul).toBe(.01);
    expect(result.requestId).toBeUndefined();
    expect(result.lineage!.attempts[0]!.requestId).toBeUndefined();
    expect(result.lineage!.logicalRequestId).toMatch(/^[a-p-]+$/);
    expect(log.query()).toHaveLength(1);
    expect(log.query()[0]!.status).toBe('answered');
  } finally { uuid.mockRestore(); installJudgmentPort(prior); }
});
