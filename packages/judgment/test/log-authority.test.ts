import { describe, expect, spyOn, test } from 'bun:test';
import { JudgmentError, SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '../src/index.ts';

const PRIVATE = 'synthetic-private-source-and-assertion';
const request = { state: { message: PRIVATE }, questions: { q: { type: 'noul', instructions: 'Q?' } } } as const;
const result = () => ({
  answers: { q: { type: 'noul', noul: 0.9 } }, requestedModel: 'jev-1.13.0', model: 'jev-1.13.0',
  usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1, requestId: undefined,
} as const);
const borrowed = (answer: unknown = result()): JudgmentPort => ({ model: 'jev-1.13.0', async ask() { return answer as never; } });
const deferred = () => Promise.withResolvers<void>();

function denied(error: unknown): void {
  expect(error).toBeInstanceOf(JudgmentError);
  const failure = error as JudgmentError;
  expect(failure.kind).toBe('rejected');
  expect(failure.message).toBe('the judgment request was rejected');
  expect(failure.cause).toBeUndefined();
  expect(failure.lineage).toBeUndefined();
  expect(`${failure.stack}\n${JSON.stringify(failure)}`).not.toContain(PRIVATE);
}

describe('recording authority', () => {
  test('initial refusal reads no source and performs no hash, provider call, or write', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const inner = borrowed(); const ask = spyOn(inner, 'ask'); const record = spyOn(log, 'record');
    const hash = spyOn(Bun.CryptoHasher, 'hash'); let sourceReads = 0;
    try {
      denied(await withDecisionLog(inner, log).ask({ ...request,
        get state() { sourceReads++; return request.state; },
        assertLogCurrent() { throw new Error(PRIVATE); },
      }).catch((error: unknown) => error));
      expect(sourceReads).toBe(0); expect(hash).not.toHaveBeenCalled();
      expect(ask).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
      expect(log.query()).toEqual([]);
    } finally { hash.mockRestore(); record.mockRestore(); ask.mockRestore(); }
  });

  test.each(['state', 'questions', 'context', 'clock', 'throwing-state'] as const)('rechecks %s capture before hashing', async (stage) => {
    using log = new SqliteDecisionLog(':memory:');
    let current = true; const inner = borrowed(); const ask = spyOn(inner, 'ask');
    const hash = spyOn(Bun.CryptoHasher, 'hash'); const record = spyOn(log, 'record');
    const revoke = () => { current = false; };
    try {
      const input = { ...request,
        get state() {
          if (stage === 'state' || stage === 'throwing-state') revoke();
          if (stage === 'throwing-state') throw new Error(PRIVATE);
          return request.state;
        },
        get questions() { if (stage === 'questions') revoke(); return request.questions; },
        context: { get site() { if (stage === 'context') revoke(); return 'authority-fixture'; } },
        assertLogCurrent() { if (!current) throw new Error(PRIVATE); },
      };
      const now = () => { if (stage === 'clock') revoke(); return new Date(); };
      denied(await withDecisionLog(inner, log, now).ask(input).catch((error: unknown) => error));
      expect(hash).not.toHaveBeenCalled(); expect(ask).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
      expect(log.query()).toEqual([]);
    } finally { hash.mockRestore(); record.mockRestore(); ask.mockRestore(); }
  });

  test.each(['answer', 'failure'] as const)('revocation during delayed %s refuses all subsequent records', async (stage) => {
    using log = new SqliteDecisionLog(':memory:');
    let current = true; const entered = deferred(); const release = deferred();
    const inner: JudgmentPort = { model: 'jev-1.13.0', async ask() {
      entered.resolve(); await release.promise;
      if (stage === 'failure') throw new JudgmentError('unavailable', PRIVATE);
      return result() as never;
    } };
    const record = spyOn(log, 'record');
    try {
      const pending = withDecisionLog(inner, log).ask({ ...request,
        assertLogCurrent() { if (!current) throw new Error(PRIVATE); },
      }).catch((error: unknown) => error);
      await entered.promise; current = false; release.resolve();
      denied(await pending); expect(record).not.toHaveBeenCalled(); expect(log.query()).toEqual([]);
    } finally { release.resolve(); record.mockRestore(); }
  });

  test.each(['answer', 'failure'] as const)('rechecks after borrowed %s projection getters', async (stage) => {
    using log = new SqliteDecisionLog(':memory:');
    let current = true;
    const response = { ...result(), usage: {
      get inputTokens() { current = false; return 1; }, outputTokens: 1,
    } };
    const upstream = new JudgmentError('unavailable', PRIVATE);
    Object.defineProperty(upstream, 'requestId', { get() { current = false; return 'synthetic-request'; } });
    const inner = stage === 'answer' ? borrowed(response) : { model: 'jev-1.13.0', async ask() { throw upstream; } };
    const record = spyOn(log, 'record');
    try {
      denied(await withDecisionLog(inner, log).ask({ ...request,
        assertLogCurrent() { if (!current) throw new Error(PRIVATE); },
      }).catch((error: unknown) => error));
      expect(record).not.toHaveBeenCalled(); expect(log.query()).toEqual([]);
    } finally { record.mockRestore(); }
  });

  test.each([null, true, false, 0, '', {}, () => {}])('refuses non-undefined assertion result %p', async (value) => {
    using log = new SqliteDecisionLog(':memory:');
    const hash = spyOn(Bun.CryptoHasher, 'hash');
    try {
      denied(await withDecisionLog(borrowed(), log).ask({ ...request, assertLogCurrent: () => value }).catch((error: unknown) => error));
      expect(hash).not.toHaveBeenCalled(); expect(log.query()).toEqual([]);
    } finally { hash.mockRestore(); }
  });

  test.each(['promise', 'thenable', 'throwing-then'] as const)('consumes refused %s without an unhandled private rejection', async (kind) => {
    using log = new SqliteDecisionLog(':memory:'); let consumed = 0;
    const hash = spyOn(Bun.CryptoHasher, 'hash');
    try {
      denied(await withDecisionLog(borrowed(), log).ask({ ...request, assertLogCurrent() {
        if (kind === 'promise') return Promise.reject(new Error(PRIVATE));
        if (kind === 'throwing-then') return { get then() { consumed++; throw new Error(PRIVATE); } };
        return { then(_resolve: unknown, reject: (reason: unknown) => void) { consumed++; reject(new Error(PRIVATE)); } };
      } }).catch((error: unknown) => error));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(consumed).toBe(kind === 'promise' ? 0 : 1);
      expect(hash).not.toHaveBeenCalled(); expect(log.query()).toEqual([]);
    } finally { hash.mockRestore(); }
  });

  test('captures the assertion accessor once and forwards the same hook', async () => {
    using log = new SqliteDecisionLog(':memory:'); let reads = 0; let checks = 0;
    const check = () => { checks++; };
    const inner: JudgmentPort = { model: 'jev-1.13.0', async ask(incoming) {
      expect(incoming.assertLogCurrent).toBe(check); return result() as never;
    } };
    const answer = await withDecisionLog(inner, log).ask({ ...request,
      get assertLogCurrent() { reads++; return reads === 1 ? check : () => { throw new Error(PRIVATE); }; },
    });
    expect(reads).toBe(1); expect(checks).toBe(3); expect(log.get(answer.decisionId!)).toMatchObject({ status: 'answered' });
  });

  test('a throwing assertion accessor fails value-free before source capture', async () => {
    using log = new SqliteDecisionLog(':memory:'); const hash = spyOn(Bun.CryptoHasher, 'hash');
    try {
      denied(await withDecisionLog(borrowed(), log).ask({ ...request,
        get assertLogCurrent(): () => void { throw new Error(PRIVATE); },
      }).catch((error: unknown) => error));
      expect(hash).not.toHaveBeenCalled(); expect(log.query()).toEqual([]);
    } finally { hash.mockRestore(); }
  });

  test('a final assertion refusal never becomes a replacement failed entry', async () => {
    using log = new SqliteDecisionLog(':memory:'); let checks = 0;
    denied(await withDecisionLog(borrowed(), log).ask({ ...request, assertLogCurrent() {
      if (++checks === 3) throw new Error(PRIVATE);
    } }).catch((error: unknown) => error));
    expect(checks).toBe(3); expect(log.query()).toEqual([]);
  });

  test('omitting the hook preserves cancelled-call failure recording', async () => {
    using log = new SqliteDecisionLog(':memory:'); const abort = new AbortController(); abort.abort();
    const error = await withDecisionLog(borrowed(), log).ask({ ...request, signal: abort.signal }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(JudgmentError); expect((error as JudgmentError).kind).toBe('aborted');
    expect(log.query()).toMatchObject([{ status: 'failed', error: { kind: 'aborted' } }]);
  });
});
