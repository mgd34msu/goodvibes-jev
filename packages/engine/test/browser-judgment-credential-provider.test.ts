import { expect, spyOn, test } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { BrowserJudgmentError, createBrowserJudgmentHttpHandler, type AuthenticatedPrincipal, type BrowserJudgmentRequest } from '../daemon-sdk/src/index.ts';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.ts';
import { createWebuiBrowserJudgment } from '../sdk/src/platform/judgment-browser/webui-runtime.ts';
import { withWebuiAnswerBoundary } from '../sdk/src/platform/judgment-browser/batteries/webui-answers.ts';

const owner: AuthenticatedPrincipal = { principalId: 'synthetic-credential-owner', principalKind: 'user', admin: true, scopes: ['write:judgment'] };
const ORIGIN = 'https://daemon.fixture.invalid';
const RAW_VALUE = 'synthetic-credential-value-never-for-judgment';
const PROVIDER_DETAIL = 'synthetic-private-provider-response-detail';
const NAMES = ['OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'GOOGLE_GEMINI_API_KEY'];
type Request = BrowserJudgmentRequest<'webui.credentials.provider-key'>;
const request = (keys: readonly string[] = ['OPENAI_API_KEY'], providerId = 'openai'): Request => ({
  protocolVersion: 1, requestId: crypto.randomUUID(), battery: 'webui.credentials.provider-key', batteryVersion: 1,
  input: { providerId, keys },
});
const barrier = () => Promise.withResolvers<void>();

function fixture(options: {
  names?: readonly string[]; source?: boolean; probability?: (key: string) => number;
  beforeList?: () => Promise<void>; beforeAnswer?: (key: string, index: number) => Promise<void>;
  answers?: () => unknown; failAnswer?: boolean;
} = {}) {
  const log = new SqliteDecisionLog(':memory:');
  const calls: unknown[] = [];
  const permissions: unknown[] = [];
  let actor = owner; let authorized = true; let methodAvailable = true; let epoch = 1;
  let listCalls = 0; let valueReads = 0; let active = 0; let maxActive = 0;
  const lifetime = new AbortController();
  const routeLifetime = new AbortController();
  const names = [...(options.names ?? NAMES)];
  // The canonical source offers names and lifetime only. A value resolver is a
  // deliberate tripwire, never part of the runtime's permitted source contract.
  const source = {
    async list() { listCalls++; await options.beforeList?.(); return [...names]; },
    lifetime() {
      const revision = epoch;
      return { signal: lifetime.signal, assertCurrent() {
        if (epoch !== revision) throw new BrowserJudgmentError('JUDGMENT_REFERENCE_HELD');
      } };
    },
    async resolve() { valueReads++; return RAW_VALUE; },
  };
  const inner: JudgmentPort = { model: 'jev-1.13.0', async ask(input) {
    const index = calls.length;
    calls.push(input.state); active++; maxActive = Math.max(maxActive, active);
    const { key } = input.state as { readonly key: string };
    try {
      await options.beforeAnswer?.(key, index);
      if (options.failAnswer) throw new Error(PROVIDER_DETAIL);
      return { requestedModel: 'jev-1.13.0', model: 'jev-1.13.0', requestId: PROVIDER_DETAIL,
        usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1,
        answers: options.answers ? options.answers() : { matches: { type: 'noul', noul: options.probability?.(key) ?? 0.99 } },
      } as never;
    } finally { active--; }
  } };
  const methods = new GatewayMethodCatalog();
  const service = createWebuiBrowserJudgment({
    methods: { get: id => id === 'credentials.get' && !methodAvailable ? null : methods.get(id) },
    ...(options.source === false ? {} : { credentialNames: source }),
    currentRoute: () => ({ revision: 'synthetic-credential-route', kind: 'local', signal: routeLifetime.signal,
      port: withDecisionLog(withWebuiAnswerBoundary(inner), log), assertCurrent() {} }),
    authorize(input) {
      permissions.push(input);
      return authorized && input.battery === 'webui.credentials.provider-key'
        && input.sources.length === 1 && input.sources[0] === 'credential-names';
    },
  });
  const handler = createBrowserJudgmentHttpHandler({ authenticate: () => actor, sameOrigins: () => [ORIGIN],
    cors: () => ({ enabled: false, allowedOrigins: [] }), service });
  return {
    service, methods, calls, permissions, log, lifetime, routeLifetime,
    listCalls: () => listCalls, valueReads: () => valueReads, maxActive: () => maxActive,
    setActor: (value: AuthenticatedPrincipal) => { actor = value; },
    deny: () => { authorized = false; }, removeMethod: () => { methodAvailable = false; },
    changeEpoch: () => { epoch++; },
    run: (input: unknown = request(), signal = new AbortController().signal) => service.execute(input, owner, signal, () => actor),
    async wire(input: unknown = request()) {
      const response = await handler(new Request(`${ORIGIN}/api/judgment/batteries/run`, { method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(input) }));
      return { status: response.status, body: await response.text() };
    },
    async close() { await service.close(); log[Symbol.dispose](); },
  };
}

test('real HTTP runtime verifies canonical names and returns recorded booleans without credential values or provider detail', async () => {
  const f = fixture({ probability: key => key === 'OPENAI_API_KEY' ? 0.99 : 0.01 });
  const input = request(['AZURE_OPENAI_API_KEY', 'OPENAI_API_KEY']);
  try {
    const response = await f.wire(input);
    expect(response.status, response.body).toBe(200);
    const result = JSON.parse(response.body);
    expect(result).toMatchObject({ protocolVersion: 1, requestId: input.requestId, battery: input.battery, batteryVersion: 1,
      status: 'settled', outcome: 'act', value: { matches: [false, true] },
      readings: { key_0: { kind: 'yes-no', probability: 0.01, verdict: 'no' }, key_1: { kind: 'yes-no', probability: 0.99, verdict: 'yes' } },
      evidence: [{ decisionId: expect.any(String) }, { decisionId: expect.any(String) }] });
    expect(f.calls).toEqual(input.input.keys.map(key => ({ providerId: 'openai', key })));
    expect(f.listCalls()).toBe(1); expect(f.valueReads()).toBe(0);
    expect(f.permissions.length).toBeGreaterThan(0);
    expect(f.permissions.every(input => (input as { sources: string[] }).sources.join(',') === 'credential-names')).toBe(true);
    const records = f.log.query();
    expect(records).toHaveLength(2);
    expect(records.every(entry => entry.status === 'answered' && entry.notes.some(note => note.kind === 'action' && note.action === 'ready'))).toBe(true);
    // Fixed questions contain public example names. State itself is hash-only.
    records.forEach(entry => expect(entry).not.toHaveProperty('state'));
    const retained = JSON.stringify(records.map(({ questions: _questions, ...entry }) => entry));
    for (const text of [...NAMES, RAW_VALUE, PROVIDER_DETAIL, owner.principalId]) {
      expect(response.body).not.toContain(text); expect(retained).not.toContain(text);
    }
    expect(JSON.stringify(f.calls)).not.toContain(RAW_VALUE);
  } finally { await f.close(); }
});

test('multi-key fan-out is bounded to four and preserves request order when answers finish out of order', async () => {
  const keys = Array.from({ length: 7 }, (_, index) => `SYNTHETIC_PROVIDER_KEY_${index}`);
  const gates = keys.map(() => barrier()); const firstFour = barrier(); const fifth = barrier();
  const f = fixture({ names: keys, probability: key => Number(key.at(-1)) % 2 === 0 ? 0.99 : 0.01,
    beforeAnswer: async (_key, index) => {
      if (index === 3) firstFour.resolve(); if (index === 4) fifth.resolve();
      await gates[index]!.promise;
    } });
  const pending = f.run(request(keys));
  try {
    await firstFour.promise; expect(f.calls).toHaveLength(4); expect(f.maxActive()).toBe(4);
    gates[3]!.resolve(); await fifth.promise;
    expect(f.calls).toHaveLength(5); expect(f.maxActive()).toBe(4);
    gates.forEach(gate => gate.resolve());
    expect(await pending).toMatchObject({ status: 'settled', value: { matches: [true, false, true, false, true, false, true] } });
    expect(f.calls).toEqual(keys.map(key => ({ providerId: 'openai', key })));
    expect(f.log.query()).toHaveLength(7); expect(f.valueReads()).toBe(0);
  } finally { gates.forEach(gate => gate.resolve()); await pending.catch(() => {}); await f.close(); }
});

test('the complete admitted 64-name inventory gets one reading per name without resolving values', async () => {
  const keys = Array.from({ length: 64 }, (_, index) => `SYNTHETIC_PROVIDER_KEY_${index}`);
  const f = fixture({ names: keys });
  try {
    const result = await f.run(request(keys));
    expect(result).toMatchObject({ status: 'settled', value: { matches: keys.map(() => true) } });
    expect(f.calls).toHaveLength(64); expect(f.log.query()).toHaveLength(64);
    expect(f.listCalls()).toBe(1); expect(f.maxActive()).toBeLessThanOrEqual(4); expect(f.valueReads()).toBe(0);
  } finally { await f.close(); }
});

test.each(['missing-name', 'missing-source', 'missing-method', 'non-admin-method', 'remote-peer-method', 'not-admin', 'other-owner', 'other-kind', 'purpose', 'expired-source'] as const)
  ('%s cannot reach the provider or retain a name hash', async kind => {
    const f = fixture({ source: kind !== 'missing-source' });
    try {
      if (kind === 'missing-method') f.removeMethod();
      if (kind === 'non-admin-method' || kind === 'remote-peer-method') f.methods.register({ ...f.methods.get('credentials.get')!,
        access: kind === 'non-admin-method' ? 'authenticated' : 'remote-peer' }, undefined, { replace: true });
      if (kind === 'not-admin') f.setActor({ ...owner, admin: false });
      if (kind === 'other-owner') f.setActor({ ...owner, principalId: 'other-owner' });
      if (kind === 'other-kind') f.setActor({ ...owner, principalKind: 'token' });
      if (kind === 'purpose') f.deny();
      if (kind === 'expired-source') f.lifetime.abort();
      await expect(f.run(kind === 'missing-name' ? request(['OPENAI_API_KEY', 'MISSING_CANONICAL_NAME']) : request())).rejects.toBeInstanceOf(BrowserJudgmentError);
      expect(f.calls).toEqual([]); expect(f.log.query()).toEqual([]); expect(f.valueReads()).toBe(0);
    } finally { await f.close(); }
  });

test.each(['duplicate-name', 'empty-list', 'too-many-names', 'oversize-name', 'oversize-provider', 'empty-provider', 'raw-values', 'key-object'] as const)
  ('%s is rejected by the wire shape before canonical lookup, provider calls or retention', async kind => {
    const f = fixture();
    const input: { providerId: unknown; keys: unknown; values?: unknown } = { providerId: 'openai', keys: ['OPENAI_API_KEY'] };
    if (kind === 'duplicate-name') input.keys = ['OPENAI_API_KEY', 'OPENAI_API_KEY'];
    if (kind === 'empty-list') input.keys = [];
    if (kind === 'too-many-names') input.keys = Array.from({ length: 65 }, (_, index) => `SYNTHETIC_KEY_${index}`);
    if (kind === 'oversize-name') input.keys = ['x'.repeat(257)];
    if (kind === 'oversize-provider') input.providerId = 'x'.repeat(129);
    if (kind === 'empty-provider') input.providerId = '';
    if (kind === 'raw-values') input.values = { OPENAI_API_KEY: RAW_VALUE };
    if (kind === 'key-object') input.keys = [{ name: 'OPENAI_API_KEY', value: RAW_VALUE }];
    try {
      const response = await f.wire({ ...request(), input });
      expect(response.status).not.toBe(200); expect(response.body).not.toContain(RAW_VALUE);
      expect(f.listCalls()).toBe(0); expect(f.calls).toEqual([]); expect(f.log.query()).toEqual([]); expect(f.valueReads()).toBe(0);
    } finally { await f.close(); }
  });

test.each(['provider', 'first-name', 'last-name'] as const)('protected material in the complete %s is held before inventory narrowing', async kind => {
  const protectedText = 'Authorization: Bearer synthetic-inline-credential';
  const keys = kind === 'first-name' ? [protectedText, ...NAMES] : kind === 'last-name' ? [...NAMES, protectedText] : NAMES;
  const f = fixture({ names: keys });
  try {
    await expect(f.run(request(keys, kind === 'provider' ? protectedText : 'openai'))).rejects.toMatchObject({ code: 'JUDGMENT_INPUT_HELD' });
    expect(f.listCalls()).toBe(0); expect(f.calls).toEqual([]); expect(f.log.query()).toEqual([]); expect(f.valueReads()).toBe(0);
  } finally { await f.close(); }
});

test.each(['owner', 'kind', 'admin', 'method', 'epoch', 'source-abort', 'request-abort'] as const)
  ('%s changing during canonical inventory lookup prevents the first transmission', async kind => {
    const entered = barrier(); const finish = barrier(); const abort = new AbortController();
    const f = fixture({ beforeList: async () => { entered.resolve(); await finish.promise; } });
    const pending = f.run(request(), abort.signal).catch((error: unknown) => error);
    try {
      await entered.promise;
      if (kind === 'owner') f.setActor({ ...owner, principalId: 'replacement-owner' });
      if (kind === 'kind') f.setActor({ ...owner, principalKind: 'token' });
      if (kind === 'admin') f.setActor({ ...owner, admin: false });
      if (kind === 'method') f.methods.register({ ...f.methods.get('credentials.get')! }, undefined, { replace: true });
      if (kind === 'epoch') f.changeEpoch();
      if (kind === 'source-abort') f.lifetime.abort();
      if (kind === 'request-abort') abort.abort();
      finish.resolve(); expect(await pending).toBeInstanceOf(BrowserJudgmentError);
      await f.service.close();
      expect(f.calls).toEqual([]); expect(f.log.query()).toEqual([]); expect(f.valueReads()).toBe(0);
    } finally { finish.resolve(); await pending; await f.close(); }
  });

test('caller mutation during inventory lookup cannot replace the captured provider or key names', async () => {
  const entered = barrier(); const finish = barrier(); const keys = ['OPENAI_API_KEY']; const input = request(keys);
  const f = fixture({ beforeList: async () => { entered.resolve(); await finish.promise; } });
  const pending = f.run(input);
  try {
    await entered.promise; keys[0] = 'AZURE_OPENAI_API_KEY'; Object.assign(input.input, { providerId: 'replacement-provider' });
    finish.resolve(); expect(await pending).toMatchObject({ status: 'settled', value: { matches: [true] } });
    expect(f.calls).toEqual([{ providerId: 'openai', key: 'OPENAI_API_KEY' }]);
  } finally { finish.resolve(); await pending.catch(() => {}); await f.close(); }
});

test.each(['owner', 'kind', 'admin', 'missing-method', 'changed-method', 'method-access', 'epoch', 'source-abort', 'purpose', 'route-abort', 'request-abort', 'shutdown'] as const)
  ('%s changing while answers wait prevents stale delivery and all answer/failure retention', async kind => {
    const entered = barrier(); const finish = barrier(); const abort = new AbortController();
    const f = fixture({ beforeAnswer: async () => { entered.resolve(); await finish.promise; } });
    const pending = f.run(request(), abort.signal).catch((error: unknown) => error);
    try {
      await entered.promise;
      if (kind === 'owner') f.setActor({ ...owner, principalId: 'replacement-owner' });
      if (kind === 'kind') f.setActor({ ...owner, principalKind: 'token' });
      if (kind === 'admin') f.setActor({ ...owner, admin: false });
      if (kind === 'missing-method') f.removeMethod();
      if (kind === 'changed-method' || kind === 'method-access') f.methods.register({ ...f.methods.get('credentials.get')!,
        ...(kind === 'method-access' ? { access: 'authenticated' as const } : {}) }, undefined, { replace: true });
      if (kind === 'epoch') f.changeEpoch();
      if (kind === 'source-abort') f.lifetime.abort();
      if (kind === 'purpose') f.deny();
      if (kind === 'route-abort') f.routeLifetime.abort();
      if (kind === 'request-abort') abort.abort();
      if (kind === 'shutdown') void f.service.close();
      finish.resolve(); expect(await pending).toBeInstanceOf(BrowserJudgmentError);
      await f.service.close();
      expect(f.calls).toHaveLength(1); expect(f.log.query()).toEqual([]); expect(f.valueReads()).toBe(0);
    } finally { finish.resolve(); await pending; await f.close(); }
  });

test('source epoch revocation suppresses even the failure record of a late provider rejection', async () => {
  const entered = barrier(); const finish = barrier();
  const f = fixture({ failAnswer: true, beforeAnswer: async () => { entered.resolve(); await finish.promise; } });
  const pending = f.run().catch((error: unknown) => error);
  try {
    await entered.promise; f.changeEpoch(); finish.resolve();
    const error = await pending; expect(error).toBeInstanceOf(BrowserJudgmentError); expect(String(error)).not.toContain(PROVIDER_DETAIL);
    await f.service.close(); expect(f.log.query()).toEqual([]);
  } finally { finish.resolve(); await pending; await f.close(); }
});

test('one uncertain key holds the entire multi-key result without a partial matching value', async () => {
  const f = fixture({ probability: key => key === 'AZURE_OPENAI_API_KEY' ? 0.5 : 0.99 });
  try {
    const result = await f.run(request(NAMES));
    expect(result).toMatchObject({ status: 'held', reason: 'uncertain', readings: { key_1: { kind: 'yes-no', verdict: 'uncertain' } } });
    expect(result).not.toHaveProperty('value'); expect(f.calls).toHaveLength(3);
    const records = f.log.query(); expect(records).toHaveLength(3);
    expect(records.every(entry => entry.status === 'answered' && entry.notes.some(note => note.kind === 'action' && note.action === 'unsettled'))).toBe(true);
  } finally { await f.close(); }
});

test.each([
  ['missing-answer', {}],
  ['wrong-item', { match: { type: 'noul', noul: 0.99 } }],
  ['extra-item', { matches: { type: 'noul', noul: 0.99 }, extra: { type: 'noul', noul: 0.99 } }],
  ['wrong-kind', { matches: { type: 'choice', choice: 'yes', confidence: 0.99, probabilities: { yes: 0.99, no: 0.01 } } }],
  ['string-probability', { matches: { type: 'noul', noul: '0.99' } }],
  ['out-of-range', { matches: { type: 'noul', noul: 1.1 } }],
  ['nonfinite-probability', { matches: { type: 'noul', noul: Number.NaN } }],
  ['provider-extension', { matches: { type: 'noul', noul: 0.99, explanation: PROVIDER_DETAIL } }],
] as const)('malformed %s produces only sanitized failed evidence, never a reading or matching value', async (_kind, answers) => {
  const f = fixture({ answers: () => answers });
  try {
    await expect(f.run()).rejects.toMatchObject({ code: 'JUDGMENT_INVALID_RESPONSE' });
    expect(f.calls).toHaveLength(1);
    const records = f.log.query(); expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 'failed', error: { kind: 'invalid-response' } });
    expect(records[0]).not.toHaveProperty('answers'); expect(records[0]).not.toHaveProperty('notes');
    const retained = JSON.stringify(records.map(({ questions: _questions, ...entry }) => entry));
    for (const text of [PROVIDER_DETAIL, RAW_VALUE, ...NAMES]) expect(retained).not.toContain(text);
  } finally { await f.close(); }
});

test('malformed answer getters are rejected without executing provider-controlled code or retaining its detail', async () => {
  let reads = 0;
  const answer = Object.defineProperty({ type: 'noul' }, 'noul', { enumerable: true, get() { reads++; throw new Error(PROVIDER_DETAIL); } });
  const f = fixture({ answers: () => ({ matches: answer }) });
  try {
    await expect(f.run()).rejects.toMatchObject({ code: 'JUDGMENT_INVALID_RESPONSE' });
    expect(reads).toBe(0); expect(f.log.query()).toHaveLength(1);
    expect(JSON.stringify(f.log.query())).not.toContain(PROVIDER_DETAIL);
  } finally { await f.close(); }
});

test.each(['settled', 'uncertain', 'malformed', 'denied'] as const)('%s completion disposes the source retirement listener', async kind => {
  const f = fixture({ probability: () => kind === 'uncertain' ? 0.5 : 0.99,
    ...(kind === 'malformed' ? { answers: () => ({}) } : {}) });
  const added = spyOn(f.lifetime.signal, 'addEventListener');
  const removed = spyOn(f.lifetime.signal, 'removeEventListener');
  try {
    if (kind === 'denied') f.deny();
    const result = await f.run().catch((error: unknown) => error);
    if (kind === 'malformed' || kind === 'denied') expect(result).toBeInstanceOf(BrowserJudgmentError);
    else expect(result).toMatchObject({ status: kind === 'uncertain' ? 'held' : 'settled' });
    expect(added.mock.calls).toHaveLength(1);
    expect(added.mock.calls[0]![0]).toBe('abort');
    expect(removed.mock.calls.some(([event, listener]) => event === 'abort' && listener === added.mock.calls[0]![1])).toBe(true);
  } finally { await f.close(); added.mockRestore(); removed.mockRestore(); }
});

test('completed requests release all owned reference slots before the next inventory lookup', async () => {
  const f = fixture();
  try {
    // The reference store holds at most 64 active entries. Finished reads must
    // release their source snapshots rather than wait for the five-minute TTL.
    for (let index = 0; index < 65; index++) expect(await f.run()).toMatchObject({ status: 'settled' });
    expect(f.calls).toHaveLength(65); expect(f.listCalls()).toBe(65); expect(f.valueReads()).toBe(0);
  } finally { await f.close(); }
});

test('source retirement cancels queued fan-out, detaches its listener and drains dispatched siblings before closing', async () => {
  const keys = Array.from({ length: 7 }, (_, index) => `SYNTHETIC_PROVIDER_KEY_${index}`);
  const entered = barrier(); const finish = barrier();
  const f = fixture({ names: keys, beforeAnswer: async (_key, index) => {
    if (index === 3) entered.resolve(); await finish.promise;
  } });
  const added = spyOn(f.lifetime.signal, 'addEventListener');
  const removed = spyOn(f.lifetime.signal, 'removeEventListener');
  const pending = f.run(request(keys)).catch((error: unknown) => error);
  try {
    await entered.promise; f.lifetime.abort();
    expect(await pending).toMatchObject({ code: 'JUDGMENT_REFERENCE_HELD' });
    expect(f.calls).toHaveLength(4);
    expect(removed.mock.calls.some(([event, listener]) => event === 'abort' && listener === added.mock.calls[0]![1])).toBe(true);
    let closed = false;
    const closing = f.service.close().then(() => { closed = true; });
    await Promise.resolve(); await Promise.resolve(); expect(closed).toBe(false);
    finish.resolve(); await closing;
    expect(f.calls).toHaveLength(4); expect(f.log.query()).toEqual([]); expect(f.valueReads()).toBe(0);
  } finally { finish.resolve(); await pending; await f.close(); added.mockRestore(); removed.mockRestore(); }
});
