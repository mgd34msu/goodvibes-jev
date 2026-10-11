import { expect, test } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { type AuthenticatedPrincipal, type BrowserJudgmentRequest } from '../daemon-sdk/src/index.ts';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.ts';
import { createWebuiBrowserJudgment } from '../sdk/src/platform/judgment-browser/webui-runtime.ts';

const owner: AuthenticatedPrincipal = { principalId: 'platform-fixture', principalKind: 'user', admin: false, scopes: ['write:judgment'] };
const request = (userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Version/17.0 Mobile/15E148 Safari/604.1'): BrowserJudgmentRequest<'webui.pwa.install-platform'> => ({
  protocolVersion: 1, requestId: crypto.randomUUID(), battery: 'webui.pwa.install-platform', batteryVersion: 1,
  input: { userAgent, platform: 'MacIntel', maxTouchPoints: 5 },
});
function fixture(options: { confidence?: number; authorized?: boolean; beforeAnswer?: () => Promise<void> } = {}) {
  const log = new SqliteDecisionLog(':memory:'); const calls: unknown[] = [];
  let actor = owner;
  const port: JudgmentPort = { model: 'jev-1.13.0', async ask(input) {
    calls.push(input.state); await options.beforeAnswer?.();
    return { requestedModel: 'jev-1.13.0', model: 'jev-1.13.0', requestId: undefined, usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1,
      answers: { platform: { type: 'choice', choice: 'ios-share-menu', confidence: options.confidence ?? 0.99, probabilities: { 'ios-share-menu': 0.99, other: 0.01 } } } as never };
  } };
  const service = createWebuiBrowserJudgment({ methods: new GatewayMethodCatalog(),
    currentRoute: () => ({ revision: 'fixture-route', kind: 'local', port: withDecisionLog(port, log), assertCurrent() {} }),
    authorize: ({ sources }) => options.authorized !== false && sources.length === 1 && sources[0] === 'browser-platform',
  });
  return { service, calls, log, changeActor: () => { actor = { ...owner, principalId: 'replacement-owner' }; },
    run: (input = request(), signal = new AbortController().signal) => service.execute(input, owner, signal, () => actor),
    close: async () => { await service.close(); log[Symbol.dispose](); } };
}

test('actual runtime returns a typed platform reading with complete metadata and real recorded evidence', async () => {
  const f = fixture();
  try {
    const result = await f.run();
    expect(result).toMatchObject({ status: 'settled', value: { platform: 'ios-share-menu' }, outcome: 'act', readings: { platform: { kind: 'choice' } } });
    expect(f.calls).toEqual([request().input]);
    expect(f.log.query()).toHaveLength(1);
    expect(JSON.stringify(f.log.query())).not.toContain('Mozilla/5.0');
  } finally { await f.close(); }
});
test('uncertainty has no installation value', async () => {
  const f = fixture({ confidence: 0.5 });
  try { const result = await f.run(); expect(result).toMatchObject({ status: 'held' }); expect(result).not.toHaveProperty('value'); }
  finally { await f.close(); }
});
test.each(['protected', 'permission', 'shape'] as const)('%s holds before provider and retention', async kind => {
  const f = fixture({ authorized: kind !== 'permission' });
  try {
    const input = request(kind === 'protected' ? 'Authorization: Bearer synthetic-inline-credential' : undefined);
    if (kind === 'shape') Object.assign(input.input, { secretValue: 'not-a-supported-field' });
    await expect(f.run(input)).rejects.toBeDefined();
    expect(f.calls).toHaveLength(0); expect(f.log.query()).toHaveLength(0);
  } finally { await f.close(); }
});
test.each(['abort', 'identity'] as const)('%s prevents late platform adoption', async kind => {
  const started = Promise.withResolvers<void>(); const finish = Promise.withResolvers<void>();
  const f = fixture({ beforeAnswer: async () => { started.resolve(); await finish.promise; } });
  const abort = new AbortController();
  try {
    const pending = f.run(request(), abort.signal); await started.promise;
    if (kind === 'abort') abort.abort(); else f.changeActor();
    finish.resolve(); await expect(pending).rejects.toBeDefined();
  } finally { finish.resolve(); await f.close(); }
});
