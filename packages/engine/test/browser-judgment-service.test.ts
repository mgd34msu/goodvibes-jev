import { describe, expect, test } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog, noul, readYesNo, STAKES_BANDS, type JudgmentPort, type YesNoReading } from '@goodvibes-jev/judgment';
import { BrowserJudgmentError, type AuthenticatedPrincipal } from '../daemon-sdk/src/index.ts';
import { BrowserJudgmentRegistry, BrowserJudgmentReferences, BrowserJudgmentService } from '../sdk/src/platform/judgment-browser/index.ts';

const ID = 'webui.errors.daemon-refusal' as const;
const names = ['session_not_found', 'session_closed', 'session_active', 'session_not_local', 'method_unknown'] as const;
const questions = Object.fromEntries(names.map((name) => [name, noul(`Read ${name}.`)]));
const owner: AuthenticatedPrincipal = { principalId: 'owner', principalKind: 'user', admin: true, scopes: ['write:judgment'] };
const body = (errorRef = 'reference') => ({ protocolVersion: 1, requestId: crypto.randomUUID(), battery: ID, batteryVersion: 1, input: { errorRef } });

function fixture(options: { probability?: number; authorized?: boolean; state?: unknown; fanOut?: number; beforeAnswer?: (signal: AbortSignal | undefined) => Promise<void> } = {}) {
  const log = new SqliteDecisionLog(':memory:');
  const references = new BrowserJudgmentReferences();
  const registry = new BrowserJudgmentRegistry();
  let calls = 0; let current = true;
  const inner: JudgmentPort = { model: 'jev-1.13.0', ask: async (request) => {
    calls++;
    await options.beforeAnswer?.(request.signal);
    return { answers: Object.fromEntries(Object.keys(request.questions).map((name) => [name, { type: 'noul', noul: options.probability ?? 0.01 }])) as never,
      requestedModel: 'jev-1.13.0', model: 'jev-1.13.0', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1, requestId: undefined };
  } };
  const port = withDecisionLog(inner, log);
  registry.register({ id: ID, version: 1, questions, maxCalls: options.fanOut ?? 1,
    resolve: async () => ({ state: options.state ?? { message: 'Fixture error', status: 404 }, sourceBinding: 'fixture-only', assertCurrent() { if (!current) throw new BrowserJudgmentError('JUDGMENT_REFERENCE_HELD'); } }),
    run: async (active, state, { signal }) => {
      const [result] = await Promise.all(Array.from({ length: options.fanOut ?? 1 }, () => active.ask({ state: state as never, questions, signal })));
      if (!result) throw new Error('missing fixture result');
      return Object.fromEntries(names.map((name) => [name, readYesNo(result.answers[name] as never, STAKES_BANDS.medium.yesNo)])) as Record<typeof names[number], YesNoReading>;
    },
    project: (readings) => Object.values(readings).some((r) => r.outcome !== 'act')
      ? { status: 'held', reason: 'uncertain', readings }
      : { status: 'settled', value: {
        session_not_found: readings.session_not_found.verdict === 'yes', session_closed: readings.session_closed.verdict === 'yes',
        session_active: readings.session_active.verdict === 'yes', session_not_local: readings.session_not_local.verdict === 'yes', method_unknown: readings.method_unknown.verdict === 'yes',
      }, readings },
  });
  const service = new BrowserJudgmentService({ registry, references,
    currentRoute: () => ({ revision: 'fixture-route-1', kind: 'local', port, assertCurrent() { if (!current) throw new BrowserJudgmentError('JUDGMENT_PERMISSION_HELD'); } }),
    authorize: () => options.authorized !== false,
  });
  return { service, log, registry, references, calls: () => calls, invalidate: () => { current = false; } };
}

describe('browser judgment service (synthetic port only)', () => {
  test('records genuine fixture readings and returns typed evidence without raw state', async () => {
    const f = fixture();
    try {
      const result = await f.service.execute(body(), owner, new AbortController().signal) as Record<string, unknown>;
      expect(result.status).toBe('settled'); expect(result.outcome).toBe('act'); expect(f.calls()).toBe(1);
      expect(result.value).toEqual(Object.fromEntries(names.map((n) => [n, false])));
      expect(JSON.stringify(result)).not.toContain('Fixture error'); expect(f.log.query()).toHaveLength(1);
      expect(f.log.query()[0]?.context).toEqual({ battery: ID, batteryVersion: 1, site: 'browser.judgment' });
    } finally { await f.service.close(); f.log[Symbol.dispose](); }
  });
  test('uncertain readings retain escalation and carry no executable value', async () => {
    const f = fixture({ probability: 0.5 });
    try {
      const result = await f.service.execute(body(), owner, new AbortController().signal) as Record<string, unknown>;
      expect(result.status).toBe('held'); expect(result.outcome).toBe('escalate'); expect(Object.hasOwn(result, 'value')).toBe(false);
    } finally { await f.service.close(); f.log[Symbol.dispose](); }
  });
  test('protected full input refuses before provider or log', async () => {
    const f = fixture({ state: { message: 'short', nested: { password: 'fixture-secret' } } });
    try {
      await expect(f.service.execute(body(), owner, new AbortController().signal)).rejects.toMatchObject({ code: 'JUDGMENT_INPUT_HELD' });
      expect(f.calls()).toBe(0); expect(f.log.query()).toHaveLength(0);
    } finally { await f.service.close(); f.log[Symbol.dispose](); }
  });
  test('reference/source availability is separate from outbound authorization', async () => {
    const f = fixture({ authorized: false });
    try {
      await expect(f.service.execute(body(), owner, new AbortController().signal)).rejects.toMatchObject({ code: 'JUDGMENT_PERMISSION_HELD' });
      expect(f.calls()).toBe(0); expect(f.log.query()).toHaveLength(0);
    } finally { await f.service.close(); f.log[Symbol.dispose](); }
  });
  test('absent actual installation remains unavailable', async () => {
    const service = new BrowserJudgmentService({ registry: new BrowserJudgmentRegistry(), references: new BrowserJudgmentReferences(), currentRoute: () => undefined, authorize: () => false });
    await expect(service.execute(body(), owner, new AbortController().signal)).rejects.toMatchObject({ code: 'JUDGMENT_UNAVAILABLE' });
    await service.close();
  });
  test('caller cancellation reaches the port; close drains before log disposal', async () => {
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    const f = fixture({ beforeAnswer: (signal) => new Promise((_, reject) => { entered(); signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }); }) });
    const abort = new AbortController(); const pending = f.service.execute(body(), owner, abort.signal);
    await started; abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'JUDGMENT_ABORTED' });
    await f.service.close(); expect(f.log.query({ status: 'failed' })).toHaveLength(1); f.log[Symbol.dispose]();
    await expect(f.service.execute(body(), owner, abort.signal)).rejects.toMatchObject({ code: 'JUDGMENT_SHUTTING_DOWN' });
  });
  test('per-principal admission is bounded and cancelled requests drain', async () => {
    const f = fixture({ beforeAnswer: (signal) => new Promise((_, reject) => { signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }); }) });
    const requests = Array.from({ length: 4 }, () => f.service.execute(body(), owner, new AbortController().signal).catch((e: unknown) => e));
    await expect(f.service.execute(body(), owner, new AbortController().signal)).rejects.toMatchObject({ code: 'JUDGMENT_BUSY' });
    await f.service.close(); await Promise.all(requests); f.log[Symbol.dispose]();
  });
  test('source or route changing during provider work prevents delivery', async () => {
    let enter!: () => void; const started = new Promise<void>((resolve) => { enter = resolve; });
    let finish!: () => void;
    const f = fixture({ beforeAnswer: () => { enter(); return new Promise<void>((resolve) => { finish = resolve; }); } });
    const pending = f.service.execute(body(), owner, new AbortController().signal);
    await started; f.invalidate(); finish();
    await expect(pending).rejects.toMatchObject({ code: 'JUDGMENT_REFERENCE_HELD' });
    await f.service.close(); f.log[Symbol.dispose]();
  });
  test('a logical fan-out has at most four provider calls; cancellation removes queued siblings', async () => {
    let count = 0; let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const f = fixture({ fanOut: 8, beforeAnswer: (signal) => new Promise((_, reject) => {
      if (++count === 4) entered(); signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    }) });
    const pending = f.service.execute(body(), owner, new AbortController().signal).catch((e: unknown) => e);
    await started; expect(f.calls()).toBe(4); await f.service.close(); await pending;
    expect(f.calls()).toBe(4); expect(f.log.query({ status: 'failed' })).toHaveLength(4); f.log[Symbol.dispose]();
  });
  test('global provider cap stays eight across sixteen admitted principals', async () => {
    let count = 0; let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const f = fixture({ beforeAnswer: (signal) => new Promise((_, reject) => {
      if (++count === 8) entered(); signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    }) });
    const pending = Array.from({ length: 16 }, (_, i) => f.service.execute(body(), { ...owner, principalId: `principal-${i}` }, new AbortController().signal).catch((e: unknown) => e));
    await started; expect(f.calls()).toBe(8);
    await expect(f.service.execute(body(), { ...owner, principalId: 'principal-17' }, new AbortController().signal)).rejects.toMatchObject({ code: 'JUDGMENT_BUSY' });
    await f.service.close(); await Promise.all(pending); expect(f.calls()).toBe(8); f.log[Symbol.dispose]();
  });
});

describe('owned browser references', () => {
  test('requires the same principal and battery, current permission/revision, and expiry', () => {
    let now = 100; let readable = true; let current = true;
    const refs = new BrowserJudgmentReferences(() => now);
    const id = refs.issue({ principalId: owner.principalId, battery: ID, revision: 'r1', expiresAt: 200,
      snapshot: { message: 'text' }, mayRead: () => readable, assertCurrent() { if (!current) throw new Error('private revision details'); } });
    const resolved = refs.resolve(id, owner, ID, (snapshot) => snapshot);
    expect(resolved.state).toEqual({ message: 'text' });
    expect(() => refs.resolve(id, { ...owner, principalId: 'another' }, ID, (x) => x)).toThrow(BrowserJudgmentError);
    expect(() => refs.resolve(id, owner, 'webui.status.badge-tone', (x) => x)).toThrow(BrowserJudgmentError);
    readable = false; expect(resolved.assertCurrent).toThrow(BrowserJudgmentError); readable = true;
    current = false; expect(resolved.assertCurrent).toThrow(BrowserJudgmentError); current = true;
    now = 200; expect(resolved.assertCurrent).toThrow(BrowserJudgmentError); refs.close();
  });
  test('takes an immutable full snapshot, refuses protected material, and owns revocation', () => {
    const refs = new BrowserJudgmentReferences(() => 100);
    const snapshot = { message: 'old' };
    const spec = { principalId: owner.principalId, battery: ID, revision: 'r1', expiresAt: 200, snapshot, mayRead: () => true, assertCurrent() {} };
    const id = refs.issue(spec); snapshot.message = 'new';
    const resolved = refs.resolve(id, owner, ID, (x) => x);
    expect(resolved.state).toEqual({ message: 'old' });
    expect(() => refs.issue({ ...spec, snapshot: { password: 'fixture' } })).toThrow(BrowserJudgmentError);
    refs.revoke(id); expect(resolved.assertCurrent).toThrow(BrowserJudgmentError); refs.close();
    expect(() => refs.issue(spec)).toThrow(BrowserJudgmentError);
  });
});
