import { expect, test } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { BrowserJudgmentError, type AuthenticatedPrincipal, type BrowserJudgmentRequest } from '../daemon-sdk/src/index.ts';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.ts';
import { createWebuiBrowserJudgment } from '../sdk/src/platform/judgment-browser/webui-runtime.ts';
import { WEBUI_COMMAND_CATALOG_VERSION } from '../sdk/src/platform/judgment-browser/batteries/webui-command-catalog.ts';

const owner: AuthenticatedPrincipal = { principalId: 'synthetic-owner', principalKind: 'user', admin: false, scopes: ['write:judgment', 'read:sessions'] };
const request = (candidates: BrowserJudgmentRequest<'webui.palette.command-rank'>['input']['candidates'] = [{ kind: 'builtin', commandId: 'nav.chat' }, { kind: 'chat', sessionId: 'fixture-chat' }]): BrowserJudgmentRequest<'webui.palette.command-rank'> => ({
  protocolVersion: 1, requestId: crypto.randomUUID(), battery: 'webui.palette.command-rank', batteryVersion: 1,
  input: { query: { kind: 'inline', text: 'Find synthetic plans' }, registryVersion: WEBUI_COMMAND_CATALOG_VERSION, candidates },
});
const barrier = () => Promise.withResolvers<void>();

test('cancellation in the adapter handoff gap releases all owned palette reference slots', async () => {
  let routes = 0;
  const service = createWebuiBrowserJudgment({ methods: new GatewayMethodCatalog(),
    currentRoute() { routes++; return undefined; }, authorize() { return true; } });
  try {
    for (let index = 0; index < 64; index++) {
      const abort = new AbortController();
      const pending = service.execute(request([{ kind: 'builtin', commandId: 'nav.chat' }]), owner, abort.signal, () => owner);
      queueMicrotask(() => abort.abort());
      await expect(pending).rejects.toMatchObject({ code: 'JUDGMENT_ABORTED' });
    }
    await Promise.resolve(); await Promise.resolve();
    await expect(service.execute(request([{ kind: 'builtin', commandId: 'nav.chat' }]), owner, new AbortController().signal, () => owner))
      .rejects.toMatchObject({ code: 'JUDGMENT_UNAVAILABLE' });
    expect(routes).toBe(1);
  } finally { await service.close(); }
});
function fixture(options: { probability?: number; beforeAnswer?: () => Promise<void> } = {}) {
  const log = new SqliteDecisionLog(':memory:'); const calls: unknown[] = [];
  let actor = owner; let allowed = true;
  let session = { id: 'fixture-chat', title: 'Synthetic plans', createdAt: 1, updatedAt: 2 };
  const methods = new GatewayMethodCatalog();
  methods.register({ id: 'fixture.read', title: 'Synthetic read', description: 'Synthetic test operation', category: 'sessions',
    source: 'builtin', access: 'authenticated', transport: ['http'], scopes: ['read:sessions'] });
  const inner: JudgmentPort = { model: 'jev-1.13.0', async ask(input) {
    calls.push(input.state); await options.beforeAnswer?.();
    return { requestedModel: 'jev-1.13.0', model: 'jev-1.13.0', requestId: undefined, usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1,
      answers: Object.fromEntries(Object.keys(input.questions).map((name) => [name, { type: 'noul', noul: name === 'match' ? options.probability ?? 0.99 : 0.01 }])) as never };
  } };
  const source = { getSession: (id: string) => id === session.id ? session : null };
  const service = createWebuiBrowserJudgment({ methods,
    currentRoute: () => ({ revision: 'owned-route', kind: 'local', port: withDecisionLog(inner, log), assertCurrent() {} }),
    authorize: (input) => allowed && input.sources.includes(input.battery === 'webui.palette.command-rank' ? 'palette-query' : 'daemon-error'),
  });
  const release = service.bindChatSessions(source);
  return { service, log, calls, methods, release, setActor: (value: AuthenticatedPrincipal) => { actor = value; },
    changeTitle: () => { session = { ...session, title: 'Changed synthetic plans', updatedAt: 3 }; }, deny: () => { allowed = false; },
    setTitle: (title: string) => { session = { ...session, title, updatedAt: 3 }; },
    run: (input: BrowserJudgmentRequest = request()) => service.execute(input, owner, new AbortController().signal, () => actor),
    errorRef: (body: unknown = { error: 'Synthetic unresolved operation failure' }, principal = owner) => service.issueErrorReference({ principal, methodId: 'fixture.read', status: 409, body }),
    async close() { await service.close(); log[Symbol.dispose](); },
  };
}

test('production WebUI owner resolves all requested builtin and real chat titles in order', async () => {
  const f = fixture();
  try {
    const result = await f.run();
    expect(result).toMatchObject({ status: 'settled', value: { registryVersion: WEBUI_COMMAND_CATALOG_VERSION,
      accepted: [{ candidateIndex: 0, probability: 0.99 }, { candidateIndex: 1, probability: 0.99 }], rejected: [] } });
    expect(f.calls).toMatchObject([{ query: 'Find synthetic plans', candidate: { title: 'Go to Chat' } }, { query: 'Find synthetic plans', candidate: { title: 'Synthetic plans', group: 'chats' } }]);
    expect(JSON.stringify(f.calls)).not.toContain('fixture-chat');
    expect(f.log.query()).toHaveLength(2);
    expect(JSON.stringify(f.log.query())).not.toContain('Synthetic plans');
  } finally { await f.close(); }
});

test.each(['unknown-builtin', 'missing-chat', 'duplicate', 'read-scope', 'principal', 'principal-kind', 'unbound'] as const)('rejects %s before the first provider call or hash record', async (kind) => {
  const f = fixture();
  try {
    let input = request();
    if (kind === 'unknown-builtin') input = request([{ kind: 'builtin', commandId: 'unregistered' }]);
    if (kind === 'missing-chat') input = request([{ kind: 'builtin', commandId: 'nav.chat' }, { kind: 'chat', sessionId: 'missing' }]);
    if (kind === 'duplicate') input = request([{ kind: 'chat', sessionId: 'fixture-chat' }, { kind: 'chat', sessionId: 'fixture-chat' }]);
    if (kind === 'read-scope') f.setActor({ ...owner, scopes: ['write:judgment'] });
    if (kind === 'principal') f.setActor({ ...owner, principalId: 'other' });
    if (kind === 'principal-kind') f.setActor({ ...owner, principalKind: 'token' });
    if (kind === 'unbound') f.release();
    await expect(f.run(input)).rejects.toBeInstanceOf(BrowserJudgmentError);
    expect(f.calls).toHaveLength(0); expect(f.log.query()).toEqual([]);
  } finally { await f.close(); }
});

test.each(['title', 'scope', 'permission', 'source-lifetime'] as const)('%s change while the provider waits prevents result retention and delivery', async (kind) => {
  const entered = barrier(); const finish = barrier();
  const f = fixture({ beforeAnswer: async () => { entered.resolve(); await finish.promise; } });
  const pending = f.run().catch((error: unknown) => error);
  try {
    await entered.promise;
    if (kind === 'title') f.changeTitle();
    if (kind === 'scope') f.setActor({ ...owner, scopes: ['write:judgment'] });
    if (kind === 'permission') f.deny();
    if (kind === 'source-lifetime') f.release();
    finish.resolve();
    expect(await pending).toBeInstanceOf(BrowserJudgmentError);
    expect(f.log.query()).toEqual([]);
  } finally { finish.resolve(); await pending; await f.close(); }
});

test('uncertain genuine readings never yield a ranked business value', async () => {
  const f = fixture({ probability: 0.5 });
  try { const result = await f.run(); expect(result).toMatchObject({ status: 'held', reason: 'uncertain' }); expect('value' in result).toBe(false); }
  finally { await f.close(); }
});

test.each(['query', 'title', 'oversize-title'] as const)('complete protected or oversized %s is held before reference retention or calls', async (kind) => {
  const f = fixture();
  try {
    const input = request();
    if (kind === 'title') f.setTitle('password=synthetic-private');
    if (kind === 'oversize-title') f.setTitle('x'.repeat(257));
    const source = kind === 'query' ? { ...input, input: { ...input.input, query: { kind: 'inline', text: 'password=synthetic-private' } } } : input;
    await expect(f.run(source as BrowserJudgmentRequest)).rejects.toMatchObject({ code: 'JUDGMENT_INPUT_HELD' });
    expect(f.calls).toHaveLength(0); expect(f.log.query()).toEqual([]);
  } finally { await f.close(); }
});

test('the real issuer snapshots bounded complete errors and binds them to principal/method access', async () => {
  const f = fixture();
  try {
    const errorRef = f.errorRef(); expect(errorRef).toBeString();
    const input = { protocolVersion: 1, requestId: crypto.randomUUID(), battery: 'webui.errors.daemon-refusal', batteryVersion: 1, input: { errorRef: errorRef! } } as const;
    expect(await f.run(input)).toMatchObject({ status: 'settled', structuralBasis: { method_unknown: 'http-status-not-404' } });
    f.setActor({ ...owner, scopes: ['write:judgment'] });
    await expect(f.run(input)).rejects.toMatchObject({ code: 'JUDGMENT_REFERENCE_HELD' });
    expect(f.calls).toHaveLength(1);
    expect(f.errorRef({ error: 'Session is closed', code: 'SESSION_CLOSED' })).toBeUndefined();
    expect(f.errorRef({ error: 'large'.repeat(1100) })).toBeUndefined();
    expect(f.errorRef({ error: 'Synthetic error', password: 'fixture-protected' })).toBeUndefined();
    expect(f.errorRef(undefined, { ...owner, principalId: 'other', scopes: [] })).toBeUndefined();
  } finally { await f.close(); }
});
