import { expect, test } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { BrowserJudgmentError, type AuthenticatedPrincipal } from '../daemon-sdk/src/index.ts';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.ts';
import { createWebuiBrowserJudgment } from '../sdk/src/platform/judgment-browser/webui-runtime.ts';
import { withWebuiAnswerBoundary } from '../sdk/src/platform/judgment-browser/batteries/webui-answers.ts';
const CARD = 'webui.settings.card-material-key';
const PROVIDER = 'webui.models.catalog-provider-match';
function fixture(battery: typeof CARD | typeof PROVIDER, options: { probability?: number; barrier?: Promise<void>; hidden?: string; names?: readonly { key: string; description: string }[] } = {}) {
  const owner: AuthenticatedPrincipal = { principalId: 'fixture-owner', principalKind: 'user', admin: true, scopes: ['write:judgment'] };
  const calls: unknown[] = [];
  const log = new SqliteDecisionLog(':memory:');
  const lifetime = new AbortController(); let epoch = 0; let allowed = true;
  const port: JudgmentPort = { model: 'jev-1.13.0', async ask(input) {
    calls.push(input.state); await options.barrier;
    return { model: 'jev-1.13.0', requestedModel: 'jev-1.13.0', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1,
      answers: { [battery === CARD ? 'material' : 'matches']: { type: 'noul', noul: options.probability ?? (battery === CARD ? 0.001 : 0.999) } } } as never;
  } };
  const sourceLifetime = () => { const captured = epoch; return { signal: lifetime.signal, assertCurrent() { if (captured !== epoch) throw new BrowserJudgmentError('JUDGMENT_REFERENCE_HELD'); } }; };
  const service = createWebuiBrowserJudgment({ methods: new GatewayMethodCatalog(),
    configNames: { async list() { return options.names ?? [{ key: 'custom.label', description: 'An ordinary label' }, ...(options.hidden ? [{ key: 'custom.other', description: options.hidden }] : [])]; }, lifetime: sourceLifetime },
    providerCatalog: { capture: () => ({ ...sourceLifetime(), snapshot: { providerIds: ['inception'], catalogProviderIds: ['inceptionlabs', ...(options.hidden ? [options.hidden] : [])] } }) },
    currentRoute: () => ({ revision: 'fixture', kind: 'local', port: withDecisionLog(withWebuiAnswerBoundary(port), log), assertCurrent() {} }),
    authorize: () => allowed,
  });
  const request = (keys = [battery === CARD ? 'custom.label' : 'inceptionlabs']) => ({ protocolVersion: 1, requestId: crypto.randomUUID(), battery, batteryVersion: 1,
    input: { keys, ...(battery === PROVIDER ? { providerId: 'inception' } : {}) } });
  return { calls, owner, lifetime, request, change() { epoch++; }, deny() { allowed = false; },
    run: (input: unknown = request(), signal = new AbortController().signal) => service.execute(input, owner, signal, () => owner),
    async close() { await service.close(); log[Symbol.dispose](); },
  };
}
for (const battery of [CARD, PROVIDER] as const) {
  test(`${battery}: canonical metadata produces a current settled result without values`, async () => {
    const f = fixture(battery); try {
      expect(await f.run()).toMatchObject({ status: 'settled', value: { matches: [battery === PROVIDER] } });
      expect(f.calls).toEqual([battery === CARD ? { key: 'custom.label', description: 'An ordinary label' } : { providerId: 'inception', key: 'inceptionlabs' }]);
    } finally { await f.close(); }
  });
  test(`${battery}: uncertainty cannot publish a usable value`, async () => {
    const f = fixture(battery, { probability: 0.5 }); try { expect(await f.run()).toMatchObject({ status: 'held' }); } finally { await f.close(); }
  });
  test(`${battery}: protected metadata outside the requested subset holds the whole source`, async () => {
    const f = fixture(battery, { hidden: 'Authorization: Bearer synthetic-protected-material' }); try {
      await expect(f.run()).rejects.toMatchObject({ code: 'JUDGMENT_INPUT_HELD' }); expect(f.calls).toEqual([]);
    } finally { await f.close(); }
  });
  test(`${battery}: invented IDs and caller values are refused before provider dispatch`, async () => {
    const f = fixture(battery); try {
      await expect(f.run(f.request(['invented']))).rejects.toBeDefined();
      const request = f.request(); await expect(f.run({ ...request, input: { ...request.input, value: 'never-transmit' } })).rejects.toBeDefined();
      expect(f.calls).toEqual([]);
    } finally { await f.close(); }
  });
  test.each(['source', 'actor', 'grant', 'cancel', 'lifetime'] as const)(`${battery}: %s retires a suspended reading`, async kind => {
    const barrier = Promise.withResolvers<void>(); const f = fixture(battery, { barrier: barrier.promise }); const abort = new AbortController();
    try {
      const result = f.run(f.request(), abort.signal).then(() => 'published', () => 'held');
      for (let i = 0; i < 100 && !f.calls.length; i++) await Bun.sleep(1);
      expect(f.calls).toHaveLength(1);
      if (kind === 'source') f.change();
      if (kind === 'actor') Object.assign(f.owner, { principalId: 'replacement-owner' });
      if (kind === 'grant') f.deny();
      if (kind === 'cancel') abort.abort();
      if (kind === 'lifetime') f.lifetime.abort();
      barrier.resolve(); expect(await result).toBe('held');
    } finally { barrier.resolve(); await f.close(); }
  });
}
test('card metadata getters are rejected without being called, including unselected entries', async () => {
  let reads = 0;
  const item = { key: 'custom.other', get description() { reads++; return 'ordinary label'; } };
  const f = fixture(CARD, { names: [{ key: 'custom.label', description: '' }, item] });
  try { await expect(f.run()).rejects.toMatchObject({ code: 'JUDGMENT_INPUT_HELD' }); expect(reads).toBe(0); expect(f.calls).toEqual([]); }
  finally { await f.close(); }
});

for (const battery of [CARD, PROVIDER] as const) test(`${battery}: direct service admission keeps the actor from before queued resolver execution`, async () => {
  const f = fixture(battery);
  try {
    const pending = f.run(); Object.assign(f.owner, { principalId: 'replacement-before-resolve' });
    await expect(pending).rejects.toMatchObject({ code: 'JUDGMENT_AUTH_REQUIRED' }); expect(f.calls).toEqual([]);
  } finally { await f.close(); }
});
