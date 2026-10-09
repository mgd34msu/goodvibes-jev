import { expect, test } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { BrowserJudgmentError, type AuthenticatedPrincipal, type BrowserJudgmentRequest } from '../daemon-sdk/src/index.ts';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.ts';
import { createWebuiBrowserJudgment } from '../sdk/src/platform/judgment-browser/webui-runtime.ts';
import { withWebuiAnswerBoundary } from '../sdk/src/platform/judgment-browser/batteries/webui-answers.ts';
const owner: AuthenticatedPrincipal = { principalId: 'config-fixture', principalKind: 'user', admin: true, scopes: ['write:judgment'] };
const request = (keys = ['custom.label']): BrowserJudgmentRequest<'webui.config.credential-key'> => ({ protocolVersion: 1, requestId: crypto.randomUUID(), battery: 'webui.config.credential-key', batteryVersion: 1, input: { keys } });
function fixture(options: { probability?: number; barrier?: Promise<void>; names?: readonly { key: string; description: string }[] } = {}) {
  const calls: unknown[] = []; const log = new SqliteDecisionLog(':memory:');
  const lifetime = new AbortController(); let actor = owner; let allowed = true; let revision = 1;
  const port: JudgmentPort = { model: 'jev-1.13.0', async ask(input) {
    calls.push(input.state); await options.barrier;
    return { model: 'jev-1.13.0', requestedModel: 'jev-1.13.0', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1,
      answers: { credential: { type: 'noul', noul: options.probability ?? 0.001 } } } as never;
  } };
  const service = createWebuiBrowserJudgment({ methods: new GatewayMethodCatalog(),
    configNames: { async list() { return options.names ?? [{ key: 'custom.label', description: 'A display label' }]; }, lifetime() {
      const captured = revision; return { signal: lifetime.signal, assertCurrent() { if (captured !== revision) throw new BrowserJudgmentError('JUDGMENT_REFERENCE_HELD'); } };
    } },
    currentRoute: () => ({ revision: 'fixture', kind: 'local', port: withDecisionLog(withWebuiAnswerBoundary(port), log), assertCurrent() {} }),
    authorize: input => allowed && input.battery === 'webui.config.credential-key' && input.sources[0] === 'config-key-names',
  });
  return { calls, lifetime, setActor(value: AuthenticatedPrincipal) { actor = value; }, deny() { allowed = false; }, change() { revision++; },
    run: (input: unknown = request(), signal = new AbortController().signal) => service.execute(input, owner, signal, () => actor),
    async close() { await service.close(); log[Symbol.dispose](); },
  };
}
test('canonical config key battery uses names and canonical descriptions, never values', async () => {
  const f = fixture(); try {
    const result = await f.run(); expect(result).toMatchObject({ status: 'settled', value: { matches: [false] }, readings: { key_0: { verdict: 'no', outcome: 'act' } } });
    expect(f.calls).toEqual([{ key: 'custom.label', description: 'A display label' }]);
  } finally { await f.close(); }
});
test('uncertain config key stays held and has no display-clearance value', async () => {
  const f = fixture({ probability: 0.5 }); try { const result = await f.run(); expect(result).toMatchObject({ status: 'held' }); expect(result).not.toHaveProperty('value'); } finally { await f.close(); }
});
test('unavailable and uncanonical names never reach judgment', async () => {
  const f = fixture(); try { await expect(f.run(request(['invented.key']))).rejects.toMatchObject({ code: 'JUDGMENT_REFERENCE_HELD' }); expect(f.calls).toHaveLength(0); } finally { await f.close(); }
});
test.each(['principal', 'grant', 'config', 'cancel', 'epoch'] as const)('%s change prevents late config clearance', async kind => {
  const barrier = Promise.withResolvers<void>(); const f = fixture({ barrier: barrier.promise }); const abort = new AbortController();
  try {
    const result = f.run(request(), abort.signal); const observed = result.then(() => 'unexpected-settled', () => 'held');
    for (let i = 0; i < 100 && !f.calls.length; i++) await Bun.sleep(1);
    expect(f.calls).toHaveLength(1);
    if (kind === 'principal') f.setActor({ ...owner, admin: false });
    if (kind === 'grant') f.deny();
    if (kind === 'config') f.lifetime.abort();
    if (kind === 'cancel') abort.abort();
    if (kind === 'epoch') f.change();
    barrier.resolve(); expect(await observed).toBe('held');
  } finally { barrier.resolve(); await f.close(); }
});
test('caller-supplied description and value are rejected by the closed protocol', async () => {
  const f = fixture(); try {
    await expect(f.run({ ...request(), input: { keys: ['custom.label'], description: 'safe', value: 'must-not-leave' } })).rejects.toMatchObject({ code: 'JUDGMENT_INVALID_INPUT' });
    expect(f.calls).toHaveLength(0);
  } finally { await f.close(); }
});
