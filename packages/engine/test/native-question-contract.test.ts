import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  acceptNativeQuestionReply,
  NativeQuestionError,
  parseNativeQuestionIdentity,
  parseNativeQuestionRecord,
  parseNativeQuestionReply,
  type NativeQuestionIdentity,
  type NativeQuestionRecord,
  type NativeQuestionReply,
} from '../sdk/src/platform/workflow/work-ledger/native-question-types.js';
import {
  NATIVE_QUESTION_MAX_ANSWER_BYTES,
  NATIVE_QUESTION_MAX_QUESTION_BYTES,
  NATIVE_QUESTION_MAX_REQUEST_BYTES,
  nativeQuestionIdentitySchema,
  nativeQuestionReplySchema,
} from '../sdk/src/platform/workflow/work-ledger/native-question-wire.js';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
function identity(): NativeQuestionIdentity {
  return {
    projectId: 'project', workId: 'work', attemptId: 'attempt',
    expectedRevision: { work: 2, criteria: 1, attempt: 3 }, questionId: 'question', questionRevision: 0,
  };
}
function record(): NativeQuestionRecord {
  return {
    version: 1, identity: identity(),
    admission: {
      contractId: 'ctr_question', ownerAgentId: 'agent', payloadRevision: hash('payload'),
      authorityId: hash('authority'), authorityRevision: hash('authority-revision'),
      scopeId: hash('scope'), scopeRevision: hash('scope-revision'),
    },
    question: 'Which output should the existing contract produce?', checkpointId: 'checkpoint', state: 'open', answer: null,
  };
}
function reply(): NativeQuestionReply { return { ...identity(), requestId: 'request', answer: '  Keep the exact text.\n' }; }
function throwsCode(action: () => unknown, code: NativeQuestionError['code']): void {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(NativeQuestionError);
    expect((error as NativeQuestionError).code).toBe(code);
    return;
  }
  throw new Error(`Expected NativeQuestionError(${code})`);
}

describe('bounded native question wire identity and reply', () => {
  test('accepts only identity and answer data, preserving exact text', () => {
    expect(nativeQuestionIdentitySchema.parse(identity())).toEqual(identity());
    expect(nativeQuestionReplySchema.parse(reply())).toEqual(reply());
    expect(parseNativeQuestionIdentity(identity())).toEqual(identity());
    expect(parseNativeQuestionReply(reply())).toEqual(reply());
    for (const extra of ['admission', 'checkpointId', 'ownerAgentId', 'authority', 'source', 'criteria', 'action']) {
      expect(nativeQuestionReplySchema.safeParse({ ...reply(), [extra]: 'injected' }).success).toBe(false);
      throwsCode(() => parseNativeQuestionReply({ ...reply(), [extra]: 'injected' }), 'invalid');
    }
    throwsCode(() => parseNativeQuestionIdentity({ ...identity(), expectedRevision: { ...identity().expectedRevision, ledger: 1 } }), 'invalid');
    throwsCode(() => parseNativeQuestionIdentity(reply()), 'invalid');
  });

  test('requires every field and refuses unknown or incorrectly typed values', () => {
    for (const key of Object.keys(reply())) {
      const missing: Record<string, unknown> = { ...reply() };
      delete missing[key];
      throwsCode(() => parseNativeQuestionReply(missing), 'invalid');
    }
    for (const answer of [null, undefined, false, 0, {}, [], '', ' \t\n']) {
      throwsCode(() => parseNativeQuestionReply({ ...reply(), answer }), 'invalid');
    }
    for (const value of [null, undefined, false, 0, '', [], new Date()]) {
      throwsCode(() => parseNativeQuestionIdentity(value), 'invalid');
      throwsCode(() => parseNativeQuestionReply(value), 'invalid');
      throwsCode(() => parseNativeQuestionRecord(value), 'invalid');
    }
  });

  test('all wire IDs have a 200-character limit without trimming or normalization', () => {
    for (const field of ['projectId', 'workId', 'attemptId', 'questionId', 'requestId'] as const) {
      expect(parseNativeQuestionReply({ ...reply(), [field]: 'x'.repeat(200) })[field]).toBe('x'.repeat(200));
      throwsCode(() => parseNativeQuestionReply({ ...reply(), [field]: 'x'.repeat(201) }), 'invalid');
      throwsCode(() => parseNativeQuestionReply({ ...reply(), [field]: '' }), 'invalid');
    }
    expect(parseNativeQuestionReply({ ...reply(), requestId: ' request ' }).requestId).toBe(' request ');
  });

  test('revisions must be safe nonnegative integers', () => {
    for (const bad of [-1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
      throwsCode(() => parseNativeQuestionIdentity({ ...identity(), questionRevision: bad }), 'invalid');
      for (const field of ['work', 'criteria', 'attempt'] as const) {
        throwsCode(() => parseNativeQuestionIdentity({ ...identity(), expectedRevision: { ...identity().expectedRevision, [field]: bad } }), 'invalid');
      }
    }
    expect(parseNativeQuestionIdentity({ ...identity(), questionRevision: Number.MAX_SAFE_INTEGER }).questionRevision).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseNativeQuestionIdentity({ ...identity(), expectedRevision: { work: 0, criteria: 0, attempt: Number.MAX_SAFE_INTEGER } }).expectedRevision.attempt).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('bounds answer UTF-8 bytes rather than JavaScript character count', () => {
    expect(parseNativeQuestionReply({ ...reply(), answer: 'x'.repeat(NATIVE_QUESTION_MAX_ANSWER_BYTES) }).answer.length).toBe(NATIVE_QUESTION_MAX_ANSWER_BYTES);
    expect(parseNativeQuestionReply({ ...reply(), answer: '🙂'.repeat(NATIVE_QUESTION_MAX_ANSWER_BYTES / 4) }).answer).toBe('🙂'.repeat(4096));
    throwsCode(() => parseNativeQuestionReply({ ...reply(), answer: 'x'.repeat(NATIVE_QUESTION_MAX_ANSWER_BYTES + 1) }), 'invalid');
    throwsCode(() => parseNativeQuestionReply({ ...reply(), answer: '🙂'.repeat(4096) + 'a' }), 'invalid');
    throwsCode(() => parseNativeQuestionReply({ ...reply(), answer: 'é'.repeat(8193) }), 'invalid');
  });

  test('independently bounds the serialized request including JSON escaping', () => {
    const base = { ...reply(), answer: 'a' };
    const overhead = new TextEncoder().encode(JSON.stringify(base)).byteLength - 1;
    const escapedCount = Math.floor((NATIVE_QUESTION_MAX_REQUEST_BYTES - overhead - 1) / 6);
    const padding = NATIVE_QUESTION_MAX_REQUEST_BYTES - overhead - escapedCount * 6;
    const exact = { ...reply(), answer: '\u0000'.repeat(escapedCount) + 'x'.repeat(padding) };
    expect(new TextEncoder().encode(exact.answer).byteLength).toBeLessThan(NATIVE_QUESTION_MAX_ANSWER_BYTES);
    expect(new TextEncoder().encode(JSON.stringify(exact)).byteLength).toBe(NATIVE_QUESTION_MAX_REQUEST_BYTES);
    expect(parseNativeQuestionReply(exact)).toEqual(exact);
    throwsCode(() => parseNativeQuestionReply({ ...exact, answer: `${exact.answer}x` }), 'invalid');
  });
});

describe('strict native question persisted records', () => {
  test('captures a detached deeply frozen data snapshot without freezing caller objects', () => {
    const input = record();
    const parsed = parseNativeQuestionRecord(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parsed.identity).not.toBe(input.identity);
    for (const value of [parsed, parsed.identity, parsed.identity.expectedRevision, parsed.admission]) expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.identity)).toBe(false);
    input.identity.expectedRevision.work++;
    expect(parsed.identity.expectedRevision.work).toBe(2);
  });

  test('requires exact own data fields at every persisted level', () => {
    const good = record();
    for (const field of Object.keys(good)) {
      const missing: Record<string, unknown> = { ...good };
      delete missing[field];
      throwsCode(() => parseNativeQuestionRecord(missing), 'invalid');
    }
    for (const bad of [
      { ...good, extra: true },
      { ...good, identity: { ...good.identity, extra: true } },
      { ...good, admission: { ...good.admission, extra: true } },
      { ...good, version: 2 },
      { ...good, state: 'continued' },
      { ...good, checkpointId: '' },
      { ...good, checkpointId: 'x'.repeat(201) },
    ]) throwsCode(() => parseNativeQuestionRecord(bad), 'invalid');
    for (const field of ['contractId', 'ownerAgentId'] as const) {
      expect(parseNativeQuestionRecord({ ...good, admission: { ...good.admission, [field]: 'x'.repeat(200) } }).admission[field].length).toBe(200);
      throwsCode(() => parseNativeQuestionRecord({ ...good, admission: { ...good.admission, [field]: 'x'.repeat(201) } }), 'invalid');
    }
  });

  test('requires canonical SHA-256 admission fingerprints', () => {
    for (const field of ['payloadRevision', 'authorityId', 'authorityRevision', 'scopeId', 'scopeRevision'] as const) {
      for (const invalid of ['revision', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)]) {
        throwsCode(() => parseNativeQuestionRecord({ ...record(), admission: { ...record().admission, [field]: invalid } }), 'invalid');
      }
    }
  });

  test('bounds question text by UTF-8 bytes and preserves original formatting', () => {
    const question = '🙂'.repeat(NATIVE_QUESTION_MAX_QUESTION_BYTES / 4);
    expect(parseNativeQuestionRecord({ ...record(), question }).question).toBe(question);
    expect(parseNativeQuestionRecord({ ...record(), question: '  Which?\n' }).question).toBe('  Which?\n');
    for (const invalid of ['', ' \t\n', `${question}x`, 'x'.repeat(NATIVE_QUESTION_MAX_QUESTION_BYTES + 1)]) {
      throwsCode(() => parseNativeQuestionRecord({ ...record(), question: invalid }), 'invalid');
    }
  });

  test('state and receipt are consistent, with answered terminal in version 1', () => {
    const answered = acceptNativeQuestionReply(record(), reply()).value;
    expect(parseNativeQuestionRecord(answered)).toEqual(answered);
    for (const state of ['open', 'cancelled', 'superseded'] as const) {
      expect(parseNativeQuestionRecord({ ...record(), state }).state).toBe(state);
      throwsCode(() => parseNativeQuestionRecord({ ...answered, state }), 'invalid');
    }
    throwsCode(() => parseNativeQuestionRecord({ ...record(), state: 'answered' }), 'invalid');
  });

  test('checks receipt digest against identity, request ID and exact answer', () => {
    const answered = acceptNativeQuestionReply(record(), reply()).value;
    expect(answered.answer?.digest).toBe(hash(JSON.stringify(nativeQuestionReplySchema.parse(reply()))));
    for (const answer of [
      { ...answered.answer, digest: '0'.repeat(64) },
      { ...answered.answer, digest: answered.answer?.digest.toUpperCase() },
      { ...answered.answer, answer: 'changed' },
      { ...answered.answer, requestId: 'changed' },
      { ...answered.answer, extra: true },
    ]) throwsCode(() => parseNativeQuestionRecord({ ...answered, answer }), 'invalid');
    throwsCode(() => parseNativeQuestionRecord({ ...answered, identity: { ...answered.identity, questionId: 'other' } }), 'invalid');
    throwsCode(() => parseNativeQuestionRecord({ ...answered, identity: { ...answered.identity, expectedRevision: { ...answered.identity.expectedRevision, work: 99 } } }), 'invalid');
  });

  test('never evaluates accessors in root, identity, revision, admission or answer', () => {
    let evaluations = 0;
    const withGetter = (value: object, field: string): object => Object.defineProperty({ ...value }, field, {
      enumerable: true, get() { evaluations++; throw new Error('Accessor must not run'); },
    });
    const answered = acceptNativeQuestionReply(record(), reply()).value;
    const candidates = [
      withGetter(record(), 'question'),
      { ...record(), identity: withGetter(identity(), 'workId') },
      { ...record(), identity: { ...identity(), expectedRevision: withGetter(identity().expectedRevision, 'work') } },
      { ...record(), admission: withGetter(record().admission, 'payloadRevision') },
      { ...answered, answer: withGetter(answered.answer!, 'answer') },
    ];
    for (const candidate of candidates) throwsCode(() => parseNativeQuestionRecord(candidate), 'invalid');
    throwsCode(() => parseNativeQuestionReply(withGetter(reply(), 'answer')), 'invalid');
    throwsCode(() => parseNativeQuestionIdentity(withGetter(identity(), 'questionId')), 'invalid');
    expect(evaluations).toBe(0);
  });

  test('rejects proxies before traps run, including nested and revoked proxies', () => {
    let traps = 0;
    const proxy = (value: object): object => new Proxy(value, {
      ownKeys() { traps++; throw new Error('No trap may run'); },
      getPrototypeOf() { traps++; throw new Error('No trap may run'); },
      get() { traps++; throw new Error('No trap may run'); },
    });
    const answered = acceptNativeQuestionReply(record(), reply()).value;
    for (const candidate of [
      proxy(record()),
      { ...record(), identity: proxy(identity()) },
      { ...record(), identity: { ...identity(), expectedRevision: proxy(identity().expectedRevision) } },
      { ...record(), admission: proxy(record().admission) },
      { ...answered, answer: proxy(answered.answer!) },
    ]) throwsCode(() => parseNativeQuestionRecord(candidate), 'invalid');
    throwsCode(() => parseNativeQuestionReply(proxy(reply())), 'invalid');
    throwsCode(() => parseNativeQuestionIdentity(proxy(identity())), 'invalid');
    const revoked = Proxy.revocable(record(), {});
    revoked.revoke();
    throwsCode(() => parseNativeQuestionRecord(revoked.proxy), 'invalid');
    expect(traps).toBe(0);
  });

  test('refuses non-enumerable, symbolic, inherited, cyclic or prototype-altered data', () => {
    const hidden = Object.defineProperty(record(), 'question', { value: 'Hidden', enumerable: false });
    const symbolic = Object.assign(record(), { [Symbol('authority')]: 'hidden' });
    const inherited = Object.assign(Object.create({ inherited: true }) as object, record());
    const nullPrototype = Object.assign(Object.create(null) as object, record());
    const cyclic = { ...record(), identity: {} };
    cyclic.identity = cyclic;
    for (const candidate of [hidden, symbolic, inherited, nullPrototype, cyclic]) {
      throwsCode(() => parseNativeQuestionRecord(candidate), 'invalid');
    }
  });
});

describe('pure native question reply acceptance and stable replay', () => {
  test('only changes open question state and stores the bounded answer receipt', () => {
    const current = record(), request = reply();
    const before = JSON.stringify({ current, request });
    const result = acceptNativeQuestionReply(current, request);
    expect(result.next).toBe(result.value);
    expect(result.value).toEqual({
      ...current, state: 'answered', answer: { requestId: request.requestId, answer: request.answer, digest: hash(JSON.stringify(request)) },
    });
    expect(JSON.stringify({ current, request })).toBe(before);
    expect(Object.isFrozen(current)).toBe(false);
    expect(Object.isFrozen(result.value.answer)).toBe(true);
    expect(result.value.identity.questionRevision).toBe(current.identity.questionRevision);
  });

  test('exact duplicate replays the stable receipt without another write after persistence', () => {
    const first = acceptNativeQuestionReply(record(), reply()).value;
    const persisted: NativeQuestionRecord = JSON.parse(JSON.stringify(first));
    const replay = acceptNativeQuestionReply(persisted, reply());
    expect(replay.next).toBeNull();
    expect(replay.value).toEqual(first);
    const reordered = { answer: reply().answer, requestId: reply().requestId, questionRevision: 0, questionId: 'question',
      expectedRevision: { attempt: 3, criteria: 1, work: 2 }, attemptId: 'attempt', workId: 'work', projectId: 'project' };
    expect(acceptNativeQuestionReply(first, reordered)).toEqual(replay);
  });

  test('changed reuse and alternate request IDs conflict even for the same answer', () => {
    const answered = acceptNativeQuestionReply(record(), reply()).value;
    for (const conflicting of [
      { ...reply(), answer: 'Changed answer' },
      { ...reply(), answer: reply().answer.trim() },
      { ...reply(), requestId: 'second-request' },
      { ...reply(), requestId: 'second-request', answer: 'Changed answer' },
    ]) throwsCode(() => acceptNativeQuestionReply(answered, conflicting), 'conflict');
    expect(acceptNativeQuestionReply(answered, reply()).value).toEqual(answered);
  });

  test('every identity component fences stale replies, including exact replay attempts', () => {
    const answered = acceptNativeQuestionReply(record(), reply()).value;
    const stale: NativeQuestionReply[] = [
      ...(['projectId', 'workId', 'attemptId', 'questionId'] as const).map(field => ({ ...reply(), [field]: 'other' })),
      { ...reply(), questionRevision: 1 },
      ...(['work', 'criteria', 'attempt'] as const).map(field => ({ ...reply(), expectedRevision: { ...identity().expectedRevision, [field]: 99 } })),
    ];
    for (const candidate of stale) {
      throwsCode(() => acceptNativeQuestionReply(record(), candidate), 'stale');
      throwsCode(() => acceptNativeQuestionReply(answered, candidate), 'stale');
    }
  });

  test('cancelled and superseded questions cannot accept a reply', () => {
    for (const state of ['cancelled', 'superseded'] as const) {
      throwsCode(() => acceptNativeQuestionReply({ ...record(), state }, reply()), 'stale');
    }
  });

  test('invalid persisted receipts cannot be used to replay or repair state', () => {
    const answered = acceptNativeQuestionReply(record(), reply()).value;
    throwsCode(() => acceptNativeQuestionReply({ ...answered, answer: { ...answered.answer!, digest: 'f'.repeat(64) } }, reply()), 'invalid');
    throwsCode(() => acceptNativeQuestionReply({ ...record(), state: 'answered' }, reply()), 'invalid');
  });
});
