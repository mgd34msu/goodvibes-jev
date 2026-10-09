/** Source-only synthetic HTTP protocol tests: no socket, model or real credential. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { createDaemonSystemRouteHandlers } from '../daemon-sdk/src/system-routes.js';
import { createSettingsPreconditionHandler } from '../daemon-sdk/src/settings-precondition.js';
import { captureRemoteSettingsPrecondition, applyRemoteSettingsPrecondition, inspectRemoteSettingsPrecondition, resolvePreparedConfigWriteRoute } from '../sdk/src/platform/config/settings-precondition-client.js';

const restores: (() => void)[] = [];
afterEach(() => { for (const restore of restores.splice(0)) restore(); });
const envelope = (body: Record<string, unknown>) => ({ settingsPrecondition: { version: 1, ...body } });
function fixture() {
  let lifetime: object | null = {};
  let generation = 0;
  let admin = true;
  let authority = {};
  let value: unknown = 1;
  let effects = 0;
  let legacyEffects = 0;
  let beginHook = () => {};
  let parseHook = async () => {};
  const owner = {
    prepare(request: { operation: 'set' | 'reset-default'; key: string; value?: unknown }) {
      if (request.key !== 'controlPlane.port') throw new Error('Invalid key');
      return { generation, value: request.operation === 'reset-default' ? 3421 : Number(request.value), operation: request.operation, key: request.key };
    },
    inspect(handle: { generation: number; value: number; operation: 'set' | 'reset-default'; key: string }) {
      return { operation: handle.operation, key: handle.key, value: handle.value,
        destinations: [{ path: '/synthetic/settings.json', operation: 'set' as const, tier: 'daemon' }], incarnation: handle.generation };
    },
    assert(handle: { generation: number }) { if (handle.generation !== generation) throw new Error('stale owner'); },
    begin(handle: { generation: number }) { owner.assert(handle); generation++; const transition = { generation }; beginHook(); return transition; },
    assertTransition(_handle: unknown, transition: { generation: number }) { if (transition.generation !== generation) throw new Error('stale transition'); },
    finish(handle: { value: number }, transition: { generation: number }) {
      owner.assertTransition(handle, transition); value = handle.value; effects++;
      return { status: 'committed' as const, completedPaths: ['/synthetic/settings.json'], verifiedInOwningStore: true };
    },
  };
  const service = createSettingsPreconditionHandler({ owner, lifetime: () => lifetime,
    captureAuthority: () => admin ? authority : null,
    withAuthority: (_req, captured, callback) => { const check = () => { if (!admin || authority !== captured) throw new Error('stale auth'); }; check(); return callback(check); },
  });
  const handlers = createDaemonSystemRouteHandlers({ settingsPrecondition: service,
    requireAdmin: () => admin ? null : Response.json({ error: 'admin' }, { status: 403 }),
    parseJsonBody: async (req: Request) => { const body = await req.json(); await parseHook(); return body; },
    isValidConfigKey: (key: string) => key === 'controlPlane.port',
    configManager: { get: () => value, setDynamic: (_key: string, next: unknown) => { value = next; legacyEffects++; }, getAll: () => ({}) },
  } as never);
  const post = (body: unknown) => handlers.postConfig(new Request('http://synthetic.invalid/config', { method: 'POST', body: JSON.stringify(body) }));
  const capture = async (operation = 'set', next: unknown = '42') => {
    const response = await post(envelope({ action: 'capture', operation, key: 'controlPlane.port', ...(operation === 'set' ? { value: next } : {}) }));
    return { response, body: await response.json() };
  };
  const apply = (reference: string) => post(envelope({ action: 'apply', reference }));
  return { post, capture, apply, effects: () => effects, legacyEffects: () => legacyEffects, value: () => value,
    rotate: () => { lifetime = {}; }, stop: () => { lifetime = null; }, revoke: () => { admin = false; },
    replaceAuth: () => { authority = {}; }, mutate: () => { generation++; },
    onBegin: (callback: () => void) => { beginHook = callback; }, onParse: (callback: () => Promise<void>) => { parseHook = callback; } };
}

test('capture projects normalized owner value; apply performs exactly that effect once', async () => {
  const f = fixture(); const { response, body } = await f.capture();
  expect(response.status).toBe(200); expect(body.settingsPrecondition.facts.value).toBe(42); expect(f.effects()).toBe(0);
  const applied = await f.apply(body.settingsPrecondition.reference);
  expect(applied.status).toBe(200); expect((await applied.json()).settingsPrecondition.receipt.status).toBe('committed');
  expect(f.value()).toBe(42); expect((await f.apply(body.settingsPrecondition.reference)).status).toBe(409); expect(f.effects()).toBe(1);
});
test('remote reset captures serving schema default as a set operation', async () => {
  const f = fixture(); const { body } = await f.capture('reset-default');
  expect(body.settingsPrecondition.facts.value).toBe(3421); await f.apply(body.settingsPrecondition.reference); expect(f.value()).toBe(3421);
});
test('legacy manual key/value remains accepted; mixed envelope never falls back', async () => {
  const f = fixture(); expect((await f.post({ key: 'controlPlane.port', value: 7 })).status).toBe(200);
  for (const malformed of [null, {}, { version: 2, action: 'capture' }, { version: 1, action: 'apply', reference: 'bad', key: 'controlPlane.port' }]) {
    expect((await f.post({ key: 'controlPlane.port', value: 9, settingsPrecondition: malformed })).status).toBe(400);
  }
  expect(f.legacyEffects()).toBe(1); expect(f.value()).toBe(7);
});
test.each(['rotate', 'stop', 'revoke', 'replaceAuth', 'mutate'] as const)('%s between capture and apply refuses before effect', async change => {
  const f = fixture(); const { body } = await f.capture(); f[change](); expect((await f.apply(body.settingsPrecondition.reference)).status).toBeGreaterThanOrEqual(400); expect(f.effects()).toBe(0);
});
test.each(['rotate', 'stop', 'revoke', 'replaceAuth', 'mutate'] as const)('%s during owner begin refuses before effect', async change => {
  const f = fixture(); const { body } = await f.capture(); f.onBegin(f[change]); expect((await f.apply(body.settingsPrecondition.reference)).status).toBeGreaterThanOrEqual(400); expect(f.effects()).toBe(0);
});
test.each(['rotate', 'stop', 'revoke', 'replaceAuth'] as const)('%s during apply body await refuses before effect', async change => {
  const f = fixture(); const { body } = await f.capture(); f.onParse(async () => { f[change](); });
  expect((await f.apply(body.settingsPrecondition.reference)).status).toBeGreaterThanOrEqual(400); expect(f.effects()).toBe(0);
});
test('capture across a serving lifetime change in body await refuses', async () => {
  const f = fixture(); f.onParse(async () => { f.rotate(); }); expect((await f.capture()).response.status).toBe(409); expect(f.effects()).toBe(0);
});
test('unknown, expired and bounded-evicted references refuse', async () => {
  const f = fixture(); expect((await f.apply('unknown')).status).toBe(409);
  const { body } = await f.capture(); const now = Date.now(); const clock = spyOn(Date, 'now').mockReturnValue(now + 300_001); restores.push(() => clock.mockRestore());
  expect((await f.apply(body.settingsPrecondition.reference)).status).toBe(409); clock.mockRestore();
  const first = (await f.capture()).body.settingsPrecondition.reference;
  for (let i = 0; i < 256; i++) await f.capture();
  expect((await f.apply(first)).status).toBe(409); expect(f.effects()).toBe(0);
});

test('strict client pins destination/token; response loss spends reference after exactly one effect', async () => {
  const f = fixture(); const requests: { url: string; init: RequestInit | undefined }[] = [];
  const endpoint = { baseUrl: 'http://synthetic.invalid', token: 'synthetic-operator', source: 'test' };
  const handle = await captureRemoteSettingsPrecondition(endpoint, { operation: 'set', key: 'controlPlane.port', value: '42' }, {
    fetchImpl: (async (url, init) => { requests.push({ url: String(url), init }); const response = await f.post(JSON.parse(String(init?.body))); if (requests.length > 1) throw new Error('response lost'); return response; }) as typeof fetch,
  });
  endpoint.baseUrl = 'http://other.invalid'; endpoint.token = 'changed';
  expect(inspectRemoteSettingsPrecondition(handle).value).toBe(42);
  expect((await applyRemoteSettingsPrecondition(handle)).status).toBe('unknown');
  await expect(applyRemoteSettingsPrecondition(handle)).rejects.toThrow();
  expect(f.effects()).toBe(1); expect(requests).toHaveLength(2);
  expect(requests[1]!.url).toBe('http://synthetic.invalid/config'); expect(requests[1]!.init!.redirect).toBe('error');
  expect(JSON.stringify(inspectRemoteSettingsPrecondition(handle))).not.toContain('synthetic-operator');
});
test('old server rejects nested capture and no legacy fallback request is sent', async () => {
  let calls = 0;
  await expect(captureRemoteSettingsPrecondition({ baseUrl: 'http://synthetic.invalid', source: 'old' }, { operation: 'set', key: 'controlPlane.port', value: 42 }, {
    fetchImpl: (async (_url, init) => { calls++; const body = JSON.parse(String(init?.body)); expect(body.key).toBeUndefined(); expect(body.value).toBeUndefined(); return Response.json({ error: 'Missing or invalid key' }, { status: 400 }); }) as typeof fetch,
  })).rejects.toThrow(); expect(calls).toBe(1);
});
test('legacy or malformed apply acknowledgments are unknown, never success', async () => {
  for (const response of [{ success: true }, envelope({ action: 'applied', reference: 'wrong', receipt: { status: 'committed', completedPaths: [] } })]) {
    const f = fixture(); let calls = 0;
    const handle = await captureRemoteSettingsPrecondition({ baseUrl: 'http://synthetic.invalid', source: 'test' }, { operation: 'set', key: 'controlPlane.port', value: 42 }, {
      fetchImpl: (async (_url, init) => { calls++; const result = await f.post(JSON.parse(String(init?.body))); return calls === 1 ? result : Response.json(response); }) as typeof fetch,
    });
    expect((await applyRemoteSettingsPrecondition(handle)).status).toBe('unknown'); expect(f.effects()).toBe(1); expect(calls).toBe(2);
  }
});
test('preadmission route discovery defers record reaping and pins the responding endpoint', async () => {
  let reaps = 0; const calls: string[] = [];
  const route = await resolvePreparedConfigWriteRoute('controlPlane.port', { hostsDaemon: false, daemonHomeDir: '/synthetic',
    readRuntimeRecord: () => ({ host: '127.0.0.1', port: 1111, pid: 123 } as never), isProcessAlive: () => true,
    reapRuntimeRecord: () => { reaps++; }, readDaemonBinding: () => ({ hostMode: 'local', host: '127.0.0.1', port: 2222, tlsMode: 'off' } as never),
    fetchImpl: (async url => { calls.push(String(url)); if (String(url).includes(':1111')) throw new Error('offline'); return Response.json({}); }) as typeof fetch });
  expect(route.mode).toBe('daemon'); if (route.mode === 'daemon') expect(route.endpoint.baseUrl).toBe('http://127.0.0.1:2222'); expect(reaps).toBe(0); expect(calls).toHaveLength(2);
});

test.each([
  { status: 'committed', completedPaths: [], verifiedInOwningStore: true },
  { status: 'committed', completedPaths: ['/synthetic/settings.json'], uncertainPath: '/synthetic/settings.json', verifiedInOwningStore: true },
  { status: 'committed', completedPaths: ['/synthetic/settings.json'] },
  { status: 'committed', completedPaths: ['/synthetic/settings.json'], verifiedInOwningStore: 'true' },
  { status: 'partial', completedPaths: [], uncertainPath: '/synthetic/settings.json' },
  { status: 'partial', completedPaths: ['/synthetic/settings.json'], uncertainPath: '/synthetic/settings.json' },
  { status: 'unknown', completedPaths: ['/synthetic/settings.json'] },
])('matching-reference malformed effect receipt $status is unknown, with no retry', async receipt => {
  const f = fixture(); let calls = 0;
  const handle = await captureRemoteSettingsPrecondition({ baseUrl: 'http://synthetic.invalid', source: 'test' }, { operation: 'set', key: 'controlPlane.port', value: 42 }, {
    fetchImpl: (async (_url, init) => {
      calls++; const response = await f.post(JSON.parse(String(init?.body)));
      if (calls === 1) return response;
      const body = await response.json(); body.settingsPrecondition.receipt = receipt; return Response.json(body);
    }) as typeof fetch,
  });
  expect(await applyRemoteSettingsPrecondition(handle)).toEqual({ status: 'unknown', completedPaths: [] });
  await expect(applyRemoteSettingsPrecondition(handle)).rejects.toThrow(); expect(f.effects()).toBe(1); expect(calls).toBe(2);
});
test('remote reset-default cannot be reinterpreted as remove-override destinations', async () => {
  const f = fixture();
  await expect(captureRemoteSettingsPrecondition({ baseUrl: 'http://synthetic.invalid', source: 'test' }, { operation: 'reset-default', key: 'controlPlane.port' }, {
    fetchImpl: (async (_url, init) => {
      const response = await f.post(JSON.parse(String(init?.body))); const body = await response.json();
      body.settingsPrecondition.facts.destinations[0].operation = 'remove'; return Response.json(body);
    }) as typeof fetch,
  })).rejects.toThrow(); expect(f.effects()).toBe(0);
});

test('malformed endpoint errors never include private URL material', async () => {
  const marker = 'synthetic-private-endpoint-material'; let calls = 0;
  const fetchImpl = (async (_input: Parameters<typeof fetch>[0]) => { calls++; throw new Error('Must not dispatch'); }) as unknown as typeof fetch;
  let failure: unknown;
  try { await captureRemoteSettingsPrecondition({ baseUrl: `invalid url ${marker}`, token: marker, source: 'test' },
    { operation: 'set', key: 'controlPlane.port', value: 42 }, { fetchImpl }); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe('Settings owner precondition unavailable; fresh capture and admission required.');
  expect(JSON.stringify(failure)).not.toContain(marker); expect(calls).toBe(0);
});
